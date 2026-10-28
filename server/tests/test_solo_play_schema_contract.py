"""migration 013(혼자 푸는 온라인 판, FR-7.13 3단계 — PRD 10.1 #8–#11 소유자 결정)의 계약.

실제 DB에서의 동작은 test_solo_play_integration.py·test_solo_decisions_integration.py가, 012 → 013
업그레이드와 그 위의 012 API 문장은 test_character_only_migration_integration.py가 본다.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.domain import UNTIMED_ELAPSED_MS_CAP
from app.main import RELEASE_SCHEMA_VERSION
from app.migrate import discover_migrations
from app.postgres import _MATCH_LIFETIME

MIGRATIONS = Path(__file__).parents[1] / "migrations"
MIGRATION = MIGRATIONS / "013_solo_play.sql"


def _sql() -> str:
    """주석을 뺀 글을 한 줄로(소문자)."""
    lines = [
        line.split("--", 1)[0]
        for line in MIGRATION.read_text(encoding="utf-8").lower().splitlines()
    ]
    return " ".join(" ".join(lines).split())


def _create_table(name: str) -> str:
    """CREATE TABLE 한 문장(정규화한 글)."""
    sql = _sql()
    start = sql.index(f"create table quiz_online.{name} (")
    return sql[start : sql.index(");", start) + 2]


def _statements() -> list[str]:
    return [statement.strip() for statement in _sql().split(";") if statement.strip()]


def test_solo_play_is_the_thirteenth_contiguous_migration_and_the_release_gate() -> None:
    migrations = discover_migrations(MIGRATIONS)

    assert [migration.version for migration in migrations] == list(range(1, 14))
    assert migrations[-1].path.name == "013_solo_play.sql"
    # 공개 release gate가 기다리는 판이 이 migration이다 (deploy/oracle/README.md)
    raw = " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())
    assert RELEASE_SCHEMA_VERSION == 13
    assert raw.startswith("-- ") and "begin;" in raw and raw.rstrip().endswith("commit;")
    assert "insert into quiz_online.schema_migrations (version) values (13)" in raw
    assert "on conflict (version) do nothing" in raw


def test_one_lock_up_front_then_only_the_solo_play_changes() -> None:
    """012 API(#108)가 도는 동안 올린다 — 네 표를 맨 앞에서 한 번에 잡고 정해진 것만 바꾼다.

    문장마다 잠금을 키워 가면(색인의 SHARE → ALTER의 ACCESS EXCLUSIVE) 012 API의 transaction과 서로
    기다릴 수 있다. 지우는 것은 같은 이름으로 다시 거는 CHECK뿐이고, 줄은 하나도 고치거나 지우지
    않는다.
    """
    statements = _statements()
    assert statements[0] == "begin"
    assert statements[1] == (
        "lock table quiz_online.rooms, quiz_online.matches, quiz_online.match_answers, "
        "quiz_online.online_rankings in access exclusive mode"
    )
    sql = _sql()
    for forbidden in (
        "update quiz_online",
        "delete from",
        "create function",
        "create or replace",
        "drop table",
        "drop column",
        "drop index",
        "set default",
        "truncate",
    ):
        assert forbidden not in sql, forbidden
    dropped = re.findall(r"drop constraint (\w+)", sql)
    added = re.findall(r"add constraint (\w+) check", sql)
    # 지운 CHECK는 같은 이름으로 다시 건다 — 011·012·008의 이름을 읽는 점검과 API가 그대로다
    assert sorted(dropped) == sorted(added) == sorted(
        [
            "rooms_question_time_check",
            "matches_question_time_check",
            "matches_active_deadline_check",
            "match_answers_elapsed_ms_range_check",
            "online_rankings_question_time_check",
        ]
    )
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


def test_no_time_limit_is_null_and_only_for_solo_rooms_and_their_matches() -> None:
    """«제한 없음»(PRD 10.1 #9)은 문항 시간 NULL이다.

    혼자 방과 그 판에만 있다(생성 열 + 외래 키).
    """
    sql = _sql()

    for table in ("rooms", "matches", "online_rankings"):
        assert (
            f"alter table quiz_online.{table} alter column question_time_ms drop not null" in sql
        ), table
        assert (
            f"alter table quiz_online.{table} add constraint {table}_question_time_check "
            "check (question_time_ms is null or question_time_ms in (20000, 40000))"
        ) in sql, table
    # 방: NULL이면 제 id를 싣고 그 id가 혼자 방 표시를 가리킨다(표시는 방 뒤에 넣으므로 COMMIT에서
    # 본다)
    assert (
        "alter table quiz_online.rooms add column untimed_solo_room_id uuid generated always as "
        "(case when question_time_ms is null then id end) stored"
    ) in sql
    assert (
        "alter table quiz_online.rooms add constraint rooms_untimed_solo_room_fkey foreign key "
        "(untimed_solo_room_id) references quiz_online.solo_rooms (room_id) "
        "deferrable initially deferred"
    ) in sql
    # 판: NULL이면 그 방이 혼자 방이어야 한다. 마감 없는 판의 id는 따로 싣는다(답의 외래 키가
    # 가리킨다)
    assert (
        "alter table quiz_online.matches add column untimed_solo_room_id uuid generated always as "
        "(case when question_time_ms is null then room_id end) stored"
    ) in sql
    assert (
        "alter table quiz_online.matches add constraint matches_untimed_solo_room_fkey foreign key "
        "(untimed_solo_room_id) references quiz_online.solo_rooms (room_id) "
        "deferrable initially deferred"
    ) in sql
    assert (
        "alter table quiz_online.matches add column untimed_match_id uuid generated always as "
        "(case when question_time_ms is null then id end) stored"
    ) in sql
    assert (
        "alter table quiz_online.matches add constraint matches_untimed_match_key "
        "unique (untimed_match_id)"
    ) in sql


def test_only_an_untimed_running_question_has_no_deadline() -> None:
    sql = _sql()

    assert (
        "alter table quiz_online.matches add constraint matches_active_deadline_check check ( "
        "(state = 'running' and (deadline_at is null) = (question_time_ms is null)) "
        "or (state = 'revealing' and deadline_at is not null) "
        "or (state = 'finished' and deadline_at is null) "
        "or state = 'abandoned' )"
    ) in sql


def test_untimed_answers_are_bounded_by_the_match_lifetime_and_only_untimed_ones_exceed_forty() -> (
    None
):
    """제한 없는 문항의 쓴 시간은 자르지 않되 판의 수명(2시간)이 상한이다.

    40초를 넘는 쓴 시간은 제한 없는 판의 답뿐이다.
    """
    sql = _sql()

    assert _MATCH_LIFETIME == "2 hours"
    assert UNTIMED_ELAPSED_MS_CAP == 2 * 60 * 60 * 1000
    assert (
        "alter table quiz_online.match_answers add constraint "
        "match_answers_elapsed_ms_range_check check (elapsed_ms between 0 and 7200000)"
    ) in sql
    assert (
        "alter table quiz_online.match_answers add column long_elapsed_match_id uuid generated "
        "always as (case when elapsed_ms > 40000 then match_id end) stored"
    ) in sql
    assert (
        "alter table quiz_online.match_answers add constraint match_answers_long_elapsed_fkey "
        "foreign key (long_elapsed_match_id) references quiz_online.matches (untimed_match_id) "
        "deferrable initially deferred"
    ) in sql


def test_runtime_role_only_marks_and_reads_solo_rooms() -> None:
    sql = _sql()

    # 표시를 남기고 읽기만 한다. 지우는 것은 방을 지울 때의 CASCADE뿐이다
    assert "grant select, insert on table quiz_online.solo_rooms to quiz_by_quiz_app" in sql
    assert sql.count("grant ") == 1
    for forbidden in ("grant all", "update on", "delete on", "truncate", "schema_migrations to"):
        assert forbidden not in sql, forbidden
