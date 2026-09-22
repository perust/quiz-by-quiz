from __future__ import annotations

from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "001_rooms.sql"


def test_room_schema_freezes_security_and_capacity_invariants() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "octet_length(token_hash) = 32" in sql
    assert "capacity in (2, 4, 6, 8, 10, 12)" in sql
    assert "is_public and password_hash is null" in sql
    assert "not is_public and password_hash is not null" in sql
    assert "primary key (room_id, player_id)" in sql
    assert "on delete cascade" in sql
    assert "check (category_id is null or category_id in" in sql
