from __future__ import annotations

from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "005_fix_match_reveal_lifecycle.sql"


def test_reveal_lifecycle_repair_drops_only_the_legacy_state_finished_check() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "from pg_constraint" in sql
    assert "conrelid = 'quiz_online.matches'::regclass" in sql
    assert "pg_get_constraintdef" in sql
    assert "finished_at" in sql
    assert "drop constraint" in sql
    assert "add constraint matches_lifecycle_check" in sql
    assert "state in ('running', 'revealing')" in sql
    assert "deadline_at" not in sql
