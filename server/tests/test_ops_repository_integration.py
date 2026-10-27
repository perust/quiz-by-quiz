"""운영 기록이 저장소에서 읽는 값 — 방·판 수, 판의 인원, 나가며 넘긴 방장, 정리한 수.

다른 테스트가 같은 DB에 남긴 행이 있을 수 있어 방·판 수는 이 테스트가 바꾼 만큼(차이)으로 본다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection

from app.domain import ValidatedRoom, validate_player, validate_room
from app.postgres import _OPS_COUNTS_SQL, PostgresRoomsRepository
from app.question_catalog import QuestionCatalog
from app.repository import CleanupCounts, RoomCounts

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


def test_ops_count_query_is_one_bounded_aggregate() -> None:
    # 5분에 한 번 도는 집계 하나다. 방마다 행을 돌려주거나 참가자를 펼치지 않는다
    normalized = " ".join(_OPS_COUNTS_SQL.split())
    assert "count(*) FILTER (WHERE NOT room_state.playing) AS waiting_rooms" in normalized
    assert "room.expires_at > now()" in normalized
    assert "room_members" not in normalized
    assert "GROUP BY" not in normalized


@pytest.mark.integration
def test_postgres_ops_counts_follow_waiting_and_playing_rooms() -> None:
    asyncio.run(_exercise_ops_counts())


@pytest.mark.integration
def test_postgres_leave_reports_whether_it_handed_over_the_host() -> None:
    asyncio.run(_exercise_leave_host_transfer())


@pytest.mark.integration
def test_postgres_cleanup_reports_what_it_removed_and_handed_over() -> None:
    asyncio.run(_exercise_cleanup_counts())


async def _exercise_ops_counts() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL, question_catalog=_test_catalog(), max_pool_size=2
    )
    await repository.open()
    host_id, guest_id = uuid4(), uuid4()
    codes: list[str] = []
    try:
        await _players(repository, [host_id, guest_id])
        before = await repository.ops_counts()

        waiting = await repository.create_room(host_id, _room_spec("운영 대기"), None)
        codes.append(waiting.code)
        playing = await repository.create_room(host_id, _room_spec("운영 진행"), None)
        codes.append(playing.code)
        after_create = await repository.ops_counts()
        assert _delta(before, after_create) == RoomCounts(2, 0, 0)

        await repository.join_room(guest_id, playing.code)
        await repository.set_ready(guest_id, playing.code, True)
        setup = await repository.start_game(host_id, playing.code)
        # 판의 인원은 운영 기록만 읽는다
        assert setup.player_count == 2
        after_start = await repository.ops_counts()
        assert _delta(before, after_start) == RoomCounts(1, 1, 1)
    finally:
        await repository.close()
        await _cleanup([host_id, guest_id], codes)


async def _exercise_leave_host_transfer() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=2)
    await repository.open()
    host_id, guest_id, third_id = uuid4(), uuid4(), uuid4()
    codes: list[str] = []
    try:
        await _players(repository, [host_id, guest_id, third_id])
        room = await repository.create_room(host_id, _room_spec("운영 승계"), None)
        codes.append(room.code)
        await repository.join_room(guest_id, room.code)
        await repository.join_room(third_id, room.code)

        # 방장이 아닌 사람이 나가면 방장은 그대로다
        stayed = await repository.leave_room(third_id, room.code)
        assert stayed is not None
        assert stayed.host_transferred is False

        handed = await repository.leave_room(host_id, room.code)
        assert handed is not None
        assert handed.host_transferred is True
        assert handed.players[0].id == guest_id

        # 마지막 사람이 나가면 방이 사라진다
        assert await repository.leave_room(guest_id, room.code) is None
        # 다른 읽기에는 이 표시가 없다
        assert (await repository.get_access(room.code)) is None
    finally:
        await repository.close()
        await _cleanup([host_id, guest_id, third_id], codes)


async def _exercise_cleanup_counts() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=2)
    await repository.open()
    stale_host, fresh_member, lone_member = uuid4(), uuid4(), uuid4()
    player_ids = [stale_host, fresh_member, lone_member]
    codes: list[str] = []
    try:
        await _players(repository, player_ids)
        handover = await repository.create_room(stale_host, _room_spec("운영 정리 승계"), None)
        codes.append(handover.code)
        await repository.join_room(fresh_member, handover.code)
        emptied = await repository.create_room(lone_member, _room_spec("운영 정리 빈 방"), None)
        codes.append(emptied.code)
        assert DATABASE_URL is not None
        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
            await connection.execute(
                """
                UPDATE quiz_online.room_members
                SET last_seen_at = now() - interval '1 hour'
                WHERE player_id = ANY(%s)
                """,
                ([stale_host, lone_member],),
            )

        counts = await repository.cleanup_expired_resources()

        assert isinstance(counts, CleanupCounts)
        assert counts.changed
        # 같은 DB의 다른 찌꺼기도 함께 정리될 수 있어 «적어도»로 본다
        assert counts.members_removed >= 2
        assert counts.hosts_transferred >= 1
        assert counts.rooms_deleted >= 1
        moved = await repository.get_room(fresh_member, handover.code)
        assert moved is not None
        assert moved.is_mine is True
        assert await repository.get_access(emptied.code) is None

        # 다시 돌리면 이 방들에서는 더 할 일이 없다
        again = await repository.cleanup_expired_resources()
        assert isinstance(again, CleanupCounts)
        assert again.members_removed == 0
        assert again.hosts_transferred == 0
    finally:
        await repository.close()
        await _cleanup(player_ids, codes)


def _delta(before: RoomCounts, after: RoomCounts) -> RoomCounts:
    return RoomCounts(
        waiting_rooms=after.waiting_rooms - before.waiting_rooms,
        playing_rooms=after.playing_rooms - before.playing_rooms,
        running_matches=after.running_matches - before.running_matches,
    )


def _room_spec(name: str) -> ValidatedRoom:
    return validate_room(
        name=name,
        category_id="science",
        capacity=4,
        is_public=True,
        password=None,
        game_mode=True,
    )


async def _players(repository: PostgresRoomsRepository, player_ids: list[UUID]) -> None:
    for index, player_id in enumerate(player_ids):
        await repository.upsert_player(
            player_id,
            hashlib.sha256(f"ops-test-token:{player_id}".encode()).digest(),
            validate_player(f"운영{index}", "slime-blue"),
        )


def _test_catalog() -> QuestionCatalog:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        for category in ("history", "science", "geography", "general", "art"):
            questions = [
                {
                    "id": f"online-{category}-{number:03d}",
                    "category": category,
                    "question": f"{category} private test question {number}?",
                    "choices": ["one", "two", "three", "four"],
                    "answerIndex": number % 4,
                    "explanation": f"private test explanation {number}",
                    "difficulty": "normal",
                    "tags": [],
                }
                for number in range(10)
            ]
            (root / f"{category}.json").write_text(json.dumps(questions), encoding="utf-8")
        return QuestionCatalog.from_directory(root)


async def _cleanup(player_ids: list[UUID], codes: list[str]) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        if codes:
            await connection.execute(
                "DELETE FROM quiz_online.rooms WHERE code = ANY(%s::char(6)[])",
                (codes,),
            )
        await connection.execute(
            "DELETE FROM quiz_online.players WHERE id = ANY(%s)",
            (player_ids,),
        )
