#!/usr/bin/env python3
"""Pages 화면이 쓰는 그대로 공개 quiz-by-quiz 온라인 API를 한 번 훑는 배포 점검.

운영 호스트의 시스템 python3(3.8 이상) 하나로 돈다. 표준 라이브러리만 쓴다 — curl·jq·openssl·
requests·websockets가 없어도 된다::

    python3 deploy/oracle/smoke.py baseline            # 지금 도는 migration-012 API(#108)
    python3 deploy/oracle/smoke.py baseline-migrated   # migration 013 뒤에도 아직 도는 그 API
    python3 deploy/oracle/smoke.py candidate           # 그 자리를 이어받는 migration-013 API
    python3 deploy/oracle/smoke.py candidate --resolve-to 127.0.0.1
    python3 deploy/oracle/smoke.py candidate --api http://127.0.0.1:18083

한 번 쓰고 버리는 브라우저 신분 하나가 release gate, 세션(혼자 온라인 판 soloPlay·soloUntimed·soloRestart는
candidate에만), 닉네임 금칙 규칙과 온라인 랭킹 읽기, 공개 2인 방, 방의 문항 시간, 이벤트 WebSocket을 차례로
지나고, candidate는 «제한 없음» 혼자 판 하나를 열어 마감이 없는지 본 뒤 기록 없이 끝낸다(DELETE /v1/solo,
PRD 10.1 #9·#11). 끝에는 언제나 방을 나가고 열린 혼자 판을 끝낸다 — 실패했거나 Ctrl-C·SIGTERM·SIGHUP으로
멈췄어도 그렇다. 단계마다 ``ok <step>: ...`` 또는 ``FAIL <step>: <reason>`` 한 줄이고, 다시 묻는
것은 stderr에 적는다. 종료 코드는 모든 줄이 ``ok``일 때만 0이다(그 밖에는 1, Ctrl-C 뒤 130,
SIGTERM 뒤 143, SIGHUP 뒤 129, 잘못된 인자 2). bearer 토큰·소켓 티켓·응답 본문은 출력하지 않고
상태 코드·오류 코드·확인한 필드만 적는다.

``baseline-migrated``는 deploy/oracle/README.md 단계 3의 상태다 — DB는 이미 013인데 012 API가
아직 돈다. 그 API의 gate는 503 ``migration-required``로 닫혀 있는 것이 정상이므로 이 모드는 그
답만 ok로 보고, 세션·닉네임·랭킹·방·소켓은 baseline과 같이 돌아야 한다. 랭킹은 읽기만 하고 쓰지
않는다 — 이 점검은 친구와 푸는 판을 열지 않고, candidate가 여는 혼자 판은 끝까지 풀지 않고 끝내므로
(``abandoned``) 랭킹 기록도 혼자 방도 남기지 않는다.

``--resolve-to IP``는 TCP만 그 IP로 붙고 Host 헤더와 TLS SNI·인증서 검증은 URL 호스트로 한다
(제 공인 주소로 돌아오지 못하는 호스트의 hairpin NAT). ``http://``는 브라우저 화면처럼 루프백
API에만 받고, 그때 ``--resolve-to``도 루프백이어야 한다 — 평문 토큰이 밖으로 나가지 않는다.
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
import signal
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
BASELINE = "baseline"
MIGRATED_BASELINE = "baseline-migrated"
CANDIDATE = "candidate"
MODES = (BASELINE, MIGRATED_BASELINE, CANDIDATE)
# 모드마다 공개 release gate가 답해야 하는 migration 판
# (server/app/main.py의 RELEASE_SCHEMA_VERSION)
SCHEMA_VERSIONS = {BASELINE: 12, CANDIDATE: 13}
# DB가 그 API의 판이 아니면 gate가 이 오류 코드의 503으로 닫힌다. baseline-migrated는 이것만 받는다.
MIGRATION_REQUIRED_CODE = "migration-required"
WEBSOCKET_PROTOCOL = "qbb.v1"
WEBSOCKET_TICKET_PREFIX = "qbb.ticket."
_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OPCODE_TEXT = 0x1
OPCODE_CLOSE = 0x8
CLOSE_NORMAL = 1000
# 브라우저가 소켓을 열자마자 보내는 움직임과 같은 모양이다(src/online/network-rooms.ts의
# movementPayload). viewport 없는 옛 모양이라 012·013 API가 모두 받는다.
PROBE_MOVEMENT = {"type": "movement", "x": 0.5, "y": 0.5, "moving": False}
# 소켓에서 움직임이 되돌아오고 close에 답이 오기를 각각 이만큼까지 기다린다.
WEBSOCKET_REPLY_SECONDS = 3.0
MAX_FRAME_BYTES = 64 << 10
# migration 011의 방 문항 시간. 보내지 않으면 20초이고 20초·40초 말고는 거절된다
# (server/app/domain.py)
DEFAULT_QUESTION_TIME_MS = 20_000
LONG_QUESTION_TIME_MS = 40_000
REJECTED_QUESTION_TIME_MS = 30_000
REJECTED_QUESTION_TIME_CODE = "invalid-question-time"
NICKNAME = "점검"
# migration 012 API의 닉네임 금칙 규칙(server/app/nickname_filter.py)이 개인 정보 모양으로 거절하는
# 이름. 거절된 세션 PUT은 프로필을 바꾸지 않는다.
REJECTED_NICKNAME = "점검@test.kr"
REJECTED_NICKNAME_CODE = "nickname-personal-info"
# 공개 랭킹 읽기 (GET /v1/rankings). 읽기만 한다
RANKING_LIMIT = 10
RANKING_TIME_ZONE = "Asia/Seoul"
RANKING_FIELDS = frozenset({"mode", "categoryId", "period", "window", "limit", "entries"})
RANKING_ENTRY_FIELDS = frozenset(
    {
        "rank",
        "nickname",
        "characterId",
        "score",
        "correctCount",
        "totalCount",
        "recordedAt",
        "isMine",
    }
)
REJECTED_RANKING_CODE = "invalid-ranking"
# candidate의 혼자 판 (FR-7.13 3단계): 전체 도전 «제한 없음»(questionTimeMs null, PRD 10.1 #9)을 열고, 마감이
# 없는지 본 뒤 DELETE /v1/solo로 기록 없이 끝낸다(#4의 끝내기). 혼자 방 하나·판 하나를 잠깐 쓴다
SOLO_START = {"categoryId": None, "questionTimeMs": None}
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
# 만들기 응답을 받지 못했으면(시간 초과·끊김) 방이 생겼는지 모른다. 서버가 뒤늦게 commit할 수
# 있으므로 이만큼씩 쉬며 이 신분이 든 방을 다시 찾는다(모두 15초).
CREATE_LOOKUP_WAITS = (2, 3, 5, 5)
_IDENTITY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_ROOM_CODE = re.compile(r"[A-Z0-9]{6}")
_TICKET = re.compile(r"[A-Za-z0-9_-]{32,256}")
_ERROR_CODE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
_FIELD_NAME = re.compile(r"[A-Za-z0-9_]{1,40}")
_STATUS_CODE = re.compile(r"[0-9]{3}")
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_MISSING = object()


class Failure(Exception):
    """한 단계의 확인이 서지 않았다. 메시지는 그대로 출력되므로 비밀을 싣지 않는다."""


class Terminated(KeyboardInterrupt):
    """SIGTERM·SIGHUP. KeyboardInterrupt를 이어 Ctrl-C와 같은 길(FAIL 한 줄, 방 나가기)을 탄다."""

    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


def _terminate(signum: int, frame: object) -> None:
    raise Terminated(signum)


def trap_termination() -> dict[int, object]:
    """SIGTERM과 (있는 곳에서만) SIGHUP을 Terminated로 바꾸고 이전 처리기를 돌려준다.

    운영 에이전트는 오래 걸린 실행을 대개 SIGTERM으로 멈춘다(도구 시간 초과, ``timeout N``, 끊긴
    ``ssh -t``). 기본 동작대로 죽으면 만든 공개방이 30분 정리 전까지 운영 로비에 남는다.
    """
    previous: dict[int, object] = {}
    for name in ("SIGTERM", "SIGHUP"):
        signum = getattr(signal, name, None)
        if signum is not None:
            previous[signum] = signal.signal(signum, _terminate)
    return previous


def restore_signals(previous: dict[int, object]) -> None:
    for signum, handler in previous.items():
        # Python 밖에서 걸린 처리기는 None으로 돌아온다. 그때는 기본 동작으로 되돌린다.
        signal.signal(signum, signal.SIG_DFL if handler is None else handler)


def interruption_name(error: KeyboardInterrupt) -> str:
    if isinstance(error, Terminated):
        try:
            return signal.Signals(error.signum).name
        except ValueError:
            return f"signal {error.signum}"
    return "Ctrl-C"


def interruption_status(error: KeyboardInterrupt) -> int:
    # 셸의 관례대로 128 + 신호 번호다. Ctrl-C(SIGINT)는 130.
    return 128 + error.signum if isinstance(error, Terminated) else 130


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


def check_target(api: ApiUrl, resolve_to: str | None) -> None:
    # http://의 루프백 규칙은 URL 호스트만 본다. --resolve-to가 그 평문 연결을 다른 주소로
    # 돌리면 bearer 토큰·X-Player-Id·소켓 티켓이 암호화 없이 밖으로 나간다.
    if resolve_to is not None and not api.tls and not ipaddress.ip_address(resolve_to).is_loopback:
        raise ValueError("--resolve-to must be a loopback address for an http:// API")


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
        """API의 ``detail.code``(server/app/main.py의 ``_error``). 코드처럼 생겼을 때만 준다."""
        try:
            value = json.loads(self.body.decode("utf-8"))
        except ValueError:
            return None
        detail = value.get("detail") if isinstance(value, dict) else None
        code = detail.get("code") if isinstance(detail, dict) else None
        return code if isinstance(code, str) and _ERROR_CODE.fullmatch(code) else None


@dataclass(frozen=True)
class Frame:
    opcode: int
    payload: bytes = b""


def close_code(frame: Frame) -> int:
    # 상태 코드가 없는 close는 1005로 읽는다(RFC 6455 7.1.5).
    return int.from_bytes(frame.payload[:2], "big") if len(frame.payload) >= 2 else 1005


@dataclass
class Upgrade:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    channel: WebSocketChannel | None = None


def _header_map(pairs: list[tuple[str, str]]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name, value in pairs:
        key = name.strip().lower()
        headers[key] = f"{headers[key]}, {value.strip()}" if key in headers else value.strip()
    return headers


class _PinnedConnection(http.client.HTTPConnection):
    """transport의 소켓 위에서 도는 http.client. REST에도 ``--resolve-to``와 TLS가 그대로 선다."""

    def __init__(self, transport: HttpTransport) -> None:
        super().__init__(transport.api.host, transport.api.port, timeout=transport.timeout)
        self._transport = transport

    def connect(self) -> None:
        self.sock = self._transport.open_socket()


class HttpTransport:
    """API와 맨 소켓으로 이야기한다.

    ``resolve_to``가 있으면 TCP 상대만 그 IP이고 Host 헤더·TLS SNI·인증서 검증은 URL 호스트로 한다.
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

    def upgrade(self, path: str, headers: dict[str, str]) -> Upgrade:
        """HTTP/1.1 WebSocket upgrade 하나. 101이면 열린 channel을 넘기고 닫기는 부른 쪽이 한다."""
        sock = self.open_socket()
        try:
            lines = [f"GET {self.api.path}{path} HTTP/1.1", f"Host: {self.api.host_header}"]
            lines.extend(f"{name}: {value}" for name, value in headers.items())
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
            head, rest = _read_head(sock)
            status, response_headers = _parse_head(head)
        except BaseException:
            sock.close()
            raise
        if status != 101:
            sock.close()
            return Upgrade(status, response_headers)
        # 101 뒤에 같이 읽힌 바이트는 서버의 첫 frame이다. 버리지 않고 channel에 넘긴다.
        return Upgrade(status, response_headers, WebSocketChannel(sock, rest, timeout=self.timeout))


