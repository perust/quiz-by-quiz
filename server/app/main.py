from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from itertools import count
from typing import Annotated, Any, Literal
from uuid import UUID

from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import ops_log
from .config import Settings, is_public_pages_question_bank
from .domain import (
    ALLOWED_CAPACITIES,
    ALLOWED_CATEGORIES,
    DEFAULT_QUESTION_TIME_MS,
    MIN_MATCH_PLAYERS,
    DomainError,
    normalize_code,
    validate_chat,
    validate_player,
    validate_question_time,
    validate_room,
    validate_solo_room,
)
from .password_work import BoundedPasswordWork, PasswordWorkBusy
from .question_catalog import CatalogError, QuestionCatalog
from .rate_limit import (
    AtomicMultiWindowLimiter,
    MinimumIntervalGate,
    RateLimitClaim,
)
from .repository import (
    OWN_RECORDS_LIMIT,
    RANKING_BOARDS,
    RANKING_LIMIT,
    CleanupCounts,
    EndedSoloMatch,
    MatchAnswerView,
    MatchInProgress,
    MatchNotFound,
    MatchNotReady,
    MatchPositionMismatch,
    MatchReviewView,
    MatchScoreView,
    MatchSetup,
    MatchView,
    MemberConnected,
    NotHost,
    NotMember,
    OwnBestView,
    OwnRecordView,
    PlayerView,
    RankingBoardView,
    RankingEntryView,
    RankingPeriod,
    RoomFull,
    RoomNotFound,
    RoomsRepository,
    RoomView,
    SoloCreateLimited,
    SoloRoomsFull,
    StandingAnswer,
    TokenConflict,
    ranking_owner_key,
)
from .room_versions import RoomVersions
from .tickets import WebSocketTickets

logger = logging.getLogger(__name__)
# 이 API가 읽고 쓰는 마지막 migration. 013(혼자 푸는 온라인 판)의 표가 없으면 로비·방·참가를 읽지
# 못하고(방 SQL이 solo_rooms를 본다) 012(온라인 랭킹)의 표가 없으면 판을 닫지 못하며(닫는
# transaction이 기록을 남긴다) 011(방장이 고르는 문항 시간)의 열이 없으면 방과 판을 읽지 못하므로
# 공개 release gate는 정확히 이 판만 ready로 답한다 (deploy/oracle/README.md).
RELEASE_SCHEMA_VERSION = 13
WEBSOCKET_PROTOCOL = "qbb.v1"
WEBSOCKET_TICKET_PREFIX = "qbb.ticket."
MAX_MOVEMENT_VIEWPORT_DIMENSION = 8192
MOVEMENT_VIEWPORT_CAPABILITY = "sender-css-pixels-v1"
WAITING_ROOM_SEAT_CAPABILITY = "waiting-room-seat-v1"
# 이동에 공유 무대 좌표(`stage`·`stageX`·`stageY`, U31)를 실어도 된다는 표시. 화면은
# 티켓이 이 값을 줄 때만 싣는다 — 이전 API(#106)의 `_movement_message`는 모르는 키가
# 섞인 이동을 통째로 버린다.
MOVEMENT_STAGE_CAPABILITY = "stage-unit-v1"
# 걷는 캐릭터가 서는 공유 무대. 대기실 라운지와 온라인 퀴즈의 2×2 바닥
# (src/online/movement-contract.ts)
MOVEMENT_STAGE_IDS = frozenset({"lounge", "arena"})
# 방 소켓이 발밑 칸 초안(`standing-answer`)을 받는다 (U13). 이 값을 모르는 이전 API는
# 모르는 메시지를 버리기만 하지만(아래 receive 루프), 화면은 티켓이 이 값을 줄 때만 보낸다 —
# 소켓마다 다시 묻는다.
STANDING_ANSWER_CAPABILITY = "standing-answer-v1"
# 초안을 기억하는 시간. 문항은 길어야 40초라 그보다 오래된 초안은 쓸 데가 없다. 마감 sweep이 잠깐
# 실패해도 다음 sweep이 쓸 수 있게 여유를 둔다(그보다 늦으면 예전처럼 시간 초과가 된다).
STANDING_ANSWER_RECORD_SECONDS = 90.0
# (방, 참가자)마다 하나뿐이라 붙은 소켓 수를 넘지 않는다. 위조 세션이 몰려도 메모리를 묶는다.
MAX_STANDING_ANSWERS = 4_096
# 답안 제출(AnswerBody)과 같은 문항 순서 한도
MAX_MATCH_POSITION = 25
WAITING_ROOM_SEAT_IDS = frozenset(
    {"chair-left", "sofa-left", "sofa-right", "chair-right"}
)
# 소켓이 끊긴 뒤 이만큼 다시 붙지 않은 참가자는 시작 판정·판 참가·방장 자리에서 뺀다.
# 새로고침·앱 전환처럼 잠깐 끊긴 사람은 그대로 기다린다. 멤버십과 30분 재입장 유예는
# 이 값과 무관하다(CLAUDE.md «방이 아니라 참가자를 정리한다»).
PRESENCE_GRACE_SECONDS = 60.0
# 그보다 오래된 끊김 기록은 버린다. 멤버십이 끝난 사람의 기록은 presence sweep이 방의
# 참가자 목록을 보고 먼저 버리므로(`retain_presence`) 이것은 마지막 안전망이다.
PRESENCE_RECORD_SECONDS = 3_600.0
# 방장이 내보낸 참가자를 기억하는 시간과 개수 (U24). 그 사람이 돌아와 방을 읽으면 «없는 방»이 아니라
# «방장이 내보냈다»를 듣는다. 끊긴 자리를 비운 것은 차단이 아니다 — 다시 참가하면 지운다.
REMOVED_RECORD_SECONDS = 3_600.0
# 접속 중에 내보낸 사람은 이만큼 그 방에 다시 들어오지 못한다. 내보내자마자 같은 코드로
# 되돌아오면 내보내기가 아무 뜻이 없다. presence 처럼 메모리에만 있어 단일 worker 계약에 기대고,
# 재시작하면 풀린다.
KICK_BLOCK_SECONDS = 600.0
MAX_REMOVED_RECORDS = 4_096
# 인증된 REST 요청의 몫 (N01, 소유자 결정). 세 claim은 한꺼번에 먹거나 하나도 먹지 않는다.
# 교실·집 NAT 뒤의 여럿은 IP 하나를 나눠 쓴다 — IP당 120/60초가 전부이던 때 같은 IP의 6명 방은
# 답의 10–14%, 12명 방은 61–70%를 429로 잃었다(deploy/oracle/README.md의 측정). 그래서 한 사람
# (브라우저 세션)의 몫을 따로 두고, IP 몫은 가장 큰 방(12명 × 120)이 다 써도 남게 올렸다.
AUTHENTICATED_PLAYER_LIMIT = 120
AUTHENTICATED_CLIENT_LIMIT = 1_500
AUTHENTICATED_PROCESS_LIMIT = 3_000
AUTHENTICATED_WINDOW_SECONDS = 60
# 엔드포인트별 몫(입장·방 변경·채팅·답·소켓 티켓)의 IP 칸은 그 프로세스 몫을 이 수로 나눈 값이다
# (N01 리뷰 security-1). 이 몫은 멤버십을 보기 전에 먹어 무작위 방 코드마다 새 «사람+방» 열쇠가
# 생긴다. IP 칸이 없던 때는 IP 몫이 1,500이 된 뒤로 한 주소가 값싼 세션 몇 개로 프로세스 몫을 채워
# 서버의 모든 방을 막을 수 있었다. 절반이라 한 주소로는 채울 수 없다(인증 몫 1,500/3,000과 같은
# 비율). 12명 방 셋(교실 하나)의 가장 바쁜 1분도 든다 — deploy/oracle/README.md의 셈.
ENDPOINT_CLIENT_SHARE_DIVISOR = 2
# 한 사람이 방 코드를 바꿔 가며 보내도 «사람+방» 몫의 이 배수까지다 — 방 셋을 오가는 사람(같은
# 브라우저의 탭 셋)도 방마다 제 몫을 다 쓴다.
ENDPOINT_ACTOR_ROOM_SPAN = 3
# 공개 랭킹 읽기의 몫 (FR-7.13 2단계). 세션 없이도 읽는 공개 읽기라 release gate처럼
# IP·프로세스 칸으로 묶고, 신분을 실은 요청은 인증 몫(위)도 함께 먹는다. 한 교실(한 주소 뒤
# 36명)이 판을 마치고 함께 랭킹을 열어 탭 여덟을 넘겨 봐도(36 × 8 = 288) IP 칸 300에 들고,
# 프로세스 1,200은 초당 20번의 색인 조회(LIMIT 10)다. deploy/oracle/README.md의 ingress 한도와
# 같은 값이다.
RANKING_CLIENT_LIMIT = 300
RANKING_PROCESS_LIMIT = 1_200
RANKING_WINDOW_SECONDS = 60
RANKING_MODES = frozenset({"category", "all"})
RANKING_PERIODS: frozenset[RankingPeriod] = frozenset({"week", "all"})
# 랭킹의 «이번 주»가 쓰는 시간대. 응답이 함께 알린다.
RANKING_TIME_ZONE = "Asia/Seoul"
# 혼자 푸는 온라인 판 (FR-7.13 3단계, POST /v1/solo)의 몫. restart 없이는 판이 도는 동안의 요청이
# 새 판을 열지 않고 그 판을 돌려주고(resumed) 판 하나가 빨라도 1분 남짓(공개 8초 × 문항 수)이라 한
# 사람이 1분에 여는 판은 하나 남짓이다. 다만 화면은 늘 restart를 싣고(PRD 10.1 #11) 다른 판을 고를
# 때마다 도는 판을 끝내고 새로 열므로, 한 사람이 1분에 판을 이 사람 칸(12)만큼 열고 끝낼 수 있다 —
# 끝낸 판은 그 방에 2시간까지 남고, 판을 열 때 읽는 최근 출제는 최근 24판만 본다
# (`RECENT_MATCH_MEMORY`). 사람 칸은 두 번 누르기·다른 탭·이어 풀기도 넉넉히 품는다. 한 교실(한 주소
# 뒤 36명)이 함께 판을 열어도 1분에 30번 남짓이라 IP 칸 120에 들고, 프로세스 600은 방 변경 몫과
# 같다 — 서비스 전체에 남는 판 수는 이 칸 × 판의 수명으로 묶인다(deploy/oracle/README.md).
SOLO_ACTOR_LIMIT = 12
SOLO_CLIENT_LIMIT = 120
SOLO_PROCESS_LIMIT = 600
SOLO_WINDOW_SECONDS = 60
# 혼자 방을 **새로 만드는** 몫 (한 시간). 다시 쓰는 판(«다시 하기»·풀던 판)은 먹지 않는다.
# «홈으로»가 혼자 방을 지우므로 홈에서 고른 판마다 새 방이다 — 한 주소 뒤 36명이 3분마다 홈에서
# 새 판을 열어도(시간당 720번) 든다. 버리는 신분을 마구 만들어도 한 주소가 한 시간에 만드는 혼자
# 방은 이만큼이고, 버려진 방은 30분 정리까지 남으므로 한 주소가 함께 쥐는 혼자 방은 많아야 이것의
# 절반 남짓이다(동시 한도 `SOLO_ROOM_CEILING` 1,200의 30%). 프로세스 칸은 서비스 전체의 새 혼자
# 방이다 — 방 만들기의 100/시간과 같은 결의 상한이다.
SOLO_CREATE_CLIENT_LIMIT = 720
SOLO_CREATE_PROCESS_LIMIT = 2_400
SOLO_CREATE_WINDOW_SECONDS = 3_600
# 내 최고 기록(홈을 열 때마다 한 번)과 기록 내보내기의 몫. 인증 몫도 함께 먹는다
OWN_BEST_ACTOR_LIMIT = 30
OWN_RECORDS_ACTOR_LIMIT = 6
OWN_CLIENT_LIMIT = 600
OWN_PROCESS_LIMIT = 1_200
OWN_WINDOW_SECONDS = 60


def _websocket_ticket(websocket: WebSocket) -> str | None:
    protocols = tuple(
        protocol.strip()
        for value in websocket.headers.getlist("sec-websocket-protocol")
        for protocol in value.split(",")
        if protocol.strip()
    )
    candidates = tuple(
        protocol.removeprefix(WEBSOCKET_TICKET_PREFIX)
        for protocol in protocols
        if protocol.startswith(WEBSOCKET_TICKET_PREFIX)
    )
    if (
        len(protocols) != 2
        or protocols.count(WEBSOCKET_PROTOCOL) != 1
        or len(candidates) != 1
    ):
        return None
    ticket = candidates[0]
    if not 32 <= len(ticket) <= 256 or not ticket.isascii():
        return None
    if any(not (character.isalnum() or character in "-_") for character in ticket):
        return None
    return ticket


@dataclass(frozen=True)
class _Movement:
    """받아서 그대로 방송할 이동 하나. 누구의 것인지는 소켓 티켓이 정한다."""

    x: float
    y: float
    moving: bool
    viewport_width: int | None = None
    viewport_height: int | None = None
    seat_id: str | None = None
    # 공유 무대 좌표 (U31). 셋이 함께 있거나 함께 없다
    stage: str | None = None
    stage_x: float | None = None
    stage_y: float | None = None


