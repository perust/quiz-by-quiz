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
from app.repository import (
    MatchInProgress,
    MatchNotReady,
    MemberConnected,
    NotHost,
    NotMember,
    PlayerView,
    RoomNotFound,
)

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


@pytest.mark.integration
def test_postgres_sweep_hands_an_absent_host_to_whoever_joins_later() -> None:
    asyncio.run(_exercise_absent_host_sweep())


@pytest.mark.integration
def test_postgres_leaving_host_prefers_a_connected_successor() -> None:
    asyncio.run(_exercise_leave_prefers_connected())


@pytest.mark.integration
def test_postgres_members_left_out_of_a_match_can_leave_and_ready_up() -> None:
    asyncio.run(_exercise_left_out_member())


@pytest.mark.integration
def test_postgres_host_removes_only_long_absent_members_outside_the_match() -> None:
    asyncio.run(_exercise_remove_absent_member())


async def _exercise_remove_absent_member() -> None:
    """U24: 방장의 «내보내기»는 유예를 넘겨 끊긴 사람만, 도는 판의 참가자는 판이 끝난 뒤에 뺀다."""
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id, guest_id, ghost_id, stranger_id = uuid4(), uuid4(), uuid4(), uuid4()
    player_ids = [host_id, guest_id, ghost_id, stranger_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("내보내기 검증"), None)
        room_code = room.code
        await repository.join_room(guest_id, room.code)
        await repository.join_room(ghost_id, room.code)
        absent = frozenset({ghost_id})

        with pytest.raises(RoomNotFound):
            await repository.remove_member(host_id, "ZZZZZZ", ghost_id, absent_player_ids=absent)
        # 방장만 내보낸다.
        with pytest.raises(NotHost):
            await repository.remove_member(guest_id, room.code, ghost_id, absent_player_ids=absent)
        # 접속 중인 사람과 방장 자신은 내보내지 않는다. 방장이 끊긴 사람으로 세어져 있어도 그렇다.
        with pytest.raises(MemberConnected):
            await repository.remove_member(host_id, room.code, guest_id, absent_player_ids=absent)
        with pytest.raises(MemberConnected):
            await repository.remove_member(
                host_id, room.code, host_id, absent_player_ids=frozenset({host_id})
            )
        with pytest.raises(NotMember):
            await repository.remove_member(
                host_id, room.code, stranger_id, absent_player_ids=frozenset({stranger_id})
            )

        # 판이 도는 동안: 판에 자리가 있는 사람은 끊겨도 판이 끝난 뒤에 뺀다.
        await repository.set_ready(guest_id, room.code, True)
        setup = await repository.start_game(host_id, room.code, absent_player_ids=absent)
        assert await _match_player_ids(setup.id) == {host_id, guest_id}
        with pytest.raises(MatchInProgress):
            await repository.remove_member(
                host_id, room.code, guest_id, absent_player_ids=frozenset({guest_id, ghost_id})
            )

        # 판에서 빠진 끊긴 사람은 판이 도는 동안에도 뺀다.
        after = await repository.remove_member(
            host_id, room.code, ghost_id, absent_player_ids=absent
        )
        assert [player.id for player in after.players] == [host_id, guest_id]
        assert after.is_mine is True
        assert not await repository.is_member(ghost_id, room.code)
        assert await repository.get_room(ghost_id, room.code) is None
        assert await _match_player_ids(setup.id) == {host_id, guest_id}

        # 차단이 아니다. 판이 끝나면 같은 코드로 다시 들어온다.
        await _reveal_last_question(setup.id)
        await repository.advance_expired_matches()
        rejoined = await repository.join_room(ghost_id, room.code)
        assert [player.id for player in rejoined.players] == [host_id, guest_id, ghost_id]
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _exercise_absent_host_sweep() -> None:
    """server-1: 넘길 사람이 없던 방에 나중에 들어온 사람도 끊긴 방장을 넘겨받는다."""
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=4)
    await repository.open()
    host_id, late_id, absent_id = uuid4(), uuid4(), uuid4()
    player_ids = [host_id, late_id, absent_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("늦은 승계 검증"), None)
        room_code = room.code
        gone = await repository.create_room(absent_id, _room_spec("사라질 방"), None)
        assert await repository.leave_room(absent_id, gone.code) is None

        nothing = await repository.transfer_absent_hosts({})
        assert nothing.transferred == frozenset()
        assert dict(nothing.members) == {}
        # 방장 혼자였다. 넘길 사람이 없고, 사라진 방은 참가자 목록에 나오지 않는다.
        lonely = await repository.transfer_absent_hosts(
            {room.code: frozenset({host_id}), gone.code: frozenset({absent_id})}
        )
        assert lonely.transferred == frozenset()
        assert dict(lonely.members) == {room.code: frozenset({host_id})}

        # 다른 끊긴 사람만 들어왔다. 여전히 넘기지 않는다.
        await repository.join_room(absent_id, room.code)
        still = await repository.transfer_absent_hosts(
            {room.code: frozenset({host_id, absent_id})}
        )
        assert still.transferred == frozenset()
        assert dict(still.members) == {room.code: frozenset({host_id, absent_id})}

        # 끊긴 사람의 집합은 그대로인 채 접속 중인 사람이 나중에 들어왔다.
        await repository.join_room(late_id, room.code)
        handed = await repository.transfer_absent_hosts(
            {room.code: frozenset({host_id, absent_id})}
        )
        assert handed.transferred == frozenset({room.code})
        assert dict(handed.members) == {room.code: frozenset(player_ids)}
        successor = await repository.get_room(late_id, room.code)
        assert successor is not None and successor.is_mine is True
        assert successor.players[0].id == late_id

        # 방장이 접속 중이면 몇 번을 다시 봐도 그대로다.
        again = await repository.transfer_absent_hosts(
            {room.code: frozenset({host_id, absent_id})}
        )
        assert again.transferred == frozenset()
        reread = await repository.get_room(late_id, room.code)
        assert reread is not None and reread.is_mine is True
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _exercise_leave_prefers_connected() -> None:
    """server-2: 나가는 방장의 자리는 끊긴 사람보다 접속 중인 사람이 먼저 받는다."""
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(DATABASE_URL, max_pool_size=4)
    await repository.open()
    host_id, early_absent_id, connected_id, late_absent_id = uuid4(), uuid4(), uuid4(), uuid4()
    player_ids = [host_id, early_absent_id, connected_id, late_absent_id]
    absent = frozenset({early_absent_id, late_absent_id})
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("나가기 승계 검증"), None)
        room_code = room.code
        for player_id in player_ids[1:]:
            await repository.join_room(player_id, room.code)

        after_host = await repository.leave_room(host_id, room.code, absent_player_ids=absent)
        assert after_host is not None
        assert after_host.players[0].id == connected_id
        connected_view = await repository.get_room(connected_id, room.code)
        assert connected_view is not None and connected_view.is_mine is True

        # 남은 사람이 모두 끊겼으면 가장 먼저 들어온 사람이 받는다. 다시 붙으면 sweep이 넘긴다.
        after_connected = await repository.leave_room(
            connected_id,
            room.code,
            absent_player_ids=absent,
        )
        assert after_connected is not None
        assert [player.id for player in after_connected.players] == [
            early_absent_id,
            late_absent_id,
        ]
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


