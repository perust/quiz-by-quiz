"""혼자 푸는 온라인 판 (FR-7.13 3단계, migration 012의 solo_rooms)을 실제 PostgreSQL에서 확인한다.

- 홈의 분야 칸이 곧바로 판을 연다(`start_solo`). 그 방은 그 사람에게만 보이고 남은 목록에서도
  코드로도 찾지 못하며 들어오지 못한다.
- 같은 사람의 다음 판은 그 혼자 방을 다시 쓴다(분야·문항 시간·닉네임은 이번 값). 판이 돌고 있으면
  새 판을 열지 않고 그 방을 돌려준다(resumed). 「홈으로」가 방을 나가면 방이 지워지고 표시도 함께
  사라진다 — 런타임 역할에 그 표의 DELETE가 없어도 CASCADE가 지운다.
- 혼자 판도 #108의 기록 그대로 남고, 내 판마다 최고 기록과 기록 내보내기는 player id와 주인 열쇠가
  모두 같은 기록만 읽는다.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection, errors
from test_online_rankings_integration import (
    DATABASE_URL,
    _cleanup,
    _owner_key,
    _play,
    _records,
    _register,
    _repository,
)

from app.domain import validate_player, validate_solo_room
from app.repository import RoomNotFound

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


@pytest.mark.integration
def test_postgres_solo_room_is_private_reused_resumed_and_gone_with_home() -> None:
    asyncio.run(_exercise_solo_lifecycle())


@pytest.mark.integration
def test_postgres_solo_match_records_the_current_profile_and_counts_as_a_ranking() -> None:
    asyncio.run(_exercise_solo_profile())


@pytest.mark.integration
def test_postgres_a_stale_solo_room_is_replaced_by_a_new_one() -> None:
    asyncio.run(_exercise_stale_solo_room())


@pytest.mark.integration
def test_postgres_own_best_and_records_read_only_the_owners_rows() -> None:
    asyncio.run(_exercise_own_reads())


@pytest.mark.integration
def test_postgres_runtime_role_cannot_delete_solo_marks_directly() -> None:
    asyncio.run(_exercise_solo_grants())


async def _exercise_solo_lifecycle() -> None:
    repository = await _repository()
    owner, other = uuid4(), uuid4()
    codes: list[str] = []
    try:
        await _register(repository, {owner: "혼자푸는나", other: "엿보는이"})
        started = await repository.start_solo(
            owner, validate_solo_room(category_id="science", question_time_ms=40_000)
        )
        assert started.created is True and started.match is not None and not started.resumed
        room = started.room
        codes.append(room.code)
        assert room.solo is True
        assert room.status == "playing" and room.in_match is True
        assert room.capacity == 2 and room.category_id == "science"
        assert room.question_time_ms == 40_000
        assert [player.id for player in room.players] == [owner]
        assert started.match.question_time_ms == 40_000
        assert started.match.player_count == 1

        # 남의 로비 목록에도, 코드로 묻는 남에게도 없는 방이다. 들어오지도 못한다
        assert room.code not in {item.code for item in await repository.list_rooms(other)}
        assert await repository.get_room(other, room.code) is None
        access = await repository.get_access(room.code)
        assert access is not None and access.solo is True
        with pytest.raises(RoomNotFound):
            await repository.join_room(other, room.code)
        assert not await repository.is_member(other, room.code)
        # 그 사람의 목록에는 있다 — 홈의 «풀던 혼자 판» 줄이 이것으로 돌아간다
        mine = [item for item in await repository.list_rooms(owner) if item.code == room.code]
        assert len(mine) == 1 and mine[0].solo is True and mine[0].joined is True

        # 판이 도는 동안 다시 열면 새 판이 아니라 그 판이다(다른 탭·이어 풀기)
        again = await repository.start_solo(
            owner, validate_solo_room(category_id="history", question_time_ms=20_000)
        )
        assert again.resumed is True and again.match is None
        assert again.room.code == room.code and again.room.category_id == "science"

        plan = {owner: [True] * started.match.total_questions}
        finished = await _play(repository, room.code, started.match.id, owner, plan)
        assert finished.state == "finished" and finished.ranking_recorded is True

        # 「다시 하기」·다음 분야: 같은 방에서 새 판을 연다. 분야·문항 시간은 이번에 고른 값이다
        rematch = await repository.start_solo(
            owner, validate_solo_room(category_id=None, question_time_ms=20_000)
        )
        assert rematch.created is False and rematch.match is not None
        assert rematch.room.code == room.code
        assert rematch.room.category_id is None and rematch.match.category_id is None
        assert rematch.match.question_time_ms == 20_000
        assert await _solo_marks(owner) == 1

        # 판이 끝나기 전에는 나갈 수 없다(친구와 푸는 방과 같다). 끝난 뒤 「홈으로」가 나가면
        # 방이 지워지고 표시도 CASCADE로 함께 사라진다
        await _finish_now(rematch.match.id)
        assert await repository.leave_room(owner, room.code) is None
        assert await _solo_marks(owner) == 0
        assert await repository.get_room(owner, room.code) is None

        # 다음 판은 새 혼자 방이다
        fresh = await repository.start_solo(
            owner, validate_solo_room(category_id="art", question_time_ms=20_000)
        )
        codes.append(fresh.room.code)
        assert fresh.created is True and fresh.room.code != room.code
        assert await _solo_marks(owner) == 1
    finally:
        await repository.close()
        for code in codes:
            await _cleanup([], code)
        await _cleanup([owner, other], None)


async def _exercise_solo_profile() -> None:
    repository = await _repository()
    owner = uuid4()
    code: str | None = None
    try:
        await _register(repository, {owner: "처음이름"})
        first = await repository.start_solo(
            owner, validate_solo_room(category_id="geography", question_time_ms=20_000)
        )
        assert first.match is not None
        code = first.room.code
        plan = {owner: [position % 2 == 1 for position in range(1, 11)]}
        await _play(repository, code, first.match.id, owner, plan)
        rows = await _records(first.match.id)
        assert [(row["nickname"], row["board"], row["score"]) for row in rows] == [
            ("처음이름", "geography", 50)
        ]

        # 홈에서 닉네임·캐릭터를 바꾸면 같은 혼자 방의 다음 판부터 그 이름이다
        await repository.upsert_player(
            owner, _token_hash_for(owner), validate_player("바꾼이름", "slime-pink")
        )
        second = await repository.start_solo(
            owner, validate_solo_room(category_id="geography", question_time_ms=20_000)
        )
        assert second.match is not None and second.room.code == code
        assert [(player.nickname, player.character_id) for player in second.room.players] == [
            ("바꾼이름", "slime-pink")
        ]
        await _play(repository, code, second.match.id, owner, {owner: [True] * 10})
        rows = await _records(second.match.id)
        assert [(row["nickname"], row["character_id"], row["score"]) for row in rows] == [
            ("바꾼이름", "slime-pink", 100)
        ]
        assert await _owner_key_of(second.match.id) == _owner_key(owner)
    finally:
        await repository.close()
        await _cleanup([owner], code)


async def _exercise_stale_solo_room() -> None:
    repository = await _repository()
    owner = uuid4()
    codes: list[str] = []
    try:
        await _register(repository, {owner: "오랜만"})
        first = await repository.start_solo(
            owner, validate_solo_room(category_id="history", question_time_ms=20_000)
        )
        assert first.match is not None
        codes.append(first.room.code)
        await _finish_now(first.match.id)
        # 정리를 기다리던 방(만료됐다)은 다시 쓰지 않고 지운 뒤 새로 만든다
        await _expire_room(first.room.code)
        replaced = await repository.start_solo(
            owner, validate_solo_room(category_id="history", question_time_ms=20_000)
        )
        codes.append(replaced.room.code)
        assert replaced.created is True and replaced.room.code != first.room.code
        assert await _room_exists(first.room.code) is False
        assert await _solo_marks(owner) == 1
    finally:
        await repository.close()
        for code in codes:
            await _cleanup([], code)
        await _cleanup([owner], None)


async def _exercise_own_reads() -> None:
    repository = await _repository()
    owner = uuid4()
    try:
        await _register(repository, {owner: "기록주인"})
        base = datetime(2026, 10, 1, tzinfo=UTC)
        keep_match = uuid4()
        latest_match = uuid4()
        await _insert(owner, board="science", score=70, at=base, match_id=keep_match)
        await _insert(owner, board="science", score=90, at=base + timedelta(days=1))
        # 같은 점수면 먼저 남긴 기록이 최고 기록이다(랭킹 순서와 같다)
        await _insert(owner, board="science", score=90, at=base + timedelta(days=2))
        await _insert(owner, board="all", score=200, at=base + timedelta(days=3), total=25)
        await _insert(
            owner, board="history", score=100, at=base + timedelta(days=4), match_id=latest_match
        )
        # 같은 id를 다른 토큰으로 다시 등록한 사람의 기록은 «내 것»이 아니다
        await _insert(
            owner,
            board="art",
            score=100,
            at=base + timedelta(days=5),
            owner_key=_owner_key(owner, browser="someone-else"),
        )
        # 주인 열쇠가 없는 기록(기록할 때 players 줄이 없었다)도 누구의 것도 아니다
        await _insert(owner, board="general", score=100, at=base, owner_key=None)

        best = await repository.own_best_scores(actor_id=owner, owner_key=_owner_key(owner))
        assert set(best) == {"all", "history", "science", "geography", "general", "art"}
        science = best["science"]
        assert science is not None and science.score == 90
        assert science.recorded_at.startswith("2026-10-02")
        assert best["all"] is not None and best["all"].total_count == 25
        assert best["history"] is not None and best["history"].score == 100
        assert best["art"] is None and best["general"] is None and best["geography"] is None

        # 결과 화면은 방금 닫힌 판을 빼고 «이 판 전의 최고 기록»과 견준다 (FR-5.7)
        before = await repository.own_best_scores(
            actor_id=owner, owner_key=_owner_key(owner), exclude_match_id=latest_match
        )
        assert before["history"] is None
        assert before["science"] is not None and before["science"].score == 90

        # 다른 토큰으로는 아무것도 «내 것»이 아니다
        stranger = await repository.own_best_scores(
            actor_id=owner, owner_key=_owner_key(owner, browser="someone-else")
        )
        assert [board for board, view in stranger.items() if view is not None] == ["art"]

        records = await repository.own_records(actor_id=owner, owner_key=_owner_key(owner))
        assert records.truncated is False
        # 최근 것부터. 남의 열쇠·열쇠 없는 기록은 없다
        assert [(record.board, record.score) for record in records.records] == [
            ("history", 100),
            ("all", 200),
            ("science", 90),
            ("science", 90),
            ("science", 70),
        ]
        assert records.records[1].total_count == 25
        assert records.records[0].question_time_ms == 20_000
        limited = await repository.own_records(
            actor_id=owner, owner_key=_owner_key(owner), limit=2
        )
        assert limited.truncated is True
        assert [record.board for record in limited.records] == ["history", "all"]
        assert keep_match != latest_match
    finally:
        await repository.close()
        await _cleanup([owner], None)


async def _exercise_solo_grants() -> None:
    repository = await _repository()
    owner = uuid4()
    code: str | None = None
    try:
        await _register(repository, {owner: "권한보기"})
        started = await repository.start_solo(
            owner, validate_solo_room(category_id="art", question_time_ms=20_000)
        )
        code = started.room.code
        assert DATABASE_URL is not None
        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
            with pytest.raises(errors.InsufficientPrivilege):
                await connection.execute(
                    "DELETE FROM quiz_online.solo_rooms WHERE player_id = %s", (owner,)
                )
            with pytest.raises(errors.InsufficientPrivilege):
                await connection.execute(
                    "UPDATE quiz_online.solo_rooms SET player_id = %s WHERE player_id = %s",
                    (uuid4(), owner),
                )
        # 사람마다 하나다 — 같은 사람의 표시를 또 남길 수 없다
        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
            with pytest.raises(errors.UniqueViolation):
                await connection.execute(
                    """
                    INSERT INTO quiz_online.solo_rooms (room_id, player_id)
                    SELECT id, %s FROM quiz_online.rooms WHERE code = %s
                    """,
                    (uuid4(), code),
                )
    finally:
        await repository.close()
        await _cleanup([owner], code)


# ── 돕는 것 ────────────────────────────────────────────────────────────────────


def _token_hash_for(player_id: UUID) -> bytes:
    from test_online_rankings_integration import _token_hash

    return _token_hash(player_id)


async def _solo_marks(player_id: UUID) -> int:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT count(*) FROM quiz_online.solo_rooms WHERE player_id = %s", (player_id,)
        )
        row = await cursor.fetchone()
    assert row is not None
    return int(row[0])


async def _room_exists(code: str) -> bool:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT 1 FROM quiz_online.rooms WHERE code = %s", (code,)
        )
        return await cursor.fetchone() is not None


async def _finish_now(match_id: UUID) -> None:
    """판을 기록 없이 닫는다(나가기·다시 하기를 보려는 것이라 점수는 보지 않는다)."""
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET state = 'abandoned', finished_at = now()
            WHERE id = %s
            """,
            (match_id,),
        )


