#!/usr/bin/env python3
"""Smoke-test the public quiz-by-quiz online API the way the Pages client uses it.

Run on the Oracle host with the system interpreter (Python 3.8+, standard
library only — no curl, jq, openssl, requests or websockets)::

    python3 deploy/oracle/smoke.py baseline     # the serving migration-010 API
    python3 deploy/oracle/smoke.py candidate    # the migration-011 API that replaces it
    python3 deploy/oracle/smoke.py candidate --resolve-to 127.0.0.1
    python3 deploy/oracle/smoke.py candidate --api http://127.0.0.1:18083

One throwaway browser identity walks through the release gate, a session, a
public two-seat room, the room's question time (candidate only) and the event
WebSocket handshake, and then always leaves the room again — after a failure or
Ctrl-C too. Each step prints one line, ``ok <step>: ...`` or
``FAIL <step>: <reason>``; retries are noted on stderr. The exit status is 0
only when every line is ``ok`` (1 otherwise, 130 after Ctrl-C, 2 for bad
arguments). Bearer tokens, WebSocket tickets and response bodies are never
printed, only status codes, error codes and the checked fields.

``--resolve-to IP`` opens the TCP connection to IP but keeps the URL host for
the Host header and for TLS SNI and certificate verification, for a host that
cannot reach its own public address (hairpin NAT). ``http://`` is accepted only
for a loopback API, like the browser client.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import ssl
import sys
import time
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlsplit

DEFAULT_API = "https://quiz-by-quiz-api.150.230.222.142.sslip.io"
# Pages에서 온 브라우저의 Origin. 모든 요청에 싣고, CORS가 이것을 들이는지도 본다.
PAGES_ORIGIN = "https://perust.github.io"
RELEASE_CONTRACT = "character-only-v1"
# 모드마다 공개 release gate가 답해야 하는 migration 판
# (server/app/main.py의 RELEASE_SCHEMA_VERSION)
SCHEMA_VERSIONS = {"baseline": 10, "candidate": 11}
WEBSOCKET_PROTOCOL = "qbb.v1"
WEBSOCKET_TICKET_PREFIX = "qbb.ticket."
_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# migration 011의 방 문항 시간. 보내지 않으면 20초이고 20초·40초 말고는 거절된다
# (server/app/domain.py)
DEFAULT_QUESTION_TIME_MS = 20_000
LONG_QUESTION_TIME_MS = 40_000
REJECTED_QUESTION_TIME_MS = 30_000
REJECTED_QUESTION_TIME_CODE = "invalid-question-time"
NICKNAME = "점검"
CHARACTER_ID = "slime-blue"
ROOM_NAME = "배포 점검"
USER_AGENT = "quiz-by-quiz-smoke/1"
TIMEOUT_SECONDS = 10.0
MAX_BODY_BYTES = 1 << 20
MAX_HEAD_BYTES = 16 << 10
# release gate는 IP당 12/60초다. 429면 Retry-After를 따르되 두 번까지만,
# 한 번에 이만큼까지만 기다린다.
READINESS_RETRIES = 2
MAX_RETRY_AFTER_SECONDS = 120
_IDENTITY_ALPHABET ="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_ROOM_CODE = re.compile(r"[A-Z0-9]{6}")
_TICKET = re.compile(r"[A-Za-z0-9_-]{32,256}")
_ERROR_CODE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
_FIELD_NAME = re.compile(r"[A-Za-z0-9_]{1,40}")
_STATUS_CODE = re.compile(r"[0-9]{3}")
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_MISSING = object()


class Failure(Exception):
    """A step's check did not hold. The message is printed, so it never carries a secret."""


