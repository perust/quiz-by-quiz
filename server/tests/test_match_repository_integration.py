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

from app.domain import validate_player, validate_room
from app.postgres import PostgresRoomsRepository
from app.question_catalog import QuestionCatalog
from app.repository import MatchInProgress, MatchNotReady, MatchPositionMismatch

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


@pytest.mark.integration
def test_postgres_match_advances_and_finishes_after_the_last_reveal() -> None:
    asyncio.run(_exercise_match_lifecycle())


async def _exercise_match_lifecycle() -> None:
    assert DATABASE_URL is not None
    catalog = _test_catalog()
    repository = PostgresRoomsRepository(DATABASE_URL, question_catalog=catalog, max_pool_size=4)
    await repository.open()
    player_ids = [uuid4(), uuid4()]
    room_code: str | None = None

    try:
        for index, player_id in enumerate(player_ids):
            await repository.upsert_player(
                player_id,
                _token_hash(player_id),
                validate_player(f"검증{index}", f"character-{index}"),
            )

        room = await repository.create_room(
            player_ids[0],
            validate_room(
                name="매치 상태 검증",
                category_id="science",
                capacity=2,
                is_public=True,
                password=None,
                game_mode=True,
            ),
            None,
        )
        room_code = room.code
        await repository.join_room(player_ids[1], room.code)

        await repository.set_ready(player_ids[0], room.code, True)
        with pytest.raises(MatchNotReady):
            await repository.start_game(player_ids[0], room.code)
        await repository.set_ready(player_ids[1], room.code, True)

        setup = await repository.start_game(player_ids[0], room.code)
        assert setup.id
        # 로비는 진행 중인 방을 미리 «게임 중»으로 알린다 (U33)
        lobby = await repository.list_rooms(player_ids[1])
        assert {view.code: view.status for view in lobby}[room.code] == "playing"
        assert setup.category_id == "science"
        assert setup.total_questions == 10

        before_read = await repository.get_match(player_ids[0], room.code)
        assert before_read.match is not None
        assert before_read.advanced is False
        before = before_read.match
        assert before.state == "running"
        assert before.question is not None
        assert before.question.position == 1
        assert len(before.question.choices) == 4
        assert not hasattr(before.question, "answer_index")
        assert not hasattr(before.question, "explanation")

        first = await repository.submit_answer(
            player_ids[0], room.code, position=1, choice_index=0
        )
        repeat = await repository.submit_answer(
            player_ids[0], room.code, position=1, choice_index=0
        )
        assert first.answer == repeat.answer
        assert first.advanced is False

        second = await repository.submit_answer(
            player_ids[1], room.code, position=1, choice_index=1
        )
        assert second.advanced is True
        assert second.match.state == "revealing"
        assert second.match.current_position == 1
        assert second.match.question is not None
        assert second.match.question.position == 1
        assert second.match.own_answer == second.answer
        assert len(second.match.scores) == 2

        with pytest.raises(MatchPositionMismatch):
            await repository.submit_answer(player_ids[0], room.code, position=1, choice_index=0)
        with pytest.raises(MatchInProgress):
            await repository.set_ready(player_ids[0], room.code, False)

        await _expire_reveal(second.match.id)
        next_read = await repository.get_match(player_ids[0], room.code)
        assert next_read.match is not None
        assert next_read.advanced is True
        next_question = next_read.match
        assert next_question.state == "running"
        assert next_question.current_position == 2
        assert next_question.question is not None
        assert next_question.question.position == 2
        assert next_question.own_answer is None

        await _force_final_reveal(next_question.id)
        finished_read = await repository.get_match(player_ids[0], room.code)
        assert finished_read.match is not None
        assert finished_read.advanced is True
        finished = finished_read.match
        assert finished.state == "finished"
        assert finished.deadline_at is None
        lobby = await repository.list_rooms(player_ids[1])
        assert {view.code: view.status for view in lobby}[room.code] == "waiting"
        assert finished.question is None
        assert finished.own_answer is None
        assert len(finished.scores) == 2
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


@pytest.mark.integration
def test_postgres_reveal_scores_review_and_rematch_memory() -> None:
    asyncio.run(_exercise_reveal_review_and_rematch())


