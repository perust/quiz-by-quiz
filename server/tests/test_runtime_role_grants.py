from __future__ import annotations

from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "004_runtime_role_grants.sql"
DATABASE_CONNECT_MIGRATION = (
    Path(__file__).parents[1] / "migrations" / "006_runtime_database_connect.sql"
)


def test_runtime_role_grants_cover_named_repository_tables_without_schema_ownership() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "grant usage on schema quiz_online to quiz_by_quiz_app" in sql
    for table in (
        "quiz_online.players",
        "quiz_online.rooms",
        "quiz_online.room_members",
        "quiz_online.matches",
        "quiz_online.match_players",
        "quiz_online.match_questions",
        "quiz_online.match_answers",
    ):
        assert table in sql
    assert "grant execute on function quiz_online.cleanup_expired_matches()" in sql
    assert "on table quiz_online.schema_migrations" not in sql
    assert "grant all" not in sql
    assert "alter role" not in sql


def test_runtime_role_gets_only_explicit_connect_on_the_current_database() -> None:
    sql = DATABASE_CONNECT_MIGRATION.read_text(encoding="utf-8").lower()

    assert "grant connect on database" in sql
    assert "current_database()" in sql
    assert "quiz_by_quiz_app" in sql
    assert "grant select on table quiz_online.schema_migrations" not in sql
    assert "grant all" not in sql
