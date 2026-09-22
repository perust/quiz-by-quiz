from __future__ import annotations

import pytest

from app.migrate import (
    Migration,
    MigrationError,
    apply_pending,
    discover_migrations,
    ensure_runtime_role,
    migrator_database_url,
    runtime_role_password,
)


class _Cursor:
    def __init__(self, rows: list[tuple[int]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[int]]:
        return self._rows


class _Connection:
    def __init__(self, applied_versions: list[int]) -> None:
        self._applied_versions = applied_versions
        self.executed: list[str] = []

    def execute(self, statement: str) -> _Cursor:
        self.executed.append(statement)
        if statement == "SELECT version FROM quiz_online.schema_migrations":
            return _Cursor([(version,) for version in self._applied_versions])
        return _Cursor([])


class _RoleCursor:
    def __init__(self, row: tuple[bool, ...] | tuple[int] | None) -> None:
        self._row = row

    def fetchone(self) -> tuple[bool, ...] | tuple[int] | None:
        return self._row


class _RoleConnection:
    def __init__(
        self,
        role: tuple[bool, ...] | None,
        *,
        has_membership: bool = False,
    ) -> None:
        self.role = role
        self.has_membership = has_membership
        self.executed: list[tuple[str, tuple[object, ...]]] = []

    def execute(self, statement: object, params: tuple[object, ...] = ()) -> _RoleCursor:
        rendered = str(statement)
        self.executed.append((rendered, params))
        if "pg_roles" in rendered:
            return _RoleCursor(self.role)
        if "pg_auth_members" in rendered:
            return _RoleCursor((1,) if self.has_membership else None)
        return _RoleCursor(None)


def _safe_runtime_role() -> tuple[bool, ...]:
    # rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    return (True, False, False, False, False, False)


def test_discover_migrations_requires_contiguous_numbered_sql_files(tmp_path) -> None:
    (tmp_path / "001_initial.sql").write_text("SELECT 1;", encoding="utf-8")
    (tmp_path / "002_add_matches.sql").write_text("SELECT 2;", encoding="utf-8")

    migrations = discover_migrations(tmp_path)

    assert [migration.version for migration in migrations] == [1, 2]
    assert [migration.path.name for migration in migrations] == [
        "001_initial.sql",
        "002_add_matches.sql",
    ]


def test_discover_migrations_rejects_a_version_gap(tmp_path) -> None:
    (tmp_path / "001_initial.sql").write_text("SELECT 1;", encoding="utf-8")
    (tmp_path / "003_later.sql").write_text("SELECT 3;", encoding="utf-8")

    with pytest.raises(MigrationError, match="contiguous"):
        discover_migrations(tmp_path)


def test_apply_pending_skips_versions_recorded_by_the_database(tmp_path) -> None:
    first = tmp_path / "001_initial.sql"
    second = tmp_path / "002_matches.sql"
    first.write_text("SELECT 'first';", encoding="utf-8")
    second.write_text("SELECT 'second';", encoding="utf-8")
    connection = _Connection(applied_versions=[1])

    installed = apply_pending(
        connection,
        (
            Migration(version=1, path=first),
            Migration(version=2, path=second),
        ),
    )

    assert installed == (2,)
    assert connection.executed == [
        "SELECT version FROM quiz_online.schema_migrations",
        "SELECT 'second';",
    ]


def test_migrator_database_url_is_required_and_separate_from_app_database_url(monkeypatch) -> None:
    monkeypatch.delenv("MIGRATOR_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://app-role-only")

    with pytest.raises(MigrationError, match="MIGRATOR_DATABASE_URL"):
        migrator_database_url()

    monkeypatch.setenv("MIGRATOR_DATABASE_URL", "postgresql://migration-owner")
    assert migrator_database_url() == "postgresql://migration-owner"


def test_runtime_role_password_is_required_separately_from_database_urls() -> None:
    with pytest.raises(MigrationError, match="QUIZ_DB_PASSWORD"):
        runtime_role_password({"MIGRATOR_DATABASE_URL": "postgresql://migration-owner"})

    environment = {"QUIZ_DB_PASSWORD": "test-runtime-password"}
    assert runtime_role_password(environment) == "test-runtime-password"


def test_ensure_runtime_role_creates_a_missing_constrained_login() -> None:
    connection = _RoleConnection(role=None)

    ensure_runtime_role(connection, "test-runtime-password")

    rendered = "\n".join(statement for statement, _ in connection.executed)
    assert "pg_roles" in rendered
    assert "CREATE ROLE" in rendered
    assert "quiz_by_quiz_app" in rendered
    assert "NOSUPERUSER" in rendered
    assert "NOCREATEDB" in rendered
    assert "NOCREATEROLE" in rendered
    assert "NOREPLICATION" in rendered
    assert "NOBYPASSRLS" in rendered
    assert "NOINHERIT" in rendered


def test_ensure_runtime_role_rejects_privileged_or_member_existing_roles() -> None:
    privileged = _RoleConnection(role=(True, True, False, False, False, False))
    with pytest.raises(MigrationError, match="unsafe"):
        ensure_runtime_role(privileged, "test-runtime-password")

    member = _RoleConnection(role=_safe_runtime_role(), has_membership=True)
    with pytest.raises(MigrationError, match="membership"):
        ensure_runtime_role(member, "test-runtime-password")