async def _exercise_reveal_review_and_rematch() -> None:
    assert DATABASE_URL is not None
    # science만 스무 문제다: 첫 판 열 문제를 뺀 나머지 열 문제로 둘째 판을 채울 수 있다
    catalog = _test_catalog(science_count=20)
    repository = PostgresRoomsRepository(DATABASE_URL, question_catalog=catalog, max_pool_size=4)
    await repository.open()
    player_ids = [uuid4(), uuid4()]
    room_code: str | None = None

    try:
        for index, player_id in enumerate(player_ids):
            await repository.upsert_player(
                player_id,
                _token_hash(player_id),
                validate_player(f"재대결{index}", f"character-{index}"),
            )
        room = await repository.create_room(
            player_ids[0],
            validate_room(
                name="재대결 검증",
                category_id="science",
                capacity=2,
                is_public=True,
                password=None,
                game_mode=True,
            ),
            None,
        )
        room_code = room.code
        await repository.join_room(player_ids[1], room.code)

        first_match = await _start_ready_match(repository, player_ids, room.code)
        running = (await repository.get_match(player_ids[0], room.code)).match
        assert running is not None and running.state == "running"
        # 아직 고르는 중에는 누구의 정오도 없다 (U30)
        assert {score.last_answer_correct for score in running.scores} == {None}
        assert running.review == ()

        await repository.submit_answer(player_ids[0], room.code, position=1, choice_index=0)
        second = await repository.submit_answer(
            player_ids[1], room.code, position=1, choice_index=1
        )
        assert second.match.state == "revealing"
        first_view = (await repository.get_match(player_ids[0], room.code)).match
        assert first_view is not None and first_view.own_answer is not None
        # 공개 중에는 참가자마다 방금 문항의 정오가 있고, 각자의 공개 결과와 같다
        expected = {
            player_ids[0]: first_view.own_answer.correct,
            player_ids[1]: second.answer.correct,
        }
        assert {
            score.player_id: score.last_answer_correct for score in second.match.scores
        } == expected
        assert second.match.review == ()

        await _force_final_reveal(first_match)
        finished = (await repository.get_match(player_ids[0], room.code)).match
        assert finished is not None and finished.state == "finished"
        assert {score.last_answer_correct for score in finished.scores} == {None}
        # 끝난 판에만 «문제 다시 보기»가 있다 (U38): 문항 순서대로, 정답은 catalog와 같다
        review = finished.review
        assert [item.position for item in review] == list(range(1, 11))
        for item in review:
            source = catalog.get(item.question_id)
            assert item.question == source.question
            assert item.explanation == source.explanation
            assert item.choices[item.answer_index] == source.choices[source.answer_index]
        assert review[0].choice_index == 0
        assert review[0].timed_out is False
        assert review[0].correct is first_view.own_answer.correct
        # 답이 없는 문항(강제로 건너뛴 2~10번)은 시간 초과로 보인다
        assert all(item.timed_out and item.choice_index is None for item in review[1:])
        other_review = (await repository.get_match(player_ids[1], room.code)).match
        assert other_review is not None
        assert other_review.review[0].choice_index == 1

        first_ids = await _match_question_ids(first_match)
        # 같은 방의 «한 판 더»는 방금 푼 문제를 되풀이하지 않는다 (N08)
        second_match = await _start_ready_match(repository, player_ids, room.code)
        second_ids = await _match_question_ids(second_match)
        assert len(second_ids) == 10
        assert second_ids.isdisjoint(first_ids)

        # 스무 문제를 다 봤으면 오래전에 본 것(첫 판)부터 다시 낸다
        await _force_final_reveal(second_match)
        assert (await repository.get_match(player_ids[0], room.code)).match is not None
        third_match = await _start_ready_match(repository, player_ids, room.code)
        assert await _match_question_ids(third_match) == first_ids
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _start_ready_match(
    repository: PostgresRoomsRepository,
    player_ids: list[UUID],
    code: str,
) -> UUID:
    await repository.set_ready(player_ids[1], code, True)
    setup = await repository.start_game(player_ids[0], code)
    return setup.id


async def _match_question_ids(match_id: UUID) -> set[str]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            "SELECT question_id FROM quiz_online.match_questions WHERE match_id = %s",
            (match_id,),
        )
        return {str(row[0]) for row in await cursor.fetchall()}


def _token_hash(player_id: UUID) -> bytes:
    return hashlib.sha256(f"match-test-token:{player_id}".encode()).digest()


def _test_catalog(*, science_count: int = 10) -> QuestionCatalog:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        for category in ("history", "science", "geography", "general", "art"):
            count = science_count if category == "science" else 10
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
                for number in range(count)
            ]
            (root / f"{category}.json").write_text(json.dumps(questions), encoding="utf-8")
        return QuestionCatalog.from_directory(root)


async def _expire_reveal(match_id: UUID) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET deadline_at = question_started_at
            WHERE id = %s
            """,
            (match_id,),
        )


async def _force_final_reveal(match_id: UUID) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET state = 'revealing',
                current_position = total_questions,
                deadline_at = question_started_at
            WHERE id = %s
            """,
            (match_id,),
        )


async def _cleanup(player_ids: list[UUID], room_code: str | None) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        if room_code:
            await connection.execute("DELETE FROM quiz_online.rooms WHERE code = %s", (room_code,))
        await connection.execute(
            "DELETE FROM quiz_online.players WHERE id = ANY(%s)",
            (player_ids,),
        )
