"""migration 012(온라인 랭킹)의 계약.

실제 DB에서의 동작은 test_online_rankings_integration.py가 본다.
"""

from __future__ import annotations

from pathlib import Path

from app.main import RELEASE_SCHEMA_VERSION
from app.migrate import discover_migrations

MIGRATIONS = Path(__file__).parents[1] / "migrations"
MIGRATION = MIGRATIONS / "012_online_rankings.sql"


def _sql() -> str:
    return " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())


def _create_table(name: str) -> str:
    """CREATE TABLE 한 문장(정규화한 글). 표마다 따로 견준다."""
    sql = _sql()
    start = sql.index(f"create table quiz_online.{name} (")
    return sql[start : sql.index(");", start) + 2]


def test_rankings_are_the_twelfth_contiguous_migration_and_the_release_gate() -> None:
    migrations = discover_migrations(MIGRATIONS)

    assert [migration.version for migration in migrations] == list(range(1, 13))
    assert migrations[-1].path.name == "012_online_rankings.sql"
    # 공개 release gate가 기다리는 판이 이 migration이다 (deploy/oracle/README.md)
    assert RELEASE_SCHEMA_VERSION == 12
    sql = _sql()
    assert sql.startswith("-- ") and "begin;" in sql and sql.rstrip().endswith("commit;")
    assert "insert into quiz_online.schema_migrations (version) values (12)" in sql
    assert "on conflict (version) do nothing" in sql


def test_migration_only_adds_and_never_touches_existing_tables() -> None:
    sql = _sql()

    # 011의 API가 도는 동안 먼저 올린다 — 이미 있는 표를 바꾸거나 지우지 않는다. 혼자 푸는 온라인 판
    # (FR-7.13 3단계)도 방 표에 열을 더하지 않고 표시 표를 따로 둔다
    for forbidden in (
        "alter table",
        "drop ",
        "update quiz_online",
        "delete from quiz_online.rooms",
    ):
        assert forbidden not in sql, forbidden
    assert sql.count("create table") == 2
    assert "create table quiz_online.online_rankings" in sql
    assert "create table quiz_online.solo_rooms" in sql


def test_record_shape_is_the_server_graded_result_of_one_match_player() -> None:
    sql = _sql()

    for column in (
        "match_id uuid not null",
        "player_id uuid not null",
        "mode varchar(8) not null",
        "category_id varchar(16),",
        "score smallint not null",
        "correct_count smallint not null",
        "total_questions smallint not null",
        "question_time_ms integer not null",
        "nickname varchar(20) not null",
        "character_id varchar(32) not null",
        "recorded_at timestamptz not null",
    ):
        assert column in sql, column
    # 판·사람마다 한 번. 외래 키는 없다 — players·matches는 몇 시간 만에 지워진다
    assert "constraint online_rankings_match_player_key unique (match_id, player_id)" in sql
    assert "references" not in _create_table("online_rankings")
    # 브라우저가 보고한 점수가 아니라 정답 수에서 나온 점수만 받는다(정답당 10점)
    assert "score = correct_count * 10" in sql
    assert "correct_count between 0 and total_questions" in sql
    assert "total_questions between 1 and 25" in sql
    assert "question_time_ms in (20000, 40000)" in sql
    assert "(mode = 'all' and category_id is null)" in sql
    assert (
        "mode = 'category' and category_id in ('history', 'science', 'geography', 'general', "
        "'art')"
    ) in sql


def test_mine_is_bound_to_the_browser_secret_not_only_to_the_public_player_id() -> None:
    sql = _sql()

    # player id는 로비에 보이고 지워진 players 줄의 id는 누구든 다시 등록할 수 있다. «내 기록»은
    # 토큰에서 나온 32바이트 열쇠가 함께 가린다 — 토큰 해시 자체는 남기지 않는다
    assert "owner_key bytea," in sql
    assert (
        "constraint online_rankings_owner_key_length check ( owner_key is null or "
        "octet_length(owner_key) = 32 )"
    ) in sql
    assert "token_hash bytea" not in sql


def test_board_and_seoul_week_are_stored_generated_columns_behind_both_queries() -> None:
    sql = _sql()

    assert "board varchar(16) generated always as (coalesce(category_id, 'all')) stored" in sql
    assert (
        "week_start date generated always as ( (date_trunc('week', recorded_at at time zone "
        "'asia/seoul'))::date ) stored"
    ) in sql
    assert (
        "on quiz_online.online_rankings (board, score desc, recorded_at asc, id asc)" in sql
    )
    assert (
        "on quiz_online.online_rankings (board, week_start, score desc, recorded_at asc, id asc)"
        in sql
    )
    assert "on quiz_online.online_rankings (recorded_at)" in sql
    # 같은 판의 기록 순서(id)가 같은 점수·같은 시각의 마지막 기준이다
    assert "id bigint generated always as identity primary key" in sql


def test_runtime_role_only_records_and_reads_and_prunes_through_a_fixed_function() -> None:
    sql = _sql()

    assert "grant select, insert on table quiz_online.online_rankings to quiz_by_quiz_app" in sql
    assert "grant select, insert on table quiz_online.solo_rooms to quiz_by_quiz_app" in sql
    for forbidden in ("grant all", "update on", "delete on", "truncate", "schema_migrations to"):
        assert forbidden not in sql, forbidden
    assert sql.count("grant ") == 3
    assert "create function quiz_online.prune_online_rankings() returns integer" in sql
    assert "security definer set search_path = pg_catalog, quiz_online" in sql
    assert "revoke all on function quiz_online.prune_online_rankings() from public" in sql
    assert (
        "grant execute on function quiz_online.prune_online_rankings() to quiz_by_quiz_app"
        in sql
    )
    # 규칙은 함수 안에 박혀 있다: 최근 8주(56일) + 판마다 전체 상위 100, 저장 한도 250,000줄,
    # 한 번에 10,000줄까지
    assert "interval '56 days'" in sql
    assert "limit 100" in sql
    assert "offset 250000" in sql
    assert "limit 10000" in sql
    assert "values ('all'), ('history'), ('science'), ('geography'), ('general'), ('art')" in sql
    assert "returns integer language sql volatile" in sql
    # 인자가 없다 — 런타임 역할이 기간이나 개수를 바꿀 수 없다
    assert "prune_online_rankings()" in sql and "prune_online_rankings(integer" not in sql


def test_solo_rooms_mark_a_room_for_one_player_and_vanish_with_it() -> None:
    """혼자 푸는 온라인 판의 방 (FR-7.13 3단계). 방 하나·사람 하나에 하나이고 방과 함께 지워진다."""
    table = _create_table("solo_rooms")

    assert (
        "room_id uuid primary key references quiz_online.rooms(id) on delete cascade" in table
    )
    assert "player_id uuid not null" in table
    assert "constraint solo_rooms_one_per_player unique (player_id)" in table
    # players는 몇 시간 만에 지워진다 — 사람에게는 외래 키를 걸지 않는다(방이 사라지면 표시도
    # 사라진다)
    assert table.count("references") == 1


def test_own_best_and_export_read_one_players_rows_through_an_index() -> None:
    """내 최고 점수·최고 기록 비교·기록 내보내기(FR-7.13 3단계)는 그 사람 줄만 읽는다."""
    sql = _sql()

    assert (
        "create index online_rankings_player_board_order_idx on quiz_online.online_rankings "
        "(player_id, board, score desc, recorded_at asc, id asc)"
    ) in sql
