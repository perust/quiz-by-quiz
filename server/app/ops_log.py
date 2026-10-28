"""운영 기록 (`quiz.ops`) — 운영자가 `docker logs`로 읽는 한 줄 JSON.

API는 uvicorn을 `--log-level warning`·`--no-access-log`로 돌린다(server/Dockerfile). 그래서
방이 열리고 판이 도는지, 요청이 얼마나 거절되거나 실패하는지를 운영 기록에서 볼 길이 없었다.
이 모듈의 logger는 uvicorn의 수준과 무관하게 제 stderr handler로 INFO를 낸다 — 한 줄에 JSON
하나(`{"event": ..., "ts": ..., ...}`). 다른 logger로 퍼뜨리지 않아(`propagate = False`) 두 번
찍히지 않는다.

**개인 정보를 싣지 않는다.** 닉네임·채팅·토큰·소켓 티켓·IP·X-Forwarded-For·player id·비밀번호·
문항 내용은 어느 사건에도 자리가 없다. 사건마다 함수가 받는 인자가 곧 싣는 칸이고(`EVENT_FIELDS`)
아무 dict나 넘기는 길은 두지 않는다. 방 코드와 수는 싣는다 — 코드는 로비에도 보이는 여섯 글자이고
방이 사라지면 다시 쓰일 수 있다. 5xx는 경로가 아니라 **경로 틀**(`/v1/rooms/{raw_code}`)과 예외
클래스 이름만 싣는다. 예외 메시지는 SQL 값이나 요청 내용을 담을 수 있다.

**양도 묶는다** (deploy/oracle/README.md의 resource envelope). 사건은 방·참가·판 단위라 요청마다
나지 않고, 5분 요약(`summary`)은 고정 크기 칸(`RequestWindow`)만 센다 — 요청을 하나도 붙들지 않는다.
"""

from __future__ import annotations

import bisect
import json
import logging
import math
import re
import sys
import time
from collections.abc import Awaitable, Callable, MutableMapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .domain import ALLOWED_CATEGORIES
from .repository import CleanupCounts, RoomCounts

OPS_LOGGER_NAME = "quiz.ops"
# 5분 요약 한 줄의 주기. 하루 288줄이라 json-file 30MB(10m × 3)에 견주면 무시할 만하다.
SUMMARY_INTERVAL_SECONDS = 300.0
# REST 지연 분포의 칸 상한(ms). 백분위는 그 값이 든 칸의 상한으로 읽는다 — 분포를 고정 크기
# 칸으로만 세어 요청 수와 무관하게 메모리가 같다. 마지막 칸 위는 넘친 칸이고 그때는 관측한
# 최댓값이다.
LATENCY_BUCKETS_MS: tuple[int, ...] = (
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000,
)
# Docker·Caddy가 사설망에서 두드리는 헬스 체크는 요약에 세지 않는다. 30초마다 와서 지연
# 분포를 흐린다.
UNCOUNTED_PATHS = frozenset({"/healthz", "/readyz"})
_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
_ROOM_CODE = re.compile(r"[A-Z0-9]{6}")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,79}")
_ROUTE_TEMPLATE = re.compile(r"/[A-Za-z0-9_/{}.-]{0,120}")
_REASON = re.compile(r"[a-z][a-z-]{0,31}")
_STATUS_CLASSES = ("2xx", "3xx", "4xx", "5xx")

