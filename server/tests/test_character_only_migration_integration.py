"""빈 DB에서 v9 데이터를 만든 뒤 migration 010 → 011 → 012 → 013을 차례로 올리고 후보 API를 돌린다.

CI가 `app.migrate`보다 먼저, 빈 DB 위에서 이 파일만 돌린다(.github/workflows/pages.yml).

- 010(캐릭터 전용)은 v9 writer가 남긴 false·NULL을 고친 뒤에 제약을 건다. 그 API 교체는 이미
  끝난 단계라(API → migration 010 → Pages), 지금 후보 API는 v9 위에서 돌지 않는다.
- 011(방장이 고르는 문항 시간)은 더하기만 한다: 010의 API가 도는 동안 먼저 적용하고, 열 이름을
  적어 쓰던 그 API의 문장이 그대로 통하며, 이미 있는 방·도는 판은 예전의 20초를 받는다
  (migration 011 → API → Pages).
- 012(온라인 랭킹)도 더하기만 한다: 011의 API가 도는 동안 먼저 적용하고(그 API의 방 문장이 그대로
  통하고 랭킹 표는 비어 있다), 012 전에 열린 판도 그 뒤의 API가 닫으면 참가자마다 기록이 남는다
  (migration 012 → API → Pages). 이 소스에는 #108의 API가 없어 그 판을 닫는 것은 아래의 013 후보다.
- 013(혼자 푸는 온라인 판)도 더하기만 한다: 012의 API(#108)가 도는 동안 먼저 적용한다. 그 API의
  코드도 이 소스에 없으므로 그 API가 쓰는 문장(방 쓰기·판 기록·보존 정리·마지막 사람이 나갈 때의
  방 삭제)을 옮겨 **런타임 역할로** 013 DB 위에서 돌린다 — 혼자 방 표시가 붙은 방도 그 역할의 방
  삭제로 함께 지워진다(그 표의 DELETE 권한 없이 CASCADE로). 후보 API는 013 위에서만 돈다 — 012
  위에서는 readiness가 번호로 닫히고 방 SQL이 solo_rooms를 봐 로비부터 실패한다. 013 위에서는 013
  전에 열린 판을 이어 가 닫을 때 참가자마다 기록을 남기고, 혼자 판을 끝까지 풀면 그 사람의 주인
  열쇠로만 내 최고 기록이 읽힌다 (migration 013 → API → Pages).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import AsyncConnection, errors
from psycopg.types.json import Jsonb

from app.domain import DEFAULT_CHARACTER_ID, validate_player, validate_room, validate_solo_room
from app.main import RELEASE_SCHEMA_VERSION
from app.migrate import (
    apply_pending,
    discover_migrations,
    ensure_runtime_role,
    runtime_role_password,
)
from app.postgres import PostgresRoomsRepository
from app.question_catalog import QuestionCatalog
from app.repository import RANKING_BOARDS, MatchView, ranking_owner_key

MIGRATOR_URL = os.getenv("MIGRATION_UPGRADE_DATABASE_URL")
RUNTIME_URL = os.getenv("MIGRATION_UPGRADE_RUNTIME_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not MIGRATOR_URL or not RUNTIME_URL,
        reason="migration upgrade database URLs are not set",
    ),
]

# v9 writer가 낸 판의 두 문항. 정답 보기는 아래 catalog와 같아야 공개·다시 보기가 맞춰 본다.
_SEEDED_QUESTIONS = (("upgrade-science-000", 0), ("upgrade-science-001", 1))


def test_v9_data_upgrades_through_010_to_013_and_the_candidate_continues_it() -> None:
    assert MIGRATOR_URL is not None
    assert RUNTIME_URL is not None
    host_id, guest_id, solo_id = uuid4(), uuid4(), uuid4()
    room_code = uuid4().hex[:6].upper()
    later_code = uuid4().hex[:6].upper()
    probe_code = uuid4().hex[:6].upper()

    with psycopg.connect(MIGRATOR_URL, autocommit=True) as connection:
        ensure_runtime_role(connection, runtime_role_password())
        migrations = discover_migrations()
        assert apply_pending(connection, migrations[:9]) == tuple(range(1, 10))
        room_id = _seed_v9_room(connection, host_id, guest_id, room_code)
        match_id = _seed_v9_running_match(connection, room_id, host_id, guest_id)
        assert asyncio.run(_runtime_schema_version()) == 0

        # ── 010: 고친 뒤에 막는다 ──
        assert apply_pending(connection, migrations[:10]) == (10,)
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

        # ── 011: 010의 API가 도는 동안 더한다 ──
        assert apply_pending(connection, migrations[:11]) == (11,)
        assert connection.execute(
            "SELECT array_agg(version ORDER BY version) FROM quiz_online.schema_migrations"
        ).fetchone()[0] == list(range(1, 12))
        # 이미 있는 방과 도는 판은 예전의 고정 20초를 받는다
        assert connection.execute(
            "SELECT question_time_ms FROM quiz_online.rooms WHERE id = %s", (room_id,)
        ).fetchone()[0] == 20_000
        assert connection.execute(
            "SELECT question_time_ms FROM quiz_online.matches WHERE id = %s", (match_id,)
        ).fetchone()[0] == 20_000
        # 010의 API는 새 열을 모른다. 열 이름을 적은 그 문장이 그대로 통하고 기본값을 받는다
        later_room_id = connection.execute(
            """
            INSERT INTO quiz_online.rooms (
                code, name, category_id, capacity, game_mode,
                is_public, password_hash, host_player_id, expires_at
            )
            VALUES (%s, '010 방', NULL, 4, true, true, NULL, %s, now() + interval '24 hours')
            RETURNING id
            """,
            (later_code, host_id),
        ).fetchone()[0]
        assert connection.execute(
            "SELECT question_time_ms FROM quiz_online.rooms WHERE id = %s", (later_room_id,)
        ).fetchone()[0] == 20_000
        assert asyncio.run(_runtime_schema_version()) == 11

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
        with pytest.raises(errors.CheckViolation):
            connection.execute(
                "UPDATE quiz_online.rooms SET question_time_ms = 30000 WHERE id = %s",
                (room_id,),
            )
        assert connection.execute(
            "SELECT to_regclass('quiz_online.online_rankings') IS NULL"
        ).fetchone()[0] is True

        # ── 012: 011의 API가 도는 동안 더한다 ──
        assert apply_pending(connection, migrations[:12]) == (12,)
        assert connection.execute(
            "SELECT array_agg(version ORDER BY version) FROM quiz_online.schema_migrations"
        ).fetchone()[0] == list(range(1, 13))
        assert connection.execute(
            "SELECT count(*) FROM quiz_online.online_rankings"
        ).fetchone()[0] == 0
        # 011의 API가 쓰던 방 문장(문항 시간을 적는다)이 그대로 통한다
        assert connection.execute(
            """
            UPDATE quiz_online.rooms SET question_time_ms = 40000, updated_at = now()
            WHERE id = %s
            RETURNING question_time_ms
            """,
            (later_room_id,),
        ).fetchone()[0] == 40_000
        assert asyncio.run(_runtime_schema_version()) == 12
        # 012는 #108의 랭킹뿐이다 — 혼자 방 표와 한 사람의 색인은 013에 있다
        assert connection.execute(
            "SELECT to_regclass('quiz_online.solo_rooms') IS NULL, "
            "to_regclass('quiz_online.online_rankings_player_board_order_idx') IS NULL"
        ).fetchone() == (True, True)

    # 후보 API(013)는 012 DB 위에서 돌지 않는다
    asyncio.run(_candidate_refuses_v12(host_id, room_code))

    with psycopg.connect(MIGRATOR_URL, autocommit=True) as connection:
        # ── 013: 012의 API(#108)가 도는 동안 더한다 ──
        assert apply_pending(connection, migrations) == (13,)
        assert connection.execute(
            "SELECT array_agg(version ORDER BY version) FROM quiz_online.schema_migrations"
        ).fetchone()[0] == list(range(1, 14))
        assert connection.execute(
            "SELECT count(*) FROM quiz_online.solo_rooms"
        ).fetchone()[0] == 0
        assert asyncio.run(_runtime_schema_version()) == 13

    try:
        # 012의 API(#108)는 013 DB 위에서도 돈다 — 그 API의 문장을 그 API와 같은 런타임 역할로
        # 돌린다. 그 기록(host_id의 줄)은 아래 finally가 migrator로 거둔다
        _v12_api_statements_run_on_v13(host_id, later_room_id, probe_code)
        asyncio.run(
            _exercise_candidate_against_v13(host_id, guest_id, solo_id, room_code, match_id)
        )
    finally:
        with psycopg.connect(MIGRATOR_URL, autocommit=True) as connection:
            connection.execute(
                "DELETE FROM quiz_online.rooms WHERE code = ANY(%s)",
                ([room_code, later_code, probe_code],),
            )
            # 혼자 방은 그 사람의 방이다 — 지우면 표시도 CASCADE로 함께 사라진다
            connection.execute(
                "DELETE FROM quiz_online.rooms r USING quiz_online.solo_rooms s "
                "WHERE s.room_id = r.id AND s.player_id = %s",
                (solo_id,),
            )
            connection.execute(
                "DELETE FROM quiz_online.players WHERE id IN (%s, %s, %s)",
                (host_id, guest_id, solo_id),
            )
            # 런타임 역할은 랭킹 기록을 지우지 못한다 — 시험이 남긴 줄은 migrator가 거둔다
            connection.execute(
                "DELETE FROM quiz_online.online_rankings WHERE player_id IN (%s, %s, %s)",
                (host_id, guest_id, solo_id),
            )


async def _candidate_refuses_v12(player_id: UUID, room_code: str) -> None:
    """013 API를 012 DB 위에 올리면: readiness는 번호(12 ≠ 13)로 닫히고, 방 SQL은 없는 표를 본다."""
    assert RUNTIME_URL is not None
    repository = PostgresRoomsRepository(
        RUNTIME_URL,
        question_catalog=_test_catalog(),
        max_pool_size=1,
    )
    await repository.open()
    try:
        # release readiness는 정확히 RELEASE_SCHEMA_VERSION만 ready로 답한다 — 여기서는 503이다
        assert await repository.schema_version() == 12
        assert RELEASE_SCHEMA_VERSION == 13
        # 로비 목록·코드 조회(참가·소켓 티켓 앞)가 모두 solo_rooms를 본다
        with pytest.raises(errors.UndefinedTable):
            await repository.list_rooms(player_id)
        with pytest.raises(errors.UndefinedTable):
            await repository.get_access(room_code)
    finally:
        await repository.close()


async def _exercise_candidate_against_v13(
    host_id: UUID,
    guest_id: UUID,
    solo_id: UUID,
    room_code: str,
    match_id: UUID,
) -> None:
    assert RUNTIME_URL is not None
    repository = PostgresRoomsRepository(
        RUNTIME_URL,
        question_catalog=_test_catalog(),
        max_pool_size=2,
    )
    await repository.open()
    compatibility_code: str | None = None
    try:
        assert await repository.schema_version() == 13

        # 구버전 client의 gameMode:false·문항 시간 없는 방은 캐릭터 전용 20초 방이 된다
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
        compatibility_code = compatibility_room.code
        assert compatibility_room.game_mode is True
        assert compatibility_room.question_time_ms == 20_000
        await repository.join_room(guest_id, compatibility_room.code)
        assert await repository.leave_room(guest_id, compatibility_room.code) is not None
        assert await repository.leave_room(host_id, compatibility_room.code) is None
        compatibility_code = None

        await repository.upsert_player(
            host_id,
            _token_hash(host_id),
            validate_player("구버전방장", None),
            update_profile=False,
        )
        room = await repository.get_room(host_id, room_code)
        assert room is not None
        assert room.game_mode is True
        assert room.question_time_ms == 20_000
        assert all(player.character_id for player in room.players)

        # 011·012·013 전에 열린 판을 후보 API가 이어 간다 — 마감·시간 초과 모두 그 판의 20초다
        await _expire_phase(match_id)
        revealed = await repository.get_match(host_id, room_code)
        assert revealed.advanced is True
        assert revealed.match is not None and revealed.match.state == "revealing"
        assert revealed.match.question_time_ms == 20_000
        assert await _elapsed_ms(match_id, 1, guest_id) == 20_000

        await _expire_phase(match_id)
        second = await repository.get_match(guest_id, room_code)
        assert second.match is not None
        assert (second.match.state, second.match.current_position) == ("running", 2)
        assert await _question_span(match_id) == timedelta(seconds=20)

        await _expire_phase(match_id)
        await repository.get_match(host_id, room_code)
        await _expire_phase(match_id)
        finished = (await repository.get_match(host_id, room_code)).match
        assert finished is not None and finished.state == "finished"
        # 012 전에 열린 판도 후보 API가 닫았으니 참가자마다 서버가 채점한 기록이 남는다(013의
        # 색인도 함께 갱신된다)
        assert finished.ranking_recorded is True
        assert await _ranking_rows(match_id) == [
            # 같은 점수·같은 시각이면 최종 순위의 순서(이름 순)대로 남는다
            ("구버전방장", "category", "science", 0, 0, 2, 20_000, True),
            ("구버전손님", "category", "science", 0, 0, 2, 20_000, True),
        ]

        setup = await repository.start_game(host_id, room_code)
        assert setup.game_mode is True
        assert setup.question_time_ms == 20_000
        assert await _question_span(setup.id) == timedelta(seconds=20)

        # 013의 것: 홈의 분야 칸이 곧바로 여는 혼자 판. 그 방은 그 사람에게만 보인다
        await repository.upsert_player(solo_id, _token_hash(solo_id), validate_player("혼자", None))
        solo = await repository.start_solo(
            solo_id, validate_solo_room(category_id="science", question_time_ms=20_000)
        )
        assert solo.created is True and solo.match is not None and solo.room.solo is True
        assert solo.room.code not in {room.code for room in await repository.list_rooms(host_id)}
        # 끝까지 풀면(첫 문항만 맞힌다) 기록이 남고, 013의 색인으로 읽는 내 최고 기록은 그 사람의
        # 주인 열쇠(토큰에서 나온다)로만 그 기록을 돌려준다
        solo_owner_key = ranking_owner_key(_token_hash(solo_id))
        assert await repository.own_best_scores(
            actor_id=solo_id, owner_key=solo_owner_key
        ) == dict.fromkeys(RANKING_BOARDS)
        solo_finished = await _finish_solo_match(
            repository, solo_id, solo.room.code, solo.match.id, solo.match.total_questions
        )
        assert solo_finished.ranking_recorded is True
        best = await repository.own_best_scores(actor_id=solo_id, owner_key=solo_owner_key)
        science = best["science"]
        assert science is not None
        assert (science.score, science.correct_count, science.total_count) == (
            10,
            1,
            solo.match.total_questions,
        )
        assert all(view is None for board, view in best.items() if board != "science")
        # 같은 id라도 다른 열쇠(다른 브라우저의 토큰)로는 아무것도 «내 것»이 아니다
        assert await repository.own_best_scores(
            actor_id=solo_id, owner_key=ranking_owner_key(b"\x00" * 32)
        ) == dict.fromkeys(RANKING_BOARDS)
        # 결과 화면은 방금 닫힌 판을 빼고 «이 판 전의» 최고 기록과 견준다 (FR-5.7)
        assert await repository.own_best_scores(
            actor_id=solo_id, owner_key=solo_owner_key, exclude_match_id=solo.match.id
        ) == dict.fromkeys(RANKING_BOARDS)
    finally:
        await repository.close()
        if compatibility_code is not None:
            async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
                await connection.execute(
                    "DELETE FROM quiz_online.rooms WHERE code = %s", (compatibility_code,)
                )


# 012의 API(#108, ux/p4-rankings의 server/app/postgres.py)가 쓰는 문장. 이 소스에는 그 코드가 없어
# 문장 모양을 옮겨 둔다 — 판을 닫으며 남기는 기록(`_INSERT_RANKING_SQL`), 60초 정리의 보존 함수,
# 마지막 사람이 나갈 때의 방 삭제(`leave_room`)
_V12_INSERT_RANKING_SQL = """
INSERT INTO quiz_online.online_rankings (
    match_id, player_id, mode, category_id, score, correct_count, total_questions,
    question_time_ms, nickname, character_id, owner_key, recorded_at
)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (match_id, player_id) DO NOTHING
"""
_V12_PRUNE_SQL = "SELECT quiz_online.prune_online_rankings() AS pruned"
_V12_DELETE_ROOM_SQL = "DELETE FROM quiz_online.rooms WHERE id = %s"


def _v12_api_statements_run_on_v13(player_id: UUID, room_id: UUID, solo_code: str) -> None:
    """013을 올린 DB에서 012의 API가 쓰는 문장을 런타임 역할로 돌린다.

    migrator(superuser)로 돌리면 권한을 하나도 보지 않는다 — 012의 API가 013 DB 위에서 계속 돈다는
    것은 그 역할의 권한으로 말해야 한다. 남긴 기록 줄(player_id의 것)은 이 역할이 지우지 못하므로
    부른 쪽이 migrator로 거둔다.
    """
    assert RUNTIME_URL is not None
    probe_match = uuid4()
    with psycopg.connect(RUNTIME_URL, autocommit=True) as connection:
        assert connection.execute("SELECT current_user").fetchone()[0] == "quiz_by_quiz_app"
        # 011·012의 API가 쓰던 방 문장(문항 시간을 적는다)
        assert connection.execute(
            """
            UPDATE quiz_online.rooms SET question_time_ms = 20000, updated_at = now()
            WHERE id = %s
            RETURNING question_time_ms
            """,
            (room_id,),
        ).fetchone()[0] == 20_000
        # 판을 닫으며 남기는 기록 — 013의 한 사람 색인도 함께 갱신될 뿐이다
        cursor = connection.execute(
            _V12_INSERT_RANKING_SQL,
            (
                probe_match,
                player_id,
                "category",
                "science",
                10,
                1,
                10,
                20_000,
                "012API",
                DEFAULT_CHARACTER_ID,
                ranking_owner_key(_token_hash(player_id)),
                datetime.now(UTC),
            ),
        )
        assert cursor.rowcount == 1
        assert connection.execute(_V12_PRUNE_SQL).fetchone()[0] >= 0
        # 그 API는 혼자 방 표시를 모른다. 013 API가 남긴(되돌린 뒤의) 혼자 방도 그 API가 마지막
        # 사람이 나갈 때 지우는 문장으로 지워지고, 표시는 CASCADE로 함께 사라진다 — 런타임 역할에
        # solo_rooms의 DELETE가 없어도 된다
        solo_room_id = connection.execute(
            """
            INSERT INTO quiz_online.rooms (
                code, name, category_id, capacity, game_mode,
                is_public, password_hash, host_player_id, expires_at
            )
            VALUES (
                %s, '혼자 하기', 'science', 2, true, true, NULL, %s, now() + interval '24 hours'
            )
            RETURNING id
            """,
            (solo_code, player_id),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO quiz_online.solo_rooms (room_id, player_id) VALUES (%s, %s)",
            (solo_room_id, player_id),
        )
        with pytest.raises(errors.InsufficientPrivilege):
            connection.execute(
                "DELETE FROM quiz_online.solo_rooms WHERE room_id = %s", (solo_room_id,)
            )
        assert connection.execute(_V12_DELETE_ROOM_SQL, (solo_room_id,)).rowcount == 1
        assert connection.execute(
            "SELECT count(*) FROM quiz_online.solo_rooms WHERE room_id = %s", (solo_room_id,)
        ).fetchone()[0] == 0


async def _finish_solo_match(
    repository: PostgresRoomsRepository,
    player_id: UUID,
    code: str,
    match_id: UUID,
    total: int,
) -> MatchView:
    """혼자 판을 끝까지 푼다 — 첫 문항만 맞히고 나머지는 틀린다. 직접 답하면 곧바로 공개다."""
    read: MatchView | None = None
    for position in range(1, total + 1):
        answer = await _answer_index(match_id, position)
        await repository.submit_answer(
            player_id,
            code,
            position=position,
            choice_index=answer if position == 1 else (answer + 1) % 4,
        )
        revealing = (await repository.get_match(player_id, code)).match
        assert revealing is not None and revealing.state == "revealing", position
        await _expire_phase(match_id)
        read = (await repository.get_match(player_id, code)).match
        assert read is not None
    assert read is not None and read.state == "finished"
    return read


async def _answer_index(match_id: UUID, position: int) -> int:
    assert RUNTIME_URL is not None
    async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT answer_index FROM quiz_online.match_questions
            WHERE match_id = %s AND position = %s
            """,
            (match_id, position),
        )
        row = await cursor.fetchone()
    assert row is not None
    return int(row[0])