@dataclass(frozen=True)
class ApiUrl:
    tls: bool
    host: str
    port: int
    path: str = ""

    @property
    def host_header(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return host if self.port == (443 if self.tls else 80) else f"{host}:{self.port}"


def parse_api(raw: str) -> ApiUrl:
    parts = urlsplit(raw)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ValueError("--api must be an https:// URL")
    if parts.scheme == "http" and parts.hostname not in _LOOPBACK_HOSTS:
        raise ValueError("--api may use http:// only for localhost, 127.0.0.1 or [::1]")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("--api must not carry credentials, a query or a fragment")
    try:
        port = parts.port
    except ValueError as error:
        raise ValueError("--api has an invalid port") from error
    tls = parts.scheme == "https"
    return ApiUrl(
        tls=tls,
        host=parts.hostname,
        port=port or (443 if tls else 80),
        path=parts.path.rstrip("/"),
    )


def parse_ip(raw: str) -> str:
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError as error:
        raise ValueError("--resolve-to must be an IP address") from error


@dataclass
class Reply:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def json(self) -> object:
        try:
            return json.loads(self.body.decode("utf-8"))
        except ValueError as error:
            raise Failure(f"HTTP {self.status} body is not JSON") from error

    def json_object(self) -> dict[str, object]:
        value = self.json()
        if not isinstance(value, dict):
            raise Failure(f"HTTP {self.status} body is not a JSON object")
        return value

    def error_code(self) -> str | None:
        """The API's ``detail.code`` (server/app/main.py ``_error``) when it looks like one."""
        try:
            value = json.loads(self.body.decode("utf-8"))
        except ValueError:
            return None
        detail = value.get("detail") if isinstance(value, dict) else None
        code = detail.get("code") if isinstance(detail, dict) else None
        return code if isinstance(code, str) and _ERROR_CODE.fullmatch(code) else None


def _header_map(pairs: list[tuple[str, str]]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name, value in pairs:
        key = name.strip().lower()
        headers[key] = f"{headers[key]}, {value.strip()}" if key in headers else value.strip()
    return headers


class _PinnedConnection(http.client.HTTPConnection):
    """http.client over the transport's socket, so ``--resolve-to`` holds for REST too."""

    def __init__(self, transport: HttpTransport) -> None:
        super().__init__(transport.api.host, transport.api.port, timeout=transport.timeout)
        self._transport = transport

    def connect(self) -> None:
        self.sock = self._transport.open_socket()


class HttpTransport:
    """Talks to the API over plain sockets.

    With ``resolve_to`` the TCP peer is that IP while the Host header, TLS SNI and
    certificate verification keep the URL host.
    """

    def __init__(
        self,
        api: ApiUrl,
        *,
        resolve_to: str | None = None,
        timeout: float = TIMEOUT_SECONDS,
        context: ssl.SSLContext | None = None,
    ) -> None:
        self.api = api
        self.resolve_to = resolve_to
        self.timeout = timeout
        if context is None and api.tls:
            context = ssl.create_default_context()
        self.context = context

    def open_socket(self) -> socket.socket:
        sock = socket.create_connection(
            (self.resolve_to or self.api.host, self.api.port),
            timeout=self.timeout,
        )
        if self.context is None:
            return sock
        try:
            return self.context.wrap_socket(sock, server_hostname=self.api.host)
        except BaseException:
            sock.close()
            raise

    def request(
        self,
        method: str,
        path: str,
        headers: dict[str, str],
        body: bytes | None = None,
    ) -> Reply:
        connection = _PinnedConnection(self)
        try:
            connection.request(
                method,
                self.api.path + path,
                body=body,
                headers={"Host": self.api.host_header, **headers},
            )
            response = connection.getresponse()
            data = response.read(MAX_BODY_BYTES)
            return Reply(response.status, _header_map(response.getheaders()), data)
        finally:
            connection.close()

    def upgrade(self, path: str, headers: dict[str, str]) -> Reply:
        """Send one HTTP/1.1 WebSocket upgrade and close the socket right after the answer."""
        sock = self.open_socket()
        try:
            lines = [f"GET {self.api.path}{path} HTTP/1.1", f"Host: {self.api.host_header}"]
            lines.extend(f"{name}: {value}" for name, value in headers.items())
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
            status, response_headers = _parse_head(_read_head(sock))
            if status == 101:
                # 열린 소켓은 곧바로 닫는다. close frame을 먼저 보내 서버가 끊김을 바로 안다.
                try:
                    sock.sendall(_close_frame())
                except OSError:
                    pass
            return Reply(status, response_headers)
        finally:
            sock.close()


def _read_head(sock: socket.socket) -> bytes:
    data = b""
    while b"\r\n\r\n" not in data:
        if len(data) > MAX_HEAD_BYTES:
            raise Failure("upgrade response head is too large")
        chunk = sock.recv(4096)
        if not chunk:
            raise Failure("connection closed before the upgrade response")
        data += chunk
    return data.split(b"\r\n\r\n", 1)[0]


def _parse_head(head: bytes) -> tuple[int, dict[str, str]]:
    lines = head.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ", 2)
    if len(parts) < 2 or not parts[0].startswith("HTTP/1.") or not _STATUS_CODE.fullmatch(parts[1]):
        raise Failure("malformed upgrade response")
    pairs = []
    for line in lines[1:]:
        name, separator, value = line.partition(":")
        if separator:
            pairs.append((name, value))
    return int(parts[1]), _header_map(pairs)


def _close_frame() -> bytes:
    """A masked client close frame with status 1000 (RFC 6455 5.5.1)."""
    payload = (1000).to_bytes(2, "big")
    mask = os.urandom(4)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return bytes((0x88, 0x80 | len(payload))) + mask + masked


def websocket_accept(key: str) -> str:
    digest = hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()  # noqa: S324 - RFC 6455
    return base64.b64encode(digest).decode("ascii")


def _show(value: object) -> str:
    """A checked value, short enough for one line and never a free-form body."""
    if value is _MISSING:
        return "missing"
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and len(value) <= 40:
        return json.dumps(value)
    return f"<{type(value).__name__}>"


def _same(actual: object, expected: object) -> bool:
    # JSON의 true와 1을 같은 값으로 보지 않는다.
    return type(actual) is type(expected) and actual == expected


def field_problems(
    value: object,
    expected: dict[str, object],
    *,
    exact: bool = False,
) -> list[str]:
    if not isinstance(value, dict):
        return ["body is not a JSON object"]
    problems = [
        f"{key}={_show(value.get(key, _MISSING))} (want {_show(want)})"
        for key, want in expected.items()
        if not _same(value.get(key, _MISSING), want)
    ]
    extra = sorted(str(key) for key in value if key not in expected) if exact else []
    if extra:
        names = ", ".join(key if _FIELD_NAME.fullmatch(key) else "<field>" for key in extra)
        problems.append(f"unexpected field(s) {names}")
    return problems


def status_text(reply: Reply) -> str:
    code = reply.error_code()
    return f"HTTP {reply.status} {code}" if code else f"HTTP {reply.status}"


def expect_status(reply: Reply, *statuses: int, what: str = "") -> None:
    if reply.status in statuses:
        return
    wanted = " or ".join(str(status) for status in statuses)
    prefix = f"{what}: " if what else ""
    raise Failure(f"{prefix}{status_text(reply)}, expected {wanted}")


def cors_problems(reply: Reply) -> list[str]:
    if reply.headers.get("access-control-allow-origin") == PAGES_ORIGIN:
        return []
    return [f"CORS does not allow {PAGES_ORIGIN}"]


def retry_after_seconds(reply: Reply) -> int:
    raw = reply.headers.get("retry-after", "").strip()
    seconds = int(raw) if raw.isascii() and raw.isdigit() else 1
    return max(1, min(seconds, MAX_RETRY_AFTER_SECONDS))


def _describe(error: BaseException) -> str:
    text = str(error).strip()
    reason = f"{type(error).__name__}: {text}" if text else type(error).__name__
    return reason if len(reason) <= 160 else reason[:157] + "..."


def _print_line(line: str) -> None:
    print(line, flush=True)


def _print_note(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


class Report:
    """One line per step. Every secret this run handled is scrubbed from what it prints."""

    def __init__(self, write=_print_line, note=_print_note) -> None:
        self._write = write
        self._note = note
        self._secrets: set[str] = set()
        self.failed = False

    def keep_secret(self, value: str) -> None:
        if value:
            self._secrets.add(value)

    def _clean(self, text: str) -> str:
        for secret in sorted(self._secrets, key=len, reverse=True):
            text = text.replace(secret, "<redacted>")
        return text

    def ok(self, step: str, detail: str) -> None:
        self._write(self._clean(f"ok {step}: {detail}"))

    def fail(self, step: str, reason: str) -> None:
        self.failed = True
        self._write(self._clean(f"FAIL {step}: {reason}"))

    def note(self, text: str) -> None:
        self._note(self._clean(text))


class Smoke:
    """The steps of one run against one API with one fresh browser identity."""

    def __init__(self, mode: str, transport, report: Report, *, sleep=time.sleep) -> None:
        if mode not in SCHEMA_VERSIONS:
            raise ValueError(f"unknown mode {mode!r}")
        self.mode = mode
        self.candidate = mode == "candidate"
        self.transport = transport
        self.report = report
        self.sleep = sleep
        # 브라우저처럼 UUID 하나와 43자 비밀을 만든다 (src/online/network-rooms.ts의 randomIdentity)
        self.player_id = str(uuid.uuid4())
        self.token = "".join(secrets.choice(_IDENTITY_ALPHABET) for _ in range(43))
        report.keep_secret(self.token)
        self.session_ready = False
        self.room_requested = False
        self.room_code: str | None = None
        self.current: str | None = None

    def call(
        self,
        method: str,
        path: str,
        payload: object = None,
        *,
        auth: bool = True,
    ) -> Reply:
        headers = {"Origin": PAGES_ORIGIN, "Accept": "application/json", "User-Agent": USER_AGENT}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
            headers["X-Player-Id"] = self.player_id
        return self.transport.request(method, path, headers, body)

    def run(self) -> int:
        interrupted = False
        try:
            # release gate가 틀려도 나머지를 본다 — 011을 돌린 직후 010 API의 gate는 503이지만
            # 방과 소켓은 그대로 돌아야 한다(deploy/oracle/README.md의 단계 3).
            self._step("readiness", self.readiness)
            self._step("session", self.session)
            if not self.session_ready:
                self.report.fail("room", "not run (no session)")
            else:
                self._step("room", self.create_room)
            later = [("room-settings", self.room_settings)] if self.candidate else []
            later.append(("websocket", self.websocket))
            for name, action in later:
                if self.room_code is None:
                    self.report.fail(name, "not run (no room)")
                else:
                    self._step(name, action)
        except KeyboardInterrupt:
            interrupted = True
            self.report.fail(self.current or "run", "interrupted (Ctrl-C)")
        finally:
            self._cleanup()
        if interrupted:
            return 130
        return 1 if self.report.failed else 0

    def _step(self, name: str, action) -> bool:
        # Ctrl-C는 여기서 잡지 않는다. run()이 이 이름으로 한 줄을 남기고 cleanup으로 간다.
        self.current = name
        try:
            detail = action()
        except Failure as failure:
            self.current = None
            self.report.fail(name, str(failure))
            return False
        except Exception as error:  # 네트워크·TLS·HTTP 오류도 그 단계의 FAIL 한 줄로 끝낸다
            self.current = None
            self.report.fail(name, _describe(error))
            return False
        self.current = None
        self.report.ok(name, detail)
        return True

    def _cleanup(self) -> None:
        try:
            self._step("cleanup", self.cleanup)
        except KeyboardInterrupt:
            left = (
                f"room {self.room_code} stays until the server's idle cleanup"
                if self.room_code
                else "nothing was confirmed"
            )
            self.report.fail("cleanup", f"interrupted (Ctrl-C); {left}")

    def readiness(self) -> str:
        version = SCHEMA_VERSIONS[self.mode]
        want = {"status": "ready", "contract": RELEASE_CONTRACT, "schemaVersion": version}
        reply = self.call("GET", "/v1/release-readiness", auth=False)
        for retry in range(1, READINESS_RETRIES + 1):
            if reply.status != 429:
                break
            wait = retry_after_seconds(reply)
            self.report.note(f"readiness: HTTP 429, retry {retry}/{READINESS_RETRIES} in {wait}s")
            self.sleep(wait)
            reply = self.call("GET", "/v1/release-readiness", auth=False)
        expect_status(reply, 200)
        problems = field_problems(reply.json(), want, exact=True) + cors_problems(reply)
        if problems:
            raise Failure("; ".join(problems))
        return f"HTTP 200 ready {RELEASE_CONTRACT} schemaVersion {version}"

    def session(self) -> str:
        reply = self.call(
            "PUT",
            "/v1/session",
            {"nickname": NICKNAME, "characterId": CHARACTER_ID},
        )
        expect_status(reply, 200)
        if reply.json_object().get("playerId") != self.player_id:
            raise Failure("playerId is not this identity")
        self.session_ready = True
        problems = cors_problems(reply)
        if problems:
            raise Failure("; ".join(problems))
        return "HTTP 200 playerId is this identity"

    def _only_me(self, players: object) -> dict[str, object] | None:
        if not isinstance(players, list) or len(players) != 1:
            return None
        player = players[0]
        if not isinstance(player, dict) or player.get("id") != self.player_id:
            return None
        return player

    def create_room(self) -> str:
        self.room_requested = True
        # questionTimeMs를 보내지 않는다 — 010 API는 모르는 필드를 거절하고, 011 API는 20초로 둔다.
        reply = self.call(
            "POST",
            "/v1/rooms",
            {"name": ROOM_NAME, "categoryId": None, "capacity": 2, "isPublic": True},
        )
        expect_status(reply, 201)
        room = reply.json_object()
        code = room.get("code")
        if not isinstance(code, str) or not _ROOM_CODE.fullmatch(code):
            raise Failure("room code is missing or malformed")
        self.room_code = code
        want: dict[str, object] = {"capacity": 2, "isPublic": True}
        if self.candidate:
            want.update(
                questionTimeMs=DEFAULT_QUESTION_TIME_MS,
                status="waiting",
                inMatch=False,
            )
        problems = field_problems(room, want)
        me = self._only_me(room.get("players"))
        if me is None:
            problems.append("players is not exactly this identity")
        elif self.candidate and me.get("connected") is not True:
            problems.append(f"connected={_show(me.get('connected', _MISSING))} (want true)")
        if problems:
            raise Failure(f"room {code}: " + "; ".join(problems))
        if self.candidate:
            return (
                f"HTTP 201 room {code} questionTimeMs {DEFAULT_QUESTION_TIME_MS}, waiting, "
                "inMatch false, only me, connected true"
            )
        return f"HTTP 201 room {code} public, capacity 2, only me"

    def room_settings(self) -> str:
        path = f"/v1/rooms/{self.room_code}"
        reply = self.call("GET", path)
        expect_status(reply, 200, what="GET")
        room = reply.json_object()
        problems = field_problems(room, {"questionTimeMs": DEFAULT_QUESTION_TIME_MS})
        players = room.get("players")
        if not isinstance(players, list) or not players or not all(
            isinstance(player, dict) and isinstance(player.get("connected"), bool)
            for player in players
        ):
            problems.append("players do not carry connected")
        if problems:
            raise Failure("GET: " + "; ".join(problems))

        what = f"PATCH {LONG_QUESTION_TIME_MS}"
        reply = self.call("PATCH", path, {"questionTimeMs": LONG_QUESTION_TIME_MS})
        expect_status(reply, 200, what=what)
        problems = field_problems(reply.json_object(), {"questionTimeMs": LONG_QUESTION_TIME_MS})
        if problems:
            raise Failure(f"{what}: " + "; ".join(problems))

        reply = self.call("PATCH", path, {"questionTimeMs": REJECTED_QUESTION_TIME_MS})
        if reply.status != 400 or reply.error_code() != REJECTED_QUESTION_TIME_CODE:
            raise Failure(
                f"PATCH {REJECTED_QUESTION_TIME_MS}: {status_text(reply)}, "
                f"expected HTTP 400 {REJECTED_QUESTION_TIME_CODE}"
            )
        return (
            f"GET questionTimeMs {DEFAULT_QUESTION_TIME_MS} with connected; "
            f"PATCH {LONG_QUESTION_TIME_MS} -> 200; "
            f"PATCH {REJECTED_QUESTION_TIME_MS} -> 400 {REJECTED_QUESTION_TIME_CODE}"
        )

    def websocket(self) -> str:
        code = self.room_code
        retried = ""
        for attempt in (1, 2):
            reply = self.call("POST", f"/v1/rooms/{code}/ws-ticket")
            expect_status(reply, 201, what="ws-ticket")
            ticket = reply.json_object().get("ticket")
            if not isinstance(ticket, str) or not _TICKET.fullmatch(ticket):
                raise Failure("ws-ticket: ticket is missing or malformed")
            self.report.keep_secret(ticket)
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            # 브라우저와 같은 두 subprotocol이다. 티켓은 URL이 아니라 이 헤더로만 간다.
            answer = self.transport.upgrade(
                f"/v1/rooms/{code}/events",
                {
                    "Upgrade": "websocket",
                    "Connection": "Upgrade",
                    "Sec-WebSocket-Key": key,
                    "Sec-WebSocket-Version": "13",
                    "Sec-WebSocket-Protocol": (
                        f"{WEBSOCKET_PROTOCOL}, {WEBSOCKET_TICKET_PREFIX}{ticket}"
                    ),
                    "Origin": PAGES_ORIGIN,
                    "User-Agent": USER_AGENT,
                },
            )
            if answer.status != 403 or attempt == 2:
                break
            # 티켓은 한 번 쓰면 사라지고 30초 뒤 만료된다. accept 전의 거절(403) 하나는 새 티켓으로
            # 한 번만 다시 붙어 낡은 티켓과 진짜 거절을 가른다.
            self.report.note("websocket: upgrade HTTP 403, retrying once with a fresh ticket")
            retried = " after one 403 retry"
        if answer.status != 101:
            raise Failure(f"upgrade HTTP {answer.status}{retried}, expected 101")
        problems = []
        if answer.headers.get("sec-websocket-protocol") != WEBSOCKET_PROTOCOL:
            problems.append(f"selected protocol is not {WEBSOCKET_PROTOCOL}")
        if answer.headers.get("sec-websocket-accept") != websocket_accept(key):
            problems.append("Sec-WebSocket-Accept does not match the key")
        if answer.headers.get("upgrade", "").lower() != "websocket":
            problems.append("Upgrade header is not websocket")
        if problems:
            raise Failure("upgrade HTTP 101 but " + "; ".join(problems))
        return f"HTTP 101 protocol {WEBSOCKET_PROTOCOL}{retried}, closed"

    def _joined_room_codes(self) -> list[str]:
        reply = self.call("GET", "/v1/rooms")
        expect_status(reply, 200, what="list rooms")
        rooms = reply.json()
        if not isinstance(rooms, list):
            raise Failure("list rooms: body is not a JSON list")
        return [
            room["code"]
            for room in rooms
            if isinstance(room, dict)
            and room.get("joined") is True
            and isinstance(room.get("code"), str)
            and _ROOM_CODE.fullmatch(room["code"])
        ]

    def cleanup(self) -> str:
        if not self.session_ready:
            return "nothing to leave (no session)"
        codes = [self.room_code] if self.room_code else []
        if not codes and self.room_requested:
            # 만들기 응답을 잃었어도 이 신분이 든 방은 모두 이 실행이 만든 것이다.
            codes = self._joined_room_codes()
        if not codes:
            return "nothing to leave (no room)"
        for code in codes:
            path = f"/v1/rooms/{code}"
            reply = self.call("DELETE", f"{path}/members/me")
            expect_status(reply, 204, 404, what=f"leave room {code}")
            reply = self.call("GET", path)
            if reply.status != 404:
                raise Failure(f"room {code} is still readable after leaving ({status_text(reply)})")
        return f"left room {', '.join(codes)}, GET -> 404"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="smoke.py",
        description="Smoke-test the public quiz-by-quiz online API as the Pages client uses it.",
    )
    parser.add_argument(
        "mode",
        choices=("baseline", "candidate"),
        help="baseline: the serving migration-010 API; candidate: the migration-011 API",
    )
    parser.add_argument("--api", default=DEFAULT_API, help=f"API base URL (default {DEFAULT_API})")
    parser.add_argument(
        "--resolve-to",
        metavar="IP",
        help="connect to IP but keep the URL host for the Host header and TLS",
    )
    args = parser.parse_args(argv)
    try:
        api = parse_api(args.api)
        resolve_to = parse_ip(args.resolve_to) if args.resolve_to else None
    except ValueError as error:
        parser.error(str(error))
    return Smoke(args.mode, HttpTransport(api, resolve_to=resolve_to), Report()).run()


if __name__ == "__main__":
    sys.exit(main())
