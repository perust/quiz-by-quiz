"""온라인 랭킹(FR-7.13 2단계, migration 012)을 실제 PostgreSQL에서 확인한다.

- 판이 닫힐 때 같은 transaction에서 판의 참가자마다 서버가 채점한 기록이 하나씩 남는다(혼자·여럿,
  판 도중 끊긴 사람 포함, 시작 때 끊겨 판에 없던 사람은 없다). 닉네임은 그 방의 이름이고 지금 규칙에
  걸리는 옛 이름은 «익명»이다.
- 조회는 점수 내림차순, 같은 점수는 먼저 남긴 기록이 위, 순위는 그 순서(1, 2, 3)이고 상위 10이다.
  «이번 주»는 서울 시각 월요일 0시부터 다음 월요일 0시 전까지다.
- 정리는 최근 8주와 판마다 전체 상위 100을 남긴다. 런타임 역할은 기록을 고치거나 지우지 못한다.

런타임 역할은 기록을 지울 수 없어(그것이 계약이다) 이 test가 남긴 줄은 DB에 남는다. CI는 빈 DB에서
돌고, 조회를 견주는 test는 다른 test가 쓰지 않는 판(분야)과 먼 미래의 주를 골라 서로 섞이지 않는다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import AsyncConnection, errors

from app.domain import ValidatedRoom, validate_player, validate_room
from app.main import _match_payload
from app.nickname_filter import ANONYMOUS_NICKNAME
from app.postgres import PostgresRoomsRepository
from app.question_catalog import QuestionCatalog
from app.repository import MatchView

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")

SEOUL = timedelta(hours=9)


@pytest.mark.integration
def test_postgres_records_a_solo_match_once_with_the_server_graded_score() -> None:
    asyncio.run(_exercise_solo_record())


@pytest.mark.integration
def test_postgres_records_every_player_of_a_multi_match_including_absent_ones() -> None:
    asyncio.run(_exercise_multi_record())


@pytest.mark.integration
def test_postgres_rankings_order_by_score_then_earlier_record_and_mark_mine() -> None:
    asyncio.run(_exercise_ordering())


@pytest.mark.integration
def test_postgres_weekly_window_runs_from_monday_midnight_in_seoul() -> None:
    asyncio.run(_exercise_week_edges())


@pytest.mark.integration
def test_postgres_retention_keeps_eight_weeks_and_each_boards_top_hundred() -> None:
    asyncio.run(_exercise_retention())


@pytest.mark.integration
def test_postgres_runtime_role_cannot_rewrite_or_delete_rankings() -> None:
    asyncio.run(_exercise_runtime_grants())


# 저장 한도(250,000줄)는 그만큼의 줄이 있어야 보인다. 런타임 역할은 그 줄을 거둘 수 없으므로
# migrator 권한의 test 전용 DB(release_check test와 같은 RELEASE_CHECK_TEST_DATABASE_URL)에서
# 한 transaction 안에 넣고 정리한 뒤 되돌린다.
TEST_MIGRATOR_URL = os.getenv("RELEASE_CHECK_TEST_DATABASE_URL")


@pytest.mark.integration
@pytest.mark.skipif(not TEST_MIGRATOR_URL, reason="RELEASE_CHECK_TEST_DATABASE_URL is not set")
def test_postgres_retention_caps_storage_even_inside_eight_weeks() -> None:
    assert TEST_MIGRATOR_URL is not None
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        with connection.transaction(force_rollback=True):
            connection.execute("SET LOCAL lock_timeout = '10s'")
            connection.execute("DELETE FROM quiz_online.online_rankings")
            # 모두 8주 안이다. 한도보다 20,005줄 많고, 가장 오래된 줄들이 맨 앞이다
            connection.execute(
                """
                INSERT INTO quiz_online.online_rankings (
                    match_id, player_id, mode, category_id, score, correct_count,
                    total_questions, question_time_ms, nickname, character_id, recorded_at
                )
                SELECT gen_random_uuid(), gen_random_uuid(), 'category', 'history',
                       (serial % 11) * 10, serial % 11, 10, 20000, '한도', 'slime-blue',
                       now() - interval '30 days' + serial * interval '1 second'
                FROM generate_series(1, 270005) AS serial
                """
            )
            oldest = connection.execute(
                """
                SELECT id FROM quiz_online.online_rankings
                WHERE score < 100
                ORDER BY recorded_at ASC, id ASC
                LIMIT 1
                """
            ).fetchone()
            first = connection.execute("SELECT quiz_online.prune_online_rankings()").fetchone()
            second = connection.execute("SELECT quiz_online.prune_online_rankings()").fetchone()
            third = connection.execute("SELECT quiz_online.prune_online_rankings()").fetchone()
            remaining = connection.execute(
                "SELECT count(*) FROM quiz_online.online_rankings"
            ).fetchone()
            gone = connection.execute(
                "SELECT count(*) FROM quiz_online.online_rankings WHERE id = %s",
                (oldest[0] if oldest else None,),
            ).fetchone()
            # 한도 밖이던 앞쪽 20,004줄(250,001번째로 새 줄보다 오래된 줄)에서 남은 것
            beyond = connection.execute(
                """
                SELECT count(*), min(score)
                FROM quiz_online.online_rankings
                WHERE recorded_at < now() - interval '30 days' + 20005 * interval '1 second'
                """
            ).fetchone()

    assert first is not None and second is not None and third is not None
    # 한 번에 10,000줄까지 지우고 다음 차례에 이어 간다. 한도에 닿으면 멈춘다
    # (한도 밖 20,004줄 가운데 판의 전체 상위 100을 뺀 19,904줄)
    assert (first[0], second[0], third[0]) == (10_000, 9_904, 0)
    assert remaining is not None and remaining[0] == 270_005 - 19_904
    assert gone is not None and gone[0] == 0
    # 판의 전체 상위 100(가장 먼저 남긴 만점들)은 한도를 넘어도 남는다
    assert beyond is not None and tuple(beyond) == (100, 100)


# ── 기록 ───────────────────────────────────────────────────────────────────────


async def _exercise_solo_record() -> None:
    repository = await _repository()
    host_id = uuid4()
    room_code: str | None = None
    try:
        await _register(repository, {host_id: "혼자푸는나"})
        room = await repository.create_room(host_id, _room_spec("혼자 랭킹", "history"), None)
        room_code = room.code
        setup = await repository.start_game(host_id, room.code)
        # 홀수 문항은 맞히고 짝수 문항은 틀린다 → 50점, 5/10
        plan = {host_id: [position % 2 == 1 for position in range(1, setup.total_questions + 1)]}
        finished = await _play(repository, room.code, setup.id, host_id, plan)

        assert finished.state == "finished"
        assert finished.ranking_recorded is True
        assert _match_payload(finished)["rankingRecorded"] is True
        rows = await _records(setup.id)
        assert rows == [
            {
                "player_id": host_id,
                "nickname": "혼자푸는나",
                "character_id": "character-0",
                "mode": "category",
                "category_id": "history",
                "board": "history",
                "score": 50,
                "correct_count": 5,
                "total_questions": 10,
                "question_time_ms": 20_000,
                "closed_at_match_finish": True,
            }
        ]

        # 끝난 판을 다시 읽어도(다른 화면·새로고침) 두 번 남지 않는다
        again = await repository.get_match(host_id, room.code)
        assert again.advanced is False
        assert len(await _records(setup.id)) == 1

        # 한 판 더도 제 기록을 하나 더 남긴다 — 판마다 하나다
        rematch = await repository.start_game(host_id, room.code)
        plan = {host_id: [True] * rematch.total_questions}
        await _play(repository, room.code, rematch.id, host_id, plan)
        assert [row["score"] for row in await _records(rematch.id)] == [100]
    finally:
        await repository.close()
        await _cleanup([host_id], room_code)


async def _exercise_multi_record() -> None:
    repository = await _repository()
    host_id, ace_id, tied_id, absent_id, outsider_id, renamed_id = (uuid4() for _ in range(6))
    players = [host_id, ace_id, tied_id, absent_id, outsider_id, renamed_id]
    room_code: str | None = None
    try:
        await _register(
            repository,
            {
                host_id: "같은이름",
                ace_id: "에이스",
                # 방 안에서 이름이 겹치면 뒤에 숫자가 붙는다(같은이름1). 기록은 그 방의 이름이다
                tied_id: "같은이름",
                absent_id: "떠난사람",
                outsider_id: "늦은사람",
                renamed_id: "옛이름",
            },
        )
        room = await repository.create_room(host_id, _room_spec("여럿 랭킹", None, 6), None)
        room_code = room.code
        for player_id in (ace_id, tied_id, absent_id, outsider_id, renamed_id):
            await repository.join_room(player_id, room.code)
            await repository.set_ready(player_id, room.code, True)
        # 규칙이 생기기 전에 지은 이름(지금 규칙에 걸린다)이 방에 남아 있다.
        # API를 거치지 않고 바꾼다
        await _set_member_nickname(room.code, renamed_id, "kim@mail.kr")
        # 시작할 때 끊겨 있던 사람은 판에 자리가 없다(U24) — 기록도 없다
        setup = await repository.start_game(
            host_id, room.code, absent_player_ids=frozenset({outsider_id})
        )
        assert setup.category_id is None and setup.total_questions == 25

        total = setup.total_questions
        plan: dict[UUID, list[bool | None]] = {
            ace_id: [True] * total,
            # 방장과 tied는 같은 점수(셋 맞힘)다
            host_id: [True, True, True] + [False] * (total - 3),
            tied_id: [False] * (total - 3) + [True, True, True],
            # 둘째 문항부터 끊겼다 — 남은 문항은 시간 초과로 채워진다(U32)
            absent_id: [True] + [None] * (total - 1),
            renamed_id: [False] * total,
        }
        finished = await _play(
            repository,
            room.code,
            setup.id,
            host_id,
            plan,
            absent_from={absent_id: 2},
        )
        assert finished.state == "finished"

        rows = await _records(setup.id)
        recorded = {row["player_id"] for row in rows}
        assert recorded == {host_id, ace_id, tied_id, absent_id, renamed_id}
        by_player = {row["player_id"]: row for row in rows}
        assert by_player[ace_id]["score"] == 250 and by_player[ace_id]["correct_count"] == 25
        assert by_player[host_id]["score"] == by_player[tied_id]["score"] == 30
        assert by_player[absent_id]["score"] == 10
        assert by_player[renamed_id]["nickname"] == ANONYMOUS_NICKNAME
        assert by_player[tied_id]["nickname"] == "같은이름1"
        assert by_player[host_id]["nickname"] == "같은이름"
        assert all(row["mode"] == "all" and row["category_id"] is None for row in rows)
        assert all(row["board"] == "all" and row["total_questions"] == 25 for row in rows)
        assert all(row["closed_at_match_finish"] for row in rows)
        # 같은 판은 같은 시각이다. 같은 점수면 그 판의 최종 순위(이름 순)대로 남아
        # id가 순서를 정한다
        assert [row["player_id"] for row in rows] == [
            ace_id,
            host_id,
            tied_id,
            absent_id,
            renamed_id,
        ]

        week = await repository.list_rankings(
            board="all", period="week", actor_id=tied_id, at=await _finished_at(setup.id)
        )
        mine = [entry for entry in week.entries if entry.is_mine]
        assert [(entry.nickname, entry.score) for entry in mine] == [("같은이름1", 30)]
        ours = [
            entry.nickname
            for entry in week.entries
            if entry.nickname in {"에이스", "같은이름", "같은이름1"}
        ]
        assert ours[:3] == ["에이스", "같은이름", "같은이름1"]
    finally:
        await repository.close()
        await _cleanup(players, room_code)


# ── 조회 ───────────────────────────────────────────────────────────────────────


async def _exercise_ordering() -> None:
    repository = await _repository()
    me, other = uuid4(), uuid4()
    monday = _far_week_monday()
    try:
        base = monday + timedelta(days=2)
        # (점수, 몇 분 뒤, 누구) — 같은 점수 70은 먼저 남긴 기록이 위,
        # 같은 시각이면 먼저 넣은 줄이 위
        rows = [
            (70, 30, other),
            (90, 50, other),
            (70, 10, me),
            (70, 30, me),
            (100, 90, other),
            (40, 1, other),
            (60, 2, other),
            (60, 3, me),
            (50, 4, other),
            (30, 5, other),
            (20, 6, other),
            (10, 7, me),
        ]
        for score, minutes, player_id in rows:
            await _insert_record(
                board="geography",
                player_id=player_id,
                score=score,
                recorded_at=base + timedelta(minutes=minutes),
                nickname=f"점수{score}",
            )

        view = await repository.list_rankings(
            board="geography", period="week", actor_id=me, at=base
        )
        assert [entry.rank for entry in view.entries] == list(range(1, 11))
        assert [(entry.score, entry.is_mine) for entry in view.entries] == [
            (100, False),
            (90, False),
            (70, True),
            (70, False),
            (70, True),
            (60, False),
            (60, True),
            (50, False),
            (40, False),
            (30, False),
        ]
        recorded = [entry.recorded_at for entry in view.entries]
        assert recorded[2] < recorded[3] == recorded[4]
        assert view.entries[0].total_count == 10 and view.entries[0].correct_count == 10
        assert view.entries[0].character_id == "slime-blue"

        # 신분이 없으면 아무것도 내 기록이 아니다
        anonymous = await repository.list_rankings(board="geography", period="week", at=base)
        assert not any(entry.is_mine for entry in anonymous.entries)

        # 전체 기간도 같은 순서·같은 한도다
        overall = await repository.list_rankings(board="geography", period="all", actor_id=me)
        assert overall.window_start is None and overall.window_end is None
        assert len(overall.entries) <= 10
        order = [(-entry.score, entry.recorded_at) for entry in overall.entries]
        assert order == sorted(order)
        assert [entry.rank for entry in overall.entries] == list(
            range(1, len(overall.entries) + 1)
        )
    finally:
        await repository.close()


async def _exercise_week_edges() -> None:
    repository = await _repository()
    try:
        monday = _far_week_monday()
        sunday_last = monday - timedelta(microseconds=1)
        next_monday = monday + timedelta(days=7)
        for name, moment in (
            ("일요일끝", sunday_last),
            ("월요일0시", monday),
            ("일요일밤", next_monday - timedelta(microseconds=1)),
            ("다음월요일", next_monday),
        ):
            await _insert_record(
                board="general", player_id=uuid4(), score=50, recorded_at=moment, nickname=name
            )

        this_week = await repository.list_rankings(board="general", period="week", at=monday)
        assert [entry.nickname for entry in this_week.entries] == ["월요일0시", "일요일밤"]
        assert _instant(this_week.window_start) == monday
        assert _instant(this_week.window_end) == next_monday

        # 일요일 23:59:59.999999(서울)는 앞 주다
        previous = await repository.list_rankings(board="general", period="week", at=sunday_last)
        assert [entry.nickname for entry in previous.entries] == ["일요일끝"]
        assert _instant(previous.window_end) == monday

        # 월요일 0시 직전이 아니라 바로 그 순간부터 새 주다
        upcoming = await repository.list_rankings(board="general", period="week", at=next_monday)
        assert [entry.nickname for entry in upcoming.entries] == ["다음월요일"]

        # UTC로는 일요일 15시가 서울의 월요일 0시다 — 브라우저나 서버의 시간대와 무관하다
        assert (monday + SEOUL).weekday() == 0 and (monday + SEOUL).hour == 0
        assert monday.weekday() == 6 and monday.hour == 15
    finally:
        await repository.close()


async def _exercise_retention() -> None:
    repository = await _repository()
    try:
        now = datetime.now(UTC)
        # 최근 8주 안: 점수 100 백 줄과 0점 하나 — 모두 남는다
        for index in range(100):
            await _insert_record(
                board="art",
                player_id=uuid4(),
                score=100,
                recorded_at=now - timedelta(minutes=index),
                nickname="최근",
            )
        recent_low = await _insert_record(
            board="art", player_id=uuid4(), score=0, recorded_at=now, nickname="최근0점"
        )
        # 8주(56일) 넘게 지났지만 전체 상위 100 안(가장 먼저 남긴 만점) — 남는다
        old_top = await _insert_record(
            board="art",
            player_id=uuid4(),
            score=100,
            recorded_at=now - timedelta(days=400),
            nickname="오래된만점",
        )
        # 8주 넘게 지났고 상위 100 밖 — 지운다
        old_low = await _insert_record(
            board="art",
            player_id=uuid4(),
            score=10,
            recorded_at=now - timedelta(days=57),
            nickname="오래된10점",
        )
        # 경계 안쪽(55일)은 상위 밖이어도 남는다
        boundary = await _insert_record(
            board="art",
            player_id=uuid4(),
            score=10,
            recorded_at=now - timedelta(days=55),
            nickname="55일",
        )

        counts = await repository.cleanup_expired_resources()
        assert counts.rankings_pruned >= 1
        assert counts.changed is True
        remaining = await _existing({recent_low, old_top, old_low, boundary})
        assert remaining == {recent_low, old_top, boundary}

        # 전체 랭킹의 위는 정리로 바뀌지 않는다
        overall = await repository.list_rankings(board="art", period="all")
        assert overall.entries[0].nickname == "오래된만점"

        # 지울 것이 없으면 아무것도 지우지 않는다
        assert (await repository.cleanup_expired_resources()).rankings_pruned == 0
    finally:
        await repository.close()


async def _exercise_runtime_grants() -> None:
    assert DATABASE_URL is not None
    record_id = await _insert_record(
        board="history",
        player_id=uuid4(),
        score=10,
        recorded_at=_far_week_monday(),
        nickname="권한",
    )
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        for statement in (
            "UPDATE quiz_online.online_rankings SET score = 100 WHERE id = %s",
            "DELETE FROM quiz_online.online_rankings WHERE id = %s",
        ):
            with pytest.raises(errors.InsufficientPrivilege):
                await connection.execute(statement, (record_id,))
        with pytest.raises(errors.InsufficientPrivilege):
            await connection.execute("TRUNCATE quiz_online.online_rankings")
        # 브라우저가 보고하는 점수 같은 것은 없다. 표의 제약도 서버 채점의 모양만 받는다
        with pytest.raises(errors.CheckViolation):
            await connection.execute(
                """
                INSERT INTO quiz_online.online_rankings (
                    match_id, player_id, mode, category_id, score, correct_count,
                    total_questions, question_time_ms, nickname, character_id, recorded_at
                )
                VALUES (
                    %s, %s, 'category', 'history', 95, 9, 10, 20000, '조작', 'slime-blue', now()
                )
                """,
                (uuid4(), uuid4()),
            )
        with pytest.raises(errors.CheckViolation):
            await connection.execute(
                """
                INSERT INTO quiz_online.online_rankings (
                    match_id, player_id, mode, category_id, score, correct_count,
                    total_questions, question_time_ms, nickname, character_id, recorded_at
                )
                VALUES (%s, %s, 'all', 'history', 10, 1, 25, 20000, '조작', 'slime-blue', now())
                """,
                (uuid4(), uuid4()),
            )
        # 같은 판·같은 사람은 한 번뿐이다
        match_id, player_id = uuid4(), uuid4()
        insert = """
            INSERT INTO quiz_online.online_rankings (
                match_id, player_id, mode, category_id, score, correct_count,
                total_questions, question_time_ms, nickname, character_id, recorded_at
            )
            VALUES (%s, %s, 'category', 'history', 10, 1, 10, 20000, '한번', 'slime-blue', now())
        """
        await connection.execute(insert, (match_id, player_id))
        with pytest.raises(errors.UniqueViolation):
            await connection.execute(insert, (match_id, player_id))
        # 생성 열은 쓸 수 없다 — 판과 주는 기록 시각·분야에서만 나온다
        with pytest.raises(errors.GeneratedAlways):
            await connection.execute(
                """
                INSERT INTO quiz_online.online_rankings (
                    match_id, player_id, mode, category_id, score, correct_count,
                    total_questions, question_time_ms, nickname, character_id, recorded_at,
                    week_start
                )
                VALUES (%s, %s, 'category', 'history', 10, 1, 10, 20000, '주', 'slime-blue',
                        now(), DATE '2000-01-03')
                """,
                (uuid4(), uuid4()),
            )


# ── 도우미 ─────────────────────────────────────────────────────────────────────


async def _repository() -> PostgresRoomsRepository:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    return repository


async def _register(repository: PostgresRoomsRepository, names: dict[UUID, str]) -> None:
    for index, (player_id, nickname) in enumerate(names.items()):
        await repository.upsert_player(
            player_id,
            _token_hash(player_id),
            validate_player(nickname, f"character-{index}"),
        )


def _room_spec(name: str, category_id: str | None, capacity: int = 2) -> ValidatedRoom:
    return validate_room(
        name=name,
        category_id=category_id,
        capacity=capacity,
        is_public=True,
        password=None,
        game_mode=True,
    )


async def _play(
    repository: PostgresRoomsRepository,
    code: str,
    match_id: UUID,
    reader: UUID,
    plan: dict[UUID, list[bool | None]],
    *,
    absent_from: dict[UUID, int] | None = None,
) -> MatchView:
    """계획대로 판을 끝까지 푼다. True·False는 직접 낸 정답·오답, None은 답하지 않음(시간 초과)."""
    total = len(next(iter(plan.values())))
    for position in range(1, total + 1):
        absent = frozenset(
            player_id
            for player_id, start in (absent_from or {}).items()
            if position >= start
        )
        answer = await _answer_index(match_id, position)
        for player_id, choices in plan.items():
            choice = choices[position - 1]
            if choice is None:
                continue
            await repository.submit_answer(
                player_id,
                code,
                position=position,
                choice_index=answer if choice else (answer + 1) % 4,
                absent_player_ids=absent - {player_id},
            )
        read = await repository.get_match(reader, code, absent_player_ids=absent - {reader})
        assert read.match is not None
        if read.match.state == "running":
            await _close_question_now(match_id)
            read = await repository.get_match(reader, code)
            assert read.match is not None
        assert read.match.state == "revealing", position
        await _expire_reveal(match_id)
        read = await repository.get_match(reader, code)
        assert read.match is not None
    assert read.match.state == "finished"
    return read.match


async def _records(match_id: UUID) -> list[dict[str, object]]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT ranking.player_id, ranking.nickname, ranking.character_id, ranking.mode,
                   ranking.category_id, ranking.board, ranking.score, ranking.correct_count,
                   ranking.total_questions, ranking.question_time_ms,
                   ranking.recorded_at = match.finished_at AS closed_at_match_finish
            FROM quiz_online.online_rankings ranking
            JOIN quiz_online.matches match ON match.id = ranking.match_id
            WHERE ranking.match_id = %s
            ORDER BY ranking.id
            """,
            (match_id,),
        )
        columns = [column.name for column in cursor.description or ()]
        return [dict(zip(columns, row, strict=True)) for row in await cursor.fetchall()]


