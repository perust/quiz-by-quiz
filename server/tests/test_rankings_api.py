"""공개 랭킹 읽기 GET /v1/rankings (FR-7.13 2단계, PRD 12.1)의 모양·순서·한도·isMine·요청 한도."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from datetime import datetime
from typing import Any
from uuid import UUID

import pytest
from test_api import HEADERS, MATCH_ID, PLAYER_ID, PLAYER_TOKEN, FakeRepository, make_client

from app.main import (
    RANKING_CLIENT_LIMIT,
    RANKING_PROCESS_LIMIT,
    _match_payload,
)
from app.repository import (
    RankingBoardView,
    RankingEntryView,
    RankingPeriod,
    ranking_owner_key,
)

# «내 기록»의 열쇠는 player id가 아니라 그 브라우저의 토큰에서 나온다 (owner_key)
OWNER_KEY = ranking_owner_key(hashlib.sha256(PLAYER_TOKEN.encode("utf-8")).digest())
WINDOW_START = "2026-10-26T00:00:00+09:00"
WINDOW_END = "2026-11-02T00:00:00+09:00"


def entry(rank: int, *, score: int, mine: bool = False) -> RankingEntryView:
    return RankingEntryView(
        rank=rank,
        nickname=f"참가자{rank}",
        character_id="slime-blue",
        score=score,
        correct_count=score // 10,
        total_count=10,
        recorded_at=f"2026-10-27T0{rank % 10}:00:00+00:00",
        is_mine=mine,
    )


class RankingRepository(FakeRepository):
    def __init__(self) -> None:
        super().__init__()
        self.ranking_calls: list[dict[str, Any]] = []
        self.ranking_entries: tuple[RankingEntryView, ...] = (
            entry(1, score=100),
            entry(2, score=90, mine=True),
        )

    async def list_rankings(
        self,
        *,
        board: str,
        period: RankingPeriod,
        actor_id: UUID | None = None,
        owner_key: bytes | None = None,
        at: datetime | None = None,
        limit: int = 10,
    ) -> RankingBoardView:
        self.ranking_calls.append(
            {
                "board": board,
                "period": period,
                "actor_id": actor_id,
                "owner_key": owner_key,
                "limit": limit,
            }
        )
        return RankingBoardView(
            board=board,
            period=period,
            entries=tuple(
                replace(
                    item,
                    is_mine=item.is_mine and actor_id is not None and owner_key is not None,
                )
                for item in self.ranking_entries
            ),
            window_start=WINDOW_START if period == "week" else None,
            window_end=WINDOW_END if period == "week" else None,
        )


def test_week_board_shape_carries_the_window_and_no_browser_identity() -> None:
    repository = RankingRepository()
    with make_client(repository) as client:
        response = client.get(
            "/v1/rankings",
            params={"mode": "category", "category": "history", "period": "week"},
            headers=HEADERS,
        )

    assert response.status_code == 200
    assert response.json() == {
        "mode": "category",
        "categoryId": "history",
        "period": "week",
        "window": {"start": WINDOW_START, "end": WINDOW_END, "timeZone": "Asia/Seoul"},
        "limit": 10,
        "entries": [
            {
                "rank": 1,
                "nickname": "참가자1",
                "characterId": "slime-blue",
                "score": 100,
                "correctCount": 10,
                "totalCount": 10,
                "recordedAt": "2026-10-27T01:00:00+00:00",
                "isMine": False,
            },
            {
                "rank": 2,
                "nickname": "참가자2",
                "characterId": "slime-blue",
                "score": 90,
                "correctCount": 9,
                "totalCount": 10,
                "recordedAt": "2026-10-27T02:00:00+00:00",
                "isMine": True,
            },
        ],
    }
    assert repository.ranking_calls == [
        {
            "board": "history",
            "period": "week",
            "actor_id": PLAYER_ID,
            "owner_key": OWNER_KEY,
            "limit": 10,
        }
    ]
    # 브라우저 신분(player id)은 어디에도 싣지 않는다
    assert str(PLAYER_ID) not in response.text
    assert PLAYER_TOKEN not in response.text


class ReusedIdRepository(RankingRepository):
    """지워진 players 줄의 id를 다른 토큰으로 다시 등록했다 — 두 토큰이 모두 그 id로 인증된다."""

    async def authenticate(self, player_id: UUID, token_hash: bytes) -> bool:
        self.authenticate_calls += 1
        return player_id == PLAYER_ID


def test_owner_key_comes_from_the_token_so_the_same_id_with_another_token_is_not_mine() -> None:
    repository = ReusedIdRepository()
    other_token = "another-token-for-the-same-player-id-123456"  # noqa: S105
    with make_client(repository) as client:
        client.get("/v1/rankings", params={"mode": "all", "period": "all"}, headers=HEADERS)
        client.get(
            "/v1/rankings",
            params={"mode": "all", "period": "all"},
            headers={**HEADERS, "Authorization": f"Bearer {other_token}"},
        )

    first, second = repository.ranking_calls
    assert first["actor_id"] == second["actor_id"] == PLAYER_ID
    assert first["owner_key"] == OWNER_KEY and len(OWNER_KEY) == 32
    # 같은 id라도 토큰이 다르면 열쇠가 다르다 — 지워진 id를 다시 등록한 사람은 남의 «나»를 못 읽는다
    assert second["owner_key"] == ranking_owner_key(
        hashlib.sha256(other_token.encode("utf-8")).digest()
    )
    assert second["owner_key"] != first["owner_key"]
    # 열쇠는 토큰 해시 그 자체가 아니다(로그인에 쓸 수 없다)
    assert OWNER_KEY != hashlib.sha256(PLAYER_TOKEN.encode("utf-8")).digest()


def test_all_mode_and_all_time_have_no_category_and_no_window() -> None:
    repository = RankingRepository()
    with make_client(repository) as client:
        response = client.get("/v1/rankings", params={"mode": "all", "period": "all"})

    assert response.status_code == 200
    body = response.json()
    assert (body["mode"], body["categoryId"], body["period"], body["window"]) == (
        "all",
        None,
        "all",
        None,
    )
    assert repository.ranking_calls[0]["board"] == "all"


def test_anonymous_read_marks_nothing_mine_and_skips_authentication() -> None:
    repository = RankingRepository()
    with make_client(repository) as client:
        response = client.get("/v1/rankings", params={"mode": "all", "period": "week"})

    assert response.status_code == 200
    assert [item["isMine"] for item in response.json()["entries"]] == [False, False]
    assert repository.ranking_calls[0]["actor_id"] is None
    assert repository.ranking_calls[0]["owner_key"] is None
    assert repository.authenticate_calls == 0


def test_isMine_needs_the_same_authenticated_browser_identity() -> None:
    repository = RankingRepository()
    with make_client(repository) as client:
        repository.authenticated = False
        expired = client.get(
            "/v1/rankings", params={"mode": "all", "period": "week"}, headers=HEADERS
        )
        malformed = client.get(
            "/v1/rankings",
            params={"mode": "all", "period": "week"},
            headers={"X-Player-Id": str(PLAYER_ID)},
        )
        forged = client.get(
            "/v1/rankings",
            params={"mode": "all", "period": "week"},
            headers={**HEADERS, "X-Player-Id": "not-a-uuid"},
        )

    # 신분을 실었는데 틀렸으면 남의 표시를 지어내지 않고 401이다 — 화면은 세션을 다시 연다
    for response in (expired, malformed, forged):
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "unauthorized"
    assert repository.ranking_calls == []


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"period": "week"},
        {"mode": "category", "period": "week"},
        {"mode": "category", "category": "music", "period": "week"},
        {"mode": "all", "category": "history", "period": "week"},
        {"mode": "all", "period": "month"},
        {"mode": "ALL", "period": "week"},
        {"mode": "all"},
    ],
)
def test_unknown_boards_and_periods_are_refused(params: dict[str, str]) -> None:
    repository = RankingRepository()
    with make_client(repository) as client:
        response = client.get("/v1/rankings", params=params)

    assert response.status_code == 400
    assert response.json()["detail"] == {
        "code": "invalid-ranking",
        "message": "랭킹 종류가 올바르지 않아요.",
    }
    assert repository.ranking_calls == []


def test_the_payload_never_carries_more_than_ten_entries() -> None:
    repository = RankingRepository()
    repository.ranking_entries = tuple(entry(rank, score=100 - rank) for rank in range(1, 14))
    with make_client(repository) as client:
        response = client.get(
            "/v1/rankings", params={"mode": "category", "category": "art", "period": "all"}
        )

    entries = response.json()["entries"]
    assert [item["rank"] for item in entries] == list(range(1, 11))
    assert repository.ranking_calls[0]["limit"] == 10


def test_rankings_are_rate_limited_per_address_like_other_public_reads() -> None:
    repository = RankingRepository()
    params = {"mode": "all", "period": "week"}
    with make_client(repository) as client:
        admitted = [
            client.get("/v1/rankings", params=params, headers={"X-Forwarded-For": "198.51.100.7"})
            for _ in range(RANKING_CLIENT_LIMIT)
        ]
        refused = client.get(
            "/v1/rankings", params=params, headers={"X-Forwarded-For": "198.51.100.7"}
        )
        # 거절은 몫을 먹지 않고, 다른 주소는 제 몫을 쓴다
        elsewhere = client.get(
            "/v1/rankings", params=params, headers={"X-Forwarded-For": "198.51.100.8"}
        )

    assert {response.status_code for response in admitted} == {200}
    assert refused.status_code == 429
    assert refused.json()["detail"]["code"] == "rate-limited"
    assert 1 <= int(refused.headers["retry-after"]) <= 60
    assert elsewhere.status_code == 200
    assert len(repository.ranking_calls) == RANKING_CLIENT_LIMIT + 1


def test_rankings_process_limit_survives_address_rotation() -> None:
    repository = RankingRepository()
    params = {"mode": "all", "period": "all"}
    with make_client(repository) as client:
        statuses = [
            client.get(
                "/v1/rankings",
                params=params,
                headers={"X-Forwarded-For": f"203.0.113.{index % 200}"},
            ).status_code
            for index in range(RANKING_PROCESS_LIMIT + 1)
        ]

    assert statuses[:RANKING_PROCESS_LIMIT] == [200] * RANKING_PROCESS_LIMIT
    assert statuses[-1] == 429
    assert len(repository.ranking_calls) == RANKING_PROCESS_LIMIT


def test_a_classroom_behind_one_address_can_page_through_the_ranking_tabs() -> None:
    """한 주소 뒤 36명이 판을 마치고 함께 랭킹을 열어 탭 여덟을 넘겨 봐도 막히지 않는다."""
    repository = RankingRepository()
    boards = [("all", None), ("category", "history"), ("category", "science"), ("all", None)]
    with make_client(repository) as client:
        statuses = [
            client.get(
                "/v1/rankings",
                params={
                    "mode": mode,
                    **({"category": category} if category else {}),
                    "period": period,
                },
                headers={"X-Forwarded-For": "192.0.2.44"},
            ).status_code
            for _ in range(36)
            for mode, category in boards
            for period in ("week", "all")
        ]

    assert len(statuses) == 288
    assert set(statuses) == {200}


def test_finished_match_payload_says_whether_the_result_reached_the_ranking() -> None:
    from app.repository import MatchView

    finished = MatchView(
        id=MATCH_ID,
        state="finished",
        category_id="history",
        game_mode=True,
        current_position=10,
        total_questions=10,
        deadline_at=None,
        question=None,
        own_answer=None,
        scores=(),
        ranking_recorded=True,
    )
    running = replace(finished, state="running", ranking_recorded=False)

    assert _match_payload(finished)["rankingRecorded"] is True
    assert _match_payload(replace(finished, ranking_recorded=False))["rankingRecorded"] is False
    # 끝나기 전의 판에는 키조차 없다(«문제 다시 보기»와 같다)
    assert "rankingRecorded" not in _match_payload(running)
