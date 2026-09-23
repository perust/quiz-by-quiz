from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import AsyncConnection, errors

from app.domain import DEFAULT_CHARACTER_ID, validate_player, validate_room
from app.migrate import (
    apply_pending,
    discover_migrations,
    ensure_runtime_role,
    runtime_role_password,
)
from app.postgres import PostgresRoomsRepository
from app.question_catalog import QuestionCatalog

MIGRATOR_URL = os.getenv("MIGRATION_UPGRADE_DATABASE_URL")
RUNTIME_URL = os.getenv("MIGRATION_UPGRADE_RUNTIME_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not MIGRATOR_URL or not RUNTIME_URL,
        reason="migration upgrade database URLs are not set",
    ),
]


def test_v9_writers_are_replaced_before_character_only_constraints_land() -> None:
    assert MIGRATOR_URL is not None
    assert RUNTIME_URL is not None
    host_id, guest_id = uuid4(), uuid4()
    room_code = uuid4().hex[:6].upper()

    with psycopg.connect(MIGRATOR_URL, autocommit=True) as connection:
        ensure_runtime_role(connection, runtime_role_password())
        migrations = discover_migrations()
        assert apply_pending(connection, migrations[:9]) == tuple(range(1, 10))
        _seed_v9_room(connection, host_id, guest_id, room_code)

    asyncio.run(_exercise_candidate_against_v9(host_id, guest_id, room_code))

    with psycopg.connect(MIGRATOR_URL, autocommit=True) as connection:
        room_id, match_id = connection.execute(
            """
            SELECT room.id, match.id
            FROM quiz_online.rooms AS room
            JOIN quiz_online.matches AS match ON match.room_id = room.id
            WHERE room.code = %s
            """,
            (room_code,),
        ).fetchone()
        connection.execute(
            "UPDATE quiz_online.players SET character_id = NULL WHERE id = %s",
            (host_id,),
        )
        connection.execute(
            "UPDATE quiz_online.room_members SET character_id = NULL WHERE room_id = %s",
            (room_id,),
        )
        connection.execute(
            "UPDATE quiz_online.match_players SET character_id = NULL WHERE match_id = %s",
            (match_id,),
        )
        connection.execute(
            "UPDATE quiz_online.rooms SET game_mode = false WHERE id = %s",
            (room_id,),
        )
        connection.execute(
            "UPDATE quiz_online.matches SET game_mode = false WHERE id = %s",
            (match_id,),
        )

        assert apply_pending(connection, migrations) == (10,)
        assert connection.execute(
            "SELECT array_agg(version ORDER BY version) FROM quiz_online.schema_migrations"
        ).fetchone()[0] == list(range(1, 11))
        assert connection.execute(
            "SELECT game_mode FROM quiz_online.rooms WHERE id = %s", (room_id,)
        ).fetchone()[0] is True
        assert connection.execute(
            "SELECT game_mode FROM quiz_online.matches WHERE id = %s", (match_id,)
        ).fetchone()[0] is True
        assert connection.execute(
            "SELECT character_id FROM quiz_online.players WHERE id = %s", (host_id,)
        ).fetchone()[0] == DEFAULT_CHARACTER_ID
        assert connection.execute(
            "SELECT count(*) FROM quiz_online.room_members "
            "WHERE room_id = %s AND character_id = %s",
            (room_id, DEFAULT_CHARACTER_ID),
        ).fetchone()[0] >= 1
        assert connection.execute(
            "SELECT count(*) FROM quiz_online.match_players "
            "WHERE match_id = %s AND character_id = %s",
            (match_id, DEFAULT_CHARACTER_ID),
        ).fetchone()[0] >= 1
        assert asyncio.run(_runtime_schema_version()) == 10

        with pytest.raises(errors.CheckViolation):
            connection.execute(
                "UPDATE quiz_online.rooms SET game_mode = false WHERE id = %s", (room_id,)
            )
        with pytest.raises(errors.NotNullViolation):
            connection.execute(
                "UPDATE quiz_online.players SET character_id = NULL WHERE id = %s", (host_id,)
            )
        with pytest.raises(errors.CheckViolation):
            connection.execute(
                "UPDATE quiz_online.match_players SET character_id = 'NOT VALID' "
                "WHERE match_id = %s",
                (match_id,),
            )

        connection.execute("DELETE FROM quiz_online.rooms WHERE id = %s", (room_id,))
        connection.execute(
            "DELETE FROM quiz_online.players WHERE id IN (%s, %s)", (host_id, guest_id)
        )


