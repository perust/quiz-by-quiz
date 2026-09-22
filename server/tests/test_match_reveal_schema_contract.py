from __future__ import annotations

from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "003_match_reveal_phase.sql"


def test_reveal_phase_keeps_a_single_active_match_and_preserves_finished_invariants() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "drop constraint if exists matches_state_check" in sql
    assert "state in ('running', 'revealing', 'finished', 'abandoned')" in sql
    assert "drop constraint if exists matches_check" in sql
    assert "state in ('running', 'revealing') and finished_at is null" in sql
    assert "drop index if exists quiz_online.one_running_match_per_room_idx" in sql
    assert "create unique index if not exists one_active_match_per_room_idx" in sql
    assert "where state in ('running', 'revealing')" in sql
    assert "values (3)" in sql