from __future__ import annotations

import inspect

from app.postgres import (
    _DELETE_EMPTY_ROOMS_SQL,
    _DELETE_EXPIRED_PLAYERS_SQL,
    _DELETE_EXPIRED_ROOMS_SQL,
    _DELETE_STALE_MEMBERS_SQL,
    _LOBBY_ROOM_LIMIT,
    _PLAYER_LIFETIME,
    _ROOM_ROWS_SQL,
    PostgresRoomsRepository,
)


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