async def _exercise_candidate_against_v9(host_id: UUID, guest_id: UUID, room_code: str) -> None:
    assert RUNTIME_URL is not None
    repository = PostgresRoomsRepository(
        RUNTIME_URL,
        question_catalog=_test_catalog(),
        max_pool_size=2,
    )
    await repository.open()
    try:
        assert await repository.schema_version() == 0
        compatibility_room = await repository.create_room(
            host_id,
            validate_room(
                name="호환성 방",
                category_id="science",
                capacity=2,
                is_public=True,
                password=None,
                game_mode=False,
            ),
            None,
        )
        async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
            member_character = await connection.execute(
                """
                SELECT member.character_id
                FROM quiz_online.room_members AS member
                JOIN quiz_online.rooms AS room ON room.id = member.room_id
                WHERE room.code = %s AND member.player_id = %s
                """,
                (compatibility_room.code, host_id),
            )
            assert (await member_character.fetchone())[0] == DEFAULT_CHARACTER_ID
            await connection.execute(
                "UPDATE quiz_online.players SET character_id = NULL WHERE id = %s",
                (guest_id,),
            )
        await repository.join_room(guest_id, compatibility_room.code)
        async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
            joined_character = await connection.execute(
                """
                SELECT member.character_id
                FROM quiz_online.room_members AS member
                JOIN quiz_online.rooms AS room ON room.id = member.room_id
                WHERE room.code = %s AND member.player_id = %s
                """,
                (compatibility_room.code, guest_id),
            )
            assert (await joined_character.fetchone())[0] == DEFAULT_CHARACTER_ID
        assert await repository.leave_room(guest_id, compatibility_room.code) is not None
        assert await repository.leave_room(host_id, compatibility_room.code) is None

        await repository.upsert_player(
            host_id,
            _token_hash(host_id),
            validate_player("구버전방장", None),
            update_profile=False,
        )
        async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
            character = await connection.execute(
                "SELECT character_id FROM quiz_online.players WHERE id = %s", (host_id,)
            )
            assert (await character.fetchone())[0] == DEFAULT_CHARACTER_ID

        room = await repository.get_room(host_id, room_code)
        assert room is not None
        assert room.game_mode is True
        assert all(player.character_id for player in room.players)
        setup = await repository.start_game(host_id, room_code)
        assert setup.game_mode is True

        async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
            persisted = await connection.execute(
                """
                SELECT match.id, match.game_mode,
                       bool_and(player.character_id IS NOT NULL)
                FROM quiz_online.matches AS match
                JOIN quiz_online.match_players AS player ON player.match_id = match.id
                WHERE match.room_id = (
                    SELECT id FROM quiz_online.rooms WHERE code = %s
                )
                GROUP BY match.id, match.game_mode
                """,
                (room_code,),
            )
            _, game_mode, all_characters = await persisted.fetchone()
            assert game_mode is True
            assert all_characters is True
    finally:
        await repository.close()


async def _runtime_schema_version() -> int:
    assert RUNTIME_URL is not None
    repository = PostgresRoomsRepository(RUNTIME_URL, max_pool_size=1)
    await repository.open()
    try:
        return await repository.schema_version()
    finally:
        await repository.close()


def _seed_v9_room(
    connection: psycopg.Connection[tuple[object, ...]],
    host_id: UUID,
    guest_id: UUID,
    room_code: str,
) -> None:
    for player_id, nickname, character_id in (
        (host_id, "구버전방장", None),
        (guest_id, "구버전손님", "slime-pink"),
    ):
        connection.execute(
            """
            INSERT INTO quiz_online.players (id, token_hash, nickname, character_id)
            VALUES (%s, %s, %s, %s)
            """,
            (player_id, _token_hash(player_id), nickname, character_id),
        )
    room_id = connection.execute(
        """
        INSERT INTO quiz_online.rooms (
            code, name, category_id, capacity, game_mode,
            is_public, password_hash, host_player_id
        )
        VALUES (%s, '구버전 방', 'science', 2, false, true, NULL, %s)
        RETURNING id
        """,
        (room_code, host_id),
    ).fetchone()[0]
    connection.execute(
        """
        INSERT INTO quiz_online.room_members (
            room_id, player_id, nickname, character_id, is_ready
        )
        VALUES
            (%s, %s, '구버전방장', NULL, true),
            (%s, %s, '구버전손님', 'slime-pink', true)
        """,
        (room_id, host_id, room_id, guest_id),
    )


def _token_hash(player_id: UUID) -> bytes:
    return hashlib.sha256(f"migration-upgrade:{player_id}".encode()).digest()


def _test_catalog() -> QuestionCatalog:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        for category in ("history", "science", "geography", "general", "art"):
            questions = [
                {
                    "id": f"upgrade-{category}-{number:03d}",
                    "category": category,
                    "question": f"{category} upgrade question {number}?",
                    "choices": ["one", "two", "three", "four"],
                    "answerIndex": number % 4,
                    "explanation": "upgrade verification",
                    "difficulty": "normal",
                    "tags": [],
                }
                for number in range(10)
            ]
            (root / f"{category}.json").write_text(json.dumps(questions), encoding="utf-8")
        return QuestionCatalog.from_directory(root)
