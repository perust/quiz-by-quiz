"""deploy/oracle/smoke.py — 운영 호스트의 python3 하나로 도는 배포 점검.

호스트에는 curl·jq·requests가 없을 수 있어 표준 라이브러리만 쓴다. 출력은 운영 기록에 남으므로
bearer 토큰·소켓 티켓·응답 본문이 한 글자도 새지 않아야 한다. 서버 흉내(FakeApi)는
server/app/main.py의 요청 모양·상태 코드·오류 코드를 그대로 따른다.
"""

import ast
import base64
import hashlib
import importlib.util
import json
import re
import socket
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

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


def body(value: object) -> bytes:
    return json.dumps(value).encode("utf-8")


def error(status: int, code: str, headers: dict | None = None):
    detail = {"code": code, "message": "…"}
    return smoke.Reply(status, dict(headers or {}), body({"detail": detail}))


class FakeApi:
    """The public API as server/app/main.py serves it, recording every request it sees."""

    def __init__(
        self,
        *,
        schema_version: int = 11,
        readiness_429: int = 0,
        upgrade_403: int = 0,
        interrupt: tuple[str, str] | None = None,
        question_time: bool = True,
    ) -> None:
        self.schema_version = schema_version
        self.readiness_429 = readiness_429
        self.upgrade_403 = upgrade_403
        self.interrupt = interrupt
        self.question_time = question_time
        self.requests: list[tuple[str, str, dict, object]] = []
        self.upgrades: list[tuple[str, dict]] = []
        self.tokens: set[str] = set()
        self.tickets: list[str] = []
        self.players: set[str] = set()
        self.rooms: dict[str, dict] = {}

    def _cors(self, headers: dict) -> dict:
        origin = headers.get("Origin")
        return {"access-control-allow-origin": origin} if origin == smoke.PAGES_ORIGIN else {}

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
        if path == "/v1/release-readiness":
            if self.readiness_429:
                self.readiness_429 -= 1
                return error(429, "rate-limited", {"retry-after": "3"})
            return self._ok(
                200,
                {
                    "status": "ready",
                    "contract": "character-only-v1",
                    "schemaVersion": self.schema_version,
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
            self.players.add(player)
            return self._ok(200, {"playerId": player}, headers)
        if player not in self.players:
            return error(401, "unauthorized")
        if (method, path) == ("POST", "/v1/rooms"):
            # 010 API는 모르는 필드를 거절한다(extra="forbid") — questionTimeMs가 없어야 한다.
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
                        "connected": True,
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
            self.tickets.append(ticket)
            return self._ok(201, {"ticket": ticket, "movementViewport": "x"}, headers)
        if (method, rest) == ("DELETE", "/members/me"):
            del self.rooms[code]
            return smoke.Reply(204, self._cors(headers))
        raise AssertionError(f"unexpected request {method} {path}")

    def upgrade(self, path, headers):
        self.upgrades.append((path, dict(headers)))
        protocols = [item.strip() for item in headers["Sec-WebSocket-Protocol"].split(",")]
        ticket = protocols[1].removeprefix("qbb.ticket.")
        assert protocols[0] == "qbb.v1" and ticket in self.tickets
        if self.upgrade_403:
            self.upgrade_403 -= 1
            return smoke.Reply(403, {})
        accept = base64.b64encode(
            hashlib.sha1(  # noqa: S324 - RFC 6455
                (headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()
        ).decode()
        return smoke.Reply(
            101,
            {
                "upgrade": "websocket",
                "connection": "Upgrade",
                "sec-websocket-accept": accept,
                "sec-websocket-protocol": "qbb.v1",
            },
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
        self.assertIn("baseline", result.stdout)
        self.assertIn("--resolve-to", result.stdout)

    def test_rejects_plain_http_off_loopback_and_bad_arguments(self):
        for argv in (
            ["candidate", "--api", "http://quiz-by-quiz-api.150.230.222.142.sslip.io"],
            ["candidate", "--api", "https://example.test/?token=x"],
            ["candidate", "--resolve-to", "not-an-ip"],
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


class SmokeRunTests(unittest.TestCase):
    def assert_no_secret(self, run: Run) -> None:
        self.assertTrue(run.api.tokens)
        self.assertTrue(run.api.tickets)
        for secret in run.api.tokens | set(run.api.tickets):
            self.assertNotIn(secret, run.output)
        self.assertNotIn("Bearer", run.output)

    def test_candidate_passes_with_one_line_per_step_and_no_secret(self):
        run = Run("candidate", FakeApi())
        self.assertEqual(run.code, 0, run.lines)
        self.assertEqual(
            [line.split(":")[0] for line in run.lines],
            [
                "ok readiness",
                "ok session",
                "ok room",
                "ok room-settings",
                "ok websocket",
                "ok cleanup",
            ],
        )
        self.assertIn("questionTimeMs 20000", run.lines[2])
        self.assertIn("400 invalid-question-time", run.lines[3])
        self.assertEqual(run.lines[5], "ok cleanup: left room QZ7K2M, GET -> 404")
        self.assertEqual(run.api.rooms, {})
        self.assert_no_secret(run)

    def test_every_request_carries_the_pages_origin_and_auth_only_after_the_gate(self):
        run = Run("candidate", FakeApi())
        for method, path, headers, _ in run.api.requests:
            with self.subTest(request=f"{method} {path}"):
                self.assertEqual(headers["Origin"], "https://perust.github.io")
                authenticated = path != "/v1/release-readiness"
                self.assertEqual("Authorization" in headers, authenticated)
                self.assertEqual("X-Player-Id" in headers, authenticated)
        (path, headers), = run.api.upgrades
        self.assertEqual(path, "/v1/rooms/QZ7K2M/events")
        self.assertEqual(headers["Origin"], "https://perust.github.io")
        self.assertEqual(
            headers["Sec-WebSocket-Protocol"],
            f"qbb.v1, qbb.ticket.{run.api.tickets[0]}",
        )
        self.assertEqual(
            [(method, path) for method, path, _, _ in run.api.requests][-2:],
            [("DELETE", "/v1/rooms/QZ7K2M/members/me"), ("GET", "/v1/rooms/QZ7K2M")],
        )

    def test_baseline_against_the_candidate_fails_the_gate_and_still_cleans_up(self):
        run = Run("baseline", FakeApi(schema_version=11))
        self.assertEqual(run.code, 1)
        self.assertEqual(
            run.lines[0],
            "FAIL readiness: schemaVersion=11 (want 10)",
        )
        self.assertEqual(
            [line.split(":")[0] for line in run.lines[1:]],
            ["ok session", "ok room", "ok websocket", "ok cleanup"],
        )
        self.assertEqual(run.api.rooms, {})
        self.assert_no_secret(run)

    def test_baseline_does_not_send_or_require_the_question_time(self):
        run = Run("baseline", FakeApi(schema_version=10, question_time=False))
        self.assertEqual(run.code, 0, run.lines)
        self.assertFalse(any(path.endswith("QZ7K2M") and method == "PATCH"
                             for method, path, _, _ in run.api.requests))

    def test_candidate_against_an_api_without_question_time_fails_the_room(self):
        run = Run("candidate", FakeApi(question_time=False))
        self.assertEqual(run.code, 1)
        self.assertIn("FAIL room: room QZ7K2M: questionTimeMs=missing (want 20000)", run.lines)
        self.assertEqual(run.lines[-1], "ok cleanup: left room QZ7K2M, GET -> 404")

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
        self.assertIn("after one 403 retry", run.lines[4])
        self.assert_no_secret(run)

        refused = Run("candidate", FakeApi(upgrade_403=2))
        self.assertEqual(refused.code, 1)
        self.assertEqual(
            refused.lines[4],
            "FAIL websocket: upgrade HTTP 403 after one 403 retry, expected 101",
        )
        self.assertEqual(len(refused.api.tickets), 2)
        self.assertEqual(refused.api.rooms, {})

    def test_ctrl_c_still_leaves_the_room(self):
        run = Run("candidate", FakeApi(interrupt=("POST", "/v1/rooms/QZ7K2M/ws-ticket")))
        self.assertEqual(run.code, 130)
        self.assertEqual(run.lines[-2], "FAIL websocket: interrupted (Ctrl-C)")
        self.assertEqual(run.lines[-1], "ok cleanup: left room QZ7K2M, GET -> 404")
        self.assertEqual(run.api.rooms, {})

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
        self.assertEqual(run.lines[2], "FAIL room: TimeoutError: timed out")
        self.assertEqual(run.lines[3], "FAIL room-settings: not run (no room)")
        self.assertEqual(run.lines[-1], "ok cleanup: left room QZ7K2M, GET -> 404")
        self.assertEqual(api.rooms, {})

    def test_report_scrubs_a_secret_that_reaches_a_message(self):
        lines = []
        report = smoke.Report(write=lines.append, note=lines.append)
        report.keep_secret("s3cr3t-ticket-value-0123456789abcdef")
        report.fail("websocket", "boom s3cr3t-ticket-value-0123456789abcdef")
        report.note("note s3cr3t-ticket-value-0123456789abcdef")
        self.assertEqual(lines, ["FAIL websocket: boom <redacted>", "note <redacted>"])


class LoopbackServer:
    """One-shot TCP server that records each request head and answers from a callback."""

    def __init__(self, respond) -> None:
        self.respond = respond
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


class TransportTests(unittest.TestCase):
    def test_resolve_to_connects_to_the_ip_but_keeps_the_url_host(self):
        payload = body({"status": "ready"})
        server = LoopbackServer(
            lambda _: b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
            + payload
        )
        transport = smoke.HttpTransport(
            smoke.parse_api(f"http://localhost:{server.port}"),
            resolve_to="127.0.0.1",
        )
        reply = transport.request("GET", "/v1/release-readiness", {"Origin": smoke.PAGES_ORIGIN})
        server.join()
        self.assertEqual((reply.status, reply.json()), (200, {"status": "ready"}))
        self.assertTrue(server.heads[0].startswith(b"GET /v1/release-readiness HTTP/1.1"))
        self.assertEqual(header(server.heads[0], "Host"), f"localhost:{server.port}")

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

    def test_upgrade_reads_the_101_and_closes_with_a_close_frame(self):
        def answer(head: bytes) -> bytes:
            key = header(head, "Sec-WebSocket-Key")
            accept = base64.b64encode(
                hashlib.sha1(  # noqa: S324 - RFC 6455
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                ).digest()
            ).decode()
            return (
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n"
                "Sec-WebSocket-Protocol: qbb.v1\r\n\r\n"
            ).encode()

        server = LoopbackServer(answer)
        transport = smoke.HttpTransport(smoke.parse_api(f"http://127.0.0.1:{server.port}"))
        key = base64.b64encode(b"0123456789abcdef").decode()
        reply = transport.upgrade(
            "/v1/rooms/QZ7K2M/events",
            {"Sec-WebSocket-Key": key, "Sec-WebSocket-Protocol": "qbb.v1, qbb.ticket.x"},
        )
        server.join()
        self.assertEqual(reply.status, 101)
        self.assertEqual(reply.headers["sec-websocket-accept"], smoke.websocket_accept(key))
        self.assertEqual(reply.headers["sec-websocket-protocol"], "qbb.v1")
        frame = server.trailing[0]
        self.assertEqual(frame[:2], b"\x88\x82")
        masked = frame[6:8]
        self.assertEqual(bytes(b ^ frame[2 + i] for i, b in enumerate(masked)), b"\x03\xe8")


if __name__ == "__main__":
    unittest.main()
