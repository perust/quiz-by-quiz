from __future__ import annotations

import asyncio
import hashlib
import os
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection

from app.domain import validate_player, validate_room
from app.postgres import PostgresRoomsRepository
from app.repository import RoomFull

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


def test_postgres_join_is_atomic_at_twelve_and_host_is_transferred() -> None:
    asyncio.run(_exercise_room_lifecycle())


def test_postgres_lobby_bounds_parents_and_keeps_twelve_member_rooms_complete() -> None:
    asyncio.run(_exercise_bounded_lobby())


def test_postgres_cleanup_preserves_active_references_then_reclaims_them() -> None:
    asyncio.run(_exercise_resource_cleanup())


def test_postgres_cleanup_skips_a_room_locked_by_the_start_path() -> None:
    asyncio.run(_exercise_cleanup_lock_interlock())


async def _exercise_room_lifecycle() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=8)
    await repository.open()
    player_ids = [uuid4() for _ in range(13)]

    try:
        for index, player_id in enumerate(player_ids):
            await repository.upsert_player(
                player_id,
                _token_hash(player_id),
                validate_player("같은이름", f"character-{index}"),
            )

        room = await repository.create_room(
            player_ids[0],
            validate_room(
                name="동시 참가 검증",
                category_id="science",
                capacity=12,
                is_public=True,
                password=None,
                game_mode=True,
            ),
            None,
        )

        joined = await asyncio.gather(
            *(repository.join_room(player_id, room.code) for player_id in player_ids[1:12])
        )
        assert all(len(view.players) <= 12 for view in joined)
        full = await repository.get_room(player_ids[0], room.code)
        assert full is not None
        assert len(full.players) == 12
        assert len({player.nickname for player in full.players}) == 12

        with pytest.raises(RoomFull):
            await repository.join_room(player_ids[12], room.code)

        transferred = await repository.leave_room(player_ids[0], room.code)
        assert transferred is not None
        new_host = transferred.players[0].id
        personalized = await repository.get_room(new_host, room.code)
        assert personalized is not None
        assert personalized.is_mine is True

        for player_id in player_ids[1:12]:
            await repository.leave_room(player_id, room.code)
        assert await repository.get_access(room.code) is None
    finally:
        await _delete_players(repository, player_ids)
        await repository.close()


async def _exercise_bounded_lobby() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=8)
    await repository.open()
    actor_id = uuid4()
    other_host_id = uuid4()
    member_ids = [uuid4() for _ in range(11)]
    player_ids = [actor_id, other_host_id, *member_ids]

    try:
        for index, player_id in enumerate(player_ids):
            await repository.upsert_player(
                player_id,
                _token_hash(player_id),
                validate_player(f"목록{index}", f"character-{index}"),
            )

        joined_room = await repository.create_room(
            actor_id,
            validate_room(
                name="참가 방 우선",
                category_id=None,
                capacity=12,
                is_public=True,
                password=None,
                game_mode=True,
            ),
            None,
        )
        await asyncio.gather(
            *(repository.join_room(player_id, joined_room.code) for player_id in member_ids)
        )

        exact_room_code = ""
        for index in range(101):
            created = await repository.create_room(
                other_host_id,
                validate_room(
                    name=f"목록 경계 {index}",
                    category_id=None,
                    capacity=2,
                    is_public=True,
                    password=None,
                    game_mode=True,
                ),
                None,
            )
            if index == 100:
                exact_room_code = created.code

        rooms = await repository.list_rooms(actor_id)
        assert len(rooms) == 100
        assert rooms[0].code == joined_room.code
        assert rooms[0].joined is True
        assert len(rooms[0].players) == 12
        assert len({player.id for player in rooms[0].players}) == 12
        assert all(len(room.players) <= room.capacity for room in rooms)
        exact_room = await repository.get_room(other_host_id, exact_room_code)
        assert exact_room is not None
        assert exact_room.code == exact_room_code
    finally:
        await _delete_rooms_and_players(player_ids)
        await repository.close()


