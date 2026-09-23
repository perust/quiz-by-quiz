from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
from dataclasses import replace
from typing import cast
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
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

    async def start_game(self, actor_id: UUID, code: str) -> MatchSetup:
        assert actor_id == PLAYER_ID and code == self.room.code
        return MatchSetup(id=MATCH_ID, category_id="history", game_mode=True, total_questions=10)

    async def get_match(self, actor_id: UUID, code: str) -> MatchRead:
        assert actor_id == PLAYER_ID and code == self.room.code
        return MatchRead(match=self.match, advanced=self.match_advanced_on_read)

    async def submit_answer(
        self,
        actor_id: UUID,
        code: str,
        *,
        position: int,
        choice_index: int | None,
    ) -> MatchSubmission:
        assert actor_id == PLAYER_ID and code == self.room.code
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
