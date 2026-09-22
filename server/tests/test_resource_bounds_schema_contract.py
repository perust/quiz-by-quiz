from __future__ import annotations

from pathlib import Path

MIGRATION = (
    Path(__file__).parents[1]
    / "migrations"
    / "009_bound_online_resource_lifetimes.sql"
)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_player_expiry_default_and_existing_rows_are_bounded_to_two_hours() -> None:
    sql = migration_sql()

    alter_default = "alter column expires_at set default (now() + interval '2 hours')"
    clamp = "set expires_at = least(expires_at, now() + interval '2 hours')"
    assert alter_default in sql
    assert clamp in sql
    assert "where expires_at > now() + interval '2 hours'" in sql
    assert sql.index(alter_default) < sql.index(clamp)


def test_cleanup_and_lobby_lookup_indexes_are_idempotently_declared() -> None:
    sql = migration_sql()

    expected_indexes = {
        "players_expires_at_idx": "quiz_online.players (expires_at)",
        "rooms_expires_at_idx": "quiz_online.rooms (expires_at)",
        "rooms_lobby_order_idx": (
            "quiz_online.rooms (updated_at desc, created_at desc, id)"
        ),
        "room_members_player_room_idx": (
            "quiz_online.room_members (player_id, room_id)"
        ),
    }
    for name, definition in expected_indexes.items():
        assert f"create index if not exists {name}" in sql
        assert definition in sql


def test_resource_bound_migration_is_forward_only_and_records_version_nine() -> None:
    sql = migration_sql()

    assert sql.startswith("begin;")
    assert sql.rstrip().endswith("commit;")
    assert "insert into quiz_online.schema_migrations (version)" in sql
    assert "values (9)" in sql
    assert "on conflict (version) do nothing" in sql
    assert "create index if not exists" in sql


def test_resource_bound_migration_does_not_broaden_runtime_capabilities() -> None:
    sql = migration_sql()

    for forbidden in (
        "grant ",
        "revoke ",
        "alter role",
        "create role",
        "create extension",
        "create table",
        "drop table",
        "truncate ",
        "delete from",
    ):
        assert forbidden not in sql
