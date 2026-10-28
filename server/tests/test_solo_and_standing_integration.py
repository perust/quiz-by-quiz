from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection

from app.domain import ValidatedRoom, validate_player, validate_room
from app.main import StandingAnswers, _match_payload, _room_payload
from app.postgres import PostgresRoomsRepository
from app.question_catalog import QuestionCatalog
from app.repository import MatchNotReady

# 혼자 여는 온라인 방과 «시간이 끝나면 발밑 칸이 답»(U13)을 실제 PostgreSQL에서 확인한다.
# 초안은 API 메모리(StandingAnswers)에 있고, 마감이 빈 답을 채울 때 잠근 판에서 다시 본다.

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


@pytest.mark.integration
def test_postgres_host_alone_plays_a_whole_match_and_a_rematch() -> None:
    asyncio.run(_exercise_solo_match())


@pytest.mark.integration
def test_postgres_deadline_records_standing_answers_and_times_out_the_rest() -> None:
    asyncio.run(_exercise_standing_answers_at_the_deadline())


@pytest.mark.integration
def test_postgres_standing_answers_never_open_the_reveal_early() -> None:
    asyncio.run(_exercise_standing_answers_do_not_count_as_answered())


@pytest.mark.integration
def test_postgres_expiry_sweep_uses_standing_answers_and_reports_the_closed_question() -> None:
    asyncio.run(_exercise_sweep_with_standing_answers())


