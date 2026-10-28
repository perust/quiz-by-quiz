from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.main import EventHub, StandingAnswers, _match_payload, create_app
from app.repository import (
    AbsentHostSweep,
    ExpiredMatchAdvance,
    MatchAnswerView,
    MatchNotReady,
    MatchQuestionView,
    MatchRead,
    MatchReviewView,
    MatchScoreView,
    MatchSetup,
    MatchSubmission,
    MatchView,
    PlayerView,
    RoomsRepository,
    RoomView,
    StandingAnswerSource,
)

PLAYER_ID = UUID("12345678-1234-5678-9234-567812345678")
MATCH_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
PLAYER_TOKEN = "match-api-player-token-with-at-least-thirty-two-characters"  # noqa: S105
HEADERS = {
    "Authorization": f"Bearer {PLAYER_TOKEN}",
    "X-Player-Id": str(PLAYER_ID),
}
WS_PROTOCOL = "qbb.v1"


def ws_protocols(ticket: str) -> list[str]:
    return [WS_PROTOCOL, f"qbb.ticket.{ticket}"]


def plain_room_event(event: dict[str, object]) -> dict[str, object]:
    """room-invalidated의 판 번호(fan-out 줄이기)를 확인하고 뗀다.

    이 테스트가 보는 것은 그 밖이다.
    """
    if event.get("type") != "room-invalidated":
        return event
    epoch = event.get("roomEpoch")
    version = event.get("roomVersion")
    assert isinstance(epoch, str) and epoch
    assert type(version) is int and version > 0
    return {
        key: value
        for key, value in event.items()
        if key not in {"roomEpoch", "roomVersion", "readyChange"}
    }


def _room(*, ready: bool = False) -> RoomView:
    return RoomView(
        code="ABC234",
        name="온라인 퀴즈",
        category_id="history",
        capacity=2,
        game_mode=True,
        players=(
            PlayerView(
                id=PLAYER_ID,
                nickname="퀴즈왕",
                character_id="slime-blue",
                is_ready=ready,
            ),
        ),
        is_public=True,
        has_password=False,
        is_mine=True,
        joined=True,
        created_at="2026-09-18T00:00:00+00:00",
    )