async def _exercise_left_out_member() -> None:
    """server-3: 끊겨서 판에서 빠진 멤버는 판이 도는 동안에도 나가고 다음 판을 준비한다."""
    assert DATABASE_URL is not None
    repository = PostgresRoomsRepository(
        DATABASE_URL,
        question_catalog=_test_catalog(),
        max_pool_size=4,
    )
    await repository.open()
    host_id, guest_id, left_out_id, leaver_id = uuid4(), uuid4(), uuid4(), uuid4()
    player_ids = [host_id, guest_id, left_out_id, leaver_id]
    room_code: str | None = None

    try:
        await _register(repository, player_ids)
        room = await repository.create_room(host_id, _room_spec("판 밖 멤버 검증"), None)
        room_code = room.code
        for player_id in player_ids[1:]:
            await repository.join_room(player_id, room.code)
        await repository.set_ready(guest_id, room.code, True)
        setup = await repository.start_game(
            host_id,
            room.code,
            absent_player_ids=frozenset({left_out_id, leaver_id}),
        )
        assert await _match_player_ids(setup.id) == {host_id, guest_id}

        # 방 snapshot이 묻는 사람에게 그 판이 제 것인지 알린다.
        left_out_view = await repository.get_room(left_out_id, room.code)
        guest_view = await repository.get_room(guest_id, room.code)
        assert left_out_view is not None and guest_view is not None
        assert (left_out_view.status, left_out_view.in_match) == ("playing", False)
        assert (guest_view.status, guest_view.in_match) == ("playing", True)

        # 판의 참가자는 여전히 판이 끝날 때까지 기다린다.
        with pytest.raises(MatchInProgress):
            await repository.leave_room(guest_id, room.code)
        with pytest.raises(MatchInProgress):
            await repository.set_ready(guest_id, room.code, True)

        # 판에서 빠진 멤버는 다음 판을 미리 준비하고, 되돌리고, 나갈 수 있다.
        readied = await repository.set_ready(left_out_id, room.code, True)
        assert _ready_of(readied.players, left_out_id) is True
        unreadied = await repository.set_ready(left_out_id, room.code, False)
        assert _ready_of(unreadied.players, left_out_id) is False
        await repository.set_ready(left_out_id, room.code, True)
        after_leave = await repository.leave_room(leaver_id, room.code)
        assert after_leave is not None
        assert after_leave.status == "playing"
        assert not await repository.is_member(leaver_id, room.code)
        assert await _match_player_ids(setup.id) == {host_id, guest_id}

        # 마지막 공개가 끝나면 마감 sweep이 판이 닫혔다고 알린다 (방이 다시 기다린다).
        await _reveal_last_question(setup.id)
        advances = [
            advance
            for advance in await repository.advance_expired_matches()
            if advance.code == room.code
        ]
        assert [advance.finished for advance in advances] == [True]
        finished_view = await repository.get_room(left_out_id, room.code)
        assert finished_view is not None
        assert (finished_view.status, finished_view.in_match) == ("waiting", False)
        # 판 동안 해 둔 준비는 다음 판에 그대로 센다.
        assert _ready_of(finished_view.players, left_out_id) is True
    finally:
        await repository.close()
        await _cleanup(player_ids, room_code)


def _ready_of(players: tuple[PlayerView, ...], player_id: UUID) -> bool:
    return next(player.is_ready for player in players if player.id == player_id)


async def _reveal_last_question(match_id: UUID) -> None:
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
