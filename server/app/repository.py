from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from .domain import ValidatedPlayer, ValidatedRoom


@dataclass(frozen=True)
class PlayerView:
    id: UUID
    nickname: str
    character_id: str
    is_ready: bool = False


@dataclass(frozen=True)
class RoomView:
    code: str
    name: str
    category_id: str | None
    capacity: int
    game_mode: bool
    players: tuple[PlayerView, ...]
    is_public: bool
    has_password: bool
    is_mine: bool
    joined: bool
    created_at: str


@dataclass(frozen=True)
class AccessInfo:
    is_public: bool
    password_hash: str | None


@dataclass(frozen=True)
class MatchSetup:
    id: UUID
    category_id: str | None
    game_mode: bool
    total_questions: int


@dataclass(frozen=True)
class MatchQuestionView:
    """A currently playable question; correct-answer material is deliberately absent."""

    id: str
    category_id: str
    question: str
    choices: tuple[str, ...]
    position: int
    total: int


@dataclass(frozen=True)
class MatchAnswerView:
    """Answer feedback retained server-side and serialized only in the reveal phase."""

    position: int
    choice_index: int | None
    correct: bool
    timed_out: bool
    answer_index: int
    explanation: str


@dataclass(frozen=True)
class MatchScoreView:
    player_id: UUID
    nickname: str
    character_id: str
    score: int
    correct_count: int
    answered_count: int


@dataclass(frozen=True)
class MatchView:
    id: UUID
    state: str
    category_id: str | None
    game_mode: bool
    current_position: int
    total_questions: int
    deadline_at: str | None
    question: MatchQuestionView | None
    own_answer: MatchAnswerView | None
    scores: tuple[MatchScoreView, ...]


@dataclass(frozen=True)
class MatchRead:
    """A match snapshot plus whether this read committed a deadline transition."""

    match: MatchView | None
    advanced: bool


@dataclass(frozen=True)
class MatchSubmission:
    match: MatchView
    answer: MatchAnswerView
    advanced: bool


class RepositoryFailure(RuntimeError):
    """Base class for expected persistence-boundary failures."""


class TokenConflict(RepositoryFailure):
    pass


class RoomNotFound(RepositoryFailure):
    pass


class RoomFull(RepositoryFailure):
    pass


class NotMember(RepositoryFailure):
    pass


class NotHost(RepositoryFailure):
    pass


class MatchNotReady(RepositoryFailure):
    pass


class MatchInProgress(RepositoryFailure):
    pass


class MatchNotFound(RepositoryFailure):
    pass


class MatchPositionMismatch(RepositoryFailure):
    pass


class RoomsRepository(Protocol):
    async def open(self) -> None: ...

    async def close(self) -> None: ...

    async def health(self) -> bool: ...

    async def schema_version(self) -> int: ...

    async def upsert_player(
        self,
        player_id: UUID,
        token_hash: bytes,
        player: ValidatedPlayer,
        update_profile: bool = True,
    ) -> None: ...

    async def authenticate(self, player_id: UUID, token_hash: bytes) -> bool: ...

    async def list_rooms(self, actor_id: UUID) -> list[RoomView]: ...

    async def create_room(
        self,
        actor_id: UUID,
        spec: ValidatedRoom,
        password_hash: str | None,
    ) -> RoomView: ...

    async def get_room(self, actor_id: UUID, code: str) -> RoomView | None: ...

    async def get_access(self, code: str) -> AccessInfo | None: ...

    async def join_room(self, actor_id: UUID, code: str) -> RoomView: ...

    async def leave_room(self, actor_id: UUID, code: str) -> RoomView | None: ...

    async def update_room(
        self,
        actor_id: UUID,
        code: str,
        patch: dict[str, object],
    ) -> RoomView: ...

    async def set_ready(self, actor_id: UUID, code: str, is_ready: bool) -> RoomView: ...

    async def send_chat(self, actor_id: UUID, code: str, text: str) -> PlayerView: ...

    async def start_game(self, actor_id: UUID, code: str) -> MatchSetup: ...

    async def get_match(self, actor_id: UUID, code: str) -> MatchRead: ...

    async def submit_answer(
        self,
        actor_id: UUID,
        code: str,
        *,
        position: int,
        choice_index: int | None,
    ) -> MatchSubmission: ...

    async def cleanup_expired_resources(self) -> None: ...

    async def advance_expired_matches(self) -> list[str]: ...

    async def is_member(self, actor_id: UUID, code: str) -> bool: ...

    async def touch_member(self, actor_id: UUID, code: str) -> None: ...
