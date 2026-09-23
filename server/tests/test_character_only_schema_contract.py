from __future__ import annotations

from pathlib import Path

MIGRATION = (
    Path(__file__).parents[1]
    / "migrations"
    / "010_enforce_character_only_play.sql"
)


def test_character_only_migration_normalizes_before_enforcing_invariants() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "update quiz_online.rooms" in sql
    assert "set game_mode = true" in sql
    assert sql.index("update quiz_online.rooms") < sql.index("rooms_character_only_check")
    assert "update quiz_online.matches" in sql
    assert "matches_character_only_check" in sql

    for table in ("players", "room_members", "match_players"):
        update = f"update quiz_online.{table}"
        alter = f"alter table quiz_online.{table}"
        assert update in sql
        assert alter in sql
        assert sql.index(update) < sql.index(alter)

    assert sql.count("alter column character_id set not null") >= 3
    assert "values (10)" in sql


def test_character_only_migration_rejects_invalid_character_ids() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert sql.count("character_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'") >= 3