# 사건마다 싣는 칸. 여기 없는 칸은 어디서도 내지 않는다(tests/test_ops_log.py가 견준다).
EVENT_FIELDS: dict[str, frozenset[str]] = {
    "api_started": frozenset({"schemaVersion"}),
    "api_stopped": frozenset(),
    "room_created": frozenset({"room", "capacity", "category", "questionTimeMs", "locked"}),
    "room_deleted": frozenset({"room", "reason"}),
    "member_joined": frozenset({"room", "players"}),
    "member_left": frozenset({"room", "players"}),
    "member_removed": frozenset({"room", "players", "blocked"}),
    "host_transferred": frozenset({"room", "reason"}),
    "match_started": frozenset({"room", "players", "category", "questionTimeMs", "questions"}),
    "match_finished": frozenset({"room", "via"}),
    # 혼자 푸는 온라인 판을 열었다 (FR-7.13 3단계). 그 방을 이번에 만들었는가와 판의 모양뿐이다 —
    # 혼자 판은 room_created·match_started 대신 이 한 줄이다(판이 끝나면 match_finished는 같다)
    "solo_started": frozenset({"room", "created", "category", "questionTimeMs", "questions"}),
    # 혼자 판을 끝까지 풀지 않고 끝냈다 (PRD 10.1 #11) — 다른 판을 골랐거나(`via: restart`) 그만뒀다
    # (`left`, DELETE /v1/solo). 기록은 남지 않는다. 끝낼 때 열려 있던 문항 순서와 판의 문항
    # 수뿐이다. 마지막 공개만 남은 판은 닫혀 기록되므로 이 줄 대신 match_finished(같은 via)다
    "solo_abandoned": frozenset({"room", "via", "position", "questions"}),
    "cleanup": frozenset(
        {
            "roomsDeleted",
            "membersRemoved",
            "hostsTransferred",
            "matchesDeleted",
            "playersDeleted",
            "rankingsPruned",
            "soloMatchesAbandoned",
        }
    ),
    "server_error": frozenset({"method", "route", "error"}),
    "summary": frozenset(
        {
            "windowSeconds",
            "sockets",
            "players",
            "rooms",
            "matches",
            "requests",
            "rateLimited",
            "unhandled",
            "latencyMs",
        }
    ),
}

logger = logging.getLogger(OPS_LOGGER_NAME)