async def _exercise_solo_match() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id = uuid4()
    player_ids = [host_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("혼자 하는 방"), None)
        room_code = room.code
        # 방 snapshot이 «방장 혼자서도 연다»를 싣는다. 이 필드가 없는 이전 API는 둘부터였다
        assert _room_payload(room)["minPlayers"] == 1

        # 준비를 누르지 않아도 방장의 시작 요청이 곧 준비이고, 세는 사람은 방장 하나로 충분하다
        setup = await repository.start_game(host_id, room.code)
        assert setup.total_questions == 10
        assert await _match_player_ids(setup.id) == {host_id}
        listed = {view.code: view.status for view in await repository.list_rooms(host_id)}
        assert listed[room.code] == "playing"

        standing = StandingAnswers()
        for position in range(1, setup.total_questions + 1):
            read = await repository.get_match(host_id, room.code, standing_answers=standing)
            assert read.match is not None
            assert read.match.state == "running"
            assert read.match.current_position == position
            payload = _match_payload(read.match)
            assert payload["standingAnswers"] is True
            if position % 2 == 1:
                # 직접 낸 답: 혼자라 «모두 답했다»가 곧바로 서서 공개로 넘어간다
                answer = await _answer_index(setup.id, position)
                submitted = await repository.submit_answer(
                    host_id,
                    room.code,
                    position=position,
                    choice_index=answer,
                    standing_answers=standing,
                )
                assert submitted.advanced is True
                assert submitted.match.state == "revealing"
                assert submitted.match.own_answer is not None
                assert submitted.match.own_answer.correct is True
            else:
                # 발밑 칸: 마감까지 기다렸다가 서 있던 칸이 답이 된다
                wrong = (await _answer_index(setup.id, position) + 1) % 4
                standing.record(
                    room.code,
                    host_id,
                    match_id=setup.id,
                    position=position,
                    choice_index=wrong,
                )
                early = await repository.get_match(host_id, room.code, standing_answers=standing)
                assert early.advanced is False, "초안은 «모두 답했다»가 아니다"
                await _close_question_now(setup.id)
                closed = await repository.get_match(host_id, room.code, standing_answers=standing)
                assert closed.advanced is True
                assert closed.match is not None and closed.match.state == "revealing"
                assert closed.match.own_answer is not None
                assert closed.match.own_answer.choice_index == wrong
                assert closed.match.own_answer.correct is False
                assert closed.match.own_answer.timed_out is False
            scores = (await repository.get_match(host_id, room.code)).match
            assert scores is not None
            assert [score.player_id for score in scores.scores] == [host_id]
            await _expire_reveal(setup.id)

        finished_read = await repository.get_match(host_id, room.code)
        assert finished_read.match is not None
        finished = finished_read.match
        assert finished.state == "finished"
        assert len(finished.scores) == 1
        # 홀수 문항 다섯은 맞히고, 짝수 문항 다섯은 발밑 칸(오답)이었다 — 시간 초과가 아니다
        assert finished.scores[0].score == 50
        assert finished.scores[0].correct_count == 5
        assert finished.scores[0].answered_count == 10
        assert [item.timed_out for item in finished.review] == [False] * 10
        assert [item.correct for item in finished.review] == [True, False] * 5
        listed = {view.code: view.status for view in await repository.list_rooms(host_id)}
        assert listed[room.code] == "waiting"

        # 한 판 더: 같은 방에서 혼자 다시 연다
        rematch = await repository.start_game(host_id, room.code)
        assert rematch.id != setup.id
        assert await _match_player_ids(rematch.id) == {host_id}
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _exercise_standing_answers_at_the_deadline() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id, standing_id, idle_id, late_id, stale_id, outsider_id = (uuid4() for _ in range(6))
    player_ids = [host_id, standing_id, idle_id, late_id, stale_id, outsider_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("발밑 칸 검증", capacity=6), None)
        room_code = room.code
        for player_id in (standing_id, idle_id, late_id, stale_id, outsider_id):
            await repository.join_room(player_id, room.code)
            await repository.set_ready(player_id, room.code, True)
        # 시작할 때 끊겨 있던 멤버는 판에 자리가 없다(U24). 그 사람의 초안은 쓰지 않는다
        setup = await repository.start_game(
            host_id, room.code, absent_player_ids=frozenset({outsider_id})
        )
        assert outsider_id not in await _match_player_ids(setup.id)
        answer = await _answer_index(setup.id, 1)

        late_clock = _FixedClock(datetime.now(UTC) + timedelta(hours=1))
        standing = StandingAnswers()
        late = StandingAnswers(wall_clock=late_clock)
        # 방장은 직접 낸 답이 있다. 초안보다 먼저 낸 답이 이긴다
        standing.record(
            room.code, host_id, match_id=setup.id, position=1, choice_index=(answer + 1) % 4
        )
        await repository.submit_answer(host_id, room.code, position=1, choice_index=answer)
        standing.record(
            room.code, standing_id, match_id=setup.id, position=1, choice_index=answer
        )
        # 마감 뒤에 닿은 초안(시계가 마감보다 늦다), 지난 문항·다른 판의 초안은 세지 않는다
        late.record(room.code, late_id, match_id=setup.id, position=1, choice_index=answer)
        standing.record(room.code, stale_id, match_id=setup.id, position=2, choice_index=answer)
        standing.record(room.code, outsider_id, match_id=setup.id, position=1, choice_index=answer)
        other_match = uuid4()
        standing.record(room.code, idle_id, match_id=other_match, position=1, choice_index=answer)

        sources = _MergedSource(standing, late)
        await _close_question_now(setup.id)
        read = await repository.get_match(host_id, room.code, standing_answers=sources)
        assert read.advanced is True
        assert read.match is not None and read.match.state == "revealing"

        answers = await _answers(setup.id, 1)
        question_time_ms = await _question_time_ms(setup.id)
        assert answers[host_id] == (answer, True, False, answers[host_id][3])
        assert answers[host_id][3] < question_time_ms, "직접 낸 답은 쓴 시간이 그대로다"
        # 발밑 칸은 보통 답으로 채점되고, 시간 초과가 아니며, 문항 시간을 다 쓴 것으로 남는다
        assert answers[standing_id] == (answer, True, False, question_time_ms)
        for player_id in (idle_id, late_id, stale_id):
            assert answers[player_id] == (None, False, True, question_time_ms), player_id
        assert outsider_id not in answers

        scores = {score.player_id: score for score in read.match.scores}
        assert scores[standing_id].score == 10
        assert scores[standing_id].last_answer_correct is True
        assert scores[idle_id].score == 0
        guest_view = (await repository.get_match(standing_id, room.code)).match
        assert guest_view is not None and guest_view.own_answer is not None
        reveal = _match_payload(guest_view)["reveal"]
        assert isinstance(reveal, dict)
        # 화면의 공개는 고른 답과 같은 모양이다 — «내 답»이 그 칸이다
        assert reveal["choiceIndex"] == answer
        assert reveal["correct"] is True
        assert reveal["timedOut"] is False
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _exercise_standing_answers_do_not_count_as_answered() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id, guest_id = uuid4(), uuid4()
    player_ids = [host_id, guest_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("앞당김 검증"), None)
        room_code = room.code
        await repository.join_room(guest_id, room.code)
        # 연결된 참가자가 준비하지 않았으면 혼자 시작할 수 있게 된 뒤에도 기다린다
        with pytest.raises(MatchNotReady):
            await repository.start_game(host_id, room.code)
        await repository.set_ready(guest_id, room.code, True)
        setup = await repository.start_game(host_id, room.code)

        standing = StandingAnswers()
        standing.record(room.code, guest_id, match_id=setup.id, position=1, choice_index=2)
        first = await repository.submit_answer(
            host_id, room.code, position=1, choice_index=0, standing_answers=standing
        )
        # 손님은 칸 위에 서 있기만 했다. 앞당긴 공개는 직접 낸 답만 기다린다
        assert first.advanced is False
        assert first.match.state == "running"
        reread = await repository.get_match(host_id, room.code, standing_answers=standing)
        assert reread.advanced is False
        assert set(await _answers(setup.id, 1)) == {host_id}, "초안은 마감 전에는 답이 아니다"
        # 손님이 직접 내면 그 답이 초안을 이기고 곧바로 공개된다
        second = await repository.submit_answer(
            guest_id, room.code, position=1, choice_index=3, standing_answers=standing
        )
        assert second.advanced is True
        assert (await _answers(setup.id, 1))[guest_id][0] == 3
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _exercise_sweep_with_standing_answers() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id = uuid4()
    player_ids = [host_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("sweep 검증"), None)
        room_code = room.code
        setup = await repository.start_game(host_id, room.code)
        standing = StandingAnswers()
        standing.record(room.code, host_id, match_id=setup.id, position=1, choice_index=1)
        await _close_question_now(setup.id)

        advances = [
            advance
            for advance in await repository.advance_expired_matches(standing_answers=standing)
            if advance.code == room.code
        ]
        assert len(advances) == 1
        assert advances[0].match_id == setup.id
        assert advances[0].position == 1
        assert advances[0].finished is False
        assert (await _answers(setup.id, 1))[host_id][:3] == (
            1,
            await _is_answer(setup.id, 1, 1),
            False,
        )
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