class MatchApiRepository:
    def __init__(self) -> None:
        self.room = _room()
        self.member = True
        self.answer = MatchAnswerView(
            position=1,
            choice_index=2,
            correct=True,
            timed_out=False,
            answer_index=2,
            explanation="정답 해설",
        )
        self.match_advanced_on_read = False
        # API가 «모두 답했다»의 분모에서 빼라고 넘긴 참가자 (U32)
        self.match_absent_player_ids: list[frozenset[UUID]] = []
        self.answer_absent_player_ids: list[frozenset[UUID]] = []
        # API가 넘긴 발밑 칸 초안 저장소 (U13). 읽기·답 모두 같은 것을 넘긴다
        self.standing_sources: list[StandingAnswerSource | None] = []
        self.match = MatchView(
            id=MATCH_ID,
            state="running",
            category_id="history",
            game_mode=True,
            current_position=1,
            total_questions=10,
            deadline_at="2026-09-18T00:00:20+00:00",
            question=MatchQuestionView(
                id="history-001",
                category_id="history",
                question="역사 문제",
                choices=("1", "2", "3", "4"),
                position=1,
                total=10,
            ),
            own_answer=None,
            scores=(
                MatchScoreView(
                    player_id=PLAYER_ID,
                    nickname="퀴즈왕",
                    character_id="slime-blue",
                    score=0,
                    correct_count=0,
                    answered_count=0,
                ),
            ),
        )

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def health(self) -> bool:
        return True

    async def schema_version(self) -> int:
        return 10

    async def authenticate(self, player_id: UUID, token_hash: bytes) -> bool:
        expected = hashlib.sha256(PLAYER_TOKEN.encode()).digest()
        return player_id == PLAYER_ID and token_hash == expected

    async def set_ready(self, actor_id: UUID, code: str, is_ready: bool) -> RoomView:
        assert actor_id == PLAYER_ID and code == self.room.code
        self.room = _room(ready=is_ready)
        return self.room

    async def start_game(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSetup:
        assert actor_id == PLAYER_ID and code == self.room.code
        assert absent_player_ids == frozenset()
        return MatchSetup(id=MATCH_ID, category_id="history", game_mode=True, total_questions=10)

    async def get_match(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
    ) -> MatchRead:
        assert actor_id == PLAYER_ID and code == self.room.code
        self.match_absent_player_ids.append(absent_player_ids)
        self.standing_sources.append(standing_answers)
        return MatchRead(match=self.match, advanced=self.match_advanced_on_read)

    async def submit_answer(
        self,
        actor_id: UUID,
        code: str,
        *,
        position: int,
        choice_index: int | None,
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
    ) -> MatchSubmission:
        assert actor_id == PLAYER_ID and code == self.room.code
        self.answer_absent_player_ids.append(absent_player_ids)
        self.standing_sources.append(standing_answers)
        assert position == 1 and choice_index == 2
        self.match = replace(self.match, own_answer=self.answer)
        return MatchSubmission(match=self.match, answer=self.answer, advanced=False)

    async def advance_expired_matches(
        self,
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> list[ExpiredMatchAdvance]:
        return []

    async def is_member(self, actor_id: UUID, code: str) -> bool:
        return self.member and actor_id == PLAYER_ID and code == self.room.code

    async def touch_member(self, actor_id: UUID, code: str) -> None:
        return None


class RetryingCleanupRepository(MatchApiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.cleanup_calls = 0
        self.cleanup_retried = threading.Event()
        self.lifecycle_events: list[str] = []

    async def open(self) -> None:
        self.lifecycle_events.append("open")

    async def cleanup_expired_resources(self) -> None:
        self.cleanup_calls += 1
        self.lifecycle_events.append(f"cleanup-{self.cleanup_calls}")
        if self.cleanup_calls == 1:
            raise RuntimeError("transient cleanup failure")
        self.cleanup_retried.set()

    async def close(self) -> None:
        self.lifecycle_events.append("close")


class BlockingCleanupRepository(MatchApiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.cleanup_started = threading.Event()
        self.lifecycle_events: list[str] = []

    async def open(self) -> None:
        self.lifecycle_events.append("open")

    async def cleanup_expired_resources(self) -> None:
        self.lifecycle_events.append("cleanup-started")
        self.cleanup_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.lifecycle_events.append("cleanup-cancelled")

    async def close(self) -> None:
        self.lifecycle_events.append("close")


def _client(repository: MatchApiRepository) -> TestClient:
    return TestClient(create_app(repository=cast(RoomsRepository, repository)))


def test_resource_cleanup_retries_after_failure_without_stopping_lifespan(
    caplog: pytest.LogCaptureFixture,
) -> None:
    repository = RetryingCleanupRepository()
    caplog.set_level(logging.WARNING)
    app = create_app(
        repository=cast(RoomsRepository, repository),
        cleanup_interval_seconds=0.01,
    )

    with TestClient(app) as client:
        assert repository.cleanup_retried.wait(timeout=1)
        assert client.get("/healthz").status_code == 200

    assert repository.cleanup_calls >= 2
    assert repository.lifecycle_events[0] == "open"
    assert repository.lifecycle_events[-1] == "close"
    assert "resource cleanup sweep failed" in caplog.text


def test_resource_cleanup_is_cancelled_before_repository_close() -> None:
    repository = BlockingCleanupRepository()
    app = create_app(
        repository=cast(RoomsRepository, repository),
        cleanup_interval_seconds=0.01,
    )

    with TestClient(app):
        assert repository.cleanup_started.wait(timeout=1)

    assert repository.lifecycle_events == [
        "open",
        "cleanup-started",
        "cleanup-cancelled",
        "close",
    ]


def test_match_routes_hide_answer_feedback_and_scores_until_reveal() -> None:
    repository = MatchApiRepository()
    with _client(repository) as client:
        ready = client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": True})
        started = client.post("/v1/rooms/ABC234/start", headers=HEADERS)
        initial = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
        submitted = client.post(
            "/v1/rooms/ABC234/match/answers",
            headers=HEADERS,
            json={"position": 1, "choiceIndex": 2},
        )

    assert ready.status_code == 200
    assert ready.json()["players"][0]["isReady"] is True
    assert started.status_code == 201
    assert started.json() == {
        "matchId": str(MATCH_ID),
        "categoryId": "history",
        "gameMode": True,
        "totalQuestions": 10,
        "questionTimeMs": 20_000,
    }
    assert initial.status_code == 200
    initial_payload = initial.json()
    question = initial_payload["question"]
    assert question["id"] == "history-001"
    assert "answerIndex" not in question
    assert "explanation" not in question
    assert initial_payload["ownSubmission"] is None
    assert initial_payload["reveal"] is None
    assert initial_payload["scores"] == []

    assert submitted.status_code == 200
    submission_payload = submitted.json()
    assert submission_payload["accepted"] is True
    assert "answer" not in submission_payload
    assert submission_payload["advanced"] is False
    assert submission_payload["match"]["ownSubmission"] == {
        "position": 1,
        "choiceIndex": 2,
        "timedOut": False,
    }
    assert submission_payload["match"]["reveal"] is None
    assert submission_payload["match"]["scores"] == []
    assert "answerIndex" not in submitted.text
    assert "explanation" not in submitted.text
    assert '"correct"' not in submitted.text


def test_an_answer_that_does_not_advance_the_match_is_not_broadcast() -> None:
    # N01: 아직 고르는 사람이 남은 답은 남의 running snapshot을 하나도 바꾸지 않는다(점수는
    # 비어 있고 제출 표시는 묻는 사람 자신의 것뿐). 방송하면 방 전원이 같은 snapshot을 다시
    # 읽어 같은 IP의 요청 한도를 N²로 먹는다. 낸 사람은 응답의 snapshot을 쓴다.
    repository = MatchApiRepository()
    with _client(repository) as client:
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            response = client.post(
                "/v1/rooms/ABC234/match/answers",
                headers=HEADERS,
                json={"position": 1, "choiceIndex": 2},
            )
            # 같은 답을 다시 보내도(저장소는 첫 답을 돌려준다) 방송하지 않는다
            repeated = client.post(
                "/v1/rooms/ABC234/match/answers",
                headers=HEADERS,
                json={"position": 1, "choiceIndex": 2},
            )
            # 방송이 있었다면 그것이 먼저 온다. 뒤에 알려진 방송 하나를 보내 순서로 확인한다
            client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": False})
            event = websocket.receive_json()

    assert response.status_code == 200
    assert response.json()["advanced"] is False
    assert response.json()["match"]["ownSubmission"] == {
        "position": 1,
        "choiceIndex": 2,
        "timedOut": False,
    }
    assert repeated.status_code == 200
    assert plain_room_event(event) == {"type": "room-invalidated"}


class RevealOpeningRepository(MatchApiRepository):
    """마지막으로 답한 사람의 제출이 모두 답한 문항을 공개로 넘긴다."""

    async def submit_answer(
        self,
        actor_id: UUID,
        code: str,
        *,
        position: int,
        choice_index: int | None,
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
    ) -> MatchSubmission:
        submission = await super().submit_answer(
            actor_id,
            code,
            position=position,
            choice_index=choice_index,
            absent_player_ids=absent_player_ids,
        )
        self.match = replace(self.match, state="revealing")
        return replace(submission, match=self.match, advanced=True)


def test_an_answer_that_opens_the_reveal_invalidates_the_whole_room() -> None:
    repository = RevealOpeningRepository()
    with _client(repository) as client:
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            response = client.post(
                "/v1/rooms/ABC234/match/answers",
                headers=HEADERS,
                json={"position": 1, "choiceIndex": 2},
            )
            event = websocket.receive_json()

    assert response.status_code == 200
    assert response.json()["advanced"] is True
    assert response.json()["match"]["state"] == "revealing"
    assert event == {"type": "match-invalidated", "matchId": str(MATCH_ID)}


def test_match_fetch_that_advances_broadcasts_invalidation() -> None:
    repository = MatchApiRepository()
    repository.match_advanced_on_read = True

    with _client(repository) as client:
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            response = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
            event = websocket.receive_json()

    assert response.status_code == 200
    assert event == {"type": "match-invalidated", "matchId": str(MATCH_ID)}


def test_match_fetch_that_finishes_the_match_also_invalidates_the_room() -> None:
    # 판이 닫히면 방의 status가 playing에서 waiting으로 바뀐다. 판에서 빠진 멤버(U24)의
    # 대기실은 GET /match로는 알 길이 없어(그 사람의 판이 아니다) 방을 다시 읽어야 한다.
    repository = MatchApiRepository()
    repository.match_advanced_on_read = True
    repository.match = replace(repository.match, state="finished", question=None)

    with _client(repository) as client:
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            response = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
            events = [
                plain_room_event(websocket.receive_json()),
                plain_room_event(websocket.receive_json()),
            ]

    assert response.status_code == 200
    assert events == [
        {"type": "match-invalidated", "matchId": str(MATCH_ID)},
        {"type": "room-invalidated"},
    ]


class FinishingExpiryRepository(MatchApiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.pending = [
            [ExpiredMatchAdvance(code="ABC234", finished=False)],
            [ExpiredMatchAdvance(code="ABC234", finished=True)],
        ]

    async def advance_expired_matches(
        self,
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> list[ExpiredMatchAdvance]:
        return self.pending.pop(0) if self.pending else []


def test_expiry_sweep_invalidates_the_room_only_when_the_match_finishes() -> None:
    repository = FinishingExpiryRepository()

    with _client(repository) as client:
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            events = [plain_room_event(websocket.receive_json()) for _ in range(3)]

    # 문항이 넘어갈 때는 판만, 판이 닫힐 때는 방도 다시 읽게 한다.
    assert events == [
        {"type": "match-invalidated"},
        {"type": "match-invalidated"},
        {"type": "room-invalidated"},
    ]


OTHER_ID = UUID("87654321-4321-4765-8321-876543218765")


class FakeClock:
    def __init__(self) -> None:
        self.now = 5_000.0

    def __call__(self) -> float:
        return self.now


def test_match_reads_and_answers_skip_long_absent_players_but_never_the_requester() -> None:
    # 매치 중 끊긴 사람 때문에 남은 사람이 문제마다 마감까지 기다리지 않게, API는 유예를
    # 넘겨 끊긴 참가자를 «모두 답했다»의 분모에서 빼라고 넘긴다 (U32). 소켓이 없어도 지금
    # 요청한 사람은 끊긴 사람이 아니다 — 빼면 그 사람의 GET 하나가 자기 답을 건너뛴다.
    repository = MatchApiRepository()
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    app = create_app(repository=cast(RoomsRepository, repository), event_hub=hub)
    with TestClient(app) as client:
        # 둘 다 이 프로세스에서 소켓을 본 적이 없다. 처음 물어본 때부터 유예를 센다.
        assert hub.is_present("ABC234", OTHER_ID)
        assert hub.is_present("ABC234", PLAYER_ID)
        fresh = client.get("/v1/rooms/ABC234/match", headers=HEADERS)

        clock.now += 61
        assert hub.absent_actors("ABC234") == frozenset({OTHER_ID, PLAYER_ID})
        stale = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
        answered = client.post(
            "/v1/rooms/ABC234/match/answers",
            headers=HEADERS,
            json={"position": 1, "choiceIndex": 2},
        )

    assert fresh.status_code == stale.status_code == answered.status_code == 200
    assert repository.match_absent_player_ids == [frozenset(), frozenset({OTHER_ID})]
    assert repository.answer_absent_player_ids == [frozenset({OTHER_ID})]


class AbsentAdvanceRepository(MatchApiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.advance_calls: list[tuple[str, frozenset[UUID]]] = []
        self.advance_requested = threading.Event()

    async def transfer_absent_hosts(
        self,
        absent_by_room: Mapping[str, frozenset[UUID]],
    ) -> AbsentHostSweep:
        # 방장은 접속 중이고 끊긴 친구는 아직 참가자다.
        return AbsentHostSweep(transferred=frozenset(), members=dict(absent_by_room))

    async def advance_past_absent_players(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> bool:
        self.advance_calls.append((code, absent_player_ids))
        self.advance_requested.set()
        return True


def test_presence_sweep_advances_a_question_that_waited_only_for_a_newly_absent_player() -> None:
    # 남은 사람이 이미 다 답했으면 다음 제출이 없어 마감까지 아무도 다시 판정하지 않는다.
    # 누가 유예를 넘기는 순간 sweep이 한 번 판정하고, 넘겼으면 화면들이 다시 읽게 한다.
    repository = AbsentAdvanceRepository()
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    app = create_app(
        repository=cast(RoomsRepository, repository),
        event_hub=hub,
        presence_interval_seconds=0.01,
    )
    with TestClient(app) as client:
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            # 판에 있던 친구는 소켓이 끊긴 채 돌아오지 않는다.
            assert hub.is_present("ABC234", OTHER_ID)
            time.sleep(0.05)
            assert repository.advance_calls == []

            clock.now += 61
            assert repository.advance_requested.wait(timeout=2)
            events = [
                plain_room_event(websocket.receive_json()),
                plain_room_event(websocket.receive_json()),
            ]

    assert repository.advance_calls[0] == ("ABC234", frozenset({OTHER_ID}))
    assert events == [{"type": "room-invalidated"}, {"type": "match-invalidated"}]


def test_revealing_match_is_the_only_snapshot_that_contains_feedback_and_scores() -> None:
    repository = MatchApiRepository()
    repository.match = replace(repository.match, state="revealing", own_answer=repository.answer)

    with _client(repository) as client:
        response = client.get("/v1/rooms/ABC234/match", headers=HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["ownSubmission"] is None
    assert payload["reveal"] == {
        "position": 1,
        "choiceIndex": 2,
        "correct": True,
        "timedOut": False,
        "answerIndex": 2,
        "explanation": "정답 해설",
    }
    assert payload["scores"] == [
        {
            "playerId": str(PLAYER_ID),
            "nickname": "퀴즈왕",
            "characterId": "slime-blue",
            "score": 0,
            "correctCount": 0,
            "answeredCount": 0,
        }
    ]


def test_active_match_payload_reports_remaining_time_measured_at_response() -> None:
    repository = MatchApiRepository()
    now = datetime(2026, 9, 18, 0, 0, 12, 500_000, tzinfo=UTC)

    running = _match_payload(repository.match, now)
    revealing = _match_payload(
        replace(
            repository.match,
            state="revealing",
            deadline_at="2026-09-18T00:00:28+00:00",
            own_answer=repository.answer,
        ),
        now,
    )
    finished = _match_payload(
        replace(repository.match, state="finished", deadline_at=None, question=None),
        now,
    )

    # 마감 시각과 함께 «응답 시점의 남은 양»을 보낸다. 브라우저 시계가 틀려도 표시가 맞는다.
    assert running["deadlineAt"] == "2026-09-18T00:00:20+00:00"
    assert running["remainingMs"] == 7_500
    # 공개 phase의 deadline은 다음 문제로 넘어가는 시각이다.
    assert revealing["remainingMs"] == 15_500
    assert finished["remainingMs"] is None


def test_match_payload_carries_the_question_time_the_host_chose_for_the_room() -> None:
    # 남은 시간 막대의 «가득»이 방장이 고른 시간이다. 늦게 받은 첫 응답의 남은 시간이 아니다.
    repository = MatchApiRepository()
    now = datetime(2026, 9, 18, 0, 0, 12, 500_000, tzinfo=UTC)
    forty = replace(repository.match, question_time_ms=40_000)

    for state, deadline, question in (
        ("running", "2026-09-18T00:00:40+00:00", forty.question),
        ("revealing", "2026-09-18T00:00:48+00:00", forty.question),
        ("finished", None, None),
    ):
        payload = _match_payload(
            replace(forty, state=state, deadline_at=deadline, question=question),
            now,
        )
        assert payload["questionTimeMs"] == 40_000, state
    assert _match_payload(repository.match, now)["questionTimeMs"] == 20_000

    repository.match = forty
    with _client(repository) as client:
        response = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["questionTimeMs"] == 40_000


def test_remaining_time_never_goes_negative_after_the_deadline() -> None:
    repository = MatchApiRepository()
    late = datetime(2026, 9, 18, 0, 1, 0, tzinfo=UTC)

    assert _match_payload(repository.match, late)["remainingMs"] == 0

    with _client(repository) as client:
        response = client.get("/v1/rooms/ABC234/match", headers=HEADERS)

    assert response.status_code == 200
    # 고정된 테스트 마감은 이미 지났다. 판정은 서버가 하고 표시는 0에서 멈춘다.
    assert response.json()["remainingMs"] == 0


def test_answer_submission_is_rate_limited_per_player_and_room() -> None:
    repository = MatchApiRepository()
    with _client(repository) as client:
        responses = [
            client.post(
                "/v1/rooms/ABC234/match/answers",
                headers=HEADERS,
                json={"position": 1, "choiceIndex": 2},
            )
            for _ in range(9)
        ]

    assert [response.status_code for response in responses[:8]] == [200] * 8
    assert responses[8].status_code == 429
    assert responses[8].json()["detail"]["code"] == "rate-limited"
    # 답안 몫은 30초 창이다. 언제 다시 낼 수 있는지 초로 말한다 (N01)
    assert 25 <= int(responses[8].headers["retry-after"]) <= 30


def test_match_answer_rejects_an_out_of_range_choice_index_before_repository() -> None:
    repository = MatchApiRepository()
    app = create_app(repository=cast(RoomsRepository, repository))
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post(
            "/v1/rooms/ABC234/match/answers",
            headers=HEADERS,
            json={"position": 1, "choiceIndex": 4},
        )

    assert response.status_code == 422


def _scored(*, last_answer_correct: bool | None) -> MatchScoreView:
    return MatchScoreView(
        player_id=PLAYER_ID,
        nickname="퀴즈왕",
        character_id="slime-blue",
        score=10,
        correct_count=1,
        answered_count=1,
        last_answer_correct=last_answer_correct,
    )


_REVIEW = MatchReviewView(
    position=1,
    question_id="history-001",
    category_id="history",
    question="역사 문제",
    choices=("1", "2", "3", "4"),
    answer_index=2,
    explanation="정답 해설",
    choice_index=1,
    correct=False,
    timed_out=False,
)


def test_per_player_correctness_is_sent_only_while_revealing() -> None:
    # 공개 단계의 «정답 n/m명»·이름표 ✓/✗ (U30). 아직 답을 고르는 사람에게는 남의 정오가 가지 않는다
    repository = MatchApiRepository()
    scores = (_scored(last_answer_correct=True),)
    revealing = _match_payload(
        replace(repository.match, state="revealing", own_answer=repository.answer, scores=scores)
    )
    running = _match_payload(replace(repository.match, scores=scores))
    finished = _match_payload(
        replace(repository.match, state="finished", deadline_at=None, question=None, scores=scores)
    )

    assert revealing["scores"] == [
        {
            "playerId": str(PLAYER_ID),
            "nickname": "퀴즈왕",
            "characterId": "slime-blue",
            "score": 10,
            "correctCount": 1,
            "answeredCount": 1,
            "lastAnswerCorrect": True,
        }
    ]
    assert running["scores"] == []
    finished_scores = cast(list[dict[str, object]], finished["scores"])
    assert "lastAnswerCorrect" not in finished_scores[0]


def test_question_review_exists_only_in_the_finished_snapshot() -> None:
    # «문제 다시 보기»(U38). 판이 끝나기 전의 응답에는 키조차 없다
    repository = MatchApiRepository()
    running = _match_payload(replace(repository.match, review=(_REVIEW,)))
    revealing = _match_payload(
        replace(
            repository.match,
            state="revealing",
            own_answer=repository.answer,
            review=(_REVIEW,),
        )
    )
    finished_match = replace(
        repository.match,
        state="finished",
        deadline_at=None,
        question=None,
        review=(_REVIEW,),
    )
    repository.match = finished_match

    with _client(repository) as client:
        response = client.get("/v1/rooms/ABC234/match", headers=HEADERS)

    assert "review" not in running
    assert "review" not in revealing
    assert response.status_code == 200
    assert response.json()["review"] == [
        {
            "position": 1,
            "id": "history-001",
            "categoryId": "history",
            "question": "역사 문제",
            "choices": ["1", "2", "3", "4"],
            "answerIndex": 2,
            "explanation": "정답 해설",
            "choiceIndex": 1,
            "correct": False,
            "timedOut": False,
        }
    ]
    assert _match_payload(replace(finished_match, review=()))["review"] == []


def test_the_room_socket_keeps_standing_answers_without_broadcasting_them() -> None:
    # U13: 화면이 실제로 움직인 뒤 선 칸을 초안으로 보낸다. API는 메모리에 두기만 하고 방에
    # 퍼뜨리지 않는다 — 남의 발밑 칸은 아직 고르는 사람에게 보이지 않는다. null은 칸에서
    # 내려선 것이다.
    repository = MatchApiRepository()
    standing = StandingAnswers()
    app = create_app(repository=cast(RoomsRepository, repository), standing_answers=standing)
    movement = {"type": "movement", "x": 0.5, "y": 0.5, "moving": False}
    draft = {"type": "standing-answer", "matchId": str(MATCH_ID), "position": 1}
    with TestClient(app) as client:
        ticket_body = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()
        # 소켓마다 다시 묻는 capability다. 이 값을 주지 않는 이전 API에는 화면이 초안을
        # 보내지 않는다
        assert ticket_body["standingAnswer"] == "standing-answer-v1"
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket_body["ticket"]),
        ) as websocket:
            websocket.send_json({**draft, "choiceIndex": 3})
            # 같은 소켓의 메시지는 차례로 처리된다. 뒤의 이동이 먼저 방송되면 초안은 방송되지 않았다
            websocket.send_json(movement)
            first = websocket.receive_json()
            stored = standing.for_question("ABC234", MATCH_ID, 1)

            websocket.send_json({**draft, "choiceIndex": None})
            websocket.send_json(movement)
            second = websocket.receive_json()
            cleared = standing.for_question("ABC234", MATCH_ID, 1)

    assert first["type"] == "movement"
    assert second["type"] == "movement"
    assert set(stored) == {PLAYER_ID}
    assert stored[PLAYER_ID].choice_index == 3
    assert cleared == {}


def test_match_reads_hand_the_standing_answers_to_the_repository_and_settle_them() -> None:
    repository = MatchApiRepository()
    standing = StandingAnswers()
    standing.record("ABC234", PLAYER_ID, match_id=MATCH_ID, position=1, choice_index=1)
    app = create_app(repository=cast(RoomsRepository, repository), standing_answers=standing)
    with TestClient(app) as client:
        ready = client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": True})
        running = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
        kept = dict(standing.for_question("ABC234", MATCH_ID, 1))
        answered = client.post(
            "/v1/rooms/ABC234/match/answers",
            headers=HEADERS,
            json={"position": 1, "choiceIndex": 2},
        )
        repository.match = replace(repository.match, state="revealing")
        revealing = client.get("/v1/rooms/ABC234/match", headers=HEADERS)

    # 방장 혼자서도 연다는 것과 발밑 칸 규칙을 응답이 싣는다 — 화면은 없으면 이전 규칙으로 읽는다
    assert ready.json()["minPlayers"] == 1
    assert running.json()["standingAnswers"] is True
    assert revealing.json()["standingAnswers"] is True
    assert repository.standing_sources == [standing, standing, standing]
    # 도는 문항의 초안은 남기고, 그 문항이 공개되면 버린다
    assert set(kept) == {PLAYER_ID}
    assert answered.status_code == 200
    assert standing.for_question("ABC234", MATCH_ID, 1) == {}


class SettlingExpiryRepository(MatchApiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.sweep_sources: list[StandingAnswerSource | None] = []
        self.pending = [
            [ExpiredMatchAdvance(code="ABC234", finished=False, match_id=MATCH_ID, position=1)],
        ]

    async def advance_expired_matches(
        self,
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> list[ExpiredMatchAdvance]:
        self.sweep_sources.append(standing_answers)
        return self.pending.pop(0) if self.pending else []


def test_the_expiry_sweep_uses_and_then_forgets_the_closed_questions_drafts() -> None:
    repository = SettlingExpiryRepository()
    standing = StandingAnswers()
    standing.record("ABC234", PLAYER_ID, match_id=MATCH_ID, position=1, choice_index=0)
    standing.record("ABC234", OTHER_ID, match_id=MATCH_ID, position=2, choice_index=1)
    app = create_app(repository=cast(RoomsRepository, repository), standing_answers=standing)
    with TestClient(app) as client:
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            event = websocket.receive_json()

    assert event == {"type": "match-invalidated"}
    assert repository.sweep_sources[0] is standing
    assert standing.for_question("ABC234", MATCH_ID, 1) == {}
    assert set(standing.for_question("ABC234", MATCH_ID, 2)) == {OTHER_ID}


class NotReadyRepository(MatchApiRepository):
    async def start_game(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSetup:
        raise MatchNotReady


def test_a_refused_start_names_the_members_who_must_ready_up_not_a_head_count() -> None:
    # 방장 혼자서도 연다. 거절의 이유는 이제 인원이 아니라 준비하지 않은 참가자다
    with _client(NotReadyRepository()) as client:
        response = client.post("/v1/rooms/ABC234/start", headers=HEADERS)

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "not-ready"
    assert detail["message"] == "방장 말고 연결된 참가자가 모두 준비해야 시작할 수 있어요."
    assert "두 명" not in detail["message"]
