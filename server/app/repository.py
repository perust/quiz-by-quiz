from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
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
    # 혼자 푸는 온라인 판의 방인가 (FR-7.13 3단계, migration 012의 solo_rooms). 그 사람에게만
    # 보이고 남이 들어오지 못한다. payload는 true일 때만 `solo`를 싣는다.
    solo: bool = False


@dataclass(frozen=True)
class AccessInfo:
    is_public: bool
    password_hash: str | None
    # 혼자 방이면 멤버가 아닌 사람에게는 «없는 방»이다 (FR-7.13 3단계)
    solo: bool = False


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
class SoloStart:
    """혼자 푸는 온라인 판을 열거나 이은 결과 (FR-7.13 3단계, POST /v1/solo).

    `match`가 None이면 그 사람의 혼자 방에 이미 판이 돌고 있어 새 판을 열지 않았다(`resumed`) —
    화면은 그 판을 이어 그린다. `created`는 이번에 혼자 방을 새로 만들었는가다(운영 기록만 읽는다).
    """

    room: RoomView
    match: MatchSetup | None
    created: bool = False

    @property
    def resumed(self) -> bool:
        return self.match is None


@dataclass(frozen=True)
class OwnBestView:
    """한 판(board)의 내 최고 기록. 같은 점수면 먼저 남긴 기록이다 (랭킹 순서와 같다)."""

    score: int
    correct_count: int
    total_count: int
    recorded_at: str


@dataclass(frozen=True)
class OwnRecordView:
    """내 온라인 기록 한 줄 (기록 내보내기, FR-7.13 2단계 N02). 브라우저 신분은 싣지 않는다."""

    board: str
    score: int
    correct_count: int
    total_count: int
    question_time_ms: int
    nickname: str
    recorded_at: str


@dataclass(frozen=True)
class OwnRecordsView:
    records: tuple[OwnRecordView, ...]
    # 한도보다 많아 오래된 기록을 덜어 냈는가
    truncated: bool


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
    # 끝난 판에서만: 묻는 사람의 이 판 결과가 온라인 랭킹에 남았는가 (FR-7.13 2단계). 판을 닫은
    # transaction이 남기므로 012 API가 닫은 판이면 언제나 true다(011 API가 닫은 판은 false).
    ranking_recorded: bool = False


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
    # 보존 기간(최근 8주 + 판마다 전체 상위 100, 저장 한도 250,000줄)을 넘겨 지운 랭킹 기록
    # (migration 012)
    rankings_pruned: int = 0

    @property
    def changed(self) -> bool:
        return any(
            (
                self.rooms_deleted,
                self.members_removed,
                self.hosts_transferred,
                self.matches_deleted,
                self.players_deleted,
                self.rankings_pruned,
            )
        )


# 온라인 랭킹의 판: 전체 도전('all')과 분야 다섯. migration 012의 board 열과 같은 값이다.
RANKING_BOARDS = ("all", "history", "science", "geography", "general", "art")
RankingPeriod = Literal["week", "all"]
# 한 번에 내보내는 순위 수 (FR-6.4의 상위 10과 같다)
RANKING_LIMIT = 10
# 기록 내보내기가 한 번에 싣는 내 기록 수. 최근 것부터 고른다 — 보존(최근 8주 + 판마다 전체 상위
# 100)이 남긴 것 가운데서다
OWN_RECORDS_LIMIT = 500
# 동시에 있을 수 있는 혼자 방의 수 (FR-7.13 3단계). 혼자 방 하나에 도는 판은 많아야 하나라 이것이
# 혼자 판의 동시 수도 묶는다 — 아무도 답하지 않는 혼자 판 1,200개는 20초 문항이면 28초마다 마감
# 넘김이 두 번이라 초당 약 86번이고, 마감 sweep(1초마다 판 100개)이 따라간다. 이미 있는 혼자 방을
# 다시 쓰는 판은 세지 않는다 — 새로 만들 때만 본다. 찬 동안 새 판은 503 `solo-busy`이고 화면은
# 연습(기록 안 남음)을 연다. 이 값을 바꾸는 것은 자원 envelope 검토다
# (deploy/oracle/README.md «Solo online play»)
SOLO_ROOM_CEILING = 1_200

# «내 기록»(isMine)을 가리는 열쇠의 앞말. 열쇠는 브라우저 비밀(토큰)의 해시에서 나온다.
_RANKING_OWNER_PREFIX = b"qbb-ranking-owner:"


