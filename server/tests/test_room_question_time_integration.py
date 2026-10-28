"""방장이 고르는 온라인 문항 시간 (20초 기본 · 40초)을 실제 PostgreSQL에서 확인한다.

방 설정이 판에 옮겨 적히고, 첫 문항·다음 문항의 마감, 시간 초과 기록, 제출의 쓴 시간이 모두
그 판의 값을 쓰는지 본다. 고정 20초가 한 자리라도 남으면 40초 방의 어느 문항은 20초에 닫힌다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection, errors

from app.domain import validate_player, validate_room
from app.postgres import PostgresRoomsRepository
from app.question_catalog import QuestionCatalog
from app.repository import MatchInProgress, NotHost

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set"),
]


def test_host_question_time_drives_every_deadline_of_the_match() -> None:
    asyncio.run(_exercise_forty_second_room())


def test_rooms_default_to_20_seconds_and_reject_other_values_in_the_database() -> None:
    asyncio.run(_exercise_default_room())


async def _exercise_forty_second_room() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host, guest = uuid4(), uuid4()
    room_code: str | None = None
    try:
        await _register(repository, host, "시간방장")
        await _register(repository, guest, "시간손님")
        room = await repository.create_room(host, _room_spec(question_time_ms=40_000), None)
        room_code = room.code
        assert room.question_time_ms == 40_000
        joined = await repository.join_room(guest, room.code)
        # 모두에게 보인다 — 참가자도 같은 값을 읽는다
        assert joined.question_time_ms == 40_000
        lobby = {view.code: view for view in await repository.list_rooms(guest)}
        assert lobby[room.code].question_time_ms == 40_000

        # 방장만 바꾼다
        with pytest.raises(NotHost):
            await repository.update_room(guest, room.code, {"question_time_ms": 20_000})
        shorter = await repository.update_room(host, room.code, {"question_time_ms": 20_000})
        assert shorter.question_time_ms == 20_000
        # 다른 설정만 바꾸면 문항 시간은 그대로다
        unchanged = await repository.update_room(host, room.code, {"capacity": 4})
        assert (unchanged.capacity, unchanged.question_time_ms) == (4, 20_000)
        longer = await repository.update_room(host, room.code, {"question_time_ms": 40_000})
        assert longer.question_time_ms == 40_000

        await repository.set_ready(guest, room.code, True)
        setup = await repository.start_game(host, room.code)
        assert setup.question_time_ms == 40_000
        first = await _match_row(setup.id)
        assert first["question_time_ms"] == 40_000
        assert first["deadline_at"] - first["question_started_at"] == timedelta(seconds=40)

        running = (await repository.get_match(host, room.code)).match
        assert running is not None and running.state == "running"
        assert running.question_time_ms == 40_000

        # 판이 도는 동안에는 방장도 문항 시간을 바꾸지 못한다 — 이 판의 마감이 이미 쓰고 있다
        with pytest.raises(MatchInProgress):
            await repository.update_room(host, room.code, {"question_time_ms": 20_000})
        assert (await repository.get_room(host, room.code)).question_time_ms == 40_000

        # 30초에 낸 답의 쓴 시간이 20초로 잘리지 않는다
        await _shift_question_start(setup.id, seconds=30)
        submitted = await repository.submit_answer(
            host, room.code, position=1, choice_index=0
        )
        assert submitted.advanced is False
        host_elapsed = await _elapsed_ms(setup.id, 1, host)
        assert 29_000 <= host_elapsed <= 40_000

        # 마감이 지나면 답하지 않은 사람은 40초를 다 쓴 시간 초과로 남는다
        await _expire_question(setup.id)
        revealed = await repository.get_match(guest, room.code)
        assert revealed.advanced is True
        assert revealed.match is not None and revealed.match.state == "revealing"
        assert await _elapsed_ms(setup.id, 1, guest) == 40_000
        assert revealed.match.question_time_ms == 40_000

        # 다음 문항의 마감도 그 판의 40초다
        await _expire_question(setup.id)
        second = await repository.get_match(host, room.code)
        assert second.advanced is True
        assert second.match is not None
        assert (second.match.state, second.match.current_position) == ("running", 2)
        following = await _match_row(setup.id)
        assert following["deadline_at"] - following["question_started_at"] == timedelta(
            seconds=40
        )
    finally:
        await repository.close()
        await _cleanup([host, guest], room_code)


async def _exercise_default_room() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host, guest = uuid4(), uuid4()
    room_code: str | None = None
    try:
        await _register(repository, host, "기본방장")
        await _register(repository, guest, "기본손님")
        # 문항 시간을 보내지 않는 구버전 client의 방은 예전처럼 20초다
        room = await repository.create_room(host, _room_spec(), None)
        room_code = room.code
        assert room.question_time_ms == 20_000
        await repository.join_room(guest, room.code)
        await repository.set_ready(guest, room.code, True)
        setup = await repository.start_game(host, room.code)
        assert setup.question_time_ms == 20_000
        match = await _match_row(setup.id)
        assert match["deadline_at"] - match["question_started_at"] == timedelta(seconds=20)
        await _expire_question(setup.id)
        assert (await repository.get_match(host, room.code)).advanced is True
        assert await _elapsed_ms(setup.id, 1, guest) == 20_000

        # 화면을 거치지 않아도 DB가 20초·40초 밖의 값과 친구와 푸는 방의 제한 없음을 막는다. 제한
        # 없음(NULL)은 혼자 방과 그 판에만 있다 — CHECK는 NULL을 받고, 혼자 방이 아닌 방·판의 NULL은
        # COMMIT의 외래 키(rooms_untimed_solo_room_fkey·matches_untimed_solo_room_fkey, migration
        # 013)가, 도는 문항의 마감이 있는 판의 NULL은 matches_active_deadline_check가 막는다
        rejected = (errors.CheckViolation, errors.NotNullViolation, errors.ForeignKeyViolation)
        async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
            for value in (30_000, None):
                with pytest.raises(rejected):
                    await connection.execute(
                        "UPDATE quiz_online.rooms SET question_time_ms = %s WHERE code = %s",
                        (value, room.code),
                    )
                with pytest.raises(rejected):
                    await connection.execute(
                        "UPDATE quiz_online.matches SET question_time_ms = %s WHERE id = %s",
                        (value, setup.id),
                    )
            # 40초를 넘는 쓴 시간은 제한 없는 판의 답뿐이다(match_answers_long_elapsed_fkey), 판의
            # 수명(2시간)을 넘는 쓴 시간은 없다(match_answers_elapsed_ms_range_check)
            with pytest.raises(errors.ForeignKeyViolation):
                await connection.execute(
                    "UPDATE quiz_online.match_answers SET elapsed_ms = 40001 WHERE match_id = %s",
                    (setup.id,),
                )
            with pytest.raises(errors.CheckViolation):
                await connection.execute(
                    "UPDATE quiz_online.match_answers SET elapsed_ms = 7200001 "
                    "WHERE match_id = %s",
                    (setup.id,),
                )
    finally:
        await repository.close()
        await _cleanup([host, guest], room_code)


def _room_spec(**changes: Any) -> Any:
    return validate_room(
        name="문항 시간 검증",
        category_id="science",
        capacity=2,
        is_public=True,
        password=None,
        **changes,
    )


async def _register(repository: PostgresRoomsRepository, player_id: UUID, nickname: str) -> None:
    await repository.upsert_player(
        player_id,
        hashlib.sha256(f"question-time:{player_id}".encode()).digest(),
        validate_player(nickname, "slime-blue"),
    )


async def _match_row(match_id: UUID) -> dict[str, Any]:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT question_time_ms, question_started_at, deadline_at
            FROM quiz_online.matches
            WHERE id = %s
            """,
            (match_id,),
        )
        row = await cursor.fetchone()
    assert row is not None
    return {"question_time_ms": row[0], "question_started_at": row[1], "deadline_at": row[2]}


