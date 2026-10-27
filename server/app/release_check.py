"""Read-only release checks for the operator (``python -m app.release_check``).

``db --expect 12|13`` runs inside the ``quiz-by-quiz-migrate`` service, before and after
migration 013 (deploy/oracle/README.md, "Fail-closed staging order"; ``--expect 10`` and
``--expect 11`` are the checks before the earlier migrations 011 and 012). ``bank`` runs inside
the ``quiz-by-quiz-api`` service, which mounts the private online bank.

Every line is ``OK``, ``FAIL``, ``WARN`` or ``INFO`` followed by a check name, and the exit
status is 0 exactly when no line is ``FAIL``. Nothing here writes to the database, reads
the runtime-role password, or prints a connection string, question content or question id.
Every check runs in its own transaction, opened ``READ ONLY`` and verified before the check
sends anything.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal

import psycopg

from .config import is_public_pages_question_bank
from .migrate import (
    _ADVISORY_LOCK_KEY,
    _RUNTIME_ROLE_NAME,
    MigrationError,
    discover_migrations,
    migrator_database_url,
)
from .question_catalog import (
    CATEGORY_IDS,
    QUESTIONS_PER_CATEGORY_ROUND,
    CatalogError,
    QuestionCatalog,
)

Status = Literal["OK", "FAIL", "WARN", "INFO"]

EXPECTABLE_VERSIONS = (10, 11, 12, 13)
ONLINE_ID_PREFIX = "online-"
# 판의 문항 기록 match_questions.question_id가 varchar(64)다(002). 더 긴 id도 catalog는 받아 API가
# 뜨지만, 그 문항을 뽑은 판은 INSERT에서 막혀 시작하지 못한다.
QUESTION_ID_MAX_LENGTH = 64
# 공개 Pages data/의 문항 번호 모양(<분야>-<숫자>, tools/check_bank.py). 그 번호를 그대로 쓴 은행은
# 공개 은행의 사본일 가능성이 크고, «이 문제 이상해요» 신고가 공개 문항 번호와 겹친다. 분야는 파일과
# 상관없이 다섯 모두를 본다. 내용이 사본인지는 이 검사가 알 수 없다 — 계약이 번호와 상관없이 금한다.
_PUBLIC_PAGES_ID = re.compile(rf"(?:{'|'.join(map(re.escape, CATEGORY_IDS))})-[0-9]+")
# 접속 중으로 셀 참가자. 대기실·판은 몇 초마다 last_seen_at을 새로 쓴다.
RECENT_MEMBER_WINDOW = timedelta(minutes=2)
_APPLICATION_NAME = "quiz-by-quiz-release-check"
_CONNECT_TIMEOUT_SECONDS = 10

# 010이 거는 캐릭터 전용 제약 다섯과, NULL이 CHECK를 그냥 통과하지 못하게 막는 NOT NULL 셋.
_CHARACTER_ONLY_CONSTRAINTS = (
    ("rooms", "rooms_character_only_check"),
    ("matches", "matches_character_only_check"),
    ("players", "players_character_id_valid"),
    ("room_members", "room_members_character_id_valid"),
    ("match_players", "match_players_character_id_valid"),
)
_CHARACTER_ID_TABLES = ("players", "room_members", "match_players")

# 011이 더하는 것. 열은 integer NOT NULL DEFAULT 20000, 값은 20000·40000뿐이다.
_QUESTION_TIME_TABLES = ("rooms", "matches")
_QUESTION_TIME_COLUMN = "question_time_ms"
_QUESTION_TIME_DEFAULT = "20000"
_DEFAULT_QUESTION_TIME_MS = 20_000
_QUESTION_TIME_VALUES = frozenset({_DEFAULT_QUESTION_TIME_MS, 40_000})
_QUESTION_TIME_CONSTRAINTS = (
    ("rooms", "rooms_question_time_check"),
    ("matches", "matches_question_time_check"),
    ("match_answers", "match_answers_elapsed_ms_range_check"),
)
# match_answers.elapsed_ms의 상한. 002의 이름 없는 열 CHECK는 20초, 011이 40초로 넓힌다.
_ELAPSED_MS_UPPER_BOUND = {10: 20_000, 11: 40_000, 12: 40_000, 13: 40_000}

# 012가 더하는 온라인 랭킹 표. 열 → (형식, NOT NULL, 저장 생성 열인가, identity인가).
_RANKINGS_TABLE = "online_rankings"
_RANKINGS_RELATION = f"quiz_online.{_RANKINGS_TABLE}"
_RANKINGS_COLUMNS: dict[str, tuple[str, bool, bool, bool]] = {
    "id": ("bigint", True, False, True),
    "match_id": ("uuid", True, False, False),
    "player_id": ("uuid", True, False, False),
    "mode": ("character varying(8)", True, False, False),
    "category_id": ("character varying(16)", False, False, False),
    "board": ("character varying(16)", False, True, False),
    "score": ("smallint", True, False, False),
    "correct_count": ("smallint", True, False, False),
    "total_questions": ("smallint", True, False, False),
    "question_time_ms": ("integer", True, False, False),
    "nickname": ("character varying(20)", True, False, False),
    "character_id": ("character varying(32)", True, False, False),
    # «내 기록»의 주인 열쇠(브라우저 토큰에서, 32바이트). players 줄이 없을 때만 NULL이다
    "owner_key": ("bytea", False, False, False),
    "recorded_at": ("timestamp with time zone", True, False, False),
    "week_start": ("date", False, True, False),
}
_RANKINGS_CHECKS = (
    "online_rankings_mode_check",
    "online_rankings_counts_check",
    "online_rankings_question_time_check",
    "online_rankings_nickname_check",
    "online_rankings_character_id_valid",
    "online_rankings_owner_key_length",
)
_RANKINGS_UNIQUE = "online_rankings_match_player_key"
_RANKINGS_INDEXES = (
    "online_rankings_board_order_idx",
    "online_rankings_board_week_order_idx",
    "online_rankings_recorded_at_idx",
)
# 013이 같은 표에 더하는 색인: 한 사람의 판마다 최고 기록·기록 내보내기 (FR-7.13 3단계).
# 012(#108)의 DB에는 없어야 한다.
_SOLO_PLAY_INDEXES = ("online_rankings_player_board_order_idx",)
_RANKINGS_PRUNE_FUNCTION = "quiz_online.prune_online_rankings()"
# 런타임 역할은 기록을 남기고 읽기만 한다. 나머지는 표 단위로도 열 단위로도 없어야 한다.
_RANKINGS_GRANTED = ("SELECT", "INSERT")
_RANKINGS_COLUMN_DENIED = ("UPDATE", "REFERENCES")
_RANKINGS_TABLE_DENIED = ("DELETE", "TRUNCATE", "TRIGGER")

# 013이 더하는 혼자 방 표시 (FR-7.13 3단계). 방 하나에 하나, 사람 하나에 하나이고 방과 함께
# 지워진다. 012(#108)의 DB에는 없어야 한다.
_SOLO_TABLE = "solo_rooms"
_SOLO_RELATION = f"quiz_online.{_SOLO_TABLE}"
_SOLO_COLUMNS: dict[str, tuple[str, bool, bool, bool]] = {
    "room_id": ("uuid", True, False, False),
    "player_id": ("uuid", True, False, False),
    "created_at": ("timestamp with time zone", True, False, False),
}
_SOLO_UNIQUE = "solo_rooms_one_per_player"
# 런타임 역할은 표시를 남기고 읽기만 한다. 지우는 것은 방을 지울 때의 CASCADE뿐이다.
_SOLO_GRANTED = ("SELECT", "INSERT")
_SOLO_COLUMN_DENIED = ("UPDATE", "REFERENCES")
_SOLO_TABLE_DENIED = ("DELETE", "TRUNCATE", "TRIGGER")

# 런타임 역할은 migration 기록을 읽지도 쓰지도 못한다(004). has_table_privilege는 표 단위
# 권한만 세므로 GRANT SELECT (version) 같은 열 권한을 놓친다 — 열에 줄 수 있는 넷은
# has_any_column_privilege로, 표에만 있는 셋은 has_table_privilege로 본다.
_LEDGER_COLUMN_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "REFERENCES")
_LEDGER_TABLE_PRIVILEGES = ("DELETE", "TRUNCATE", "TRIGGER")
# 011은 따로 GRANT하지 않고 004의 표 단위 권한이 새 열을 덮는다 — 그래서 열 권한은
# has_column_privilege로 실효 권한을 본다.
_QUESTION_TIME_PRIVILEGES = ("SELECT", "INSERT", "UPDATE")
_SCHEMA_VERSION_FUNCTION = "quiz_online.character_only_schema_version()"

# README의 statement-logging preflight. 이 값과 다르면 migrator의 ALTER ROLE ... PASSWORD가
# 비밀번호째 로그에 남을 수 있다.
_LOGGING_SETTINGS = (
    "log_statement",
    "log_min_duration_statement",
    "log_duration",
    "log_min_duration_sample",
    "log_statement_sample_rate",
    "log_transaction_sample_rate",
    "log_min_error_statement",
)
_ALTER_ROLE_LOG_REASON = "a failed ALTER ROLE ... PASSWORD could be logged with the password"

# 세션 값(default_transaction_read_only)을 첫 transaction에서 한 번 보는 것으로는 그 뒤를 보증하지
# 못한다 — transaction pooling proxy 뒤라면 transaction마다 다른 server 연결로 갈 수 있다. 그래서
# 점검마다 transaction을 READ ONLY로 열고, 정말 그런지 본 뒤에야 점검 문장을 보낸다.
_READ_ONLY_TRANSACTION_SQL = "SET TRANSACTION READ ONLY"
_READ_ONLY_GUARD_SQL = "SELECT current_setting('transaction_read_only')"

_SESSION_SQL = """
SELECT current_user::text,
       current_database()::text,
       current_setting('server_version')