class _FixedClock:
    def __init__(self, value: datetime) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value


class _MergedSource:
    """두 초안 저장소를 하나로 본다 — 하나는 마감 뒤 시계로 초안을 받는다."""

    def __init__(self, *sources: StandingAnswers) -> None:
        self.sources = sources

    def for_question(self, code: str, match_id: UUID, position: int) -> dict[UUID, object]:
        merged: dict[UUID, object] = {}
        for source in self.sources:
            merged.update(source.for_question(code, match_id, position))
        return merged


async def _register(repository: PostgresRoomsRepository, player_ids: list[UUID]) -> None:
    for index, player_id in enumerate(player_ids):
        await repository.upsert_player(
            player_id,
            _token_hash(player_id),
            validate_player(f"발밑{index}", f"character-{index}"),
        )


def _room_spec(name: str, *, capacity: int = 2) -> ValidatedRoom:
    return validate_room(
        name=name,
        category_id="science",
        capacity=capacity,
        is_public=True,
        password=None,
        game_mode=True,
    )


async def _match_player_ids(match_id: UUID) -> set[UUID]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT player_id FROM quiz_online.match_players WHERE match_id = %s",
            (match_id,),
        )
        return {row[0] for row in await cursor.fetchall()}


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


async def _is_answer(match_id: UUID, position: int, choice_index: int) -> bool:
    return await _answer_index(match_id, position) == choice_index


async def _question_time_ms(match_id: UUID) -> int:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT question_time_ms FROM quiz_online.matches WHERE id = %s",
            (match_id,),
        )
        row = await cursor.fetchone()
        assert row is not None
        return int(row[0])


async def _answers(
    match_id: UUID,
    position: int,
) -> dict[UUID, tuple[int | None, bool, bool, int]]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT player_id, choice_index, correct, timed_out, elapsed_ms
            FROM quiz_online.match_answers
            WHERE match_id = %s AND position = %s
            """,
            (match_id, position),
        )
        return {
            row[0]: (
                None if row[1] is None else int(row[1]),
                bool(row[2]),
                bool(row[3]),
                int(row[4]),
            )
            for row in await cursor.fetchall()
        }


async def _close_question_now(match_id: UUID) -> None:
    """마감을 지금으로 당긴다. 그 전에 받은 초안은 마감 안에 닿은 것이다."""
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
    return hashlib.sha256(f"standing-test-token:{player_id}".encode()).digest()


def _test_catalog() -> QuestionCatalog:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        for category in ("history", "science", "geography", "general", "art"):
            questions = [
                {
                    "id": f"online-{category}-{number:03d}",
                    "category": category,
                    "question": f"{category} standing test question {number}?",
                    "choices": ["one", "two", "three", "four"],
                    "answerIndex": number % 4,
                    "explanation": f"standing test explanation {number}",
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
