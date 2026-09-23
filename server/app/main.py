from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
from collections import defaultdict
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from itertools import count
from typing import Annotated, Any
from uuid import UUID

from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings, is_public_pages_question_bank
from .domain import (
    ALLOWED_CAPACITIES,
    ALLOWED_CATEGORIES,
    DomainError,
    normalize_code,
    validate_chat,
    validate_player,
    validate_room,
)
from .password_work import BoundedPasswordWork, PasswordWorkBusy
from .question_catalog import CatalogError, QuestionCatalog
from .rate_limit import (
    AtomicMultiWindowLimiter,
    MinimumIntervalGate,
    RateLimitClaim,
)
from .repository import (
    MatchAnswerView,
    MatchInProgress,
    MatchNotFound,
    MatchNotReady,
    MatchPositionMismatch,
    MatchSetup,
    MatchView,
    NotHost,
    NotMember,
    PlayerView,
    RoomFull,
    RoomNotFound,
    RoomsRepository,
    RoomView,
    TokenConflict,
)
from .tickets import WebSocketTickets

logger = logging.getLogger(__name__)
WEBSOCKET_PROTOCOL = "qbb.v1"
WEBSOCKET_TICKET_PREFIX = "qbb.ticket."


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


def _movement_message(message: str) -> tuple[float, float, bool] | None:
    """Return one strict, bounded movement payload without trusting client identity."""
    if len(message) > 256:
        return None
    try:
        value = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(value, dict) or set(value) != {"type", "x", "y", "moving"}:
        return None
    if value["type"] != "movement" or type(value["moving"]) is not bool:
        return None
    x = value["x"]
    y = value["y"]
    if (
        isinstance(x, bool)
        or not isinstance(x, (int, float))
        or isinstance(y, bool)
        or not isinstance(y, (int, float))
    ):
        return None
    x = float(x)
    y = float(y)
    if not math.isfinite(x) or not math.isfinite(y) or not 0 <= x <= 1 or not 0 <= y <= 1:
        return None
    return x, y, value["moving"]


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
    is_public: StrictBool = Field(alias="isPublic")
    password: str | None = None


class JoinRoomBody(StrictBody):
    password: str | None = None


class UpdateRoomBody(StrictBody):
    category_id: str | None = Field(default=None, alias="categoryId")
    capacity: StrictInt | None = None
    game_mode: StrictBool | None = Field(default=None, alias="gameMode")


class ChatBody(StrictBody):
    text: str


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
    ) -> None:
        if min(max_actor_room, max_room, max_total) < 1:
            raise ValueError("event hub limits must be positive")
        if send_timeout_seconds <= 0:
            raise ValueError("event hub send timeout must be positive")
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
        self._rooms[code].add(websocket)
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
        if sockets is not None:
            sockets.discard(websocket)
            if not sockets:
                self._rooms.pop(connected_code, None)
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

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    def is_connected(self, websocket: WebSocket) -> bool:
        return websocket in self._connections


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


def _identity(
    authorization: Annotated[str | None, Header()] = None,
    player_id_header: Annotated[str | None, Header(alias="X-Player-Id")] = None,
) -> Identity:
    if not authorization or not player_id_header:
        raise _error(401, "unauthorized", "온라인 세션이 필요합니다.")

    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not 32 <= len(token) <= 256:
        raise _error(401, "unauthorized", "온라인 세션이 올바르지 않습니다.")
    if not token.isascii() or any(character.isspace() for character in token):
        raise _error(401, "unauthorized", "온라인 세션이 올바르지 않습니다.")

    try:
        player_id = UUID(player_id_header)
    except ValueError as error:
        raise _error(401, "unauthorized", "온라인 세션이 올바르지 않습니다.") from error

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
    }


def _room_payload(room: RoomView) -> dict[str, object]:
    return {
        "code": room.code,
        "name": room.name,
        "categoryId": room.category_id,
        "capacity": room.capacity,
        "gameMode": room.game_mode,
        "players": [_player_payload(player) for player in room.players],
        "isPublic": room.is_public,
        "hasPassword": room.has_password,
        "isMine": room.is_mine,
        "joined": room.joined,
        "createdAt": room.created_at,
    }


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


def _match_payload(match: MatchView) -> dict[str, object]:
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
    return {
        "matchId": str(match.id),
        "state": match.state,
        "categoryId": match.category_id,
        "gameMode": match.game_mode,
        "currentPosition": match.current_position,
        "totalQuestions": match.total_questions,
        "deadlineAt": match.deadline_at,
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
            {
                "playerId": str(score.player_id),
                "nickname": score.nickname,
                "characterId": score.character_id,
                "score": score.score,
                "correctCount": score.correct_count,
                "answeredCount": score.answered_count,
            }
            for score in match.scores
        ]
        if match.state != "running"
        else [],
    }