async def _expire_room(code: str) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            "UPDATE quiz_online.rooms SET expires_at = now() - interval '1 second' WHERE code = %s",
            (code,),
        )


async def _owner_key_of(match_id: UUID) -> bytes | None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT owner_key FROM quiz_online.online_rankings WHERE match_id = %s", (match_id,)
        )
        row = await cursor.fetchone()
    assert row is not None
    return None if row[0] is None else bytes(row[0])


_KEEP = object()


async def _insert(
    player_id: UUID,
    *,
    board: str,
    score: int,
    at: datetime,
    total: int = 10,
    match_id: UUID | None = None,
    owner_key: bytes | None | object = _KEEP,
) -> None:
    """런타임 역할이 할 수 있는 INSERT로 정해진 기록 하나. 주인 열쇠는 기본으로 그 사람의 것이다."""
    assert DATABASE_URL is not None
    key = _owner_key(player_id) if owner_key is _KEEP else owner_key
    mode, category = ("all", None) if board == "all" else ("category", board)
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            INSERT INTO quiz_online.online_rankings (
                match_id, player_id, mode, category_id, score, correct_count, total_questions,
                question_time_ms, nickname, character_id, owner_key, recorded_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, 20000, '기록주인', 'slime-blue', %s, %s)
            """,
            (
                match_id or uuid4(),
                player_id,
                mode,
                category,
                score,
                score // 10,
                total,
                key,
                at,
            ),
        )
