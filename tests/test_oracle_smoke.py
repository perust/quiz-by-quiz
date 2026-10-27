"""deploy/oracle/smoke.py — 운영 호스트의 python3 하나로 도는 배포 점검.

호스트에는 curl·jq·requests가 없을 수 있어 표준 라이브러리만 쓴다. 출력은 운영 기록에 남으므로
bearer 토큰·소켓 티켓·응답 본문이 한 글자도 새지 않아야 한다. 서버 흉내(FakeApi)는
server/app/main.py의 요청 모양·상태 코드·오류 코드를 그대로 따른다.
"""

import ast
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest
from collections import deque
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SMOKE_PATH = ROOT / "deploy" / "oracle" / "smoke.py"


def load_smoke():
    spec = importlib.util.spec_from_file_location("oracle_smoke", SMOKE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


smoke = load_smoke()
TOKEN_HEADER = re.compile(r"^Bearer ([A-Za-z0-9_-]{32,256})$")
CORS_FAILURE = "CORS does not allow https://perust.github.io"
WEBSOCKET_OK = "ok websocket: HTTP 101 protocol qbb.v1, movement echoed, closed 1000"
_ECHO_ORIGIN = object()


def body(value: object) -> bytes:
    return json.dumps(value).encode("utf-8")


def error(status: int, code: str, headers: dict | None = None):
    detail = {"code": code, "message": "…"}
    return smoke.Reply(status, dict(headers or {}), body({"detail": detail}))


def text_frame(value: object):
    return smoke.Frame(smoke.OPCODE_TEXT, body(value))


def close_frame(code: int):
    return smoke.Frame(smoke.OPCODE_CLOSE, code.to_bytes(2, "big"))


class FakeChannel:
    """101 뒤의 서버 쪽. room_events처럼 받은 움직임을 보낸 사람에게도 되돌리고 close에는 답한다."""

    def __init__(self, api: "FakeApi", player: str) -> None:
        self.api = api
        self.player = player
        self.sent: list[tuple[str, object]] = []
        self.inbox: deque = deque()
        self.closed = False
        if api.socket_noise:
            self.inbox.append(text_frame({"type": "room-invalidated"}))
            self.inbox.append(smoke.Frame(0x9, b""))
        if api.socket_close is not None:
            self.inbox.append(close_frame(api.socket_close))

    def send_text(self, text: str) -> None:
        message = json.loads(text)
        self.sent.append(("text", message))
        if self.api.socket_echo and not self.api.socket_drop:
            self.inbox.append(text_frame({**message, "playerId": self.player, "sequence": 1}))

    def send_close(self, code: int = 1000) -> None:
        self.sent.append(("close", code))
        self.inbox.append(close_frame(self.api.close_reply))

    def read_frame(self, deadline: float):
        if self.api.socket_drop:
            return None
        if not self.inbox:
            raise TimeoutError("timed out")
        return self.inbox.popleft()

    def close(self) -> None:
        self.closed = True


class FakeApi:
    """server/app/main.py가 내놓는 공개 API. 받은 요청을 모두 적어 둔다."""

    def __init__(
        self,
        *,
        schema_version: int = 13,
        readiness_error: tuple[int, str] | None = None,
        readiness_extra: dict | None = None,
        readiness_429: int = 0,
        cors_origin: object = _ECHO_ORIGIN,
        connected: bool = True,
        upgrade_403: int = 0,
        socket_close: int | None = None,
        socket_drop: bool = False,
        socket_echo: bool = True,
        socket_noise: bool = False,
        close_reply: int = 1000,
        interrupt: tuple[str, str] | None = None,
        terminate: tuple[str, str] | None = None,
        question_time: bool = True,
        rankings: bool = True,
        solo_play: bool | None = None,
        nickname_filter: bool = True,
        ranking_extra: dict | None = None,
        ranking_entry_extra: dict | None = None,
        anonymous_mine: bool = False,
    ) -> None:
        self.schema_version = schema_version
        self.readiness_error = readiness_error
        self.readiness_extra = dict(readiness_extra or {})
        self.readiness_429 = readiness_429
        self.cors_origin = cors_origin
        self.connected = connected
        self.upgrade_403 = upgrade_403
        self.socket_close = socket_close
        self.socket_drop = socket_drop
        self.socket_echo = socket_echo
        self.socket_noise = socket_noise
        self.close_reply = close_reply
        self.interrupt = interrupt
        self.terminate = terminate
        self.question_time = question_time
        # migration 012 API(#108)부터의 것: 세션의 rankings, 닉네임 금칙 규칙, GET /v1/rankings
        self.rankings = rankings
        # migration 013 API(이 후보, FR-7.13 3단계)의 것: 세션의 soloPlay. 기본은 랭킹과 같다 — 012
        # API(이 경계의 baseline)는 solo_play=False로 흉내 낸다
        self.solo_play = rankings if solo_play is None else solo_play
        self.nickname_filter = nickname_filter
        self.ranking_extra = dict(ranking_extra or {})
        self.ranking_entry_extra = dict(ranking_entry_extra or {})
        self.anonymous_mine = anonymous_mine
        self.requests: list[tuple[str, str, dict, object]] = []
        self.upgrades: list[tuple[str, dict]] = []
        self.channels: list[FakeChannel] = []
        self.tokens: set[str] = set()
        self.tickets: dict[str, str] = {}
        self.players: set[str] = set()
        self.rooms: dict[str, dict] = {}

    def _cors(self, headers: dict) -> dict:
        origin = headers.get("Origin")
        if self.cors_origin is not _ECHO_ORIGIN:
            origin = self.cors_origin
        elif origin != smoke.PAGES_ORIGIN:
            origin = None
        return {} if origin is None else {"access-control-allow-origin": origin}

    def _ok(self, status: int, value: object, headers: dict) -> object:
        return smoke.Reply(status, self._cors(headers), body(value))

    def _room(self, room: dict) -> dict:
        payload = dict(room)
        if not self.question_time:
            payload.pop("questionTimeMs")
        return payload

    def request(self, method, path, headers, data=None):
        payload = json.loads(data) if data else None
        self.requests.append((method, path, dict(headers), payload))
        if self.interrupt == (method, path):
            raise KeyboardInterrupt
        reply = self._handle(method, path, headers, payload)
        if self.terminate == (method, path):
            # 서버는 이미 처리했고 SIGTERM이 그 답을 받기 전에 온다.
            signal.raise_signal(signal.SIGTERM)
        return reply

    def _rankings(self, method, path, headers):
        """server/app/main.py의 list_rankings. 신분이 없어도 읽고, 있으면 확인한다."""
        if not self.rankings:
            # 랭킹을 모르는 API에는 그 경로가 없다(FastAPI의 기본 404)
            return smoke.Reply(404, self._cors(headers), body({"detail": "Not Found"}))
        query = {key: values[0] for key, values in parse_qs(urlsplit(path).query).items()}
        mode, category, period = query.get("mode"), query.get("category"), query.get("period")
        if (
            mode not in ("category", "all")
            or period not in ("week", "all")
            or (mode == "category" and category not in ("history", "science"))
            or (mode == "all" and category is not None)
        ):
            return error(400, "invalid-ranking", self._cors(headers))
        if "Authorization" in headers and headers.get("X-Player-Id") not in self.players:
            return error(401, "unauthorized", self._cors(headers))
        anonymous = "Authorization" not in headers
        entries = [
            {
                "rank": rank,
                "nickname": f"참가자{rank}",
                "characterId": "slime-blue",
                "score": 100 - rank * 10,
                "correctCount": 10 - rank,
                "totalCount": 10,
                "recordedAt": "2026-10-27T03:10:52+00:00",
                "isMine": anonymous and self.anonymous_mine,
                **self.ranking_entry_extra,
            }
            for rank in (1, 2)
        ]
        window = (
            {
                "start": "2026-10-25T15:00:00+00:00",
                "end": "2026-11-01T15:00:00+00:00",
                "timeZone": "Asia/Seoul",
            }
            if period == "week"
            else None
        )
        return self._ok(
            200,
            {
                "mode": mode,
                "categoryId": category if mode == "category" else None,
                "period": period,
                "window": window,
                "limit": 10,
                "entries": entries,
                **self.ranking_extra,
            },
            headers,
        )

    def _handle(self, method, path, headers, payload):
        if method == "GET" and path.startswith("/v1/rankings"):
            return self._rankings(method, path, headers)
        if path == "/v1/release-readiness":
            if self.readiness_429:
                self.readiness_429 -= 1
                return error(429, "rate-limited", {"retry-after": "3"})
            if self.readiness_error is not None:
                status, code = self.readiness_error
                return error(status, code, self._cors(headers))
            return self._ok(
                200,
                {
                    "status": "ready",
                    "contract": "character-only-v1",
                    "schemaVersion": self.schema_version,
                    **self.readiness_extra,
                },
                headers,
            )
        token = TOKEN_HEADER.match(headers.get("Authorization", ""))
        player = headers.get("X-Player-Id")
        if token is None or player is None:
            return error(401, "unauthorized")
        self.tokens.add(token.group(1))
        if (method, path) == ("PUT", "/v1/session"):
            assert set(payload) == {"nickname", "characterId"}
            if self.nickname_filter and "@" in payload["nickname"]:
                # 거절된 세션은 프로필을 바꾸지 않는다
                return error(400, "nickname-personal-info", self._cors(headers))
            self.players.add(player)
            session = {"playerId": player, "minPlayers": 1, "standingAnswers": True}
            if self.rankings:
                session["rankings"] = True
            if self.solo_play:
                session["soloPlay"] = True
            return self._ok(200, session, headers)
        if player not in self.players:
            return error(401, "unauthorized")
        if (method, path) == ("POST", "/v1/rooms"):
            # 구버전 화면처럼 questionTimeMs를 보내지 않는다 — 012·013 API 모두 20초로 둔다.
            assert set(payload) == {"name", "categoryId", "capacity", "isPublic"}
            code = "QZ7K2M"
            self.rooms[code] = {
                "code": code,
                "name": payload["name"],
                "categoryId": payload["categoryId"],
                "capacity": payload["capacity"],
                "gameMode": True,
                "questionTimeMs": 20000,
                "players": [
                    {
                        "id": player,
                        "nickname": "점검",
                        "characterId": "slime-blue",
                        "isReady": False,
                        "connected": self.connected,
                    }
                ],
                "isPublic": payload["isPublic"],
                "hasPassword": False,
                "isMine": True,
                "joined": True,
                "createdAt": "2026-10-27T00:00:00Z",
                "status": "waiting",
                "inMatch": False,
            }
            return self._ok(201, self._room(self.rooms[code]), headers)
        if (method, path) == ("GET", "/v1/rooms"):
            return self._ok(200, [self._room(room) for room in self.rooms.values()], headers)
        match = re.fullmatch(r"/v1/rooms/([A-Z0-9]{6})(/.*)?", path)
        assert match is not None, path
        code, rest = match.group(1), match.group(2) or ""
        room = self.rooms.get(code)
        if room is None:
            return error(404, "not-found")
        if (method, rest) == ("GET", ""):
            return self._ok(200, self._room(room), headers)
        if (method, rest) == ("PATCH", ""):
            if payload.get("questionTimeMs") not in (20000, 40000):
                return error(400, "invalid-question-time")
            room["questionTimeMs"] = payload["questionTimeMs"]
            return self._ok(200, self._room(room), headers)
        if (method, rest) == ("POST", "/ws-ticket"):
            ticket = f"T{len(self.tickets):02d}" + "q" * 40
            self.tickets[ticket] = player
            return self._ok(201, {"ticket": ticket, "movementViewport": "x"}, headers)
        if (method, rest) == ("DELETE", "/members/me"):
            del self.rooms[code]
            return smoke.Reply(204, self._cors(headers))
        raise AssertionError(f"unexpected request {method} {path}")

    def upgrade(self, path, headers):
        self.upgrades.append((path, dict(headers)))
        protocols = [item.strip() for item in headers["Sec-WebSocket-Protocol"].split(",")]
        ticket = protocols[1][len("qbb.ticket."):]
        assert protocols[0] == "qbb.v1" and ticket in self.tickets
        if self.upgrade_403:
            self.upgrade_403 -= 1
            return smoke.Upgrade(403, {})
        accept = base64.b64encode(
            hashlib.sha1(  # noqa: S324 - RFC 6455
                (headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()
        ).decode()
        channel = FakeChannel(self, self.tickets[ticket])
        self.channels.append(channel)
        return smoke.Upgrade(
            101,
            {
                "upgrade": "websocket",
                "connection": "Upgrade",
                "sec-websocket-accept": accept,
                "sec-websocket-protocol": "qbb.v1",
            },
            channel,
        )


class Run:
    def __init__(self, mode: str, api: FakeApi) -> None:
        self.lines: list[str] = []
        self.notes: list[str] = []
        self.sleeps: list[float] = []
        report = smoke.Report(write=self.lines.append, note=self.notes.append)
        self.smoke = smoke.Smoke(mode, api, report, sleep=self.sleeps.append)
        self.code = self.smoke.run()
        self.api = api

    @property
    def output(self) -> str:
        return "\n".join(self.lines + self.notes)


class StandardLibraryOnlyTests(unittest.TestCase):
    def test_imports_only_the_standard_library_with_python_38_syntax(self):
        tree = ast.parse(SMOKE_PATH.read_text(encoding="utf-8"), feature_version=(3, 8))
        modules = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0)
                modules.add(node.module.split(".")[0])
        self.assertIn("ssl", modules)
        self.assertEqual(sorted(modules - set(sys.stdlib_module_names)), [])

    def test_runs_with_an_isolated_interpreter_without_site_packages(self):
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(SMOKE_PATH), "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("baseline-migrated", result.stdout)
        self.assertIn("--resolve-to", result.stdout)

    def test_rejects_plain_http_off_loopback_and_bad_arguments(self):
        for argv in (
            ["candidate", "--api", "http://quiz-by-quiz-api.150.230.222.142.sslip.io"],
            ["candidate", "--api", "https://example.test/?token=x"],
            ["candidate", "--resolve-to", "not-an-ip"],
            # 루프백 URL이어도 평문 연결을 밖의 주소로 돌리면 토큰이 암호화 없이 나간다.
            ["candidate", "--api", "http://localhost:8000", "--resolve-to", "203.0.113.9"],
            ["staging"],
        ):
            with self.subTest(argv=argv):
                result = subprocess.run(
                    [sys.executable, "-I", "-S", str(SMOKE_PATH), *argv],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")


class ApiUrlTests(unittest.TestCase):
    def test_default_api_is_the_production_https_host(self):
        api = smoke.parse_api(smoke.DEFAULT_API)
        self.assertEqual(
            (api.tls, api.host, api.port, api.path, api.host_header),
            (
                True,
                "quiz-by-quiz-api.150.230.222.142.sslip.io",
                443,
                "",
                "quiz-by-quiz-api.150.230.222.142.sslip.io",
            ),
        )

    def test_local_http_keeps_its_port_in_the_host_header(self):
        api = smoke.parse_api("http://127.0.0.1:18083/")
        self.assertEqual((api.tls, api.port, api.host_header), (False, 18083, "127.0.0.1:18083"))
        self.assertEqual(smoke.parse_api("http://[::1]:8000").host_header, "[::1]:8000")

    def test_plain_http_may_resolve_only_to_a_loopback_address(self):
        local = smoke.parse_api("http://localhost:8000")
        smoke.check_target(local, None)
        smoke.check_target(local, "127.0.0.1")
        smoke.check_target(local, "::1")
        with self.assertRaises(ValueError):
            smoke.check_target(local, "203.0.113.9")
        smoke.check_target(smoke.parse_api(smoke.DEFAULT_API), "10.0.0.5")


class SmokeRunTests(unittest.TestCase):
    def assert_no_secret(self, run: Run) -> None:
        self.assertTrue(run.api.tokens)
        self.assertTrue(run.api.tickets)
        for secret in run.api.tokens | set(run.api.tickets):
            self.assertNotIn(secret, run.output)
        self.assertNotIn("Bearer", run.output)

    def assert_left_the_room(self, run: Run) -> None:
        self.assertEqual(run.lines[-1], "ok cleanup: left room QZ7K2M, GET -> 404")
        self.assertEqual(run.api.rooms, {})

    def test_candidate_passes_with_one_line_per_step_and_no_secret(self):
        run = Run("candidate", FakeApi())
        self.assertEqual(run.code, 0, run.lines)
        self.assertEqual(
            [line.split(":")[0] for line in run.lines],
            [
                "ok readiness",
                "ok session",
                "ok nickname",
                "ok rankings",
                "ok room",
                "ok room-settings",
                "ok websocket",
                "ok cleanup",
            ],
        )
        self.assertEqual(run.lines[0], "ok readiness: HTTP 200 ready character-only-v1 schemaVersion 13")
        self.assertEqual(
            run.lines[1],
            "ok session: HTTP 200 playerId is this identity, rankings true, soloPlay true",
        )
        self.assertEqual(
            run.lines[2],
            "ok nickname: HTTP 400 nickname-personal-info for an e-mail-shaped nickname",
        )
        self.assertEqual(
            run.lines[3],
            "ok rankings: anonymous week HTTP 200 (2 entries, window Asia/Seoul); "
            "history all-time HTTP 200; unknown board -> 400 invalid-ranking",
        )
        self.assertIn("questionTimeMs 20000", run.lines[4])
        self.assertIn("400 invalid-question-time", run.lines[5])
        self.assertEqual(run.lines[6], WEBSOCKET_OK)
        self.assert_left_the_room(run)
        self.assert_no_secret(run)

    def test_every_request_carries_the_pages_origin_and_auth_only_after_the_gate(self):
        run = Run("candidate", FakeApi())
        # 공개 읽기 둘은 신분 없이 보낸다: release gate와 공개 랭킹(그 거절까지)
        anonymous = {
            "/v1/release-readiness",
            "/v1/rankings?mode=all&period=week",
            "/v1/rankings?mode=season&period=week",
        }
        for method, path, headers, _ in run.api.requests:
            with self.subTest(request=f"{method} {path}"):
                self.assertEqual(headers["Origin"], "https://perust.github.io")
                authenticated = path not in anonymous
                self.assertEqual("Authorization" in headers, authenticated)
                self.assertEqual("X-Player-Id" in headers, authenticated)
        # 랭킹은 읽기만 한다 — 판을 열지 않으므로 기록을 남기지 않는다
        self.assertFalse(
            any(
                path.startswith("/v1/rankings") and method != "GET"
                for method, path, _, _ in run.api.requests
            )
        )
        self.assertFalse(any(path.endswith("/start") for _, path, _, _ in run.api.requests))
        (path, headers), = run.api.upgrades
        self.assertEqual(path, "/v1/rooms/QZ7K2M/events")
        self.assertEqual(headers["Origin"], "https://perust.github.io")
        (ticket,) = run.api.tickets
        self.assertEqual(headers["Sec-WebSocket-Protocol"], f"qbb.v1, qbb.ticket.{ticket}")
        self.assertEqual(
            [(method, path) for method, path, _, _ in run.api.requests][-2:],
            [("DELETE", "/v1/rooms/QZ7K2M/members/me"), ("GET", "/v1/rooms/QZ7K2M")],
        )

    def test_websocket_sends_the_browsers_movement_then_closes_normally(self):
        run = Run("candidate", FakeApi())
        (channel,) = run.api.channels
        self.assertEqual(
            channel.sent,
            [("text", {"type": "movement", "x": 0.5, "y": 0.5, "moving": False}), ("close", 1000)],
        )
        self.assertTrue(channel.closed)

    def test_websocket_skips_other_frames_while_waiting_for_the_echo(self):
        run = Run("candidate", FakeApi(socket_noise=True))
        self.assertEqual(run.code, 0, run.lines)
        self.assertEqual(run.lines[6], WEBSOCKET_OK)
        self.assertNotIn("room-invalidated", run.output)

    def test_websocket_closed_or_dropped_after_the_101_fails_and_still_cleans_up(self):
        for options, reason in (
            # hub.activate가 거절하면 accept 바로 뒤에 1012로 닫는다.
            ({"socket_close": 1012}, "server closed with 1012 before the movement echo"),
            # touch_member가 던지면 uvicorn은 close frame 없이 TCP를 끊는다.
            (
                {"socket_drop": True},
                "connection dropped without a close frame before the movement echo",
            ),
            ({"socket_echo": False}, "no movement echo within 3s"),
            ({"close_reply": 1011}, "close reply 1011, expected 1000"),
        ):
            with self.subTest(options=options):
                run = Run("candidate", FakeApi(**options))
                self.assertEqual(run.code, 1)
                self.assertEqual(run.lines[6], f"FAIL websocket: {reason}")
                self.assertTrue(run.api.channels[0].closed)
                self.assert_left_the_room(run)
                self.assert_no_secret(run)

    def test_baseline_against_the_candidate_fails_the_gate_and_the_session(self):
        # 013 API를 baseline으로 보면: gate가 13이고 세션이 혼자 온라인 판을 알린다
        run = Run("baseline", FakeApi(schema_version=13))
        self.assertEqual(run.code, 1)
        self.assertEqual(
            run.lines[0],
            "FAIL readiness: schemaVersion=13 (want 12)",
        )
        self.assertEqual(run.lines[1], "FAIL session: soloPlay=true (want missing)")
        self.assertEqual(
            [line.split(":")[0] for line in run.lines[2:]],
            [
                "ok nickname",
                "ok rankings",
                "ok room",
                "ok room-settings",
                "ok websocket",
                "ok cleanup",
            ],
        )
        self.assert_left_the_room(run)
        self.assert_no_secret(run)

    def test_baseline_is_the_rankings_api_without_solo_play(self):
        # 이 경계의 baseline은 012 API(#108)다: 문항 시간·랭킹·닉네임 규칙은 있고 혼자 온라인 판은 없다
        run = Run("baseline", FakeApi(schema_version=12, solo_play=False))
        self.assertEqual(run.code, 0, run.lines)
        self.assertEqual(
            [line.split(":")[0] for line in run.lines],
            [
                "ok readiness",
                "ok session",
                "ok nickname",
                "ok rankings",
                "ok room",
                "ok room-settings",
                "ok websocket",
                "ok cleanup",
            ],
        )
        self.assertEqual(run.lines[0], "ok readiness: HTTP 200 ready character-only-v1 schemaVersion 12")
        self.assertEqual(
            run.lines[1], "ok session: HTTP 200 playerId is this identity, rankings true, no soloPlay"
        )
        self.assertTrue(run.lines[3].startswith("ok rankings: anonymous week HTTP 200"), run.lines[3])
        # 랭킹은 읽기만 하고 판도 혼자 판도 열지 않는다
        self.assertFalse(
            any(
                path == "/v1/solo" or path.endswith("/start") or (
                    path.startswith("/v1/rankings") and method != "GET"
                )
                for method, path, _, _ in run.api.requests
            )
        )
        # 012 API의 방 설정(문항 시간)도 baseline이 본다
        self.assertTrue(
            any(
                path.endswith("QZ7K2M") and method == "PATCH"
                for method, path, _, _ in run.api.requests
            )
        )
        self.assert_left_the_room(run)

    def test_baseline_against_the_011_api_fails_session_nickname_and_rankings(self):
        # 011 API는 이 경계의 baseline이 아니다 — #108의 migration 012 경계를 먼저 마친다
        run = Run("baseline", FakeApi(schema_version=11, rankings=False, nickname_filter=False))
        self.assertEqual(run.code, 1)
        self.assertEqual(run.lines[0], "FAIL readiness: schemaVersion=11 (want 12)")
        self.assertEqual(run.lines[1], "FAIL session: rankings=missing (want true)")
        self.assertEqual(
            run.lines[2], "FAIL nickname: HTTP 200, expected HTTP 400 nickname-personal-info"
        )
        self.assertEqual(run.lines[3], "FAIL rankings: anonymous week: HTTP 404, expected 200")
        self.assertEqual(run.lines[6], WEBSOCKET_OK)
        self.assert_left_the_room(run)

    def test_baseline_against_an_api_without_question_time_fails_the_room(self):
        run = Run("baseline", FakeApi(schema_version=12, question_time=False, solo_play=False))
        self.assertEqual(run.code, 1)
        self.assertIn("FAIL room: room QZ7K2M: questionTimeMs=missing (want 20000)", run.lines)
        self.assert_left_the_room(run)

    def test_migrated_baseline_passes_only_on_the_expected_migration_required_gate(self):
        # README 단계 3: DB는 013인데 012 API가 아직 돈다. gate는 닫히고 세션·랭킹·방·소켓은 돈다.
        api = FakeApi(readiness_error=(503, "migration-required"), solo_play=False)
        run = Run("baseline-migrated", api)
        self.assertEqual(run.code, 0, run.lines)
        self.assertEqual(
            run.lines[0],
            "ok readiness: HTTP 503 migration-required (closed as expected after migration 013)",
        )
        self.assertEqual(
            run.lines[1], "ok session: HTTP 200 playerId is this identity, rankings true, no soloPlay"
        )
        self.assertEqual(
            [line.split(":")[0] for line in run.lines[2:]],
            [
                "ok nickname",
                "ok rankings",
                "ok room",
                "ok room-settings",
                "ok websocket",
                "ok cleanup",
            ],
        )
        self.assert_no_secret(run)

        for options, reason in (
            ({"schema_version": 12}, "HTTP 200, expected HTTP 503 migration-required"),
            (
                {"readiness_error": (503, "database-unavailable")},
                "HTTP 503 database-unavailable, expected HTTP 503 migration-required",
            ),
            (
                {"readiness_error": (503, "migration-required"), "cors_origin": None},
                CORS_FAILURE,
            ),
        ):
            with self.subTest(options=options):
                run = Run("baseline-migrated", FakeApi(solo_play=False, **options))
                self.assertEqual(run.code, 1)
                self.assertEqual(run.lines[0], f"FAIL readiness: {reason}")
                self.assert_left_the_room(run)

    def test_baseline_after_migration_points_at_the_migrated_mode(self):
        run = Run("baseline", FakeApi(readiness_error=(503, "migration-required"), solo_play=False))
        self.assertEqual(run.code, 1)
        self.assertEqual(
            run.lines[0],
            "FAIL readiness: HTTP 503 migration-required, expected 200 "
            "(after migration 013 run baseline-migrated instead)",
        )
        candidate = Run("candidate", FakeApi(readiness_error=(503, "migration-required")))
        self.assertEqual(
            candidate.lines[0],
            "FAIL readiness: HTTP 503 migration-required, expected 200",
        )

    def test_readiness_must_match_exactly(self):
        run = Run("candidate", FakeApi(readiness_extra={"debug": True}))
        self.assertEqual(run.code, 1)
        self.assertEqual(run.lines[0], "FAIL readiness: unexpected field(s) debug")
        self.assert_left_the_room(run)

    def test_cors_that_does_not_allow_the_pages_origin_fails_the_gate_and_the_session(self):
        for cors_origin in (None, "https://evil.example"):
            with self.subTest(cors_origin=cors_origin):
                run = Run("candidate", FakeApi(cors_origin=cors_origin))
                self.assertEqual(run.code, 1)
                self.assertEqual(run.lines[0], f"FAIL readiness: {CORS_FAILURE}")
                self.assertEqual(run.lines[1], f"FAIL session: {CORS_FAILURE}")
                self.assertEqual(run.lines[2], f"FAIL nickname: {CORS_FAILURE}")
                self.assertEqual(run.lines[3], f"FAIL rankings: anonymous week: {CORS_FAILURE}")
                self.assertEqual(run.lines[6], WEBSOCKET_OK)
                self.assert_left_the_room(run)
                self.assert_no_secret(run)

    def test_candidate_room_must_show_me_connected(self):
        run = Run("candidate", FakeApi(connected=False))
        self.assertEqual(run.code, 1)
        self.assertEqual(run.lines[4], "FAIL room: room QZ7K2M: connected=false (want true)")
        self.assert_left_the_room(run)

    def test_candidate_against_an_api_without_rankings_fails_session_nickname_and_rankings(self):
        # 011 API를 candidate로 보면: 세션이 랭킹을 알리지 않고, 닉네임을 거절하지 않고, 경로가 없다
        run = Run("candidate", FakeApi(rankings=False, nickname_filter=False))
        self.assertEqual(run.code, 1)
        self.assertEqual(
            run.lines[1],
            "FAIL session: rankings=missing (want true); soloPlay=missing (want true)",
        )
        self.assertEqual(
            run.lines[2], "FAIL nickname: HTTP 200, expected HTTP 400 nickname-personal-info"
        )
        self.assertEqual(run.lines[3], "FAIL rankings: anonymous week: HTTP 404, expected 200")
        self.assertEqual(run.lines[6], WEBSOCKET_OK)
        self.assert_left_the_room(run)

    def test_candidate_against_the_012_api_fails_the_gate_and_the_session(self):
        # 012 API(#108)를 candidate로 보면: gate가 12이고 세션이 혼자 온라인 판을 알리지 않는다.
        # 랭킹은 같은 것이라 통한다
        run = Run("candidate", FakeApi(schema_version=12, solo_play=False))
        self.assertEqual(run.code, 1)
        self.assertEqual(run.lines[0], "FAIL readiness: schemaVersion=12 (want 13)")
        self.assertEqual(run.lines[1], "FAIL session: soloPlay=missing (want true)")
        self.assertTrue(run.lines[3].startswith("ok rankings"), run.lines[3])
        self.assert_left_the_room(run)

    def test_candidate_on_a_migration_12_database_fails_the_gate(self):
        # 013 API는 012 DB 위에서 돌지 않는다 — 그 gate는 503 migration-required로 닫힌다
        run = Run("candidate", FakeApi(readiness_error=(503, "migration-required")))
        self.assertEqual(run.code, 1)
        self.assertEqual(run.lines[0], "FAIL readiness: HTTP 503 migration-required, expected 200")

    def test_rankings_must_carry_exactly_the_public_fields(self):
        for options, reason in (
            (
                {"ranking_entry_extra": {"playerId": "leak"}},
                "anonymous week: entry 1 does not carry exactly the public fields",
            ),
            ({"ranking_extra": {"debug": True}}, "anonymous week: unexpected field(s) debug"),
            ({"anonymous_mine": True}, "anonymous week: an anonymous read marked an entry as mine"),
        ):
            with self.subTest(options=options):
                run = Run("candidate", FakeApi(**options))
                self.assertEqual(run.code, 1)
                self.assertEqual(run.lines[3], f"FAIL rankings: {reason}")
                self.assert_left_the_room(run)
                self.assert_no_secret(run)

    def test_candidate_against_an_api_without_question_time_fails_the_room(self):
        run = Run("candidate", FakeApi(question_time=False))
        self.assertEqual(run.code, 1)
        self.assertIn("FAIL room: room QZ7K2M: questionTimeMs=missing (want 20000)", run.lines)
        self.assert_left_the_room(run)

    def test_readiness_honours_retry_after_at_most_twice(self):
        run = Run("candidate", FakeApi(readiness_429=3))
        self.assertEqual(run.sleeps, [3, 3])
        self.assertEqual(run.lines[0], "FAIL readiness: HTTP 429 rate-limited, expected 200")
        self.assertEqual(len(run.notes), 2)

        recovered = Run("candidate", FakeApi(readiness_429=2))
        self.assertEqual(recovered.code, 0, recovered.lines)
        self.assertEqual(recovered.sleeps, [3, 3])

    def test_websocket_403_retries_once_with_a_fresh_ticket(self):
        run = Run("candidate", FakeApi(upgrade_403=1))
        self.assertEqual(run.code, 0, run.lines)
        self.assertEqual(len(run.api.tickets), 2)
        self.assertIn("after one 403 retry", run.lines[6])
        self.assert_no_secret(run)

        refused = Run("candidate", FakeApi(upgrade_403=2))
        self.assertEqual(refused.code, 1)
        self.assertEqual(
            refused.lines[6],
            "FAIL websocket: upgrade HTTP 403 after one 403 retry, expected 101",
        )
        self.assertEqual(len(refused.api.tickets), 2)
        self.assertEqual(refused.api.rooms, {})

    def test_ctrl_c_still_leaves_the_room(self):
        run = Run("candidate", FakeApi(interrupt=("POST", "/v1/rooms/QZ7K2M/ws-ticket")))
        self.assertEqual(run.code, 130)
        self.assertEqual(run.lines[-2], "FAIL websocket: interrupted (Ctrl-C)")
        self.assert_left_the_room(run)

    def test_sigterm_through_the_installed_handler_still_leaves_the_room(self):
        previous = smoke.trap_termination()
        try:
            run = Run("candidate", FakeApi(terminate=("POST", "/v1/rooms/QZ7K2M/ws-ticket")))
        finally:
            smoke.restore_signals(previous)
        self.assertEqual(run.code, 143)
        self.assertEqual(run.lines[-2], "FAIL websocket: interrupted (SIGTERM)")
        self.assert_left_the_room(run)

    def test_main_traps_sigterm_for_the_run_and_restores_the_handler(self):
        before = signal.getsignal(signal.SIGTERM)
        api = FakeApi(terminate=("POST", "/v1/rooms"))
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(smoke, "HttpTransport", lambda api_url, resolve_to=None: api):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = smoke.main(["candidate", "--api", "http://127.0.0.1:9"])
        self.assertEqual(code, 143)
        lines = stdout.getvalue().splitlines()
        self.assertEqual(lines[4], "FAIL room: interrupted (SIGTERM)")
        # 만들기 요청이 답을 받기 전에 멈췄다. 이 신분이 든 방을 찾아 나간다.
        self.assertEqual(lines[-1], "ok cleanup: left room QZ7K2M, GET -> 404")
        self.assertEqual(api.rooms, {})
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)

    def test_lost_room_response_is_found_by_membership_and_left(self):
        api = FakeApi()
        original = api.request

        def drop_create_response(method, path, headers, data=None):
            reply = original(method, path, headers, data)
            if (method, path) == ("POST", "/v1/rooms"):
                raise TimeoutError("timed out")
            return reply

        api.request = drop_create_response
        run = Run("candidate", api)
        self.assertEqual(run.code, 1)
        self.assertEqual(run.lines[4], "FAIL room: TimeoutError: timed out")
        self.assertEqual(run.lines[5], "FAIL room-settings: not run (no room)")
        self.assertEqual(run.sleeps, [])
        self.assert_left_the_room(run)

    def test_lost_room_response_waits_for_a_late_commit(self):
        api = FakeApi()
        original = api.request
        state = {"pending": None, "lookups": 0}

        def commit_late(method, path, headers, data=None):
            if (method, path) == ("POST", "/v1/rooms"):
                state["pending"] = (method, path, headers, data)
                raise TimeoutError("timed out")
            if (method, path) == ("GET", "/v1/rooms"):
                state["lookups"] += 1
                if state["lookups"] == 3:
                    original(*state["pending"])
            return original(method, path, headers, data)

        api.request = commit_late
        run = Run("candidate", api)
        self.assertEqual(run.code, 1)
        self.assertEqual(run.sleeps, [2, 3])
        self.assert_left_the_room(run)

    def test_lost_room_response_without_a_room_is_not_reported_as_clean(self):
        api = FakeApi()
        original = api.request

        def never_answer_create(method, path, headers, data=None):
            if (method, path) == ("POST", "/v1/rooms"):
                raise ConnectionResetError("reset")
            return original(method, path, headers, data)

        api.request = never_answer_create
        run = Run("candidate", api)
        self.assertEqual(run.code, 1)
        self.assertEqual(run.sleeps, [2, 3, 5, 5])
        self.assertEqual(
            run.lines[-1],
            "FAIL cleanup: create outcome unknown; no joined room seen",
        )

    def test_refused_room_is_checked_once(self):
        api = FakeApi()
        original = api.request

        def refuse_create(method, path, headers, data=None):
            if (method, path) == ("POST", "/v1/rooms"):
                return error(429, "rate-limited")
            return original(method, path, headers, data)

        api.request = refuse_create
        run = Run("candidate", api)
        self.assertEqual(run.lines[4], "FAIL room: HTTP 429 rate-limited, expected 201")
        self.assertEqual(run.lines[-1], "ok cleanup: nothing to leave (no room)")
        self.assertEqual(run.sleeps, [])

    def test_report_scrubs_a_secret_that_reaches_a_message(self):
        lines = []
        report = smoke.Report(write=lines.append, note=lines.append)
        report.keep_secret("s3cr3t-ticket-value-0123456789abcdef")
        report.fail("websocket", "boom s3cr3t-ticket-value-0123456789abcdef")
        report.note("note s3cr3t-ticket-value-0123456789abcdef")
        self.assertEqual(lines, ["FAIL websocket: boom <redacted>", "note <redacted>"])


class LoopbackServer:
    """한 번만 받는 TCP 서버. 요청 머리를 적고 callback으로 답한 뒤 after가 이어 받는다."""

    def __init__(self, respond, after=None) -> None:
        self.respond = respond
        self.after = after
        self.heads: list[bytes] = []
        self.trailing: list[bytes] = []
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        with self.listener:
            connection, _ = self.listener.accept()
            with connection:
                connection.settimeout(5)
                data = b""
                while b"\r\n\r\n" not in data:
                    data += connection.recv(4096)
                head, _, rest = data.partition(b"\r\n\r\n")
                self.heads.append(head)
                connection.sendall(self.respond(head))
                if self.after is not None:
                    self.trailing.append(self.after(connection, rest))
                    return
                try:
                    rest += connection.recv(4096)
                except OSError:
                    pass
                self.trailing.append(rest)

    def join(self) -> None:
        self.thread.join(5)


def header(head: bytes, name: str) -> str:
    for line in head.decode("latin-1").split("\r\n")[1:]:
        key, _, value = line.partition(":")
        if key.strip().lower() == name.lower():
            return value.strip()
    raise AssertionError(f"{name} missing")


def http_ok(payload: bytes):
    return lambda _: (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        + f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
        + payload
    )


def client_frames(data: bytes) -> list[tuple[int, bytes]]:
    """클라이언트가 보낸 가린 frame을 풀어 (opcode, payload)로 돌려준다.

    가리지 않은 frame이면 AssertionError, 아직 덜 온 frame이면 ValueError다.
    """
    frames = []
    while data:
        if len(data) < 2 or len(data) < 6 + (data[1] & 0x7F):
            raise ValueError("incomplete frame")
        opcode, length = data[0] & 0x0F, data[1] & 0x7F
        assert data[1] & 0x80, "client frames must be masked"
        assert length < 126
        mask, payload = data[2:6], data[6:6 + length]
        frames.append((opcode, bytes(b ^ mask[i % 4] for i, b in enumerate(payload))))
        data = data[6 + length:]
    return frames


def has_close(data: bytes) -> bool:
    try:
        return any(opcode == smoke.OPCODE_CLOSE for opcode, _ in client_frames(data))
    except ValueError:
        return False


def server_frame(opcode: int, payload: bytes) -> bytes:
    if len(payload) < 126:
        return bytes((0x80 | opcode, len(payload))) + payload
    return bytes((0x80 | opcode, 126)) + len(payload).to_bytes(2, "big") + payload


class TransportTests(unittest.TestCase):
    def test_rest_goes_to_the_resolve_to_ip_but_keeps_the_url_host(self):
        # smoke.invalid는 풀리지 않는 이름이다. 요청이 닿았다면 --resolve-to의 IP로 붙은 것이다.
        server = LoopbackServer(http_ok(body({"status": "ready"})))
        transport = smoke.HttpTransport(
            smoke.ApiUrl(tls=False, host="smoke.invalid", port=server.port),
            resolve_to="127.0.0.1",
        )
        reply = transport.request("GET", "/v1/release-readiness", {"Origin": smoke.PAGES_ORIGIN})
        server.join()
        self.assertEqual((reply.status, reply.json()), (200, {"status": "ready"}))
        self.assertTrue(server.heads[0].startswith(b"GET /v1/release-readiness HTTP/1.1"))
        self.assertEqual(header(server.heads[0], "Host"), f"smoke.invalid:{server.port}")

    def test_rest_over_https_goes_through_the_tls_socket(self):
        # http.client의 연결을 그대로 쓰면 --resolve-to를 잊고 https에 평문 토큰을 보낸다.
        server = LoopbackServer(http_ok(body({"status": "ready"})))
        transport = smoke.HttpTransport(
            smoke.parse_api(f"https://smoke.invalid:{server.port}"),
            context=mock.Mock(),
        )
        wrapped = socket.create_connection(("127.0.0.1", server.port), timeout=5)
        with mock.patch.object(transport, "open_socket", return_value=wrapped) as open_socket:
            reply = transport.request("GET", "/v1/release-readiness", {})
        server.join()
        open_socket.assert_called_once_with()
        self.assertEqual(reply.status, 200)
        self.assertEqual(header(server.heads[0], "Host"), f"smoke.invalid:{server.port}")

    def test_tls_sni_and_verification_use_the_url_host(self):
        api = smoke.parse_api(smoke.DEFAULT_API)
        context = mock.Mock()
        transport = smoke.HttpTransport(api, resolve_to="203.0.113.7", context=context)
        with mock.patch.object(smoke.socket, "create_connection") as create:
            transport.open_socket()
        create.assert_called_once_with(("203.0.113.7", 443), timeout=smoke.TIMEOUT_SECONDS)
        context.wrap_socket.assert_called_once_with(
            create.return_value,
            server_hostname="quiz-by-quiz-api.150.230.222.142.sslip.io",
        )
        self.assertTrue(smoke.HttpTransport(api).context.check_hostname)

    def test_upgrade_hands_over_a_channel_that_reads_and_writes_frames(self):
        notice = body({"type": "room-invalidated", "pad": "x" * 200})

        def answer(head: bytes) -> bytes:
            key = header(head, "Sec-WebSocket-Key")
            accept = base64.b64encode(
                hashlib.sha1(  # noqa: S324 - RFC 6455
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                ).digest()
            ).decode()
            # 101과 첫 frame을 한 번에 보낸다 — 머리 뒤에 같이 읽힌 바이트를 버리면 안 된다.
            return (
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n"
                "Sec-WebSocket-Protocol: qbb.v1\r\n\r\n"
            ).encode() + server_frame(smoke.OPCODE_TEXT, notice)

        def echo_until_close(connection: socket.socket, rest: bytes) -> bytes:
            data = rest
            while not has_close(data):
                data += connection.recv(4096)
            connection.sendall(server_frame(smoke.OPCODE_CLOSE, (1000).to_bytes(2, "big")))
            return data

        server = LoopbackServer(answer, echo_until_close)
        transport = smoke.HttpTransport(smoke.parse_api(f"http://127.0.0.1:{server.port}"))
        key = base64.b64encode(b"0123456789abcdef").decode()
        upgrade = transport.upgrade(
            "/v1/rooms/QZ7K2M/events",
            {"Sec-WebSocket-Key": key, "Sec-WebSocket-Protocol": "qbb.v1, qbb.ticket.x"},
        )
        deadline = time.monotonic() + 5
        try:
            self.assertEqual(upgrade.status, 101)
            self.assertEqual(upgrade.headers["sec-websocket-accept"], smoke.websocket_accept(key))
            self.assertEqual(upgrade.headers["sec-websocket-protocol"], "qbb.v1")
            first = upgrade.channel.read_frame(deadline)
            self.assertEqual(first, smoke.Frame(smoke.OPCODE_TEXT, notice))
            upgrade.channel.send_text('{"type":"movement"}')
            upgrade.channel.send_close()
            reply = upgrade.channel.read_frame(deadline)
        finally:
            upgrade.channel.close()
        server.join()
        self.assertEqual(smoke.close_code(reply), 1000)
        self.assertEqual(
            client_frames(server.trailing[0]),
            [(smoke.OPCODE_TEXT, b'{"type":"movement"}'), (smoke.OPCODE_CLOSE, b"\x03\xe8")],
        )

    def test_channel_reports_a_dropped_connection_and_a_masked_server_frame(self):
        left, right = socket.socketpair()
        with left, right:
            channel = smoke.WebSocketChannel(left, b"\x81\x05")
            right.close()
            self.assertIsNone(channel.read_frame(time.monotonic() + 5))
        left, right = socket.socketpair()
        with left, right:
            channel = smoke.WebSocketChannel(left, b"\x81\x80\x00\x00\x00\x00")
            with self.assertRaises(smoke.Failure):
                channel.read_frame(time.monotonic() + 5)
            with self.assertRaises(socket.timeout):
                smoke.WebSocketChannel(left).read_frame(time.monotonic() + 0.05)


if __name__ == "__main__":
    unittest.main()