async def _elapsed_ms(match_id: UUID, position: int, player_id: UUID) -> int:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
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


async def _shift_question_start(match_id: UUID, *, seconds: int) -> None:
    """문항이 seconds초 전에 열린 것처럼 옮긴다. 마감은 그대로 미래에 둔다."""
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET question_started_at = now() - %s * interval '1 second'
            WHERE id = %s
            """,
            (seconds, match_id),
        )


async def _expire_question(match_id: UUID) -> None:
    """지금 phase(문항 또는 공개)의 마감이 이미 지난 것처럼 만든다."""
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            """
            UPDATE quiz_online.matches
            SET question_started_at = now() - interval '1 minute',
                deadline_at = now() - interval '1 minute'
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


def _test_catalog() -> QuestionCatalog:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        for category in ("history", "science", "geography", "general", "art"):
            questions = [
                {
                    "id": f"time-{category}-{number:03d}",
                    "category": category,
                    "question": f"{category} question time {number}?",
                    "choices": ["one", "two", "three", "four"],
                    "answerIndex": number % 4,
                    "explanation": f"question time explanation {number}",
                    "difficulty": "normal",
                    "tags": [],
                }
                for number in range(10)
            ]
            (root / f"{category}.json").write_text(json.dumps(questions), encoding="utf-8")
        return QuestionCatalog.from_directory(root)
