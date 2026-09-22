from pathlib import Path

MIGRATION = (
    Path(__file__).parents[1]
    / "migrations"
    / "008_restore_match_lifecycle_integrity.sql"
)


def test_match_lifecycle_migration_requires_deadlines_for_active_phases() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "matches_active_deadline_check" in sql
    assert "state in ('running', 'revealing') and deadline_at is not null" in sql
    assert "state = 'finished' and deadline_at is null" in sql
    assert "matches_position_range_check" in sql
    assert "current_position between 1 and total_questions" in sql
    assert "values (8)" in sql


def test_lifecycle_migration_normalizes_legacy_finished_deadlines_before_enforcement() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    normalize = "update quiz_online.matches"
    constraint = "add constraint matches_active_deadline_check"
    assert normalize in sql
    assert "set deadline_at = null" in sql
    assert "where state = 'finished' and deadline_at is not null" in sql
    assert sql.index(normalize) < sql.index(constraint)


def test_lifecycle_migration_normalizes_legacy_zero_position_before_enforcement() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    normalize = "update quiz_online.matches\nset current_position = 1\nwhere current_position = 0"
    constraint = "add constraint matches_position_range_check"
    assert normalize in sql
    assert sql.index(normalize) < sql.index(constraint)
