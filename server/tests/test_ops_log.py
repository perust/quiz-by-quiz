"""운영 기록 (`app/ops_log.py`) — 운영자가 `docker logs`로 읽는 한 줄 JSON.

사건은 정해진 칸만 싣고 개인 정보(닉네임·채팅·토큰·티켓·IP·player id·비밀번호·문항 내용)는 한
글자도 싣지 않는다. 5분 요약은 고정 크기 칸으로만 센다. uvicorn을 `--log-level warning`으로 돌려도
INFO 한 줄이 stderr로 나가야 한다(server/Dockerfile의 CMD).
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import sys
import time
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app import ops_log
from app.main import RELEASE_SCHEMA_VERSION, EventHub, create_app
from app.repository import (
    AccessInfo,
    CleanupCounts,
    MatchAnswerView,
    MatchQuestionView,
    MatchRead,
    MatchReviewView,
    MatchScoreView,
    MatchSetup,
    MatchSubmission,
    MatchView,
    PlayerView,
    RoomCounts,
    RoomView,
)

PLAYER_ID = UUID("12345678-1234-5678-9234-567812345678")
OTHER_ID = UUID("87654321-4321-4765-8321-876543218765")
MATCH_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
PLAYER_TOKEN = "ops-log-token-with-at-least-thirty-two-characters"  # noqa: S105
FORWARDED_IP = "203.0.113.77"
HEADERS = {
    "Authorization": f"Bearer {PLAYER_TOKEN}",
    "X-Player-Id": str(PLAYER_ID),
    "X-Forwarded-For": FORWARDED_IP,
}
NICKNAME = "비밀닉네임"
OTHER_NICKNAME = "숨은참가자"
ROOM_NAME = "비밀방이름"
ROOM_PASSWORD = "pw-sec-7391"  # noqa: S105 - inert test value
CHAT_TEXT = "비밀 채팅 내용"
# 판이 도는 동안 응답을 실제로 지나가는 문항(번호·질문·보기·해설) — 운영 기록에는 없어야 한다
QUESTION_ID = "sci-secret-9041"
QUESTION_TEXT = "비밀 문항 내용?"
CHOICES = ("비밀 보기 하나", "비밀 보기 둘", "비밀 보기 셋", "비밀 보기 넷")
EXPLANATION = "비밀 해설 문장"
# 어느 운영 기록 줄에도 나오면 안 되는 값
SECRETS = (
    NICKNAME,
    OTHER_NICKNAME,
    ROOM_NAME,
    ROOM_PASSWORD,
    CHAT_TEXT,
    QUESTION_ID,
    QUESTION_TEXT,
    *CHOICES,
    EXPLANATION,
    PLAYER_TOKEN,
    hashlib.sha256(PLAYER_TOKEN.encode()).hexdigest(),
    str(PLAYER_ID),
    str(OTHER_ID),
    FORWARDED_IP,
)
# 칸 이름으로도 두지 않는다. 문항 «수»(questions)와 문항 «시간»(questionTimeMs)은 내용이 아니다.
FORBIDDEN_FIELD_PARTS = (
    "nick",
    "name",
    "chat",
    "text",
    "token",
    "ticket",
    "forward",
    "address",
    "password",
    "playerid",
    "player_id",
    "choice",
    "answer",
    "explanation",
)
FORBIDDEN_FIELD_NAMES = frozenset({"ip", "client", "player", "question", "id", "message"})


@pytest.fixture
def ops_lines() -> Iterator[list[str]]:
    """운영 logger가 낸 줄을 그대로(JSON 문자열) 모은다. 운영 logger는 root로 퍼뜨리지 않는다."""
    ops_log.install()
    lines: list[str] = []
    formatter = ops_log.JsonLineFormatter()

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(formatter.format(record))

    handler = Collect(logging.INFO)
    ops_log.logger.addHandler(handler)
    try:
        yield lines
    finally:
        ops_log.logger.removeHandler(handler)


def events(lines: list[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in lines]


def wait_until(predicate: Any, message: str, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(message)


# ── 사건의 모양 ──────────────────────────────────────────────────────────────


def _emit_every_event() -> None:
    window = ops_log.RequestWindow()
    window.record(200, 12.0)
    ops_log.api_started(schema_version=12)
    ops_log.api_stopped()
    ops_log.room_created(
        "ABC234", capacity=4, category_id=None, question_time_ms=20_000, locked=False
    )
    ops_log.room_deleted("ABC234", reason="empty")
    ops_log.member_joined("ABC234", players=2)
    ops_log.member_left("ABC234", players=1)
    ops_log.member_removed("ABC234", players=1, blocked=True)
    ops_log.host_transferred("ABC234", reason="host-absent")
    ops_log.match_started(
        "ABC234", players=2, category_id="science", question_time_ms=40_000, questions=10
    )
    ops_log.match_finished("ABC234", via="sweep")
    ops_log.cleanup(CleanupCounts(rooms_deleted=1, members_removed=2, rankings_pruned=3))
    ops_log.server_error("GET", "/v1/rooms/{raw_code}", RuntimeError("boom"))
    ops_log.summary(
        window_seconds=300.2,
        stats=window.take(),
        sockets=3,
        players=2,
        rooms=RoomCounts(waiting_rooms=1, playing_rooms=1, running_matches=1),
    )


def test_every_event_carries_exactly_its_declared_fields(ops_lines: list[str]) -> None:
    _emit_every_event()

    seen = events(ops_lines)
    assert [event["event"] for event in seen] == list(ops_log.EVENT_FIELDS)
    for event in seen:
        assert set(event) == {"event", "ts"} | ops_log.EVENT_FIELDS[event["event"]], event
        # UTC 밀리초 ISO 8601
        assert event["ts"].endswith("Z") and len(event["ts"]) == len("2026-10-27T03:14:15.926Z")
    # 한 줄에 JSON 하나
    assert all("\n" not in line for line in ops_lines)


def test_declared_fields_never_name_personal_data() -> None:
    names = set().union(*ops_log.EVENT_FIELDS.values())
    for name in names:
        lowered = name.lower()
        assert lowered not in FORBIDDEN_FIELD_NAMES, name
        assert not any(part in lowered for part in FORBIDDEN_FIELD_PARTS), name


def test_events_carry_the_expected_values(ops_lines: list[str]) -> None:
    _emit_every_event()

    by_name = {event["event"]: event for event in events(ops_lines)}
    assert by_name["api_started"]["schemaVersion"] == 12
    assert by_name["room_created"] | {"ts": None} == {
        "event": "room_created",
        "ts": None,
        "room": "ABC234",
        "capacity": 4,
        "category": "all",
        "questionTimeMs": 20_000,
        "locked": False,
    }
    assert by_name["match_started"]["category"] == "science"
    assert by_name["match_started"]["questionTimeMs"] == 40_000
    assert by_name["match_started"]["players"] == 2
    assert by_name["cleanup"]["roomsDeleted"] == 1
    assert by_name["cleanup"]["membersRemoved"] == 2
    assert by_name["cleanup"]["hostsTransferred"] == 0
    # 보존 기간을 넘겨 지운 랭킹 기록도 수만 남긴다 (migration 012)
    assert by_name["cleanup"]["rankingsPruned"] == 3
    assert by_name["server_error"] | {"ts": None} == {
        "event": "server_error",
        "ts": None,
        "method": "GET",
        "route": "/v1/rooms/{raw_code}",
        "error": "RuntimeError",
    }
    summary = by_name["summary"]
    assert summary["windowSeconds"] == 300
    assert summary["rooms"] == {"waiting": 1, "playing": 1}
    assert summary["matches"] == 1
    assert summary["requests"] == {"total": 1, "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 0}


def test_unexpected_values_are_replaced_rather_than_logged(ops_lines: list[str]) -> None:
    ops_log.room_created(
        "abc 234<script>", capacity=4, category_id="고양이", question_time_ms=20_000, locked=True
    )
    ops_log.host_transferred("ABC234", reason=NICKNAME)
    ops_log.server_error(NICKNAME, f"/v1/rooms/{NICKNAME}?x=1", ValueError(NICKNAME))

    created, transferred, failed = events(ops_lines)
    assert created["room"] == "<invalid>"
    assert created["category"] == "<invalid>"
    assert transferred["reason"] == "<invalid>"
    assert failed["method"] == "OTHER"
    assert failed["route"] == "<unmatched>"
    assert failed["error"] == "ValueError"
    assert all(NICKNAME not in line for line in ops_lines)


# ── API에서 실제로 나는 사건 ─────────────────────────────────────────────────


def _room(**changes: Any) -> RoomView:
    base = RoomView(
        code="ABC234",
        name=ROOM_NAME,
        category_id="science",
        capacity=4,
        game_mode=True,
        players=(PlayerView(id=PLAYER_ID, nickname=NICKNAME, character_id="slime-blue"),),
        is_public=False,
        has_password=True,
        is_mine=True,
        joined=True,
        created_at="2026-10-27T00:00:00+00:00",
        question_time_ms=40_000,
    )
    return replace(base, **changes)


QUESTION = MatchQuestionView(
    id=QUESTION_ID,
    category_id="science",
    question=QUESTION_TEXT,
    choices=CHOICES,
    position=1,
    total=10,
)
ANSWER = MatchAnswerView(
    position=1,
    choice_index=2,
    correct=False,
    timed_out=False,
    answer_index=1,
    explanation=EXPLANATION,
)
SCORES = (
    MatchScoreView(
        player_id=PLAYER_ID,
        nickname=NICKNAME,
        character_id="slime-blue",
        score=0,
        correct_count=0,
        answered_count=1,
        last_answer_correct=False,
    ),
    MatchScoreView(
        player_id=OTHER_ID,
        nickname=OTHER_NICKNAME,
        character_id="slime-red",
        score=10,
        correct_count=1,
        answered_count=1,
        last_answer_correct=True,
    ),
)
REVIEW = (
    MatchReviewView(
        position=1,
        question_id=QUESTION_ID,
        category_id="science",
        question=QUESTION_TEXT,
        choices=CHOICES,
        answer_index=1,
        explanation=EXPLANATION,
        choice_index=2,
        correct=False,
        timed_out=False,
    ),
)


def _match(state: str, **changes: Any) -> MatchView:
    base = MatchView(
        id=MATCH_ID,
        state=state,
        category_id="science",
        game_mode=True,
        current_position=1,
        total_questions=10,
        deadline_at=None,
        question=QUESTION,
        own_answer=None,
        scores=SCORES,
        question_time_ms=40_000,
    )
    return replace(base, **changes)


class OpsRepository:
    """방 하나의 일생을 흉내 낸다. 모든 값에 개인 정보를 담아 운영 기록으로 새는지 본다.

    판도 문항 하나를 실제로 내보낸다 — 도는 판의 질문·보기, 공개의 해설·점수(닉네임),
    끝난 판의 «문제 다시 보기»가 응답을 지나가므로 문항 내용의 부재 검사가 헛돌지 않는다.
    """

    def __init__(self) -> None:
        self.room = _room()
        self.member = False
        self.leave_results: list[RoomView | None] = []
        self.match_reads: list[MatchRead] = [
            MatchRead(match=_match("running"), advanced=False),
            MatchRead(
                match=_match(
                    "finished",
                    current_position=10,
                    question=None,
                    own_answer=None,
                    review=REVIEW,
                ),
                advanced=True,
            ),
        ]
        self.counts: RoomCounts | Exception = RoomCounts(
            waiting_rooms=2, playing_rooms=1, running_matches=1
        )
        self.cleanup_result: CleanupCounts | None = None
        self.fail_list_rooms: Exception | None = None

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def health(self) -> bool:
        return True

    async def schema_version(self) -> int:
        return RELEASE_SCHEMA_VERSION

    async def upsert_player(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def authenticate(self, player_id: UUID, token_hash: bytes) -> bool:
        return player_id == PLAYER_ID and token_hash == hashlib.sha256(
            PLAYER_TOKEN.encode()
        ).digest()

    async def list_rooms(self, actor_id: UUID) -> list[RoomView]:
        if self.fail_list_rooms is not None:
            raise self.fail_list_rooms
        return [self.room]

    async def create_room(self, actor_id: UUID, spec: Any, password_hash: str | None) -> RoomView:
        self.room = _room(
            capacity=spec.capacity,
            category_id=spec.category_id,
            question_time_ms=spec.question_time_ms,
            has_password=password_hash is not None,
        )
        return self.room

    async def get_room(self, actor_id: UUID, code: str) -> RoomView | None:
        if self.fail_list_rooms is not None:
            raise self.fail_list_rooms
        return self.room if code == self.room.code else None

    async def get_access(self, code: str) -> AccessInfo | None:
        return AccessInfo(is_public=False, password_hash="encoded-room-lock")  # noqa: S106

    async def is_member(self, actor_id: UUID, code: str) -> bool:
        return self.member

    async def join_room(self, actor_id: UUID, code: str) -> RoomView:
        if self.member:
            return self.room
        self.member = True
        self.room = replace(
            self.room,
            players=(
                *self.room.players,
                PlayerView(id=OTHER_ID, nickname=OTHER_NICKNAME, character_id="slime-red"),
            ),
        )
        return self.room

    async def send_chat(self, actor_id: UUID, code: str, text: str) -> PlayerView:
        return self.room.players[0]

    async def start_game(self, actor_id: UUID, code: str, **kwargs: Any) -> MatchSetup:
        return MatchSetup(
            id=MATCH_ID,
            category_id=self.room.category_id,
            game_mode=True,
            total_questions=10,
            question_time_ms=self.room.question_time_ms,
            player_count=len(self.room.players),
        )

    async def get_match(self, actor_id: UUID, code: str, **kwargs: Any) -> MatchRead:
        return self.match_reads.pop(0)

    async def submit_answer(self, actor_id: UUID, code: str, **kwargs: Any) -> MatchSubmission:
        # 모두 답해 공개로 넘어갔다 — 응답에 해설과 점수판(닉네임)이 실린다
        return MatchSubmission(
            match=_match("revealing", own_answer=ANSWER), answer=ANSWER, advanced=True
        )

    async def remove_member(
        self, actor_id: UUID, code: str, player_id: UUID, **kwargs: Any
    ) -> RoomView:
        self.room = replace(
            self.room,
            players=tuple(player for player in self.room.players if player.id != player_id),
        )
        return self.room

    async def leave_room(self, actor_id: UUID, code: str, **kwargs: Any) -> RoomView | None:
        return self.leave_results.pop(0)

    async def ops_counts(self) -> RoomCounts:
        if isinstance(self.counts, Exception):
            raise self.counts
        return self.counts

    async def cleanup_expired_resources(self) -> CleanupCounts | None:
        return self.cleanup_result

    async def advance_expired_matches(self, **_kwargs: Any) -> list[Any]:
        return []


class AcceptingHasher:
    def hash(self, password: str) -> str:
        return "encoded-room-lock"

    def verify(self, encoded: str, password: str) -> bool:
        return True


def test_a_rooms_life_is_logged_without_any_personal_data(ops_lines: list[str]) -> None:
    repository = OpsRepository()
    successor = _room(
        players=(PlayerView(id=OTHER_ID, nickname=OTHER_NICKNAME, character_id="slime-red"),),
        is_mine=False,
        host_transferred=True,
    )
    repository.leave_results = [successor, None]
    app = create_app(repository=repository, password_hasher=AcceptingHasher())

    with TestClient(app) as client:
        session = client.put(
            "/v1/session",
            headers=HEADERS,
            json={"nickname": NICKNAME, "characterId": "slime-blue"},
        )
        assert session.status_code == 200
        created = client.post(
            "/v1/rooms",
            headers=HEADERS,
            json={
                "name": ROOM_NAME,
                "categoryId": "science",
                "capacity": 4,
                "questionTimeMs": 40_000,
                "isPublic": False,
                "password": ROOM_PASSWORD,
            },
        )
        assert created.status_code == 201, created.text
        joined = client.post(
            "/v1/rooms/ABC234/join", headers=HEADERS, json={"password": ROOM_PASSWORD}
        )
        assert joined.status_code == 200, joined.text
        # 이미 들어간 사람이 다시 참가해도 새 참가가 아니다
        assert client.post("/v1/rooms/ABC234/join", headers=HEADERS, json={}).status_code == 200
        chat = client.post("/v1/rooms/ABC234/chat", headers=HEADERS, json={"text": CHAT_TEXT})
        assert chat.status_code == 202
        assert client.post("/v1/rooms/ABC234/start", headers=HEADERS).status_code == 201
        # 문항 내용이 실제로 응답을 지나간다 — 운영 기록에만 없어야 한다
        running = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
        assert running.status_code == 200, running.text
        assert running.json()["question"] == {
            "id": QUESTION_ID,
            "categoryId": "science",
            "question": QUESTION_TEXT,
            "choices": list(CHOICES),
            "position": 1,
            "total": 10,
        }
        answered = client.post(
            "/v1/rooms/ABC234/match/answers",
            headers=HEADERS,
            json={"position": 1, "choiceIndex": 2},
        )
        assert answered.status_code == 200, answered.text
        revealed = answered.json()["match"]
        assert revealed["reveal"]["explanation"] == EXPLANATION
        assert [score["nickname"] for score in revealed["scores"]] == [NICKNAME, OTHER_NICKNAME]
        finished = client.get("/v1/rooms/ABC234/match", headers=HEADERS)
        assert finished.status_code == 200, finished.text
        review = finished.json()["review"]
        assert [(item["id"], item["question"], item["explanation"]) for item in review] == [
            (QUESTION_ID, QUESTION_TEXT, EXPLANATION)
        ]
        assert review[0]["choices"] == list(CHOICES)
        removed = client.delete(
            f"/v1/rooms/ABC234/members/{OTHER_ID}?connected=true", headers=HEADERS
        )
        assert removed.status_code == 200, removed.text
        assert client.delete("/v1/rooms/ABC234/members/me", headers=HEADERS).status_code == 204
        assert client.delete("/v1/rooms/ABC234/members/me", headers=HEADERS).status_code == 204

    # 먼저 본다 — 새는 줄이 있으면 어느 값이 샜는지로 실패한다
    for line in ops_lines:
        for secret in SECRETS:
            assert secret not in line, (secret, line)
    seen = [event for event in events(ops_lines) if event["event"] != "summary"]
    assert [event["event"] for event in seen] == [
        "api_started",
        "room_created",
        "member_joined",
        "match_started",
        "match_finished",
        "member_removed",
        "member_left",
        "host_transferred",
        "member_left",
        "room_deleted",
        "api_stopped",
    ]
    strip = [{key: value for key, value in event.items() if key != "ts"} for event in seen]
    assert strip[1] == {
        "event": "room_created",
        "room": "ABC234",
        "capacity": 4,
        "category": "science",
        "questionTimeMs": 40_000,
        "locked": True,
    }
    assert strip[2] == {"event": "member_joined", "room": "ABC234", "players": 2}
    assert strip[3] == {
        "event": "match_started",
        "room": "ABC234",
        "players": 2,
        "category": "science",
        "questionTimeMs": 40_000,
        "questions": 10,
    }
    assert strip[4] == {"event": "match_finished", "room": "ABC234", "via": "request"}
    assert strip[5] == {"event": "member_removed", "room": "ABC234", "players": 1, "blocked": True}
    assert strip[6] == {"event": "member_left", "room": "ABC234", "players": 1}
    assert strip[7] == {"event": "host_transferred", "room": "ABC234", "reason": "host-left"}
    assert strip[8] == {"event": "member_left", "room": "ABC234", "players": 0}
    assert strip[9] == {"event": "room_deleted", "room": "ABC234", "reason": "empty"}


def test_an_unhandled_error_logs_only_the_route_template_and_exception_class(
    ops_lines: list[str],
) -> None:
    repository = OpsRepository()
    # 예외 메시지는 SQL 값·닉네임·주소를 담을 수 있다
    repository.fail_list_rooms = RuntimeError(f"{NICKNAME} {FORWARDED_IP} SELECT secret")
    app = create_app(repository=repository, ops_summary_interval_seconds=0.05)

    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/v1/rooms", headers=HEADERS).status_code == 500
        assert client.get("/v1/rooms/ABC234", headers=HEADERS).status_code == 500
        wait_until(
            lambda: sum(
                event["unhandled"] for event in events(ops_lines) if event["event"] == "summary"
            )
            == 2,
            "the summary did not count both unhandled errors",
        )

    failures = [event for event in events(ops_lines) if event["event"] == "server_error"]
    assert [(event["method"], event["route"], event["error"]) for event in failures] == [
        ("GET", "/v1/rooms", "RuntimeError"),
        ("GET", "/v1/rooms/{raw_code}", "RuntimeError"),
    ]
    summaries = [event for event in events(ops_lines) if event["event"] == "summary"]
    assert sum(event["requests"]["5xx"] for event in summaries) == 2
    for line in ops_lines:
        assert "SELECT secret" not in line
        for secret in SECRETS:
            assert secret not in line, (secret, line)


def test_cleanup_logs_one_line_only_when_something_changed(ops_lines: list[str]) -> None:
    repository = OpsRepository()
    repository.cleanup_result = CleanupCounts(rooms_deleted=2, members_removed=3, players_deleted=4)
    app = create_app(repository=repository, cleanup_interval_seconds=0.05)

    with TestClient(app):
        wait_until(
            lambda: any(event["event"] == "cleanup" for event in events(ops_lines)),
            "cleanup was not logged",
        )
        repository.cleanup_result = CleanupCounts()
        logged = sum(event["event"] == "cleanup" for event in events(ops_lines))
        time.sleep(0.3)
        # 빈 정리는 줄을 내지 않는다(60초마다 한 줄이 쌓이지 않는다)
        assert sum(event["event"] == "cleanup" for event in events(ops_lines)) <= logged + 1

    first = next(event for event in events(ops_lines) if event["event"] == "cleanup")
    assert first["roomsDeleted"] == 2
    assert first["membersRemoved"] == 3
    assert first["hostsTransferred"] == 0
    assert first["playersDeleted"] == 4
    assert first["rankingsPruned"] == 0


# ── 5분 요약 ─────────────────────────────────────────────────────────────────


def test_request_window_reads_percentiles_from_fixed_buckets() -> None:
    window = ops_log.RequestWindow()
    for _ in range(50):
        window.record(200, 3.0)
    for _ in range(40):
        window.record(201, 40.0)
    for _ in range(4):
        window.record(404, 40.0)
    window.record(429, 41.0)
    for _ in range(4):
        window.record(503, 700.0)
    window.record(500, 701.5)
    window.record_unhandled()

    stats = window.take()

    assert stats.requests == {"total": 100, "2xx": 90, "3xx": 0, "4xx": 5, "5xx": 5}
    assert stats.rate_limited == 1
    assert stats.unhandled == 1
    # 50번째는 ≤5ms 칸, 95번째는 ≤50ms 칸, 최댓값은 그대로
    assert stats.p50_ms == 5.0
    assert stats.p95_ms == 50.0
    assert stats.max_ms == 701.5

    # 읽으면 비운다
    empty = window.take()
    assert empty.requests == {"total": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0}
    assert (empty.p50_ms, empty.p95_ms, empty.max_ms) == (None, None, None)
    assert empty.rate_limited == 0 and empty.unhandled == 0


def test_request_window_never_reports_a_percentile_above_the_maximum() -> None:
    window = ops_log.RequestWindow()
    window.record(200, 0.4)
    window.record(200, 3.2)
    stats = window.take()
    # ≤5ms 칸이지만 관측한 최댓값은 3.2ms다
    assert (stats.p50_ms, stats.p95_ms, stats.max_ms) == (1.0, 3.2, 3.2)

    window.record(200, 25_000.0)
    stats = window.take()
    # 가장 큰 상한(10초)을 넘친 칸은 최댓값으로 읽는다
    assert (stats.p50_ms, stats.p95_ms, stats.max_ms) == (25_000.0, 25_000.0, 25_000.0)


def test_request_window_state_is_bounded_whatever_the_traffic() -> None:
    window = ops_log.RequestWindow()

    def footprint() -> dict[str, int]:
        return {
            name: len(value) if isinstance(value, list) else 1
            for name, value in vars(window).items()
        }

    before = footprint()
    for index in range(100_000):
        window.record(200 + (index % 4) * 100, float(index % 20_000))
    assert footprint() == before
    assert window.bucket_count == len(ops_log.LATENCY_BUCKETS_MS) + 1
    assert window.take().requests["total"] == 100_000
    assert footprint() == before


def test_request_window_rejects_unordered_buckets() -> None:
    with pytest.raises(ValueError):
        ops_log.RequestWindow((10, 5))
    with pytest.raises(ValueError):
        ops_log.RequestWindow(())


def test_summary_counts_rest_requests_by_class_and_reads_room_counts(
    ops_lines: list[str],
) -> None:
    repository = OpsRepository()
    app = create_app(repository=repository, ops_summary_interval_seconds=0.05)

    with TestClient(app) as client:
        # release gate는 IP당 12/60초다 — 열셋째는 429
        statuses = [client.get("/v1/release-readiness").status_code for _ in range(13)]
        assert statuses == [200] * 12 + [429]
        assert client.get("/v1/rooms").status_code == 401
        # 사설 헬스 체크는 세지 않는다
        assert client.get("/healthz").status_code == 200
        assert client.get("/readyz").status_code == 200

        def totals() -> dict[str, int]:
            summaries = [event for event in events(ops_lines) if event["event"] == "summary"]
            result = {"total": 0, "2xx": 0, "4xx": 0, "5xx": 0, "rateLimited": 0}
            for event in summaries:
                for key in ("total", "2xx", "4xx", "5xx"):
                    result[key] += event["requests"][key]
                result["rateLimited"] += event["rateLimited"]
            return result

        wait_until(lambda: totals()["total"] == 14, "summaries did not count 14 requests")
        time.sleep(0.15)

    assert totals() == {"total": 14, "2xx": 12, "4xx": 2, "5xx": 0, "rateLimited": 1}
    summaries = [event for event in events(ops_lines) if event["event"] == "summary"]
    for event in summaries:
        assert event["rooms"] == {"waiting": 2, "playing": 1}
        assert event["matches"] == 1
        assert event["sockets"] == 0
        assert event["players"] == 0
    counted = [event for event in summaries if event["requests"]["total"]]
    assert all(event["latencyMs"]["p50"] is not None for event in counted)
    assert all(
        event["latencyMs"]["p50"] <= event["latencyMs"]["p95"] <= event["latencyMs"]["max"]
        for event in counted
    )


def test_summary_reports_unknown_room_counts_when_the_database_fails(
    ops_lines: list[str],
) -> None:
    repository = OpsRepository()
    repository.counts = RuntimeError("database is down")
    app = create_app(repository=repository, ops_summary_interval_seconds=0.05)

    with TestClient(app):
        wait_until(
            lambda: any(event["event"] == "summary" for event in events(ops_lines)),
            "no summary was logged while the database failed",
        )

    summary = next(event for event in events(ops_lines) if event["event"] == "summary")
    assert summary["rooms"] is None
    assert summary["matches"] is None
    assert summary["latencyMs"] == {"p50": None, "p95": None, "max": None}


def test_summary_interval_must_be_positive() -> None:
    with pytest.raises(ValueError):
        create_app(repository=OpsRepository(), ops_summary_interval_seconds=0)
    with pytest.raises(ValueError):
        create_app(repository=OpsRepository(), ops_summary_interval_seconds=True)


def test_event_hub_counts_connected_members_once_per_room() -> None:
    class Socket:
        async def send_json(self, event: dict[str, object]) -> None:
            return None

        async def close(self, *, code: int) -> None:
            return None

    hub = EventHub()
    first, second_tab, other = Socket(), Socket(), Socket()
    assert hub.connect("ABC234", PLAYER_ID, first)
    assert hub.connect("ABC234", PLAYER_ID, second_tab)
    assert hub.connect("ABC234", OTHER_ID, other)
    assert hub.connection_count == 3
    # 같은 사람의 두 탭은 한 사람이다
    assert hub.live_member_count == 2
    hub.disconnect("ABC234", other)
    assert hub.live_member_count == 1


def test_the_deploy_guide_lists_every_event_and_what_is_never_logged() -> None:
    guide = (Path(__file__).resolve().parents[2] / "deploy" / "oracle" / "README.md").read_text(
        encoding="utf-8"
    )
    section = guide.split("## Operational log and uptime monitor", 1)[1]
    normalized = " ".join(section.split())
    for event in ops_log.EVENT_FIELDS:
        assert f"`{event}`" in section, event
    assert "**Never logged:**" in section
    for item in ("nicknames", "chat text", "WebSocket tickets", "IP addresses", "player ids"):
        assert item in normalized, item
    assert "docker compose … logs --no-log-prefix" in section
    # 스모크 점검 절 뒤에 붙인 새 절이다 — 배포 순서 절을 고쳐 쓰지 않는다
    assert guide.index("### Smoke test through Caddy") < guide.index(
        "## Operational log and uptime monitor"
    )


# ── uvicorn --log-level warning 아래에서도 나간다 ────────────────────────────


def test_ops_lines_reach_stderr_under_the_runtime_uvicorn_logging() -> None:
    # Dockerfile의 CMD처럼 uvicorn이 `--log-level warning`으로 logging을 설정하고 app factory를
    # 부른다. uvicorn의 INFO(«Started server process» 같은)는 숨고 운영 기록의 INFO만 나와야 한다.
    script = """
import logging
import threading

import uvicorn

from app.main import create_app


class Repo:
    async def open(self):
        return None

    async def close(self):
        return None

    async def advance_expired_matches(self, **_kwargs):
        return []


config = uvicorn.Config(
    lambda: create_app(repository=Repo()),
    factory=True,
    host="127.0.0.1",
    port=0,
    log_level="warning",
    lifespan="on",
)
server = uvicorn.Server(config)
logging.getLogger("app.main").info("plain app info must stay hidden")
threading.Timer(1.5, lambda: setattr(server, "should_exit", True)).start()
server.run()
"""

    result = subprocess.run(  # noqa: S603 - fixed interpreter and script
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    lines = [line for line in result.stderr.splitlines() if line.strip()]
    assert lines, "no ops line reached stderr"
    parsed = [json.loads(line) for line in lines]
    assert [event["event"] for event in parsed] == ["api_started", "api_stopped"]
    assert parsed[0]["schemaVersion"] == RELEASE_SCHEMA_VERSION
    assert "plain app info" not in result.stderr
    assert "INFO" not in result.stderr
