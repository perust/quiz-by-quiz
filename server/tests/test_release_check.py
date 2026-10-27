"""운영자 점검 도구(`python -m app.release_check`)를 확인한다.

bank는 임시 디렉터리에서 돈다. db는 `python -m app.migrate`를 마친 MIGRATOR_DATABASE_URL에서 돌고,
그 값이 없으면 다른 integration test처럼 건너뛴다. migration 10의 DB는 같은 DB 안에서 001..010을
한 transaction으로 다시 깔아 만들고 끝나면 되돌린다 — 다른 DB나 schema를 만들지 않는다.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from app import release_check
from app.config import PUBLIC_PAGES_DATA_DIR
from app.migrate import _ADVISORY_LOCK_KEY, discover_migrations
from app.release_check import Check, check_database, evaluate_logging, evaluate_logging_overrides

CATEGORIES = ("history", "science", "geography", "general", "art")
SOURCE = Path(release_check.__file__).read_text(encoding="utf-8")
MIGRATOR_URL = os.getenv("MIGRATOR_DATABASE_URL")

# 문항 내용이 출력에 새는지 보려고 모든 글에 이 표식을 붙인다.
_CONTENT_MARK = "PRIVATE-CONTENT"
# 세션을 여는 SET 셋. 이 밖의 문장은 SELECT·SHOW뿐이어야 한다.
_SESSION_SETS = (
    "SET default_transaction_read_only = on",
    "SET statement_timeout = '15s'",
    "SET lock_timeout = '5s'",
)
_WRITE_WORDS = re.compile(
    r"\b(insert|update|delete|merge|alter|create|drop|grant|revoke|truncate|copy|comment|"
    r"vacuum|analyze|reindex|cluster|refresh|lock|call|do|nextval|setval|set_config|"
    r"pg_advisory_\w+|pg_terminate_backend|pg_cancel_backend|lo_\w+|dblink\w*)\b",
    re.IGNORECASE,
)


# ── bank ───────────────────────────────────────────────────────────────────────


def _question(category: str, number: int, question_id: str | None = None) -> dict[str, object]:
    return {
        "id": question_id or f"online-{category}-{number:03d}",
        "category": category,
        "question": f"{_CONTENT_MARK} question {category} {number}?",
        "choices": [f"{_CONTENT_MARK} choice {choice} {number}" for choice in range(4)],
        "answerIndex": number % 4,
        "explanation": f"{_CONTENT_MARK} explanation {number}",
        "difficulty": "normal",
        "tags": [],
    }


def _write_bank(
    root: Path,
    *,
    counts: Mapping[str, int] | None = None,
    make_id: Callable[[str, int], str | None] | None = None,
) -> list[str]:
    root.mkdir(exist_ok=True)
    ids: list[str] = []
    for category in CATEGORIES:
        questions = [
            _question(category, number, make_id(category, number) if make_id else None)
            for number in range((counts or {}).get(category, 10))
        ]
        ids += [str(question["id"]) for question in questions]
        (root / f"{category}.json").write_text(json.dumps(questions), encoding="utf-8")
    if os.name == "posix":
        root.chmod(0o750)
        for category in CATEGORIES:
            (root / f"{category}.json").chmod(0o640)
    return ids


def _run_bank(directory: Path | str | None, capsys: pytest.CaptureFixture[str]) -> tuple[int, str]:
    environment = {} if directory is None else {"QUESTION_BANK_DIR": str(directory)}
    status = release_check.main(["bank"], environment)
    return status, capsys.readouterr().out


def _lines(output: str) -> dict[str, list[str]]:
    by_name: dict[str, list[str]] = {}
    for line in output.splitlines():
        status, name, *_ = line.split(" ", 2) + [""]
        assert status in {"OK", "FAIL", "WARN", "INFO"}, line
        by_name.setdefault(name, []).append(status)
    return by_name


def _assert_no_content(output: str, ids: list[str]) -> None:
    assert _CONTENT_MARK not in output
    for question_id in ids:
        assert question_id not in output


def test_bank_accepts_a_private_online_bank_without_printing_content(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _write_bank(tmp_path / "bank")

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 0
    lines = _lines(output)
    assert all(state in {"OK", "INFO"} for states in lines.values() for state in states)
    for category in CATEGORIES:
        assert f"OK category-{category} 10 questions" in output
    assert "OK id-prefix all 50 ids start with online-" in output
    assert "OK id-format" in output
    assert output.splitlines()[-1] == "OK result 0 FAIL, 0 WARN"
    _assert_no_content(output, ids)


def test_bank_fails_a_category_shorter_than_a_round(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _write_bank(tmp_path / "bank", counts={"art": 9})

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 1
    assert "FAIL category-art 9 questions (a category round needs 10)" in output
    assert "OK category-history 10 questions" in output
    _assert_no_content(output, ids)


def test_bank_fails_ids_without_the_online_prefix(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # 공개 Pages와 같은 모양의 ID다. 그대로 쓰면 공개 은행에서 답을 찾을 수 있다.
    ids = _write_bank(
        tmp_path / "bank",
        make_id=lambda category, number: (
            f"{category}-{number:03d}" if number < 3 else f"online-{category}-{number:03d}"
        ),
    )

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 1
    assert "FAIL id-prefix 15 of 50 ids lack the online- prefix" in output
    assert "WARN id-format 15 of 50 ids" in output
    _assert_no_content(output, ids)


def test_bank_warns_on_ids_that_carry_more_than_a_number(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _write_bank(
        tmp_path / "bank",
        make_id=lambda category, number: (
            f"online-{category}-hangul-{number}" if number == 0 else f"online-{category}-{number}"
        ),
    )

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 0
    assert "OK id-prefix" in output
    assert "WARN id-format 5 of 50 ids do not match online-<category>-<digits>" in output
    assert output.splitlines()[-1] == "OK result 0 FAIL, 1 WARN"
    _assert_no_content(output, ids)


def test_bank_reports_a_catalog_error_with_its_class_and_message(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _write_bank(tmp_path / "bank")
    (tmp_path / "bank" / "art.json").unlink()

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 1
    assert "FAIL catalog CatalogError: required static question file is missing: art.json" in output
    assert "category-" not in output
    _assert_no_content(output, ids)


def test_bank_catalog_error_never_echoes_a_question_id(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _write_bank(
        tmp_path / "bank",
        make_id=lambda category, number: (
            "online-shared-777" if number == 0 and category in {"history", "art"} else None
        ),
    )

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 1
    assert "FAIL catalog CatalogError: duplicate question id: <id>" in output
    _assert_no_content(output, ids)


def test_bank_requires_question_bank_dir(capsys: pytest.CaptureFixture[str]) -> None:
    status, output = _run_bank(None, capsys)

    assert status == 1
    assert "FAIL bank-dir QUESTION_BANK_DIR is not set" in output


def test_bank_refuses_the_directory_the_api_treats_as_public(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _write_bank(tmp_path / "data", make_id=lambda category, number: f"{category}-{number}")
    monkeypatch.setattr("app.config.PUBLIC_PAGES_DATA_DIR", tmp_path / "data")

    status, output = _run_bank(tmp_path / "data", capsys)

    assert status == 1
    assert "public Pages data/ directory; the API refuses to start on it" in output
    assert _lines(output)["bank-dir"] == ["FAIL"]
    assert "FAIL id-prefix 50 of 50 ids" in output
    _assert_no_content(output, ids)


@pytest.mark.skipif(
    not (PUBLIC_PAGES_DATA_DIR / "history.json").exists(),
    reason="the public Pages data/ directory is not in this build context",
)
def test_bank_refuses_the_real_public_pages_data_directory(
    capsys: pytest.CaptureFixture[str],
) -> None:
    public_ids = [
        str(item["id"])
        for category in CATEGORIES
        for item in json.loads(
            (PUBLIC_PAGES_DATA_DIR / f"{category}.json").read_text(encoding="utf-8")
        )
    ]

    status, output = _run_bank(PUBLIC_PAGES_DATA_DIR, capsys)

    assert status == 1
    assert "FAIL bank-dir" in output and "public Pages data/ directory" in output
    assert "FAIL id-prefix" in output
    for question_id in public_ids:
        assert question_id not in output


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits only")
def test_bank_warns_when_other_users_can_read_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write_bank(tmp_path / "bank")
    (tmp_path / "bank" / "science.json").chmod(0o644)

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 0
    assert "WARN bank-permissions other users have access to science.json" in output


# ── db without a database ──────────────────────────────────────────────────────


class _RecordingEnvironment(dict[str, str]):
    def __init__(self, values: Mapping[str, str]) -> None:
        super().__init__(values)
        self.read: set[str] = set()

    def get(self, key: str, default: Any = None) -> Any:
        self.read.add(key)
        return super().get(key, default)

    def __getitem__(self, key: str) -> str:
        self.read.add(key)
        return super().__getitem__(key)


def test_db_requires_the_migrator_url_and_never_reads_the_runtime_password(
    capsys: pytest.CaptureFixture[str],
) -> None:
    environment = _RecordingEnvironment({"QUIZ_DB_PASSWORD": "runtime-secret"})

    status = release_check.main(["db", "--expect", "11"], environment)

    output = capsys.readouterr().out
    assert status == 1
    assert "FAIL config MIGRATOR_DATABASE_URL is required" in output
    assert environment.read == {"MIGRATOR_DATABASE_URL"}
    assert "runtime-secret" not in output


def test_db_connection_failure_prints_neither_the_url_nor_the_driver_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    url = "postgresql://owner:migrator-secret@db.internal:5432/quiz_by_quiz"

    def refuse(conninfo: str, **_: object) -> None:
        raise psycopg.OperationalError(f"connection to {conninfo} failed: migrator-secret")

    monkeypatch.setattr(psycopg, "connect", refuse)
    environment = _RecordingEnvironment({"MIGRATOR_DATABASE_URL": url})

    status = release_check.main(["db", "--expect", "10"], environment)

    output = capsys.readouterr().out
    assert status == 1
    assert "FAIL connect could not connect (OperationalError)" in output
    assert "migrator-secret" not in output and "db.internal" not in output
    assert environment.read == {"MIGRATOR_DATABASE_URL"}


@pytest.mark.parametrize("argv", [["db"], ["db", "--expect", "9"], ["db", "--expect", "12"]])
def test_db_accepts_only_an_explicit_expect_of_10_or_11(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        release_check.main(argv, {})
    assert raised.value.code == 2


_BASELINE_LOGGING = {
    "log_statement": "none",
    "log_min_duration_statement": "-1",
    "log_duration": "off",
    "log_min_duration_sample": "-1",
    "log_statement_sample_rate": "1",
    "log_transaction_sample_rate": "0",
    "log_min_error_statement": "error",
}


def _statuses(checks: list[Check]) -> dict[str, str]:
    return {check.name: check.status for check in checks}


def test_logging_baseline_passes_and_warns_about_failed_statements() -> None:
    checks = evaluate_logging(_BASELINE_LOGGING)

    assert _statuses(checks) == {
        "log_statement": "OK",
        "log_min_duration_statement": "OK",
        "log_duration": "OK",
        "log_min_duration_sample": "OK",
        "log_transaction_sample_rate": "OK",
        "log_min_error_statement": "WARN",
    }
    warning = next(check for check in checks if check.status == "WARN")
    assert "ALTER ROLE ... PASSWORD could be logged with the password" in warning.detail
    assert _statuses(evaluate_logging({"log_min_error_statement": "panic"})) == {
        "log_min_error_statement": "OK"
    }


@pytest.mark.parametrize(
    ("setting", "value"),
    [
        ("log_statement", "ddl"),
        ("log_statement", "mod"),
        ("log_statement", "all"),
        ("log_min_duration_statement", "0"),
        ("log_min_duration_statement", "250"),
        ("log_duration", "on"),
        ("log_min_duration_sample", "0"),
        ("log_transaction_sample_rate", "0.01"),
    ],
)
def test_logging_that_can_persist_statement_text_fails(setting: str, value: str) -> None:
    checks = evaluate_logging({**_BASELINE_LOGGING, setting: value})

    failed = [check for check in checks if check.status == "FAIL"]
    assert [check.name for check in failed] == [setting]
    assert failed[0].detail.startswith(value)


def test_sampled_duration_logging_is_safe_only_at_a_zero_sample_rate() -> None:
    sampled = {**_BASELINE_LOGGING, "log_min_duration_sample": "100"}

    assert _statuses(evaluate_logging(sampled))["log_min_duration_sample"] == "FAIL"
    silent = {**sampled, "log_statement_sample_rate": "0"}
    assert _statuses(evaluate_logging(silent))["log_min_duration_sample"] == "OK"


def test_logging_overrides_warn_without_printing_unrelated_settings() -> None:
    checks = evaluate_logging_overrides(
        [
            ("quiz_by_quiz", "*", ["log_statement=all", "search_path=hidden_schema"]),
            ("*", "reporting", ["work_mem=64MB"]),
        ]
    )

    assert [check.status for check in checks] == ["WARN"]
    assert "database=quiz_by_quiz role=* log_statement=all" in checks[0].detail
    assert "hidden_schema" not in checks[0].render()
    assert [check.status for check in evaluate_logging_overrides([])] == ["OK"]


def test_module_source_issues_only_read_statements() -> None:
    tree = ast.parse(SOURCE)
    constants = {
        target.id: node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    # `_fetchone(connection, SQL, params)`는 execute를 감쌀 뿐이다. 그 안의 execute 대신
    # 부르는 쪽의 SQL을 본다.
    wrapper = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_fetchone"
    )
    inside_wrapper = {id(node) for node in ast.walk(wrapper)}
    executed: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or id(node) in inside_wrapper:
            continue
        if isinstance(node.func, ast.Attribute) and node.func.attr == "execute":
            statement = node.args[0]
        elif isinstance(node.func, ast.Name) and node.func.id == "_fetchone":
            statement = node.args[1]
        else:
            continue
        if isinstance(statement, ast.Constant) and isinstance(statement.value, str):
            executed.append(statement.value)
        elif isinstance(statement, ast.Name) and statement.id.endswith("_SQL"):
            executed.append(constants[statement.id])
        else:
            pytest.fail(f"line {node.lineno} executes SQL that is not a fixed string")

    assert len(executed) > 15
    for statement in executed:
        normalized = " ".join(statement.split())
        keyword = normalized.split(" ", 1)[0].upper()
        if keyword == "SET":
            assert normalized in _SESSION_SETS
        else:
            assert keyword in {"SELECT", "SHOW"}, normalized
        assert _WRITE_WORDS.search(normalized) is None, normalized
    assert "SET default_transaction_read_only = on" in executed


def test_module_never_reads_the_runtime_password_or_runs_migrations() -> None:
    tree = ast.parse(SOURCE)
    identifiers = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    identifiers |= {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    identifiers |= {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }

    assert "QUIZ_DB_PASSWORD" not in SOURCE
    assert identifiers.isdisjoint(
        {"runtime_role_password", "ensure_runtime_role", "apply_pending", "_runtime_role_statement"}
    )


def test_deploy_guide_runs_each_check_in_the_service_that_has_its_input() -> None:
    root = Path(__file__).parents[2]
    guide = (root / "deploy" / "oracle" / "README.md").read_text(encoding="utf-8")
    compose = (root / "deploy" / "oracle" / "compose.quiz-by-quiz.yaml").read_text(encoding="utf-8")
    command = "/app/.venv/bin/python -m app.release_check"
    lines = guide.splitlines()

    def documented(fragment: str) -> str:
        return next(line for line in lines if fragment in line)

    database = documented(f"{command} db --expect 10")
    assert "run --rm --no-deps quiz-by-quiz-migrate" in database
    assert "the same command with `--expect 11`" in guide
    assert "--require-idle" in guide
    bank = documented(f"{command} bank")
    assert "run --rm --no-deps quiz-by-quiz-api" in bank

    # db는 migrator URL을, bank는 bank mount를 가진 서비스에서만 돈다
    migrate_service, api_service = compose.split("  quiz-by-quiz-api:", 1)
    assert "MIGRATOR_DATABASE_URL:" in migrate_service
    assert "QUESTION_BANK_DIR: /run/quiz-by-quiz/online-bank" in api_service
    assert "target: /run/quiz-by-quiz/online-bank" in api_service
    dockerfile = (root / "server" / "Dockerfile").read_text(encoding="utf-8")
    runtime_stage = dockerfile.split("FROM base AS runtime", 1)[1]
    assert "COPY --chown=app:app server/app ./app" in runtime_stage
    assert "COPY --chown=app:app server/migrations ./migrations" in runtime_stage


# ── db against PostgreSQL ──────────────────────────────────────────────────────


class _RecordingConnection:
    """Forwards to a real connection and remembers every statement the module sends."""

    def __init__(self, inner: psycopg.Connection[Any], statements: list[str]) -> None:
        self._inner = inner
        self._statements = statements

    def execute(self, statement: Any, params: Any = None, **kwargs: Any) -> Any:
        self._statements.append(str(statement))
        return self._inner.execute(statement, params, **kwargs)

    def transaction(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.transaction(*args, **kwargs)

    def __enter__(self) -> _RecordingConnection:
        self._inner.__enter__()
        return self

    def __exit__(self, *exc: object) -> None:
        self._inner.__exit__(*exc)  # type: ignore[arg-type]


@pytest.fixture
def recorded_statements(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    statements: list[str] = []
    real_connect = psycopg.connect

    def connect(*args: Any, **kwargs: Any) -> _RecordingConnection:
        return _RecordingConnection(real_connect(*args, **kwargs), statements)

    monkeypatch.setattr(psycopg, "connect", connect)
    yield statements


@pytest.mark.integration
@pytest.mark.skipif(not MIGRATOR_URL, reason="MIGRATOR_DATABASE_URL is not set")
def test_latest_database_passes_expect_11_with_only_read_statements(
    recorded_statements: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    assert MIGRATOR_URL is not None
    environment = _RecordingEnvironment({"MIGRATOR_DATABASE_URL": MIGRATOR_URL})

    status = release_check.main(["db", "--expect", "11"], environment)

    output = capsys.readouterr().out
    lines = _lines(output)
    assert status == 0, output
    assert "FAIL" not in {state for states in lines.values() for state in states}
    assert output.startswith("OK session read-only as ")
    latest = discover_migrations()[-1].version
    assert f"OK ledger versions 1..{latest} contiguous, latest {latest}" in output
    assert "OK question-time-columns" in output
    assert "OK elapsed-ms-check match_answers_elapsed_ms_range_check allows 0..40000" in output
    assert "OK runtime-question-time-access" in output
    assert "OK runtime-ledger-access" in output
    assert "OK log_statement none" in output
    assert "INFO active-matches" in output and "INFO recent-members" in output
    # 접속 문자열도, 그 안의 비밀번호도 출력하지 않는다
    password = conninfo_to_dict(MIGRATOR_URL).get("password")
    assert MIGRATOR_URL not in output
    assert not password or str(password) not in output
    assert environment.read == {"MIGRATOR_DATABASE_URL"}

    # 실제로 보낸 문장: 세션을 read-only로 만드는 SET이 먼저, 나머지는 읽기뿐이다
    assert recorded_statements[: len(_SESSION_SETS)] == list(_SESSION_SETS)
    for statement in recorded_statements[len(_SESSION_SETS) :]:
        keyword = " ".join(statement.split()).split(" ", 1)[0].upper()
        assert keyword in {"SELECT", "SHOW"}, statement


@pytest.mark.integration
@pytest.mark.skipif(not MIGRATOR_URL, reason="MIGRATOR_DATABASE_URL is not set")
def test_latest_database_fails_expect_10(capsys: pytest.CaptureFixture[str]) -> None:
    assert MIGRATOR_URL is not None

    status = release_check.main(["db", "--expect", "10"], {"MIGRATOR_DATABASE_URL": MIGRATOR_URL})

    output = capsys.readouterr().out
    assert status == 1
    assert "FAIL ledger latest version is 11, expected 10" in output
    assert "FAIL schema-version" in output
    assert "FAIL question-time-columns migration 011 columns already exist" in output
    assert "FAIL question-time-constraints migration 011 constraints already exist" in output
    assert "allows 0..40000, expected 0..20000" in output
    assert output.splitlines()[-1].startswith("FAIL result ")


@pytest.mark.integration
@pytest.mark.skipif(not MIGRATOR_URL, reason="MIGRATOR_DATABASE_URL is not set")
def test_a_running_migrator_is_reported_without_failing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert MIGRATOR_URL is not None
    with psycopg.connect(MIGRATOR_URL, autocommit=True) as migrator:
        migrator.execute("SELECT pg_advisory_lock(%s)", (_ADVISORY_LOCK_KEY,))
        try:
            held = release_check.main(
                ["db", "--expect", "11"], {"MIGRATOR_DATABASE_URL": MIGRATOR_URL}
            )
            held_output = capsys.readouterr().out
        finally:
            migrator.execute("SELECT pg_advisory_unlock(%s)", (_ADVISORY_LOCK_KEY,))

    assert held == 0
    assert "WARN migration-lock held by another session: app.migrate is running" in held_output
    release_check.main(["db", "--expect", "11"], {"MIGRATOR_DATABASE_URL": MIGRATOR_URL})
    assert "OK migration-lock not held" in capsys.readouterr().out


@pytest.mark.integration
@pytest.mark.skipif(not MIGRATOR_URL, reason="MIGRATOR_DATABASE_URL is not set")
def test_migration_10_database_passes_expect_10_and_fails_expect_11() -> None:
    """001..010만 깐 DB를 같은 DB 안의 한 transaction에서 만들고 점검한 뒤 되돌린다."""
    assert MIGRATOR_URL is not None
    migrations = discover_migrations()
    with psycopg.connect(MIGRATOR_URL, autocommit=True) as connection:
        connection.execute("SET lock_timeout = '10s'")
        with connection.transaction(force_rollback=True):
            connection.execute("DROP SCHEMA quiz_online CASCADE")
            for migration in migrations[:10]:
                connection.execute(_migration_body(migration.path))
            _seed_active_match(connection)
            connection.execute("SET TRANSACTION READ ONLY")

            at_10 = check_database(connection, expect=10)
            idle_required = check_database(connection, expect=10, require_idle=True)
            at_11 = check_database(connection, expect=11)

        # 되돌렸다 — 이 DB는 다시 최신이다
        versions = connection.execute(
            "SELECT array_agg(version ORDER BY version) FROM quiz_online.schema_migrations"
        ).fetchone()
        assert versions is not None
        assert versions[0] == [migration.version for migration in migrations]

    rendered_10 = [check.render() for check in at_10]
    assert [line for line in rendered_10 if line.startswith("FAIL")] == []
    assert "OK ledger versions 1..10 contiguous, latest 10" in rendered_10
    assert "INFO pending-migrations app.migrate from this image would apply 11" in rendered_10
    assert "OK schema-version quiz_online.character_only_schema_version() = 10" in rendered_10
    assert any(line.startswith("OK character-only 5 constraints") for line in rendered_10)
    assert any(
        line.startswith("OK question-time-columns") and "absent" in line for line in rendered_10
    )
    assert any(
        line.startswith("OK question-time-constraints") and "absent" in line for line in rendered_10
    )
    assert any(
        line.startswith("OK elapsed-ms-check") and line.endswith("allows 0..20000")
        for line in rendered_10
    )
    assert "INFO active-matches 1 (running 1, revealing 0)" in rendered_10
    assert "INFO recent-members 1 in 1 rooms seen within 2 minutes" in rendered_10
    assert "OK runtime-schema-version-access" in " ".join(rendered_10)
    assert "OK runtime-ledger-access" in " ".join(rendered_10)

    assert _statuses(idle_required)["active-matches"] == "FAIL"
    assert [check.name for check in idle_required if check.status == "FAIL"] == ["active-matches"]

    failed_11 = {check.name for check in at_11 if check.status == "FAIL"}
    assert {
        "ledger",
        "schema-version",
        "question-time-columns",
        "question-time-constraints",
        "elapsed-ms-check",
        "question-time-values",
        "runtime-question-time-access",
    } <= failed_11
    assert "character-only" not in failed_11


def _migration_body(path: Path) -> str:
    """The migration without its own BEGIN/COMMIT, so the test's transaction can roll it back."""
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines.count("BEGIN;") == 1 and lines.count("COMMIT;") == 1, path.name
    return "\n".join(line for line in lines if line not in {"BEGIN;", "COMMIT;"})


def _seed_active_match(connection: psycopg.Connection[Any]) -> None:
    player_id = uuid4()
    connection.execute(
        """
        INSERT INTO quiz_online.players (id, token_hash, nickname, character_id)
        VALUES (%s, %s, '점검방장', 'slime-blue')
        """,
        (player_id, hashlib.sha256(player_id.bytes).digest()),
    )
    room_row = connection.execute(
        """
        INSERT INTO quiz_online.rooms (code, name, capacity, is_public, host_player_id)
        VALUES (%s, '점검 방', 2, true, %s)
        RETURNING id
        """,
        (uuid4().hex[:6].upper(), player_id),
    ).fetchone()
    assert room_row is not None
    connection.execute(
        """
        INSERT INTO quiz_online.room_members (room_id, player_id, nickname, character_id)
        VALUES (%s, %s, '점검방장', 'slime-blue')
        """,
        (room_row[0], player_id),
    )
    connection.execute(
        """
        INSERT INTO quiz_online.matches (room_id, total_questions, deadline_at, expires_at)
        VALUES (%s, 10, now() + interval '20 seconds', now() + interval '2 hours')
        """,
        (room_row[0],),
    )
