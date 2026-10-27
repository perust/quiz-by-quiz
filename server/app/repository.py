from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol
from uuid import UUID

from .domain import DEFAULT_QUESTION_TIME_MS, ValidatedPlayer, ValidatedRoom


@dataclass(frozen=True)
class PlayerView:
    id: UUID
    nickname: str
    character_id: str
    is_ready: bool = False
    # DB는 접속 여부를 모른다. API가 event hub의 presence로 채워 내보낸다.
    connected: bool = True


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
    # 진행 중인(running·revealing) 매치가 있으면 playing. 그동안 새 참가는 거절된다.
    status: Literal["waiting", "playing"] = "waiting"
    # 묻는 사람이 그 진행 중인 판의 참가자인가. playing인데 false면 판에서 빠진 멤버다(U24) —
    # 그 사람은 판이 도는 동안에도 나가거나 다음 판을 준비할 수 있다.
    in_match: bool = False
    # 방장이 고른 문항 시간(ms, 20초·40초). 판을 열 때 그 판에 옮겨 적는다.
    question_time_ms: int = DEFAULT_QUESTION_TIME_MS
    # 이 요청(나가기)이 방장 자리를 넘겼는가. 운영 기록(`ops_log.host_transferred`)만 읽는다 —
    # 방 payload에는 싣지 않는다.
    host_transferred: bool = False


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
    question_time_ms: int = DEFAULT_QUESTION_TIME_MS
    # 판에 든 사람 수. 운영 기록(`ops_log.match_started`)만 읽는다 — 시작 payload에는 싣지 않는다.
    # 모르는 저장소(테스트의 가짜)는 None이다.
    player_count: int | None = None


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
    # 공개(revealing) 중에만 채운다: 방금 공개한 문항을 맞혔는가 (U30). 다른 phase에서는 None이라
    # 아직 고민 중인 사람에게 남의 정오가 나가지 않는다.
    last_answer_correct: bool | None = None


@dataclass(frozen=True)
class MatchReviewView:
    """끝난 판의 문항 하나와 묻는 사람의 답 (U38 «문제 다시 보기»).

    finished snapshot에만, 그 판의 참가자에게만 싣는다. 공개 단계에서 문항마다 이미 본 것
    (문제·보기·정답·해설)을 한데 모은 것이라 판이 끝나기 전에는 존재하지 않는다.
    """

    position: int
    question_id: str
    category_id: str
    question: str
    choices: tuple[str, ...]
    answer_index: int
    explanation: str
    choice_index: int | None
    correct: bool
    timed_out: bool


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
    review: tuple[MatchReviewView, ...] = ()
    # 이 판의 문항 시간(ms). 시작할 때 방 설정에서 옮겨 와 판 내내 같다 —
    # 모든 문항 마감이 이 값이다.
    question_time_ms: int = DEFAULT_QUESTION_TIME_MS


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


@dataclass(frozen=True)
class ExpiredMatchAdvance:
    """마감 sweep이 넘긴 판 하나. 마지막 공개가 끝나 닫혔으면 방이 다시 기다리는 방이 된다."""

    code: str
    finished: bool
    # 넘긴 판과 넘기기 전의 문항 순서. API가 그 문항까지의 발밑 칸 초안을 버린다 (U13)
    match_id: UUID | None = None
    position: int | None = None


@dataclass(frozen=True)
class StandingAnswer:
    """시간이 끝나면 답으로 세는 발밑 칸 (U13, 혼자 하기와 같은 규칙).

    화면이 실제로 움직인 뒤 선 칸을 방 소켓으로 보낸 초안이다. API의 메모리에만 있고(presence와
    같은 단일 worker 계약) DB에는 마감이 그 사람의 빈 답을 채울 때 보통 답으로만 남는다.
    """

    choice_index: int
    # API가 받은 시각(UTC). 마감 뒤에 닿은 초안은 세지 않는다
    received_at: datetime


class StandingAnswerSource(Protocol):
    """마감이 빈 답을 채울 때 묻는 발밑 칸 초안. 이 판·이 문항의 것만 돌려준다."""

    def for_question(
        self,
        code: str,
        match_id: UUID,
        position: int,
    ) -> Mapping[UUID, StandingAnswer]: ...


@dataclass(frozen=True)
class AbsentHostSweep:
    """presence sweep이 끊긴 사람이 있는 방들을 한 번에 다시 본 결과."""

    # 끊긴 방장을 접속 중인 참가자에게 넘긴 방
    transferred: frozenset[str]
    # 지금 있는 방마다 참가자. 물어본 방이 여기 없으면 사라졌거나 만료됐다.
    members: Mapping[str, frozenset[UUID]]