async def _ranking_rows(match_id: UUID) -> list[tuple[object, ...]]:
    assert RUNTIME_URL is not None
    async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT ranking.nickname, ranking.mode, ranking.category_id, ranking.score,
                   ranking.correct_count, ranking.total_questions, ranking.question_time_ms,
                   ranking.recorded_at = match.finished_at
            FROM quiz_online.online_rankings ranking
            JOIN quiz_online.matches match ON match.id = ranking.match_id
            WHERE ranking.match_id = %s
            ORDER BY ranking.id
            """,
            (match_id,),
        )
        return [tuple(row) for row in await cursor.fetchall()]


async def _runtime_schema_version() -> int:
    assert RUNTIME_URL is not None
    repository = PostgresRoomsRepository(RUNTIME_URL, max_pool_size=1)
    await repository.open()
    try:
        return await repository.schema_version()
    finally:
        await repository.close()


async def _expire_phase(match_id: UUID) -> None:
    """지금 phase(문항 또는 공개)의 마감이 이미 지난 것처럼 만든다."""
    assert RUNTIME_URL is not None
    async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET question_started_at = now() - interval '1 minute',
                deadline_at = now() - interval '1 minute'
            WHERE id = %s
            """,
            (match_id,),
        )


async def _question_span(match_id: UUID) -> timedelta:
    assert RUNTIME_URL is not None
    async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT deadline_at - question_started_at FROM quiz_online.matches WHERE id = %s",
            (match_id,),
        )
        row = await cursor.fetchone()
    assert row is not None
    return row[0]