def _match_start_payload(match: MatchSetup) -> dict[str, object]:
    return {
        "matchId": str(match.id),
        "categoryId": match.category_id,
        "gameMode": match.game_mode,
        "totalQuestions": match.total_questions,
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
) -> FastAPI:
    if (
        isinstance(cleanup_interval_seconds, bool)
        or cleanup_interval_seconds <= 0
    ):
        raise ValueError("cleanup_interval_seconds must be positive")
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
    hub = EventHub()
    ingress_limiter = AtomicMultiWindowLimiter()
    authenticated_ingress_limiter = AtomicMultiWindowLimiter()
    join_limiter = AtomicMultiWindowLimiter()
    mutation_limiter = AtomicMultiWindowLimiter()
    chat_limiter = AtomicMultiWindowLimiter()
    answer_limiter = AtomicMultiWindowLimiter()
    ticket_limiter = AtomicMultiWindowLimiter()
    websocket_inbound_limiter = AtomicMultiWindowLimiter()
    release_readiness_limiter = AtomicMultiWindowLimiter()
    movement_sequences = count(1)

    def allow_actor_room(
        limiter: AtomicMultiWindowLimiter,
        *,
        prefix: str,
        actor_id: UUID,
        code: str,
        actor_limit: int,
        actor_window_seconds: float,
        process_limit: int,
    ) -> bool:
        return limiter.allow(
            (
                RateLimitClaim(
                    key=f"{prefix}:actor-room:{actor_id}:{code}",
                    limit=actor_limit,
                    window_seconds=actor_window_seconds,
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
                    codes = await repo.advance_expired_matches()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # A transient database outage must not terminate the API lifespan.
                    logger.warning("match expiry sweep failed", exc_info=True)
                    codes = []
                for code in codes:
                    await hub.broadcast(code, {"type": "match-invalidated"})

        async def sweep_expired_resources() -> None:
            while True:
                await asyncio.sleep(cleanup_interval_seconds)
                try:
                    await repo.cleanup_expired_resources()
                    await hub.revalidate(repo.is_member)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Cleanup is best-effort per tick; a transient outage is retried.
                    logger.warning("resource cleanup sweep failed", exc_info=True)

        try:
            sweep_tasks = [
                asyncio.create_task(sweep_expired_matches()),
                asyncio.create_task(sweep_expired_resources()),
            ]
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
    )

    async def require_actor(
        request: Request,
        identity: Identity = Depends(_identity),
    ) -> UUID:
        client_key = _client_key(request)
        if not authenticated_ingress_limiter.allow(
            (
                RateLimitClaim(
                    key=f"authenticated:client:{client_key}",
                    limit=120,
                    window_seconds=60,
                ),
                RateLimitClaim(
                    key="authenticated:process",
                    limit=600,
                    window_seconds=60,
                ),
            )
        ):
            raise _error(
                429,
                "rate-limited",
                "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
                headers={"Retry-After": "1"},
            )
        if not await repo.authenticate(identity.player_id, identity.token_hash):
            raise _error(401, "unauthorized", "온라인 세션이 만료되었습니다.")
        return identity.player_id

    @app.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def ready() -> dict[str, str]:
        if not await repo.health():
            raise _error(503, "database-unavailable", "데이터베이스에 연결할 수 없습니다.")
        return {"status": "ready"}

    @app.get("/v1/release-readiness")
    async def release_readiness(request: Request) -> dict[str, str | int]:
        client_key = _client_key(request)
        if not release_readiness_limiter.allow(
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
        ):
            raise _error(
                429,
                "rate-limited",
                "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
                headers={"Retry-After": "60"},
            )
        version = await repo.schema_version()
        if version != 10:
            raise _error(
                503,
                "migration-required",
                "캐릭터 전용 데이터베이스 전환이 완료되지 않았습니다.",
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
    ) -> dict[str, str]:
        client_key = _client_key(request)
        if not ingress_limiter.allow(
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
        ):
            raise _error(429, "rate-limited", "잠시 뒤 다시 시도해 주세요.")
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
                "이 브라우저 식별자를 다시 만들 필요가 있습니다.",
            ) from error
        return {"playerId": str(identity.player_id)}

    @app.get("/v1/rooms")
    async def list_rooms(
        actor_id: UUID = Depends(require_actor),
    ) -> list[dict[str, object]]:
        return [_room_payload(room) for room in await repo.list_rooms(actor_id)]

    @app.post("/v1/rooms", status_code=201)
    async def create_room(
        request: Request,
        body: CreateRoomBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        client_key = _client_key(request)
        if not ingress_limiter.allow(
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
        ):
            raise _error(429, "rate-limited", "방은 잠시 뒤 다시 만들 수 있습니다.")
        try:
            spec = validate_room(
                name=body.name,
                category_id=body.category_id,
                capacity=body.capacity,
                is_public=body.is_public,
                password=body.password,
                game_mode=body.game_mode,
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
                    "비밀번호 작업이 많습니다. 잠시 뒤 다시 시도해 주세요.",
                    headers={"Retry-After": "1"},
                ) from error
        room = await repo.create_room(actor_id, spec, password_hash)
        return _room_payload(room)

    @app.get("/v1/rooms/{raw_code}")
    async def get_room(
        raw_code: str,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        room = await repo.get_room(actor_id, code)
        if room is None:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.")
        return _room_payload(room)

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
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        if not allow_actor_room(
            join_limiter,
            prefix="join",
            actor_id=actor_id,
            code=code,
            actor_limit=12,
            actor_window_seconds=60,
            process_limit=300,
        ):
            raise _error(
                429,
                "rate-limited",
                "참가 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
            )

        already_joined = await repo.is_member(actor_id, code)
        if not already_joined:
            access = await repo.get_access(code)
            if access is None:
                raise _error(404, "not-found", "그런 코드의 방이 없습니다.")
            if not access.is_public:
                client_key = _client_key(request)
                if not ingress_limiter.allow(
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
                ):
                    raise _error(
                        429,
                        "rate-limited",
                        "참가 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
                    )
                if not body.password:
                    raise _error(403, "need-password", "비밀번호가 필요한 방입니다.")
                if not access.password_hash:
                    raise _error(403, "wrong-password", "비밀번호가 맞지 않습니다.")
                try:
                    verified = await password_work.verify(
                        access.password_hash,
                        body.password,
                    )
                except PasswordWorkBusy as error:
                    raise _error(
                        429,
                        "rate-limited",
                        "비밀번호 작업이 많습니다. 잠시 뒤 다시 시도해 주세요.",
                        headers={"Retry-After": "1"},
                    ) from error
                except (VerifyMismatchError, VerificationError, InvalidHashError):
                    verified = False
                if not verified:
                    raise _error(403, "wrong-password", "비밀번호가 맞지 않습니다.")

        try:
            room = await repo.join_room(actor_id, code)
        except RoomNotFound as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        except RoomFull as error:
            raise _error(409, "full", "방이 이미 가득 찼습니다.") from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중인 게임에는 새로 참가할 수 없습니다.",
            ) from error

        await hub.broadcast(code, {"type": "room-invalidated"})
        return _room_payload(room)

    @app.delete("/v1/rooms/{raw_code}/members/me", status_code=204)
    async def leave_room(
        raw_code: str,
        actor_id: UUID = Depends(require_actor),
    ) -> Response:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        if not allow_actor_room(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        ):
            raise _error(
                429,
                "rate-limited",
                "방 변경 요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
            )
        try:
            room = await repo.leave_room(actor_id, code)
        except (RoomNotFound, NotMember) as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중인 게임에서는 방을 나갈 수 없습니다.",
            ) from error
        await hub.disconnect_actor(code, actor_id)
        if room is not None:
            await hub.broadcast(code, {"type": "room-invalidated"})
        return Response(status_code=204)

    @app.patch("/v1/rooms/{raw_code}")
    async def update_room(
        raw_code: str,
        body: UpdateRoomBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        if not allow_actor_room(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        ):
            raise _error(
                429,
                "rate-limited",
                "방 변경 요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
            )

        patch = body.model_dump(exclude_unset=True)
        if "game_mode" in patch:
            # 구버전 client의 true/false는 모두 호환 입력일 뿐이다. 어떤 값이 와도
            # 캐릭터 전용 설정은 바뀌지 않으며 DB mutation에도 전달하지 않는다.
            patch.pop("game_mode")
        if "category_id" in patch:
            category = patch["category_id"]
            if category is not None and category not in ALLOWED_CATEGORIES:
                raise _error(400, "invalid-category", "지원하지 않는 게임 형식입니다.")
        if "capacity" in patch and patch["capacity"] not in ALLOWED_CAPACITIES:
            raise _error(400, "invalid-capacity", "지원하지 않는 최대 인원입니다.")

        try:
            room = await repo.update_room(actor_id, code, patch)
        except RoomNotFound as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        except NotHost as error:
            raise _error(403, "not-host", "방장만 설정을 바꿀 수 있습니다.") from error
        except RoomFull as error:
            raise _error(409, "full", "현재 인원보다 작은 정원으로 바꿀 수 없습니다.") from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중에는 방 설정을 바꿀 수 없습니다.",
            ) from error
        await hub.broadcast(code, {"type": "room-invalidated"})
        return _room_payload(room)

    @app.put("/v1/rooms/{raw_code}/ready")
    async def set_ready(
        raw_code: str,
        body: ReadyBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        if not allow_actor_room(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        ):
            raise _error(
                429,
                "rate-limited",
                "방 변경 요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
            )
        try:
            room = await repo.set_ready(actor_id, code, body.is_ready)
        except (RoomNotFound, NotMember) as error:
            raise _error(403, "not-member", "먼저 방에 참가해 주세요.") from error
        except MatchInProgress as error:
            raise _error(
                409,
                "game-in-progress",
                "진행 중에는 준비 상태를 바꿀 수 없습니다.",
            ) from error
        await hub.broadcast(code, {"type": "room-invalidated"})
        return _room_payload(room)

    @app.post("/v1/rooms/{raw_code}/chat", status_code=202)
    async def send_chat(
        raw_code: str,
        body: ChatBody,
        actor_id: UUID = Depends(require_actor),
    ) -> Response:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(400, error.code, str(error)) from error
        if not allow_actor_room(
            chat_limiter,
            prefix="chat",
            actor_id=actor_id,
            code=code,
            actor_limit=12,
            actor_window_seconds=60,
            process_limit=600,
        ):
            raise _error(429, "rate-limited", "채팅은 잠시 뒤 다시 보낼 수 있습니다.")
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
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        if not allow_actor_room(
            mutation_limiter,
            prefix="mutation",
            actor_id=actor_id,
            code=code,
            actor_limit=30,
            actor_window_seconds=10,
            process_limit=600,
        ):
            raise _error(
                429,
                "rate-limited",
                "방 변경 요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
            )
        try:
            match = await repo.start_game(actor_id, code)
        except RoomNotFound as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        except NotHost as error:
            raise _error(403, "not-host", "방장만 게임을 시작할 수 있습니다.") from error
        except MatchNotReady as error:
            raise _error(
                409,
                "not-ready",
                "참가자가 두 명 이상이고 모두 준비해야 시작할 수 있습니다.",
            ) from error
        except MatchInProgress as error:
            raise _error(409, "game-in-progress", "이미 진행 중인 게임이 있습니다.") from error
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
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        match_read = await repo.get_match(actor_id, code)
        match = match_read.match
        if match is None:
            raise _error(404, "no-active-match", "진행하거나 방금 끝난 게임이 없습니다.")
        payload = _match_payload(match)
        if match_read.advanced:
            await hub.broadcast(code, {"type": "match-invalidated", "matchId": str(match.id)})
        return payload

    @app.post("/v1/rooms/{raw_code}/match/answers")
    async def submit_answer(
        raw_code: str,
        body: AnswerBody,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, object]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        if not allow_actor_room(
            answer_limiter,
            prefix="answer",
            actor_id=actor_id,
            code=code,
            actor_limit=8,
            actor_window_seconds=30,
            process_limit=600,
        ):
            raise _error(
                429,
                "rate-limited",
                "답안 제출이 너무 빠릅니다. 잠시 뒤 다시 시도해 주세요.",
            )
        try:
            submission = await repo.submit_answer(
                actor_id,
                code,
                position=body.position,
                choice_index=body.choice_index,
            )
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        except MatchNotFound as error:
            raise _error(404, "no-active-match", "진행 중인 게임이 없습니다.") from error
        except MatchPositionMismatch as error:
            raise _error(409, "stale-question", "이미 다음 문제로 넘어갔습니다.") from error
        except NotMember as error:
            raise _error(403, "not-member", "먼저 방에 참가해 주세요.") from error
        await hub.broadcast(
            code,
            {"type": "match-invalidated", "matchId": str(submission.match.id)},
        )
        return {
            "match": _match_payload(submission.match),
            "accepted": True,
            "advanced": submission.advanced,
        }

    @app.post("/v1/rooms/{raw_code}/ws-ticket", status_code=201)
    async def websocket_ticket(
        raw_code: str,
        actor_id: UUID = Depends(require_actor),
    ) -> dict[str, str]:
        try:
            code = normalize_code(raw_code)
        except DomainError as error:
            raise _error(404, "not-found", "그런 코드의 방이 없습니다.") from error
        if not allow_actor_room(
            ticket_limiter,
            prefix="ticket",
            actor_id=actor_id,
            code=code,
            actor_limit=6,
            actor_window_seconds=60,
            process_limit=300,
        ):
            raise _error(
                429,
                "rate-limited",
                "연결 준비 요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
            )
        if not await repo.is_member(actor_id, code):
            raise _error(403, "not-member", "먼저 방에 참가해 주세요.")
        return {"ticket": ticket_store.issue(actor_id, code)}

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
                movement = _movement_message(message)
                if movement is None:
                    continue
                x, y, moving = movement
                await hub.broadcast(
                    code,
                    {
                        "type": "movement",
                        "playerId": str(actor_id),
                        "x": x,
                        "y": y,
                        "moving": moving,
                        "sequence": next(movement_sequences),
                    },
                )
        except (RuntimeError, WebSocketDisconnect):
            pass
        finally:
            hub.disconnect(code, websocket)

    return app
