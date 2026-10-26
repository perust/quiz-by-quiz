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

from app.domain import ValidatedRoom, validate_player, validate_room
from app.postgres import PostgresRoomsRepository
from app.question_catalog import QuestionCatalog
from app.repository import MatchNotReady

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


@pytest.mark.integration
def test_postgres_start_counts_the_host_as_ready_and_skips_absent_members() -> None:
    asyncio.run(_exercise_presence_start())


@pytest.mark.integration
def test_postgres_absent_host_moves_to_the_earliest_connected_member_first() -> None:
    asyncio.run(_exercise_absent_host_transfer())


@pytest.mark.integration
def test_postgres_match_does_not_wait_for_long_absent_players() -> None:
    asyncio.run(_exercise_absent_early_advance())


async def _exercise_absent_early_advance() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id, guest_id, gone_id = uuid4(), uuid4(), uuid4()
    player_ids = [host_id, guest_id, gone_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("조기 진행 검증"), None)
        room_code = room.code
        await repository.join_room(guest_id, room.code)
        await repository.join_room(gone_id, room.code)
        await repository.set_ready(guest_id, room.code, True)
        await repository.set_ready(gone_id, room.code, True)
        setup = await repository.start_game(host_id, room.code)
        assert await _match_player_ids(setup.id) == set(player_ids)
        gone = frozenset({gone_id})

        # 1번: 판 도중 끊긴 사람을 빼면 남은 둘이 답하는 순간 넘어간다 (U32)
        first = await repository.submit_answer(
            host_id, room.code, position=1, choice_index=0, absent_player_ids=gone
        )
        assert first.advanced is False
        second = await repository.submit_answer(
            guest_id, room.code, position=1, choice_index=1, absent_player_ids=gone
        )
        assert second.advanced is True
        assert second.match.state == "revealing"
        # 끊긴 사람의 빈 답은 마감 때와 같은 시간 초과로 채워진다
        assert {score.player_id: score.answered_count for score in second.match.scores} == {
            host_id: 1,
            guest_id: 1,
            gone_id: 1,
        }
        assert await _timed_out(setup.id, 1, gone_id) is True

        # 2번: 다시 붙었으면 다시 센다 — 그 사람이 답할 때까지 기다린다
        await _expire_deadline(setup.id)
        reread = await repository.get_match(host_id, room.code)
        assert reread.match is not None and reread.match.current_position == 2
        for player_id in (host_id, guest_id):
            waiting = await repository.submit_answer(
                player_id, room.code, position=2, choice_index=0
            )
            assert waiting.advanced is False
        returned = await repository.submit_answer(
            gone_id, room.code, position=2, choice_index=2
        )
        assert returned.advanced is True

        # 3번: 남은 사람이 다 답한 뒤에 누가 유예를 넘기면 presence sweep이 넘긴다
        await _expire_deadline(setup.id)
        third = await repository.get_match(host_id, room.code)
        assert third.match is not None and third.match.current_position == 3
        for player_id in (host_id, guest_id):
            pending = await repository.submit_answer(
                player_id, room.code, position=3, choice_index=0
            )
            assert pending.advanced is False
        assert await repository.advance_past_absent_players(room.code, frozenset()) is False
        # 판의 모두가 끊겼으면 앞당기지 않는다 — 마감이 정한다
        assert await repository.advance_past_absent_players(
            room.code, frozenset(player_ids)
        ) is False
        assert await repository.advance_past_absent_players(room.code, gone) is True
        assert await repository.advance_past_absent_players(room.code, gone) is False
        assert await _timed_out(setup.id, 3, gone_id) is True
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _expire_deadline(match_id: UUID) -> None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        await connection.execute(
            "UPDATE quiz_online.matches SET deadline_at = question_started_at WHERE id = %s",
            (match_id,),
        )