"""

_LEDGER_SQL = """
SELECT version
FROM quiz_online.schema_migrations
ORDER BY version
"""

_LEDGER_EXISTS_SQL = """
SELECT to_regclass('quiz_online.schema_migrations') IS NOT NULL
"""

_SCHEMA_VERSION_SQL = """
SELECT quiz_online.character_only_schema_version()
"""

_FUNCTION_EXISTS_SQL = """
SELECT to_regprocedure(%s::text) IS NOT NULL
"""

_CHECK_CONSTRAINTS_SQL = """
SELECT relation.relname::text,
       check_row.conname::text,
       check_row.convalidated,
       pg_catalog.pg_get_constraintdef(check_row.oid)
FROM pg_catalog.pg_constraint check_row
JOIN pg_catalog.pg_class relation ON relation.oid = check_row.conrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'quiz_online'
  AND check_row.contype = 'c'
  AND relation.relname = ANY(%s::text[])
"""

_COLUMNS_SQL = """
SELECT relation.relname::text,
       attribute.attname::text,
       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
       attribute.attnotnull,
       pg_catalog.pg_get_expr(column_default.adbin, column_default.adrelid)
FROM pg_catalog.pg_attribute attribute
JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_attrdef column_default
  ON column_default.adrelid = attribute.attrelid
 AND column_default.adnum = attribute.attnum
WHERE namespace.nspname = 'quiz_online'
  AND relation.relname = ANY(%s::text[])
  AND attribute.attname = %s::text
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
"""

_QUESTION_TIME_VALUES_SQL = """
SELECT 'rooms', question_time_ms, count(*)
FROM quiz_online.rooms
GROUP BY question_time_ms
UNION ALL
SELECT 'matches', question_time_ms, count(*)
FROM quiz_online.matches
GROUP BY question_time_ms
"""

_RUNTIME_ROLE_SQL = """
SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_catalog.pg_roles
WHERE rolname = %s::text
"""

_RUNTIME_ROLE_MEMBERSHIP_SQL = """
SELECT 1
FROM pg_catalog.pg_auth_members membership
JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
WHERE member_role.rolname = %s::text
LIMIT 1
"""

_FUNCTION_PRIVILEGE_SQL = """
SELECT pg_catalog.has_function_privilege(%s::name, %s::text, 'EXECUTE')
"""

_LEDGER_PRIVILEGES_SQL = """
SELECT privilege,
       pg_catalog.has_any_column_privilege(%s::name, 'quiz_online.schema_migrations', privilege)
FROM unnest(%s::text[]) AS privilege
UNION ALL
SELECT privilege,
       pg_catalog.has_table_privilege(%s::name, 'quiz_online.schema_migrations', privilege)
FROM unnest(%s::text[]) AS privilege
"""

_COLUMN_PRIVILEGES_SQL = """
SELECT relation, privilege,
       pg_catalog.has_column_privilege(%s::name, 'quiz_online.' || relation, %s::text, privilege)
FROM unnest(%s::text[]) AS relation
CROSS JOIN unnest(%s::text[]) AS privilege
"""

_LOGGING_SQL = """
SELECT name::text, setting
FROM pg_catalog.pg_settings
WHERE name = ANY(%s::text[])
"""

_LOGGING_OVERRIDES_SQL = """
SELECT COALESCE(database_row.datname::text, '*'),
       COALESCE(role_row.rolname::text, '*'),
       setting_row.setconfig
FROM pg_catalog.pg_db_role_setting setting_row
LEFT JOIN pg_catalog.pg_database database_row ON database_row.oid = setting_row.setdatabase
LEFT JOIN pg_catalog.pg_roles role_row ON role_row.oid = setting_row.setrole
ORDER BY 1, 2
"""

# app.migrate가 쥐는 advisory lock. pg_locks는 64비트 열쇠를 classid(상위)·objid(하위)로
# 나눠 싣는다. advisory lock은 데이터베이스마다라 같은 클러스터의 다른 DB는 보지 않는다.
_MIGRATION_LOCK_SQL = """
SELECT count(*)
FROM pg_catalog.pg_locks lock_row
WHERE lock_row.locktype = 'advisory'
  AND lock_row.granted
  AND lock_row.database = (
      SELECT database_row.oid
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = current_database()
  )
  AND lock_row.classid::bigint = %s::bigint
  AND lock_row.objid::bigint = %s::bigint
  AND lock_row.objsubid = 1
"""

# 판이 도는 방(postgres.py의 running·revealing, 판 수명 expires_at 안).
_ACTIVE_MATCHES_SQL = """
SELECT count(*) FILTER (WHERE state = 'running'),
       count(*) FILTER (WHERE state = 'revealing')
FROM quiz_online.matches
WHERE state IN ('running', 'revealing')
  AND expires_at > now()
"""

_RANKINGS_EXISTS_SQL = """
SELECT to_regclass(%s::text) IS NOT NULL
"""

_RANKINGS_COLUMNS_SQL = """
SELECT attribute.attname::text,
       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
       attribute.attnotnull,
       attribute.attgenerated::text,
       attribute.attidentity::text
FROM pg_catalog.pg_attribute attribute
WHERE attribute.attrelid = to_regclass(%s::text)
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
"""

_UNIQUE_CONSTRAINTS_SQL = """
SELECT constraint_row.conname::text, constraint_row.convalidated
FROM pg_catalog.pg_constraint constraint_row
WHERE constraint_row.conrelid = to_regclass(%s::text)
  AND constraint_row.contype = 'u'
"""

_INDEXES_SQL = """
SELECT index_class.relname::text, index_row.indisvalid
FROM pg_catalog.pg_index index_row
JOIN pg_catalog.pg_class index_class ON index_class.oid = index_row.indexrelid
WHERE index_row.indrelid = to_regclass(%s::text)
"""

# 혼자 방 표시의 방 외래 키. ON DELETE CASCADE(confdeltype 'c')여야 방과 함께 사라진다
_SOLO_FOREIGN_KEY_SQL = """
SELECT constraint_row.conname::text,
       constraint_row.confdeltype::text,
       constraint_row.confrelid = to_regclass('quiz_online.rooms'),
       constraint_row.convalidated
FROM pg_catalog.pg_constraint constraint_row
WHERE constraint_row.conrelid = to_regclass(%s::text)
  AND constraint_row.contype = 'f'
