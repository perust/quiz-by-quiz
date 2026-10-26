from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
from dataclasses import replace
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.main import EventHub, _match_payload, create_app
from app.repository import (
    MatchAnswerView,
    MatchQuestionView,
    MatchRead,
    MatchScoreView,
    MatchSetup,
    MatchSubmission,
    MatchView,
    PlayerView,
    RoomsRepository,
    RoomView,
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
    ) -> MatchRead:
        assert actor_id == PLAYER_ID and code == self.room.code
        self.match_absent_player_ids.append(absent_player_ids)
        return MatchRead(match=self.match, advanced=self.match_advanced_on_read)

    async def submit_answer(
        self,
        actor_id: UUID,
        code: str,
        *,
        position: int,
        choice_index: int | None,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSubmission:
        assert actor_id == PLAYER_ID and code == self.room.code
        self.answer_absent_player_ids.append(absent_player_ids)
        assert position == 1 and choice_index == 2
        self.match = replace(self.match, own_answer=self.answer)
        return MatchSubmission(match=self.match, answer=self.answer, advanced=False)

    async def advance_expired_matches(self) -> list[str]:
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


def test_match_answer_broadcast_only_invalidates_other_clients() -> None:
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
            event = websocket.receive_json()

    assert response.status_code == 200
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

    async def transfer_absent_host(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
    ) -> bool:
        return False

    async def advance_past_absent_players(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
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
            events = [websocket.receive_json(), websocket.receive_json()]

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
