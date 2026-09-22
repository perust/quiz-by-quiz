from __future__ import annotations

import secrets
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection, errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .domain import ValidatedPlayer, ValidatedRoom
from .question_catalog import CatalogError, QuestionCatalog, SelectedQuestion
from .repository import (
    AccessInfo,
    MatchAnswerView,
    MatchInProgress,
    MatchNotFound,
    MatchNotReady,
    MatchPositionMismatch,
    MatchQuestionView,
    MatchRead,
    MatchScoreView,
    MatchSetup,
    MatchSubmission,
    MatchView,
    NotHost,
    NotMember,
    PlayerView,
    RepositoryFailure,
    RoomFull,
    RoomNotFound,
    RoomView,
    TokenConflict,
)

_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_ROOM_LIFETIME = "24 hours"
_MEMBER_STALE_AFTER = "30 minutes"
_PLAYER_LIFETIME = "2 hours"
_MATCH_LIFETIME = "2 hours"
_QUESTION_TIMEOUT = "20 seconds"
_REVEAL_DURATION = "3 seconds"

_LOBBY_ROOM_LIMIT = 100

_ROOM_ROWS_SQL = """
WITH selected_rooms AS MATERIALIZED (
    SELECT
        candidate.id,
        EXISTS (
            SELECT 1
            FROM quiz_online.room_members mine
            WHERE mine.room_id = candidate.id
              AND mine.player_id = %(actor_id)s
        ) AS joined
    FROM quiz_online.rooms candidate
    WHERE candidate.expires_at > now()
      AND (
          %(code)s::char(6) IS NULL
          OR candidate.code = %(code)s::char(6)
      )
      AND (
          %(require_member)s = false
          OR EXISTS (
              SELECT 1
              FROM quiz_online.room_members required_member
              WHERE required_member.room_id = candidate.id
                AND required_member.player_id = %(actor_id)s
          )
      )
    ORDER BY
        joined DESC,
        candidate.updated_at DESC,
        candidate.created_at DESC,
        candidate.id ASC
    LIMIT %(room_limit)s
)
SELECT
    r.id AS room_id,
    r.code::text AS code,
    r.name,
    r.category_id,
    r.capacity,
    r.game_mode,
    r.is_public,
    (r.password_hash IS NOT NULL) AS has_password,
    (r.host_player_id = %(actor_id)s) AS is_mine,
    selected.joined,
    r.created_at,
    member.player_id,
    member.nickname,
    member.character_id,
    member.is_ready,
    member.joined_at
FROM selected_rooms selected
JOIN quiz_online.rooms r ON r.id = selected.id
LEFT JOIN quiz_online.room_members member ON member.room_id = r.id
ORDER BY
    selected.joined DESC,
    r.updated_at DESC,
    r.created_at DESC,
    r.id ASC,
    member.joined_at ASC,
    member.player_id ASC
"""

_DELETE_EXPIRED_ROOMS_SQL = """
DELETE FROM quiz_online.rooms room
WHERE room.expires_at <= now()
  AND NOT EXISTS (
      SELECT 1
      FROM quiz_online.matches active_match
      WHERE active_match.room_id = room.id
        AND active_match.state IN ('running', 'revealing')
  )
"""

_DELETE_STALE_MEMBERS_SQL = """
WITH cleanup_rooms AS MATERIALIZED (
    SELECT room.id
    FROM quiz_online.rooms room
    WHERE EXISTS (
        SELECT 1
        FROM quiz_online.room_members stale_member
        WHERE stale_member.room_id = room.id
          AND stale_member.last_seen_at <= now() - %s::interval
    )
      AND NOT EXISTS (
          SELECT 1
          FROM quiz_online.matches active_match
          WHERE active_match.room_id = room.id
            AND active_match.state IN ('running', 'revealing')
      )
    ORDER BY room.id
    FOR UPDATE OF room SKIP LOCKED
)
DELETE FROM quiz_online.room_members member
USING cleanup_rooms
WHERE member.room_id = cleanup_rooms.id
  AND member.last_seen_at <= now() - %s::interval
"""

_TRANSFER_ORPHANED_HOSTS_SQL = """
UPDATE quiz_online.rooms room
SET host_player_id = (
        SELECT member.player_id
        FROM quiz_online.room_members member
        WHERE member.room_id = room.id
        ORDER BY member.joined_at ASC, member.player_id ASC
        LIMIT 1
    ),
    updated_at = now()
WHERE NOT EXISTS (
    SELECT 1
    FROM quiz_online.room_members host_member
    WHERE host_member.room_id = room.id
      AND host_member.player_id = room.host_player_id
)
  AND EXISTS (
    SELECT 1
    FROM quiz_online.room_members any_member
    WHERE any_member.room_id = room.id
)
"""

_DELETE_EMPTY_ROOMS_SQL = """
DELETE FROM quiz_online.rooms room
WHERE NOT EXISTS (
    SELECT 1
    FROM quiz_online.room_members member
    WHERE member.room_id = room.id
)
  AND NOT EXISTS (
      SELECT 1
      FROM quiz_online.matches active_match
      WHERE active_match.room_id = room.id
        AND active_match.state IN ('running', 'revealing')
  )
"""