async def _exercise_resource_cleanup() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=4)
    await repository.open()
    orphan_id, room_player_id, match_player_id = (uuid4(), uuid4(), uuid4())
    player_ids = [orphan_id, room_player_id, match_player_id]
    active_room_id, match_room_id, match_id = uuid4(), uuid4(), uuid4()
    active_room_code = uuid4().hex[:6].upper()
    match_room_code = uuid4().hex[:6].upper()

    try:
        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
            for index, player_id in enumerate(player_ids):
                await connection.execute(
                    """
                    INSERT INTO quiz_online.players (
                        id, token_hash, nickname, character_id, expires_at
                    )
                    VALUES (%s, %s, %s, %s, now() - interval '1 minute')
                    """,
                    (
                        player_id,
                        _token_hash(player_id),
                        f"정리{index}",
                        f"cleanup-{index}",
                    ),
                )
            await connection.execute(
                """
                INSERT INTO quiz_online.rooms (
                    id, code, name, capacity, game_mode, is_public,
                    password_hash, host_player_id, expires_at
                )
                VALUES
                    (%s, %s, '활성 방', 2, true, true, NULL, %s,
                     now() + interval '1 hour'),
                    (%s, %s, '경기 방', 2, true, true, NULL, %s,
                     now() - interval '1 minute')
                """,
                (
                    active_room_id,
                    active_room_code,
                    room_player_id,
                    match_room_id,
                    match_room_code,
                    match_player_id,
                ),
            )
            await connection.execute(
                """
                INSERT INTO quiz_online.room_members (
                    room_id, player_id, nickname, character_id, last_seen_at
                )
                VALUES
                    (%s, %s, '활성참가자', 'cleanup-room', now()),
                    (%s, %s, '경기참가자', 'cleanup-match',
                     now() - interval '1 hour')
                """,
                (active_room_id, room_player_id, match_room_id, match_player_id),
            )
            await connection.execute(
                """
                INSERT INTO quiz_online.matches (
                    id, room_id, state, current_position, total_questions,
                    question_started_at, deadline_at, expires_at
                )
                VALUES (
                    %s, %s, 'running', 1, 1, now(),
                    now() + interval '10 minutes', now() + interval '1 hour'
                )
                """,
                (match_id, match_room_id),
            )
            await connection.execute(
                """
                INSERT INTO quiz_online.match_players (
                    match_id, player_id, nickname, character_id
                )
                VALUES (%s, %s, '경기참가자', 'cleanup-match')
                """,
                (match_id, match_player_id),
            )

        await repository.cleanup_expired_resources()
        assert await _remaining_player_ids(player_ids) == {
            room_player_id,
            match_player_id,
        }

        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
            await connection.execute(
                "UPDATE quiz_online.rooms SET expires_at = now() - interval '1 minute' "
                "WHERE id = %s",
                (active_room_id,),
            )
            await connection.execute(
                "UPDATE quiz_online.matches SET expires_at = now() - interval '1 minute' "
                "WHERE id = %s",
                (match_id,),
            )

        await repository.cleanup_expired_resources()
        assert await _remaining_player_ids(player_ids) == set()
    finally:
        await _delete_rooms_and_players(player_ids)
        await repository.close()


async def _exercise_cleanup_lock_interlock() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=4)
    await repository.open()
    player_ids = [uuid4(), uuid4()]

    try:
        for index, player_id in enumerate(player_ids):
            await repository.upsert_player(
                player_id,
                _token_hash(player_id),
                validate_player(f"잠금{index}", f"lock-{index}"),
            )
        room = await repository.create_room(
            player_ids[0],
            validate_room(
                name="정리 잠금 검증",
                category_id=None,
                capacity=2,
                is_public=True,
                password=None,
                game_mode=True,
            ),
            None,
        )
        await repository.join_room(player_ids[1], room.code)
        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as setup:
            await setup.execute(
                "UPDATE quiz_online.room_members "
                "SET last_seen_at = now() - interval '1 hour' "
                "WHERE room_id = (SELECT id FROM quiz_online.rooms WHERE code = %s)",
                (room.code,),
            )

        locker = await AsyncConnection.connect(DATABASE_URL)
        try:
            async with locker.transaction():
                locked = await locker.execute(
                    "SELECT id FROM quiz_online.rooms WHERE code = %s FOR UPDATE",
                    (room.code,),
                )
                locked_room = await locked.fetchone()
                assert locked_room is not None

                await asyncio.wait_for(repository.cleanup_expired_resources(), timeout=2)
                members = await locker.execute(
                    "SELECT count(*) FROM quiz_online.room_members WHERE room_id = %s",
                    (locked_room[0],),
                )
                member_count = await members.fetchone()
                assert member_count is not None and member_count[0] == 2
        finally:
            await locker.close()

        await repository.cleanup_expired_resources()
        assert await repository.get_access(room.code) is None
    finally:
        await _delete_rooms_and_players(player_ids)
        await repository.close()


def _token_hash(player_id: UUID) -> bytes:
    return hashlib.sha256(f"test-token:{player_id}".encode()).digest()


async def _delete_players(repository: PostgresRoomsRepository, player_ids: list[UUID]) -> None:
    del repository
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            "DELETE FROM quiz_online.players WHERE id = ANY(%s)",
            (player_ids,),
        )


async def _delete_rooms_and_players(player_ids: list[UUID]) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            "DELETE FROM quiz_online.rooms WHERE host_player_id = ANY(%s)",
            (player_ids,),
        )
        await connection.execute(
            "DELETE FROM quiz_online.players WHERE id = ANY(%s)",
            (player_ids,),
        )


async def _remaining_player_ids(player_ids: list[UUID]) -> set[UUID]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT id FROM quiz_online.players WHERE id = ANY(%s)",
            (player_ids,),
        )
        return {row[0] for row in await cursor.fetchall()}