def _timestamp(created: float) -> str:
    return (
        datetime.fromtimestamp(created, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class JsonLineFormatter(logging.Formatter):
    """`{"event": ..., "ts": ..., ...칸}` 한 줄. 사건 이름은 record의 message다."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "event": record.getMessage(),
            "ts": _timestamp(record.created),
        }
        fields = getattr(record, "ops_fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class _StderrJsonHandler(logging.StreamHandler):
    """쓰는 순간의 `sys.stderr`로 낸다(logging의 lastResort와 같다).

    만들 때의 stream을 쥐면 테스트가 stderr를 바꿔 끼운 뒤 닫힌 파일에 쓴다.
    """

    def __init__(self) -> None:
        logging.Handler.__init__(self, logging.INFO)
        self.setFormatter(JsonLineFormatter())

    @property
    def stream(self) -> Any:
        return sys.stderr

    @stream.setter
    def stream(self, value: Any) -> None:
        # StreamHandler.setStream이 바꾸려 해도 늘 지금의 stderr를 쓴다
        return None


def install() -> logging.Logger:
    """운영 logger에 stderr JSON handler를 한 번만 단다. 여러 번 불러도 같다.

    uvicorn은 app factory를 부르기 전에 logging을 설정한다(`disable_existing_loggers: False`).
    그래서 `create_app`에서 달아도 `--log-level warning`과 무관하게 INFO가 나간다.
    """
    if not any(isinstance(handler, _StderrJsonHandler) for handler in logger.handlers):
        logger.addHandler(_StderrJsonHandler())
    logger.setLevel(logging.INFO)
    logger.propagate = False
    logger.disabled = False
    return logger


def _emit(event: str, fields: dict[str, object]) -> None:
    logger.info(event, extra={"ops_fields": fields})


def _room(code: str) -> str:
    # 정규화한 코드만 온다. 그래도 여섯 글자 대문자·숫자가 아니면 싣지 않는다.
    return code if _ROOM_CODE.fullmatch(code) else "<invalid>"


def _category(category_id: str | None) -> str:
    if category_id is None:
        return "all"
    return category_id if category_id in ALLOWED_CATEGORIES else "<invalid>"


def _count(value: int | None) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    return max(0, int(value))


# ── 사건 ──────────────────────────────────────────────────────────────────────


def api_started(*, schema_version: int) -> None:
    _emit("api_started", {"schemaVersion": int(schema_version)})


def api_stopped() -> None:
    _emit("api_stopped", {})


def room_created(
    code: str,
    *,
    capacity: int,
    category_id: str | None,
    question_time_ms: int,
    locked: bool,
) -> None:
    _emit(
        "room_created",
        {
            "room": _room(code),
            "capacity": _count(capacity),
            "category": _category(category_id),
            "questionTimeMs": _count(question_time_ms),
            "locked": bool(locked),
        },
    )


def room_deleted(code: str, *, reason: str) -> None:
    _emit("room_deleted", {"room": _room(code), "reason": _reason(reason)})


def member_joined(code: str, *, players: int) -> None:
    _emit("member_joined", {"room": _room(code), "players": _count(players)})


def member_left(code: str, *, players: int) -> None:
    _emit("member_left", {"room": _room(code), "players": _count(players)})


def member_removed(code: str, *, players: int, blocked: bool) -> None:
    _emit(
        "member_removed",
        {"room": _room(code), "players": _count(players), "blocked": bool(blocked)},
    )


def host_transferred(code: str, *, reason: str) -> None:
    _emit("host_transferred", {"room": _room(code), "reason": _reason(reason)})


def match_started(
    code: str,
    *,
    players: int | None,
    category_id: str | None,
    question_time_ms: int,
    questions: int,
) -> None:
    _emit(
        "match_started",
        {
            "room": _room(code),
            "players": _count(players),
            "category": _category(category_id),
            "questionTimeMs": _count(question_time_ms),
            "questions": _count(questions),
        },
    )


def solo_started(
    code: str,
    *,
    created: bool,
    category_id: str | None,
    question_time_ms: int | None,
    questions: int,
) -> None:
    # «제한 없음» 혼자 판이면 questionTimeMs가 null이다 (PRD 10.1 #9)
    _emit(
        "solo_started",
        {
            "room": _room(code),
            "created": bool(created),
            "category": _category(category_id),
            "questionTimeMs": _count(question_time_ms),
            "questions": _count(questions),
        },
    )


def solo_abandoned(code: str, *, via: str, position: int, questions: int) -> None:
    _emit(
        "solo_abandoned",
        {
            "room": _room(code),
            "via": _reason(via),
            "position": _count(position),
            "questions": _count(questions),
        },
    )


def match_finished(code: str, *, via: str) -> None:
    _emit("match_finished", {"room": _room(code), "via": _reason(via)})


def cleanup(counts: CleanupCounts) -> None:
    _emit(
        "cleanup",
        {
            "roomsDeleted": _count(counts.rooms_deleted),
            "membersRemoved": _count(counts.members_removed),
            "hostsTransferred": _count(counts.hosts_transferred),
            "matchesDeleted": _count(counts.matches_deleted),
            "playersDeleted": _count(counts.players_deleted),
            "rankingsPruned": _count(counts.rankings_pruned),
            "soloMatchesAbandoned": _count(counts.solo_matches_abandoned),
        },
    )


def server_error(method: str, route: str | None, error: BaseException) -> None:
    """처리하지 못한 예외 하나. 경로 틀과 예외 클래스 이름뿐이다.

    메시지·경로 값·본문은 싣지 않는다.
    """
    _emit(
        "server_error",
        {
            "method": method if method in _METHODS else "OTHER",
            "route": route if route and _ROUTE_TEMPLATE.fullmatch(route) else "<unmatched>",
            "error": _identifier(type(error).__name__),
        },
    )


def _reason(value: str) -> str:
    # 사유는 부르는 쪽이 정한 짧은 낱말뿐이다
    return value if _REASON.fullmatch(value) else "<invalid>"


def _identifier(value: str) -> str:
    return value if _IDENTIFIER.fullmatch(value) else "<invalid>"


# ── 5분 요약 ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WindowStats:
    requests: dict[str, int]
    rate_limited: int
    unhandled: int
    p50_ms: float | None
    p95_ms: float | None
    max_ms: float | None


class RequestWindow:
    """요약 한 창의 REST 요청 수·상태 갈래·429·처리 못 한 예외·지연 분포.

    고정 크기 칸만 센다. 요청이 몇 개든 칸의 수와 크기가 같다 — 요청마다의 값을 붙들지 않는다.
    API는 단일 worker의 이벤트 루프 하나에서 돌아 잠금이 필요 없다.
    """

    def __init__(self, bounds_ms: tuple[int, ...] = LATENCY_BUCKETS_MS) -> None:
        if not bounds_ms or list(bounds_ms) != sorted(set(bounds_ms)) or bounds_ms[0] <= 0:
            raise ValueError("latency buckets must be positive and strictly increasing")
        self._bounds = bounds_ms
        self._reset()

    def _reset(self) -> None:
        # 마지막 칸은 가장 큰 상한을 넘친 요청이다
        self._latency = [0] * (len(self._bounds) + 1)
        # 1xx..5xx. 범위 밖의 상태(있을 수 없다)는 가장 가까운 갈래로 센다
        self._classes = [0] * 5
        self._rate_limited = 0
        self._unhandled = 0
        self._max_ms = 0.0

    @property
    def bucket_count(self) -> int:
        return len(self._latency)

    def record(self, status: int, elapsed_ms: float) -> None:
        index = min(max(status // 100, 1), 5) - 1
        self._classes[index] += 1
        if status == 429:
            self._rate_limited += 1
        elapsed = max(0.0, float(elapsed_ms)) if math.isfinite(elapsed_ms) else 0.0
        self._max_ms = max(self._max_ms, elapsed)
        # 상한이 elapsed 이상인 첫 칸. 모든 상한보다 크면 넘친 칸(마지막)이다
        self._latency[bisect.bisect_left(self._bounds, elapsed)] += 1

    def record_unhandled(self) -> None:
        self._unhandled += 1

    def _percentile(self, quantile: float, total: int) -> float:
        rank = max(1, math.ceil(quantile * total))
        seen = 0
        for bucket, count in enumerate(self._latency):
            seen += count
            if seen >= rank:
                if bucket < len(self._bounds):
                    # 칸 상한이 관측한 최댓값보다 크면 최댓값으로 읽는다(p ≤ max)
                    return min(float(self._bounds[bucket]), round(self._max_ms, 1))
                break
        return round(self._max_ms, 1)

    def take(self) -> WindowStats:
        """지금 창을 읽고 비운다."""
        total = sum(self._latency)
        requests = {"total": sum(self._classes)}
        requests.update(
            {name: self._classes[index + 1] for index, name in enumerate(_STATUS_CLASSES)}
        )
        stats = WindowStats(
            requests=requests,
            rate_limited=self._rate_limited,
            unhandled=self._unhandled,
            p50_ms=self._percentile(0.50, total) if total else None,
            p95_ms=self._percentile(0.95, total) if total else None,
            max_ms=round(self._max_ms, 1) if total else None,
        )
        self._reset()
        return stats


def summary(
    *,
    window_seconds: float,
    stats: WindowStats,
    sockets: int,
    players: int,
    rooms: RoomCounts | None,
) -> None:
    """5분 요약 한 줄. 방·판 수를 읽지 못했으면(DB가 안 될 때) 그 칸은 null이다."""
    _emit(
        "summary",
        {
            "windowSeconds": max(0, round(window_seconds)),
            "sockets": _count(sockets),
            "players": _count(players),
            "rooms": (
                {
                    "waiting": _count(rooms.waiting_rooms),
                    "playing": _count(rooms.playing_rooms),
                }
                if rooms is not None
                else None
            ),
            "matches": _count(rooms.running_matches) if rooms is not None else None,
            "requests": dict(stats.requests),
            "rateLimited": stats.rate_limited,
            "unhandled": stats.unhandled,
            "latencyMs": {"p50": stats.p50_ms, "p95": stats.p95_ms, "max": stats.max_ms},
        },
    )


# ── REST 요청 계수 middleware ─────────────────────────────────────────────────

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def _route_template(scope: Scope) -> str | None:
    # FastAPI·Starlette의 router가 맞춘 route를 같은 scope에 적는다. 값이 아니라 틀이다.
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else None


class RequestMetricsMiddleware:
    """REST 요청마다 상태와 걸린 시간을 `RequestWindow`에 센다. WebSocket은 그대로 넘긴다.

    가장 바깥 user middleware로 단다 — TrustedHost·CORS가 거절한 요청과 preflight도 센다. 처리하지
    못한 예외는 Starlette의 ServerErrorMiddleware가 500으로 바꾸기 전에 여기를 지나므로 500으로 세고
    `server_error`를 한 줄 낸 뒤 그대로 다시 던진다(응답과 uvicorn의 오류 기록은 예전 그대로다).
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        window: RequestWindow,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.app = app
        self._window = window
        self._clock = clock

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        counted = scope.get("path") not in UNCOUNTED_PATHS
        started = self._clock()
        status: int | None = None

        async def send_counting(message: Message) -> None:
            nonlocal status
            if message.get("type") == "http.response.start":
                status = int(message.get("status", 500))
            await send(message)

        try:
            await self.app(scope, receive, send_counting)
        except Exception as error:
            if counted:
                self._window.record(
                    status or 500,
                    (self._clock() - started) * 1000,
                )
                self._window.record_unhandled()
            server_error(str(scope.get("method", "")), _route_template(scope), error)
            raise
        if counted and status is not None:
            self._window.record(status, (self._clock() - started) * 1000)
