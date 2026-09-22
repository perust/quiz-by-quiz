from __future__ import annotations

import os
import re
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
from psycopg import errors, sql

_MIGRATIONS_DIR = Path(__file__).parents[1] / "migrations"
_MIGRATION_NAME = re.compile(r"^(?P<version>[0-9]{3})_[a-z0-9_]+\.sql$")
_ADVISORY_LOCK_KEY = 854_217_903
_RUNTIME_ROLE_NAME = "quiz_by_quiz_app"
_RUNTIME_ROLE_PASSWORD_ENV = "QUIZ_DB_PASSWORD"  # noqa: S105 - environment variable name only


class MigrationError(RuntimeError):
    """Raised when the immutable migration sequence cannot be applied safely."""


@dataclass(frozen=True)
class Migration:
    version: int
    path: Path


def discover_migrations(directory: Path = _MIGRATIONS_DIR) -> tuple[Migration, ...]:
    migrations: list[Migration] = []
    for path in directory.iterdir():
        if not path.is_file():
            continue
        matched = _MIGRATION_NAME.fullmatch(path.name)
        if matched is None:
            continue
        migrations.append(Migration(version=int(matched["version"]), path=path))

    migrations.sort(key=lambda migration: migration.version)
    if not migrations:
        raise MigrationError("no numbered SQL migrations were found")
    versions = [migration.version for migration in migrations]
    if len(set(versions)) != len(versions):
        raise MigrationError("migration versions must be unique")
    expected = list(range(1, versions[-1] + 1))
    if versions != expected:
        raise MigrationError("migration versions must be contiguous starting at 001")
    return tuple(migrations)


def migrator_database_url(environment: Mapping[str, str] | None = None) -> str:
    source = os.environ if environment is None else environment
    database_url = source.get("MIGRATOR_DATABASE_URL", "").strip()
    if not database_url:
        raise MigrationError("MIGRATOR_DATABASE_URL is required")
    return database_url


def runtime_role_password(environment: Mapping[str, str] | None = None) -> str:
    source = os.environ if environment is None else environment
    password = source.get(_RUNTIME_ROLE_PASSWORD_ENV, "")
    if not password or "\x00" in password:
        raise MigrationError(f"{_RUNTIME_ROLE_PASSWORD_ENV} is required")
    return password


def _runtime_role_statement(prefix: str, password: str) -> sql.Composed:
    if prefix == "CREATE ROLE":
        verb = sql.SQL("CREATE ROLE")
    elif prefix == "ALTER ROLE":
        verb = sql.SQL("ALTER ROLE")
    else:  # pragma: no cover - internal fixed call sites only
        raise ValueError("unsupported runtime-role statement")
    return sql.SQL(
        "{} {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        "NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {}"
    ).format(
        verb,
        sql.Identifier(_RUNTIME_ROLE_NAME),
        sql.Literal(password),
    )


def ensure_runtime_role(connection: Any, password: str) -> None:
    role_cursor = connection.execute(
        """
        SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
        FROM pg_roles
        WHERE rolname = %s
        """,
        (_RUNTIME_ROLE_NAME,),
    )
    role = role_cursor.fetchone()
    if role is None:
        connection.execute(_runtime_role_statement("CREATE ROLE", password))
        return

    can_login, is_superuser, can_create_role, can_create_database, can_replicate, bypass_rls = (
        bool(value) for value in role
    )
    if not can_login or any(
        (is_superuser, can_create_role, can_create_database, can_replicate, bypass_rls)
    ):
        raise MigrationError("existing runtime role is unsafe")

    membership_cursor = connection.execute(
        """
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = %s
        LIMIT 1
        """,
        (_RUNTIME_ROLE_NAME,),
    )
    if membership_cursor.fetchone() is not None:
        raise MigrationError("existing runtime role has unexpected membership")

    connection.execute(_runtime_role_statement("ALTER ROLE", password))


def _applied_versions(connection: Any) -> set[int]:
    try:
        cursor = connection.execute("SELECT version FROM quiz_online.schema_migrations")
    except errors.UndefinedTable:
        return set()
    return {int(row[0]) for row in cursor.fetchall()}


def _verify_applied_sequence(applied: set[int], migrations: Iterable[Migration]) -> None:
    known = {migration.version for migration in migrations}
    unknown = applied - known
    if unknown:
        raise MigrationError("database contains migration versions unavailable in this image")
    if applied and applied != set(range(1, max(applied) + 1)):
        raise MigrationError("database migration history is not contiguous")


def apply_pending(connection: Any, migrations: Iterable[Migration]) -> tuple[int, ...]:
    ordered = tuple(migrations)
    applied = _applied_versions(connection)
    _verify_applied_sequence(applied, ordered)
    installed: list[int] = []
    for migration in ordered:
        if migration.version in applied:
            continue
        connection.execute(migration.path.read_text(encoding="utf-8"))
        installed.append(migration.version)
    return tuple(installed)


def main() -> int:
    try:
        migrations = discover_migrations()
        database_url = migrator_database_url()
        password = runtime_role_password()
        with psycopg.connect(database_url, autocommit=True) as connection:
            connection.execute("SET lock_timeout = '15s'")
            connection.execute("SELECT pg_advisory_lock(%s)", (_ADVISORY_LOCK_KEY,))
            try:
                ensure_runtime_role(connection, password)
                installed = apply_pending(connection, migrations)
            finally:
                connection.execute("SELECT pg_advisory_unlock(%s)", (_ADVISORY_LOCK_KEY,))
    except Exception as error:
        print(f"quiz-by-quiz migration failed: {type(error).__name__}", file=sys.stderr)
        return 1

    if installed:
        versions = ", ".join(str(version) for version in installed)
        print(f"quiz-by-quiz migrations applied: {versions}")
    else:
        print("quiz-by-quiz migrations already current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
