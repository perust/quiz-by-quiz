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
from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest
from test_api import (
    HEADERS,
    MATCH_ID,
    PLAYER_ID,
    PLAYER_TOKEN,
    FakeRepository,
    make_client,
    room_view,
)

from app import main as api_main
from app import ops_log
from app.main import (
    OWN_BEST_ACTOR_LIMIT,
    SOLO_ACTOR_LIMIT,
    SOLO_CLIENT_LIMIT,
    SOLO_CREATE_CLIENT_LIMIT,
    SOLO_CREATE_PROCESS_LIMIT,
    SOLO_CREATE_WINDOW_SECONDS,
)
from app.repository import (
    OWN_RECORDS_LIMIT,
    RANKING_BOARDS,
    SOLO_ROOM_CEILING,
    AccessInfo,
    EndedSoloMatch,
    MatchInProgress,
    MatchSetup,
    OwnBestView,
    OwnRecordsView,
    OwnRecordView,
    SoloCreateLimited,
    SoloEnd,
    SoloRoomsFull,
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
        # 화면이 보낸 restart(PRD 10.1 #11)를 저장소에 그대로 넘겼는가
        self.restart_flags: list[bool] = []
        self.end_calls: list[UUID] = []
        self.end_result = SoloEnd(code=None)
        # 이번 요청이 새 혼자 방을 만드는가. 만들 때만 저장소가 만드는 몫(`may_create`)을 먹는다
        self.creates = True
        self.create_charges = 0
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

    async def start_solo(
        self,
        actor_id: UUID,
        spec: Any,
        *,
        may_create: Callable[[], float | None] | None = None,
        restart: bool = False,
    ) -> SoloStart:
        self.solo_calls.append((actor_id, spec))
        self.restart_flags.append(restart)
        if isinstance(self.solo_result, Exception):
            raise self.solo_result
        if self.creates and may_create is not None:
            wait = may_create()
            if wait is not None:
                raise SoloCreateLimited(wait)
            self.create_charges += 1
        return self.solo_result

    async def end_solo(self, actor_id: UUID) -> SoloEnd:
        self.end_calls.append(actor_id)
        return self.end_result

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
    # 이 API는 «제한 없음»(questionTimeMs null, PRD 10.1 #9)과 다른 판을 골라 도는 판을 끝내고 새로
    # 열기(restart, #4)를 받는다. 이 둘이 없는 API에는 화면이 null도 restart도 보내지 않는다
    assert session.json()["soloUntimed"] is True
    assert session.json()["soloRestart"] is True


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


def test_solo_start_accepts_all_mode_twenty_forty_seconds_and_no_limit() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        all_mode = client.post("/v1/solo", headers=HEADERS, json={"categoryId": None})
        # 혼자 판은 «제한 없음»(null, 마감 없음)도 고른다 (PRD 10.1 #9, 소유자 결정)
        unlimited = client.post(
            "/v1/solo", headers=HEADERS, json={"categoryId": None, "questionTimeMs": None}
        )
        as_text = client.post(
            "/v1/solo", headers=HEADERS, json={"categoryId": None, "questionTimeMs": "none"}
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
    assert unlimited.status_code == 201
    assert repository.solo_calls[1][1].question_time_ms is None
    # 글자·실수 같은 다른 모양의 «제한 없음»은 받지 않는다
    assert as_text.status_code == 422
    assert thirty.status_code == 400
    assert thirty.json()["detail"]["code"] == "invalid-question-time"
    assert unknown.status_code == 400
    assert unknown.json()["detail"]["code"] == "invalid-category"
    # 정원·비밀번호 같은 다른 칸은 받지 않는다
    assert extra.status_code == 422
    assert len(repository.solo_calls) == 2
    # restart를 보내지 않으면 도는 판을 그대로 잇는다(예전 규칙)
    assert repository.restart_flags == [False, False]


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


def test_solo_start_answers_503_solo_busy_when_the_solo_room_ceiling_is_reached() -> None:
    # 혼자 방이 동시 한도까지 찼다. 5xx라 화면은 결정 #1처럼 연습(기록 안 남음)을 열고 그
    # 까닭을 말한다
    assert SOLO_ROOM_CEILING == 1_200
    repository = SoloRepository()
    repository.solo_result = SoloRoomsFull()
    with make_client(repository) as client:
        full = client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})

    assert full.status_code == 503
    assert full.json()["detail"]["code"] == "solo-busy"