async def _finished_at(match_id: UUID) -> datetime:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT finished_at FROM quiz_online.matches WHERE id = %s", (match_id,)
        )
        row = await cursor.fetchone()
    assert row is not None
    return row[0]


async def _insert_record(
    *,
    board: str,
    player_id: UUID,
    score: int,
    recorded_at: datetime,
    nickname: str,
) -> int:
    """런타임 역할이 할 수 있는 INSERT로 정해진 기록을 넣는다(분야 판, 10문제)."""
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            INSERT INTO quiz_online.online_rankings (
                match_id, player_id, mode, category_id, score, correct_count, total_questions,
                question_time_ms, nickname, character_id, recorded_at
            )
            VALUES (%s, %s, 'category', %s, %s, %s, 10, 20000, %s, 'slime-blue', %s)
            RETURNING id
            """,
            (uuid4(), player_id, board, score, score // 10, nickname, recorded_at),
        )
        row = await cursor.fetchone()
    assert row is not None
    return int(row[0])


async def _existing(ids: set[int]) -> set[int]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT id FROM quiz_online.online_rankings WHERE id = ANY(%s)", (list(ids),)
        )
        return {int(row[0]) for row in await cursor.fetchall()}


async def _set_member_nickname(code: str, player_id: UUID, nickname: str) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.room_members member
            SET nickname = %s
            FROM quiz_online.rooms room
            WHERE member.room_id = room.id AND room.code = %s AND member.player_id = %s
            """,
            (nickname, code, player_id),
        )