def ranking_owner_key(token_hash: bytes) -> bytes:
    """랭킹 기록의 주인 열쇠(32바이트). 기록할 때와 읽을 때 같은 함수를 쓴다 (FR-7.13 2단계).

    player id만으로 «내 기록»을 가리면, players 줄이 지워진 뒤(2시간) 그 id를 제 토큰으로
    다시 등록한 사람이 남의 기록을 «나»로 읽는다 — player id는 로비의 방 snapshot에 실려
    누구에게나 보인다. 그래서 브라우저만 아는 토큰의 해시에서 열쇠를 만든다. 앞말을 붙여 다시
    해시하므로 토큰 해시 자체가 기록에 남지 않고, 열쇠로는 로그인할 수 없다.
    """
    return hashlib.sha256(_RANKING_OWNER_PREFIX + token_hash).digest()


@dataclass(frozen=True)
class RankingEntryView:
    """랭킹 한 줄. 브라우저 신분(player_id)은 싣지 않는다 — 묻는 사람의 것인지만 알린다."""

    rank: int
    nickname: str
    character_id: str
    score: int
    correct_count: int
    total_count: int
    recorded_at: str
    is_mine: bool


@dataclass(frozen=True)
class RankingBoardView:
    """판 하나의 한 기간 상위 기록. «이번 주»면 서울 시각 월요일 0시부터 다음 월요일까지다."""

    board: str
    period: RankingPeriod
    entries: tuple[RankingEntryView, ...]
    window_start: str | None = None
    window_end: str | None = None


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


class SoloRoomsFull(RepositoryFailure):
    """혼자 방이 한도(`SOLO_ROOM_CEILING`)까지 찼다 (FR-7.13 3단계). 새 혼자 방을 만들지 않는다.

    이미 있는 혼자 방을 다시 쓰는 판은 막지 않는다 — 만들 때만 센다. API는 503 `solo-busy`로 알리고
    화면은 결정 #1처럼 연습(기록 안 남음)을 연다.
    """


class SoloCreateLimited(RepositoryFailure):
    """새 혼자 방을 만드는 몫(주소·프로세스, 한 시간)이 찼다. `retry_after`초 뒤에 자리가 난다."""

    def __init__(self, retry_after: float) -> None:
        super().__init__("solo room creation budget exhausted")
        self.retry_after = retry_after


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

    # 이 API가 쓰는 012의 혼자 방 표(`quiz_online.solo_rooms`)가 있는가. 012를 제자리에서 고쳐
    # #108의 012와 이 PR의 012가 같은 번호(12)다 — 번호만 보는 release readiness가 #108의 012 위에서
    # ready를 말하지 않게 함께 본다 (deploy/oracle/README.md «Fail-closed staging order»)
    async def solo_rooms_ready(self) -> bool: ...

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

    # 온라인 랭킹 상위 기록 (FR-7.13 2단계). actor_id와 owner_key(`ranking_owner_key`, 인증된
    # 그 브라우저의 토큰에서)가 모두 같은 기록에만 is_mine을 단다 — 둘 중 하나라도 없으면
    # 아무것도 내 기록이 아니다. at은 «이번 주»를 고를 시각이다(None이면 DB의 지금) — 테스트가
    # 주의 경계를 고른다.
    async def list_rankings(
        self,
        *,
        board: str,
        period: RankingPeriod,
        actor_id: UUID | None = None,
        owner_key: bytes | None = None,
        at: datetime | None = None,
        limit: int = RANKING_LIMIT,
    ) -> RankingBoardView: ...

    # 내 판마다 최고 기록 (FR-7.13 3단계, GET /v1/rankings/mine). actor_id와 owner_key가 모두 같은
    # 기록만 센다. exclude_match_id를 주면 그 판의 기록은 빼고 센다 — 결과 화면이 «이 판 전의 최고
    # 기록»과 견준다(FR-5.7). 기록이 없는 판은 None이다.
    async def own_best_scores(
        self,
        *,
        actor_id: UUID,
        owner_key: bytes,
        exclude_match_id: UUID | None = None,
    ) -> Mapping[str, OwnBestView | None]: ...

    # 내 온라인 기록 (기록 내보내기, GET /v1/rankings/mine/records). 최근 것부터 limit개.
    async def own_records(
        self,
        *,
        actor_id: UUID,
        owner_key: bytes,
        limit: int = OWN_RECORDS_LIMIT,
    ) -> OwnRecordsView: ...

    # 혼자 푸는 온라인 판 (FR-7.13 3단계, POST /v1/solo). 그 사람의 혼자 방을 다시 쓰고(없으면
    # 만든다) 곧바로 판을 연다. 혼자 방에 판이 돌고 있으면 새 판을 열지 않고 그 방을 돌려준다.
    # 새 혼자 방은 한도(`SOLO_ROOM_CEILING`) 안에서만 만들고(넘으면 SoloRoomsFull), 만들 때만
    # `may_create`(만드는 몫, 남은 대기 초 또는 None)를 먹는다 — 넘으면 SoloCreateLimited.
    async def start_solo(
        self,
        actor_id: UUID,
        spec: ValidatedRoom,
        *,
        may_create: Callable[[], float | None] | None = None,
    ) -> SoloStart: ...

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