_DELETE_EXPIRED_PLAYERS_SQL = """
DELETE FROM quiz_online.players player
WHERE player.expires_at <= now()
  AND NOT EXISTS (
      SELECT 1
      FROM quiz_online.room_members member
      WHERE member.player_id = player.id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM quiz_online.match_players match_player
      JOIN quiz_online.matches match ON match.id = match_player.match_id
      WHERE match_player.player_id = player.id
        AND match.expires_at > now()
  )
"""


class PostgresRoomsRepository:
    def __init__(
        self,
        database_url: str,
        *,
        question_catalog: QuestionCatalog | None = None,
        max_pool_size: int = 5,
    ) -> None:
        self._catalog = question_catalog
        self._pool = AsyncConnectionPool(
            conninfo=database_url,
            min_size=1,
            max_size=max_pool_size,
            open=False,
            timeout=10,
            kwargs={"autocommit": True, "row_factory": dict_row},
        )

    async def open(self) -> None:
        await self._pool.open(wait=True)

    async def close(self) -> None:
        await self._pool.close()

    async def health(self) -> bool:
        try:
            async with self._pool.connection(timeout=3) as connection:
                await connection.execute("SELECT 1")
            return True
        except Exception:
            return False

    async def upsert_player(
        self,
        player_id: UUID,
        token_hash: bytes,
        player: ValidatedPlayer,
        update_profile: bool = True,
    ) -> None:
        statement = """
        INSERT INTO quiz_online.players AS current_player (
            id, token_hash, nickname, character_id, last_seen_at, expires_at
        )
        VALUES (%s, %s, %s, %s, now(), now() + %s::interval)
        ON CONFLICT (id) DO UPDATE
        SET nickname = CASE
                WHEN %s THEN EXCLUDED.nickname
                ELSE current_player.nickname
            END,
            character_id = CASE
                WHEN %s THEN EXCLUDED.character_id
                ELSE current_player.character_id
            END,
            last_seen_at = now(),
            expires_at = now() + %s::interval
        WHERE current_player.token_hash = EXCLUDED.token_hash
        RETURNING id
        """
        try:
            async with self._pool.connection() as connection:
                cursor = await connection.execute(
                    statement,
                    (
                        player_id,
                        token_hash,
                        player.nickname,
                        player.character_id,
                        _PLAYER_LIFETIME,
                        update_profile,
                        update_profile,
                        _PLAYER_LIFETIME,
                    ),
                )
                row = await cursor.fetchone()
        except errors.UniqueViolation as error:
            raise TokenConflict from error
        if row is None:
            raise TokenConflict

    async def authenticate(self, player_id: UUID, token_hash: bytes) -> bool:
        statement = """
        UPDATE quiz_online.players
        SET last_seen_at = now(), expires_at = now() + %s::interval
        WHERE id = %s AND token_hash = %s AND expires_at > now()
        RETURNING id
        """
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                statement,
                (_PLAYER_LIFETIME, player_id, token_hash),
            )
            return await cursor.fetchone() is not None

    async def list_rooms(self, actor_id: UUID) -> list[RoomView]:
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                _ROOM_ROWS_SQL,
                {
                    "actor_id": actor_id,
                    "code": None,
                    "require_member": False,
                    "room_limit": _LOBBY_ROOM_LIMIT,
                },
            )
            return _build_room_views(await cursor.fetchall())

    async def create_room(
        self,
        actor_id: UUID,
        spec: ValidatedRoom,
        password_hash: str | None,
    ) -> RoomView:
        for _ in range(10):
            code = _make_code()
            try:
                async with self._pool.connection() as connection:
                    async with connection.transaction():
                        player = await self._player_row(connection, actor_id)
                        if player is None:
                            raise NotMember
                        cursor = await connection.execute(
                            """
                            INSERT INTO quiz_online.rooms (
                                code, name, category_id, capacity, game_mode,
                                is_public, password_hash, host_player_id, expires_at
                            )
                            VALUES (
                                %s, %s, %s, %s, %s, %s, %s, %s,
                                now() + %s::interval
                            )
                            RETURNING id
                            """,
                            (
                                code,
                                spec.name,
                                spec.category_id,
                                spec.capacity,
                                spec.game_mode,
                                spec.is_public,
                                password_hash,
                                actor_id,
                                _ROOM_LIFETIME,
                            ),
                        )
                        room = await cursor.fetchone()
                        if room is None:
                            raise RepositoryFailure("room insert returned no row")
                        await connection.execute(
                            """
                            INSERT INTO quiz_online.room_members (
                                room_id, player_id, nickname, character_id
                            )
                            VALUES (%s, %s, %s, %s)
                            """,
                            (
                                room["id"],
                                actor_id,
                                player["nickname"],
                                player["character_id"],
                            ),
                        )
                        created = await self._fetch_room(
                            connection,
                            actor_id,
                            code,
                            require_member=True,
                        )
                        if created is None:
                            raise RepositoryFailure("created room could not be read")
                        return created
            except errors.UniqueViolation:
                continue
        raise RepositoryFailure("could not allocate a unique room code")

    async def get_room(self, actor_id: UUID, code: str) -> RoomView | None:
        async with self._pool.connection() as connection:
            room = await self._fetch_room(connection, actor_id, code, require_member=True)
            if room is not None:
                await self._touch_member(connection, actor_id, room.code)
            return room

    async def get_access(self, code: str) -> AccessInfo | None:
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT is_public, password_hash
                FROM quiz_online.rooms
                WHERE code = %s AND expires_at > now()
                """,
                (code,),
            )
            row = await cursor.fetchone()
            if row is None:
                return None
            return AccessInfo(
                is_public=bool(row["is_public"]),
                password_hash=row["password_hash"],
            )

    async def join_room(self, actor_id: UUID, code: str) -> RoomView:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id, capacity
                    FROM quiz_online.rooms
                    WHERE code = %s AND expires_at > now()
                    FOR UPDATE
                    """,
                    (code,),
                )
                room = await cursor.fetchone()
                if room is None:
                    raise RoomNotFound

                member = await connection.execute(
                    """
                    SELECT 1
                    FROM quiz_online.room_members
                    WHERE room_id = %s AND player_id = %s
                    """,
                    (room["id"], actor_id),
                )
                if await member.fetchone() is None:
                    active_match = await connection.execute(
                        """
                        SELECT 1
                        FROM quiz_online.matches
                        WHERE room_id = %s AND state IN ('running', 'revealing')
                        """,
                        (room["id"],),
                    )
                    if await active_match.fetchone() is not None:
                        raise MatchInProgress
                    count_cursor = await connection.execute(
                        "SELECT count(*) AS count FROM quiz_online.room_members WHERE room_id = %s",
                        (room["id"],),
                    )
                    count_row = await count_cursor.fetchone()
                    if count_row is None or int(count_row["count"]) >= int(room["capacity"]):
                        raise RoomFull

                    player = await self._player_row(connection, actor_id)
                    if player is None:
                        raise NotMember
                    names_cursor = await connection.execute(
                        "SELECT nickname FROM quiz_online.room_members WHERE room_id = %s",
                        (room["id"],),
                    )
                    taken = {str(row["nickname"]) for row in await names_cursor.fetchall()}
                    nickname = _unique_nickname(str(player["nickname"]), taken)
                    await connection.execute(
                        """
                        INSERT INTO quiz_online.room_members (
                            room_id, player_id, nickname, character_id
                        )
                        VALUES (%s, %s, %s, %s)
                        """,
                        (room["id"], actor_id, nickname, player["character_id"]),
                    )

                await self._touch_member(connection, actor_id, code)
                joined = await self._fetch_room(
                    connection,
                    actor_id,
                    code,
                    require_member=True,
                )
                if joined is None:
                    raise RepositoryFailure("joined room could not be read")
                return joined

    async def leave_room(self, actor_id: UUID, code: str) -> RoomView | None:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id, host_player_id
                    FROM quiz_online.rooms
                    WHERE code = %s
                    FOR UPDATE
                    """,
                    (code,),
                )
                room = await cursor.fetchone()
                if room is None:
                    raise RoomNotFound
                active_match = await connection.execute(
                    """
                    SELECT 1
                    FROM quiz_online.matches
                    WHERE room_id = %s AND state IN ('running', 'revealing')
                    """,
                    (room["id"],),
                )
                if await active_match.fetchone() is not None:
                    raise MatchInProgress

                deleted = await connection.execute(
                    """
                    DELETE FROM quiz_online.room_members
                    WHERE room_id = %s AND player_id = %s
                    RETURNING player_id
                    """,
                    (room["id"], actor_id),
                )
                if await deleted.fetchone() is None:
                    raise NotMember

                next_cursor = await connection.execute(
                    """
                    SELECT player_id
                    FROM quiz_online.room_members
                    WHERE room_id = %s
                    ORDER BY joined_at ASC, player_id ASC
                    LIMIT 1
                    """,
                    (room["id"],),
                )
                next_member = await next_cursor.fetchone()
                if next_member is None:
                    await connection.execute(
                        "DELETE FROM quiz_online.rooms WHERE id = %s",
                        (room["id"],),
                    )
                    return None

                if room["host_player_id"] == actor_id:
                    await connection.execute(
                        """
                        UPDATE quiz_online.rooms
                        SET host_player_id = %s, updated_at = now(),
                            expires_at = now() + %s::interval
                        WHERE id = %s
                        """,
                        (next_member["player_id"], _ROOM_LIFETIME, room["id"]),
                    )
                return await self._fetch_room(
                    connection,
                    actor_id,
                    code,
                    require_member=False,
                )

    async def update_room(
        self,
        actor_id: UUID,
        code: str,
        patch: dict[str, object],
    ) -> RoomView:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id, host_player_id, capacity, category_id, game_mode
                    FROM quiz_online.rooms
                    WHERE code = %s AND expires_at > now()
                    FOR UPDATE
                    """,
                    (code,),
                )
                room = await cursor.fetchone()
                if room is None:
                    raise RoomNotFound
                if room["host_player_id"] != actor_id:
                    raise NotHost
                active_match = await connection.execute(
                    """
                    SELECT 1
                    FROM quiz_online.matches
                    WHERE room_id = %s AND state IN ('running', 'revealing')
                    """,
                    (room["id"],),
                )
                if await active_match.fetchone() is not None:
                    raise MatchInProgress

                capacity = patch.get("capacity", room["capacity"])
                count_cursor = await connection.execute(
                    "SELECT count(*) AS count FROM quiz_online.room_members WHERE room_id = %s",
                    (room["id"],),
                )
                count_row = await count_cursor.fetchone()
                if count_row is None or int(count_row["count"]) > int(capacity):
                    raise RoomFull

                category = patch.get("category_id", room["category_id"])
                game_mode = patch.get("game_mode", room["game_mode"])
                await connection.execute(
                    """
                    UPDATE quiz_online.rooms
                    SET category_id = %s, capacity = %s, game_mode = %s,
                        updated_at = now(), expires_at = now() + %s::interval
                    WHERE id = %s
                    """,
                    (category, capacity, game_mode, _ROOM_LIFETIME, room["id"]),
                )
                updated = await self._fetch_room(
                    connection,
                    actor_id,
                    code,
                    require_member=True,
                )
                if updated is None:
                    raise RepositoryFailure("updated room could not be read")
                return updated

    async def send_chat(self, actor_id: UUID, code: str, text: str) -> PlayerView:
        del text
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                """
                UPDATE quiz_online.room_members member
                SET last_seen_at = now()
                FROM quiz_online.rooms room
                WHERE member.room_id = room.id
                  AND room.code = %s
                  AND room.expires_at > now()
                  AND member.player_id = %s
                RETURNING member.player_id, member.nickname, member.character_id, room.id
                """,
                (code, actor_id),
            )
            row = await cursor.fetchone()
            if row is None:
                raise NotMember
            await connection.execute(
                """
                UPDATE quiz_online.rooms
                SET updated_at = now(), expires_at = now() + %s::interval
                WHERE id = %s
                """,
                (_ROOM_LIFETIME, row["id"]),
            )
            return PlayerView(
                id=row["player_id"],
                nickname=str(row["nickname"]),
                character_id=row["character_id"],
            )

    async def set_ready(self, actor_id: UUID, code: str, is_ready: bool) -> RoomView:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id
                    FROM quiz_online.rooms
                    WHERE code = %s AND expires_at > now()
                    FOR UPDATE
                    """,
                    (code,),
                )
                room = await cursor.fetchone()
                if room is None:
                    raise RoomNotFound
                active_match = await connection.execute(
                    """
                    SELECT 1
                    FROM quiz_online.matches
                    WHERE room_id = %s AND state IN ('running', 'revealing')
                    """,
                    (room["id"],),
                )
                if await active_match.fetchone() is not None:
                    raise MatchInProgress
                updated_member = await connection.execute(
                    """
                    UPDATE quiz_online.room_members
                    SET is_ready = %s, last_seen_at = now()
                    WHERE room_id = %s AND player_id = %s
                    RETURNING player_id
                    """,
                    (is_ready, room["id"], actor_id),
                )
                if await updated_member.fetchone() is None:
                    raise NotMember
                room_view = await self._fetch_room(
                    connection,
                    actor_id,
                    code,
                    require_member=True,
                )
                if room_view is None:
                    raise RepositoryFailure("ready room could not be read")
                return room_view

    async def start_game(self, actor_id: UUID, code: str) -> MatchSetup:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id, host_player_id, category_id, game_mode
                    FROM quiz_online.rooms
                    WHERE code = %s AND expires_at > now()
                    FOR UPDATE
                    """,
                    (code,),
                )
                room = await cursor.fetchone()
                if room is None:
                    raise RoomNotFound
                if room["host_player_id"] != actor_id:
                    raise NotHost

                running = await connection.execute(
                    """
                    SELECT 1
                    FROM quiz_online.matches
                    WHERE room_id = %s AND state IN ('running', 'revealing')
                    """,
                    (room["id"],),
                )
                if await running.fetchone() is not None:
                    raise MatchInProgress

                members_cursor = await connection.execute(
                    """
                    SELECT player_id, nickname, character_id, is_ready
                    FROM quiz_online.room_members
                    WHERE room_id = %s
                    ORDER BY joined_at ASC, player_id ASC
                    """,
                    (room["id"],),
                )
                members = await members_cursor.fetchall()
                if len(members) < 2 or any(not bool(member["is_ready"]) for member in members):
                    raise MatchNotReady

                try:
                    selected = self._catalog_or_error().select_round(
                        category_id=room["category_id"],
                    )
                except CatalogError as error:
                    raise RepositoryFailure("static question catalog is unavailable") from error

                created = await connection.execute(
                    """
                    INSERT INTO quiz_online.matches (
                        room_id, category_id, game_mode, total_questions,
                        deadline_at, expires_at
                    )
                    VALUES (
                        %s, %s, %s, %s,
                        now() + %s::interval,
                        now() + %s::interval
                    )
                    RETURNING id
                    """,
                    (
                        room["id"],
                        room["category_id"],
                        room["game_mode"],
                        len(selected),
                        _QUESTION_TIMEOUT,
                        _MATCH_LIFETIME,
                    ),
                )
                match = await created.fetchone()
                if match is None:
                    raise RepositoryFailure("match insert returned no row")
                match_id = match["id"]

                for member in members:
                    await connection.execute(
                        """
                        INSERT INTO quiz_online.match_players (
                            match_id, player_id, nickname, character_id
                        )
                        VALUES (%s, %s, %s, %s)
                        """,
                        (
                            match_id,
                            member["player_id"],
                            member["nickname"],
                            member["character_id"],
                        ),
                    )
                for position, question in enumerate(selected, start=1):
                    await connection.execute(
                        """
                        INSERT INTO quiz_online.match_questions (
                            match_id, position, question_id, category_id, choices, answer_index
                        )
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            match_id,
                            position,
                            question.id,
                            question.category,
                            Jsonb(list(question.choices)),
                            question.answer_index,
                        ),
                    )

                await connection.execute(
                    "UPDATE quiz_online.room_members SET is_ready = false WHERE room_id = %s",
                    (room["id"],),
                )
                await connection.execute(
                    """
                    UPDATE quiz_online.rooms
                    SET updated_at = now(), expires_at = now() + %s::interval
                    WHERE id = %s
                    """,
                    (_ROOM_LIFETIME, room["id"]),
                )
                return MatchSetup(
                    id=match_id,
                    category_id=room["category_id"],
                    game_mode=bool(room["game_mode"]),
                    total_questions=len(selected),
                )

    async def get_match(self, actor_id: UUID, code: str) -> MatchRead:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                match = await self._locked_match(connection, actor_id, code)
                if match is None:
                    return MatchRead(match=None, advanced=False)
                advanced = await self._advance_locked_match(connection, match)
                return MatchRead(
                    match=await self._match_view(connection, actor_id, match["id"]),
                    advanced=advanced,
                )

    async def submit_answer(
        self,
        actor_id: UUID,
        code: str,
        *,
        position: int,
        choice_index: int | None,
    ) -> MatchSubmission:
        if type(position) is not int or position < 1:
            raise RepositoryFailure("answer position is invalid")
        if choice_index is not None and (
            type(choice_index) is not int or choice_index not in range(4)
        ):
            raise RepositoryFailure("answer choice is invalid")

        async with self._pool.connection() as connection:
            async with connection.transaction():
                match = await self._locked_match(connection, actor_id, code)
                if match is None:
                    raise MatchNotFound
                if await self._advance_locked_match(connection, match):
                    raise MatchPositionMismatch
                if match["state"] != "running" or int(match["current_position"]) != position:
                    raise MatchPositionMismatch

                question_cursor = await connection.execute(
                    """
                    SELECT question_id, category_id, choices, answer_index
                    FROM quiz_online.match_questions
                    WHERE match_id = %s AND position = %s
                    """,
                    (match["id"], position),
                )
                question = await question_cursor.fetchone()
                if question is None:
                    raise RepositoryFailure("current match question is missing")

                elapsed_cursor = await connection.execute(
                    """
                    SELECT LEAST(
                        20000,
                        GREATEST(
                            0,
                            floor(extract(epoch FROM now() - question_started_at) * 1000)::integer
                        )
                    ) AS elapsed_ms
                    FROM quiz_online.matches
                    WHERE id = %s
                    """,
                    (match["id"],),
                )
                elapsed = await elapsed_cursor.fetchone()
                if elapsed is None:
                    raise RepositoryFailure("current match disappeared")

                timed_out = choice_index is None
                inserted = await connection.execute(
                    """
                    INSERT INTO quiz_online.match_answers (
                        match_id, position, player_id, choice_index, correct, timed_out, elapsed_ms
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (match_id, position, player_id) DO NOTHING
                    RETURNING choice_index, correct, timed_out
                    """,
                    (
                        match["id"],
                        position,
                        actor_id,
                        choice_index,
                        not timed_out and choice_index == int(question["answer_index"]),
                        timed_out,
                        int(elapsed["elapsed_ms"]),
                    ),
                )
                answer = await inserted.fetchone()
                was_inserted = answer is not None
                if answer is None:
                    existing = await connection.execute(
                        """
                        SELECT choice_index, correct, timed_out
                        FROM quiz_online.match_answers
                        WHERE match_id = %s AND position = %s AND player_id = %s
                        """,
                        (match["id"], position, actor_id),
                    )
                    answer = await existing.fetchone()
                if answer is None:
                    raise RepositoryFailure("answer conflict could not be read")

                feedback = self._answer_view(question, answer, position=position)
                advanced = was_inserted and await self._advance_locked_match(connection, match)
                view = await self._match_view(connection, actor_id, match["id"])
                if view is None:
                    raise RepositoryFailure("match answer view could not be read")
                return MatchSubmission(match=view, answer=feedback, advanced=advanced)

    async def advance_expired_matches(self) -> list[str]:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT match.*, room.code
                    FROM quiz_online.matches match
                    JOIN quiz_online.rooms room ON room.id = match.room_id
                    WHERE match.state IN ('running', 'revealing')
                      AND match.deadline_at <= now()
                    ORDER BY match.deadline_at ASC
                    LIMIT 100
                    FOR UPDATE OF match SKIP LOCKED
                    """
                )
                matches = await cursor.fetchall()
                advanced_codes: list[str] = []
                for match in matches:
                    if await self._advance_locked_match(connection, match):
                        advanced_codes.append(str(match["code"]))
                return advanced_codes

    async def is_member(self, actor_id: UUID, code: str) -> bool:
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT 1
                FROM quiz_online.room_members member
                JOIN quiz_online.rooms room ON room.id = member.room_id
                WHERE room.code = %s
                  AND room.expires_at > now()
                  AND member.player_id = %s
                """,
                (code, actor_id),
            )
            return await cursor.fetchone() is not None

    async def touch_member(self, actor_id: UUID, code: str) -> None:
        async with self._pool.connection() as connection:
            await self._touch_member(connection, actor_id, code)

    async def _fetch_room(
        self,
        connection: AsyncConnection[dict[str, Any]],
        actor_id: UUID,
        code: str,
        *,
        require_member: bool,
    ) -> RoomView | None:
        cursor = await connection.execute(
            _ROOM_ROWS_SQL,
            {
                "actor_id": actor_id,
                "code": code,
                "require_member": require_member,
                "room_limit": 1,
            },
        )
        views = _build_room_views(await cursor.fetchall())
        return views[0] if views else None

    def _catalog_or_error(self) -> QuestionCatalog:
        if self._catalog is None:
            raise RepositoryFailure("static question catalog was not configured")
        return self._catalog

    async def _locked_match(
        self,
        connection: AsyncConnection[dict[str, Any]],
        actor_id: UUID,
        code: str,
    ) -> Mapping[str, Any] | None:
        cursor = await connection.execute(
            """
            SELECT match.*, room.code
            FROM quiz_online.matches match
            JOIN quiz_online.rooms room ON room.id = match.room_id
            JOIN quiz_online.match_players player ON player.match_id = match.id
            WHERE room.code = %s
              AND player.player_id = %s
              AND match.expires_at > now()
            ORDER BY match.started_at DESC
            LIMIT 1
            FOR UPDATE OF match
            """,
            (code, actor_id),
        )
        return await cursor.fetchone()

    async def _advance_locked_match(
        self,
        connection: AsyncConnection[dict[str, Any]],
        match: Mapping[str, Any],
    ) -> bool:
        state = str(match["state"])
        if state not in {"running", "revealing"}:
            return False

        match_id = match["id"]
        current_position = int(match["current_position"])
        total_questions = int(match["total_questions"])
        if state == "revealing":
            if current_position >= total_questions:
                completed = await connection.execute(
                    """
                    UPDATE quiz_online.matches
                    SET state = 'finished', finished_at = now(), deadline_at = NULL
                    WHERE id = %s
                      AND state = 'revealing'
                      AND deadline_at <= now()
                    RETURNING id
                    """,
                    (match_id,),
                )
            else:
                completed = await connection.execute(
                    """
                    UPDATE quiz_online.matches
                    SET state = 'running',
                        current_position = current_position + 1,
                        question_started_at = now(),
                        deadline_at = now() + %s::interval
                    WHERE id = %s
                      AND state = 'revealing'
                      AND deadline_at <= now()
                    RETURNING id
                    """,
                    (_QUESTION_TIMEOUT, match_id),
                )
            return await completed.fetchone() is not None

        progress_cursor = await connection.execute(
            """
            SELECT
                deadline_at <= now() AS expired,
                (
                    SELECT count(*)
                    FROM quiz_online.match_players
                    WHERE match_id = %s
                ) AS player_count,
                (
                    SELECT count(*)
                    FROM quiz_online.match_answers
                    WHERE match_id = %s AND position = %s
                ) AS answer_count
            FROM quiz_online.matches
            WHERE id = %s
            """,
            (match_id, match_id, current_position, match_id),
        )
        progress = await progress_cursor.fetchone()
        if progress is None:
            raise RepositoryFailure("locked match disappeared")
        expired = bool(progress["expired"])
        player_count = int(progress["player_count"])
        answer_count = int(progress["answer_count"])
        if not expired and answer_count < player_count:
            return False

        if expired:
            await connection.execute(
                """
                INSERT INTO quiz_online.match_answers (
                    match_id, position, player_id, choice_index, correct, timed_out, elapsed_ms
                )
                SELECT %s, %s, player.player_id, NULL, false, true, 20000
                FROM quiz_online.match_players player
                LEFT JOIN quiz_online.match_answers answer
                  ON answer.match_id = player.match_id
                 AND answer.position = %s
                 AND answer.player_id = player.player_id
                WHERE player.match_id = %s AND answer.player_id IS NULL
                ON CONFLICT (match_id, position, player_id) DO NOTHING
                """,
                (match_id, current_position, current_position, match_id),
            )

        revealed = await connection.execute(
            """
            UPDATE quiz_online.matches
            SET state = 'revealing', deadline_at = now() + %s::interval
            WHERE id = %s AND state = 'running'
            RETURNING id
            """,
            (_REVEAL_DURATION, match_id),
        )
        return await revealed.fetchone() is not None

    async def _match_view(
        self,
        connection: AsyncConnection[dict[str, Any]],
        actor_id: UUID,
        match_id: UUID,
    ) -> MatchView | None:
        cursor = await connection.execute(
            """
            SELECT match.id, match.state, match.category_id, match.game_mode,
                   match.current_position, match.total_questions, match.deadline_at
            FROM quiz_online.matches match
            JOIN quiz_online.match_players player ON player.match_id = match.id
            WHERE match.id = %s AND player.player_id = %s AND match.expires_at > now()
            """,
            (match_id, actor_id),
        )
        match = await cursor.fetchone()
        if match is None:
            return None
        scores = await self._score_views(connection, match_id)
        question_view: MatchQuestionView | None = None
        own_answer: MatchAnswerView | None = None
        if match["state"] in {"running", "revealing"}:
            question_cursor = await connection.execute(
                """
                SELECT question_id, category_id, choices, answer_index
                FROM quiz_online.match_questions
                WHERE match_id = %s AND position = %s
                """,
                (match_id, match["current_position"]),
            )
            question = await question_cursor.fetchone()
            if question is None:
                raise RepositoryFailure("current match question is missing")
            question_view = self._question_view(
                question,
                position=int(match["current_position"]),
                total=int(match["total_questions"]),
            )
            answer_cursor = await connection.execute(
                """
                SELECT choice_index, correct, timed_out
                FROM quiz_online.match_answers
                WHERE match_id = %s AND position = %s AND player_id = %s
                """,
                (match_id, match["current_position"], actor_id),
            )
            answer = await answer_cursor.fetchone()
            if answer is not None:
                own_answer = self._answer_view(
                    question,
                    answer,
                    position=int(match["current_position"]),
                )
        deadline_at = match["deadline_at"]
        return MatchView(
            id=match["id"],
            state=str(match["state"]),
            category_id=match["category_id"],
            game_mode=bool(match["game_mode"]),
            current_position=int(match["current_position"]),
            total_questions=int(match["total_questions"]),
            deadline_at=_iso(deadline_at) if isinstance(deadline_at, datetime) else None,
            question=question_view,
            own_answer=own_answer,
            scores=scores,
        )

    async def _score_views(
        self,
        connection: AsyncConnection[dict[str, Any]],
        match_id: UUID,
    ) -> tuple[MatchScoreView, ...]:
        cursor = await connection.execute(
            """
            SELECT
                player.player_id,
                player.nickname,
                player.character_id,
                COALESCE(sum(CASE WHEN answer.correct THEN 10 ELSE 0 END), 0)::integer AS score,
                count(answer.player_id) FILTER (WHERE answer.correct)::integer AS correct_count,
                count(answer.player_id)::integer AS answered_count
            FROM quiz_online.match_players player
            LEFT JOIN quiz_online.match_answers answer
              ON answer.match_id = player.match_id AND answer.player_id = player.player_id
            WHERE player.match_id = %s
            GROUP BY player.player_id, player.nickname, player.character_id
            ORDER BY score DESC, correct_count DESC, answered_count DESC, player.nickname ASC
            """,
            (match_id,),
        )
        return tuple(
            MatchScoreView(
                player_id=row["player_id"],
                nickname=str(row["nickname"]),
                character_id=row["character_id"],
                score=int(row["score"]),
                correct_count=int(row["correct_count"]),
                answered_count=int(row["answered_count"]),
            )
            for row in await cursor.fetchall()
        )

    def _question_view(
        self,
        question: Mapping[str, Any],
        *,
        position: int,
        total: int,
    ) -> MatchQuestionView:
        catalog_question = self._catalog_question(question)
        choices = _choices(question["choices"])
        return MatchQuestionView(
            id=str(question["question_id"]),
            category_id=str(question["category_id"]),
            question=catalog_question.question,
            choices=choices,
            position=position,
            total=total,
        )

    def _answer_view(
        self,
        question: Mapping[str, Any],
        answer: Mapping[str, Any],
        *,
        position: int,
    ) -> MatchAnswerView:
        catalog_question = self._catalog_question(question)
        answer_index = int(question["answer_index"])
        choices = _choices(question["choices"])
        if choices[answer_index] != catalog_question.choices[catalog_question.answer_index]:
            raise RepositoryFailure("static catalog no longer matches persisted match question")
        choice_index = answer["choice_index"]
        if choice_index is not None:
            choice_index = int(choice_index)
        return MatchAnswerView(
            position=position,
            choice_index=choice_index,
            correct=bool(answer["correct"]),
            timed_out=bool(answer["timed_out"]),
            answer_index=answer_index,
            explanation=catalog_question.explanation,
        )

    def _catalog_question(self, question: Mapping[str, Any]) -> SelectedQuestion:
        try:
            catalog_question = self._catalog_or_error().get(str(question["question_id"]))
        except CatalogError as error:
            raise RepositoryFailure(
                "persisted match question is missing from static catalog"
            ) from error
        if catalog_question.category != question["category_id"]:
            raise RepositoryFailure("persisted match category does not match static catalog")
        return catalog_question

    async def _player_row(
        self,
        connection: AsyncConnection[dict[str, Any]],
        player_id: UUID,
    ) -> Mapping[str, Any] | None:
        cursor = await connection.execute(
            """
            SELECT nickname, character_id
            FROM quiz_online.players
            WHERE id = %s AND expires_at > now()
            """,
            (player_id,),
        )
        return await cursor.fetchone()

    async def _touch_member(
        self,
        connection: AsyncConnection[dict[str, Any]],
        actor_id: UUID,
        code: str,
    ) -> None:
        cursor = await connection.execute(
            """
            UPDATE quiz_online.room_members member
            SET last_seen_at = now()
            FROM quiz_online.rooms room
            WHERE member.room_id = room.id
              AND room.code = %s
              AND member.player_id = %s
            RETURNING room.id
            """,
            (code, actor_id),
        )
        row = await cursor.fetchone()
        if row is None:
            return
        await connection.execute(
            """
            UPDATE quiz_online.rooms
            SET updated_at = now(), expires_at = now() + %s::interval
            WHERE id = %s
            """,
            (_ROOM_LIFETIME, row["id"]),
        )

    async def cleanup_expired_resources(self) -> None:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                await connection.execute("SELECT quiz_online.cleanup_expired_matches()")
                await connection.execute(_DELETE_EXPIRED_ROOMS_SQL)
                await connection.execute(
                    _DELETE_STALE_MEMBERS_SQL,
                    (_MEMBER_STALE_AFTER, _MEMBER_STALE_AFTER),
                )
                await connection.execute(_TRANSFER_ORPHANED_HOSTS_SQL)
                await connection.execute(_DELETE_EMPTY_ROOMS_SQL)
                await connection.execute(_DELETE_EXPIRED_PLAYERS_SQL)


def _make_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))


def _unique_nickname(wanted: str, taken: set[str]) -> str:
    if wanted not in taken:
        return wanted
    for number in range(1, 1000):
        candidate = f"{wanted}{number}"
        if candidate not in taken:
            return candidate
    raise RepositoryFailure("could not allocate a unique nickname")


def _iso(value: datetime) -> str:
    return value.isoformat()


def _choices(value: object) -> tuple[str, ...]:
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(not isinstance(item, str) for item in value)
    ):
        raise RepositoryFailure("persisted match choices are invalid")
    return tuple(value)


def _build_room_views(rows: Sequence[Mapping[str, Any]]) -> list[RoomView]:
    grouped: dict[UUID, dict[str, Any]] = {}
    for row in rows:
        room_id = row["room_id"]
        item = grouped.get(room_id)
        if item is None:
            created_at = row["created_at"]
            if isinstance(created_at, datetime):
                created_at = created_at.isoformat()
            item = {
                "code": str(row["code"]),
                "name": str(row["name"]),
                "category_id": row["category_id"],
                "capacity": int(row["capacity"]),
                "game_mode": bool(row["game_mode"]),
                "players": [],
                "is_public": bool(row["is_public"]),
                "has_password": bool(row["has_password"]),
                "is_mine": bool(row["is_mine"]),
                "joined": bool(row["joined"]),
                "created_at": str(created_at),
            }
            grouped[room_id] = item
        if row["player_id"] is not None:
            item["players"].append(
                PlayerView(
                    id=row["player_id"],
                    nickname=str(row["nickname"]),
                    character_id=row["character_id"],
                    is_ready=bool(row["is_ready"]),
                )
            )

    return [
        RoomView(
            code=item["code"],
            name=item["name"],
            category_id=item["category_id"],
            capacity=item["capacity"],
            game_mode=item["game_mode"],
            players=tuple(item["players"]),
            is_public=item["is_public"],
            has_password=item["has_password"],
            is_mine=item["is_mine"],
            joined=item["joined"],
            created_at=item["created_at"],
        )
        for item in grouped.values()
    ]
