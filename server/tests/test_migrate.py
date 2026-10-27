from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from psycopg import errors, pq

from app import migrate
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


# ── main(): 실패한 migration의 원래 오류를 알리고 잠금을 푼다 ─────────────────────────


_IDLE = pq.TransactionStatus.IDLE
_INTRANS = pq.TransactionStatus.INTRANS
_INERROR = pq.TransactionStatus.INERROR
# 서버·드라이버의 오류 문장에는 접속 정보가 섞일 수 있다. main()은 이것을 한 글자도 내지 않는다.
_LEAKY_MESSAGE = "password=leaked-migrator-secret"


class _MainConnection:
    """Mimics the server: once a statement fails inside BEGIN, only ROLLBACK is accepted."""

    def __init__(
        self,
        *,
        applied_versions: list[int] | None = None,
        unlock_error: Exception | None = None,
    ) -> None:
        self._applied_versions = applied_versions
        self._unlock_error = unlock_error
        self.info = SimpleNamespace(transaction_status=_IDLE)
        self.executed: list[str] = []
        self.lock_held = False
        self.closed = False

    def __enter__(self) -> _MainConnection:
        return self

    def __exit__(self, *_: object) -> None:
        self.closed = True

    def execute(self, statement: object, params: tuple[object, ...] = ()) -> _Cursor:
        rendered = str(statement)
        self.executed.append(rendered)
        if rendered == "ROLLBACK":
            self.info.transaction_status = _IDLE
            return _Cursor([])
        if self.info.transaction_status == _INERROR:
            raise errors.InFailedSqlTransaction(
                "current transaction is aborted, commands ignored until end of transaction block"
            )
        if "pg_advisory_lock" in rendered:
            self.lock_held = True
        elif "pg_advisory_unlock" in rendered:
            if self._unlock_error is not None:
                raise self._unlock_error
            self.lock_held = False
        elif rendered == "SELECT version FROM quiz_online.schema_migrations":
            if self._applied_versions is None:
                raise errors.UndefinedTable("relation does not exist")
            return _Cursor([(version,) for version in self._applied_versions])
        elif rendered.startswith("BEGIN;"):
            self.info.transaction_status = _INTRANS
            if "VIOLATE" in rendered:
                self.info.transaction_status = _INERROR
                raise errors.CheckViolation(_LEAKY_MESSAGE)
            if rendered.rstrip().endswith("COMMIT;"):
                self.info.transaction_status = _IDLE
        return _Cursor([])


def _run_main(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    connection: _MainConnection,
    migration_sql: tuple[str, ...],
) -> int:
    migrations = []
    for version, text in enumerate(migration_sql, start=1):
        path = tmp_path / f"{version:03d}_step.sql"
        path.write_text(text, encoding="utf-8")
        migrations.append(Migration(version=version, path=path))
    monkeypatch.setenv("MIGRATOR_DATABASE_URL", "postgresql://migration-owner")
    monkeypatch.setenv("QUIZ_DB_PASSWORD", "test-runtime-password")
    monkeypatch.setattr(migrate, "discover_migrations", lambda: tuple(migrations))
    monkeypatch.setattr(migrate, "ensure_runtime_role", lambda _connection, _password: None)
    monkeypatch.setattr(migrate.psycopg, "connect", lambda *_args, **_kwargs: connection)
    return migrate.main()


def test_main_reports_the_failing_statement_not_the_masked_unlock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    connection = _MainConnection()

    status = _run_main(
        monkeypatch,
        tmp_path,
        connection,
        ("BEGIN;\nSELECT 'ok';\nCOMMIT;\n", "BEGIN;\nSELECT 'VIOLATE';\nCOMMIT;\n"),
    )

    captured = capsys.readouterr()
    assert status == 1
    # 예전에는 잠금 해제가 InFailedSqlTransaction(25P02)으로 원래 오류를 덮었다
    assert captured.err == "quiz-by-quiz migration failed: CheckViolation (SQLSTATE 23514)\n"
    assert captured.out == ""
    assert _LEAKY_MESSAGE not in captured.err
    # 실패한 BEGIN을 먼저 되돌린 뒤 잠금을 푼다
    assert connection.executed[-2:] == ["ROLLBACK", "SELECT pg_advisory_unlock(%s)"]
    assert connection.lock_held is False
    assert connection.info.transaction_status == _IDLE
    assert connection.closed is True


def test_main_keeps_the_original_error_when_the_unlock_fails_too(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    connection = _MainConnection(unlock_error=errors.OperationalError("connection lost"))

    status = _run_main(
        monkeypatch, tmp_path, connection, ("BEGIN;\nSELECT 'VIOLATE';\nCOMMIT;\n",)
    )

    captured = capsys.readouterr()
    assert status == 1
    assert captured.err == "quiz-by-quiz migration failed: CheckViolation (SQLSTATE 23514)\n"
    assert connection.executed[-2:] == ["ROLLBACK", "SELECT pg_advisory_unlock(%s)"]
    assert connection.closed is True


def test_main_refuses_a_migration_that_leaves_its_transaction_open(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    connection = _MainConnection()

    status = _run_main(monkeypatch, tmp_path, connection, ("BEGIN;\nSELECT 'no commit';\n",))

    captured = capsys.readouterr()
    assert status == 1
    # 열린 채로 되돌리고 «applied»라고 말하지 않는다
    assert captured.err == "quiz-by-quiz migration failed: MigrationError\n"
    assert captured.out == ""
    assert connection.executed[-2:] == ["ROLLBACK", "SELECT pg_advisory_unlock(%s)"]
    assert connection.lock_held is False


def test_main_reports_a_non_database_error_by_class_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("MIGRATOR_DATABASE_URL", raising=False)

    assert migrate.main() == 1

    captured = capsys.readouterr()
    assert captured.err == "quiz-by-quiz migration failed: MigrationError\n"
    assert captured.out == ""


@pytest.mark.parametrize(
    ("applied_versions", "expected"),
    [
        (None, "quiz-by-quiz migrations applied: 1, 2\n"),
        ([1, 2], "quiz-by-quiz migrations already current\n"),
    ],
)
def test_main_success_output_is_unchanged_and_releases_the_lock(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    applied_versions: list[int] | None,
    expected: str,
) -> None:
    connection = _MainConnection(applied_versions=applied_versions)

    status = _run_main(
        monkeypatch,
        tmp_path,
        connection,
        ("BEGIN;\nSELECT 1;\nCOMMIT;\n", "BEGIN;\nSELECT 2;\nCOMMIT;\n"),
    )

    captured = capsys.readouterr()
    assert status == 0
    assert captured.out == expected
    assert captured.err == ""
    assert "ROLLBACK" not in connection.executed
    assert connection.executed[-1] == "SELECT pg_advisory_unlock(%s)"
    assert connection.lock_held is False
