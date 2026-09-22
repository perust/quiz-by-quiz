from __future__ import annotations

from pathlib import Path

MIGRATION = (
    Path(__file__).parents[1]
    / "migrations"
    / "007_allow_finished_match_without_deadline.sql"
)


def test_final_reveal_expiry_allows_a_finished_match_to_clear_its_deadline() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "alter table quiz_online.matches" in sql
    assert "alter column deadline_at drop not null" in sql