async def _timed_out(match_id: UUID, position: int, player_id: UUID) -> bool | None:
    assert DATABASE_URL is not None
    async with await AsyncConnection.connect(DATABASE_URL, autocommit=True) as connection:
        cursor = await connection.execute(
            """
            SELECT timed_out
            FROM quiz_online.match_answers
            WHERE match_id = %s AND position = %s AND player_id = %s
            """,
            (match_id, position, player_id),
        )
        row = await cursor.fetchone()
        return None if row is None else bool(row[0])


async def _exercise_presence_start() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id, guest_id, absent_id = uuid4(), uuid4(), uuid4()
    player_ids = [host_id, guest_id, absent_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("방장 준비 검증"), None)
        room_code = room.code
        await repository.join_room(guest_id, room.code)
        await repository.join_room(absent_id, room.code)

        # 끊긴 사람을 빼도 참가자가 아직 준비하지 않았으면 시작하지 않는다.
        with pytest.raises(MatchNotReady):
            await repository.start_game(
                host_id,
                room.code,
                absent_player_ids=frozenset({absent_id}),
            )
        await repository.set_ready(guest_id, room.code, True)
        # 끊긴 사람을 기다려야 하면 여전히 시작할 수 없다.
        with pytest.raises(MatchNotReady):
            await repository.start_game(host_id, room.code)

        # 방장은 «준비 완료»를 누르지 않았다. 시작 요청이 곧 방장의 준비다.
        setup = await repository.start_game(
            host_id,
            room.code,
            absent_player_ids=frozenset({absent_id}),
        )
        assert setup.total_questions == 10
        assert await _match_player_ids(setup.id) == {host_id, guest_id}

        # 판에서 빠졌어도 멤버십은 그대로라 끝나면 다시 같은 방에서 준비할 수 있다.
        assert await repository.is_member(absent_id, room.code)
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _exercise_absent_host_transfer() -> None:
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=4)
    await repository.open()
    host_id, early_absent_id, connected_id = uuid4(), uuid4(), uuid4()
    player_ids = [host_id, early_absent_id, connected_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("방장 승계 검증"), None)
        room_code = room.code
        await repository.join_room(early_absent_id, room.code)
        await repository.join_room(connected_id, room.code)

        assert not await repository.transfer_absent_host(room.code, frozenset())
        assert not await repository.transfer_absent_host(
            room.code,
            frozenset({early_absent_id}),
        )
        assert not await repository.transfer_absent_host(
            room.code,
            frozenset(player_ids),
        )

        transferred = await repository.transfer_absent_host(
            room.code,
            frozenset({host_id, early_absent_id}),
        )
        assert transferred is True

        successor_view = await repository.get_room(connected_id, room.code)
        assert successor_view is not None
        assert successor_view.is_mine is True
        # 화면은 첫 자리를 방장으로 그린다. 먼저 들어온 끊긴 사람보다 앞에 온다.
        assert [player.id for player in successor_view.players] == [
            connected_id,
            host_id,
            early_absent_id,
        ]
        old_host_view = await repository.get_room(host_id, room.code)
        assert old_host_view is not None
        assert old_host_view.is_mine is False
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _register(repository: PostgresRoomsRepository, player_ids: list[UUID]) -> None:
    for index, player_id in enumerate(player_ids):
        await repository.upsert_player(
            player_id,
            _token_hash(player_id),
            validate_player(f"접속{index}", f"character-{index}"),
        )


def _room_spec(name: str) -> ValidatedRoom:
    return validate_room(
        name=name,
        category_id="science",
        capacity=4,
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


def _token_hash(player_id: UUID) -> bytes:
    return hashlib.sha256(f"presence-test-token:{player_id}".encode()).digest()


def _test_catalog() -> QuestionCatalog:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        for category in ("history", "science", "geography", "general", "art"):
            questions = [
                {
                    "id": f"presence-{category}-{number:03d}",
                    "category": category,
                    "question": f"{category} presence test question {number}?",
                    "choices": ["one", "two", "three", "four"],
                    "answerIndex": number % 4,
                    "explanation": f"presence test explanation {number}",
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