"""

_SECURITY_DEFINER_SQL = """
SELECT procedure.prosecdef, procedure.proconfig
FROM pg_catalog.pg_proc procedure
WHERE procedure.oid = to_regprocedure(%s::text)
"""

_RANKINGS_ROWS_SQL = """
SELECT count(*), count(DISTINCT board), min(recorded_at) IS NOT NULL
FROM quiz_online.online_rankings
"""

_SOLO_ROOMS_ROWS_SQL = """
SELECT count(*)
FROM quiz_online.solo_rooms
"""

_TABLE_PRIVILEGES_SQL = """
SELECT privilege, pg_catalog.has_table_privilege(%s::name, %s::text, privilege)
FROM unnest(%s::text[]) AS privilege
"""

_ANY_COLUMN_PRIVILEGES_SQL = """
SELECT privilege, pg_catalog.has_any_column_privilege(%s::name, %s::text, privilege)
FROM unnest(%s::text[]) AS privilege
"""

_RECENT_MEMBERS_SQL = """
SELECT count(*), count(DISTINCT room_id)
FROM quiz_online.room_members
WHERE last_seen_at > now() - %s::interval
"""

_ELAPSED_BOUNDS = re.compile(
    r"\(elapsed_ms >= (?P<lower>-?[0-9]+)\).*\(elapsed_ms <= (?P<upper>-?[0-9]+)\)"
)
_INTEGER = re.compile(r"-?[0-9]+")


@dataclass(frozen=True)
class Check:
    status: Status
    name: str
    detail: str

    def render(self) -> str:
        return f"{self.status} {self.name} {self.detail}".rstrip()


class _NotReadOnly(RuntimeError):
    """The session refused to become read-only, so no check may run."""


Connection = Any
CheckFunction = Callable[[Connection], Iterable[Check]]


# ── db ─────────────────────────────────────────────────────────────────────────


def run_database_checks(
    environment: Mapping[str, str],
    *,
    expect: int,
    require_idle: bool = False,
    require_default_question_time: bool = False,
    require_empty_rankings: bool = False,
    require_empty_solo_rooms: bool = False,
) -> list[Check]:
    """Connect as the migration owner, force read-only transactions and run every check."""
    try:
        database_url = migrator_database_url(environment)
    except MigrationError:
        return [Check("FAIL", "config", "MIGRATOR_DATABASE_URL is required")]

    try:
        connection = psycopg.connect(
            database_url,
            autocommit=True,
            connect_timeout=_CONNECT_TIMEOUT_SECONDS,
            application_name=_APPLICATION_NAME,
        )
    except (psycopg.Error, OSError) as error:
        # libpq의 연결 오류 문장에는 호스트·사용자가 들어 있다. 종류만 알린다.
        return [Check("FAIL", "connect", f"could not connect ({type(error).__name__})")]

    with connection:
        try:
            # autocommit이라 세 SET은 세션 값이 된다. 점검마다 transaction도 READ ONLY로 연다(_run).
            connection.execute("SET default_transaction_read_only = on")
            connection.execute("SET statement_timeout = '15s'")
            connection.execute("SET lock_timeout = '5s'")
        except psycopg.Error as error:
            return [Check("FAIL", "session", f"could not configure ({_describe(error)})")]
        return check_database(
            connection,
            expect=expect,
            require_idle=require_idle,
            require_default_question_time=require_default_question_time,
            require_empty_rankings=require_empty_rankings,
            require_empty_solo_rooms=require_empty_solo_rooms,
        )


def check_database(
    connection: Connection,
    *,
    expect: int,
    require_idle: bool = False,
    require_default_question_time: bool = False,
    require_empty_rankings: bool = False,
    require_empty_solo_rooms: bool = False,
) -> list[Check]:
    """Run the release checks, each in its own verified read-only transaction.

    ``require_default_question_time`` (``--expect 11`` only) fails while any room or match
    holds a question time other than 20000 — the window between migration 011 and its
    candidate API, when only the migration-010 API (which never writes the column) serves.
    ``require_empty_rankings`` (``--expect 12`` only) fails while the ranking table holds a
    row — the window between migration 012 and its candidate API, when only the
    migration-011 API (which never writes the table) serves. ``require_empty_solo_rooms``
    (``--expect 13`` only) fails while a solo room exists — the window between migration 013
    and its candidate API, when only the migration-012 API (which never writes the table)
    serves.
    """
    if expect not in EXPECTABLE_VERSIONS:
        raise ValueError(f"expect must be one of {EXPECTABLE_VERSIONS}")
    if require_default_question_time and expect != 11:
        raise ValueError("require_default_question_time needs expect 11")
    if require_empty_rankings and expect != 12:
        raise ValueError("require_empty_rankings needs expect 12")
    if require_empty_solo_rooms and expect != 13:
        raise ValueError("require_empty_solo_rooms needs expect 13")

    session = _run(connection, "session", _check_session)
    if any(check.status == "FAIL" for check in session):
        return session

    checks: list[tuple[str, CheckFunction]] = [
        ("ledger", lambda conn: _check_ledger(conn, expect)),
        ("schema-version", lambda conn: _check_schema_version(conn, expect)),
        ("character-only", _check_character_only),
        ("question-time-columns", lambda conn: _check_question_time_columns(conn, expect)),
        (
            "question-time-constraints",
            lambda conn: _check_question_time_constraints(conn, expect),
        ),
        ("elapsed-ms-check", lambda conn: _check_elapsed_ms(conn, expect)),
    ]
    if expect >= 11:
        checks.append(
            (
                "question-time-values",
                lambda conn: _check_question_time_values(conn, require_default_question_time),
            )
        )
    checks.append(("rankings-table", lambda conn: _check_rankings_table(conn, expect)))
    checks.append(("solo-rooms-table", lambda conn: _check_solo_rooms_table(conn, expect)))
    if expect >= 12:
        checks += [
            ("rankings-constraints", _check_rankings_constraints),
            ("rankings-indexes", lambda conn: _check_rankings_indexes(conn, expect)),
            ("rankings-retention", _check_rankings_retention),
            (
                "rankings-records",
                lambda conn: _check_rankings_records(conn, require_empty_rankings),
            ),
        ]
    if expect >= 13:
        checks += [
            ("solo-rooms-constraints", _check_solo_rooms_constraints),
            (
                "solo-rooms-records",
                lambda conn: _check_solo_rooms_records(conn, require_empty_solo_rooms),
            ),
        ]
    checks += [
        ("runtime-role", _check_runtime_role),
        ("runtime-schema-version-access", _check_runtime_function_access),
        ("runtime-ledger-access", _check_runtime_ledger_access),
    ]
    if expect >= 11:
        checks.append(("runtime-question-time-access", _check_runtime_question_time_access))
    if expect >= 12:
        checks.append(("runtime-rankings-access", _check_runtime_rankings_access))
    if expect >= 13:
        checks.append(("runtime-solo-rooms-access", _check_runtime_solo_rooms_access))
    checks += [
        ("logging", _check_logging),
        ("logging-overrides", _check_logging_overrides),
        ("migration-lock", _check_migration_lock),
        ("active-matches", lambda conn: _check_active_matches(conn, require_idle)),
        ("recent-members", _check_recent_members),
    ]

    results = list(session)
    for name, check in checks:
        results.extend(_run(connection, name, check))
    return results


def _run(connection: Connection, name: str, check: CheckFunction) -> list[Check]:
    """One check per transaction (or savepoint), so a failed query cannot abort the rest.

    The transaction is made ``READ ONLY`` and verified before the check runs, so read-only
    does not rest on the session setting surviving from the first transaction. If the
    server still reports read-write, the check sends nothing and becomes a ``FAIL``.
    """
    try:
        with connection.transaction():
            connection.execute(_READ_ONLY_TRANSACTION_SQL)
            if _fetchone(connection, _READ_ONLY_GUARD_SQL)[0] != "on":
                raise _NotReadOnly
            return list(check(connection))
    except _NotReadOnly:
        return [Check("FAIL", name, "transaction is not read-only; no check was run")]
    except psycopg.Error as error:
        return [Check("FAIL", name, f"query failed ({_describe(error)})")]


def _describe(error: psycopg.Error) -> str:
    # 서버 문장은 싣지 않는다. 종류와 SQLSTATE면 어디서 막혔는지 알 수 있다.
    sqlstate = getattr(error, "sqlstate", None)
    return f"{type(error).__name__} {sqlstate}" if sqlstate else type(error).__name__


def _fetchone(connection: Connection, statement: str, params: Sequence[object] = ()) -> Any:
    row = connection.execute(statement, params).fetchone()
    if row is None:  # pragma: no cover - every statement here returns one row
        raise RuntimeError("query returned no row")
    return row


def _check_session(connection: Connection) -> Iterable[Check]:
    # 여기 왔으면 _run이 이 transaction의 read-only를 이미 확인했다.
    user, database, server_version = _fetchone(connection, _SESSION_SQL)
    yield Check(
        "OK",
        "session",
        f"read-only as {user} on database {database} (PostgreSQL {server_version})",
    )


def _check_ledger(connection: Connection, expect: int) -> Iterable[Check]:
    if not _fetchone(connection, _LEDGER_EXISTS_SQL)[0]:
        yield Check("FAIL", "ledger", "quiz_online.schema_migrations is missing")
        return
    versions = [int(row[0]) for row in connection.execute(_LEDGER_SQL).fetchall()]
    if not versions:
        yield Check("FAIL", "ledger", "quiz_online.schema_migrations is empty")
        return

    latest = versions[-1]
    expected = list(range(1, latest + 1))
    if versions != expected:
        missing = sorted(set(expected) - set(versions))
        extra = sorted(set(versions) - set(expected))
        problems = [f"missing {_join(missing)}"] if missing else []
        problems += [f"unexpected {_join(extra)}"] if extra else []
        yield Check("FAIL", "ledger", f"versions are not contiguous from 1: {'; '.join(problems)}")
    elif latest != expect:
        yield Check("FAIL", "ledger", f"latest version is {latest}, expected {expect}")
    else:
        yield Check("OK", "ledger", f"versions 1..{latest} contiguous, latest {latest}")

    # 이 image의 app.migrate가 무엇을 올릴지. 011 전 점검을 후보 image에서 돌리면 «11»이 나온다.
    shipped = [migration.version for migration in discover_migrations()]
    unknown = sorted(set(versions) - set(shipped))
    pending = sorted(set(shipped) - set(versions))
    if unknown:
        yield Check(
            "WARN",
            "pending-migrations",
            f"database has versions this image does not ship ({_join(unknown)}); "
            "app.migrate from this image would refuse to run",
        )
    elif pending:
        yield Check(
            "INFO",
            "pending-migrations",
            f"app.migrate from this image would apply {_join(pending)}",
        )
    else:
        yield Check("INFO", "pending-migrations", f"none; this image ships 1..{shipped[-1]}")


def _check_schema_version(connection: Connection, expect: int) -> Iterable[Check]:
    if not _fetchone(connection, _FUNCTION_EXISTS_SQL, (_SCHEMA_VERSION_FUNCTION,))[0]:
        yield Check("FAIL", "schema-version", f"{_SCHEMA_VERSION_FUNCTION} is missing")
        return
    version = int(_fetchone(connection, _SCHEMA_VERSION_SQL)[0])
    status: Status = "OK" if version == expect else "FAIL"
    suffix = "" if version == expect else f", expected {expect}"
    yield Check(status, "schema-version", f"{_SCHEMA_VERSION_FUNCTION} = {version}{suffix}")


def _check_constraints(
    connection: Connection, tables: Iterable[str]
) -> dict[tuple[str, str], tuple[bool, str]]:
    """CHECK constraints of the given quiz_online tables: (table, name) → (validated, def)."""
    rows = connection.execute(_CHECK_CONSTRAINTS_SQL, (sorted(set(tables)),)).fetchall()
    return {
        (table, name): (bool(validated), definition) for table, name, validated, definition in rows
    }


def _columns(
    connection: Connection, tables: Iterable[str], column: str
) -> dict[str, tuple[str, bool, str | None]]:
    """One column of the given quiz_online tables: table → (type, NOT NULL, default)."""
    rows = connection.execute(_COLUMNS_SQL, (sorted(set(tables)), column)).fetchall()
    return {
        table: (data_type, bool(not_null), default)
        for table, _name, data_type, not_null, default in rows
    }


def _check_character_only(connection: Connection) -> Iterable[Check]:
    constraints = _check_constraints(
        connection, (table for table, _ in _CHARACTER_ONLY_CONSTRAINTS)
    )
    problems = _constraint_problems(constraints, _CHARACTER_ONLY_CONSTRAINTS)
    columns = _columns(connection, _CHARACTER_ID_TABLES, "character_id")
    for table in _CHARACTER_ID_TABLES:
        column = columns.get(table)
        if column is None:
            problems.append(f"{table}.character_id is missing")
        elif not column[1]:
            problems.append(f"{table}.character_id is nullable")
    if problems:
        yield Check("FAIL", "character-only", "; ".join(problems))
    else:
        yield Check(
            "OK",
            "character-only",
            f"{len(_CHARACTER_ONLY_CONSTRAINTS)} constraints validated, "
            f"character_id NOT NULL on {len(_CHARACTER_ID_TABLES)} tables",
        )


def _constraint_problems(
    constraints: Mapping[tuple[str, str], tuple[bool, str]],
    required: Iterable[tuple[str, str]],
) -> list[str]:
    problems: list[str] = []
    for table, name in required:
        found = constraints.get((table, name))
        if found is None:
            problems.append(f"{name} on {table} is missing")
        elif not found[0]:
            problems.append(f"{name} on {table} is not validated")
    return problems


def _check_question_time_columns(connection: Connection, expect: int) -> Iterable[Check]:
    columns = _columns(connection, _QUESTION_TIME_TABLES, _QUESTION_TIME_COLUMN)
    names = ", ".join(f"{table}.{_QUESTION_TIME_COLUMN}" for table in _QUESTION_TIME_TABLES)
    if expect < 11:
        present = [table for table in _QUESTION_TIME_TABLES if table in columns]
        if present:
            yield Check(
                "FAIL",
                "question-time-columns",
                "migration 011 columns already exist: "
                + ", ".join(f"{table}.{_QUESTION_TIME_COLUMN}" for table in present),
            )
        else:
            yield Check("OK", "question-time-columns", f"{names} absent, as at migration 10")
        return

    problems: list[str] = []
    for table in _QUESTION_TIME_TABLES:
        column = columns.get(table)
        label = f"{table}.{_QUESTION_TIME_COLUMN}"
        if column is None:
            problems.append(f"{label} is missing")
            continue
        data_type, not_null, default = column
        if data_type != "integer":
            problems.append(f"{label} is {data_type}, expected integer")
        if not not_null:
            problems.append(f"{label} is nullable")
        if default != _QUESTION_TIME_DEFAULT:
            problems.append(f"{label} default is {default or 'none'}, expected 20000")
    if problems:
        yield Check("FAIL", "question-time-columns", "; ".join(problems))
    else:
        yield Check("OK", "question-time-columns", f"{names} integer NOT NULL DEFAULT 20000")


def _check_question_time_constraints(connection: Connection, expect: int) -> Iterable[Check]:
    constraints = _check_constraints(connection, (table for table, _ in _QUESTION_TIME_CONSTRAINTS))
    names = ", ".join(name for _, name in _QUESTION_TIME_CONSTRAINTS)
    if expect < 11:
        present = [
            name for table, name in _QUESTION_TIME_CONSTRAINTS if (table, name) in constraints
        ]
        if present:
            yield Check(
                "FAIL",
                "question-time-constraints",
                f"migration 011 constraints already exist: {', '.join(present)}",
            )
        else:
            yield Check("OK", "question-time-constraints", f"{names} absent, as at migration 10")
        return

    problems = _constraint_problems(constraints, _QUESTION_TIME_CONSTRAINTS)
    for table in _QUESTION_TIME_TABLES:
        found = constraints.get((table, f"{table}_question_time_check"))
        if found is not None and _integers(found[1]) != _QUESTION_TIME_VALUES:
            problems.append(f"{table}_question_time_check does not allow exactly 20000 and 40000")
    if problems:
        yield Check("FAIL", "question-time-constraints", "; ".join(problems))
    else:
        yield Check("OK", "question-time-constraints", f"{names} validated")


def _check_elapsed_ms(connection: Connection, expect: int) -> Iterable[Check]:
    upper = _ELAPSED_MS_UPPER_BOUND[expect]
    # 011의 DO 블록과 같은 기준으로 찾는다 — 정의에 elapsed_ms가 들어간 match_answers의 CHECK.
    elapsed = [
        (name, validated, definition)
        for (table, name), (validated, definition) in _check_constraints(
            connection, ("match_answers",)
        ).items()
        if table == "match_answers" and "elapsed_ms" in definition.lower()
    ]
    if len(elapsed) != 1:
        yield Check(
            "FAIL",
            "elapsed-ms-check",
            f"expected exactly one elapsed_ms CHECK on match_answers, found {len(elapsed)}",
        )
        return
    name, validated, definition = elapsed[0]
    bounds = _ELAPSED_BOUNDS.search(definition)
    found = (int(bounds["lower"]), int(bounds["upper"])) if bounds else None
    if found != (0, upper):
        shown = f"{found[0]}..{found[1]}" if found else "unrecognized bounds"
        yield Check("FAIL", "elapsed-ms-check", f"{name} allows {shown}, expected 0..{upper}")
    elif not validated:
        yield Check("FAIL", "elapsed-ms-check", f"{name} is not validated")
    else:
        yield Check("OK", "elapsed-ms-check", f"{name} allows 0..{upper}")


def _check_question_time_values(connection: Connection, require_default: bool) -> Iterable[Check]:
    missing = _missing_question_time_columns(connection)
    if missing:
        yield Check("FAIL", "question-time-values", f"missing column: {missing}")
        return
    counts: dict[str, Counter[int]] = {table: Counter() for table in _QUESTION_TIME_TABLES}
    for table, value, count in connection.execute(_QUESTION_TIME_VALUES_SQL).fetchall():
        counts[str(table)][int(value)] += int(count)
    unexpected = {
        table: sorted(value for value in counter if value not in _QUESTION_TIME_VALUES)
        for table, counter in counts.items()
    }
    summary = "; ".join(
        f"{table} " + (" ".join(f"{value}={counter[value]}" for value in sorted(counter)) or "none")
        for table, counter in counts.items()
    )
    if any(unexpected.values()):
        yield Check("FAIL", "question-time-values", f"values other than 20000/40000: {summary}")
    elif not require_default:
        yield Check("INFO", "question-time-values", summary)
    # 011 뒤 후보 API로 바꾸기 전에는 010의 API만 돈다. 그 API는 이 열을 쓰지 않으므로
    # 40000이 있으면 후보 API가 너무 일찍 돌았다는 뜻이다(README 3단계).
    elif any(
        value != _DEFAULT_QUESTION_TIME_MS for counter in counts.values() for value in counter
    ):
        yield Check(
            "FAIL",
            "question-time-values",
            f"{summary}; --require-default-question-time needs every row at 20000 "
            "(only the candidate API writes 40000)",
        )
    else:
        yield Check("OK", "question-time-values", f"{summary}; every row at 20000")


def _rankings_table_exists(connection: Connection) -> bool:
    return bool(_fetchone(connection, _RANKINGS_EXISTS_SQL, (_RANKINGS_RELATION,))[0])


def _check_rankings_table(connection: Connection, expect: int) -> Iterable[Check]:
    name = "rankings-table"
    exists = _rankings_table_exists(connection)
    if expect < 12:
        if exists:
            yield Check("FAIL", name, f"migration 012 table already exists: {_RANKINGS_RELATION}")
        else:
            yield Check("OK", name, f"{_RANKINGS_RELATION} absent, as at migration {expect}")
        return
    if not exists:
        yield Check("FAIL", name, f"{_RANKINGS_RELATION} is missing")
        return
    found = {
        str(column): (str(data_type), bool(not_null), generated == "s", identity in {"a", "d"})
        for column, data_type, not_null, generated, identity in connection.execute(
            _RANKINGS_COLUMNS_SQL, (_RANKINGS_RELATION,)
        ).fetchall()
    }
    problems: list[str] = []
    for column, (data_type, not_null, generated, identity) in _RANKINGS_COLUMNS.items():
        actual = found.get(column)
        if actual is None:
            problems.append(f"{column} is missing")
            continue
        if actual[0] != data_type:
            problems.append(f"{column} is {actual[0]}, expected {data_type}")
        if actual[1] != not_null:
            problems.append(f"{column} is {'NOT NULL' if actual[1] else 'nullable'}")
        if actual[2] != generated:
            problems.append(f"{column} {'is' if actual[2] else 'is not'} a stored generated column")
        if actual[3] != identity:
            problems.append(f"{column} {'is' if actual[3] else 'is not'} an identity column")
    extra = sorted(set(found) - set(_RANKINGS_COLUMNS))
    if extra:
        problems.append(f"unexpected columns {', '.join(extra)}")
    if problems:
        yield Check("FAIL", name, "; ".join(problems))
    else:
        yield Check(
            "OK",
            name,
            f"{_RANKINGS_RELATION} has {len(_RANKINGS_COLUMNS)} columns "
            "(board and week_start generated, id identity)",
        )


def _check_rankings_constraints(connection: Connection) -> Iterable[Check]:
    name = "rankings-constraints"
    if not _rankings_table_exists(connection):
        yield Check("FAIL", name, f"{_RANKINGS_RELATION} is missing")
        return
    constraints = _check_constraints(connection, (_RANKINGS_TABLE,))
    problems = _constraint_problems(
        constraints, ((_RANKINGS_TABLE, check) for check in _RANKINGS_CHECKS)
    )
    question_time = constraints.get((_RANKINGS_TABLE, "online_rankings_question_time_check"))
    if question_time is not None and _integers(question_time[1]) != _QUESTION_TIME_VALUES:
        problems.append(
            "online_rankings_question_time_check does not allow exactly 20000 and 40000"
        )
    owner_key = constraints.get((_RANKINGS_TABLE, "online_rankings_owner_key_length"))
    if owner_key is not None and "octet_length(owner_key) = 32" not in owner_key[1]:
        problems.append("online_rankings_owner_key_length does not require 32-byte owner keys")
    unique = {
        str(constraint): bool(validated)
        for constraint, validated in connection.execute(
            _UNIQUE_CONSTRAINTS_SQL, (_RANKINGS_RELATION,)
        ).fetchall()
    }
    if _RANKINGS_UNIQUE not in unique:
        problems.append(f"{_RANKINGS_UNIQUE} (one record per match player) is missing")
    if problems:
        yield Check("FAIL", name, "; ".join(problems))
    else:
        yield Check(
            "OK",
            name,
            f"{len(_RANKINGS_CHECKS)} checks validated, {_RANKINGS_UNIQUE} present",
        )


def _check_rankings_indexes(connection: Connection, expect: int) -> Iterable[Check]:
    """012의 색인 셋. 013부터는 그 표에 더한 한 사람의 색인도 보고, 012에서는 그것이 없어야 한다."""
    name = "rankings-indexes"
    if not _rankings_table_exists(connection):
        yield Check("FAIL", name, f"{_RANKINGS_RELATION} is missing")
        return
    indexes = {
        str(index): bool(valid)
        for index, valid in connection.execute(_INDEXES_SQL, (_RANKINGS_RELATION,)).fetchall()
    }
    required = _RANKINGS_INDEXES + (_SOLO_PLAY_INDEXES if expect >= 13 else ())
    problems = [
        f"{index} is {'missing' if index not in indexes else 'not valid'}"
        for index in required
        if not indexes.get(index, False)
    ]
    early = [index for index in _SOLO_PLAY_INDEXES if expect < 13 and index in indexes]
    if early:
        problems.append(f"migration 013 index already exists: {', '.join(early)}")
    if problems:
        yield Check("FAIL", name, "; ".join(problems))
    elif expect < 13:
        yield Check(
            "OK",
            name,
            f"{', '.join(required)} valid; {', '.join(_SOLO_PLAY_INDEXES)} absent, "
            f"as at migration {expect}",
        )
    else:
        yield Check("OK", name, f"{', '.join(required)} valid")


def _check_rankings_retention(connection: Connection) -> Iterable[Check]:
    name = "rankings-retention"
    if not _fetchone(connection, _FUNCTION_EXISTS_SQL, (_RANKINGS_PRUNE_FUNCTION,))[0]:
        yield Check("FAIL", name, f"{_RANKINGS_PRUNE_FUNCTION} is missing")
        return
    security_definer, config = _fetchone(
        connection, _SECURITY_DEFINER_SQL, (_RANKINGS_PRUNE_FUNCTION,)
    )
    problems: list[str] = []
    if not security_definer:
        problems.append("is not SECURITY DEFINER (the runtime role has no DELETE)")
    if not any(str(entry).startswith("search_path=") for entry in config or ()):
        problems.append("has no fixed search_path")
    if problems:
        yield Check("FAIL", name, f"{_RANKINGS_PRUNE_FUNCTION} " + ", ".join(problems))
    else:
        yield Check(
            "OK", name, f"{_RANKINGS_PRUNE_FUNCTION} SECURITY DEFINER with a fixed search_path"
        )


def _check_rankings_records(connection: Connection, require_empty: bool) -> Iterable[Check]:
    name = "rankings-records"
    if not _rankings_table_exists(connection):
        yield Check("FAIL", name, f"{_RANKINGS_RELATION} is missing")
        return
    rows, boards, _ = _fetchone(connection, _RANKINGS_ROWS_SQL)
    detail = f"{int(rows)} records in {int(boards)} boards"
    # 012 뒤 후보 API로 바꾸기 전에는 011의 API만 돈다. 그 API는 이 표를 모르므로 기록이 있으면
    # 후보 API가 너무 일찍 돌았다는 뜻이다(README 3단계).
    if require_empty and int(rows):
        yield Check(
            "FAIL",
            name,
            f"{detail}; --require-empty-rankings needs 0 (only the candidate API records)",
        )
    elif require_empty:
        yield Check("OK", name, f"{detail}; empty")
    else:
        yield Check("INFO", name, detail)


def _solo_rooms_table_exists(connection: Connection) -> bool:
    return bool(_fetchone(connection, _RANKINGS_EXISTS_SQL, (_SOLO_RELATION,))[0])


def _check_solo_rooms_table(connection: Connection, expect: int) -> Iterable[Check]:
    """혼자 방 표시 표 (FR-7.13 3단계, migration 013). 013 전에는 없어야 한다."""
    name = "solo-rooms-table"
    exists = _solo_rooms_table_exists(connection)
    if expect < 13:
        if exists:
            yield Check("FAIL", name, f"migration 013 table already exists: {_SOLO_RELATION}")
        else:
            yield Check("OK", name, f"{_SOLO_RELATION} absent, as at migration {expect}")
        return
    if not exists:
        yield Check("FAIL", name, f"{_SOLO_RELATION} is missing")
        return
    found = {
        str(column): (str(data_type), bool(not_null), generated == "s", identity in {"a", "d"})
        for column, data_type, not_null, generated, identity in connection.execute(
            _RANKINGS_COLUMNS_SQL, (_SOLO_RELATION,)
        ).fetchall()
    }
    problems: list[str] = []
    for column, (data_type, not_null, _, _) in _SOLO_COLUMNS.items():
        actual = found.get(column)
        if actual is None:
            problems.append(f"{column} is missing")
            continue
        if actual[0] != data_type:
            problems.append(f"{column} is {actual[0]}, expected {data_type}")
        if actual[1] != not_null:
            problems.append(f"{column} is {'NOT NULL' if actual[1] else 'nullable'}")
    extra = sorted(set(found) - set(_SOLO_COLUMNS))
    if extra:
        problems.append(f"unexpected columns {', '.join(extra)}")
    if problems:
        yield Check("FAIL", name, "; ".join(problems))
    else:
        yield Check("OK", name, f"{_SOLO_RELATION} has {len(_SOLO_COLUMNS)} columns")


def _check_solo_rooms_constraints(connection: Connection) -> Iterable[Check]:
    """방과 함께 지워지고(ON DELETE CASCADE) 사람마다 하나다(UNIQUE)."""
    name = "solo-rooms-constraints"
    if not _solo_rooms_table_exists(connection):
        yield Check("FAIL", name, f"{_SOLO_RELATION} is missing")
        return
    problems: list[str] = []
    foreign = connection.execute(_SOLO_FOREIGN_KEY_SQL, (_SOLO_RELATION,)).fetchall()
    cascading = [
        row for row in foreign if str(row[1]) == "c" and bool(row[2]) and bool(row[3])
    ]
    if not cascading:
        problems.append("room_id does not reference quiz_online.rooms ON DELETE CASCADE")
    unique = {
        str(constraint): bool(validated)
        for constraint, validated in connection.execute(
            _UNIQUE_CONSTRAINTS_SQL, (_SOLO_RELATION,)
        ).fetchall()
    }
    if not unique.get(_SOLO_UNIQUE, False):
        problems.append(f"{_SOLO_UNIQUE} (one solo room per player) is missing")
    if problems:
        yield Check("FAIL", name, "; ".join(problems))
    else:
        yield Check(
            "OK", name, f"room_id cascades from quiz_online.rooms, {_SOLO_UNIQUE} present"
        )


def _check_solo_rooms_records(connection: Connection, require_empty: bool) -> Iterable[Check]:
    name = "solo-rooms-records"
    if not _solo_rooms_table_exists(connection):
        yield Check("FAIL", name, f"{_SOLO_RELATION} is missing")
        return
    rows = int(_fetchone(connection, _SOLO_ROOMS_ROWS_SQL)[0])
    detail = f"{rows} solo rooms"
    # 013 뒤 후보 API로 바꾸기 전에는 012의 API(#108)만 돈다. 그 API는 이 표를 모르므로 혼자 방이
    # 있으면 후보 API가 너무 일찍 돌았다는 뜻이다(README 3단계).
    if require_empty and rows:
        yield Check(
            "FAIL",
            name,
            f"{detail}; --require-empty-solo-rooms needs 0 (only the candidate API creates them)",
        )
    elif require_empty:
        yield Check("OK", name, f"{detail}; empty")
    else:
        yield Check("INFO", name, detail)


def _check_runtime_solo_rooms_access(connection: Connection) -> Iterable[Check]:
    name = "runtime-solo-rooms-access"
    if not _runtime_role_exists(connection):
        yield Check("FAIL", name, f"{_RUNTIME_ROLE_NAME} does not exist")
        return
    if not _solo_rooms_table_exists(connection):
        yield Check("FAIL", name, f"{_SOLO_RELATION} is missing")
        return
    granted = dict(
        connection.execute(
            _TABLE_PRIVILEGES_SQL,
            (_RUNTIME_ROLE_NAME, _SOLO_RELATION, list(_SOLO_GRANTED)),
        ).fetchall()
    )
    denied_table = dict(
        connection.execute(
            _TABLE_PRIVILEGES_SQL,
            (_RUNTIME_ROLE_NAME, _SOLO_RELATION, list(_SOLO_TABLE_DENIED)),
        ).fetchall()
    )
    denied_column = dict(
        connection.execute(
            _ANY_COLUMN_PRIVILEGES_SQL,
            (_RUNTIME_ROLE_NAME, _SOLO_RELATION, list(_SOLO_COLUMN_DENIED)),
        ).fetchall()
    )
    problems = [f"lacks {privilege}" for privilege in _SOLO_GRANTED if not granted.get(privilege)]
    held = [
        str(privilege)
        for privilege, has in (*denied_table.items(), *denied_column.items())
        if has
    ]
    if held:
        problems.append(f"holds {', '.join(sorted(held))} (table or column grant)")
    if problems:
        yield Check(
            "FAIL", name, f"{_RUNTIME_ROLE_NAME} on {_SOLO_RELATION}: " + "; ".join(problems)
        )
    else:
        yield Check(
            "OK", name, f"{_RUNTIME_ROLE_NAME} can only SELECT/INSERT {_SOLO_RELATION}"
        )


def _check_runtime_role(connection: Connection) -> Iterable[Check]:
    # app.migrate의 ensure_runtime_role과 같은 기준이다. 읽기만 하고 비밀번호는 건드리지 않는다.
    role = connection.execute(_RUNTIME_ROLE_SQL, (_RUNTIME_ROLE_NAME,)).fetchone()
    if role is None:
        yield Check("FAIL", "runtime-role", f"{_RUNTIME_ROLE_NAME} does not exist")
        return
    can_login, *unsafe_flags = (bool(value) for value in role)
    flag_names = ("SUPERUSER", "CREATEROLE", "CREATEDB", "REPLICATION", "BYPASSRLS")
    problems = [name for name, enabled in zip(flag_names, unsafe_flags, strict=True) if enabled]
    if not can_login:
        problems.insert(0, "NOLOGIN")
    if connection.execute(_RUNTIME_ROLE_MEMBERSHIP_SQL, (_RUNTIME_ROLE_NAME,)).fetchone():
        problems.append("member of another role")
    if problems:
        yield Check(
            "FAIL", "runtime-role", f"{_RUNTIME_ROLE_NAME} is unsafe: {', '.join(problems)}"
        )
    else:
        yield Check("OK", "runtime-role", f"{_RUNTIME_ROLE_NAME} LOGIN without elevated attributes")


def _missing_question_time_columns(connection: Connection) -> str:
    present = _columns(connection, _QUESTION_TIME_TABLES, _QUESTION_TIME_COLUMN)
    missing = [table for table in _QUESTION_TIME_TABLES if table not in present]
    return ", ".join(f"{table}.{_QUESTION_TIME_COLUMN}" for table in missing)


def _runtime_role_exists(connection: Connection) -> bool:
    return connection.execute(_RUNTIME_ROLE_SQL, (_RUNTIME_ROLE_NAME,)).fetchone() is not None


def _check_runtime_function_access(connection: Connection) -> Iterable[Check]:
    name = "runtime-schema-version-access"
    if not _runtime_role_exists(connection):
        yield Check("FAIL", name, f"{_RUNTIME_ROLE_NAME} does not exist")
        return
    if not _fetchone(connection, _FUNCTION_EXISTS_SQL, (_SCHEMA_VERSION_FUNCTION,))[0]:
        yield Check("FAIL", name, f"{_SCHEMA_VERSION_FUNCTION} is missing")
        return
    granted = _fetchone(
        connection, _FUNCTION_PRIVILEGE_SQL, (_RUNTIME_ROLE_NAME, _SCHEMA_VERSION_FUNCTION)
    )[0]
    verb = "can" if granted else "cannot"
    status: Status = "OK" if granted else "FAIL"
    yield Check(status, name, f"{_RUNTIME_ROLE_NAME} {verb} EXECUTE {_SCHEMA_VERSION_FUNCTION}")


def _check_runtime_ledger_access(connection: Connection) -> Iterable[Check]:
    name = "runtime-ledger-access"
    if not _runtime_role_exists(connection):
        yield Check("FAIL", name, f"{_RUNTIME_ROLE_NAME} does not exist")
        return
    if not _fetchone(connection, _LEDGER_EXISTS_SQL)[0]:
        yield Check("FAIL", name, "quiz_online.schema_migrations is missing")
        return
    rows = connection.execute(
        _LEDGER_PRIVILEGES_SQL,
        (
            _RUNTIME_ROLE_NAME,
            list(_LEDGER_COLUMN_PRIVILEGES),
            _RUNTIME_ROLE_NAME,
            list(_LEDGER_TABLE_PRIVILEGES),
        ),
    ).fetchall()
    held = [str(privilege) for privilege, granted in rows if granted]
    if held:
        yield Check(
            "FAIL",
            name,
            f"{_RUNTIME_ROLE_NAME} holds {', '.join(held)} on quiz_online.schema_migrations "
            "(table or column grant)",
        )
    else:
        yield Check(
            "OK", name, f"{_RUNTIME_ROLE_NAME} has no access to quiz_online.schema_migrations"
        )


def _check_runtime_question_time_access(connection: Connection) -> Iterable[Check]:
    name = "runtime-question-time-access"
    if not _runtime_role_exists(connection):
        yield Check("FAIL", name, f"{_RUNTIME_ROLE_NAME} does not exist")
        return
    missing = _missing_question_time_columns(connection)
    if missing:
        yield Check("FAIL", name, f"missing column: {missing}")
        return
    rows = connection.execute(
        _COLUMN_PRIVILEGES_SQL,
        (
            _RUNTIME_ROLE_NAME,
            _QUESTION_TIME_COLUMN,
            list(_QUESTION_TIME_TABLES),
            list(_QUESTION_TIME_PRIVILEGES),
        ),
    ).fetchall()
    lacking = [
        f"{privilege} on {relation}.{_QUESTION_TIME_COLUMN}"
        for relation, privilege, granted in rows
        if not granted
    ]
    privileges = "/".join(_QUESTION_TIME_PRIVILEGES)
    if lacking:
        yield Check("FAIL", name, f"{_RUNTIME_ROLE_NAME} lacks {', '.join(lacking)}")
    else:
        yield Check(
            "OK",
            name,
            f"{_RUNTIME_ROLE_NAME} can {privileges} {_QUESTION_TIME_COLUMN} on "
            + ", ".join(_QUESTION_TIME_TABLES),
        )


def _check_runtime_rankings_access(connection: Connection) -> Iterable[Check]:
    name = "runtime-rankings-access"
    if not _runtime_role_exists(connection):
        yield Check("FAIL", name, f"{_RUNTIME_ROLE_NAME} does not exist")
        return
    if not _rankings_table_exists(connection):
        yield Check("FAIL", name, f"{_RANKINGS_RELATION} is missing")
        return
    granted = dict(
        connection.execute(
            _TABLE_PRIVILEGES_SQL,
            (_RUNTIME_ROLE_NAME, _RANKINGS_RELATION, list(_RANKINGS_GRANTED)),
        ).fetchall()
    )
    denied_table = dict(
        connection.execute(
            _TABLE_PRIVILEGES_SQL,
            (_RUNTIME_ROLE_NAME, _RANKINGS_RELATION, list(_RANKINGS_TABLE_DENIED)),
        ).fetchall()
    )
    denied_column = dict(
        connection.execute(
            _ANY_COLUMN_PRIVILEGES_SQL,
            (_RUNTIME_ROLE_NAME, _RANKINGS_RELATION, list(_RANKINGS_COLUMN_DENIED)),
        ).fetchall()
    )
    prune = _fetchone(connection, _FUNCTION_EXISTS_SQL, (_RANKINGS_PRUNE_FUNCTION,))[0] and (
        _fetchone(
            connection,
            _FUNCTION_PRIVILEGE_SQL,
            (_RUNTIME_ROLE_NAME, _RANKINGS_PRUNE_FUNCTION),
        )[0]
    )
    problems = [
        f"lacks {privilege}" for privilege in _RANKINGS_GRANTED if not granted.get(privilege)
    ]
    held = [
        str(privilege)
        for privilege, has in (*denied_table.items(), *denied_column.items())
        if has
    ]
    if held:
        problems.append(f"holds {', '.join(sorted(held))} (table or column grant)")
    if not prune:
        problems.append(f"cannot EXECUTE {_RANKINGS_PRUNE_FUNCTION}")
    if problems:
        yield Check(
            "FAIL", name, f"{_RUNTIME_ROLE_NAME} on {_RANKINGS_RELATION}: " + "; ".join(problems)
        )
    else:
        yield Check(
            "OK",
            name,
            f"{_RUNTIME_ROLE_NAME} can only SELECT/INSERT {_RANKINGS_RELATION} "
            f"and EXECUTE {_RANKINGS_PRUNE_FUNCTION}",
        )


def _check_logging(connection: Connection) -> Iterable[Check]:
    rows = connection.execute(_LOGGING_SQL, (list(_LOGGING_SETTINGS),)).fetchall()
    return evaluate_logging({str(name): str(setting) for name, setting in rows})


def evaluate_logging(settings: Mapping[str, str]) -> list[Check]:
    """Judge the session's effective logging settings against the README preflight.

    The verified baseline is ``log_statement=none`` with duration logging disabled. Any
    setting that can persist statement text (and so the migrator's ``ALTER ROLE ...
    PASSWORD``) is a blocker; ``log_min_error_statement`` only logs failed statements, so it
    is a warning. Settings this PostgreSQL version does not have are skipped.
    """
    checks: list[Check] = []

    def require(name: str, safe: Callable[[str], bool], expected: str, note: str = "") -> None:
        value = settings.get(name)
        if value is None:
            return
        if safe(value):
            checks.append(Check("OK", name, f"{value}{note}"))
        else:
            checks.append(
                Check(
                    "FAIL",
                    name,
                    f"{value}{note}, expected {expected}: statement text would be logged",
                )
            )

    require("log_statement", lambda value: value == "none", "none")
    require("log_min_duration_statement", lambda value: value == "-1", "-1")
    require("log_duration", lambda value: value == "off", "off")

    # 표본 로깅은 log_statement_sample_rate가 0이면 아무것도 남기지 않는다.
    sample_rate = settings.get("log_statement_sample_rate", "1")
    require(
        "log_min_duration_sample",
        lambda value: value == "-1" or _float(sample_rate) == 0,
        "-1",
        "" if settings.get("log_min_duration_sample") == "-1" else f" at sample rate {sample_rate}",
    )
    require("log_transaction_sample_rate", lambda value: _float(value) == 0, "0")

    error_statement = settings.get("log_min_error_statement")
    if error_statement == "panic":
        checks.append(Check("OK", "log_min_error_statement", error_statement))
    elif error_statement is not None:
        checks.append(
            Check(
                "WARN",
                "log_min_error_statement",
                f"{error_statement}: {_ALTER_ROLE_LOG_REASON}",
            )
        )
    return checks


def _float(value: str) -> float:
    try:
        return float(value)
    except ValueError:
        return float("nan")


def _check_logging_overrides(connection: Connection) -> Iterable[Check]:
    rows = connection.execute(_LOGGING_OVERRIDES_SQL).fetchall()
    return evaluate_logging_overrides(
        (str(database), str(role), list(config or ())) for database, role, config in rows
    )


def evaluate_logging_overrides(
    rows: Iterable[tuple[str, str, Sequence[str]]],
) -> list[Check]:
    """Warn about ALTER DATABASE/ROLE ... SET rows that touch logging.

    The session values above already include the overrides that apply to the migrator here.
    Other rows decide what other sessions log, so they are shown, but only their logging
    entries — the rest of ``setconfig`` is never printed.
    """
    checks: list[Check] = []
    for database, role, config in rows:
        entries = [entry for entry in config if "log" in entry.partition("=")[0].lower()]
        if entries:
            scope = f"database={database} role={role}"
            checks.append(
                Check(
                    "WARN",
                    "logging-overrides",
                    f"{scope} {' '.join(entries)}: {_ALTER_ROLE_LOG_REASON}",
                )
            )
    if not checks:
        checks.append(
            Check("OK", "logging-overrides", "no per-database or per-role logging settings")
        )
    return checks


def _check_migration_lock(connection: Connection) -> Iterable[Check]:
    high, low = _ADVISORY_LOCK_KEY >> 32, _ADVISORY_LOCK_KEY & 0xFFFF_FFFF
    holders = int(_fetchone(connection, _MIGRATION_LOCK_SQL, (high, low))[0])
    if holders:
        yield Check("WARN", "migration-lock", "held by another session: app.migrate is running")
    else:
        yield Check("OK", "migration-lock", "not held")


def _check_active_matches(connection: Connection, require_idle: bool) -> Iterable[Check]:
    running, revealing = (int(value) for value in _fetchone(connection, _ACTIVE_MATCHES_SQL))
    total = running + revealing
    detail = f"{total} (running {running}, revealing {revealing})"
    if require_idle and total:
        yield Check("FAIL", "active-matches", f"{detail}; --require-idle needs 0")
    else:
        yield Check("INFO", "active-matches", detail)


def _check_recent_members(connection: Connection) -> Iterable[Check]:
    row = _fetchone(connection, _RECENT_MEMBERS_SQL, (RECENT_MEMBER_WINDOW,))
    members, rooms = (int(value) for value in row)
    minutes = int(RECENT_MEMBER_WINDOW.total_seconds() // 60)
    yield Check(
        "INFO", "recent-members", f"{members} in {rooms} rooms seen within {minutes} minutes"
    )


def _integers(definition: str) -> frozenset[int]:
    return frozenset(int(value) for value in _INTEGER.findall(definition))


def _join(values: Iterable[int]) -> str:
    return ", ".join(str(value) for value in values)


# ── bank ───────────────────────────────────────────────────────────────────────


def run_bank_checks(environment: Mapping[str, str]) -> list[Check]:
    """Validate the mounted private bank the way the API will load it, without content."""
    configured = environment.get("QUESTION_BANK_DIR", "").strip()
    if not configured:
        return [Check("FAIL", "bank-dir", "QUESTION_BANK_DIR is not set")]
    directory = Path(configured)

    checks: list[Check] = []
    if is_public_pages_question_bank(directory):
        checks.append(
            Check(
                "FAIL",
                "bank-dir",
                f"{directory} is the public Pages data/ directory; the API refuses to start on it",
            )
        )
    else:
        checks.append(Check("OK", "bank-dir", str(directory)))

    try:
        catalog = QuestionCatalog.from_directory(directory)
    except CatalogError as error:
        # 오류 문장에 문항 ID가 들어갈 수 있다(«duplicate question id: …»). 알려진 ID는 가린다.
        message = _redact_ids(str(error), _raw_bank_ids(directory))
        checks.append(Check("FAIL", "catalog", f"{type(error).__name__}: {message}"))
        return checks

    total = sum(len(questions) for questions in catalog.by_category.values())
    checks.append(
        Check("OK", "catalog", f"{total} questions in {len(catalog.by_category)} categories")
    )
    for category in CATEGORY_IDS:
        count = len(catalog.by_category[category])
        status: Status = "OK" if count >= QUESTIONS_PER_CATEGORY_ROUND else "FAIL"
        checks.append(
            Check(
                status,
                f"category-{category}",
                f"{count} questions (a category round needs {QUESTIONS_PER_CATEGORY_ROUND})",
            )
        )

    ids = [
        (category, question.id)
        for category, questions in catalog.by_category.items()
        for question in questions
    ]
    too_long = sum(1 for _, question_id in ids if len(question_id) > QUESTION_ID_MAX_LENGTH)
    column = f"match_questions.question_id is varchar({QUESTION_ID_MAX_LENGTH})"
    if too_long:
        checks.append(
            Check(
                "FAIL",
                "id-length",
                f"{too_long} of {len(ids)} ids exceed {QUESTION_ID_MAX_LENGTH} characters "
                f"({column}; a match that draws one cannot start)",
            )
        )
    else:
        checks.append(
            Check(
                "OK",
                "id-length",
                f"all {len(ids)} ids fit {QUESTION_ID_MAX_LENGTH} characters ({column})",
            )
        )

    # 계약(ONLINE_QUESTION_BANK.md)은 online- 접두사를 예로만 든다. 공개 번호 모양만 막고
    # 나머지는 알린다.
    unprefixed = sum(1 for _, question_id in ids if not question_id.startswith(ONLINE_ID_PREFIX))
    public_shaped = sum(1 for _, question_id in ids if _PUBLIC_PAGES_ID.fullmatch(question_id))
    if public_shaped:
        checks.append(
            Check(
                "FAIL",
                "id-prefix",
                f"{public_shaped} of {len(ids)} ids have the public Pages form "
                "<category>-<digits> (a kept public id marks a likely copy of the public bank, "
                "and its issue reports collide with public question numbers)",
            )
        )
    elif unprefixed:
        checks.append(
            Check(
                "WARN",
                "id-prefix",
                f"{unprefixed} of {len(ids)} ids lack the {ONLINE_ID_PREFIX} prefix "
                "the bank contract uses",
            )
        )
    else:
        checks.append(Check("OK", "id-prefix", f"all {len(ids)} ids start with {ONLINE_ID_PREFIX}"))

    # «이 문제 이상해요»는 ID를 공개 이슈에 싣는다. 번호만 쓰는 모양이어야 내용이 새지 않는다.
    irregular = sum(
        1
        for category, question_id in ids
        if re.fullmatch(rf"{re.escape(ONLINE_ID_PREFIX)}{category}-[0-9]+", question_id) is None
    )
    if irregular:
        checks.append(
            Check(
                "WARN",
                "id-format",
                f"{irregular} of {len(ids)} ids do not match online-<category>-<digits>; "
                "ids reach public issue reports, so keep them content-free",
            )
        )
    else:
        checks.append(Check("OK", "id-format", "all ids match online-<category>-<digits>"))

    checks.append(_check_bank_permissions(directory))
    return checks


def _check_bank_permissions(directory: Path) -> Check:
    # README: 디렉터리 0700(또는 0750), 파일 0640. 어느 쪽이든 «그 밖의 사용자»에게는 권한이 없다.
    if os.name != "posix":
        return Check("INFO", "bank-permissions", "skipped: not a POSIX filesystem")
    exposed = [
        path.name or str(path)
        for path in (directory, *(directory / f"{category}.json" for category in CATEGORY_IDS))
        if stat.S_IMODE(path.stat().st_mode) & 0o007
    ]
    if exposed:
        return Check(
            "WARN",
            "bank-permissions",
            f"other users have access to {', '.join(exposed)} "
            "(expected directory 0700 or 0750, files 0640)",
        )
    return Check("OK", "bank-permissions", "no access for other users")


def _raw_bank_ids(directory: Path) -> set[str]:
    ids: set[str] = set()
    for category in CATEGORY_IDS:
        try:
            raw = json.loads((directory / f"{category}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(raw, list):
            ids.update(
                item["id"]
                for item in raw
                if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]
            )
    return ids


def _redact_ids(message: str, ids: Iterable[str]) -> str:
    for question_id in sorted(ids, key=len, reverse=True):
        message = message.replace(question_id, "<id>")
    return message


# ── CLI ────────────────────────────────────────────────────────────────────────


def report(checks: Sequence[Check]) -> int:
    failures = sum(1 for check in checks if check.status == "FAIL")
    warnings = sum(1 for check in checks if check.status == "WARN")
    for check in checks:
        print(check.render())
    verdict = "FAIL" if failures else "OK"
    print(f"{verdict} result {failures} FAIL, {warnings} WARN")
    return 1 if failures else 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.release_check",
        description="Read-only quiz-by-quiz release checks. Exit 0 iff no line is FAIL.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    database = commands.add_parser(
        "db",
        help="check the migration ledger, schema, runtime grants, logging and activity",
    )
    database.add_argument(
        "--expect",
        type=int,
        choices=EXPECTABLE_VERSIONS,
        required=True,
        help="the migration the database must be at",
    )
    database.add_argument(
        "--require-idle",
        action="store_true",
        help="fail while any match is running or revealing",
    )
    database.add_argument(
        "--require-default-question-time",
        action="store_true",
        help=(
            "fail while any room or match has a question time other than 20000 "
            "(after migration 011, before its candidate API replaces the migration-010 API; "
            "needs --expect 11)"
        ),
    )
    database.add_argument(
        "--require-empty-rankings",
        action="store_true",
        help=(
            "fail while the online ranking table holds a record "
            "(after migration 012, before its candidate API replaces the migration-011 API; "
            "needs --expect 12)"
        ),
    )
    database.add_argument(
        "--require-empty-solo-rooms",
        action="store_true",
        help=(
            "fail while a solo room exists "
            "(after migration 013, before the candidate API replaces the migration-012 API; "
            "needs --expect 13)"
        ),
    )
    commands.add_parser("bank", help="check the private online question bank at QUESTION_BANK_DIR")
    return parser


def main(
    argv: Sequence[str] | None = None,
    environment: Mapping[str, str] | None = None,
) -> int:
    parser = _parser()
    arguments = parser.parse_args(argv)
    if (
        arguments.command == "db"
        and arguments.require_default_question_time
        and arguments.expect != 11
    ):
        parser.error("--require-default-question-time needs --expect 11")
    if arguments.command == "db" and arguments.require_empty_rankings and arguments.expect != 12:
        parser.error("--require-empty-rankings needs --expect 12")
    if (
        arguments.command == "db"
        and arguments.require_empty_solo_rooms
        and arguments.expect != 13
    ):
        parser.error("--require-empty-solo-rooms needs --expect 13")
    source = os.environ if environment is None else environment
    try:
        if arguments.command == "db":
            checks = run_database_checks(
                source,
                expect=arguments.expect,
                require_idle=arguments.require_idle,
                require_default_question_time=arguments.require_default_question_time,
                require_empty_rankings=arguments.require_empty_rankings,
                require_empty_solo_rooms=arguments.require_empty_solo_rooms,
            )
        else:
            checks = run_bank_checks(source)
    except Exception as error:  # pragma: no cover - last-resort guard; never print details
        checks = [Check("FAIL", "internal", type(error).__name__)]
    return report(checks)


if __name__ == "__main__":
    sys.exit(main())
