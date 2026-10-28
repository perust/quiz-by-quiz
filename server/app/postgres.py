from __future__ import annotations

import logging
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection, errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .domain import (
    DEFAULT_CHARACTER_ID,
    MIN_MATCH_PLAYERS,
    UNTIMED_ELAPSED_MS_CAP,
    ValidatedPlayer,
    ValidatedRoom,
)
from .nickname_filter import ranking_nickname
from .question_catalog import (
    RECENT_QUESTION_MEMORY,
    CatalogError,
    QuestionCatalog,
    SelectedQuestion,
)
from .repository import (
    OWN_RECORDS_LIMIT,
    RANKING_BOARDS,
    SOLO_ROOM_CEILING,
    AbsentHostSweep,
    AccessInfo,
    CleanupCounts,
    EndedSoloMatch,
    ExpiredMatchAdvance,
    MatchAnswerView,
    MatchInProgress,
    MatchNotFound,
    MatchNotReady,
    MatchPositionMismatch,
    MatchQuestionView,
    MatchRead,
    MatchReviewView,
    MatchScoreView,
    MatchSetup,
    MatchSubmission,
    MatchView,
    MemberConnected,
    NotHost,
    NotMember,
    OwnBestView,
    OwnRecordsView,
    OwnRecordView,
    PlayerView,
    RankingBoardView,
    RankingEntryView,
    RankingPeriod,
    RepositoryFailure,
    RoomCounts,
    RoomFull,
    RoomNotFound,
    RoomView,
    SoloCreateLimited,
    SoloEnd,
    SoloRoomsFull,
    SoloStart,
    StandingAnswerSource,
    TokenConflict,
    ranking_owner_key,
)

_logger = logging.getLogger(__name__)

_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_ROOM_LIFETIME = "24 hours"
_MEMBER_STALE_AFTER = "30 minutes"
_PLAYER_LIFETIME = "2 hours"
_MATCH_LIFETIME = "2 hours"
# 문항 마감은 고정값이 아니다. 방장이 방마다 고른 문항 시간(20초·40초, migration 011)을 판을
# 열 때 matches.question_time_ms에 옮겨 적고, 모든 문항 마감·시간 초과 기록이 그 판의 값을 쓴다.
# 혼자 방의 «제한 없음»(PRD 10.1 #9, migration 013)은 NULL이다 — 마감(`now() + NULL`)도 NULL이라
# 마감 sweep(`deadline_at <= now()`)이 보지 않고, 시간 초과·끊긴 사람 채우기·발밑 칸도 없다. 공개는
# 그 사람이 답을 낼 때다.

