from __future__ import annotations

import inspect

from app.postgres import (
    _DELETE_EMPTY_ROOMS_SQL,
    _DELETE_EXPIRED_PLAYERS_SQL,
    _DELETE_EXPIRED_ROOMS_SQL,
    _DELETE_STALE_MEMBERS_SQL,
    _LOBBY_ROOM_LIMIT,
    _PLAYER_LIFETIME,
    _REVEAL_DURATION,
    _ROOM_ROWS_SQL,
    PostgresRoomsRepository,
)


def test_reveal_window_leaves_time_to_read_the_answer_and_explanation() -> None:
    # 공개 3초로는 해설을 다 읽기 전에 다음 문제로 넘어갔다. 소유자 결정으로 8초다.
    assert _REVEAL_DURATION == "8 seconds"
    # 공개로 넘기는 SQL은 한 자리다 — 마감 있는 판도 «제한 없음» 혼자 판(migration 013)도 그것을
    # 탄다
    reveal_source = inspect.getsource(PostgresRoomsRepository._reveal_locked_match)
    assert "SET state = 'revealing', deadline_at = now() + %s::interval" in reveal_source
    assert "(_REVEAL_DURATION, match_id)" in reveal_source
    advance_source = inspect.getsource(PostgresRoomsRepository._advance_locked_match)
    assert advance_source.count("await self._reveal_locked_match(connection, match_id)") == 2
    assert "SET state = 'revealing'" not in advance_source


def test_every_question_deadline_uses_the_matchs_own_question_time() -> None:
    # 방장이 방마다 20초·40초를 고른다. 고정 20초가 남은 자리가 있으면 40초 방의 어느 문항은
    # 20초에 닫히거나, 시간 초과·쓴 시간이 20초로 잘못 남는다.
    # 판을 여는 SQL은 «게임 시작»과 혼자 판(FR-7.13 3단계)이 함께 쓰는 `_start_locked_match`에 있다
    start = " ".join(
        (
            inspect.getsource(PostgresRoomsRepository.start_game)
            + inspect.getsource(PostgresRoomsRepository._start_locked_match)
        ).split()
    )
    assert "SELECT id, host_player_id, category_id, game_mode, question_time_ms" in start
    assert "question_time_ms, deadline_at, expires_at" in start
    assert "now() + %s::integer * interval '1 millisecond'" in start
    assert "question_time_ms, question_time_ms, _MATCH_LIFETIME" in start

    advance = " ".join(
        inspect.getsource(PostgresRoomsRepository._advance_locked_match).split()
    )
    assert "deadline_at = now() + question_time_ms * interval '1 millisecond'" in advance
    assert "true, match.question_time_ms" in advance

    submit = " ".join(inspect.getsource(PostgresRoomsRepository.submit_answer).split())
    # «제한 없음» 혼자 판(문항 시간 NULL)은 자르지 않고 재되 판의 수명(migration 013의 상한) 안이다
    assert "SELECT LEAST( COALESCE(question_time_ms, %s), GREATEST(" in submit
    assert '(UNTIMED_ELAPSED_MS_CAP, match["id"])' in submit

    for name in ("start_game", "_start_locked_match", "_advance_locked_match", "submit_answer"):
        source = inspect.getsource(getattr(PostgresRoomsRepository, name))
        assert "20000" not in source, name
        assert "20 seconds" not in source, name


def test_room_reads_and_writes_carry_the_hosts_question_time() -> None:
    assert "r.question_time_ms," in _ROOM_ROWS_SQL
    create = " ".join(inspect.getsource(PostgresRoomsRepository.create_room).split())
    assert "question_time_ms, is_public, password_hash, host_player_id, expires_at" in create
    assert "spec.question_time_ms," in create
    update = " ".join(inspect.getsource(PostgresRoomsRepository.update_room).split())
    assert 'patch.get("question_time_ms", room["question_time_ms"])' in update
    assert "question_time_ms = %s" in update
    # 판이 도는 동안에는 문항 시간도 바꾸지 않는다 — 판정이 쓰기보다 먼저다
    assert update.index("raise MatchInProgress") < update.index("UPDATE quiz_online.rooms")


