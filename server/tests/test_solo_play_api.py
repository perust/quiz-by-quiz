"""혼자 푸는 온라인 판 (FR-7.13 3단계)의 API 계약: POST /v1/solo, 내 최고 기록, 내 기록 내보내기.

홈의 분야 칸·전체 도전이 대기실을 거치지 않고 곧바로 판을 연다. 그 방은 그 사람에게만 보이고 남이
들어오지 못한다. 기록은 #108의 서버 랭킹 그대로이고, 홈의 별 점수·결과의 최고 기록 비교(FR-5.7)와
기록 내보내기(N02)는 인증된 신분(player id + 토큰에서 나온 주인 열쇠)의 기록만 읽는다.
실제 DB에서의 동작은 test_solo_play_integration.py가 본다.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from dataclasses import replace
from typing import Any
from uuid import UUID

from test_api import (
    HEADERS,
    MATCH_ID,
    PLAYER_ID,
    PLAYER_TOKEN,
    FakeRepository,
    make_client,
    room_view,
)

from app import ops_log
from app.main import OWN_BEST_ACTOR_LIMIT, SOLO_ACTOR_LIMIT
from app.repository import (
    OWN_RECORDS_LIMIT,
    RANKING_BOARDS,
    AccessInfo,
    MatchInProgress,
    MatchSetup,
    OwnBestView,
    OwnRecordsView,
    OwnRecordView,
    SoloStart,
    ranking_owner_key,
)

OWNER_KEY = ranking_owner_key(hashlib.sha256(PLAYER_TOKEN.encode("utf-8")).digest())
SOLO_CODE = "SQL234"


def solo_room(**changes: Any) -> Any:
    return room_view(
        code=SOLO_CODE,
        name="혼자 하기",
        capacity=2,
        is_public=True,
        has_password=False,
        solo=True,
        **changes,
    )


class SoloRepository(FakeRepository):
    def __init__(self) -> None:
        super().__init__()
        self.solo_calls: list[Any] = []
        self.solo_result: SoloStart | Exception = SoloStart(
            room=solo_room(status="playing", in_match=True),
            match=MatchSetup(
                id=MATCH_ID,
                category_id="science",
                game_mode=True,
                total_questions=10,
                question_time_ms=40_000,
                player_count=1,
            ),
            created=True,
        )
        self.best_calls: list[dict[str, Any]] = []
        self.best: dict[str, OwnBestView | None] = dict.fromkeys(RANKING_BOARDS)
        self.best["science"] = OwnBestView(
            score=80, correct_count=8, total_count=10, recorded_at="2026-10-27T01:00:00+00:00"
        )
        self.records_calls: list[dict[str, Any]] = []
        self.records = OwnRecordsView(
            records=(
                OwnRecordView(
                    board="science",
                    score=80,
                    correct_count=8,
                    total_count=10,
                    question_time_ms=40_000,
                    nickname="퀴즈왕",
                    recorded_at="2026-10-27T01:00:00+00:00",
                ),
                OwnRecordView(
                    board="all",
                    score=200,
                    correct_count=20,
                    total_count=25,
                    question_time_ms=20_000,
                    nickname="익명",
                    recorded_at="2026-10-26T01:00:00+00:00",
                ),
            ),
            truncated=False,
        )

    async def start_solo(self, actor_id: UUID, spec: Any) -> SoloStart:
        self.solo_calls.append((actor_id, spec))
        if isinstance(self.solo_result, Exception):
            raise self.solo_result
        return self.solo_result

    async def own_best_scores(
        self,
        *,
        actor_id: UUID,
        owner_key: bytes,
        exclude_match_id: UUID | None = None,
    ) -> Mapping[str, OwnBestView | None]:
        self.best_calls.append(
            {"actor_id": actor_id, "owner_key": owner_key, "exclude": exclude_match_id}
        )
        return self.best

    async def own_records(
        self,
        *,
        actor_id: UUID,
        owner_key: bytes,
        limit: int = OWN_RECORDS_LIMIT,
    ) -> OwnRecordsView:
        self.records_calls.append({"actor_id": actor_id, "owner_key": owner_key, "limit": limit})
        return self.records


def test_session_announces_solo_play_additively() -> None:
    with make_client(SoloRepository()) as client:
        session = client.put("/v1/session", headers=HEADERS, json={"nickname": "퀴즈왕"})

    assert session.status_code == 200
    # 화면은 이 필드로 홈의 분야 칸을 온라인 혼자 판으로 돌린다. 없으면 예전 혼자 하기(로컬)다
    assert session.json()["soloPlay"] is True


def test_solo_start_opens_a_match_at_once_without_a_waiting_room() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        response = client.post(
            "/v1/solo",
            headers=HEADERS,
            json={"categoryId": "science", "questionTimeMs": 40_000},
        )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["resumed"] is False
    assert body["match"] == {
        "matchId": str(MATCH_ID),
        "categoryId": "science",
        "gameMode": True,
        "totalQuestions": 10,
        "questionTimeMs": 40_000,
    }
    room = body["room"]
    assert room["code"] == SOLO_CODE
    assert room["solo"] is True
    assert room["status"] == "playing"
    # 판 번호(room-invalidated 줄이기)는 다른 방 snapshot과 같다
    assert isinstance(room["roomEpoch"], str) and type(room["roomVersion"]) is int
    (actor_id, spec), = repository.solo_calls
    assert actor_id == PLAYER_ID
    assert (spec.category_id, spec.question_time_ms, spec.capacity) == ("science", 40_000, 2)
    assert spec.is_public is True and spec.password is None


def test_solo_start_accepts_all_mode_and_only_twenty_or_forty_seconds() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        all_mode = client.post("/v1/solo", headers=HEADERS, json={"categoryId": None})
        # «제한 없음»은 연습(기록 안 남음)에만 있다 (PRD 10.2 #2의 기본값)
        unlimited = client.post(
            "/v1/solo", headers=HEADERS, json={"categoryId": None, "questionTimeMs": None}
        )
        thirty = client.post(
            "/v1/solo", headers=HEADERS, json={"categoryId": "art", "questionTimeMs": 30_000}
        )
        unknown = client.post("/v1/solo", headers=HEADERS, json={"categoryId": "music"})
        extra = client.post(
            "/v1/solo", headers=HEADERS, json={"categoryId": None, "capacity": 4}
        )

    assert all_mode.status_code == 201
    assert repository.solo_calls[0][1].category_id is None
    assert repository.solo_calls[0][1].question_time_ms == 20_000
    assert unlimited.status_code == 422
    assert thirty.status_code == 400
    assert thirty.json()["detail"]["code"] == "invalid-question-time"
    assert unknown.status_code == 400
    assert unknown.json()["detail"]["code"] == "invalid-category"
    # 정원·비밀번호 같은 다른 칸은 받지 않는다
    assert extra.status_code == 422
    assert len(repository.solo_calls) == 1


def test_solo_start_returns_the_running_match_as_resumed() -> None:
    repository = SoloRepository()
    repository.solo_result = SoloStart(room=solo_room(status="playing", in_match=True), match=None)
    with make_client(repository) as client:
        response = client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})

    assert response.status_code == 201
    assert response.json()["resumed"] is True
    assert response.json()["match"] is None
    assert response.json()["room"]["code"] == SOLO_CODE


def test_solo_start_requires_a_session_and_reports_a_stuck_room() -> None:
    repository = SoloRepository()
    repository.solo_result = MatchInProgress()
    with make_client(repository) as client:
        anonymous = client.post("/v1/solo", json={"categoryId": "history"})
        stuck = client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})

    assert anonymous.status_code == 401
    assert stuck.status_code == 409
    assert stuck.json()["detail"]["code"] == "game-in-progress"


def test_solo_start_is_rate_limited_per_player_with_retry_after() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        responses = [
            client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})
            for _ in range(SOLO_ACTOR_LIMIT + 1)
        ]

    assert [response.status_code for response in responses[:SOLO_ACTOR_LIMIT]] == [201] * (
        SOLO_ACTOR_LIMIT
    )
    assert responses[-1].status_code == 429
    assert responses[-1].headers["Retry-After"].isdigit()
    assert len(repository.solo_calls) == SOLO_ACTOR_LIMIT


def test_solo_start_logs_one_line_without_personal_data() -> None:
    ops_log.install()
    lines: list[str] = []
    formatter = ops_log.JsonLineFormatter()

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(formatter.format(record))

    handler = Collect(logging.INFO)
    ops_log.logger.addHandler(handler)
    try:
        with make_client(SoloRepository()) as client:
            client.post("/v1/solo", headers=HEADERS, json={"categoryId": "science"})
    finally:
        ops_log.logger.removeHandler(handler)

    events = [json.loads(line) for line in lines]
    solo = [event for event in events if event["event"] == "solo_started"]
    assert len(solo) == 1
    assert solo[0] | {"ts": None} == {
        "event": "solo_started",
        "ts": None,
        "room": SOLO_CODE,
        "created": True,
        "category": "science",
        "questionTimeMs": 40_000,
        "questions": 10,
    }
    # 혼자 판은 room_created·match_started를 따로 내지 않는다
    assert not [event for event in events if event["event"] in {"room_created", "match_started"}]
    assert all(str(PLAYER_ID) not in line and "퀴즈왕" not in line for line in lines)


def test_room_payload_carries_solo_only_for_solo_rooms() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        regular = client.get("/v1/rooms", headers=HEADERS)
        repository.room = solo_room()
        repository.member = True
        mine = client.get(f"/v1/rooms/{SOLO_CODE}", headers=HEADERS)

    assert regular.status_code == 200
    # 이전 화면과 다른 방에는 키가 없다 — 더하기만 한다
    assert "solo" not in regular.json()[0]
    assert mine.status_code == 200
    assert mine.json()["solo"] is True


def test_nobody_else_can_join_a_solo_room_by_code() -> None:
    repository = SoloRepository()
    repository.room = solo_room()

    async def solo_access(code: str) -> AccessInfo | None:
        if code != SOLO_CODE:
            return None
        return AccessInfo(is_public=True, password_hash=None, solo=True)

    repository.get_access = solo_access  # type: ignore[method-assign]
    with make_client(repository) as client:
        joined = client.post(f"/v1/rooms/{SOLO_CODE}/join", headers=HEADERS, json={})

    # «가득 찼다»가 아니라 «없는 방»이다 — 남의 혼자 방이 있다는 것도 알리지 않는다
    assert joined.status_code == 404
    assert joined.json()["detail"]["code"] == "not-found"
    assert repository.join_calls == 0


def test_own_best_scores_are_per_board_and_carry_no_identity() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        response = client.get("/v1/rankings/mine", headers=HEADERS)
        excluded = client.get(
            "/v1/rankings/mine", headers=HEADERS, params={"excludeMatch": str(MATCH_ID)}
        )
        broken = client.get(
            "/v1/rankings/mine", headers=HEADERS, params={"excludeMatch": "not-a-uuid"}
        )
        anonymous = client.get("/v1/rankings/mine")

    assert response.status_code == 200
    boards = response.json()["boards"]
    assert list(boards) == list(RANKING_BOARDS)
    assert boards["science"] == {
        "score": 80,
        "correctCount": 8,
        "totalCount": 10,
        "recordedAt": "2026-10-27T01:00:00+00:00",
    }
    assert boards["history"] is None
    # 신분은 응답에 없다 — 묻는 신분의 주인 열쇠로만 고른다
    assert str(PLAYER_ID) not in response.text
    assert repository.best_calls[0] == {
        "actor_id": PLAYER_ID,
        "owner_key": OWNER_KEY,
        "exclude": None,
    }
    # 결과 화면은 방금 닫힌 판을 빼고 «이 판 전의 최고 기록»과 견준다 (FR-5.7)
    assert excluded.status_code == 200
    assert repository.best_calls[1]["exclude"] == MATCH_ID
    assert broken.status_code == 400
    assert anonymous.status_code == 401
    assert len(repository.best_calls) == 2


def test_own_best_scores_reject_a_wrong_token_and_are_rate_limited() -> None:
    repository = SoloRepository()
    wrong = {**HEADERS, "Authorization": "Bearer " + "x" * 40}
    with make_client(repository) as client:
        refused = client.get("/v1/rankings/mine", headers=wrong)
        responses = [
            client.get("/v1/rankings/mine", headers=HEADERS)
            for _ in range(OWN_BEST_ACTOR_LIMIT + 1)
        ]

    assert refused.status_code == 401
    assert [response.status_code for response in responses[:OWN_BEST_ACTOR_LIMIT]] == [200] * (
        OWN_BEST_ACTOR_LIMIT
    )
    assert responses[-1].status_code == 429
    assert responses[-1].headers["Retry-After"].isdigit()


def test_own_records_export_the_players_server_records_without_identity() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        response = client.get("/v1/rankings/mine/records", headers=HEADERS)
        repository.records = replace(repository.records, truncated=True)
        truncated = client.get("/v1/rankings/mine/records", headers=HEADERS)
        anonymous = client.get("/v1/rankings/mine/records")

    assert response.status_code == 200
    assert response.json() == {
        "records": [
            {
                "mode": "category",
                "categoryId": "science",
                "score": 80,
                "correctCount": 8,
                "totalCount": 10,
                "questionTimeMs": 40_000,
                "nickname": "퀴즈왕",
                "recordedAt": "2026-10-27T01:00:00+00:00",
            },
            {
                "mode": "all",
                "categoryId": None,
                "score": 200,
                "correctCount": 20,
                "totalCount": 25,
                "questionTimeMs": 20_000,
                "nickname": "익명",
                "recordedAt": "2026-10-26T01:00:00+00:00",
            },
        ],
        "limit": OWN_RECORDS_LIMIT,
        "truncated": False,
    }
    assert str(PLAYER_ID) not in response.text
    assert repository.records_calls[0]["owner_key"] == OWNER_KEY
    assert truncated.json()["truncated"] is True
    assert anonymous.status_code == 401