@dataclass(frozen=True)
class CleanupCounts:
    """60초 정리 한 번이 지우거나 넘긴 수. API가 0이 아닐 때만 운영 기록에 한 줄 낸다."""

    rooms_deleted: int = 0
    members_removed: int = 0
    hosts_transferred: int = 0
    matches_deleted: int = 0
    players_deleted: int = 0

    @property
    def changed(self) -> bool:
        return any(
            (
                self.rooms_deleted,
                self.members_removed,
                self.hosts_transferred,
                self.matches_deleted,
                self.players_deleted,
            )
        )


@dataclass(frozen=True)
class RoomCounts:
    """운영 요약의 방·판 수. 5분에 한 번 집계 쿼리 하나로 읽는다(`ops_counts`)."""

    waiting_rooms: int
    playing_rooms: int
    running_matches: int


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


class MemberConnected(RepositoryFailure):
    """내보내려는 참가자가 아직 접속 중이다 (U24).

    끊긴 자리를 비우는 내보내기는 유예를 넘겨 끊긴 사람만 뺀다. 접속 중인 사람은 방장이
    그렇게 보고 확인한 내보내기(`allow_connected`)로만 뺀다.
    """


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

    # absent_player_ids: 유예를 넘겨 끊긴 참가자. 나가는 방장의 자리는 접속 중인 사람이 먼저 받는다.
    async def leave_room(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> RoomView | None: ...

    # 방장이 다른 참가자를 방에서 뺀다 (U24). 방장 자신은 MemberConnected(나가기로 떠난다),
    # 도는 판에 자리가 있는 사람은 MatchInProgress다. allow_connected가 false면 유예를 넘겨
    # 끊긴 참가자(absent_player_ids 안의 사람)만 빼고 접속 중인 사람은 MemberConnected다.
    # 다시 참가를 잠시 막는 것은 API의 메모리 기록(RemovedMembers)이 맡는다.
    async def remove_member(
        self,
        actor_id: UUID,
        code: str,
        player_id: UUID,
        *,
        absent_player_ids: frozenset[UUID],
        allow_connected: bool = False,
    ) -> RoomView: ...

    # patch에는 API가 검증한 category_id·capacity·question_time_ms 가운데 바꿀 것만 온다.
    # 방장만(NotHost), 판이 도는 동안에는 바꿀 수 없다(MatchInProgress).
    async def update_room(
        self,
        actor_id: UUID,
        code: str,
        patch: dict[str, object],
    ) -> RoomView: ...

    async def set_ready(self, actor_id: UUID, code: str, is_ready: bool) -> RoomView: ...

    async def send_chat(self, actor_id: UUID, code: str, text: str) -> PlayerView: ...

    async def start_game(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSetup: ...

    async def transfer_absent_host(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
    ) -> bool: ...

    # presence sweep이 5초마다 끊긴 사람이 있는 방 전부를 한 번에 다시 본다. 방장이 어떤 길로
    # 끊긴 사람이 됐는지(끊김·나가기 승계·30분 정리), 접속 중인 사람이 언제 들어왔는지 묻지 않는다.
    async def transfer_absent_hosts(
        self,
        absent_by_room: Mapping[str, frozenset[UUID]],
    ) -> AbsentHostSweep: ...

    # absent_player_ids: 유예를 넘겨 끊긴 참가자. «모두 답했다»의 분모에서 빠진다 (U32).
    # 부르는 쪽(API)이 지금 요청한 사람은 넣지 않는다 — 요청하는 사람은 끊긴 사람이 아니다.
    # standing_answers: 발밑 칸 초안 (U13). 마감이 빈 답을 채울 때만 묻고, «모두 답했다»에는
    # 세지 않는다.
    async def get_match(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
    ) -> MatchRead: ...

    async def submit_answer(
        self,
        actor_id: UUID,
        code: str,
        *,
        position: int,
        choice_index: int | None,
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
    ) -> MatchSubmission: ...

    # 지우거나 넘긴 수를 돌려준다. 수를 모르는 구현은 None을 돌려줘도 된다(운영 기록만 빠진다).
    async def cleanup_expired_resources(self) -> CleanupCounts | None: ...

    # 운영 요약(5분마다)의 기다리는 방·게임 중인 방·도는 판 수
    async def ops_counts(self) -> RoomCounts: ...

    async def advance_expired_matches(
        self,
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> list[ExpiredMatchAdvance]: ...

    async def advance_past_absent_players(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> bool: ...

    async def is_member(self, actor_id: UUID, code: str) -> bool: ...

    async def touch_member(self, actor_id: UUID, code: str) -> None: ...