async def _elapsed_ms(match_id: UUID, position: int, player_id: UUID) -> int:
    assert RUNTIME_URL is not None
    async with await AsyncConnection.connect(RUNTIME_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT elapsed_ms
            FROM quiz_online.match_answers
            WHERE match_id = %s AND position = %s AND player_id = %s
            """,
            (match_id, position, player_id),
        )
        row = await cursor.fetchone()
    assert row is not None
    return int(row[0])


def _seed_v9_room(
    connection: psycopg.Connection[tuple[object, ...]],
    host_id: UUID,
    guest_id: UUID,
    room_code: str,
) -> UUID:
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
    return room_id


def _seed_v9_running_match(
    connection: psycopg.Connection[tuple[object, ...]],
    room_id: UUID,
    host_id: UUID,
    guest_id: UUID,
) -> UUID:
    """v9 writer가 연 판: gameMode false, 방장 캐릭터 NULL, 방장은 첫 문항에서 시간 초과(20초)."""
    match_id = connection.execute(
        """
        INSERT INTO quiz_online.matches (
            room_id, category_id, game_mode, total_questions, deadline_at, expires_at
        )
        VALUES (%s, 'science', false, %s, now() + interval '20 seconds', now() + interval '2 hours')
        RETURNING id
        """,
        (room_id, len(_SEEDED_QUESTIONS)),
    ).fetchone()[0]
    connection.execute(
        """
        INSERT INTO quiz_online.match_players (match_id, player_id, nickname, character_id)
        VALUES (%s, %s, '구버전방장', NULL), (%s, %s, '구버전손님', 'slime-pink')
        """,
        (match_id, host_id, match_id, guest_id),
    )
    for position, (question_id, answer_index) in enumerate(_SEEDED_QUESTIONS, start=1):
        connection.execute(
            """
            INSERT INTO quiz_online.match_questions (
                match_id, position, question_id, category_id, choices, answer_index
            )
            VALUES (%s, %s, %s, 'science', %s, %s)
            """,
            (match_id, position, question_id, Jsonb(["one", "two", "three", "four"]), answer_index),
        )
    connection.execute(
        """
        INSERT INTO quiz_online.match_answers (
            match_id, position, player_id, choice_index, correct, timed_out, elapsed_ms
        )
        VALUES (%s, 1, %s, NULL, false, true, 20000)
        """,
        (match_id, host_id),
    )
    return match_id


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
