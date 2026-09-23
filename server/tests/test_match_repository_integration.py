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
        assert finished.question is None
        assert finished.own_answer is None
        assert len(finished.scores) == 2
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


def _token_hash(player_id: UUID) -> bytes:
    return hashlib.sha256(f"match-test-token:{player_id}".encode()).digest()


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
