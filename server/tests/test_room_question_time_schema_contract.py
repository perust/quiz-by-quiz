from __future__ import annotations

from pathlib import Path

from app.migrate import discover_migrations

MIGRATIONS = Path(__file__).parents[1] / "migrations"
MIGRATION = MIGRATIONS / "011_room_question_time.sql"


def _sql() -> str:
    return " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())


def test_question_time_is_the_eleventh_contiguous_migration() -> None:
    versions = [migration.version for migration in discover_migrations(MIGRATIONS)]

    # 012(온라인 랭킹)가 뒤를 잇는다 — 011은 열한 번째 자리에 그대로 있다
    assert versions[:11] == list(range(1, 12))
    assert discover_migrations(MIGRATIONS)[10].path.name == "011_room_question_time.sql"
    assert "values (11)" in _sql()
    assert "on conflict (version) do nothing" in _sql()


def test_rooms_and_matches_carry_only_20_or_40_seconds_with_a_20_second_default() -> None:
    sql = _sql()

    for table in ("rooms", "matches"):
        # 이미 있는 방·판은 예전의 고정 20초를 받는다 (NOT NULL DEFAULT가 기존 행을 채운다)
        assert (
            f"alter table quiz_online.{table} add column question_time_ms integer "
            "not null default 20000"
        ) in sql
        assert (
            f"add constraint {table}_question_time_check "
            "check (question_time_ms in (20000, 40000))"
        ) in sql
    # 제한 없음(NULL)은 표현할 수 없다
    assert sql.count("question_time_ms integer not null default 20000") == 2


def test_timed_out_answers_can_record_a_full_40_second_question() -> None:
    sql = _sql()

    # 002의 이름 없는 0..20000 CHECK를 정의로 찾아 지운 뒤 40초까지 넓힌다
    assert "conrelid = 'quiz_online.match_answers'::regclass" in sql
    assert "pg_get_constraintdef(oid) ilike '%elapsed_ms%'" in sql
    assert sql.index("drop constraint %i") < sql.index("match_answers_elapsed_ms_range_check")
    assert "check (elapsed_ms between 0 and 40000)" in sql


def test_question_time_migration_is_additive_for_the_previous_api() -> None:
    sql = _sql()

    # 010의 API가 도는 동안 먼저 적용한다 (migration 011 → API → Pages). 지우거나 이름을 바꾸는
    # 열이 없고, 런타임 역할의 권한은 004의 표 단위 GRANT가 새 열까지 덮는다.
    assert "drop column" not in sql
    assert "rename" not in sql
    assert "grant " not in sql
    assert "revoke " not in sql
    assert sql.startswith("-- ") and "begin;" in sql and sql.rstrip().endswith("commit;")