def test_solo_room_creation_has_its_own_hourly_budget_that_reuse_never_pays(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 버리는 신분을 마구 만들어도 한 주소가 한 시간에 만드는 혼자 방은 이만큼이다. 다시 쓰는
    # 판은 먹지 않는다
    assert (SOLO_CREATE_CLIENT_LIMIT, SOLO_CREATE_PROCESS_LIMIT) == (720, 2_400)
    assert SOLO_CREATE_WINDOW_SECONDS == 3_600
    # 한 교실(36명)이 1분에 함께 판을 열어도(30번 남짓) 주소 칸에 든다
    assert SOLO_CLIENT_LIMIT == 120
    monkeypatch.setattr(api_main, "SOLO_CREATE_CLIENT_LIMIT", 2)
    repository = SoloRepository()
    with make_client(repository) as client:
        created = [
            client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})
            for _ in range(2)
        ]
        refused = client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})
        # 같은 혼자 방을 다시 쓰는 판(«다시 하기»·풀던 판)은 만드는 몫과 무관하다
        repository.creates = False
        reused = client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})

    assert [response.status_code for response in created] == [201, 201]
    assert refused.status_code == 429
    assert refused.json()["detail"]["code"] == "rate-limited"
    # 한 시간 창이다 — 1분 몫의 Retry-After(60초 안)와 다르다
    assert 3_500 <= int(refused.headers["Retry-After"]) <= 3_600
    assert reused.status_code == 201
    assert repository.create_charges == 2


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



# ── 소유자 결정: «제한 없음» 혼자 판(PRD 10.1 #9)과 다른 판을 골라 끝내고 새로 열기(#11) ──────


def _collect_ops() -> tuple[list[str], logging.Handler]:
    ops_log.install()
    lines: list[str] = []
    formatter = ops_log.JsonLineFormatter()

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(formatter.format(record))

    handler = Collect(logging.INFO)
    ops_log.logger.addHandler(handler)
    return lines, handler


def test_an_untimed_solo_start_says_no_deadline_additively() -> None:
    repository = SoloRepository()
    repository.solo_result = SoloStart(
        room=solo_room(status="playing", in_match=True, question_time_ms=None),
        match=MatchSetup(
            id=MATCH_ID,
            category_id="science",
            game_mode=True,
            total_questions=10,
            question_time_ms=None,
            player_count=1,
        ),
        created=True,
    )
    lines, handler = _collect_ops()
    try:
        with make_client(repository) as client:
            response = client.post(
                "/v1/solo",
                headers=HEADERS,
                json={"categoryId": "science", "questionTimeMs": None},
            )
    finally:
        ops_log.logger.removeHandler(handler)

    assert response.status_code == 201, response.text
    body = response.json()
    # 문항 시간 null과 함께 «마감 없음» 표시를 싣는다 — 화면은 이 표시가 있을 때만 null을 믿는다
    assert body["match"]["questionTimeMs"] is None and body["match"]["untimed"] is True
    assert body["room"]["questionTimeMs"] is None and body["room"]["untimed"] is True
    solo = [json.loads(line) for line in lines if '"solo_started"' in line]
    assert len(solo) == 1 and solo[0]["questionTimeMs"] is None


def test_timed_rooms_and_matches_carry_no_untimed_mark() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        started = client.post("/v1/solo", headers=HEADERS, json={"categoryId": "science"})
        rooms = client.get("/v1/rooms", headers=HEADERS)

    assert started.status_code == 201
    # 20초·40초 판·방에는 키조차 없다 — 이전 화면이 보던 모양 그대로다
    assert "untimed" not in started.json()["match"]
    assert "untimed" not in started.json()["room"]
    assert "untimed" not in rooms.json()[0]


def test_friend_rooms_still_refuse_no_time_limit() -> None:
    # 친구와 푸는 방은 그대로 20초·40초다 (앞선 소유자 결정) — 한 사람이 답하지 않으면 방 전체가
    # 멈춘다
    repository = SoloRepository()
    repository.member = True
    with make_client(repository) as client:
        created = client.post(
            "/v1/rooms",
            headers=HEADERS,
            json={
                "name": "친구 방",
                "categoryId": None,
                "capacity": 4,
                "isPublic": True,
                "questionTimeMs": None,
            },
        )
        patched = client.patch(
            f"/v1/rooms/{repository.room.code}", headers=HEADERS, json={"questionTimeMs": None}
        )

    assert created.status_code == 422
    assert patched.status_code == 400
    assert patched.json()["detail"]["code"] == "invalid-question-time"
    assert repository.create_calls == 0 and repository.update_calls == 0