def _far_week_monday() -> datetime:
    """다른 test와 겹치지 않는 먼 미래의 한 주. 서울 시각 월요일 0시(UTC로는 일요일 15시)다."""
    start = datetime(2200, 1, 6, tzinfo=UTC)  # 월요일
    week = start + timedelta(weeks=secrets.randbelow(40_000))
    return week - SEOUL


def _instant(value: str | None) -> datetime:
    assert value is not None
    return datetime.fromisoformat(value).astimezone(UTC)


async def _answer_index(match_id: UUID, position: int) -> int:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
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


async def _close_question_now(match_id: UUID) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            "UPDATE quiz_online.matches SET deadline_at = now() WHERE id = %s",
            (match_id,),
        )


async def _expire_reveal(match_id: UUID) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            "UPDATE quiz_online.matches SET deadline_at = question_started_at WHERE id = %s",
            (match_id,),
        )


def _token_hash(player_id: UUID) -> bytes:
    return hashlib.sha256(f"ranking-test-token:{player_id}".encode()).digest()


def _test_catalog() -> QuestionCatalog:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        for category in ("history", "science", "geography", "general", "art"):
            questions = [
                {
                    "id": f"online-{category}-{number:03d}",
                    "category": category,
                    "question": f"{category} ranking test question {number}?",
                    "choices": ["one", "two", "three", "four"],
                    "answerIndex": number % 4,
                    "explanation": f"ranking test explanation {number}",
                    "difficulty": "normal",
                    "tags": [],
                }
                for number in range(10)
            ]
            (root / f"{category}.json").write_text(json.dumps(questions), encoding="utf-8")
        return QuestionCatalog.from_directory(root)


async def _cleanup(player_ids: list[UUID], room_code: str | None) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        if room_code:
            await connection.execute("DELETE FROM quiz_online.rooms WHERE code = %s", (room_code,))
        await connection.execute(
            "DELETE FROM quiz_online.players WHERE id = ANY(%s)",
            (player_ids,),
        )
