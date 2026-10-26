from __future__ import annotations

import asyncio
import inspect
from collections.abc import Mapping, Sequence
from typing import Any, cast
from uuid import UUID

from app.postgres import PostgresRoomsRepository

# 매치 진행의 «모두 답했다» 판정 (U32). 한 사람이 매치 중에 끊겨 돌아오지 않으면 남은
# 사람이 문제마다 마감까지 기다렸다. 유예를 넘겨 끊긴 참가자는 그 분모에서 빼고, 그
# 사람의 빈 답은 시간 초과로 채우며, 다시 붙으면 다음 판정부터 다시 센다.
# 실제 SQL은 test_match_repository_integration.py가 PostgreSQL에서 확인한다.

MATCH_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
HOST = UUID("11111111-1111-4111-8111-111111111111")
GUEST = UUID("22222222-2222-4222-8222-222222222222")
GONE = UUID("33333333-3333-4333-8333-333333333333")


class FakeCursor:
    def __init__(self, rows: Sequence[Mapping[str, Any]]) -> None:
        self._rows = list(rows)

    async def fetchone(self) -> Mapping[str, Any] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[Mapping[str, Any]]:
        return list(self._rows)


class ProgressConnection:
    """이번 문항의 답 여부만 돌려주는 가짜 연결. 실행한 문장을 남긴다."""

    def __init__(self, *, expired: bool, answered: Mapping[UUID, bool]) -> None:
        self.expired = expired
        self.answered = dict(answered)
        self.statements: list[str] = []

    async def execute(self, query: str, params: object = ()) -> FakeCursor:
        normalized = " ".join(query.split())
        self.statements.append(normalized)
        if "answer.player_id IS NOT NULL AS answered" in normalized:
            return FakeCursor([
                {"expired": self.expired, "player_id": player_id, "answered": answered}
                for player_id, answered in self.answered.items()
            ])
        if normalized.startswith("INSERT INTO quiz_online.match_answers"):
            return FakeCursor([])
        if "SET state = 'revealing'" in normalized:
            return FakeCursor([{"id": MATCH_ID}])
        raise AssertionError(f"unexpected statement: {normalized}")

    @property
    def filled_timeouts(self) -> bool:
        return any(
            statement.startswith("INSERT INTO quiz_online.match_answers")
            for statement in self.statements
        )

    @property
    def revealed(self) -> bool:
        return any("SET state = 'revealing'" in statement for statement in self.statements)


def _advance(
    connection: ProgressConnection,
    absent: frozenset[UUID] = frozenset(),
) -> bool:
    repository = PostgresRoomsRepository("postgresql://unused.invalid/quiz")
    match = {
        "id": MATCH_ID,
        "state": "running",
        "current_position": 3,
        "total_questions": 10,
    }
    return asyncio.run(
        repository._advance_locked_match(  # noqa: SLF001 - 진행 규칙만 떼어 본다
            cast(Any, connection),
            match,
            absent_player_ids=absent,
        )
    )


def test_a_present_player_who_has_not_answered_still_holds_the_question() -> None:
    connection = ProgressConnection(
        expired=False,
        answered={HOST: True, GUEST: False, GONE: False},
    )

    assert _advance(connection, frozenset({GONE})) is False
    assert not connection.revealed
    assert not connection.filled_timeouts


def test_without_presence_everyone_in_the_match_must_answer_first() -> None:
    connection = ProgressConnection(
        expired=False,
        answered={HOST: True, GUEST: True, GONE: False},
    )

    assert _advance(connection) is False
    assert not connection.revealed


def test_long_absent_players_leave_the_denominator_and_time_out() -> None:
    connection = ProgressConnection(
        expired=False,
        answered={HOST: True, GUEST: True, GONE: False},
    )

    assert _advance(connection, frozenset({GONE})) is True
    # 끊긴 사람의 빈 답은 시간 초과로 채운 뒤 공개로 넘어간다
    assert connection.filled_timeouts
    assert connection.revealed
    fill = next(
        statement
        for statement in connection.statements
        if statement.startswith("INSERT INTO quiz_online.match_answers")
    )
    assert "SELECT %s, %s, player.player_id, NULL, false, true, 20000" in fill
    assert connection.statements.index(fill) < next(
        index
        for index, statement in enumerate(connection.statements)
        if "SET state = 'revealing'" in statement
    )


def test_an_absent_players_own_answer_does_not_stand_in_for_a_present_player() -> None:
    # 소켓 없이 REST로 답한 사람은 «끊긴 사람»으로 셀 수 있다. 그 답이 남은 사람의 답을
    # 대신하면 아직 고르는 사람이 있는데 문항이 넘어간다.
    connection = ProgressConnection(
        expired=False,
        answered={HOST: True, GUEST: False, GONE: True},
    )

    assert _advance(connection, frozenset({GONE})) is False


def test_when_everyone_in_the_match_is_absent_the_deadline_decides() -> None:
    connection = ProgressConnection(
        expired=False,
        answered={HOST: False, GUEST: False},
    )

    assert _advance(connection, frozenset({HOST, GUEST})) is False
    assert not connection.revealed


def test_the_deadline_still_times_out_every_missing_answer() -> None:
    connection = ProgressConnection(
        expired=True,
        answered={HOST: True, GUEST: False, GONE: False},
    )

    assert _advance(connection) is True
    assert connection.filled_timeouts
    assert connection.revealed


def test_every_progress_entry_point_carries_the_absent_players() -> None:
    for name in ("get_match", "submit_answer", "advance_past_absent_players"):
        source = inspect.getsource(getattr(PostgresRoomsRepository, name))
        assert "absent_player_ids=absent_player_ids" in source, name
    # 마감 sweep은 끊김과 무관하다 — 마감이 지나면 모두 시간 초과다
    expiry = inspect.getsource(PostgresRoomsRepository.advance_expired_matches)
    assert "absent_player_ids" not in expiry
    presence = inspect.getsource(PostgresRoomsRepository.advance_past_absent_players)
    assert "match.state = 'running'" in presence
    assert "FOR UPDATE OF match" in presence