class WebSocketChannel:
    """101 뒤의 소켓. 보내는 frame은 가리고(mask) 서버 frame은 맨 채로 읽는다(RFC 6455 5.1)."""

    def __init__(
        self,
        sock: socket.socket,
        buffered: bytes = b"",
        *,
        timeout: float = TIMEOUT_SECONDS,
        clock=time.monotonic,
    ) -> None:
        self._sock = sock
        self._buffer = buffered
        self._timeout = timeout
        self._clock = clock
        self._close_sent = False

    def _send(self, frame: bytes) -> None:
        self._sock.settimeout(self._timeout)
        self._sock.sendall(frame)

    def send_text(self, text: str) -> None:
        self._send(_client_frame(OPCODE_TEXT, text.encode("utf-8")))

    def send_close(self, code: int = CLOSE_NORMAL) -> None:
        self._close_sent = True
        self._send(_client_frame(OPCODE_CLOSE, code.to_bytes(2, "big")))

    def _read_exact(self, size: int, deadline: float) -> bytes | None:
        while len(self._buffer) < size:
            remaining = deadline - self._clock()
            if remaining <= 0:
                # Python 3.8의 socket.timeout은 아직 TimeoutError가 아니다. recv가 내는 것과 맞춘다.
                raise socket.timeout("timed out")  # noqa: UP041
            self._sock.settimeout(remaining)
            chunk = self._sock.recv(max(4096, size - len(self._buffer)))
            if not chunk:
                return None
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def read_frame(self, deadline: float) -> Frame | None:
        """서버 frame 하나를 deadline까지 기다린다. 연결이 frame 없이 끊기면 None이다."""
        head = self._read_exact(2, deadline)
        if head is None:
            return None
        if head[1] & 0x80:
            raise Failure("server frame is masked")
        length = head[1] & 0x7F
        if length >= 126:
            extended = self._read_exact(2 if length == 126 else 8, deadline)
            if extended is None:
                return None
            length = int.from_bytes(extended, "big")
        if length > MAX_FRAME_BYTES:
            raise Failure("server frame is too large")
        payload = self._read_exact(length, deadline) if length else b""
        if payload is None:
            return None
        return Frame(head[0] & 0x0F, payload)

    def close(self) -> None:
        # 아직 close frame을 보내지 않았으면 먼저 보내 서버가 끊김을 바로 안다.
        try:
            if not self._close_sent:
                self.send_close()
        except OSError:
            pass
        finally:
            self._sock.close()


