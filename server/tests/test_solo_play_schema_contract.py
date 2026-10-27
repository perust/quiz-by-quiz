"""migration 013(혼자 푸는 온라인 판, FR-7.13 3단계)의 계약.

실제 DB에서의 동작은 test_solo_play_integration.py가, 012 → 013 업그레이드는
test_character_only_migration_integration.py가 본다.
"""

from __future__ import annotations

from pathlib import Path

from app.main import RELEASE_SCHEMA_VERSION
from app.migrate import discover_migrations

MIGRATIONS = Path(__file__).parents[1] / "migrations"
MIGRATION = MIGRATIONS / "013_solo_play.sql"


def _sql() -> str:
    return " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())


def _create_table(name: str) -> str:
    """CREATE TABLE 한 문장(정규화한 글)."""
    sql = _sql()
    start = sql.index(f"create table quiz_online.{name} (")
    return sql[start : sql.index(");", start) + 2]


def test_solo_play_is_the_thirteenth_contiguous_migration_and_the_release_gate() -> None:
    migrations = discover_migrations(MIGRATIONS)

    assert [migration.version for migration in migrations] == list(range(1, 14))
    assert migrations[-1].path.name == "013_solo_play.sql"
    # 공개 release gate가 기다리는 판이 이 migration이다 (deploy/oracle/README.md)
    assert RELEASE_SCHEMA_VERSION == 13
    sql = _sql()
    assert sql.startswith("-- ") and "begin;" in sql and sql.rstrip().endswith("commit;")
    assert "insert into quiz_online.schema_migrations (version) values (13)" in sql
    assert "on conflict (version) do nothing" in sql


def test_migration_only_adds_and_never_touches_existing_tables() -> None:
    sql = _sql()

    # 012의 API(#108)가 도는 동안 먼저 올린다 — 이미 있는 표를 바꾸거나 지우지 않는다. 방 표에 열을
    # 더하지 않고 표시 표를 따로 두며, 랭킹 표에는 색인 하나만 더한다
    for forbidden in (
        "alter table",
        "drop ",
        "update quiz_online",
        "delete from",
        "create function",
        "create or replace",
    ):
        assert forbidden not in sql, forbidden
    assert sql.count("create table") == 1
    assert "create table quiz_online.solo_rooms" in sql
    assert sql.count("create index") == 1


def test_solo_rooms_mark_a_room_for_one_player_and_vanish_with_it() -> None:
    """혼자 푸는 온라인 판의 방. 방 하나·사람 하나에 하나이고 방과 함께 지워진다."""
    table = _create_table("solo_rooms")

    assert (
        "room_id uuid primary key references quiz_online.rooms(id) on delete cascade" in table
    )
    assert "player_id uuid not null" in table
    assert "created_at timestamptz not null default now()" in table
    assert "constraint solo_rooms_one_per_player unique (player_id)" in table
    # players는 몇 시간 만에 지워진다 — 사람에게는 외래 키를 걸지 않는다(방이 사라지면 표시도
    # 사라진다)
    assert table.count("references") == 1


def test_own_best_and_export_read_one_players_rows_through_an_index() -> None:
    """내 최고 점수·최고 기록 비교·기록 내보내기는 그 사람 줄만 읽는다."""
    sql = _sql()

    assert (
        "create index online_rankings_player_board_order_idx on quiz_online.online_rankings "
        "(player_id, board, score desc, recorded_at asc, id asc)"
    ) in sql


def test_runtime_role_only_marks_and_reads_solo_rooms() -> None:
    sql = _sql()

    # 표시를 남기고 읽기만 한다. 지우는 것은 방을 지울 때의 CASCADE뿐이다
    assert "grant select, insert on table quiz_online.solo_rooms to quiz_by_quiz_app" in sql
    assert sql.count("grant ") == 1
    for forbidden in ("grant all", "update on", "delete on", "truncate", "schema_migrations to"):
        assert forbidden not in sql, forbidden
