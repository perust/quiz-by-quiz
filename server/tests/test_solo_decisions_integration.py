"""혼자 판의 소유자 결정 두 가지(결정 #2·#4 = PRD 10.1 #9·#11)를 실제 PostgreSQL에서 확인한다.

- #2 «제한 없음»: 혼자 방과 그 판만 문항 시간 NULL(마감 없음)을 가진다(migration 013). 마감
  sweep·끊긴 사람 채우기·발밑 칸이 모두 그 판을 건너뛰고, 공개는 그 사람이 답을 낼 때다. 쓴 시간은
  자르지 않고 잰다. 기록은 문항 시간 NULL로 남는다. 아무도 30분 넘게 보이지 않으면 멤버 정리가 기록
  없이 끝낸다.
- #4 다른 판을 고르면: 도는 판을 기록 없이 끝내고(`abandoned`) 같은 transaction에서 고른 판을 연다.
  같은 판이면 잇는다. 마지막 공개만 남은 판은 끝까지 푼 판이라 닫아 기록한다. 그만두기(DELETE
  /v1/solo)는 도는 판을 기록 없이 끝내고 혼자 방을 지운다.
- 012 API로 되돌릴 때의 정리(혼자 방 지우기)가 문항 시간 NULL인 방·판을 하나도 남기지 않는다.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection, errors
from test_online_rankings_integration import (
    DATABASE_URL,
    TEST_MIGRATOR_URL,
    _answer_index,
    _cleanup,
    _expire_reveal,
    _records,
    _register,
    _repository,
)
from test_solo_play_integration import _room_exists, _solo_marks

from app.domain import validate_solo_room
from app.postgres import PostgresRoomsRepository
from app.repository import MatchView, StandingAnswer

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


class _Drafts:
    """발밑 칸 초안을 내놓는 가짜. 마감 없는 판에서는 묻지도 않아야 한다."""

    def __init__(self, player_id: UUID, choice_index: int) -> None:
        self.asked: list[tuple[str, UUID, int]] = []
        self._draft = {
            player_id: StandingAnswer(choice_index=choice_index, received_at=datetime.now(UTC))
        }

    def for_question(
        self, code: str, match_id: UUID, position: int
    ) -> Mapping[UUID, StandingAnswer]:
        self.asked.append((code, match_id, position))
        return self._draft


@pytest.mark.integration
def test_postgres_an_untimed_solo_match_has_no_deadline_and_reveals_on_its_answer() -> None:
    asyncio.run(_exercise_untimed_match())


@pytest.mark.integration
def test_postgres_picking_another_board_ends_the_running_solo_match_without_a_record() -> None:
    asyncio.run(_exercise_restart())


@pytest.mark.integration
def test_postgres_a_fully_answered_solo_match_is_recorded_when_another_board_is_picked() -> None:
    asyncio.run(_exercise_restart_at_final_reveal())


@pytest.mark.integration
def test_postgres_ending_solo_play_removes_the_room_and_the_unrecorded_match() -> None:
    asyncio.run(_exercise_end_solo())


@pytest.mark.integration
def test_postgres_an_untimed_solo_match_nobody_watches_ends_with_the_stale_member_cleanup() -> None:
    asyncio.run(_exercise_idle_cleanup())


@pytest.mark.integration
def test_postgres_no_time_limit_lives_only_in_solo_rooms_and_their_matches() -> None:
    asyncio.run(_exercise_untimed_constraints())


async def _exercise_untimed_match() -> None:
    repository = await _repository()
    owner = uuid4()
    codes: list[str] = []
    try:
        await _register(repository, {owner: "느긋한나"})
        started = await repository.start_solo(
            owner, validate_solo_room(category_id="science", question_time_ms=None)
        )
        assert started.match is not None
        code, match_id = started.room.code, started.match.id
        codes.append(code)
        assert started.room.question_time_ms is None
        assert started.match.question_time_ms is None
        row = await _match_row(match_id)
        assert (row["state"], row["question_time_ms"], row["deadline_at"]) == (
            "running",
            None,
            None,
        )

        # 10분이 지나도 마감 sweep은 이 판을 넘기지 않는다
        await _shift_question_start(match_id, minutes=10)
        answer = await _answer_index(match_id, 1)
        drafts = _Drafts(owner, answer)
        swept = await repository.advance_expired_matches(standing_answers=drafts)
        assert match_id not in {advance.match_id for advance in swept}
        # 그 사람이 끊겨도 빈 답을 채우거나 발밑 칸을 답으로 남기지 않는다
        assert (
            await repository.advance_past_absent_players(
                code, frozenset({owner}), standing_answers=drafts
            )
            is False
        )
        read = await repository.get_match(
            owner, code, absent_player_ids=frozenset({owner}), standing_answers=drafts
        )
        assert read.advanced is False and read.match is not None
        assert (read.match.state, read.match.deadline_at) == ("running", None)
        assert read.match.question_time_ms is None
        assert drafts.asked == []
        assert await _answer_count(match_id) == 0

        # 직접 낸 답이 곧바로 공개를 연다. 쓴 시간은 40초에서 자르지 않는다(로컬 «제한 없음»과 같다)
        submitted = await repository.submit_answer(owner, code, position=1, choice_index=answer)
        assert submitted.advanced is True and submitted.match.state == "revealing"
        assert 599_000 <= await _elapsed_ms(match_id, 1, owner) <= 660_000
        # 공개에는 8초 마감이 있고, 다음 문항에는 다시 없다
        assert (await _match_row(match_id))["deadline_at"] is not None
        await _expire_reveal(match_id)
        swept = await repository.advance_expired_matches()
        assert match_id in {advance.match_id for advance in swept}
        row = await _match_row(match_id)
        assert (row["state"], row["current_position"], row["deadline_at"]) == ("running", 2, None)

        # 끝까지 풀면 다른 판처럼 기록된다 — 문항 시간 NULL로(랭킹은 문항 시간으로 나누지 않는다)
        finished = await _answer_through(repository, owner, code, match_id, start=2)
        assert finished.state == "finished" and finished.ranking_recorded is True
        assert finished.question_time_ms is None
        (record,) = await _records(match_id)
        assert record["question_time_ms"] is None and record["score"] == 100
        exported = await repository.own_records(
            actor_id=owner, owner_key=_owner_key_for(owner)
        )
        assert [item.question_time_ms for item in exported.records] == [None]
    finally:
        await repository.close()
        for code in codes:
            await _cleanup([], code)
        await _cleanup([owner], None)


async def _exercise_restart() -> None:
    repository = await _repository()
    owner = uuid4()
    codes: list[str] = []
    try:
        await _register(repository, {owner: "바꾸는나"})
        first = await repository.start_solo(
            owner, validate_solo_room(category_id="science", question_time_ms=20_000)
        )
        assert first.match is not None
        codes.append(first.room.code)
        science_id = first.match.id

        # 같은 판을 고르면 restart여도 잇는다 (문항 시간을 바꿨어도 도는 판 그대로다)
        same = await repository.start_solo(
            owner,
            validate_solo_room(category_id="science", question_time_ms=None),
            restart=True,
        )
        assert same.resumed is True and same.ended is None
        # restart를 보내지 않으면 다른 판이어도 예전처럼 도는 판을 돌려준다
        plain = await repository.start_solo(
            owner, validate_solo_room(category_id="art", question_time_ms=40_000)
        )
        assert plain.resumed is True and plain.ended is None
        assert (await _match_row(science_id))["state"] == "running"

        # 다른 판(전체 도전)을 고르면 도는 판을 기록 없이 끝내고 같은 방에서 새 판을 연다
        other = await repository.start_solo(
            owner,
            validate_solo_room(category_id=None, question_time_ms=None),
            restart=True,
        )
        assert other.match is not None and other.created is False
        assert other.room.code == first.room.code
        assert other.ended is not None
        assert (other.ended.match_id, other.ended.category_id) == (science_id, "science")
        assert (other.ended.position, other.ended.total_questions, other.ended.recorded) == (
            1,
            10,
            False,
        )
        ended_row = await _match_row(science_id)
        assert ended_row["state"] == "abandoned" and ended_row["deadline_at"] is None
        assert ended_row["finished_at"] is not None
        assert await _records(science_id) == []
        # 새 판: 전체 도전, 마감 없음. 방도 이번 값이다
        assert other.match.category_id is None and other.match.question_time_ms is None
        assert other.room.category_id is None and other.room.question_time_ms is None
        read = await repository.get_match(owner, first.room.code)
        assert read.match is not None and read.match.id == other.match.id
        assert read.match.total_questions == 25
        # 끝낸 판의 문항은 이 방의 «최근 문제»라 다음 판이 피한다 (N08) — 판은 남아 있다
        assert await _match_count(first.room.code) == 2
    finally:
        await repository.close()
        for code in codes:
            await _cleanup([], code)
        await _cleanup([owner], None)


async def _exercise_restart_at_final_reveal() -> None:
    repository = await _repository()
    owner = uuid4()
    codes: list[str] = []
    try:
        await _register(repository, {owner: "다푼나"})
        started = await repository.start_solo(
            owner, validate_solo_room(category_id="history", question_time_ms=None)
        )
        assert started.match is not None
        code, match_id = started.room.code, started.match.id
        codes.append(code)
        # 마지막 문항까지 답했다 — 마지막 공개만 남았다
        last = await _answer_through(
            repository, owner, code, match_id, start=1, stop_at_final_reveal=True
        )
        assert (last.state, last.current_position) == ("revealing", 10)

        other = await repository.start_solo(
            owner,
            validate_solo_room(category_id="art", question_time_ms=20_000),
            restart=True,
        )
        assert other.ended is not None and other.ended.recorded is True
        assert other.match is not None and other.match.category_id == "art"
        # 끝까지 푼 판이다 — 닫히고(finished) 그 점수가 남는다(로컬 N04의 «결과 보기»와 같다)
        assert (await _match_row(match_id))["state"] == "finished"
        (record,) = await _records(match_id)
        assert record["score"] == 100 and record["question_time_ms"] is None
    finally:
        await repository.close()
        for code in codes:
            await _cleanup([], code)
        await _cleanup([owner], None)


async def _exercise_end_solo() -> None:
    repository = await _repository()
    owner = uuid4()
    try:
        await _register(repository, {owner: "그만두는나"})
        assert (await repository.end_solo(owner)).code is None
        started = await repository.start_solo(
            owner, validate_solo_room(category_id="general", question_time_ms=None)
        )
        assert started.match is not None
        answer = await _answer_index(started.match.id, 1)
        await repository.submit_answer(
            owner, started.room.code, position=1, choice_index=answer
        )

        ended = await repository.end_solo(owner)
        assert ended.code == started.room.code
        assert ended.ended is not None and ended.ended.recorded is False
        assert ended.ended.match_id == started.match.id
        # 방·멤버십·판·표시가 함께 사라지고 기록은 남지 않는다
        assert not await _room_exists(started.room.code)
        assert await _solo_marks(owner) == 0
        assert await _match_exists(started.match.id) is False
        assert await _records(started.match.id) == []
        assert (await repository.end_solo(owner)).code is None
    finally:
        await repository.close()
        await _cleanup([owner], None)


async def _exercise_idle_cleanup() -> None:
    repository = await _repository()
    idle, watched, timed = uuid4(), uuid4(), uuid4()
    codes: list[str] = []
    try:
        await _register(repository, {idle: "자리비운나", watched: "푸는중", timed: "시간판"})
        idle_start = await repository.start_solo(
            idle, validate_solo_room(category_id="science", question_time_ms=None)
        )
        watched_start = await repository.start_solo(
            watched, validate_solo_room(category_id="science", question_time_ms=None)
        )
        timed_start = await repository.start_solo(
            timed, validate_solo_room(category_id="science", question_time_ms=20_000)
        )
        for started in (idle_start, watched_start, timed_start):
            assert started.match is not None
            codes.append(started.room.code)
        assert idle_start.match and timed_start.match and watched_start.match
        # 마감 없는 판의 사람이 31분 동안 보이지 않았다. 마감 있는 판의 사람도 그렇다
        await _last_seen(idle_start.room.code, idle, minutes=31)
        await _last_seen(timed_start.room.code, timed, minutes=31)

        counts = await repository.cleanup_expired_resources()

        assert counts.solo_matches_abandoned >= 1
        # 아무도 보지 않는 마감 없는 판은 기록 없이 끝나고, 같은 정리가 그 사람과 빈 방을 지운다
        assert not await _room_exists(idle_start.room.code)
        assert await _solo_marks(idle) == 0
        assert await _records(idle_start.match.id) == []
        # 푸는 중인(보이는) 판과 마감이 끝낼 판은 건드리지 않는다
        assert (await _match_row(watched_start.match.id))["state"] == "running"
        assert (await _match_row(timed_start.match.id))["state"] == "running"
        assert await _room_exists(timed_start.room.code)
    finally:
        await repository.close()
        for code in codes:
            await _cleanup([], code)
        await _cleanup([idle, watched, timed], None)


async def _exercise_untimed_constraints() -> None:
    assert DATABASE_URL is not None
    repository = await _repository()
    owner = uuid4()
    codes: list[str] = []
    try:
        await _register(repository, {owner: "울타리"})
        started = await repository.start_solo(
            owner, validate_solo_room(category_id="art", question_time_ms=None)
        )
        assert started.match is not None
        codes.append(started.room.code)
        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
            # 마감 없는 판의 도는 문항에는 마감이 없다 — 있으면 문항 시간과 어긋난다
            with pytest.raises(errors.CheckViolation):
                await connection.execute(
                    "UPDATE quiz_online.matches SET deadline_at = now() WHERE id = %s",
                    (started.match.id,),
                )
            # 그 판의 답은 판의 수명(2시간)까지 쓴 시간을 가질 수 있다
            await connection.execute(
                """
                INSERT INTO quiz_online.match_answers (
                    match_id, position, player_id, choice_index, correct, timed_out, elapsed_ms
                )
                VALUES (%s, 1, %s, 0, false, false, 7200000)
                """,
                (started.match.id, owner),
            )
        if TEST_MIGRATOR_URL is None:
            return
        # 012 API로 되돌릴 때의 정리(README «Solo online play»의 Rollback)는 혼자 방만 지운다.
        # 그래도 문항 시간 NULL인 방·판과 40초를 넘는 답은 하나도 남지 않는다(생성 열 + 외래 키).
        # 되돌린다
        async with await AsyncConnection.connect(TEST_MIGRATOR_URL) as migrator:
            async with migrator.transaction(force_rollback=True):
                await migrator.execute(
                    "DELETE FROM quiz_online.rooms r USING quiz_online.solo_rooms s "
                    "WHERE s.room_id = r.id"
                )
                # COMMIT에서 볼 외래 키를 지금 본다 — 정리가 실제로 COMMIT할 수 있다
                await migrator.execute("SET CONSTRAINTS ALL IMMEDIATE")
                cursor = await migrator.execute(
                    """
                    SELECT
                        (SELECT count(*) FROM quiz_online.rooms WHERE question_time_ms IS NULL),
                        (SELECT count(*) FROM quiz_online.matches WHERE question_time_ms IS NULL),
                        (SELECT count(*) FROM quiz_online.match_answers WHERE elapsed_ms > 40000)
                    """
                )
                assert await cursor.fetchone() == (0, 0, 0)
    finally:
        await repository.close()
        for code in codes:
            await _cleanup([], code)
        await _cleanup([owner], None)


async def _answer_through(
    repository: PostgresRoomsRepository,
    player_id: UUID,
    code: str,
    match_id: UUID,
    *,
    start: int,
    stop_at_final_reveal: bool = False,
) -> MatchView:
    """마감 없는 판을 start번부터 끝까지 맞게 푼다. 공개는 마감을 당겨 넘긴다."""
    total = int((await _match_row(match_id))["total_questions"])
    view = None
    for position in range(start, total + 1):
        answer = await _answer_index(match_id, position)
        submitted = await repository.submit_answer(
            player_id, code, position=position, choice_index=answer
        )
        assert submitted.advanced is True and submitted.match.state == "revealing", position
        view = submitted.match
        if position == total and stop_at_final_reveal:
            return view
        await _expire_reveal(match_id)
        read = await repository.get_match(player_id, code)
        assert read.match is not None
        view = read.match
    assert view is not None
    return view


def _owner_key_for(player_id: UUID) -> bytes:
    from test_online_rankings_integration import _owner_key

    return _owner_key(player_id)


async def _match_row(match_id: UUID) -> dict[str, object]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT state, current_position, total_questions, question_time_ms, deadline_at,
                   finished_at
            FROM quiz_online.matches
            WHERE id = %s
            """,
            (match_id,),
        )
        row = await cursor.fetchone()
        columns = [column.name for column in cursor.description or ()]
    assert row is not None
    return dict(zip(columns, row, strict=True))