def test_optional_room_code_is_explicitly_typed_for_postgres() -> None:
    assert "%(code)s::char(6) IS NULL" in _ROOM_ROWS_SQL
    assert "candidate.code = %(code)s::char(6)" in _ROOM_ROWS_SQL


def test_lobby_limits_parent_rooms_before_expanding_complete_memberships() -> None:
    normalized = " ".join(_ROOM_ROWS_SQL.lower().split())

    assert _LOBBY_ROOM_LIMIT == 100
    assert normalized.startswith("with selected_rooms as materialized")
    assert "limit %(room_limit)s" in normalized
    assert normalized.index("limit %(room_limit)s") < normalized.index(
        "left join quiz_online.room_members member"
    )
    assert "order by joined desc" in normalized
    assert "candidate.updated_at desc" in normalized
    assert "candidate.created_at desc" in normalized
    assert "candidate.id asc" in normalized


def test_player_lifetime_is_two_hours_and_lobby_read_does_not_trigger_cleanup() -> None:
    assert _PLAYER_LIFETIME == "2 hours"
    list_rooms_source = inspect.getsource(PostgresRoomsRepository.list_rooms)
    assert "cleanup_expired_resources" not in list_rooms_source
    assert "_cleanup" not in list_rooms_source


def test_resource_cleanup_preserves_rooms_and_members_with_active_matches() -> None:
    stale_members = " ".join(_DELETE_STALE_MEMBERS_SQL.lower().split())
    assert stale_members.startswith("with cleanup_rooms as materialized")
    assert "for update of room skip locked" in stale_members
    assert stale_members.index("for update of room skip locked") < stale_members.index(
        "delete from quiz_online.room_members member"
    )

    for statement in (
        _DELETE_EXPIRED_ROOMS_SQL,
        _DELETE_STALE_MEMBERS_SQL,
        _DELETE_EMPTY_ROOMS_SQL,
    ):
        normalized = " ".join(statement.lower().split())
        assert "quiz_online.matches" in normalized
        assert "state in ('running', 'revealing')" in normalized
        assert "not exists" in normalized


def test_expired_player_cleanup_preserves_room_and_unexpired_match_references() -> None:
    normalized = " ".join(_DELETE_EXPIRED_PLAYERS_SQL.lower().split())

    assert "player.expires_at <= now()" in normalized
    assert "quiz_online.room_members" in normalized
    assert "quiz_online.match_players" in normalized
    assert "match.expires_at > now()" in normalized
    assert normalized.count("not exists") >= 2

def test_room_members_put_the_current_host_first_for_the_waiting_room() -> None:
    # 화면은 첫 자리를 방장으로 그린다. 끊긴 방장을 접속 중인 사람에게 넘기면 가장 먼저
    # 들어온 사람이 방장이 아닐 수 있으므로 들어온 순서보다 방장 여부가 먼저다.
    normalized = " ".join(_ROOM_ROWS_SQL.lower().split())

    host_first = "(member.player_id = r.host_player_id) desc nulls last"
    assert host_first in normalized
    assert normalized.index(host_first) < normalized.index("member.joined_at asc")


def test_start_counts_the_host_request_as_ready_and_skips_absent_members() -> None:
    # 준비 판정은 «게임 시작»과 혼자 판이 함께 쓰는 `_start_locked_match`에 있다 (FR-7.13 3단계)
    source = inspect.getsource(PostgresRoomsRepository.start_game) + inspect.getsource(
        PostgresRoomsRepository._start_locked_match
    )

    assert "absent_player_ids" in source
    assert 'member["player_id"] != actor_id' in source
    assert 'member["player_id"] not in absent_player_ids' in source