def _read_head(sock: socket.socket) -> tuple[bytes, bytes]:
    data = b""
    while b"\r\n\r\n" not in data:
        if len(data) > MAX_HEAD_BYTES:
            raise Failure("upgrade response head is too large")
        chunk = sock.recv(4096)
        if not chunk:
            raise Failure("connection closed before the upgrade response")
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    return head, rest


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


def _client_frame(opcode: int, payload: bytes) -> bytes:
    """가린(masked) 클라이언트 frame 하나(RFC 6455 5.2). 보내는 것은 모두 125바이트 안이다."""
    if len(payload) > 125:
        raise ValueError("client frame payload is too long")
    mask = os.urandom(4)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return bytes((0x80 | opcode, 0x80 | len(payload))) + mask + masked


def websocket_accept(key: str) -> str:
    digest = hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()  # noqa: S324 - RFC 6455
    return base64.b64encode(digest).decode("ascii")


def _show(value: object) -> str:
    """확인한 값을 한 줄에 들 만큼만 보인다. 자유 형식의 본문은 보이지 않는다."""
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
    """단계마다 한 줄. 이 실행이 다룬 비밀은 모두 출력에서 지운다."""

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
    """한 API를 새 브라우저 신분 하나로 한 번 훑는 단계들."""

    def __init__(self, mode: str, transport, report: Report, *, sleep=time.sleep) -> None:
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}")
        self.mode = mode
        self.candidate = mode == CANDIDATE
        self.transport = transport
        self.report = report
        self.sleep = sleep
        # 브라우저처럼 UUID 하나와 43자 비밀을 만든다 (src/online/network-rooms.ts의 randomIdentity)
        self.player_id = str(uuid.uuid4())
        self.token = "".join(secrets.choice(_IDENTITY_ALPHABET) for _ in range(43))
        report.keep_secret(self.token)
        self.session_ready = False
        self.room_requested = False
        # 만들기 요청이 HTTP 답을 받았는가. 받지 못했으면 방이 생겼는지 모른다(cleanup이 찾아본다).
        self.room_answered = False
        self.room_code: str | None = None
        # 혼자 판을 열려고 했는가, 연 혼자 방과 그것을 끝냈는가. 끝내지 못했으면 cleanup이 끝낸다
        self.solo_requested = False
        # 혼자 판 열기가 HTTP 답을 받았는가. 받지 못했으면 혼자 방이 생겼는지 모른다(cleanup이 끝내 본다)
        self.solo_answered = False
        self.solo_code: str | None = None
        self.solo_ended = False
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
        interrupted: KeyboardInterrupt | None = None
        try:
            # release gate가 틀려도 나머지를 본다 — 무엇이 더 깨졌는지 한 번에 보이게 한다.
            # migration 013 직후의 012 API(gate 503)는 baseline-migrated로 보면 gate도 ok다.
            self._step("readiness", self.readiness)
            self._step("session", self.session)
            # 닉네임 금칙 규칙과 공개 랭킹 읽기는 migration 012 API부터의 것이라 이 경계의 세 모드가
            # 모두 본다. 판을 열지 않으므로 랭킹을 쓰지 않고, 거절된 닉네임은 프로필을 바꾸지 않는다
            needs_session = [
                ("nickname", self.nickname),
                ("rankings", self.rankings),
                ("room", self.create_room),
            ]
            for name, action in needs_session:
                if not self.session_ready:
                    self.report.fail(name, "not run (no session)")
                else:
                    self._step(name, action)
            later = [("room-settings", self.room_settings), ("websocket", self.websocket)]
            for name, action in later:
                if self.room_code is None:
                    self.report.fail(name, "not run (no room)")
                else:
                    self._step(name, action)
            # 혼자 온라인 판은 migration 013 API(이 후보)의 것이다 — 012 API(baseline)에는 없다
            if self.candidate:
                if not self.session_ready:
                    self.report.fail("solo", "not run (no session)")
                else:
                    self._step("solo", self.solo)
        except KeyboardInterrupt as error:
            interrupted = error
            self.report.fail(self.current or "run", f"interrupted ({interruption_name(error)})")
        finally:
            late = self._cleanup()
        interrupted = interrupted or late
        if interrupted is not None:
            return interruption_status(interrupted)
        return 1 if self.report.failed else 0

    def _step(self, name: str, action) -> bool:
        # Ctrl-C·SIGTERM은 여기서 잡지 않는다. run()이 이 이름으로 한 줄을 남기고 cleanup으로 간다.
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

    def _cleanup(self) -> KeyboardInterrupt | None:
        try:
            self._step("cleanup", self.cleanup)
        except KeyboardInterrupt as error:
            left = (
                f"room {self.room_code} stays until the server's idle cleanup"
                if self.room_code
                else "nothing was confirmed"
            )
            self.report.fail("cleanup", f"interrupted ({interruption_name(error)}); {left}")
            return error
        return None

    def _readiness_reply(self) -> Reply:
        reply = self.call("GET", "/v1/release-readiness", auth=False)
        for retry in range(1, READINESS_RETRIES + 1):
            if reply.status != 429:
                break
            wait = retry_after_seconds(reply)
            self.report.note(f"readiness: HTTP 429, retry {retry}/{READINESS_RETRIES} in {wait}s")
            self.sleep(wait)
            reply = self.call("GET", "/v1/release-readiness", auth=False)
        return reply

    def readiness(self) -> str:
        reply = self._readiness_reply()
        migration_required = reply.status == 503 and reply.error_code() == MIGRATION_REQUIRED_CODE
        if self.mode == MIGRATED_BASELINE:
            # 단계 3의 정상 상태다. 다른 답(200, database-unavailable 같은 503)은 모두 FAIL이다.
            if not migration_required:
                raise Failure(f"{status_text(reply)}, expected HTTP 503 {MIGRATION_REQUIRED_CODE}")
            problems = cors_problems(reply)
            if problems:
                raise Failure("; ".join(problems))
            return f"HTTP 503 {MIGRATION_REQUIRED_CODE} (closed as expected after migration 013)"
        if migration_required and self.mode == BASELINE:
            raise Failure(
                f"{status_text(reply)}, expected 200 "
                f"(after migration 013 run {MIGRATED_BASELINE} instead)"
            )
        expect_status(reply, 200)
        version = SCHEMA_VERSIONS[self.mode]
        want = {"status": "ready", "contract": RELEASE_CONTRACT, "schemaVersion": version}
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
        session = reply.json_object()
        if session.get("playerId") != self.player_id:
            raise Failure("playerId is not this identity")
        self.session_ready = True
        problems = cors_problems(reply)
        # migration 012 API부터 끝난 판을 서버 랭킹에 남긴다고(rankings) 알리고, 013 API는 홈의 혼자
        # 온라인 판도 연다고(soloPlay, FR-7.13 3단계), 그 판이 «제한 없음»(soloUntimed)과 다른 판을 골라
        # 끝내고 새로 열기(soloRestart, PRD 10.1 #9·#11)를 안다고 알린다. 012 API(#108)에는 셋 다 없다
        solo: object = True if self.candidate else _MISSING
        problems += field_problems(
            session,
            {"rankings": True, "soloPlay": solo, "soloUntimed": solo, "soloRestart": solo},
        )
        if problems:
            raise Failure("; ".join(problems))
        if self.candidate:
            return (
                "HTTP 200 playerId is this identity, rankings true, "
                "soloPlay soloUntimed soloRestart true"
            )
        return "HTTP 200 playerId is this identity, rankings true, no soloPlay"

    def nickname(self) -> str:
        reply = self.call(
            "PUT",
            "/v1/session",
            {"nickname": REJECTED_NICKNAME, "characterId": CHARACTER_ID},
        )
        if reply.status != 400 or reply.error_code() != REJECTED_NICKNAME_CODE:
            raise Failure(f"{status_text(reply)}, expected HTTP 400 {REJECTED_NICKNAME_CODE}")
        problems = cors_problems(reply)
        if problems:
            raise Failure("; ".join(problems))
        return f"HTTP 400 {REJECTED_NICKNAME_CODE} for an e-mail-shaped nickname"

    def _ranking_problems(self, value: object, *, period: str) -> list[str]:
        problems = field_problems(value, {"period": period, "limit": RANKING_LIMIT})
        if not isinstance(value, dict):
            return problems
        missing = sorted(RANKING_FIELDS - set(value))
        extra = sorted(str(key) for key in value if key not in RANKING_FIELDS)
        if missing:
            problems.append(f"missing field(s) {', '.join(missing)}")
        if extra:
            problems.append(f"unexpected field(s) {', '.join(extra)}")
        window = value.get("window")
        if period == "week":
            if not isinstance(window, dict) or set(window) != {"start", "end", "timeZone"}:
                problems.append("window is not {start, end, timeZone}")
            elif window.get("timeZone") != RANKING_TIME_ZONE:
                problems.append(f"window.timeZone={_show(window.get('timeZone'))}")
        elif window is not None:
            problems.append("window is not null for period all")
        entries = value.get("entries")
        if not isinstance(entries, list) or len(entries) > RANKING_LIMIT:
            problems.append(f"entries is not a list of at most {RANKING_LIMIT}")
            return problems
        for index, item in enumerate(entries, start=1):
            if not isinstance(item, dict) or set(item) != RANKING_ENTRY_FIELDS:
                problems.append(f"entry {index} does not carry exactly the public fields")
                break
            if item.get("rank") != index or not isinstance(item.get("isMine"), bool):
                problems.append(f"entry {index} rank or isMine is malformed")
                break
        return problems

    def rankings(self) -> str:
        # 신분 없이: 공개 읽기다. 아무것도 내 기록이 아니다
        path = "/v1/rankings?mode=all&period=week"
        reply = self.call("GET", path, auth=False)
        expect_status(reply, 200, what="anonymous week")
        board = reply.json()
        problems = self._ranking_problems(board, period="week") + cors_problems(reply)
        problems += field_problems(board, {"mode": "all", "categoryId": None})
        entries = board.get("entries") if isinstance(board, dict) else None
        if isinstance(entries, list) and any(
            isinstance(item, dict) and item.get("isMine") is True for item in entries
        ):
            problems.append("an anonymous read marked an entry as mine")
        if problems:
            raise Failure("anonymous week: " + "; ".join(problems))
        count = len(entries) if isinstance(entries, list) else 0

        # 이 신분으로: 같은 인증을 지난다. 새 신분이라 내 기록은 없다
        reply = self.call("GET", "/v1/rankings?mode=category&category=history&period=all")
        expect_status(reply, 200, what="history all-time")
        problems = self._ranking_problems(reply.json(), period="all")
        problems += field_problems(reply.json(), {"mode": "category", "categoryId": "history"})
        if problems:
            raise Failure("history all-time: " + "; ".join(problems))

        reply = self.call("GET", "/v1/rankings?mode=season&period=week", auth=False)
        if reply.status != 400 or reply.error_code() != REJECTED_RANKING_CODE:
            raise Failure(
                f"unknown board: {status_text(reply)}, expected HTTP 400 {REJECTED_RANKING_CODE}"
            )
        return (
            f"anonymous week HTTP 200 ({count} entries, window {RANKING_TIME_ZONE}); "
            f"history all-time HTTP 200; unknown board -> 400 {REJECTED_RANKING_CODE}"
        )

    def _only_me(self, players: object) -> dict[str, object] | None:
        if not isinstance(players, list) or len(players) != 1:
            return None
        player = players[0]
        if not isinstance(player, dict) or player.get("id") != self.player_id:
            return None
        return player

    def create_room(self) -> str:
        self.room_requested = True
        # questionTimeMs를 보내지 않는다 — 구버전 화면처럼 보내지 않은 방은 012·013 API 모두 20초다.
        reply = self.call(
            "POST",
            "/v1/rooms",
            {"name": ROOM_NAME, "categoryId": None, "capacity": 2, "isPublic": True},
        )
        self.room_answered = True
        expect_status(reply, 201)
        room = reply.json_object()
        code = room.get("code")
        if not isinstance(code, str) or not _ROOM_CODE.fullmatch(code):
            raise Failure("room code is missing or malformed")
        self.room_code = code
        # 011 API부터의 방 모양이다. 이 경계(013)의 baseline(012 API)도 갖고 있어 모든 모드가 본다
        want: dict[str, object] = {
            "capacity": 2,
            "isPublic": True,
            "questionTimeMs": DEFAULT_QUESTION_TIME_MS,
            "status": "waiting",
            "inMatch": False,
        }
        problems = field_problems(room, want)
        me = self._only_me(room.get("players"))
        if me is None:
            problems.append("players is not exactly this identity")
        elif me.get("connected") is not True:
            problems.append(f"connected={_show(me.get('connected', _MISSING))} (want true)")
        if problems:
            raise Failure(f"room {code}: " + "; ".join(problems))
        return (
            f"HTTP 201 room {code} questionTimeMs {DEFAULT_QUESTION_TIME_MS}, waiting, "
            "inMatch false, only me, connected true"
        )

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
        if answer.status != 101 or answer.channel is None:
            raise Failure(f"upgrade HTTP {answer.status}{retried}, expected 101")
        channel = answer.channel
        try:
            problems = []
            if answer.headers.get("sec-websocket-protocol") != WEBSOCKET_PROTOCOL:
                problems.append(f"selected protocol is not {WEBSOCKET_PROTOCOL}")
            if answer.headers.get("sec-websocket-accept") != websocket_accept(key):
                problems.append("Sec-WebSocket-Accept does not match the key")
            if answer.headers.get("upgrade", "").lower() != "websocket":
                problems.append("Upgrade header is not websocket")
            if problems:
                raise Failure("upgrade HTTP 101 but " + "; ".join(problems))
            # 101만으로는 모자란다. 서버는 accept한 뒤에야 hub에 붙이고(못 붙이면 1012로 닫는다)
            # 접속 시각을 DB에 적으며(실패하면 frame 없이 끊긴다), 그다음에야 받는 loop가 돌아
            # 움직임을 방 전체에 — 보낸 사람에게도 — 되돌린다. 내 움직임이 돌아오면 셋이 모두 섰다.
            channel.send_text(json.dumps(PROBE_MOVEMENT, separators=(",", ":")))
            self._await_frame(channel, "movement echo", self._is_my_movement)
            channel.send_close(CLOSE_NORMAL)
            closing = self._await_frame(channel, "close reply", _is_close)
            if close_code(closing) != CLOSE_NORMAL:
                raise Failure(f"close reply {close_code(closing)}, expected {CLOSE_NORMAL}")
        finally:
            channel.close()
        return (
            f"HTTP 101 protocol {WEBSOCKET_PROTOCOL}{retried}, movement echoed, "
            f"closed {CLOSE_NORMAL}"
        )

    def solo(self) -> str:
        """«제한 없음» 혼자 판 하나를 열고(마감이 없다) 기록 없이 끝낸다 (PRD 10.1 #9·#11)."""
        self.solo_requested = True
        reply = self.call("POST", "/v1/solo", SOLO_START)
        self.solo_answered = True
        expect_status(reply, 201, what="POST /v1/solo")
        started = reply.json_object()
        room = started.get("room")
        match = started.get("match")
        code = room.get("code") if isinstance(room, dict) else None
        if not isinstance(code, str) or not _ROOM_CODE.fullmatch(code):
            raise Failure("POST /v1/solo: room code is missing or malformed")
        self.solo_code = code
        problems = field_problems(started, {"resumed": False})
        problems += [
            f"room {problem}"
            for problem in field_problems(
                room, {"solo": True, "untimed": True, "questionTimeMs": None}
            )
        ]
        problems += [
            f"match {problem}"
            for problem in field_problems(match, {"untimed": True, "questionTimeMs": None})
        ]
        if self._only_me(room.get("players") if isinstance(room, dict) else None) is None:
            problems.append("room players is not exactly this identity")
        if problems:
            raise Failure("POST /v1/solo: " + "; ".join(problems))

        reply = self.call("GET", f"/v1/rooms/{code}/match")
        expect_status(reply, 200, what="GET match")
        # 마감 없는 도는 문항이다 — 마감·남은 시간이 없고 서 있는 칸은 답이 되지 않는다
        problems = field_problems(
            reply.json_object(),
            {
                "state": "running",
                "untimed": True,
                "questionTimeMs": None,
                "deadlineAt": None,
                "remainingMs": None,
                "standingAnswers": False,
            },
        )
        if problems:
            raise Failure("GET match: " + "; ".join(problems))

        ended = self._end_solo()
        return (
            f"HTTP 201 untimed solo room {code}; GET match running with no deadline; "
            f"{ended}"
        )

    def _end_solo(self) -> str:
        """DELETE /v1/solo — 도는 판을 기록 없이 끝내고 혼자 방을 지운다. 그 방은 다시 읽히지 않는다."""
        reply = self.call("DELETE", "/v1/solo")
        if self.solo_code is None:
            # 열기의 답을 받지 못했다 — 혼자 방이 있으면 끝내고, 없으면(404는 그 길이 없는 API) 할 일이 없다
            expect_status(reply, 200, 404, what="DELETE /v1/solo")
            self.solo_ended = True
            return f"DELETE /v1/solo -> {reply.status}"
        expect_status(reply, 200, what="DELETE /v1/solo")
        body_value = reply.json_object()
        problems = field_problems(body_value, {"left": True})
        problems += [
            f"ended {problem}"
            for problem in field_problems(body_value.get("ended"), {"recorded": False})
        ]
        if problems:
            raise Failure("DELETE /v1/solo: " + "; ".join(problems))
        reply = self.call("GET", f"/v1/rooms/{self.solo_code}")
        if reply.status != 404:
            raise Failure(
                f"solo room {self.solo_code} is still readable after ending "
                f"({status_text(reply)})"
            )
        self.solo_ended = True
        return f"DELETE /v1/solo -> 200 ended unrecorded, GET {self.solo_code} -> 404"

    def _is_my_movement(self, frame: Frame) -> bool:
        if frame.opcode != OPCODE_TEXT:
            return False
        try:
            value = json.loads(frame.payload.decode("utf-8"))
        except ValueError:
            return False
        return (
            isinstance(value, dict)
            and value.get("type") == "movement"
            and value.get("playerId") == self.player_id
        )

    def _await_frame(self, channel, what: str, wanted) -> Frame:
        # 그사이 온 다른 frame(방 무효화 알림, ping)은 건너뛴다. 내용은 출력하지 않는다.
        deadline = time.monotonic() + WEBSOCKET_REPLY_SECONDS
        while True:
            try:
                frame = channel.read_frame(deadline)
            except (socket.timeout, TimeoutError):  # noqa: UP041 - Python 3.8에서는 둘이 다르다
                raise Failure(f"no {what} within {WEBSOCKET_REPLY_SECONDS:g}s") from None
            if frame is None:
                raise Failure(f"connection dropped without a close frame before the {what}")
            if wanted(frame):
                return frame
            if frame.opcode == OPCODE_CLOSE:
                raise Failure(f"server closed with {close_code(frame)} before the {what}")

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

    def _created_room_codes(self) -> list[str]:
        # 이 신분이 든 방은 모두 이 실행이 만든 것이다. 만들기가 HTTP 답을 받았으면 방은 이미
        # 있거나 없으므로 한 번 보면 되고, 받지 못했으면 늦은 commit을 몇 번 더 기다린다.
        codes = self._joined_room_codes()
        if self.room_answered:
            return codes
        for wait in CREATE_LOOKUP_WAITS:
            if codes:
                break
            self.report.note(f"cleanup: create outcome unknown, looking again in {wait}s")
            self.sleep(wait)
            codes = self._joined_room_codes()
        return codes

    def cleanup(self) -> str:
        if not self.session_ready:
            return "nothing to leave (no session)"
        # 열려고 한 혼자 판을 끝내지 못했으면(실패·중단) 여기서 끝낸다. 혼자 방이 없으면 아무 일도 없다
        solo = ""
        unknown = not self.solo_answered
        if self.solo_requested and not self.solo_ended and (self.solo_code or unknown):
            solo = "; " + self._end_solo()
        codes = [self.room_code] if self.room_code else []
        if not codes and self.room_requested:
            codes = self._created_room_codes()
            if not codes and not self.room_answered:
                raise Failure("create outcome unknown; no joined room seen")
        if not codes:
            return "nothing to leave (no room)" + solo
        for code in codes:
            path = f"/v1/rooms/{code}"
            reply = self.call("DELETE", f"{path}/members/me")
            expect_status(reply, 204, 404, what=f"leave room {code}")
            reply = self.call("GET", path)
            if reply.status != 404:
                raise Failure(f"room {code} is still readable after leaving ({status_text(reply)})")
        return f"left room {', '.join(codes)}, GET -> 404" + solo


def _is_close(frame: Frame) -> bool:
    return frame.opcode == OPCODE_CLOSE


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="smoke.py",
        description="Smoke-test the public quiz-by-quiz online API as the Pages client uses it.",
    )
    parser.add_argument(
        "mode",
        choices=MODES,
        help=(
            "baseline: the serving migration-012 API; "
            "baseline-migrated: that API after migration 013 ran (gate 503 migration-required); "
            "candidate: the migration-013 API"
        ),
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
        check_target(api, resolve_to)
    except ValueError as error:
        parser.error(str(error))
    smoke = Smoke(args.mode, HttpTransport(api, resolve_to=resolve_to), Report())
    previous = trap_termination()
    try:
        return smoke.run()
    except KeyboardInterrupt as error:  # run()이 정리를 마친 뒤에 온 신호다. 남은 일이 없다.
        return interruption_status(error)
    finally:
        restore_signals(previous)


if __name__ == "__main__":
    sys.exit(main())