# 정답·해설을 실제로 읽을 시간. 공개 카드는 «다음 문제까지 N초»를 보여 준다.
_REVEAL_DURATION = "8 seconds"

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
        ) AS joined,
        EXISTS (
            SELECT 1
            FROM quiz_online.matches active_match
            WHERE active_match.room_id = candidate.id
              AND active_match.state IN ('running', 'revealing')
        ) AS is_playing,
        EXISTS (
            SELECT 1
            FROM quiz_online.matches my_match
            JOIN quiz_online.match_players my_player ON my_player.match_id = my_match.id
            WHERE my_match.room_id = candidate.id
              AND my_match.state IN ('running', 'revealing')
              AND my_player.player_id = %(actor_id)s
        ) AS in_match,
        EXISTS (
            SELECT 1
            FROM quiz_online.solo_rooms solo
            WHERE solo.room_id = candidate.id
        ) AS solo
    FROM quiz_online.rooms candidate
    WHERE candidate.expires_at > now()
      AND (
          %(code)s::char(6) IS NULL
          OR candidate.code = %(code)s::char(6)
      )
      -- 혼자 푸는 온라인 판의 방(FR-7.13 3단계)은 그 방의 사람에게만 보인다. 남의 로비 목록에도,
      -- 코드로 묻는 남에게도 없는 방이다
      AND (
          NOT EXISTS (
              SELECT 1
              FROM quiz_online.solo_rooms hidden_solo
              WHERE hidden_solo.room_id = candidate.id
          )
          OR EXISTS (
              SELECT 1
              FROM quiz_online.room_members solo_member
              WHERE solo_member.room_id = candidate.id
                AND solo_member.player_id = %(actor_id)s
          )
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
    r.question_time_ms,
    r.is_public,
    (r.password_hash IS NOT NULL) AS has_password,
    (r.host_player_id = %(actor_id)s) AS is_mine,
    selected.joined,
    selected.is_playing,
    selected.in_match,
    selected.solo,
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
    (member.player_id = r.host_player_id) DESC NULLS LAST,
    member.joined_at ASC,
    member.player_id ASC
"""

# 이 사람이 진행 중인 판의 참가자인가. 나가기·준비는 방 전체가 아니라 이것으로 막는다 —
# 끊겨서 판에서 빠진 멤버(U24)까지 막으면 판이 끝날 때까지 방에 갇힌다.
_PLAYS_ACTIVE_MATCH_SQL = """
SELECT 1
FROM quiz_online.matches active_match
JOIN quiz_online.match_players player ON player.match_id = active_match.id
WHERE active_match.room_id = %s
  AND active_match.state IN ('running', 'revealing')
  AND player.player_id = %s
"""

# presence sweep이 끊긴 사람이 있는 방들의 방장과 참가자를 한 번에 읽는다. 잠그지 않는다 —
# 넘길 방만 transfer_absent_host가 잠그고 다시 확인한다. is_member와 같이 만료된 방은 없는 방이다.
_ABSENT_HOST_ROOMS_SQL = """
SELECT room.code::text AS code, room.host_player_id, member.player_id
FROM quiz_online.rooms room
LEFT JOIN quiz_online.room_members member ON member.room_id = room.id
WHERE room.code = ANY(%s::char(6)[])
  AND room.expires_at > now()
ORDER BY room.code ASC, member.joined_at ASC, member.player_id ASC
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

# 마감이 없는 «제한 없음» 혼자 판은 스스로 끝나지 않는다(migration 013). 판의 누구도 그 방에서 30분
# (멤버 정리와 같은 창) 넘게 보이지 않았으면 기록 없이 끝낸다 — 끝까지 풀지 않은 판은 기록하지
# 않는다 (FR-6, N04). 그러면 아래 멤버 정리가 같은 transaction에서 그 사람과 빈 방(표시도 함께)을
# 지운다. 판이 도는 화면은 소켓으로 15초마다 last_seen_at을 새로 쓰므로 푸는 중인 판은 끝내지
# 않는다. 그래도 판은 시작 뒤 2시간(`_MATCH_LIFETIME`)이면 `cleanup_expired_matches()`가 지운다.
_ABANDON_IDLE_UNTIMED_MATCHES_SQL = """
WITH idle AS MATERIALIZED (
    SELECT match.id
    FROM quiz_online.matches match
    WHERE match.state = 'running'
      AND match.question_time_ms IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM quiz_online.match_players player
          JOIN quiz_online.room_members member
            ON member.room_id = match.room_id AND member.player_id = player.player_id
          WHERE player.match_id = match.id
            AND member.last_seen_at > now() - %s::interval
      )
    ORDER BY match.id
    FOR UPDATE OF match SKIP LOCKED
)
UPDATE quiz_online.matches match
SET state = 'abandoned', finished_at = now(), deadline_at = NULL
FROM idle
WHERE match.id = idle.id
"""

# 그 방에서 도는 판(있으면 하나다 — one_active_match_per_room_idx). 혼자 판을 끝낼 때 잠근다
_LOCKED_ACTIVE_MATCH_SQL = """
SELECT match.*, room.code
FROM quiz_online.matches match
JOIN quiz_online.rooms room ON room.id = match.room_id
WHERE match.room_id = %s
  AND match.state IN ('running', 'revealing')
FOR UPDATE OF match
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

# 운영 요약(5분마다)의 방·판 수 (deploy/oracle/README.md «Operational log»). 로비와 같이 만료된 방은
# 없는 방이고, 게임 중인 방은 진행 중인(running·revealing) 판이 있는 방이다. 집계 하나라 방이 많아도
# 결과는 한 줄이다.
_OPS_COUNTS_SQL = """
SELECT
    count(*) FILTER (WHERE NOT room_state.playing) AS waiting_rooms,
    count(*) FILTER (WHERE room_state.playing) AS playing_rooms,
    (
        SELECT count(*)
        FROM quiz_online.matches running_match
        WHERE running_match.state IN ('running', 'revealing')
    ) AS running_matches
FROM quiz_online.rooms room
CROSS JOIN LATERAL (
    SELECT EXISTS (
        SELECT 1
        FROM quiz_online.matches active_match
        WHERE active_match.room_id = room.id
          AND active_match.state IN ('running', 'revealing')
    ) AS playing
) room_state
WHERE room.expires_at > now()
"""

# 온라인 랭킹 (FR-7.13 2단계, migration 012). «이번 주»는 서울 시각 월요일 0시부터 다음 월요일 0시
# 전까지다. 기록의 week_start(저장 열)와 같은 식으로 지금의 주를 고르고, 창의 두 끝을 함께 돌려준다.
_RANKING_WEEK_SQL = """
SELECT
    week.week_start,
    (week.week_start::timestamp AT TIME ZONE 'Asia/Seoul') AS window_start,
    ((week.week_start + 7)::timestamp AT TIME ZONE 'Asia/Seoul') AS window_end
FROM (
    SELECT (
        date_trunc('week', COALESCE(%(at)s::timestamptz, now()) AT TIME ZONE 'Asia/Seoul')
    )::date AS week_start
) week
"""

# 상위 기록. 점수 내림차순, 같은 점수는 먼저 남긴 기록(기록 시각 → 같은 판이면 그 판의 순위대로
# 남긴 id)이 위다 — 혼자 하기 랭킹(FR-6.3)과 같은 «먼저 달성한 순»이다. 두 색인을 그대로 탄다.
# 내 기록은 player id와 주인 열쇠(브라우저 토큰에서 나온 owner_key)가 모두 같을 때만이다 — id만 보면
# players 줄이 지워진 뒤 그 id를 제 토큰으로 다시 등록한 사람이 남의 기록을 «나»로 읽는다.
_RANKING_COLUMNS = """
SELECT
    ranking.nickname,
    ranking.character_id,
    ranking.score,
    ranking.correct_count,
    ranking.total_questions,
    ranking.recorded_at,
    COALESCE(
        ranking.player_id = %(actor_id)s::uuid AND ranking.owner_key = %(owner_key)s::bytea,
        false
    ) AS is_mine
FROM quiz_online.online_rankings ranking
"""
_RANKING_ORDER = """
ORDER BY ranking.score DESC, ranking.recorded_at ASC, ranking.id ASC
LIMIT %(limit)s
"""
_RANKING_ALL_SQL = _RANKING_COLUMNS + "WHERE ranking.board = %(board)s" + _RANKING_ORDER
_RANKING_WEEK_ENTRIES_SQL = (
    _RANKING_COLUMNS
    + "WHERE ranking.board = %(board)s AND ranking.week_start = %(week_start)s"
    + _RANKING_ORDER
)

_INSERT_RANKING_SQL = """
INSERT INTO quiz_online.online_rankings (
    match_id, player_id, mode, category_id, score, correct_count, total_questions,
    question_time_ms, nickname, character_id, owner_key, recorded_at
)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (match_id, player_id) DO NOTHING
"""
# 기록할 판 참가자들의 토큰 해시. 판이 도는 동안 players 줄은 지워지지 않는다
# (`_DELETE_EXPIRED_PLAYERS_SQL`이 살아 있는 판의 참가자를 건너뛴다)
_RANKING_OWNER_TOKENS_SQL = """
SELECT id, token_hash FROM quiz_online.players WHERE id = ANY(%s)
"""

# 내 판마다 최고 기록 (FR-7.13 3단계 — 홈의 별 점수·결과의 최고 기록 비교,
# FR-2.3·FR-5.7). 랭킹과 같은 순서(점수 내림차순, 같은 점수는 먼저 남긴 기록)의 첫
# 줄이다. player id와 주인 열쇠가 모두 같은 기록만 센다 — id만 보면 지워진 id를 다시
# 등록한 사람이 남의 최고 점수를 «내 것»으로 읽는다.
# `online_rankings_player_board_order_idx`를 탄다. 결과 화면은 방금 닫힌 판을 빼고
# 묻는다(exclude_match).
_OWN_BEST_SQL = """
SELECT DISTINCT ON (ranking.board)
    ranking.board,
    ranking.score,
    ranking.correct_count,
    ranking.total_questions,
    ranking.recorded_at
FROM quiz_online.online_rankings ranking
WHERE ranking.player_id = %(actor_id)s
  AND ranking.owner_key = %(owner_key)s
  AND (%(exclude_match)s::uuid IS NULL OR ranking.match_id <> %(exclude_match)s::uuid)
ORDER BY ranking.board, ranking.score DESC, ranking.recorded_at ASC, ranking.id ASC
"""

# 내 온라인 기록 (기록 내보내기). 최근 것부터 한도 + 1개를 읽어 덜어 냈는지 안다
_OWN_RECORDS_SQL = """
SELECT
    ranking.board,
    ranking.score,
    ranking.correct_count,
    ranking.total_questions,
    ranking.question_time_ms,
    ranking.nickname,
    ranking.recorded_at
FROM quiz_online.online_rankings ranking
WHERE ranking.player_id = %(actor_id)s
  AND ranking.owner_key = %(owner_key)s
ORDER BY ranking.recorded_at DESC, ranking.id DESC
LIMIT %(limit)s
"""

# 그 사람의 혼자 방 (FR-7.13 3단계). 표시(solo_rooms)는 사람마다 하나다. 판이 도는지·그 사람이 아직
# 멤버인지·만료됐는지를 함께 읽어, 다시 쓸지 지우고 새로 만들지 정한다
_SOLO_ROOM_SQL = """
SELECT
    room.id,
    room.code::text AS code,
    room.host_player_id,
    room.category_id,
    room.game_mode,
    room.question_time_ms,
    (room.expires_at > now()) AS alive,
    EXISTS (
        SELECT 1
        FROM quiz_online.room_members member
        WHERE member.room_id = room.id AND member.player_id = solo.player_id
    ) AS member,
    EXISTS (
        SELECT 1
        FROM quiz_online.matches active_match
        WHERE active_match.room_id = room.id
          AND active_match.state IN ('running', 'revealing')
    ) AS playing
FROM quiz_online.solo_rooms solo
JOIN quiz_online.rooms room ON room.id = solo.room_id
WHERE solo.player_id = %s
FOR UPDATE OF room
"""

# 이 방의 지난 판에 나온 문항과 마지막으로 낸 시각 (N08). 판은 `_MATCH_LIFETIME` 동안 남으므로
# 그 사이의 «한 판 더»가 이 기억을 쓴다. 프로세스 메모리가 아니라 DB에서 읽어 worker 수·재시작과
# 무관하고, 방이 지워지면 판과 함께 사라진다. `matches_room_started_at_idx`를 탄다.
_RECENT_ROOM_QUESTIONS_SQL = """
SELECT question.question_id, max(match.started_at) AS last_used
FROM quiz_online.matches match
JOIN quiz_online.match_questions question ON question.match_id = match.id
WHERE match.room_id = %s
GROUP BY question.question_id
ORDER BY last_used DESC, question.question_id ASC
LIMIT %s
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

    async def schema_version(self) -> int:
        try:
            async with self._pool.connection(timeout=3) as connection:
                cursor = await connection.execute(
                    "SELECT quiz_online.character_only_schema_version() AS schema_version"
                )
                row = await cursor.fetchone()
        except errors.UndefinedFunction:
            return 0
        if row is None:
            return 0
        return int(row["schema_version"])

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
                WHEN %s OR current_player.character_id IS NULL THEN EXCLUDED.character_id
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
                                question_time_ms,
                                is_public, password_hash, host_player_id, expires_at
                            )
                            VALUES (
                                %s, %s, %s, %s, %s, %s, %s, %s, %s,
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
                                spec.question_time_ms,
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
                                player["character_id"] or DEFAULT_CHARACTER_ID,
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
                SELECT
                    room.is_public,
                    room.password_hash,
                    EXISTS (
                        SELECT 1 FROM quiz_online.solo_rooms solo WHERE solo.room_id = room.id
                    ) AS solo
                FROM quiz_online.rooms room
                WHERE room.code = %s AND room.expires_at > now()
                """,
                (code,),
            )
            row = await cursor.fetchone()
            if row is None:
                return None
            return AccessInfo(
                is_public=bool(row["is_public"]),
                password_hash=row["password_hash"],
                solo=bool(row["solo"]),
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
                    # 혼자 방(FR-7.13 3단계)에는 그 사람 말고 아무도 들어오지 못한다.
                    # API가 먼저 «없는 방»으로 거절하고 여기서 한 번 더 막는다 —
                    # 남에게는 없는 방과 같다
                    solo = await connection.execute(
                        "SELECT 1 FROM quiz_online.solo_rooms WHERE room_id = %s",
                        (room["id"],),
                    )
                    if await solo.fetchone() is not None:
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
                        (
                            room["id"],
                            actor_id,
                            nickname,
                            player["character_id"] or DEFAULT_CHARACTER_ID,
                        ),
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

    async def leave_room(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> RoomView | None:
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
                # 판이 도는 동안 나갈 수 없는 것은 그 판의 참가자뿐이다. 끊겨서 판에서 빠진
                # 멤버(U24)는 판이 끝날 때까지 기다리지 않고 나간다.
                playing = await connection.execute(
                    _PLAYS_ACTIVE_MATCH_SQL,
                    (room["id"], actor_id),
                )
                if await playing.fetchone() is not None:
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

                # 나가는 방장의 자리는 가장 먼저 들어온 **접속 중인** 사람이 받는다. 모두 끊겼으면
                # 가장 먼저 들어온 사람이 받고, 누가 다시 붙으면 presence sweep이 넘긴다.
                next_cursor = await connection.execute(
                    """
                    SELECT player_id
                    FROM quiz_online.room_members
                    WHERE room_id = %s
                    ORDER BY (player_id = ANY(%s)) ASC, joined_at ASC, player_id ASC
                    LIMIT 1
                    """,
                    (room["id"], list(absent_player_ids)),
                )
                next_member = await next_cursor.fetchone()
                if next_member is None:
                    await connection.execute(
                        "DELETE FROM quiz_online.rooms WHERE id = %s",
                        (room["id"],),
                    )
                    return None

                host_left = room["host_player_id"] == actor_id
                if host_left:
                    await connection.execute(
                        """
                        UPDATE quiz_online.rooms
                        SET host_player_id = %s, updated_at = now(),
                            expires_at = now() + %s::interval
                        WHERE id = %s
                        """,
                        (next_member["player_id"], _ROOM_LIFETIME, room["id"]),
                    )
                view = await self._fetch_room(
                    connection,
                    actor_id,
                    code,
                    require_member=False,
                )
                # 운영 기록이 «나가며 방장을 넘겼다»를 남긴다. payload에는 싣지 않는다
                if view is None or not host_left:
                    return view
                return replace(view, host_transferred=True)

    async def remove_member(
        self,
        actor_id: UUID,
        code: str,
        player_id: UUID,
        *,
        absent_player_ids: frozenset[UUID],
        allow_connected: bool = False,
    ) -> RoomView:
        """방장이 다른 참가자를 방에서 뺀다 (U24).

        방장만, 남만(방장 자신은 나가기로 떠난다), 방에 있는 사람만 뺀다. 도는 판에 자리가 있는
        사람은 판이 끝난 뒤에 뺀다(판에서 빠진 멤버는 판이 도는 동안에도 뺄 수 있다).
        `allow_connected` 가 없으면 탭을 닫고 떠난 자리를 비우는 일이라 유예를 넘겨 끊긴 사람만
        뺀다. 접속 중인 사람은 방장이 그렇게 보고 확인했을 때만 뺀다 — 잠시 다시 들어오지 못하게
        막는 것은 API의 메모리 기록이 맡고 DB는 모른다. 방을 잠그고 그 안에서 모두 다시 확인한다.
        """
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id, host_player_id
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
                # 요청한 방장은 지금 여기 있다. 소켓 없이 REST만 쓰는 방장이 끊긴 사람으로
                # 세어져 있어도 자신을 내보내지 않는다.
                if player_id == actor_id:
                    raise MemberConnected
                member = await connection.execute(
                    """
                    SELECT 1
                    FROM quiz_online.room_members
                    WHERE room_id = %s AND player_id = %s
                    """,
                    (room["id"], player_id),
                )
                if await member.fetchone() is None:
                    raise NotMember
                if not allow_connected and player_id not in absent_player_ids:
                    raise MemberConnected
                playing = await connection.execute(
                    _PLAYS_ACTIVE_MATCH_SQL,
                    (room["id"], player_id),
                )
                if await playing.fetchone() is not None:
                    raise MatchInProgress
                await connection.execute(
                    """
                    DELETE FROM quiz_online.room_members
                    WHERE room_id = %s AND player_id = %s
                    """,
                    (room["id"], player_id),
                )
                view = await self._fetch_room(
                    connection,
                    actor_id,
                    code,
                    require_member=True,
                )
                if view is None:
                    raise RepositoryFailure("room could not be read after removing a member")
                return view

    async def transfer_absent_hosts(
        self,
        absent_by_room: Mapping[str, frozenset[UUID]],
    ) -> AbsentHostSweep:
        """끊긴 사람이 있는 방들을 한 번에 읽고, 끊긴 방장은 접속 중인 참가자에게 넘긴다.

        presence sweep이 5초마다 부른다. 끊긴 사람의 집합이 바뀔 때만 보면 놓친다 — 넘길
        사람이 없던 방에 나중에 누가 들어오거나, 나가기 승계·30분 정리가 끊긴 사람에게 방장을
        넘겨도 그 집합은 그대로다. 그래서 집합과 무관하게 «방장이 끊겼고 접속 중인 사람이
        있다»만 본다. 참가자 목록을 함께 돌려줘 멤버십이 끝난 사람의 접속 기록을 hub가 버린다.
        """
        if not absent_by_room:
            return AbsentHostSweep(transferred=frozenset(), members={})
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                _ABSENT_HOST_ROOMS_SQL,
                (list(absent_by_room),),
            )
            rows = await cursor.fetchall()
        hosts: dict[str, UUID] = {}
        members: dict[str, list[UUID]] = {}
        for row in rows:
            room_code = str(row["code"])
            hosts[room_code] = row["host_player_id"]
            joined = members.setdefault(room_code, [])
            if row["player_id"] is not None:
                joined.append(row["player_id"])
        transferred: set[str] = set()
        for room_code, host_id in hosts.items():
            absent = absent_by_room.get(room_code, frozenset())
            if host_id not in absent:
                continue
            if all(player_id in absent for player_id in members[room_code]):
                continue
            if await self.transfer_absent_host(room_code, absent):
                transferred.add(room_code)
        return AbsentHostSweep(
            transferred=frozenset(transferred),
            members={room_code: frozenset(ids) for room_code, ids in members.items()},
        )

    async def transfer_absent_host(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
    ) -> bool:
        """유예를 넘겨 끊긴 방장 자리를 가장 먼저 들어온 접속 중인 참가자에게 넘긴다.

        방을 잠그고 다시 확인한다 — 읽은 뒤에 방장이 바뀌었거나 넘길 사람이 나갔을 수 있다.
        """
        if not absent_player_ids:
            return False
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id, host_player_id
                    FROM quiz_online.rooms
                    WHERE code = %s AND expires_at > now()
                    FOR UPDATE
                    """,
                    (code,),
                )
                room = await cursor.fetchone()
                if room is None or room["host_player_id"] not in absent_player_ids:
                    return False
                members_cursor = await connection.execute(
                    """
                    SELECT player_id
                    FROM quiz_online.room_members
                    WHERE room_id = %s
                    ORDER BY joined_at ASC, player_id ASC
                    """,
                    (room["id"],),
                )
                successor = next(
                    (
                        member["player_id"]
                        for member in await members_cursor.fetchall()
                        if member["player_id"] not in absent_player_ids
                    ),
                    None,
                )
                if successor is None:
                    return False
                await connection.execute(
                    """
                    UPDATE quiz_online.rooms
                    SET host_player_id = %s, updated_at = now()
                    WHERE id = %s
                    """,
                    (successor, room["id"]),
                )
                return True

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
                    SELECT id, host_player_id, capacity, category_id, question_time_ms
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
                # 판이 도는 동안에는 어떤 설정도 바꾸지 않는다 — 문항 시간은 그 판의 마감이
                # 이미 쓰고 있다
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
                question_time = patch.get("question_time_ms", room["question_time_ms"])
                await connection.execute(
                    """
                    UPDATE quiz_online.rooms
                    SET category_id = %s, capacity = %s, question_time_ms = %s,
                        updated_at = now(), expires_at = now() + %s::interval
                    WHERE id = %s
                    """,
                    (category, capacity, question_time, _ROOM_LIFETIME, room["id"]),
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
                character_id=row["character_id"] or DEFAULT_CHARACTER_ID,
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
                # 판의 참가자만 판이 끝날 때까지 기다린다. 판에서 빠진 멤버(U24)는 다음 판을
                # 미리 준비해 둔다 — 시작이 모두의 준비를 되돌리므로 도는 판에는 영향이 없다.
                playing = await connection.execute(
                    _PLAYS_ACTIVE_MATCH_SQL,
                    (room["id"], actor_id),
                )
                if await playing.fetchone() is not None:
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

    async def start_game(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSetup:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT id, host_player_id, category_id, game_mode, question_time_ms
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
                return await self._start_locked_match(
                    connection,
                    room,
                    actor_id,
                    absent_player_ids=absent_player_ids,
                )

    async def _start_locked_match(
        self,
        connection: AsyncConnection[dict[str, Any]],
        room: Mapping[str, Any],
        actor_id: UUID,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSetup:
        """잠근 방(`FOR UPDATE`)에서 판을 연다. 방장 확인은 부르는 쪽이 했다.

        «게임 시작»(방장)과 혼자 푸는 온라인 판(`start_solo`)이 같은 길을 쓴다 — 출제·마감·준비
        되돌리기가 두 벌이 되지 않는다.
        """
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
        # 방장의 시작 요청이 곧 방장의 준비다. 유예를 넘겨 끊긴 참가자는
        # 기다리지도, 판에 넣지도 않는다(멤버십과 재입장 유예는 그대로).
        # 세는 사람은 방장 혼자여도 된다(MIN_MATCH_PLAYERS) — 혼자 온 사람도 방을
        # 만들어 푼다.
        members = [
            member
            for member in await members_cursor.fetchall()
            if member["player_id"] == actor_id
            or member["player_id"] not in absent_player_ids
        ]
        if len(members) < MIN_MATCH_PLAYERS or any(
            not bool(member["is_ready"])
            for member in members
            if member["player_id"] != actor_id
        ):
            raise MatchNotReady

        recent_cursor = await connection.execute(
            _RECENT_ROOM_QUESTIONS_SQL,
            (room["id"], RECENT_QUESTION_MEMORY),
        )
        recent_use = {
            str(row["question_id"]): row["last_used"].timestamp()
            for row in await recent_cursor.fetchall()
        }
        try:
            # 같은 방의 «한 판 더»가 방금 푼 문제를 되풀이하지 않는다 (N08)
            selected = self._catalog_or_error().select_round(
                category_id=room["category_id"],
                recent_use=recent_use,
            )
        except CatalogError as error:
            raise RepositoryFailure("static question catalog is unavailable") from error

        # 방장이 고른 문항 시간을 판에 옮겨 적는다. 이 판의 모든 문항 마감이 이 값이다. 혼자 방의
        # «제한 없음»(NULL)이면 마감도 NULL이다 — `now() + NULL`이 NULL이다(migration 013)
        raw_question_time = room["question_time_ms"]
        question_time_ms = None if raw_question_time is None else int(raw_question_time)
        created = await connection.execute(
            """
            INSERT INTO quiz_online.matches (
                room_id, category_id, game_mode, total_questions,
                question_time_ms, deadline_at, expires_at
            )
            VALUES (
                %s, %s, %s, %s,
                %s,
                now() + %s::integer * interval '1 millisecond',
                now() + %s::interval
            )
            RETURNING id
            """,
            (
                room["id"],
                room["category_id"],
                True,
                len(selected),
                question_time_ms,
                question_time_ms,
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
                    member["character_id"] or DEFAULT_CHARACTER_ID,
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
            game_mode=True,
            total_questions=len(selected),
            question_time_ms=question_time_ms,
            player_count=len(members),
        )

    async def start_solo(
        self,
        actor_id: UUID,
        spec: ValidatedRoom,
        *,
        may_create: Callable[[], float | None] | None = None,
        restart: bool = False,
    ) -> SoloStart:
        """혼자 푸는 온라인 판을 곧바로 연다 (FR-7.13 3단계, POST /v1/solo).

        그 사람의 혼자 방을 다시 쓴다 — 같은 방의 지난 판을 피해 출제하므로(N08)
        「다시 하기」와 다음 판이 방금 푼 문제를 되풀이하지 않는다. 방이 없거나(처음·
        「홈으로」가 지웠다) 만료됐거나 그 사람이 이미 멤버가 아니면 지우고 새로 만든다.
        판이 돌고 있으면 새 판을 열지 않고 그 방을 돌려준다(resumed) — 다른 탭에서 연
        판이나 나갔다 온 판을 화면이 이어 그린다. 분야·문항 시간은 이번에 고른 값으로
        바꾼다. 두 요청이 겹쳐 둘 다 방을 만들려 하면 solo_rooms의 UNIQUE가 하나를
        되돌리고 다시 읽는다.

        새로 만들 때만 두 가지를 본다 — 다시 쓰는 판은 막지 않는다. 혼자 방이 `SOLO_ROOM_CEILING`
        만큼 있으면 SoloRoomsFull이고(혼자 판의 동시 수를 묶는다), 아니면 `may_create`가 만드는
        몫(주소·프로세스, 한 시간)을 먹는다 — 찼으면 SoloCreateLimited다. 한도는 같은 순간의
        transaction 둘이 함께 넘을 수 있는 느슨한 상한이다(넘는 만큼은 동시에 만든 수뿐이다).

        `restart`면(PRD 10.1 #11, 소유자 결정) 도는 판이 다른 판(분야·전체 도전)일 때 그 판을 기록
        없이 끝내고(`_end_locked_match`) 같은 transaction에서 고른 판을 연다 — 끝낸 판은 `ended`로
        알린다. 같은 판이 돌면 restart여도 그 판을 잇는다(resumed). 끝내고 여는 것이 한
        transaction이라 판이 없는 사이가 보이지 않고, 새 판을 열지 못하면 끝낸 것도 되돌아간다.
        """
        for _ in range(10):
            try:
                async with self._pool.connection() as connection:
                    async with connection.transaction():
                        player = await self._player_row(connection, actor_id)
                        if player is None:
                            raise NotMember
                        cursor = await connection.execute(_SOLO_ROOM_SQL, (actor_id,))
                        room = await cursor.fetchone()
                        created = False
                        ended: EndedSoloMatch | None = None
                        if room is not None and room["playing"]:
                            if not room["member"]:
                                # 판의 참가자가 아닌 채로 남은 방은 판이 끝나야 지울 수 있다
                                raise MatchInProgress
                            active_cursor = await connection.execute(
                                _LOCKED_ACTIVE_MATCH_SQL, (room["id"],)
                            )
                            active = await active_cursor.fetchone()
                            if active is not None and (
                                not restart or active["category_id"] == spec.category_id
                            ):
                                view = await self._fetch_room(
                                    connection, actor_id, str(room["code"]), require_member=True
                                )
                                if view is None:
                                    raise RepositoryFailure("solo room could not be read")
                                return SoloStart(room=view, match=None)
                            if active is not None:
                                # 다른 판을 골랐다. 도는 판을 끝내고 아래에서 그 방을 다시 써 연다
                                ended = await self._end_locked_match(connection, active)
                        if room is not None and (not room["alive"] or not room["member"]):
                            # 정리를 기다리던 방이다. 표시는 CASCADE로 함께 지워진다
                            await connection.execute(
                                "DELETE FROM quiz_online.rooms WHERE id = %s", (room["id"],)
                            )
                            room = None
                        if room is None:
                            cursor = await connection.execute(
                                "SELECT count(*) >= %s AS at_ceiling FROM quiz_online.solo_rooms",
                                (SOLO_ROOM_CEILING,),
                            )
                            ceiling = await cursor.fetchone()
                            if ceiling is not None and ceiling["at_ceiling"]:
                                raise SoloRoomsFull
                            if may_create is not None:
                                wait = may_create()
                                if wait is not None:
                                    raise SoloCreateLimited(wait)
                            room = await self._insert_solo_room(connection, actor_id, spec, player)
                            created = True
                        else:
                            await connection.execute(
                                """
                                UPDATE quiz_online.rooms
                                SET category_id = %s, question_time_ms = %s,
                                    updated_at = now(), expires_at = now() + %s::interval
                                WHERE id = %s
                                """,
                                (
                                    spec.category_id,
                                    spec.question_time_ms,
                                    _ROOM_LIFETIME,
                                    room["id"],
                                ),
                            )
                            # 홈에서 바꾼 닉네임·캐릭터를 다음 판부터 쓴다. 랭킹 기록은
                            # 판에 옮겨 적은 이 이름으로 남는다(match_players)
                            await connection.execute(
                                """
                                UPDATE quiz_online.room_members
                                SET nickname = %s, character_id = %s, last_seen_at = now()
                                WHERE room_id = %s AND player_id = %s
                                """,
                                (
                                    player["nickname"],
                                    player["character_id"] or DEFAULT_CHARACTER_ID,
                                    room["id"],
                                    actor_id,
                                ),
                            )
                            room = {
                                **room,
                                "category_id": spec.category_id,
                                "question_time_ms": spec.question_time_ms,
                            }
                        match = await self._start_locked_match(connection, room, actor_id)
                        view = await self._fetch_room(
                            connection, actor_id, str(room["code"]), require_member=True
                        )
                        if view is None:
                            raise RepositoryFailure("solo room could not be read")
                        return SoloStart(room=view, match=match, created=created, ended=ended)
            except errors.UniqueViolation:
                # 방 코드가 겹쳤거나 같은 사람의 다른 요청이 먼저 혼자 방을 만들었다. 다시 읽는다
                continue
        raise RepositoryFailure("could not open a solo room")

    async def end_solo(self, actor_id: UUID) -> SoloEnd:
        """혼자 판을 그만둔다 (DELETE /v1/solo). 도는 판은 기록 없이 끝내고 혼자 방을 지운다.

        혼자 방이 없으면 아무것도 하지 않는다(code None). 방을 지우면 멤버십·판·표시가 CASCADE로
        함께 사라진다. 끝까지 풀지 않은 판은 기록하지 않는다 — 마지막 공개만 남은 판은 끝까지 푼
        판이라 닫아 기록한 뒤에 지운다(`_end_locked_match`). 화면은 이 길을 쓰지 않고(«홈으로»는
        끝난 판의 방을 나간다) 배포 점검(`deploy/oracle/smoke.py candidate`)이 제가 연 혼자 판을
        치우는 데 쓴다.
        """
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(_SOLO_ROOM_SQL, (actor_id,))
                room = await cursor.fetchone()
                if room is None:
                    return SoloEnd(code=None)
                ended: EndedSoloMatch | None = None
                if room["playing"]:
                    active_cursor = await connection.execute(
                        _LOCKED_ACTIVE_MATCH_SQL, (room["id"],)
                    )
                    active = await active_cursor.fetchone()
                    if active is not None:
                        ended = await self._end_locked_match(connection, active)
                await connection.execute(
                    "DELETE FROM quiz_online.rooms WHERE id = %s", (room["id"],)
                )
                return SoloEnd(code=str(room["code"]), ended=ended)

    async def _end_locked_match(
        self,
        connection: AsyncConnection[dict[str, Any]],
        match: Mapping[str, Any],
    ) -> EndedSoloMatch:
        """잠근 도는 판(`_LOCKED_ACTIVE_MATCH_SQL`)을 끝낸다 (PRD 10.1 #11).

        끝까지 풀지 않은 판은 기록 없이 `abandoned`가 된다(FR-6, 로컬 N04) — 마감도 지워 sweep이
        다시 보지 않는다. 마지막 문항까지 답해 마지막 공개만 남은 판은 끝까지 푼 판이라 그 자리에서
        닫고 마감 sweep이 닫을 때와 같이 기록한다(로컬 나가기 확인의 «결과 보기»와 같은 규칙). 발밑
        칸 초안·방송·운영 기록은 API가 맡는다.
        """
        position = int(match["current_position"])
        total = int(match["total_questions"])
        ended = EndedSoloMatch(
            match_id=match["id"],
            category_id=match["category_id"],
            position=position,
            total_questions=total,
        )
        if match["state"] == "revealing" and position >= total:
            completed = await connection.execute(
                """
                UPDATE quiz_online.matches
                SET state = 'finished', finished_at = now(), deadline_at = NULL
                WHERE id = %s AND state = 'revealing'
                RETURNING finished_at
                """,
                (match["id"],),
            )
            closed = await completed.fetchone()
            if closed is not None:
                await self._record_rankings(connection, match, closed["finished_at"])
                return replace(ended, recorded=True)
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET state = 'abandoned', finished_at = now(), deadline_at = NULL
            WHERE id = %s AND state IN ('running', 'revealing')
            """,
            (match["id"],),
        )
        return ended

    async def _insert_solo_room(
        self,
        connection: AsyncConnection[dict[str, Any]],
        actor_id: UUID,
        spec: ValidatedRoom,
        player: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """혼자 방 하나와 그 사람의 멤버십·표시를 남긴다. 코드가 겹치면 UniqueViolation이 난다."""
        code = _make_code()
        cursor = await connection.execute(
            """
            INSERT INTO quiz_online.rooms (
                code, name, category_id, capacity, game_mode,
                question_time_ms,
                is_public, password_hash, host_player_id, expires_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s, now() + %s::interval)
            RETURNING id, code::text AS code, host_player_id, category_id, game_mode,
                question_time_ms
            """,
            (
                code,
                spec.name,
                spec.category_id,
                spec.capacity,
                spec.game_mode,
                spec.question_time_ms,
                True,
                actor_id,
                _ROOM_LIFETIME,
            ),
        )
        room = await cursor.fetchone()
        if room is None:
            raise RepositoryFailure("solo room insert returned no row")
        await connection.execute(
            """
            INSERT INTO quiz_online.room_members (room_id, player_id, nickname, character_id)
            VALUES (%s, %s, %s, %s)
            """,
            (
                room["id"],
                actor_id,
                player["nickname"],
                player["character_id"] or DEFAULT_CHARACTER_ID,
            ),
        )
        await connection.execute(
            "INSERT INTO quiz_online.solo_rooms (room_id, player_id) VALUES (%s, %s)",
            (room["id"], actor_id),
        )
        return room

    async def own_best_scores(
        self,
        *,
        actor_id: UUID,
        owner_key: bytes,
        exclude_match_id: UUID | None = None,
    ) -> Mapping[str, OwnBestView | None]:
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                _OWN_BEST_SQL,
                {
                    "actor_id": actor_id,
                    "owner_key": owner_key,
                    "exclude_match": exclude_match_id,
                },
            )
            rows = await cursor.fetchall()
        best: dict[str, OwnBestView | None] = dict.fromkeys(RANKING_BOARDS)
        for row in rows:
            board = str(row["board"])
            if board not in best:
                continue
            best[board] = OwnBestView(
                score=int(row["score"]),
                correct_count=int(row["correct_count"]),
                total_count=int(row["total_questions"]),
                recorded_at=_iso(row["recorded_at"]),
            )
        return best

    async def own_records(
        self,
        *,
        actor_id: UUID,
        owner_key: bytes,
        limit: int = OWN_RECORDS_LIMIT,
    ) -> OwnRecordsView:
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                _OWN_RECORDS_SQL,
                {"actor_id": actor_id, "owner_key": owner_key, "limit": limit + 1},
            )
            rows = await cursor.fetchall()
        return OwnRecordsView(
            records=tuple(
                OwnRecordView(
                    board=str(row["board"]),
                    score=int(row["score"]),
                    correct_count=int(row["correct_count"]),
                    total_count=int(row["total_questions"]),
                    question_time_ms=_question_time(row["question_time_ms"]),
                    nickname=str(row["nickname"]),
                    recorded_at=_iso(row["recorded_at"]),
                )
                for row in rows[:limit]
            ),
            truncated=len(rows) > limit,
        )

    async def get_match(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
    ) -> MatchRead:
        async with self._pool.connection() as connection:
            async with connection.transaction():
                match = await self._locked_match(connection, actor_id, code)
                # 기록 없이 끝낸 혼자 판(`abandoned`)은 «판이 없다»와 같다 — 같은 transaction에서
                # 다음 판이 열리거나(restart) 방이 지워진다(그만두기·30분 정리)
                if match is None or match["state"] == "abandoned":
                    return MatchRead(match=None, advanced=False)
                advanced = await self._advance_locked_match(
                    connection,
                    match,
                    absent_player_ids=absent_player_ids,
                    standing_answers=standing_answers,
                )
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
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
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
                if match is None or match["state"] == "abandoned":
                    raise MatchNotFound
                if await self._advance_locked_match(
                    connection,
                    match,
                    absent_player_ids=absent_player_ids,
                    standing_answers=standing_answers,
                ):
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

                # 쓴 시간은 그 판의 문항 시간을 넘지 않는다 (시간 초과 기록과 같은 상한). «제한
                # 없음» 판은 자르지 않고 재되(로컬과 같다, FR-5.3) 판의 수명(2시간) 안이다 —
                # migration 013의 상한
                elapsed_cursor = await connection.execute(
                    """
                    SELECT LEAST(
                        COALESCE(question_time_ms, %s),
                        GREATEST(
                            0,
                            floor(extract(epoch FROM now() - question_started_at) * 1000)::integer
                        )
                    ) AS elapsed_ms
                    FROM quiz_online.matches
                    WHERE id = %s
                    """,
                    (UNTIMED_ELAPSED_MS_CAP, match["id"]),
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
                advanced = was_inserted and await self._advance_locked_match(
                    connection,
                    match,
                    absent_player_ids=absent_player_ids,
                    standing_answers=standing_answers,
                )
                view = await self._match_view(connection, actor_id, match["id"])
                if view is None:
                    raise RepositoryFailure("match answer view could not be read")
                return MatchSubmission(match=view, answer=feedback, advanced=advanced)

    async def advance_expired_matches(
        self,
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> list[ExpiredMatchAdvance]:
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
                advanced: list[ExpiredMatchAdvance] = []
                for match in matches:
                    # 마지막 문항의 공개가 끝나면 판이 닫혀 방의 status가 바뀐다. API가
                    # room-invalidated도 보내 판에서 빠진 멤버의 대기실이 다시 읽게 한다.
                    finishing = (
                        match["state"] == "revealing"
                        and int(match["current_position"]) >= int(match["total_questions"])
                    )
                    # 판마다 savepoint다. 한 판이 넘어가지 못하면(랭킹 기록 실패·권한 어긋남)
                    # 그 판만 되돌려 다음 sweep에 다시 보고, 같은 묶음의 나머지 판은 넘기고
                    # 방송한다. 묶음을 통째로 되돌리면 마감이 가장 이른 그 판이 매번 맨 앞에
                    # 뽑혀 모든 판의 마감이 멈춘다.
                    try:
                        async with connection.transaction():
                            moved = await self._advance_locked_match(
                                connection,
                                match,
                                standing_answers=standing_answers,
                            )
                    except (errors.Error, RepositoryFailure):
                        # 연결이 끊겼으면 다음 판도 못 넘긴다 — 묶음째 실패로 알린다
                        if connection.broken:
                            raise
                        _logger.warning("match advance skipped", exc_info=True)
                        continue
                    if moved:
                        advanced.append(
                            ExpiredMatchAdvance(
                                code=str(match["code"]),
                                finished=finishing,
                                match_id=match["id"],
                                position=int(match["current_position"]),
                            )
                        )
                return advanced

    async def advance_past_absent_players(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
        *,
        standing_answers: StandingAnswerSource | None = None,
    ) -> bool:
        """누가 막 유예를 넘겨 끊겼을 때, 남은 사람이 이미 다 답했으면 마감을 기다리지 않는다.

        presence sweep이 부른다. 남은 사람의 답이 끊긴 사람을 기다리며 이미 다 들어와 있으면
        다음 제출이 없어, 마감까지 아무도 «모두 답했다»를 다시 판정하지 않기 때문이다.
        """
        if not absent_player_ids:
            return False
        async with self._pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    SELECT match.*, room.code
                    FROM quiz_online.matches match
                    JOIN quiz_online.rooms room ON room.id = match.room_id
                    WHERE room.code = %s
                      AND match.state = 'running'
                      AND match.expires_at > now()
                    ORDER BY match.started_at DESC
                    LIMIT 1
                    FOR UPDATE OF match
                    """,
                    (code,),
                )
                match = await cursor.fetchone()
                if match is None:
                    return False
                return await self._advance_locked_match(
                    connection,
                    match,
                    absent_player_ids=absent_player_ids,
                    standing_answers=standing_answers,
                )

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
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
        standing_answers: StandingAnswerSource | None = None,
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
                    RETURNING id, finished_at
                    """,
                    (match_id,),
                )
                closed = await completed.fetchone()
                if closed is None:
                    return False
                # 판을 닫는 바로 이 transaction에서 랭킹을 남긴다. 기록이 실패하면 판도 닫히지
                # 않고 다음 sweep·읽기가 다시 닫는다 — 닫힌 판의 기록이 빠지는 일이 없다.
                await self._record_rankings(connection, match, closed["finished_at"])
                return True
            else:
                completed = await connection.execute(
                    """
                    UPDATE quiz_online.matches
                    SET state = 'running',
                        current_position = current_position + 1,
                        question_started_at = now(),
                        deadline_at = now() + question_time_ms * interval '1 millisecond'
                    WHERE id = %s
                      AND state = 'revealing'
                      AND deadline_at <= now()
                    RETURNING id
                    """,
                    (match_id,),
                )
            return await completed.fetchone() is not None

        # 판의 참가자마다 이번 문항에 답했는지. 판이 비어 있어도 마감 여부는 읽히게 LEFT JOIN이다.
        progress_cursor = await connection.execute(
            """
            SELECT
                match.deadline_at <= now() AS expired,
                player.player_id,
                answer.player_id IS NOT NULL AS answered
            FROM quiz_online.matches match
            LEFT JOIN quiz_online.match_players player
              ON player.match_id = match.id
            LEFT JOIN quiz_online.match_answers answer
              ON answer.match_id = player.match_id
             AND answer.position = %s
             AND answer.player_id = player.player_id
            WHERE match.id = %s
            """,
            (current_position, match_id),
        )
        progress = await progress_cursor.fetchall()
        if not progress:
            raise RepositoryFailure("locked match disappeared")
        # 마감이 NULL이면(«제한 없음») `deadline_at <= now()`도 NULL이라 마감은 지나지 않는다
        expired = bool(progress[0]["expired"])
        players = [row for row in progress if row["player_id"] is not None]
        if match["question_time_ms"] is None:
            # «제한 없음» 혼자 판 (PRD 10.1 #9): 시간 초과가 없고, 끊긴 사람을 빼고 앞당기거나 빈
            # 답을 채우지 않으며, 발밑 칸도 답이 되지 않는다(마감이 없다). 판의 모두가 직접 답했을
            # 때만 공개한다 — 혼자 판이라 그 사람이 답을 낼 때다
            if not players or not all(bool(row["answered"]) for row in players):
                return False
            return await self._reveal_locked_match(connection, match_id)

        # 모두 답하면 마감을 기다리지 않는다. 유예를 넘겨 끊긴 참가자는 그 «모두»에서 뺀다 —
        # 한 사람이 떠났다고 남은 사람이 문제마다 마감까지 기다리지 않게 (U32). 그 사람의 빈
        # 답은 아래에서 시간 초과로 채우고, 다시 붙으면 다음 판정부터 다시 센다. 판의 모두가
        # 끊겼으면 앞당길 까닭이 없어 마감까지 기다린다.
        counted = [row for row in players if row["player_id"] not in absent_player_ids]
        if players and not counted:
            everyone_answered = False
        else:
            everyone_answered = all(bool(row["answered"]) for row in counted)
        if not expired and not everyone_answered:
            return False

        # 마감이 지났거나 끊긴 사람을 빼고 앞당겼으면, 답이 없는 참가자는 시간 초과로 채운다.
        # 시간 초과는 그 판의 문항 시간(20초·40초)을 다 쓴 것으로 남는다.
        # 그 전에 발밑 칸 초안이 있는 사람은 그 칸을 답으로 남긴다 (U13, 혼자 하기와 같은 규칙) —
        # «시간이 끝나면 선 칸이 답»이다. 초안은 «모두 답했다»에 세지 않았으므로 여기서만 쓴다.
        if expired or absent_player_ids:
            if standing_answers is not None:
                await self._record_standing_answers(
                    connection,
                    match,
                    current_position,
                    standing_answers,
                )
            await connection.execute(
                """
                INSERT INTO quiz_online.match_answers (
                    match_id, position, player_id, choice_index, correct, timed_out, elapsed_ms
                )
                SELECT %s, %s, player.player_id, NULL, false, true, match.question_time_ms
                FROM quiz_online.match_players player
                JOIN quiz_online.matches match ON match.id = player.match_id
                LEFT JOIN quiz_online.match_answers answer
                  ON answer.match_id = player.match_id
                 AND answer.position = %s
                 AND answer.player_id = player.player_id
                WHERE player.match_id = %s AND answer.player_id IS NULL
                ON CONFLICT (match_id, position, player_id) DO NOTHING
                """,
                (match_id, current_position, current_position, match_id),
            )

        return await self._reveal_locked_match(connection, match_id)

    async def _reveal_locked_match(
        self,
        connection: AsyncConnection[dict[str, Any]],
        match_id: UUID,
    ) -> bool:
        """도는 문항을 공개로 넘긴다. 공개(8초)에는 «제한 없음» 판에도 마감이 있다."""
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

    async def _record_rankings(
        self,
        connection: AsyncConnection[dict[str, Any]],
        match: Mapping[str, Any],
        finished_at: datetime,
    ) -> None:
        """닫힌 판의 참가자마다 온라인 랭킹 기록 한 줄 (FR-7.13 2단계, PRD 12.1).

        점수·맞힌 수는 서버가 채점한 답에서 다시 센다(최종 순위와 같은 `_score_views`). 끊겨서
        빈 답이 시간 초과로 채워진 참가자도 판의 참가자이므로 남긴다. 닉네임은 그 방에서 보인
        이름이고, 지금 금칙 규칙에 걸리는 옛 이름이면 «익명»으로 남긴다. 같은 판·같은 사람은 한 번만
        남는다(UNIQUE). 최종 순위 순서대로 넣어, 같은 점수·같은 시각이면 그 판의 순위가 id 순서다.
        """
        category_id = match["category_id"]
        mode = "all" if category_id is None else "category"
        scores = await self._score_views(connection, match["id"])
        # «내 기록»의 주인 열쇠는 그 브라우저의 토큰에서 나온다(`ranking_owner_key`). 줄이
        # 없으면 NULL — 그 기록은 누구의 «나»도 아니다
        tokens_cursor = await connection.execute(
            _RANKING_OWNER_TOKENS_SQL, ([score.player_id for score in scores],)
        )
        owner_keys = {
            row["id"]: ranking_owner_key(bytes(row["token_hash"]))
            for row in await tokens_cursor.fetchall()
        }
        for score in scores:
            await connection.execute(
                _INSERT_RANKING_SQL,
                (
                    match["id"],
                    score.player_id,
                    mode,
                    category_id,
                    score.score,
                    score.correct_count,
                    int(match["total_questions"]),
                    # «제한 없음» 혼자 판이면 NULL이다(migration 013). 랭킹은 문항 시간으로 나누지
                    # 않는다
                    _question_time(match["question_time_ms"]),
                    ranking_nickname(score.nickname),
                    score.character_id or DEFAULT_CHARACTER_ID,
                    owner_keys.get(score.player_id),
                    finished_at,
                ),
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
        async with self._pool.connection() as connection:
            window_start: str | None = None
            window_end: str | None = None
            params: dict[str, object] = {
                "board": board,
                "actor_id": actor_id,
                "owner_key": owner_key,
                "limit": limit,
            }
            if period == "week":
                week_cursor = await connection.execute(_RANKING_WEEK_SQL, {"at": at})
                week = await week_cursor.fetchone()
                if week is None:
                    raise RepositoryFailure("ranking week could not be computed")
                window_start = _iso(week["window_start"])
                window_end = _iso(week["window_end"])
                params["week_start"] = week["week_start"]
                cursor = await connection.execute(_RANKING_WEEK_ENTRIES_SQL, params)
            else:
                cursor = await connection.execute(_RANKING_ALL_SQL, params)
            rows = await cursor.fetchall()
        return RankingBoardView(
            board=board,
            period=period,
            window_start=window_start,
            window_end=window_end,
            entries=tuple(
                RankingEntryView(
                    # 같은 점수도 먼저 남긴 기록이 위이고 순위는 그 순서다(혼자 하기 랭킹과 같다)
                    rank=index,
                    nickname=str(row["nickname"]),
                    character_id=str(row["character_id"]),
                    score=int(row["score"]),
                    correct_count=int(row["correct_count"]),
                    total_count=int(row["total_questions"]),
                    recorded_at=_iso(row["recorded_at"]),
                    is_mine=bool(row["is_mine"]),
                )
                for index, row in enumerate(rows, start=1)
            ),
        )

    async def _record_standing_answers(
        self,
        connection: AsyncConnection[dict[str, Any]],
        match: Mapping[str, Any],
        position: int,
        standing_answers: StandingAnswerSource,
    ) -> None:
        """답이 없는 참가자의 발밑 칸 초안을 그 문항의 답으로 남긴다 (U13).

        채점은 보통 답과 같고(정답이면 10점), 시간 초과가 아니며, 쓴 시간은 그 판의 문항 시간을
        다 쓴 것이다 — 로컬에서 시간이 끝날 때 선 칸을 낸 답과 같다. 잠근 판에서 다시 본다: 이 판·
        이 문항이고 판의 참가자이며 아직 답이 없고(먼저 낸 답이 이긴다) 마감 전에 받은 초안만 쓴다.
        """
        drafts = standing_answers.for_question(str(match["code"]), match["id"], position)
        player_ids: list[UUID] = []
        choices: list[int] = []
        received: list[datetime] = []
        for player_id, draft in drafts.items():
            if type(draft.choice_index) is not int or draft.choice_index not in range(4):
                continue
            player_ids.append(player_id)
            choices.append(draft.choice_index)
            received.append(draft.received_at)
        if not player_ids:
            return
        await connection.execute(
            """
            INSERT INTO quiz_online.match_answers (
                match_id, position, player_id, choice_index, correct, timed_out, elapsed_ms
            )
            SELECT
                match.id,
                match.current_position,
                player.player_id,
                draft.choice_index,
                draft.choice_index = question.answer_index,
                false,
                match.question_time_ms
            FROM unnest(%s::uuid[], %s::smallint[], %s::timestamptz[])
                AS draft(player_id, choice_index, received_at)
            JOIN quiz_online.matches match ON match.id = %s
            JOIN quiz_online.match_players player
              ON player.match_id = match.id AND player.player_id = draft.player_id
            JOIN quiz_online.match_questions question
              ON question.match_id = match.id AND question.position = match.current_position
            WHERE match.state = 'running'
              AND match.current_position = %s
              AND draft.received_at <= match.deadline_at
            ON CONFLICT (match_id, position, player_id) DO NOTHING
            """,
            (player_ids, choices, received, match["id"], position),
        )

    async def _match_view(
        self,
        connection: AsyncConnection[dict[str, Any]],
        actor_id: UUID,
        match_id: UUID,
    ) -> MatchView | None:
        cursor = await connection.execute(
            """
            SELECT match.id, match.state, match.category_id, match.game_mode,
                   match.current_position, match.total_questions, match.deadline_at,
                   match.question_time_ms
            FROM quiz_online.matches match
            JOIN quiz_online.match_players player ON player.match_id = match.id
            WHERE match.id = %s AND player.player_id = %s AND match.expires_at > now()
            """,
            (match_id, actor_id),
        )
        match = await cursor.fetchone()
        if match is None:
            return None
        # 참가자별 «방금 문항을 맞혔나»는 공개 중에만 읽는다 (U30).
        # 아직 답을 고르는 running에는 없다.
        scores = await self._score_views(
            connection,
            match_id,
            reveal_position=(
                int(match["current_position"]) if match["state"] == "revealing" else None
            ),
        )
        question_view: MatchQuestionView | None = None
        own_answer: MatchAnswerView | None = None
        # «문제 다시 보기»는 판이 끝난 뒤에만 만든다 (U38)
        review: tuple[MatchReviewView, ...] = ()
        ranking_recorded = False
        if match["state"] == "finished":
            review = await self._review_views(connection, actor_id, match_id)
            recorded_cursor = await connection.execute(
                """
                SELECT 1
                FROM quiz_online.online_rankings
                WHERE match_id = %s AND player_id = %s
                """,
                (match_id, actor_id),
            )
            ranking_recorded = await recorded_cursor.fetchone() is not None
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
            game_mode=True,
            current_position=int(match["current_position"]),
            total_questions=int(match["total_questions"]),
            deadline_at=_iso(deadline_at) if isinstance(deadline_at, datetime) else None,
            question=question_view,
            own_answer=own_answer,
            scores=scores,
            review=review,
            question_time_ms=_question_time(match["question_time_ms"]),
            ranking_recorded=ranking_recorded,
        )

    async def _score_views(
        self,
        connection: AsyncConnection[dict[str, Any]],
        match_id: UUID,
        *,
        reveal_position: int | None = None,
    ) -> tuple[MatchScoreView, ...]:
        # reveal_position이 None이면 last_answer_correct 비교가 NULL이라 아무 행도 세지 않는다.
        cursor = await connection.execute(
            """
            SELECT
                player.player_id,
                player.nickname,
                player.character_id,
                COALESCE(sum(CASE WHEN answer.correct THEN 10 ELSE 0 END), 0)::integer AS score,
                count(answer.player_id) FILTER (WHERE answer.correct)::integer AS correct_count,
                count(answer.player_id)::integer AS answered_count,
                bool_or(answer.correct) FILTER (
                    WHERE answer.position = %s::smallint
                ) AS last_answer_correct
            FROM quiz_online.match_players player
            LEFT JOIN quiz_online.match_answers answer
              ON answer.match_id = player.match_id AND answer.player_id = player.player_id
            WHERE player.match_id = %s
            GROUP BY player.player_id, player.nickname, player.character_id
            ORDER BY score DESC, correct_count DESC, answered_count DESC, player.nickname ASC
            """,
            (reveal_position, match_id),
        )
        return tuple(
            MatchScoreView(
                player_id=row["player_id"],
                nickname=str(row["nickname"]),
                character_id=row["character_id"] or DEFAULT_CHARACTER_ID,
                score=int(row["score"]),
                correct_count=int(row["correct_count"]),
                answered_count=int(row["answered_count"]),
                # 공개 중에는 모든 참가자의 답(빈 답은 시간 초과)이 있다.
                # 그래도 없으면 맞힌 것이 아니다.
                last_answer_correct=(
                    None if reveal_position is None else bool(row["last_answer_correct"])
                ),
            )
            for row in await cursor.fetchall()
        )

    async def _review_views(
        self,
        connection: AsyncConnection[dict[str, Any]],
        actor_id: UUID,
        match_id: UUID,
    ) -> tuple[MatchReviewView, ...]:
        """끝난 판의 문항과 묻는 사람의 답을 순서대로 (U38 «문제 다시 보기»).

        문제 글·해설은 정적 catalog에서 다시 읽는다. 배포 사이에 catalog가 바뀌어 맞춰 볼 수 없으면
        다시 보기만 빼고 최종 순위는 그대로 보낸다 — 지난 판의 풀이 때문에 순위까지 잃지 않는다.
        """
        cursor = await connection.execute(
            """
            SELECT
                question.position,
                question.question_id,
                question.category_id,
                question.choices,
                question.answer_index,
                answer.choice_index,
                answer.correct,
                answer.timed_out
            FROM quiz_online.match_questions question
            LEFT JOIN quiz_online.match_answers answer
              ON answer.match_id = question.match_id
             AND answer.position = question.position
             AND answer.player_id = %s
            WHERE question.match_id = %s
            ORDER BY question.position ASC
            """,
            (actor_id, match_id),
        )
        views: list[MatchReviewView] = []
        try:
            for row in await cursor.fetchall():
                catalog_question, answer_index, choices = self._verified_question(row)
                answered = row["correct"] is not None
                choice_index = row["choice_index"]
                views.append(
                    MatchReviewView(
                        position=int(row["position"]),
                        question_id=str(row["question_id"]),
                        category_id=str(row["category_id"]),
                        question=catalog_question.question,
                        choices=choices,
                        answer_index=answer_index,
                        explanation=catalog_question.explanation,
                        choice_index=int(choice_index) if choice_index is not None else None,
                        # 답이 없는 문항(끝나기 전에 빠진 사람)은 시간 초과와 같다
                        correct=bool(row["correct"]) if answered else False,
                        timed_out=bool(row["timed_out"]) if answered else True,
                    )
                )
        except RepositoryFailure:
            _logger.warning("finished match review skipped: catalog mismatch", exc_info=True)
            return ()
        return tuple(views)

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
        catalog_question, answer_index, _ = self._verified_question(question)
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

    def _verified_question(
        self,
        question: Mapping[str, Any],
    ) -> tuple[SelectedQuestion, int, tuple[str, ...]]:
        """저장된 판 문항을 catalog와 맞춰 본다. 정답 보기가 달라졌으면 채점·공개하지 않는다."""
        catalog_question = self._catalog_question(question)
        answer_index = int(question["answer_index"])
        choices = _choices(question["choices"])
        if choices[answer_index] != catalog_question.choices[catalog_question.answer_index]:
            raise RepositoryFailure("static catalog no longer matches persisted match question")
        return catalog_question, answer_index, choices

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

    async def cleanup_expired_resources(self) -> CleanupCounts:
        # 지우거나 넘긴 수는 운영 기록(`ops_log.cleanup`)이 한 줄로 남긴다. 무엇을 지웠는지는
        # 싣지 않는다.
        async with self._pool.connection() as connection:
            async with connection.transaction():
                matches = await connection.execute(
                    "SELECT quiz_online.cleanup_expired_matches() AS deleted"
                )
                matches_row = await matches.fetchone()
                # 마감이 없어 스스로 끝나지 않는 혼자 판을 멤버 정리 앞에서 끝낸다(migration 013) —
                # 그래야 아래 멤버 정리가 그 방을 «판이 도는 방»으로 건너뛰지 않는다
                idle_untimed = await connection.execute(
                    _ABANDON_IDLE_UNTIMED_MATCHES_SQL, (_MEMBER_STALE_AFTER,)
                )
                expired_rooms = await connection.execute(_DELETE_EXPIRED_ROOMS_SQL)
                stale_members = await connection.execute(
                    _DELETE_STALE_MEMBERS_SQL,
                    (_MEMBER_STALE_AFTER, _MEMBER_STALE_AFTER),
                )
                orphaned_hosts = await connection.execute(_TRANSFER_ORPHANED_HOSTS_SQL)
                empty_rooms = await connection.execute(_DELETE_EMPTY_ROOMS_SQL)
                expired_players = await connection.execute(_DELETE_EXPIRED_PLAYERS_SQL)
                counts = CleanupCounts(
                    rooms_deleted=_affected(expired_rooms) + _affected(empty_rooms),
                    members_removed=_affected(stale_members),
                    hosts_transferred=_affected(orphaned_hosts),
                    matches_deleted=int(matches_row["deleted"] or 0) if matches_row else 0,
                    players_deleted=_affected(expired_players),
                    solo_matches_abandoned=_affected(idle_untimed),
                )
            # 랭킹 보존 기간 정리(최근 8주 + 판마다 전체 상위 100, 저장 한도 250,000줄, migration
            # 012의 함수). 방 정리와 따로 돈다 — 이것이 실패해도 방 정리와 그 뒤의 멤버십 재확인은
            # 이번 차례에 그대로 선다.
            try:
                pruned_cursor = await connection.execute(
                    "SELECT quiz_online.prune_online_rankings() AS pruned"
                )
                pruned_row = await pruned_cursor.fetchone()
            except errors.Error:
                _logger.warning("online ranking retention sweep failed", exc_info=True)
                return counts
            pruned = int(pruned_row["pruned"] or 0) if pruned_row else 0
            return replace(counts, rankings_pruned=pruned)

    async def ops_counts(self) -> RoomCounts:
        async with self._pool.connection(timeout=5) as connection:
            cursor = await connection.execute(_OPS_COUNTS_SQL)
            row = await cursor.fetchone()
        if row is None:
            raise RepositoryFailure("ops count query returned no row")
        return RoomCounts(
            waiting_rooms=int(row["waiting_rooms"]),
            playing_rooms=int(row["playing_rooms"]),
            running_matches=int(row["running_matches"]),
        )


def _affected(cursor: Any) -> int:
    # psycopg는 모르는 수를 -1로 준다
    return max(0, int(cursor.rowcount))


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


def _question_time(value: Any) -> int | None:
    """방·판·기록의 문항 시간. NULL은 «제한 없음»(마감 없음)이다.

    혼자 방과 그 판, 그 판의 기록에만 있다(migration 013).
    """
    return None if value is None else int(value)


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
                "game_mode": True,
                "players": [],
                "is_public": bool(row["is_public"]),
                "has_password": bool(row["has_password"]),
                "is_mine": bool(row["is_mine"]),
                "joined": bool(row["joined"]),
                "created_at": str(created_at),
                # join_room 이 MatchInProgress 를 내는 조건과 같은 판정이다
                "status": "playing" if row["is_playing"] else "waiting",
                "in_match": bool(row["in_match"]),
                "question_time_ms": _question_time(row["question_time_ms"]),
                "solo": bool(row["solo"]),
            }
            grouped[room_id] = item
        if row["player_id"] is not None:
            item["players"].append(
                PlayerView(
                    id=row["player_id"],
                    nickname=str(row["nickname"]),
                    character_id=row["character_id"] or DEFAULT_CHARACTER_ID,
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
            status=item["status"],
            in_match=item["in_match"],
            question_time_ms=item["question_time_ms"],
            solo=item["solo"],
        )
        for item in grouped.values()
    ]