def test_restart_ends_the_other_running_match_without_a_record_and_starts_this_one() -> None:
    repository = SoloRepository()
    ended_id = UUID("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
    repository.solo_result = replace(
        repository.solo_result,
        created=False,
        ended=EndedSoloMatch(
            match_id=ended_id,
            category_id="history",
            position=4,
            total_questions=10,
        ),
    )
    lines, handler = _collect_ops()
    try:
        with make_client(repository) as client:
            response = client.post(
                "/v1/solo",
                headers=HEADERS,
                json={"categoryId": "science", "questionTimeMs": 40_000, "restart": True},
            )
            not_bool = client.post(
                "/v1/solo", headers=HEADERS, json={"categoryId": "science", "restart": "yes"}
            )
    finally:
        ops_log.logger.removeHandler(handler)

    assert response.status_code == 201, response.text
    assert repository.restart_flags == [True]
    body = response.json()
    assert body["resumed"] is False and body["match"]["matchId"] == str(MATCH_ID)
    # 화면은 이것으로 «풀던 판은 기록 없이 끝냈어요»를 말한다
    assert body["ended"] == {"matchId": str(ended_id), "categoryId": "history", "recorded": False}
    assert not_bool.status_code == 422
    events = [json.loads(line) for line in lines]
    abandoned = [event for event in events if event["event"] == "solo_abandoned"]
    assert [event | {"ts": None} for event in abandoned] == [
        {
            "event": "solo_abandoned",
            "ts": None,
            "room": SOLO_CODE,
            "via": "restart",
            "position": 4,
            "questions": 10,
        }
    ]
    # 끝낸 판은 기록되지 않았으므로 match_finished가 없다. 새 판은 solo_started 한 줄이다
    assert not [event for event in events if event["event"] == "match_finished"]
    assert len([event for event in events if event["event"] == "solo_started"]) == 1
    assert all(str(PLAYER_ID) not in line for line in lines)


def test_a_restart_that_closed_a_fully_answered_match_logs_it_as_finished() -> None:
    # 마지막 공개만 남은 판은 끝까지 푼 판이라(N04의 «결과 보기») 닫혀 기록된다
    repository = SoloRepository()
    repository.solo_result = replace(
        repository.solo_result,
        ended=EndedSoloMatch(
            match_id=MATCH_ID, category_id=None, position=25, total_questions=25, recorded=True
        ),
    )
    lines, handler = _collect_ops()
    try:
        with make_client(repository) as client:
            response = client.post(
                "/v1/solo", headers=HEADERS, json={"categoryId": "art", "restart": True}
            )
    finally:
        ops_log.logger.removeHandler(handler)

    assert response.status_code == 201
    assert response.json()["ended"]["recorded"] is True
    events = [json.loads(line) for line in lines]
    assert [event["via"] for event in events if event["event"] == "match_finished"] == ["restart"]
    assert not [event for event in events if event["event"] == "solo_abandoned"]


def test_restart_is_rate_limited_like_solo_starts() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        responses = [
            client.post(
                "/v1/solo", headers=HEADERS, json={"categoryId": "history", "restart": True}
            )
            for _ in range(SOLO_ACTOR_LIMIT + 1)
        ]

    assert responses[-1].status_code == 429
    assert len(repository.restart_flags) == SOLO_ACTOR_LIMIT


def test_ending_solo_play_removes_the_solo_room_and_the_unrecorded_match() -> None:
    repository = SoloRepository()
    lines, handler = _collect_ops()
    try:
        with make_client(repository) as client:
            nothing = client.delete("/v1/solo", headers=HEADERS)
            repository.end_result = SoloEnd(
                code=SOLO_CODE,
                ended=EndedSoloMatch(
                    match_id=MATCH_ID, category_id="science", position=2, total_questions=10
                ),
            )
            ended = client.delete("/v1/solo", headers=HEADERS)
            anonymous = client.delete("/v1/solo")
    finally:
        ops_log.logger.removeHandler(handler)

    assert nothing.status_code == 200
    assert nothing.json() == {"ended": None, "left": False}
    assert ended.status_code == 200
    assert ended.json() == {
        "ended": {"matchId": str(MATCH_ID), "categoryId": "science", "recorded": False},
        "left": True,
    }
    assert anonymous.status_code == 401
    assert repository.end_calls == [PLAYER_ID, PLAYER_ID]
    names = [json.loads(line)["event"] for line in lines]
    # 한 판은 solo_abandoned 한 줄로 끝나고, 유일한 사람이 나가 방이 사라진다(나가기와 같은 두 줄)
    assert names.count("solo_abandoned") == 1
    assert names.index("solo_abandoned") < names.index("member_left") < names.index("room_deleted")
    abandoned = next(json.loads(line) for line in lines if '"solo_abandoned"' in line)
    assert (abandoned["via"], abandoned["position"]) == ("left", 2)
    assert all(str(PLAYER_ID) not in line for line in lines)


def test_ending_solo_play_is_rate_limited_with_the_solo_buckets() -> None:
    repository = SoloRepository()
    with make_client(repository) as client:
        for _ in range(SOLO_ACTOR_LIMIT):
            client.post("/v1/solo", headers=HEADERS, json={"categoryId": "history"})
        refused = client.delete("/v1/solo", headers=HEADERS)

    # 열기와 같은 칸이다 — 그만두기로 열기 몫을 비켜 갈 수 없다
    assert refused.status_code == 429
    assert repository.end_calls == []