def _unit_number(value: object) -> float | None:
    """0~1의 유한한 수. bool은 수가 아니다."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 1:
        return None
    return number


_LEGACY_MOVEMENT_KEYS = frozenset({"type", "x", "y", "moving"})
_VIEWPORT_MOVEMENT_KEYS = _LEGACY_MOVEMENT_KEYS | {"viewportWidth", "viewportHeight"}
_STAGE_MOVEMENT_KEYS = frozenset({"stage", "stageX", "stageY"})
# 받는 모양은 다섯뿐이다. 무대 좌표는 viewport 크기를 보내는 화면만 싣는다(받는다고 알린 소켓에서만)
_MOVEMENT_KEY_SETS = (
    _LEGACY_MOVEMENT_KEYS,
    _VIEWPORT_MOVEMENT_KEYS,
    _VIEWPORT_MOVEMENT_KEYS | {"seatId"},
    _VIEWPORT_MOVEMENT_KEYS | _STAGE_MOVEMENT_KEYS,
    _VIEWPORT_MOVEMENT_KEYS | {"seatId"} | _STAGE_MOVEMENT_KEYS,
)


def _movement_message(message: str) -> _Movement | None:
    """Return one strict, bounded movement payload without trusting client identity."""
    if len(message) > 256:
        return None
    try:
        value = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(value, dict):
        return None
    keys = set(value)
    if keys not in _MOVEMENT_KEY_SETS:
        return None
    if value["type"] != "movement" or type(value["moving"]) is not bool:
        return None
    x = _unit_number(value["x"])
    y = _unit_number(value["y"])
    if x is None or y is None:
        return None
    if keys == _LEGACY_MOVEMENT_KEYS:
        return _Movement(x=x, y=y, moving=value["moving"])
    viewport_width = value["viewportWidth"]
    viewport_height = value["viewportHeight"]
    if (
        type(viewport_width) is not int
        or type(viewport_height) is not int
        or not 1 <= viewport_width <= MAX_MOVEMENT_VIEWPORT_DIMENSION
        or not 1 <= viewport_height <= MAX_MOVEMENT_VIEWPORT_DIMENSION
    ):
        return None
    seat_id: str | None = None
    if "seatId" in keys:
        candidate = value["seatId"]
        if (
            not isinstance(candidate, str)
            or candidate not in WAITING_ROOM_SEAT_IDS
            or value["moving"]
        ):
            return None
        seat_id = candidate
    stage: str | None = None
    stage_x: float | None = None
    stage_y: float | None = None
    if "stage" in keys:
        stage_candidate = value["stage"]
        stage_x = _unit_number(value["stageX"])
        stage_y = _unit_number(value["stageY"])
        if (
            not isinstance(stage_candidate, str)
            or stage_candidate not in MOVEMENT_STAGE_IDS
            or stage_x is None
            or stage_y is None
        ):
            return None
        stage = stage_candidate
    return _Movement(
        x=x,
        y=y,
        moving=value["moving"],
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        seat_id=seat_id,
        stage=stage,
        stage_x=stage_x,
        stage_y=stage_y,
    )


def _movement_event(movement: _Movement, actor_id: UUID, sequence: int) -> dict[str, object]:
    """방 전원에게 보낼 이동. 받은 키만 싣는다 — 이전 화면은 모르는 키를 보지 않는다."""
    event: dict[str, object] = {
        "type": "movement",
        "playerId": str(actor_id),
        "x": movement.x,
        "y": movement.y,
        "moving": movement.moving,
        "sequence": sequence,
    }
    if movement.viewport_width is not None and movement.viewport_height is not None:
        event["viewportWidth"] = movement.viewport_width
        event["viewportHeight"] = movement.viewport_height
    if movement.seat_id is not None:
        event["seatId"] = movement.seat_id
    if movement.stage is not None:
        event["stage"] = movement.stage
        event["stageX"] = movement.stage_x
        event["stageY"] = movement.stage_y
    return event


def _standing_answer_message(message: str) -> tuple[UUID, int, int | None] | None:
    """발밑 칸 초안 하나 (U13). 판·문항 순서·칸(없으면 null, 칸에서 내려섰다)만 받는다.

    누구의 초안인지는 소켓 티켓이 정한다. 이 판·지금 문항·판의 참가자인지는 쓸 때(마감이 빈 답을
    채울 때) 잠근 판에서 다시 본다 — 받는 순간 견주면 그사이 문항이 넘어가도 알 수 없다.
    """
    if len(message) > 256 or '"standing-answer"' not in message:
        return None
    try:
        value = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(value, dict):
        return None
    if set(value) != {"type", "matchId", "position", "choiceIndex"}:
        return None
    if value["type"] != "standing-answer":
        return None
    raw_match_id = value["matchId"]
    position = value["position"]
    choice_index = value["choiceIndex"]
    if not isinstance(raw_match_id, str) or len(raw_match_id) != 36:
        return None
    try:
        match_id = UUID(raw_match_id)
    except ValueError:
        return None
    if type(position) is not int or not 1 <= position <= MAX_MATCH_POSITION:
        return None
    if choice_index is not None and (type(choice_index) is not int or choice_index not in range(4)):
        return None
    return match_id, position, choice_index


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SessionBody(StrictBody):
    nickname: str | None = None
    character_id: str | None = Field(default=None, alias="characterId")


class CreateRoomBody(StrictBody):
    name: str
    category_id: str | None = Field(default=None, alias="categoryId")
    capacity: StrictInt
    game_mode: StrictBool = Field(default=True, alias="gameMode")
    # 방장이 고르는 문항 시간(ms). 보내지 않는 구버전 client의 방은 20초다
    question_time_ms: StrictInt = Field(default=DEFAULT_QUESTION_TIME_MS, alias="questionTimeMs")
    is_public: StrictBool = Field(alias="isPublic")
    password: str | None = None


class JoinRoomBody(StrictBody):
    password: str | None = None


class UpdateRoomBody(StrictBody):
    category_id: str | None = Field(default=None, alias="categoryId")
    capacity: StrictInt | None = None
    game_mode: StrictBool | None = Field(default=None, alias="gameMode")
    question_time_ms: StrictInt | None = Field(default=None, alias="questionTimeMs")


class ChatBody(StrictBody):
    text: str


class SoloBody(StrictBody):
    # 「전체 도전」이면 None. 문항 시간은 20초·40초이거나 null(«제한 없음», PRD 10.1 #9) — 보내지
    # 않으면 20초다. 화면은 세션의 `soloUntimed`를 본 뒤에만 null을 보낸다
    category_id: str | None = Field(default=None, alias="categoryId")
    question_time_ms: StrictInt | None = Field(
        default=DEFAULT_QUESTION_TIME_MS, alias="questionTimeMs"
    )
    # 혼자 방에 다른 판(분야·전체 도전)이 돌고 있으면 그 판을 기록 없이 끝내고 이 판을 연다 (PRD
    # 10.1 #11). 같은 판이 돌면 그 판을 잇는다. 화면은 세션의 `soloRestart`를 본 뒤에만 보낸다
    restart: StrictBool = False


class ReadyBody(StrictBody):
    is_ready: StrictBool = Field(alias="isReady")


class AnswerBody(StrictBody):
    position: StrictInt = Field(ge=1, le=25)
    choice_index: StrictInt | None = Field(ge=0, le=3, alias="choiceIndex")


@dataclass(frozen=True)
class Identity:
    player_id: UUID
    token_hash: bytes


class EventHub:
    def __init__(
        self,
        *,
        max_actor_room: int = 2,
        max_room: int = 32,
        max_total: int = 256,
        send_timeout_seconds: float = 2.0,
        presence_grace_seconds: float = PRESENCE_GRACE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if min(max_actor_room, max_room, max_total) < 1:
            raise ValueError("event hub limits must be positive")
        if send_timeout_seconds <= 0:
            raise ValueError("event hub send timeout must be positive")
        if presence_grace_seconds <= 0:
            raise ValueError("event hub presence grace must be positive")
        self._max_actor_room = max_actor_room
        self._max_room = max_room
        self._max_total = max_total
        self._send_timeout_seconds = send_timeout_seconds
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self._connections: dict[WebSocket, tuple[str, UUID]] = {}
        self._room_counts: dict[str, int] = defaultdict(int)
        self._actor_room_counts: dict[tuple[str, UUID], int] = defaultdict(int)
        self._closing: dict[WebSocket, asyncio.Task[bool]] = {}
        self._accepting = True
        # 접속 상태(presence). 단일 worker 계약이라 메모리로 충분하다.
        self._presence_grace_seconds = presence_grace_seconds
        self._clock = clock
        self._live_actor_counts: dict[tuple[str, UUID], int] = {}
        self._absent_since: dict[tuple[str, UUID], float] = {}
        self._announced_absent: set[tuple[str, UUID]] = set()
        # 유예를 넘겨 끊긴 것을 sweep이 알리기 전에 다시 붙은 사람이 있는 방. 그사이 방을 읽은
        # 화면은 `connected: false`를 들고 있는데 끊김도 다시 붙음도 방송되지 않았다 — 다음
        # sweep이 이 방을 알리고, 그때까지 준비 토글은 고칠 거리를 싣지 않는다.
        self._presence_dirty: set[str] = set()

    def reserve(self, code: str, actor_id: UUID, websocket: WebSocket) -> bool:
        if not self._accepting:
            return False
        existing = self._connections.get(websocket)
        if existing is not None:
            return existing == (code, actor_id)
        actor_room = (code, actor_id)
        if (
            len(self._connections) >= self._max_total
            or self._room_counts.get(code, 0) >= self._max_room
            or self._actor_room_counts.get(actor_room, 0) >= self._max_actor_room
        ):
            return False
        self._connections[websocket] = actor_room
        self._room_counts[code] += 1
        self._actor_room_counts[actor_room] += 1
        return True

    def activate(self, code: str, actor_id: UUID, websocket: WebSocket) -> bool:
        if (
            not self._accepting
            or self._connections.get(websocket) != (code, actor_id)
            or websocket in self._closing
        ):
            return False
        sockets = self._rooms[code]
        if websocket not in sockets:
            sockets.add(websocket)
            actor_room = (code, actor_id)
            if (
                actor_room not in self._announced_absent
                and self._is_absent(actor_room, self._clock())
            ):
                # 방 snapshot은 이미 «연결 끊김»을 실었을 수 있는데 sweep은 아직 알리지 않았다.
                # 그대로 두면 알린 것과 지금이 같아 보여 sweep이 이 방을 놓친다.
                self._presence_dirty.add(code)
            self._live_actor_counts[actor_room] = (
                self._live_actor_counts.get(actor_room, 0) + 1
            )
            self._absent_since.pop(actor_room, None)
        return True

    def connect(self, code: str, actor_id: UUID, websocket: WebSocket) -> bool:
        if not self.reserve(code, actor_id, websocket):
            return False
        if self.activate(code, actor_id, websocket):
            return True
        self.disconnect(code, websocket)
        return False

    def disconnect(self, code: str, websocket: WebSocket) -> None:
        connection = self._connections.pop(websocket, None)
        if connection is None:
            return
        connected_code, actor_id = connection
        sockets = self._rooms.get(connected_code)
        was_live = sockets is not None and websocket in sockets
        if sockets is not None:
            sockets.discard(websocket)
            if not sockets:
                self._rooms.pop(connected_code, None)
        if was_live:
            live_room = (connected_code, actor_id)
            live = self._live_actor_counts.get(live_room, 0)
            if live > 1:
                self._live_actor_counts[live_room] = live - 1
            else:
                self._live_actor_counts.pop(live_room, None)
                self._absent_since[live_room] = self._clock()
        room_count = self._room_counts.get(connected_code, 0)
        if room_count > 1:
            self._room_counts[connected_code] = room_count - 1
        elif room_count == 1:
            self._room_counts.pop(connected_code, None)
        actor_room = (connected_code, actor_id)
        count = self._actor_room_counts.get(actor_room, 0)
        if count > 1:
            self._actor_room_counts[actor_room] = count - 1
        elif count == 1:
            self._actor_room_counts.pop(actor_room, None)

    async def _close_owned(
        self,
        code: str,
        websocket: WebSocket,
        close_code: int,
    ) -> bool:
        if websocket not in self._connections:
            return True
        try:
            await asyncio.wait_for(
                websocket.close(code=close_code),
                timeout=self._send_timeout_seconds,
            )
        except Exception as error:  # pragma: no cover - transport exception varies
            if websocket not in self._connections:
                return True
            logger.warning(
                "event websocket close did not complete for room %s",
                code,
                exc_info=error,
            )
            return False
        self.disconnect(code, websocket)
        return True

    async def _close(self, code: str, websocket: WebSocket, close_code: int) -> bool:
        if websocket not in self._connections:
            return True
        close_task = self._closing.get(websocket)
        if close_task is None:
            close_task = asyncio.create_task(
                self._close_owned(code, websocket, close_code)
            )
            self._closing[websocket] = close_task

            def forget(completed: asyncio.Task[bool]) -> None:
                if self._closing.get(websocket) is completed:
                    self._closing.pop(websocket, None)
                with suppress(asyncio.CancelledError, Exception):
                    completed.exception()

            close_task.add_done_callback(forget)
        return await asyncio.shield(close_task)

    async def disconnect_actor(
        self,
        code: str,
        actor_id: UUID,
        *,
        close_code: int = 4403,
    ) -> None:
        sockets = [
            websocket
            for websocket, connection in tuple(self._connections.items())
            if connection == (code, actor_id)
        ]
        results = await asyncio.gather(
            *(self._close(code, websocket, close_code) for websocket in sockets)
        )
        if any(not result for result in results):
            logger.warning(
                "event websocket close remains pending for room %s",
                code,
            )

    async def revalidate(
        self,
        is_member: Callable[[UUID, str], Awaitable[bool]],
    ) -> None:
        actor_room_sockets: dict[tuple[str, UUID], list[WebSocket]] = defaultdict(list)
        for websocket, actor_room in tuple(self._connections.items()):
            actor_room_sockets[actor_room].append(websocket)
        if not actor_room_sockets:
            return
        results = await asyncio.gather(
            *(
                is_member(actor_id, code)
                for code, actor_id in actor_room_sockets
            ),
            return_exceptions=True,
        )
        for (code, actor_id), result in zip(actor_room_sockets, results, strict=True):
            if isinstance(result, BaseException):
                logger.warning(
                    "event membership revalidation failed for room %s",
                    code,
                    exc_info=result,
                )
            elif not result:
                sockets = [
                    websocket
                    for websocket in actor_room_sockets[(code, actor_id)]
                    if self._connections.get(websocket) == (code, actor_id)
                ]
                close_results = await asyncio.gather(
                    *(self._close(code, websocket, 4403) for websocket in sockets)
                )
                if any(not closed for closed in close_results):
                    logger.warning(
                        "event websocket close remains pending for room %s",
                        code,
                    )

    async def _send_one(
        self,
        code: str,
        websocket: WebSocket,
        event: dict[str, object],
    ) -> None:
        try:
            await asyncio.wait_for(
                websocket.send_json(event),
                timeout=self._send_timeout_seconds,
            )
        except Exception:  # pragma: no cover - exact transport failure varies
            await self._close(code, websocket, 1011)

    async def broadcast(self, code: str, event: dict[str, object]) -> None:
        await asyncio.gather(
            *(
                self._send_one(code, websocket, event)
                for websocket in tuple(self._rooms.get(code, ()))
            )
        )

    async def send_actor(self, code: str, actor_id: UUID, event: dict[str, object]) -> None:
        """이 방에 열린 한 사람의 소켓에만 보낸다. 내보내진 사람의 화면에 이유를 먼저 알린다."""
        await asyncio.gather(
            *(
                self._send_one(code, websocket, event)
                for websocket in tuple(self._rooms.get(code, ()))
                if self._connections.get(websocket) == (code, actor_id)
            )
        )

    async def close_all(self) -> None:
        self._accepting = False
        await asyncio.gather(
            *(
                self._close(code, websocket, 1012)
                for websocket, (code, _) in tuple(self._connections.items())
            )
        )
        if self._connections:
            raise RuntimeError(
                f"event hub did not close {len(self._connections)} connection(s)"
            )

    def _is_absent(self, actor_room: tuple[str, UUID], now: float) -> bool:
        since = self._absent_since.get(actor_room)
        return (
            since is not None
            and actor_room not in self._live_actor_counts
            and now - since >= self._presence_grace_seconds
        )

    def is_present(self, code: str, actor_id: UUID) -> bool:
        """방 snapshot의 `connected`. 유예 안에 다시 붙으면 끊긴 적 없는 것으로 본다.

        이 프로세스에서 소켓을 본 적 없는 참가자(서버 재시작 뒤의 유령, 막 들어와 아직
        소켓을 열지 않은 사람)는 처음 물어본 지금부터 유예를 센다.
        """
        actor_room = (code, actor_id)
        if actor_room in self._live_actor_counts:
            return True
        now = self._clock()
        since = self._absent_since.setdefault(actor_room, now)
        return now - since < self._presence_grace_seconds

    def absent_actors(self, code: str) -> frozenset[UUID]:
        """유예를 넘겨 끊긴 이 방의 참가자. 시작 판정과 방장 승계가 쓴다."""
        now = self._clock()
        return frozenset(
            actor_id
            for room_code, actor_id in tuple(self._absent_since)
            if room_code == code and self._is_absent((room_code, actor_id), now)
        )

    def sweep_presence(self) -> frozenset[str]:
        """끊김으로 바뀌었거나 다시 붙어 `connected`가 달라진 방들.

        유예를 넘긴 뒤 이 sweep이 알리기 전에 다시 붙은 사람의 방도 든다(`_presence_dirty`).
        알린 끊김과 지금은 같아 보이지만, 그사이 방을 읽은 화면은 `connected: false`를 들고 있다.
        """
        now = self._clock()
        for actor_room, since in tuple(self._absent_since.items()):
            if now - since >= PRESENCE_RECORD_SECONDS:
                # 정리 sweep이 이미 지운 참가자다. 되살아났다고 방송하지 않는다.
                del self._absent_since[actor_room]
                self._announced_absent.discard(actor_room)
        absent = {
            actor_room
            for actor_room in self._absent_since
            if self._is_absent(actor_room, now)
        }
        changed = frozenset(code for code, _ in absent ^ self._announced_absent)
        changed |= self._presence_dirty
        self._presence_dirty = set()
        self._announced_absent = absent
        return changed

    def presence_settled(self, code: str) -> bool:
        """이 방의 접속 상태 변화가 모두 방송됐는가 (room-invalidated 줄이기).

        유예를 넘겨 끊겼는데 아직 sweep이 알리지 않았거나, 알린 뒤 다시 붙었거나, 알리기 전에
        끊겼다 다시 붙었으면(`_presence_dirty`) False다. 그동안 방 snapshot의 `connected`는 이미
        달라져 있거나 같은 번호의 snapshot끼리 다르다 — 준비 토글을 GET 없이 고치게 하면 화면이
        낡은 접속 상태를 이어 쓰므로, 그때는 고칠 거리(`readyChange`)를 싣지 않아 모두 다시
        읽게 한다.
        """
        if code in self._presence_dirty:
            return False
        now = self._clock()
        for actor_room in self._absent_since:
            if actor_room[0] == code and (
                self._is_absent(actor_room, now) != (actor_room in self._announced_absent)
            ):
                return False
        return not any(
            actor_room[0] == code and actor_room not in self._absent_since
            for actor_room in self._announced_absent
        )

    def absent_by_room(self) -> dict[str, frozenset[UUID]]:
        """유예를 넘겨 끊긴 참가자가 있는 방마다 그 참가자들. presence sweep이 매번 다시 본다."""
        now = self._clock()
        rooms: dict[str, set[UUID]] = defaultdict(set)
        for actor_room in tuple(self._absent_since):
            if self._is_absent(actor_room, now):
                rooms[actor_room[0]].add(actor_room[1])
        return {code: frozenset(actor_ids) for code, actor_ids in rooms.items()}

    def forget_presence(self, code: str, actor_id: UUID) -> None:
        """멤버십이 끝났거나 새로 시작된 참가자의 끊김 기록을 지운다.

        나간 사람은 다음 sweep에서 방송할 일이 없고, 다시 들어온 사람은 새 유예로 센다.
        """
        actor_room = (code, actor_id)
        self._absent_since.pop(actor_room, None)
        self._announced_absent.discard(actor_room)

    def retain_presence(self, code: str, member_ids: frozenset[UUID] | None) -> bool:
        """지금 참가자가 아닌 사람의 끊김 기록을 버린다. 방이 없으면(None) 그 방의 기록을 모두.

        30분 정리와 방 삭제는 hub를 거치지 않는다. 기록이 남으면 같은 방에 다시 들어온 사람이
        들어오자마자 끊긴 사람으로 세어진다. 무엇이든 버렸으면 True다.
        """
        stale = [
            actor_room
            for actor_room in tuple(self._absent_since)
            if actor_room[0] == code
            and (member_ids is None or actor_room[1] not in member_ids)
        ]
        for actor_room in stale:
            del self._absent_since[actor_room]
            self._announced_absent.discard(actor_room)
        return bool(stale)

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    @property
    def live_member_count(self) -> int:
        """소켓이 하나라도 열린 (방, 참가자) 수. 운영 요약의 «접속 중인 참가자»다."""
        return len(self._live_actor_counts)

    def is_connected(self, websocket: WebSocket) -> bool:
        return websocket in self._connections


RemovalReason = Literal["removed", "kicked"]


class RemovedMembers:
    """방장이 내보낸 (방, 참가자). 단일 worker 계약이라 presence 처럼 메모리로 충분하다.

    두 가지다. 유예를 넘겨 끊긴 자리를 비운 것(`removed`)은 알리는 데만 쓰고 다시 참가하는 것을
    막지 않는다. 접속 중에 내보낸 것(`kicked`)은 `block_seconds` 동안 같은 방 참가를 거절하고,
    그 뒤로는 `removed` 처럼 알리기만 한다. 막는 시간은 기록보다 길 수 없다 — 기록이 사라지면
    막을 근거도 없다. 기록 수는 `max_records` 로 묶는다. 넘치면 가장 오래된 것부터 버리므로
    극단적으로 몰리면 막힌 기록도 일찍 풀릴 수 있다(메모리를 키우지 않는 쪽을 골랐다).
    """

    def __init__(
        self,
        *,
        record_seconds: float = REMOVED_RECORD_SECONDS,
        block_seconds: float = KICK_BLOCK_SECONDS,
        max_records: int = MAX_REMOVED_RECORDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if record_seconds <= 0 or block_seconds <= 0 or max_records < 1:
            raise ValueError("removed member records must be positive")
        self._record_seconds = record_seconds
        self._block_seconds = min(block_seconds, record_seconds)
        self._max_records = max_records
        self._clock = clock
        # 넣은 순서가 곧 시각 순서다. 가득 차면 가장 오래된 것부터 버린다. 값은 (시각, 막는가).
        self._records: dict[tuple[str, UUID], tuple[float, bool]] = {}

    def mark(self, code: str, player_id: UUID, *, blocked: bool = False) -> None:
        now = self._clock()
        for key, (at, _) in tuple(self._records.items()):
            if now - at < self._record_seconds:
                break
            del self._records[key]
        key = (code, player_id)
        self._records.pop(key, None)
        self._records[key] = (now, blocked)
        while len(self._records) > self._max_records:
            del self._records[next(iter(self._records))]

    def reason(self, code: str, player_id: UUID) -> RemovalReason | None:
        """그 사람이 이 방에서 내보내졌는가. 아직 막혀 있으면 `kicked`, 알리기만 하면 `removed`."""
        key = (code, player_id)
        record = self._records.get(key)
        if record is None:
            return None
        at, blocked = record
        age = self._clock() - at
        if age >= self._record_seconds:
            del self._records[key]
            return None
        return "kicked" if blocked and age < self._block_seconds else "removed"

    def was_removed(self, code: str, player_id: UUID) -> bool:
        return self.reason(code, player_id) is not None

    def is_blocked(self, code: str, player_id: UUID) -> bool:
        return self.reason(code, player_id) == "kicked"

    def forget(self, code: str, player_id: UUID) -> None:
        self._records.pop((code, player_id), None)

    def forget_room(self, code: str) -> None:
        for key in [key for key in self._records if key[0] == code]:
            del self._records[key]


@dataclass(frozen=True)
class _StandingDraft:
    match_id: UUID
    position: int
    answer: StandingAnswer
    # 기억한 때(monotonic). 오래된 것부터 버린다
    recorded_at: float


class StandingAnswers:
    """발밑 칸 초안 (U13). 시간이 끝나면 선 칸이 답이라는 혼자 하기 규칙을 온라인에도 쓴다.

    화면은 실제로 움직인 뒤 선 칸이 바뀔 때만(잠깐 멈췄다 보내는 debounce) 방 소켓으로
    보내고, 칸에서 내려서면 지운다. 서버 권위는 그대로다 — 이것은 «모두 답했다»에 세지 않고
    (앞당긴 공개는 여전히 직접 낸 답만 기다린다), 마감이 빈 답을 채울 때만 그 칸을 보통 답으로
    남긴다(`_record_standing_answers`).

    presence·`RemovedMembers` 처럼 메모리에만 있어 **단일 worker 계약**에 기댄다. API를 다시
    띄우면 잃는다 — 다시 붙은 화면이 마지막 초안을 다시 보내지만, 그 전에 마감이 오면 예전처럼
    시간 초과다. (방, 참가자)마다 하나만 둔다: 새 초안이 앞 초안을 갈아 치우므로 문항이 넘어가도
    쌓이지 않는다. 문항이 넘어가거나 판이 끝나면(`settle`) 그 판의 지난 초안을 버리고, 오래된
    것(`record_seconds`)과 넘치는 것(`max_records`, 가장 오래된 것부터)도 버린다.
    """

    def __init__(
        self,
        *,
        record_seconds: float = STANDING_ANSWER_RECORD_SECONDS,
        max_records: int = MAX_STANDING_ANSWERS,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if record_seconds <= 0 or max_records < 1:
            raise ValueError("standing answer records must be positive")
        self._record_seconds = record_seconds
        self._max_records = max_records
        self._clock = clock
        self._wall_clock = wall_clock
        # 넣은 순서가 곧 시각 순서다(같은 열쇠는 빼고 다시 넣는다)
        self._drafts: dict[tuple[str, UUID], _StandingDraft] = {}
        # 방마다 초안이 있는 참가자. 마감 sweep이 방 하나의 초안만 훑는다
        self._rooms: dict[str, set[UUID]] = defaultdict(set)

    def _drop(self, key: tuple[str, UUID]) -> None:
        if self._drafts.pop(key, None) is None:
            return
        code, player_id = key
        players = self._rooms.get(code)
        if players is not None:
            players.discard(player_id)
            if not players:
                del self._rooms[code]

    def _expire(self, now: float) -> None:
        # 넣은 순서가 시각 순서라 앞에서부터 오래된 것만 본다 — 마감 sweep이 초마다 판마다 부른다
        while self._drafts:
            key, draft = next(iter(self._drafts.items()))
            if now - draft.recorded_at < self._record_seconds:
                break
            self._drop(key)

    def record(
        self,
        code: str,
        player_id: UUID,
        *,
        match_id: UUID,
        position: int,
        choice_index: int,
    ) -> None:
        now = self._clock()
        self._expire(now)
        key = (code, player_id)
        self._drop(key)
        self._drafts[key] = _StandingDraft(
            match_id=match_id,
            position=position,
            answer=StandingAnswer(choice_index=choice_index, received_at=self._wall_clock()),
            recorded_at=now,
        )
        self._rooms[code].add(player_id)
        while len(self._drafts) > self._max_records:
            self._drop(next(iter(self._drafts)))

    def clear(self, code: str, player_id: UUID) -> None:
        """칸에서 내려섰다. 그 사람의 초안을 지운다."""
        self._drop((code, player_id))

    def for_question(
        self,
        code: str,
        match_id: UUID,
        position: int,
    ) -> dict[UUID, StandingAnswer]:
        self._expire(self._clock())
        result: dict[UUID, StandingAnswer] = {}
        for player_id in tuple(self._rooms.get(code, ())):
            draft = self._drafts.get((code, player_id))
            if draft is not None and draft.match_id == match_id and draft.position == position:
                result[player_id] = draft.answer
        return result

    def settle(
        self,
        code: str,
        match_id: UUID,
        *,
        through_position: int | None,
    ) -> None:
        """그 판의 문항이 닫혔다. 그 문항(`through_position`)까지의 초안을 버린다.

        None이면 판이 끝났다 — 그 판의 초안을 모두 버린다.
        """
        for player_id in tuple(self._rooms.get(code, ())):
            draft = self._drafts.get((code, player_id))
            if draft is None or draft.match_id != match_id:
                continue
            if through_position is None or draft.position <= through_position:
                self._drop((code, player_id))

    def settle_view(self, code: str, match: MatchView) -> None:
        """API가 읽은 판의 모습으로 지난 초안을 버린다. 도는 문항의 초안은 그대로 둔다."""
        if match.state == "running":
            self.settle(code, match.id, through_position=match.current_position - 1)
        elif match.state == "revealing":
            self.settle(code, match.id, through_position=match.current_position)
        else:
            self.settle(code, match.id, through_position=None)

    def forget_member(self, code: str, player_id: UUID) -> None:
        self._drop((code, player_id))

    def forget_room(self, code: str) -> None:
        for player_id in tuple(self._rooms.get(code, ())):
            self._drop((code, player_id))

    def __len__(self) -> int:
        return len(self._drafts)


def _error(
    status: int,
    code: str,
    message: str,
    *,
    headers: dict[str, str] | None = None,
) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"code": code, "message": message},
        headers=headers,
    )


def _rate_limited(message: str, wait_seconds: float) -> HTTPException:
    """요청 한도(429). `Retry-After`는 한도가 실제로 한 자리를 비울 때까지의 초다 (N01).

    브라우저는 놓친 재조회를 이 값(상한 약 3초)과 jitter를 두고 한 번 다시 보낸다. 거절된 요청은
    한도를 먹지 않으므로 이른 재시도가 몫을 더 깎지는 않는다.
    """
    return _error(
        429,
        "rate-limited",
        message,
        headers={"Retry-After": str(max(1, math.ceil(wait_seconds)))},
    )


def _removed_error(status: int, reason: RemovalReason) -> HTTPException:
    """내보내진 사람이 방을 읽거나 다시 붙으려 할 때. «없는 방»과 다른 말을 한다 (U24)."""
    if reason == "kicked":
        return _error(
            status,
            "kicked",
            "방장이 내보낸 방이에요. 잠시 뒤에 다시 들어올 수 있어요.",
        )
    return _error(
        status,
        "removed",
        "방장이 방에서 내보냈어요. 방 코드로 다시 참가할 수 있어요.",
    )


def _identity(
    authorization: Annotated[str | None, Header()] = None,
    player_id_header: Annotated[str | None, Header(alias="X-Player-Id")] = None,
) -> Identity:
    if not authorization or not player_id_header:
        raise _error(401, "unauthorized", "온라인 세션이 필요해요.")

    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not 32 <= len(token) <= 256:
        raise _error(401, "unauthorized", "온라인 세션이 올바르지 않아요.")
    if not token.isascii() or any(character.isspace() for character in token):
        raise _error(401, "unauthorized", "온라인 세션이 올바르지 않아요.")

    try:
        player_id = UUID(player_id_header)
    except ValueError as error:
        raise _error(401, "unauthorized", "온라인 세션이 올바르지 않아요.") from error

    return Identity(
        player_id=player_id,
        token_hash=hashlib.sha256(token.encode("utf-8")).digest(),
    )


def _player_payload(player: PlayerView) -> dict[str, object]:
    return {
        "id": str(player.id),
        "nickname": player.nickname,
        "characterId": player.character_id,
        "isReady": player.is_ready,
        "connected": player.connected,
    }


def _room_payload(room: RoomView) -> dict[str, object]:
    payload: dict[str, object] = {
        "code": room.code,
        "name": room.name,
        "categoryId": room.category_id,
        "capacity": room.capacity,
        "gameMode": room.game_mode,
        "questionTimeMs": room.question_time_ms,
        "players": [_player_payload(player) for player in room.players],
        "isPublic": room.is_public,
        "hasPassword": room.has_password,
        "isMine": room.is_mine,
        "joined": room.joined,
        "createdAt": room.created_at,
        "status": room.status,
        "inMatch": room.in_match,
        # 판을 여는 데 필요한 세는 사람 수. 방장 혼자서도 연다 — 이 필드가 없는 이전 API는 둘이었다
        "minPlayers": MIN_MATCH_PLAYERS,
    }
    # 혼자 푸는 온라인 판의 방 (FR-7.13 3단계). 그 사람에게만 보이는 방이라 true일 때만 싣는다 —
    # 화면은 로비 목록에서 빼고 홈의 «풀던 혼자 판»으로만 잇는다. 이전 화면은 이 키를 모른다
    if room.solo:
        payload["solo"] = True
    # «제한 없음» 혼자 방 (PRD 10.1 #9, migration 013)은 `questionTimeMs` 키를 싣지 않고
    # `untimed: true`만 싣는다. #109 전의 Pages 화면(#106–#108)은 방마다 null을 거절하고 한 방이
    # 틀리면 로비 목록 전체를 버린다 — 같은 브라우저의 새 화면 탭이 연 «제한 없음» 혼자 방
    # 하나가 Pages 발행 전부터 열려 있던 탭의 로비를 통째로 막았다. 키가 없으면 그 화면은 20초
    # 방으로 읽어 목록을 그린다(그 방의 도는 판은 마감이 null이라 그 화면의 판 읽기가 거절한다
    # — 판 snapshot은 null을 그대로 싣는다). 지금 화면은 이 표시를 보고 문항 시간이 없는 방으로
    # 읽는다. 친구와 푸는 방은 언제나 20초·40초를 싣는다
    if room.question_time_ms is None:
        del payload["questionTimeMs"]
        payload["untimed"] = True
    return payload


def _match_answer_payload(answer: MatchAnswerView) -> dict[str, object]:
    return {
        "position": answer.position,
        "choiceIndex": answer.choice_index,
        "correct": answer.correct,
        "timedOut": answer.timed_out,
        "answerIndex": answer.answer_index,
        "explanation": answer.explanation,
    }


def _own_submission_payload(answer: MatchAnswerView) -> dict[str, object]:
    """A running match can acknowledge a submission without revealing whether it was right."""
    return {
        "position": answer.position,
        "choiceIndex": answer.choice_index,
        "timedOut": answer.timed_out,
    }


def _remaining_ms(match: MatchView, now: datetime) -> int | None:
    """응답 시점까지 남은 활성 phase 시간. 브라우저는 표시용 카운트다운에만 쓴다.

    running이면 제출 마감까지, revealing이면 다음 문제(또는 최종 순위)까지의 시간이다.
    브라우저 시계 오차와 무관하도록 절대 시각이 아니라 남은 양으로 보낸다. 마감 판정은
    언제나 서버(PostgreSQL deadline)가 한다.
    """
    if match.state not in {"running", "revealing"} or match.deadline_at is None:
        return None
    deadline = datetime.fromisoformat(match.deadline_at)
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=UTC)
    return max(0, math.floor((deadline - now).total_seconds() * 1000))


def _score_payload(score: MatchScoreView, *, revealing: bool) -> dict[str, object]:
    payload: dict[str, object] = {
        "playerId": str(score.player_id),
        "nickname": score.nickname,
        "characterId": score.character_id,
        "score": score.score,
        "correctCount": score.correct_count,
        "answeredCount": score.answered_count,
    }
    # 공개 단계의 미니 점수판·이름표 ✓/✗ (U30). 공개 중일 때만 싣는다.
    if revealing and score.last_answer_correct is not None:
        payload["lastAnswerCorrect"] = score.last_answer_correct
    return payload


def _review_payload(item: MatchReviewView) -> dict[str, object]:
    return {
        "position": item.position,
        "id": item.question_id,
        "categoryId": item.category_id,
        "question": item.question,
        "choices": list(item.choices),
        "answerIndex": item.answer_index,
        "explanation": item.explanation,
        "choiceIndex": item.choice_index,
        "correct": item.correct,
        "timedOut": item.timed_out,
    }


def _match_payload(match: MatchView, now: datetime | None = None) -> dict[str, object]:
    question = None
    if match.question is not None:
        question = {
            "id": match.question.id,
            "categoryId": match.question.category_id,
            "question": match.question.question,
            "choices": list(match.question.choices),
            "position": match.question.position,
            "total": match.question.total,
        }
    untimed = match.question_time_ms is None
    payload: dict[str, object] = {
        "matchId": str(match.id),
        "state": match.state,
        "categoryId": match.category_id,
        "gameMode": match.game_mode,
        "currentPosition": match.current_position,
        "totalQuestions": match.total_questions,
        # 이 판의 문항 시간. 화면의 남은 시간 막대가 «가득»으로 쓴다 (마감 판정은 여전히 서버다).
        # «제한 없음» 혼자 판이면 null이고 도는 문항의 deadlineAt·remainingMs도 null이다
        "questionTimeMs": match.question_time_ms,
        "deadlineAt": match.deadline_at,
        "remainingMs": _remaining_ms(match, now or datetime.now(UTC)),
        # 시간이 끝나면 발밑 칸이 답이다(U13, 혼자 하기와 같다). 화면이 초안을 보내고 규칙을
        # 그렇게 말한다. 이 필드가 없는 이전 API에서는 직접 낸 답만 세고, 화면은 초안을
        # 보내지 않는다. 마감이 없는 판에는 싣지 않는다 — 직접 낸 답만 답이다
        "standingAnswers": not untimed,
        "question": question,
        "ownSubmission": (
            _own_submission_payload(match.own_answer)
            if match.state == "running" and match.own_answer is not None
            else None
        ),
        "reveal": (
            _match_answer_payload(match.own_answer)
            if match.state == "revealing" and match.own_answer is not None
            else None
        ),
        "scores": [
            _score_payload(score, revealing=match.state == "revealing")
            for score in match.scores
        ]
        if match.state != "running"
        else [],
    }
    # 마감 없는 혼자 판 (PRD 10.1 #9). 더하기만 한 표시다 — 이것이 있을 때만 화면이 null 문항 시간과
    # 도는 문항의 null 마감을 믿는다. 이 표시를 모르는 화면은 그런 판을 열지 않는다(null을 보내지
    # 않는다)
    if untimed:
        payload["untimed"] = True
    # «문제 다시 보기»(U38)는 끝난 판에만 있다. 진행 중인 판의 응답에는 키조차 없다.
    if match.state == "finished":
        payload["review"] = [_review_payload(item) for item in match.review]
        # 이 판의 내 결과가 온라인 랭킹에 남았는가 (FR-7.13 2단계). 이 필드가 없는 이전 API의 결과
        # 화면은 랭킹 이야기를 하지 않는다.
        payload["rankingRecorded"] = match.ranking_recorded
    return payload


def _ranking_entry_payload(entry: RankingEntryView) -> dict[str, object]:
    # 브라우저 신분(player id)은 싣지 않는다. 묻는 사람의 기록인지(isMine)만 알린다.
    return {
        "rank": entry.rank,
        "nickname": entry.nickname,
        "characterId": entry.character_id,
        "score": entry.score,
        "correctCount": entry.correct_count,
        "totalCount": entry.total_count,
        "recordedAt": entry.recorded_at,
        "isMine": entry.is_mine,
    }


def _ranking_payload(
    view: RankingBoardView,
    *,
    mode: str,
    category_id: str | None,
) -> dict[str, object]:
    window = None
    if view.period == "week" and view.window_start and view.window_end:
        window = {
            "start": view.window_start,
            "end": view.window_end,
            "timeZone": RANKING_TIME_ZONE,
        }
    return {
        "mode": mode,
        "categoryId": category_id,
        "period": view.period,
        "window": window,
        "limit": RANKING_LIMIT,
        "entries": [_ranking_entry_payload(entry) for entry in view.entries[:RANKING_LIMIT]],
    }


def _own_best_payload(best: OwnBestView | None) -> dict[str, object] | None:
    if best is None:
        return None
    return {
        "score": best.score,
        "correctCount": best.correct_count,
        "totalCount": best.total_count,
        "recordedAt": best.recorded_at,
    }


def _own_record_payload(record: OwnRecordView) -> dict[str, object]:
    # 브라우저 신분(player id)·주인 열쇠는 싣지 않는다. 판(board)은 랭킹과 같은
    # mode·categoryId로 옮긴다
    return {
        "mode": "all" if record.board == "all" else "category",
        "categoryId": None if record.board == "all" else record.board,
        "score": record.score,
        "correctCount": record.correct_count,
        "totalCount": record.total_count,
        "questionTimeMs": record.question_time_ms,
        "nickname": record.nickname,
        "recordedAt": record.recorded_at,
    }


def _match_start_payload(match: MatchSetup) -> dict[str, object]:
    payload: dict[str, object] = {
        "matchId": str(match.id),
        "categoryId": match.category_id,
        "gameMode": match.game_mode,
        "totalQuestions": match.total_questions,
        "questionTimeMs": match.question_time_ms,
    }
    if match.question_time_ms is None:
        payload["untimed"] = True
    return payload


def _ended_solo_payload(ended: EndedSoloMatch) -> dict[str, object]:
    """끝내고 새로 연 혼자 판의 앞 판 (PRD 10.1 #11). 화면은 이것으로 «기록 없이 끝냈어요»를
    말한다."""
    return {
        "matchId": str(ended.match_id),
        "categoryId": ended.category_id,
        # 마지막 공개만 남은 판(끝까지 푼 판)이면 닫아 기록했다
        "recorded": ended.recorded,
    }


def _client_key(request: Request) -> str:
    # API 컨테이너에는 외부 포트가 없고 Caddy만 접근한다. Caddy가 붙인 첫 주소를 쓴다.
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def create_app(
    *,
    repository: RoomsRepository | None = None,
    settings: Settings | None = None,
    password_hasher: Any | None = None,
    tickets: WebSocketTickets | None = None,
    cleanup_interval_seconds: float = 60.0,
    presence_interval_seconds: float = 5.0,
    event_hub: EventHub | None = None,
    removed_members: RemovedMembers | None = None,
    standing_answers: StandingAnswers | None = None,
    room_versions: RoomVersions | None = None,
    ops_summary_interval_seconds: float = ops_log.SUMMARY_INTERVAL_SECONDS,
) -> FastAPI:
    if (
        isinstance(cleanup_interval_seconds, bool)
        or cleanup_interval_seconds <= 0
    ):
        raise ValueError("cleanup_interval_seconds must be positive")
    if (
        isinstance(ops_summary_interval_seconds, bool)
        or ops_summary_interval_seconds <= 0
    ):
        raise ValueError("ops_summary_interval_seconds must be positive")
    if (
        isinstance(presence_interval_seconds, bool)
        or presence_interval_seconds <= 0
    ):
        raise ValueError("presence_interval_seconds must be positive")
    active_settings = settings or Settings.from_env()
    if repository is None:
        if not active_settings.database_url:
            raise RuntimeError("DATABASE_URL is required")
        question_bank_dir = active_settings.question_bank_dir
        if question_bank_dir is None or is_public_pages_question_bank(question_bank_dir):
            raise RuntimeError("QUESTION_BANK_DIR must point to a private online question bank")
        from .postgres import PostgresRoomsRepository

        try:
            catalog = QuestionCatalog.from_directory(question_bank_dir)
        except CatalogError as error:
            raise RuntimeError("private online question bank is invalid") from error
        repo: RoomsRepository = PostgresRoomsRepository(
            active_settings.database_url,
            question_catalog=catalog,
        )
    else:
        repo = repository

    password_work = BoundedPasswordWork(hasher=password_hasher)
    ticket_store = tickets or WebSocketTickets()
    hub = event_hub or EventHub()
    removed = removed_members or RemovedMembers()
    standing = standing_answers if standing_answers is not None else StandingAnswers()
    versions = room_versions if room_versions is not None else RoomVersions()
    ingress_limiter = AtomicMultiWindowLimiter()
    authenticated_ingress_limiter = AtomicMultiWindowLimiter()
    join_limiter = AtomicMultiWindowLimiter()
    mutation_limiter = AtomicMultiWindowLimiter()
    chat_limiter = AtomicMultiWindowLimiter()
    answer_limiter = AtomicMultiWindowLimiter()
    ticket_limiter = AtomicMultiWindowLimiter()
    websocket_inbound_limiter = AtomicMultiWindowLimiter()
    release_readiness_limiter = AtomicMultiWindowLimiter()
    ranking_limiter = AtomicMultiWindowLimiter()
    movement_sequences = count(1)
    # 운영 기록 (deploy/oracle/README.md «Operational log»). uvicorn의 --log-level과 무관하게
    # INFO 한 줄 JSON을 stderr로 낸다. 요청 계수는 고정 크기 칸뿐이라 요청 수와 무관하게
    # 메모리가 같다.
    ops_log.install()
    request_window = ops_log.RequestWindow()

    def room_payload(room: RoomView, label: int | None = None) -> dict[str, object]:
        """DB snapshot에 hub가 아는 접속 상태를 얹어 내보낸다.

        `label`은 DB를 읽기 **전에** 읽은 판 번호(`versions.label()`)다. 붙이면 화면이
        «이 번호까지 알린 변화를 담은 방»으로 믿고 그 번호 이하의 room-invalidated를 다시
        읽지 않는다. 이전 화면은 두 키를 모르고 지나간다.
        """
        payload = _room_payload(
            replace(
                room,
                players=tuple(
                    replace(player, connected=hub.is_present(room.code, player.id))
                    for player in room.players
                ),
            )
        )
        if label is not None:
            payload["roomEpoch"] = versions.epoch
            payload["roomVersion"] = label
        return payload

    def room_invalidated(
        version: int,
        *,
        ready_change: dict[str, object] | None = None,
    ) -> dict[str, object]:
        """방 전원이 다시 읽을 까닭.

        번호와 묶음 이름은 더하기만 한 키라 이전 화면은 예전처럼 다시 읽는다.
        """
        event: dict[str, object] = {
            "type": "room-invalidated",
            "roomEpoch": versions.epoch,
            "roomVersion": version,
        }
        if ready_change is not None:
            event["readyChange"] = ready_change
        return event

    async def announce_room(code: str) -> None:
        """방이 바뀌었다(commit 뒤). 번호를 올리고 방 전원에게 알린다."""
        version, _ = versions.bump(code)
        await hub.broadcast(code, room_invalidated(version))

    def match_absent_ids(code: str, actor_id: UUID) -> frozenset[UUID]:
        """«모두 답했다»의 분모에서 뺄 참가자 (U32). 지금 요청한 사람은 끊긴 사람이 아니다.

        소켓 없이 REST로만 푸는 사람도 제 요청에서는 세어야 한다 — 빼면 그 사람의 GET 하나가
        자기 답을 기다리지 않고 문항을 넘겨 버린다.
        """
        return hub.absent_actors(code) - {actor_id}

    def actor_room_wait(
        limiter: AtomicMultiWindowLimiter,
        *,
        prefix: str,
        actor_id: UUID,
        code: str,
        client_key: str,
        actor_limit: int,
        actor_window_seconds: float,
        process_limit: int,
    ) -> float | None:
        """None이면 들였다. 아니면 다시 해도 되는 때까지의 초(`Retry-After`).

        네 claim은 한꺼번에 먹거나 하나도 먹지 않는다. 멤버십·방 확인보다 먼저 먹으므로 무작위
        코드도 몫을 먹는다 — 그래서 사람(방 코드와 무관)과 IP 칸이 프로세스 몫을 지킨다 (N01 리뷰).
        """
        return limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"{prefix}:actor-room:{actor_id}:{code}",
                    limit=actor_limit,
                    window_seconds=actor_window_seconds,
                ),
                RateLimitClaim(
                    key=f"{prefix}:actor:{actor_id}",
                    limit=actor_limit * ENDPOINT_ACTOR_ROOM_SPAN,
                    window_seconds=actor_window_seconds,
                ),
                RateLimitClaim(
                    key=f"{prefix}:client:{client_key}",
                    limit=process_limit // ENDPOINT_CLIENT_SHARE_DIVISOR,
                    window_seconds=60,
                ),
                RateLimitClaim(
                    key=f"{prefix}:process",
                    limit=process_limit,
                    window_seconds=60,
                ),
            )
        )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await repo.open()
        sweep_tasks: list[asyncio.Task[None]] = []

        async def sweep_expired_matches() -> None:
            while True:
                await asyncio.sleep(1)
                try:
                    advances = await repo.advance_expired_matches(standing_answers=standing)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # A transient database outage must not terminate the API lifespan.
                    logger.warning("match expiry sweep failed", exc_info=True)
                    advances = []
                for advance in advances:
                    if advance.match_id is not None:
                        # 넘긴 문항까지의 초안은 이제 쓸 데가 없다. 판이 닫혔으면 모두 버린다
                        standing.settle(
                            advance.code,
                            advance.match_id,
                            through_position=None if advance.finished else advance.position,
                        )
                    if advance.finished:
                        ops_log.match_finished(advance.code, via="sweep")
                    await hub.broadcast(advance.code, {"type": "match-invalidated"})
                    if advance.finished:
                        # 방이 다시 기다리는 방이 됐다. 판에서 빠진 멤버의 대기실이 다시 읽는다.
                        await announce_room(advance.code)

        async def sweep_expired_resources() -> None:
            while True:
                await asyncio.sleep(cleanup_interval_seconds)
                try:
                    cleaned = await repo.cleanup_expired_resources()
                    if isinstance(cleaned, CleanupCounts) and cleaned.changed:
                        # 어느 방이 바뀌었는지 모른다(방송도 하지 않는다). 모든 방의 번호를 올려
                        # 다음 준비 토글을 GET 없이 고치지 못하게 한다 — 화면이 다시 읽는다.
                        versions.bump_all()
                        ops_log.cleanup(cleaned)
                    await hub.revalidate(repo.is_member)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Cleanup is best-effort per tick; a transient outage is retried.
                    logger.warning("resource cleanup sweep failed", exc_info=True)

        async def sweep_presence() -> None:
            # 끊긴 사람이 있는 방은 **매번** 다시 본다. 끊긴 사람의 집합이 바뀔 때만 보면, 넘길
            # 사람이 없던 방에 나중에 들어온 사람이나 나가기 승계·30분 정리로 끊긴 사람이 방장이
            # 된 방을 놓친다. 끊긴 방장은 접속 중인 다음 참가자에게 넘기고, 멤버십이 끝난 사람의
            # 기록은 버린다. 무엇이 바뀌었으면 room-invalidated로 남은 화면이 다시 읽게 한다.
            # 막 끊긴 사람만 기다리던 문항은 마감 전에 넘기고 match-invalidated를 보낸다 (U32).
            while True:
                await asyncio.sleep(presence_interval_seconds)
                try:
                    changed = hub.sweep_presence()
                    absent_by_room = hub.absent_by_room()
                    transferred: frozenset[str] = frozenset()
                    forgotten: set[str] = set()
                    if absent_by_room:
                        try:
                            hosts = await repo.transfer_absent_hosts(absent_by_room)
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            # 다음 sweep이 같은 방들을 다시 본다.
                            logger.warning("absent host transfer failed", exc_info=True)
                        else:
                            transferred = hosts.transferred
                            for code in sorted(transferred):
                                ops_log.host_transferred(code, reason="host-absent")
                            forgotten = {
                                code
                                for code in absent_by_room
                                if hub.retain_presence(code, hosts.members.get(code))
                            }
                    for code in changed | transferred | forgotten:
                        advanced = False
                        absent = absent_by_room.get(code, frozenset())
                        if code in changed and absent:
                            try:
                                advanced = await repo.advance_past_absent_players(
                                    code,
                                    absent,
                                    standing_answers=standing,
                                )
                            except asyncio.CancelledError:
                                raise
                            except Exception:
                                # 놓쳐도 그 문항의 마감 sweep이 넘긴다.
                                logger.warning(
                                    "absent player match advance failed for room %s",
                                    code,
                                    exc_info=True,
                                )
                        await announce_room(code)
                        if advanced:
                            await hub.broadcast(code, {"type": "match-invalidated"})
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning("presence sweep failed", exc_info=True)

        async def summarize_operations() -> None:
            # 운영 요약 한 줄(기본 5분). 방·판 수는 집계 쿼리 하나로 읽고, 못 읽으면(DB가 안 될 때)
            # 그 칸만 null로 내고 다음 창에 다시 읽는다. 요청 수·지연은 그 창의 칸을 읽고 비운다.
            window_started = time.monotonic()
            while True:
                await asyncio.sleep(ops_summary_interval_seconds)
                try:
                    rooms = None
                    try:
                        rooms = await repo.ops_counts()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.warning("ops summary room counts failed", exc_info=True)
                    now = time.monotonic()
                    ops_log.summary(
                        window_seconds=now - window_started,
                        stats=request_window.take(),
                        sockets=hub.connection_count,
                        players=hub.live_member_count,
                        rooms=rooms,
                    )
                    window_started = now
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning("ops summary failed", exc_info=True)

        try:
            sweep_tasks = [
                asyncio.create_task(sweep_expired_matches()),
                asyncio.create_task(sweep_expired_resources()),
                asyncio.create_task(sweep_presence()),
                asyncio.create_task(summarize_operations()),
            ]
            ops_log.api_started(schema_version=RELEASE_SCHEMA_VERSION)
            yield
        finally:
            for sweep_task in sweep_tasks:
                sweep_task.cancel()
            for sweep_task in sweep_tasks:
                with suppress(asyncio.CancelledError):
                    await sweep_task
            try:
                await hub.close_all()
            finally:
                await repo.close()
                ops_log.api_stopped()

    app = FastAPI(
        title="quiz-by-quiz room API",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(active_settings.trusted_hosts))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(active_settings.cors_origins),
        allow_origin_regex=r"^http://(?:localhost|127\.0\.0\.1)(?::\d+)?$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Player-Id"],
        # Retry-After는 CORS가 기본으로 보여 주는 응답 헤더가 아니다. Pages(다른 origin)의
        # 브라우저가 요청 한도 거절에서 «언제 다시»를 읽으려면 드러내야 한다 (N01)
        expose_headers=["Retry-After"],
    )
    # 마지막에 달아 가장 바깥 user middleware가 된다 — TrustedHost·CORS가 거절한 요청도 세고,
    # 처리하지 못한 예외가 500이 되기 전에 경로 틀과 예외 클래스만 기록한다.
    app.add_middleware(ops_log.RequestMetricsMiddleware, window=request_window)

    async def require_actor(
        request: Request,
        identity: Identity = Depends(_identity),
    ) -> UUID:
        return await authenticate_actor(request, identity)

    async def authenticate_actor(request: Request, identity: Identity) -> UUID:
        client_key = _client_key(request)
        wait = authenticated_ingress_limiter.try_acquire(
            (
                # 한 사람의 몫 (N01). DB 인증 전이라 player id만으로 열쇠를 삼으면, 남의 id를 아는
                # 사람(방 snapshot에 실린다)이 틀린 토큰으로 그 사람의 몫을 비울 수 있다. 그래서
                # 토큰 해시까지 열쇠에 넣는다 — 위조 요청은 제 몫과 IP·프로세스 몫만 먹는다.
                RateLimitClaim(
                    key=(
                        f"authenticated:player:{identity.player_id}:"
                        f"{identity.token_hash.hex()}"
                    ),
                    limit=AUTHENTICATED_PLAYER_LIMIT,
                    window_seconds=AUTHENTICATED_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key=f"authenticated:client:{client_key}",
                    limit=AUTHENTICATED_CLIENT_LIMIT,
                    window_seconds=AUTHENTICATED_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key="authenticated:process",
                    limit=AUTHENTICATED_PROCESS_LIMIT,
                    window_seconds=AUTHENTICATED_WINDOW_SECONDS,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        if not await repo.authenticate(identity.player_id, identity.token_hash):
            raise _error(401, "unauthorized", "온라인 세션이 만료됐어요.")
        return identity.player_id

    @app.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def ready() -> dict[str, str]:
        if not await repo.health():
            raise _error(503, "database-unavailable", "데이터베이스에 연결할 수 없어요.")
        return {"status": "ready"}

    @app.get("/v1/release-readiness")
    async def release_readiness(request: Request) -> dict[str, str | int]:
        client_key = _client_key(request)
        wait = release_readiness_limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"release-readiness:client:{client_key}",
                    limit=12,
                    window_seconds=60,
                ),
                RateLimitClaim(
                    key="release-readiness:process",
                    limit=120,
                    window_seconds=60,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        version = await repo.schema_version()
        if version != RELEASE_SCHEMA_VERSION:
            raise _error(
                503,
                "migration-required",
                "데이터베이스 전환이 완료되지 않았어요.",
            )
        return {
            "status": "ready",
            "contract": "character-only-v1",
            "schemaVersion": version,
        }

    @app.put("/v1/session")
    async def put_session(
        request: Request,
        body: SessionBody,
        identity: Identity = Depends(_identity),
    ) -> dict[str, object]:
        client_key = _client_key(request)
        wait = ingress_limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"session:client:{client_key}",
                    limit=60,
                    window_seconds=60,
                ),
                RateLimitClaim(
                    key="session:process",
                    limit=300,
                    window_seconds=60,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("잠시 뒤 다시 시도해 주세요.", wait)
        try:
            player = validate_player(body.nickname, body.character_id)
        except DomainError as error:
            raise _error(400, error.code, str(error)) from error
        try:
            await repo.upsert_player(
                identity.player_id,
                identity.token_hash,
                player,
                update_profile=bool(body.model_fields_set),
            )
        except TokenConflict as error:
            raise _error(
                409,
                "identity-conflict",
                "이 브라우저 식별자를 다시 만들 필요가 있어요.",
            ) from error
        return {
            "playerId": str(identity.player_id),
            # 방 snapshot이 아직 없는 화면(홈·빈 로비·「게임 방법」)이 이 API의 규칙을 말할 수 있게
            # 함께 알린다. 이 필드가 없는 이전 API는 둘부터였고 직접 낸 답만 셌다.
            "minPlayers": MIN_MATCH_PLAYERS,
            "standingAnswers": True,
            # 끝난 온라인 판을 서버 랭킹에 남기고 GET /v1/rankings로 보인다 (FR-7.13 2단계).
            # 이 필드가 없는 이전 API면 화면은 온라인 랭킹을 숨긴다.
            "rankings": True,
            # 혼자 푸는 온라인 판 (FR-7.13 3단계): POST /v1/solo, 내 최고 기록
            # (GET /v1/rankings/mine)과 내 기록 내보내기(GET /v1/rankings/mine/records). 이
            # 필드가 없는 이전 API면 화면은 홈의 분야 칸으로 예전처럼 혼자 하기(로컬)를 연다.
            "soloPlay": True,
            # 혼자 판의 «제한 없음»(`questionTimeMs: null`, PRD 10.1 #9)과 다른 판을 골라 도는 판을
            # 끝내고 새로 열기(`restart: true`, #4). 더하기만 한 표시다 — 없으면 화면은 null도
            # restart도 보내지 않는다(«제한 없음»이면 20초, 다른 판이 돌면 그 판으로 돌아갈 줄을
            # 보인다)
            "soloUntimed": True,
            "soloRestart": True,
        }

    @app.get("/v1/rankings")
    async def list_rankings(
        request: Request,
        mode: str | None = None,
        category: str | None = None,
        period: str | None = None,
        authorization: Annotated[str | None, Header()] = None,
        player_id_header: Annotated[str | None, Header(alias="X-Player-Id")] = None,
    ) -> dict[str, object]:
        """온라인 랭킹 상위 10 (FR-7.13 2단계, PRD 12.1). 세션 없이도 읽는 공개 읽기다.

        신분(Authorization·X-Player-Id)을 실은 요청은 다른 인증 요청처럼 확인하고, 그 브라우저의
        기록에만 isMine을 단다 — player id와 토큰에서 나온 주인 열쇠(`ranking_owner_key`)가
        모두 같아야 한다. id는 로비에 보이고 지워진 players 줄의 id는 누구든 다시 등록할 수
        있어서다. 신분이 틀렸으면 401이다 — 화면은 세션을 다시 열고 한 번 더 묻는다.
        """
        client_key = _client_key(request)
        wait = ranking_limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"rankings:client:{client_key}",
                    limit=RANKING_CLIENT_LIMIT,
                    window_seconds=RANKING_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key="rankings:process",
                    limit=RANKING_PROCESS_LIMIT,
                    window_seconds=RANKING_WINDOW_SECONDS,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("랭킹은 잠시 뒤 다시 볼 수 있어요.", wait)
        if (
            mode not in RANKING_MODES
            or period not in RANKING_PERIODS
            or (mode == "category" and category not in ALLOWED_CATEGORIES)
            or (mode == "all" and category is not None)
        ):
            raise _error(400, "invalid-ranking", "랭킹 종류가 올바르지 않아요.")
        actor_id: UUID | None = None
        owner_key: bytes | None = None
        if authorization is not None or player_id_header is not None:
            identity = _identity(authorization=authorization, player_id_header=player_id_header)
            actor_id = await authenticate_actor(request, identity)
            owner_key = ranking_owner_key(identity.token_hash)
        board = category if mode == "category" and category is not None else "all"
        if board not in RANKING_BOARDS:  # pragma: no cover - guarded above
            raise _error(400, "invalid-ranking", "랭킹 종류가 올바르지 않아요.")
        view = await repo.list_rankings(
            board=board,
            period="week" if period == "week" else "all",
            actor_id=actor_id,
            owner_key=owner_key,
        )
        return _ranking_payload(
            view,
            mode=mode,
            category_id=category if mode == "category" else None,
        )

    def own_wait(
        request: Request,
        actor_id: UUID,
        *,
        prefix: str,
        actor_limit: int,
    ) -> None:
        """내 최고 기록·기록 내보내기의 몫 (FR-7.13 3단계). 인증 몫은 먼저 먹었다."""
        wait = ranking_limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"{prefix}:actor:{actor_id}",
                    limit=actor_limit,
                    window_seconds=OWN_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key=f"{prefix}:client:{_client_key(request)}",
                    limit=OWN_CLIENT_LIMIT,
                    window_seconds=OWN_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key=f"{prefix}:process",
                    limit=OWN_PROCESS_LIMIT,
                    window_seconds=OWN_WINDOW_SECONDS,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("기록은 잠시 뒤 다시 볼 수 있어요.", wait)

    @app.get("/v1/rankings/mine")
    async def own_best_scores(
        request: Request,
        identity: Identity = Depends(_identity),
        exclude_match: str | None = Query(default=None, alias="excludeMatch"),
    ) -> dict[str, object]:
        """내 판마다 최고 기록 (FR-7.13 3단계 — 홈의 별 점수 FR-2.3, 결과의 최고 기록 비교 FR-5.7).

        인증된 신분의 기록만 센다 — player id와 그 토큰에서 나온 주인 열쇠가 모두 같아야 한다
        (`ranking_owner_key`, GET /v1/rankings의 isMine과 같다). 응답에는 신분이 없다. 결과 화면은
        방금 닫힌 판을 빼고(`excludeMatch`) «이 판 전의 최고 기록»과 견준다.
        """
        actor_id = await authenticate_actor(request, identity)
        own_wait(request, actor_id, prefix="rankings-mine", actor_limit=OWN_BEST_ACTOR_LIMIT)
        excluded: UUID | None = None
        if exclude_match is not None:
            try:
                excluded = UUID(exclude_match)
            except ValueError as error:
                raise _error(400, "invalid-match", "판 식별자가 올바르지 않아요.") from error
        best = await repo.own_best_scores(
            actor_id=actor_id,
            owner_key=ranking_owner_key(identity.token_hash),
            exclude_match_id=excluded,
        )
        return {"boards": {board: _own_best_payload(best.get(board)) for board in RANKING_BOARDS}}

    @app.get("/v1/rankings/mine/records")
    async def own_records(
        request: Request,
        identity: Identity = Depends(_identity),
    ) -> dict[str, object]:
        """내 온라인 기록 (서버 기록의 기록 내보내기 N02, FR-7.13 2단계). 최근 것부터 한도까지."""
        actor_id = await authenticate_actor(request, identity)
        own_wait(request, actor_id, prefix="rankings-records", actor_limit=OWN_RECORDS_ACTOR_LIMIT)
        view = await repo.own_records(
            actor_id=actor_id,
            owner_key=ranking_owner_key(identity.token_hash),
        )
        return {
            "records": [_own_record_payload(record) for record in view.records],
            "limit": OWN_RECORDS_LIMIT,
            "truncated": view.truncated,
        }

    @app.post("/v1/solo", status_code=201)
    async def start_solo(
        request: Request,
        body: SoloBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        """혼자 푸는 온라인 판을 곧바로 연다 (FR-7.13 3단계). 대기실을 거치지 않는다.

        그 사람의 혼자 방(남의 목록에 없고 남이 들어오지 못한다)을 다시 쓰거나 만들고 판을 연다.
        혼자 방에 판이 이미 돌고 있으면 새 판을 열지 않고 그 방을 `resumed`로 돌려준다 — 화면은 그
        판을 이어 그린다. `restart`면 도는 판이 다른 판(분야·전체 도전)일 때 그 판을 기록 없이
        끝내고 같은 transaction에서 이 판을 연다(PRD 10.1 #11) — 응답의 `ended`가 끝낸 판이다. 판의
        출제·채점·마감·기록(FR-7.13 2단계)은 친구와 푸는 방과 같다. 문항 시간 null(«제한 없음»,
        #2)은 마감이 없다.
        """
        wait = ingress_limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"solo:actor:{actor_id}",
                    limit=SOLO_ACTOR_LIMIT,
                    window_seconds=SOLO_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key=f"solo:client:{_client_key(request)}",
                    limit=SOLO_CLIENT_LIMIT,
                    window_seconds=SOLO_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key="solo:process",
                    limit=SOLO_PROCESS_LIMIT,
                    window_seconds=SOLO_WINDOW_SECONDS,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("판은 잠시 뒤 다시 열 수 있어요.", wait)
        try:
            spec = validate_solo_room(
                category_id=body.category_id,
                question_time_ms=body.question_time_ms,
            )
        except DomainError as error:
            raise _error(400, error.code, str(error)) from error
        client_key = _client_key(request)

        def may_create() -> float | None:
            # 새 혼자 방을 만들 때만 먹는다 — 다시 쓰는 판은 이 몫과 무관하다
            return ingress_limiter.try_acquire(
                (
                    RateLimitClaim(
                        key=f"solo-create:client:{client_key}",
                        limit=SOLO_CREATE_CLIENT_LIMIT,
                        window_seconds=SOLO_CREATE_WINDOW_SECONDS,
                    ),
                    RateLimitClaim(
                        key="solo-create:process",
                        limit=SOLO_CREATE_PROCESS_LIMIT,
                        window_seconds=SOLO_CREATE_WINDOW_SECONDS,
                    ),
                )
            )

        # 번호는 DB를 읽기 전에 읽는다 — 이 번호까지 알린 변화는 이미 commit됐다
        label = versions.label()
        try:
            started = await repo.start_solo(
                actor_id, spec, may_create=may_create, restart=body.restart
            )
        except NotMember as error:
            raise _error(401, "unauthorized", "온라인 세션이 만료됐어요.") from error
        except MatchInProgress as error:
            raise _error(409, "game-in-progress", "이미 진행 중인 게임이 있어요.") from error
        except SoloRoomsFull as error:
            # 혼자 방이 동시 한도까지 찼다. 5xx라 화면은 결정 #1처럼 연습(기록 안 남음)을 연다
            raise _error(
                503,
                "solo-busy",
                "지금은 혼자 판 자리가 모두 찼어요. 잠시 뒤 다시 시도해 주세요.",
            ) from error
        except SoloCreateLimited as error:
            raise _rate_limited("판은 잠시 뒤 다시 열 수 있어요.", error.retry_after) from error
        room = started.room
        if started.ended is not None:
            # 다른 판을 골라 도는 판을 끝냈다. 그 판의 발밑 칸 초안은 쓸 데가 없다(마감 없는 판에는
            # 애초에 없다). 끝까지 풀지 않은 판은 기록 없이 끝났고, 마지막 공개만 남았던 판은 닫혀
            # 기록됐다
            ended = started.ended
            standing.settle(room.code, ended.match_id, through_position=None)
            log_solo_end(room.code, ended, via="restart")
        if started.match is not None:
            # 판 시작은 준비를 되돌린다 — 번호를 올려 둔다(«게임 시작»과 같다). 혼자 방에는 그
            # 사람뿐이라 방송할 상대가 없지만 다른 탭의 소켓이 있으면 판을 연다
            versions.bump(room.code)
            ops_log.solo_started(
                room.code,
                created=started.created,
                category_id=started.match.category_id,
                question_time_ms=started.match.question_time_ms,
                questions=started.match.total_questions,
            )
            await hub.broadcast(
                room.code, {"type": "game-started", **_match_start_payload(started.match)}
            )
        payload: dict[str, object] = {
            "room": room_payload(room, label),
            "match": None if started.match is None else _match_start_payload(started.match),
            "resumed": started.resumed,
        }
        if started.ended is not None:
            payload["ended"] = _ended_solo_payload(started.ended)
        return payload

    def log_solo_end(code: str, ended: EndedSoloMatch, *, via: str) -> None:
        # 혼자 판 하나는 solo_started 한 줄로 시작해 match_finished(닫혀 기록됨)나
        # solo_abandoned(기록 없이 끝남) 한 줄로 끝난다 — 마감 없는 판을 30분 정리가 끝내면
        # cleanup의 soloMatchesAbandoned다
        if ended.recorded:
            ops_log.match_finished(code, via=via)
        else:
            ops_log.solo_abandoned(
                code,
                via=via,
                position=ended.position,
                questions=ended.total_questions,
            )

    @app.delete("/v1/solo")
    async def end_solo(
        request: Request,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        """혼자 판을 그만둔다: 도는 판을 기록 없이 끝내고 혼자 방을 지운다 (PRD 10.1 #11의 끝내기).

        혼자 방이 없으면 아무것도 하지 않는다(`ended: null`, `left: false`). 몫은 혼자 판 열기와
        같은 칸을 먹는다. 화면은 쓰지 않고(«홈으로»는 끝난 판의 방을 나간다) 배포 점검이 제가 연
        판을 치운다(`deploy/oracle/smoke.py candidate`).
        """
        wait = ingress_limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"solo:actor:{actor_id}",
                    limit=SOLO_ACTOR_LIMIT,
                    window_seconds=SOLO_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key=f"solo:client:{_client_key(request)}",
                    limit=SOLO_CLIENT_LIMIT,
                    window_seconds=SOLO_WINDOW_SECONDS,
                ),
                RateLimitClaim(
                    key="solo:process",
                    limit=SOLO_PROCESS_LIMIT,
                    window_seconds=SOLO_WINDOW_SECONDS,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("잠시 뒤 다시 시도해 주세요.", wait)
        result = await repo.end_solo(actor_id)
        code = result.code
        if code is None:
            return {"ended": None, "left": False}
        if result.ended is not None:
            log_solo_end(code, result.ended, via="left")
            await hub.broadcast(
                code, {"type": "match-invalidated", "matchId": str(result.ended.match_id)}
            )
        # 마지막(유일한) 사람이 나가 방이 사라졌다 — 나가기와 같이 정리한다
        ops_log.member_left(code, players=0)
        ops_log.room_deleted(code, reason="empty")
        await hub.disconnect_actor(code, actor_id)
        hub.forget_presence(code, actor_id)
        versions.bump(code)
        hub.retain_presence(code, None)
        removed.forget_room(code)
        standing.forget_room(code)
        return {
            "ended": None if result.ended is None else _ended_solo_payload(result.ended),
            "left": True,
        }

    @app.get("/v1/rooms")
    async def list_rooms(
        actor_id: UUID = Depends(require_actor),
    ) -> list[dict[str, object]]:
        return [room_payload(room) for room in await repo.list_rooms(actor_id)]

    @app.post("/v1/rooms", status_code=201)
    async def create_room(
        request: Request,
        body: CreateRoomBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        client_key = _client_key(request)
        wait = ingress_limiter.try_acquire(
            (
                RateLimitClaim(
                    key=f"room-create:actor:{actor_id}",
                    limit=10,
                    window_seconds=3_600,
                ),
                RateLimitClaim(
                    key=f"room-create:client:{client_key}",
                    limit=30,
                    window_seconds=3_600,
                ),
                RateLimitClaim(
                    key="room-create:process",
                    limit=100,
                    window_seconds=3_600,
                ),
            )
        )
        if wait is not None:
            raise _rate_limited("방은 잠시 뒤 다시 만들 수 있어요.", wait)
        try:
            spec = validate_room(
                name=body.name,
                category_id=body.category_id,
                capacity=body.capacity,
                is_public=body.is_public,
                password=body.password,
                game_mode=body.game_mode,
                question_time_ms=body.question_time_ms,
            )
        except DomainError as error:
            raise _error(400, error.code, str(error)) from error

        password_hash = None
        if spec.password is not None:
            try:
                password_hash = await password_work.hash(spec.password)
            except PasswordWorkBusy as error:
                raise _error(
                    429,
                    "rate-limited",
                    "비밀번호 작업이 많아요. 잠시 뒤 다시 시도해 주세요.",
                    headers={"Retry-After": "1"},
                ) from error
        label = versions.label()
        room = await repo.create_room(actor_id, spec, password_hash)
        ops_log.room_created(
            room.code,
            capacity=room.capacity,
            category_id=room.category_id,
            question_time_ms=room.question_time_ms,
            locked=room.has_password,
        )
        return room_payload(room, label)

    @app.get("/v1/rooms/{raw_code}")
    async def get_room(
        raw_code: str,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        # 번호는 DB를 읽기 전에 읽는다 — 이 번호까지 알린 변화는 이미 commit됐다
        label = versions.label()
        room = await repo.get_room(actor_id, code)
        if room is None:
            removal = removed.reason(code, actor_id)
            if removal is not None:
                # 방장이 나를 내보냈다. «없는 방»으로 돌려보내면 방이 사라진 줄 안다 (U24)
                raise _removed_error(404, removal)
            raise _error(404, "not-found", "그런 코드의 방이 없어요.")
        return room_payload(room, label)

    @app.post("/v1/rooms/{raw_code}/join")
    async def join_room(
        raw_code: str,
        request: Request,
        body: JoinRoomBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        wait = actor_room_wait(
            join_limiter,
            prefix="join",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=12,
            actor_window_seconds=60,
            process_limit=300,
        )
        if wait is not None:
            raise _rate_limited("참가 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        if removed.is_blocked(code, actor_id):
            # 접속 중에 방장이 내보낸 사람이다. KICK_BLOCK_SECONDS 동안 같은 방에 들이지 않는다.
            # 비밀번호를 견주기 전에 거절한다 — 막힌 사람에게 비밀번호 확인을 내주지 않는다.
            raise _removed_error(403, "kicked")

        already_joined = await repo.is_member(actor_id, code)
        if not already_joined:
            access = await repo.get_access(code)
            # 혼자 푸는 온라인 판의 방(FR-7.13 3단계)은 그 사람 말고는 들어오지 못한다.
            # «가득 찼다»가 아니라 «없는 방»으로 답한다 — 남의 혼자 방이 있다는 것도 알리지 않는다
            if access is None or access.solo:
                raise _error(404, "not-found", "그런 코드의 방이 없어요.")
            if not access.is_public:
                client_key = _client_key(request)
                wait = ingress_limiter.try_acquire(
                    (
                        RateLimitClaim(
                            key=f"password-join:client-room:{client_key}:{code}",
                            limit=10,
                            window_seconds=60,
                        ),
                        RateLimitClaim(
                            key="password-join:process",
                            limit=120,
                            window_seconds=60,
                        ),
                    )
                )
                if wait is not None:
                    raise _rate_limited(
                        "참가 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.",
                        wait,
                    )
                if not body.password:
                    raise _error(403, "need-password", "비밀번호가 필요한 방이에요.")
                if not access.password_hash:
                    raise _error(403, "wrong-password", "비밀번호가 맞지 않아요.")
                try:
                    verified = await password_work.verify(
                        access.password_hash,
                        body.password,
                    )
                except PasswordWorkBusy as error:
                    raise _error(
                        429,
                        "rate-limited",
                        "비밀번호 작업이 많아요. 잠시 뒤 다시 시도해 주세요.",
                        headers={"Retry-After": "1"},
                    ) from error
                except (VerifyMismatchError, VerificationError, InvalidHashError):
                    verified = False
                if not verified:
                    raise _error(403, "wrong-password", "비밀번호가 맞지 않아요.")

        label = versions.label()
        try:
            room = await repo.join_room(actor_id, code)
        except RoomNotFound as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        except RoomFull as error:
            raise _error(409, "full", "방이 이미 가득 찼어요.") from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중인 게임에는 새로 참가할 수 없어요.",
            ) from error

        if not already_joined:
            ops_log.member_joined(code, players=len(room.players))
            # 새 멤버십은 새 유예로 센다. 예전 멤버십의 끊김 기록이 남아 있으면 들어오자마자
            # 끊긴 사람이 되어 시작 판정과 판에서 빠진다.
            hub.forget_presence(code, actor_id)
            # 내보내졌던 사람이 다시 들어왔다. 다음에 나가도 «내보냈다»로 듣지 않는다.
            removed.forget(code, actor_id)
        await announce_room(code)
        return room_payload(room, label)

    @app.delete("/v1/rooms/{raw_code}/members/me", status_code=204)
    async def leave_room(
        raw_code: str,
        request: Request,
        actor_id: UUID = Depends(require_actor),
    ) -> Response:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        wait = actor_room_wait(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        )
        if wait is not None:
            raise _rate_limited("방 변경 요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        try:
            room = await repo.leave_room(
                actor_id,
                code,
                absent_player_ids=hub.absent_actors(code),
            )
        except (RoomNotFound, NotMember) as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중인 게임에서는 방을 나갈 수 없어요.",
            ) from error
        ops_log.member_left(code, players=0 if room is None else len(room.players))
        if room is None:
            ops_log.room_deleted(code, reason="empty")
        elif room.host_transferred:
            ops_log.host_transferred(code, reason="host-left")
        await hub.disconnect_actor(code, actor_id)
        hub.forget_presence(code, actor_id)
        standing.forget_member(code, actor_id)
        if room is None:
            # 마지막 사람이 나가 방이 사라졌다. 같은 코드에 남은 기록도 버린다. 번호는 올려 둔다 —
            # 같은 코드로 새 방이 생겨도 이 방의 번호를 이어 믿지 않는다.
            versions.bump(code)
            hub.retain_presence(code, None)
            removed.forget_room(code)
            standing.forget_room(code)
        else:
            await announce_room(code)
        return Response(status_code=204)

    @app.delete("/v1/rooms/{raw_code}/members/{raw_player_id}")
    async def remove_member(
        raw_code: str,
        raw_player_id: str,
        request: Request,
        connected: bool = False,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        """방장의 «내보내기» (U24). 방장만, 남만, 도는 판의 참가자는 판이 끝난 뒤에 뺀다.

        `connected` 는 방장이 확인창에서 본 그 사람의 상태다.

        - 없거나 false: 탭을 닫고 떠난 자리를 비운다. 유예를 넘겨 끊긴 사람만 빼고(그 사이 다시
          붙었으면 `member-connected`), 돌아오면 다시 참가할 수 있다. 구버전 화면도 이 길이다
        - true: 접속 중인 사람을 내보낸다. «잠시 다시 들어올 수 없어요»를 보고 확인한 것이므로
          KICK_BLOCK_SECONDS 동안 같은 방 참가를 거절한다(`kicked`)

        같은 모양의 `members/me`(나가기)가 먼저 등록돼 그 경로를 가져간다.
        """
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        try:
            player_id = UUID(raw_player_id)
        except ValueError as error:
            raise _error(404, "not-member", "그 참가자는 이 방에 없어요.") from error
        wait = actor_room_wait(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        )
        if wait is not None:
            raise _rate_limited("방 변경 요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        if player_id == actor_id:
            raise _error(400, "invalid-target", "방을 떠나려면 나가기를 눌러 주세요.")
        label = versions.label()
        try:
            room = await repo.remove_member(
                actor_id,
                code,
                player_id,
                absent_player_ids=hub.absent_actors(code),
                allow_connected=connected,
            )
        except RoomNotFound as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        except NotHost as error:
            raise _error(403, "not-host", "방장만 참가자를 내보낼 수 있어요.") from error
        except NotMember as error:
            raise _error(404, "not-member", "그 참가자는 이 방에 없어요.") from error
        except MemberConnected as error:
            # 끊긴 자리를 비우려던 사이 그 사람이 다시 붙었다. 막히는 내보내기는 방장이 그
            # 말을 보고 다시 골라야 한다 — 확인창이 말하지 않은 차단을 걸지 않는다.
            raise _error(
                409,
                "member-connected",
                "그 참가자가 다시 연결됐어요. 확인한 뒤 다시 내보내 주세요.",
            ) from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중인 판의 참가자는 판이 끝난 뒤에 내보낼 수 있어요.",
            ) from error
        ops_log.member_removed(code, players=len(room.players), blocked=connected)
        # 소켓을 닫기 전에 기록한다. 닫힌 화면이 다시 붙으려다 같은 이유를 듣는다.
        removed.mark(code, player_id, blocked=connected)
        reason: RemovalReason = "kicked" if connected else "removed"
        # 열린 화면에는 먼저 이유를 알려 곧바로 로비로 돌려보낸다. 이 이벤트를 모르는 구버전
        # 화면도 소켓이 닫히면 다시 붙으려다 ws-ticket 에서 같은 이유를 듣는다.
        await hub.send_actor(code, player_id, {"type": "removed", "reason": reason})
        await hub.disconnect_actor(code, player_id)
        hub.forget_presence(code, player_id)
        standing.forget_member(code, player_id)
        await announce_room(code)
        return room_payload(room, label)

    @app.patch("/v1/rooms/{raw_code}")
    async def update_room(
        raw_code: str,
        request: Request,
        body: UpdateRoomBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        wait = actor_room_wait(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        )
        if wait is not None:
            raise _rate_limited("방 변경 요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)

        patch = body.model_dump(exclude_unset=True)
        if "game_mode" in patch:
            # 구버전 client의 true/false는 모두 호환 입력일 뿐이다. 어떤 값이 와도
            # 캐릭터 전용 설정은 바뀌지 않으며 DB mutation에도 전달하지 않는다.
            patch.pop("game_mode")
        if "category_id" in patch:
            category = patch["category_id"]
            if category is not None and category not in ALLOWED_CATEGORIES:
                raise _error(400, "invalid-category", "지원하지 않는 게임 형식이에요.")
        if "capacity" in patch and patch["capacity"] not in ALLOWED_CAPACITIES:
            raise _error(400, "invalid-capacity", "지원하지 않는 최대 인원이에요.")
        if "question_time_ms" in patch:
            # 20초·40초 둘뿐이다. 방장만, 판이 돌지 않을 때만 바뀐다(저장소가 판정한다)
            try:
                validate_question_time(patch["question_time_ms"])
            except DomainError as error:
                raise _error(400, error.code, str(error)) from error

        label = versions.label()
        try:
            room = await repo.update_room(actor_id, code, patch)
        except RoomNotFound as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        except NotHost as error:
            raise _error(403, "not-host", "방장만 설정을 바꿀 수 있어요.") from error
        except RoomFull as error:
            raise _error(409, "full", "현재 인원보다 작은 정원으로 바꿀 수 없어요.") from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중에는 방 설정을 바꿀 수 없어요.",
            ) from error
        await announce_room(code)
        return room_payload(room, label)

    @app.put("/v1/rooms/{raw_code}/ready")
    async def set_ready(
        raw_code: str,
        request: Request,
        body: ReadyBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        wait = actor_room_wait(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        )
        if wait is not None:
            raise _rate_limited("방 변경 요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        # 준비를 바꾸는 쓰기는 방마다 하나씩 commit하고 그 차례대로 번호를 받는다
        # (room_versions.py). 그래야 «바로 앞 번호 + 이 사람의 준비»로 고친 화면이 늦게
        # commit된 값을 덮어쓰지 않는다.
        async with versions.writing(code):
            label = versions.label()
            try:
                room = await repo.set_ready(actor_id, code, body.is_ready)
            except (RoomNotFound, NotMember) as error:
                raise _error(403, "not-member", "먼저 방에 참가해 주세요.") from error
            except MatchInProgress as error:
                raise _error(
                    409,
                    "game-in-progress",
                    "진행 중에는 준비 상태를 바꿀 수 없어요.",
                ) from error
            version, previous = versions.bump(code)
        # 가장 잦은 방 변화라 고칠 거리를 함께 싣는다. 받은 화면의 방이 정확히
        # `previousVersion` 뒤의 것이면 GET 없이 이 사람의 준비만 고친다. 접속 상태 변화가
        # 아직 방송되지 않았으면 싣지 않는다 — 그 방의 `connected`가 이미 달라져 있어 모두
        # 다시 읽어야 한다.
        ready_change: dict[str, object] | None = None
        if hub.presence_settled(code):
            ready_change = {
                "previousVersion": previous,
                "playerId": str(actor_id),
                "isReady": body.is_ready,
            }
        await hub.broadcast(code, room_invalidated(version, ready_change=ready_change))
        return room_payload(room, label)

    @app.post("/v1/rooms/{raw_code}/chat", status_code=202)
    async def send_chat(
        raw_code: str,
        request: Request,
        body: ChatBody,
        actor_id: UUID = Depends(require_actor),
    ) -> Response:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(400, error.code, str(error)) from error
        wait = actor_room_wait(
            chat_limiter,
            prefix="chat",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=12,
            actor_window_seconds=60,
            process_limit=600,
        )
        if wait is not None:
            raise _rate_limited("채팅은 잠시 뒤 다시 보낼 수 있어요.", wait)
        try:
            text = validate_chat(body.text)
            player = await repo.send_chat(actor_id, code, text)
        except DomainError as error:
            raise _error(400, error.code, str(error)) from error
        except (RoomNotFound, NotMember) as error:
            raise _error(403, "not-member", "먼저 방에 참가해 주세요.") from error
        await hub.broadcast(
            code,
            {
                "type": "chat",
                "playerId": str(player.id),
                "nickname": player.nickname,
                "text": text,
            },
        )
        return Response(status_code=202)

    @app.post("/v1/rooms/{raw_code}/start", status_code=201)
    async def start_game(
        raw_code: str,
        request: Request,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        wait = actor_room_wait(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        )
        if wait is not None:
            raise _rate_limited("방 변경 요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        # 판 시작은 모두의 준비를 되돌리고 방을 «게임 중»으로 바꾼다. room-invalidated 대신
        # game-started만 보내지만 번호는 올린다 — 다음 준비 토글을 시작 전의 방에 덧대어
        # 고치지 못하게 한다. 준비 쓰기와 같은 차례에 선다(room_versions.py).
        async with versions.writing(code):
            try:
                match = await repo.start_game(
                    actor_id,
                    code,
                    absent_player_ids=hub.absent_actors(code),
                )
            except RoomNotFound as error:
                raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
            except NotHost as error:
                raise _error(403, "not-host", "방장만 게임을 시작할 수 있어요.") from error
            except MatchNotReady as error:
                raise _error(
                    409,
                    "not-ready",
                    "방장 말고 연결된 참가자가 모두 준비해야 시작할 수 있어요.",
                ) from error
            except MatchInProgress as error:
                raise _error(409, "game-in-progress", "이미 진행 중인 게임이 있어요.") from error
            versions.bump(code)
        ops_log.match_started(
            code,
            players=match.player_count,
            category_id=match.category_id,
            question_time_ms=match.question_time_ms,
            questions=match.total_questions,
        )
        payload = _match_start_payload(match)
        await hub.broadcast(code, {"type": "game-started", **payload})
        return payload

    @app.get("/v1/rooms/{raw_code}/match")
    async def get_match(
        raw_code: str,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        match_read = await repo.get_match(
            actor_id,
            code,
            absent_player_ids=match_absent_ids(code, actor_id),
            standing_answers=standing,
        )
        match = match_read.match
        if match is None:
            raise _error(404, "no-active-match", "진행하거나 방금 끝난 게임이 없어요.")
        standing.settle_view(code, match)
        payload = _match_payload(match)
        if match_read.advanced:
            if match.state == "finished":
                ops_log.match_finished(code, via="request")
            await hub.broadcast(code, {"type": "match-invalidated", "matchId": str(match.id)})
            if match.state == "finished":
                # 이 읽기가 판을 닫았다. 방의 status가 바뀌었으니 대기실도 다시 읽게 한다.
                await announce_room(code)
        return payload

    @app.post("/v1/rooms/{raw_code}/match/answers")
    async def submit_answer(
        raw_code: str,
        request: Request,
        body: AnswerBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        wait = actor_room_wait(
            answer_limiter,
            prefix="answer",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=8,
            actor_window_seconds=30,
            process_limit=600,
        )
        if wait is not None:
            raise _rate_limited("답안 제출이 너무 빨라요. 잠시 뒤 다시 시도해 주세요.", wait)
        try:
            submission = await repo.submit_answer(
                actor_id,
                code,
                position=body.position,
                choice_index=body.choice_index,
                absent_player_ids=match_absent_ids(code, actor_id),
                standing_answers=standing,
            )
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        except MatchNotFound as error:
            raise _error(404, "no-active-match", "진행 중인 게임이 없어요.") from error
        except MatchPositionMismatch as error:
            raise _error(409, "stale-question", "이미 다음 문제로 넘어갔어요.") from error
        except NotMember as error:
            raise _error(403, "not-member", "먼저 방에 참가해 주세요.") from error
        standing.settle_view(code, submission.match)
        if submission.advanced:
            # 이 답으로 모두 답해 공개로 넘어갔다. 방 전체가 다시 읽는다.
            await hub.broadcast(
                code,
                {"type": "match-invalidated", "matchId": str(submission.match.id)},
            )
        # 넘어가지 않은 답은 방송하지 않는다 (N01). running snapshot에서 남이 보는 것은
        # 하나도 바뀌지 않는다 — 점수는 공개 전까지 비어 있고(`scores: []`), 제출 표시
        # (`ownSubmission`)는 묻는 사람 자신의 것뿐이다. 그래서 답 하나마다 방 전원이 같은
        # snapshot을 다시 읽어 같은 IP의 몫을 N²로 먹던 방송이었다. 낸 사람은 아래 응답의
        # snapshot을 그대로 그리고, 응답을 받지 못했으면 한 번 다시 읽는다(화면 쪽, N01 리뷰).
        # 같은 사람의 다른 탭은 공개에서 «내 답»으로 안다.
        return {
            "match": _match_payload(submission.match),
            "accepted": True,
            "advanced": submission.advanced,
        }

    @app.post("/v1/rooms/{raw_code}/ws-ticket", status_code=201)
    async def websocket_ticket(
        raw_code: str,
        request: Request,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, str]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없어요.") from error
        wait = actor_room_wait(
            ticket_limiter,
            prefix="ticket",
            actor_id=actor_id,
            code=code,
            client_key=_client_key(request),
            actor_limit=6,
            actor_window_seconds=60,
            process_limit=300,
        )
        if wait is not None:
            raise _rate_limited("연결 준비 요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.", wait)
        if not await repo.is_member(actor_id, code):
            removal = removed.reason(code, actor_id)
            if removal is not None:
                # 내보내진 화면이 다시 붙으려 한다. 같은 말로 알려 재시도를 멈추게 한다 (U24)
                raise _removed_error(403, removal)
            raise _error(403, "not-member", "먼저 방에 참가해 주세요.")
        return {
            "ticket": ticket_store.issue(actor_id, code),
            "movementViewport": MOVEMENT_VIEWPORT_CAPABILITY,
            "movementSeat": WAITING_ROOM_SEAT_CAPABILITY,
            "movementStage": MOVEMENT_STAGE_CAPABILITY,
            "standingAnswer": STANDING_ANSWER_CAPABILITY,
        }

    @app.websocket("/v1/rooms/{raw_code}/events")
    async def room_events(
        websocket: WebSocket,
        raw_code: str,
    ) -> None:
        try:
            code = normalize_code(raw_code)
        except DomainError:
            await websocket.close(code=4404)
            return
        ticket = _websocket_ticket(websocket)
        actor_id = ticket_store.consume(ticket, code) if ticket is not None else None
        if actor_id is None:
            await websocket.close(code=4403)
            return
        if not hub.reserve(code, actor_id, websocket):
            await websocket.close(code=4429)
            return
        try:
            if not await repo.is_member(actor_id, code):
                await websocket.close(code=4403)
                return
            if not hub.is_connected(websocket):
                return
            await websocket.accept(subprotocol=WEBSOCKET_PROTOCOL)
            if not hub.activate(code, actor_id, websocket):
                await websocket.close(code=1012)
                return
            touch_gate = MinimumIntervalGate(interval_seconds=15)
            if touch_gate.allow():
                await repo.touch_member(actor_id, code)
            while True:
                message = await websocket.receive_text()
                if not websocket_inbound_limiter.allow(
                    (
                        RateLimitClaim(
                            key=f"websocket-inbound:burst:{actor_id}:{code}",
                            limit=30,
                            window_seconds=1,
                        ),
                        RateLimitClaim(
                            key=f"websocket-inbound:sustained:{actor_id}:{code}",
                            limit=1_200,
                            window_seconds=60,
                        ),
                        RateLimitClaim(
                            key="websocket-inbound",
                            limit=15_000,
                            window_seconds=60,
                        ),
                    )
                ):
                    await websocket.close(code=4429)
                    return
                if touch_gate.allow():
                    await repo.touch_member(actor_id, code)
                standing_answer = _standing_answer_message(message)
                if standing_answer is not None:
                    # 방송하지 않는다 — 남의 발밑 칸은 아직 고르는 사람에게 보이지 않는다(PRD 2.1).
                    # 메모리에 두기만 하고 마감이 빈 답을 채울 때 잠근 판에서 다시 본다.
                    draft_match_id, draft_position, draft_choice = standing_answer
                    if draft_choice is None:
                        standing.clear(code, actor_id)
                    else:
                        standing.record(
                            code,
                            actor_id,
                            match_id=draft_match_id,
                            position=draft_position,
                            choice_index=draft_choice,
                        )
                    continue
                movement = _movement_message(message)
                if movement is None:
                    continue
                await hub.broadcast(
                    code,
                    _movement_event(movement, actor_id, next(movement_sequences)),
                )
        except (RuntimeError, WebSocketDisconnect):
            pass
        finally:
            hub.disconnect(code, websocket)

    return app