async def _match_exists(match_id: UUID) -> bool:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT 1 FROM quiz_online.matches WHERE id = %s", (match_id,)
        )
        return await cursor.fetchone() is not None


async def _match_count(code: str) -> int:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT count(*)
            FROM quiz_online.matches match
            JOIN quiz_online.rooms room ON room.id = match.room_id
            WHERE room.code = %s
            """,
            (code,),
        )
        row = await cursor.fetchone()
    assert row is not None
    return int(row[0])


async def _answer_count(match_id: UUID) -> int:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT count(*) FROM quiz_online.match_answers WHERE match_id = %s", (match_id,)
        )
        row = await cursor.fetchone()
    assert row is not None
    return int(row[0])


async def _elapsed_ms(match_id: UUID, position: int, player_id: UUID) -> int:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT elapsed_ms FROM quiz_online.match_answers
            WHERE match_id = %s AND position = %s AND player_id = %s
            """,
            (match_id, position, player_id),
        )
        row = await cursor.fetchone()
    assert row is not None
    return int(row[0])


async def _shift_question_start(match_id: UUID, *, minutes: int) -> None:
    """마감 없는 문항이 minutes분 전에 열린 것처럼 옮긴다."""
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET question_started_at = question_started_at - %s * interval '1 minute'
            WHERE id = %s
            """,
            (minutes, match_id),
        )


async def _last_seen(code: str, player_id: UUID, *, minutes: int) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.room_members member
            SET last_seen_at = now() - %s * interval '1 minute'
            FROM quiz_online.rooms room
            WHERE member.room_id = room.id AND room.code = %s AND member.player_id = %s
            """,
            (minutes, code, player_id),
        )
