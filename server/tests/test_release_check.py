"""운영자 점검 도구(`python -m app.release_check`)를 확인한다.

bank는 임시 디렉터리에서 돈다. db는 `python -m app.migrate`를 마친
RELEASE_CHECK_TEST_DATABASE_URL(migrator 권한의 버려도 되는 test DB)에서 돌고, 그 값이 없으면
건너뛴다. 운영의 MIGRATOR_DATABASE_URL은 읽지 않는다 — 아래 test는 같은 DB 안에서 schema를
지우고 001..010·001..011을 한 transaction으로 다시 깔았다가 되돌리고(그동안 모든 quiz_online 표를
ACCESS EXCLUSIVE로 쥔다) app.migrate의 advisory lock도 쥔다. 그 값을 내보낸 채 pytest를
돌렸다고 운영 DB에 닿으면 안 된다. 다른 DB나 schema는 만들지 않는다.
"""

from __future__ import annotations

import ast
import hashlib
import itertools
import json
import os
import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

from app import release_check
from app.config import PUBLIC_PAGES_DATA_DIR
from app.migrate import _ADVISORY_LOCK_KEY, _RUNTIME_ROLE_NAME, discover_migrations
from app.release_check import Check, check_database, evaluate_logging, evaluate_logging_overrides

CATEGORIES = ("history", "science", "geography", "general", "art")
ROOT = Path(__file__).parents[2]
SOURCE = Path(release_check.__file__).read_text(encoding="utf-8")
# test 전용 이름이다. CI는 app.migrate를 마친 뒤의 전체 pytest에만 넘긴다
# (.github/workflows/pages.yml).
TEST_MIGRATOR_URL = os.getenv("RELEASE_CHECK_TEST_DATABASE_URL")
needs_database = pytest.mark.skipif(
    not TEST_MIGRATOR_URL, reason="RELEASE_CHECK_TEST_DATABASE_URL is not set"
)

# 문항 내용이 출력에 새는지 보려고 모든 글에 이 표식을 붙인다.
_CONTENT_MARK = "PRIVATE-CONTENT"
# 세션을 여는 SET 셋과, 점검마다 transaction을 여는 SET 하나. 이 밖의 문장은
# SELECT·SHOW뿐이어야 한다.
_SESSION_SETS = (
    "SET default_transaction_read_only = on",
    "SET statement_timeout = '15s'",
    "SET lock_timeout = '5s'",
)
_READ_ONLY_TRANSACTION = "SET TRANSACTION READ ONLY"
_READ_ONLY_GUARD = "SELECT current_setting('transaction_read_only')"
_NOT_READ_ONLY = "transaction is not read-only; no check was run"
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
    assert "OK id-length all 50 ids fit 64 characters" in output
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


def test_bank_fails_ids_in_the_public_pages_form(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # 공개 Pages와 같은 모양의 ID다. 다른 분야 파일에 있어도 같은 모양이면 센다.
    def make_id(category: str, number: int) -> str | None:
        if number < 3:
            return f"{category}-{number:03d}"
        if category == "art" and number == 3:
            return "history-9003"
        return None

    ids = _write_bank(tmp_path / "bank", make_id=make_id)

    status, output = _run_bank(tmp_path / "bank", capsys)

    # API 와 같은 로더가 공개 형식 ID 를 먼저 거절한다 (question_catalog). 그래서 개수와 파일 이름만
    # 담은 catalog 실패 하나로 끝나고, ID·내용은 나오지 않는다
    assert status == 1
    assert (
        "FAIL catalog CatalogError: 16 question ids use the public Pages bank format <category>-NNN"
    ) in output
    assert [line for line in output.splitlines() if line.startswith("FAIL ")] == [
        line for line in output.splitlines() if line.startswith("FAIL catalog ")
    ] + ["FAIL result 1 FAIL, 0 WARN"]
    _assert_no_content(output, ids)


def test_bank_warns_on_other_ids_without_the_online_prefix(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # 계약은 online-을 예로만 든다. 공개 번호 모양이 아니면 막지 않고 알린다.
    ids = _write_bank(
        tmp_path / "bank",
        make_id=lambda category, number: (
            f"qbq-{category}-{number:03d}" if number == 0 else f"online-{category}-{number:03d}"
        ),
    )

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 0
    assert "WARN id-prefix 5 of 50 ids lack the online- prefix" in output
    assert "WARN id-format 5 of 50 ids" in output
    assert output.splitlines()[-1] == "OK result 0 FAIL, 2 WARN"
    _assert_no_content(output, ids)


def test_bank_fails_ids_longer_than_the_match_question_column(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # online-history-(15자) + 숫자 50자 = 65자. 모양은 맞아 id-format은 통과한다. 64자는 들어간다.
    too_long = "online-history-" + "7" * 50
    fits = "online-science-" + "7" * 49
    assert (len(too_long), len(fits)) == (65, 64)
    ids = _write_bank(
        tmp_path / "bank",
        make_id=lambda category, number: (
            {"history": too_long, "science": fits}.get(category) if number == 0 else None
        ),
    )

    status, output = _run_bank(tmp_path / "bank", capsys)

    assert status == 1
    assert (
        "FAIL id-length 1 of 50 ids exceed 64 characters "
        "(match_questions.question_id is varchar(64); a match that draws one cannot start)"
    ) in output
    assert [line for line in output.splitlines() if line.startswith("FAIL ")] == [
        line for line in output.splitlines() if line.startswith("FAIL id-length ")
    ] + ["FAIL result 1 FAIL, 0 WARN"]
    _assert_no_content(output, ids)


def test_question_id_limit_matches_the_match_questions_column() -> None:
    # 열을 넓히거나 줄이는 migration이 오면 이 한도도 함께 고친다.
    texts = {
        migration.path.name: migration.path.read_text(encoding="utf-8")
        for migration in discover_migrations()
    }
    definitions = [
        (name, match)
        for name, text in texts.items()
        for match in re.findall(r"question_id\s+varchar\((\d+)\)", text, flags=re.IGNORECASE)
    ]
    assert definitions == [("002_matches.sql", str(release_check.QUESTION_ID_MAX_LENGTH))]
    assert [
        name
        for name, text in texts.items()
        if re.search(r"ALTER\s+COLUMN\s+question_id\b", text, flags=re.IGNORECASE)
    ] == []


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
    assert "FAIL catalog CatalogError: 50 question ids use the public Pages bank format" in output
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
    assert "FAIL catalog CatalogError:" in output and "public Pages bank format" in output
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

    status = release_check.main(["db", "--expect", "12"], environment)

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


@pytest.mark.parametrize(
    "argv",
    [
        ["db"],
        ["db", "--expect", "9"],
        ["db", "--expect", "13"],
        # 011 전에는 question_time_ms가 없고, 012 단계에서는 011 API가 40000을 쓴다. 그 요구는
        # --expect 11에만 뜻이 있다
        ["db", "--expect", "10", "--require-default-question-time"],
        ["db", "--expect", "12", "--require-default-question-time"],
        # 랭킹 표는 012부터다. 비어 있어야 한다는 요구는 --expect 12에만 뜻이 있다
        ["db", "--expect", "11", "--require-empty-rankings"],
    ],
)
def test_db_accepts_only_an_explicit_expect_of_10_11_or_12(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        release_check.main(argv, {})
    assert raised.value.code == 2


class _Rows:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def fetchone(self) -> tuple[object, ...] | None:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows


class _ScriptedConnection:
    """No server: answers the read-only guard from a script and records every statement.

    Anything past the guard and the session row means a check ran, which must not happen
    on a transaction the server reports as read-write, so it fails the test outright.
    """

    def __init__(self, read_only: Iterable[str]) -> None:
        self._read_only = iter(read_only)
        self.statements: list[str] = []
        self.transactions = 0

    def execute(self, statement: Any, params: Any = None) -> _Rows:
        normalized = " ".join(str(statement).split())
        self.statements.append(normalized)
        if normalized == _READ_ONLY_TRANSACTION:
            return _Rows([])
        if normalized == _READ_ONLY_GUARD:
            return _Rows([(next(self._read_only),)])
        if normalized == " ".join(release_check._SESSION_SQL.split()):
            return _Rows([("migrator", "quiz_by_quiz", "16.4")])
        raise AssertionError(f"a check ran on a read-write transaction: {normalized}")

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.transactions += 1
        yield


def test_db_runs_nothing_when_the_session_is_not_read_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = _ScriptedConnection(["off"])

    checks = check_database(connection, expect=11)

    assert checks == [Check("FAIL", "session", _NOT_READ_ONLY)]
    assert connection.statements == [_READ_ONLY_TRANSACTION, _READ_ONLY_GUARD]
    assert release_check.report(checks) == 1
    assert capsys.readouterr().out == (
        f"FAIL session {_NOT_READ_ONLY}\nFAIL result 1 FAIL, 0 WARN\n"
    )


def test_db_verifies_read_only_in_every_check_transaction() -> None:
    # 첫 transaction만 read-only인 연결이다 — 세션 값이 이어지지 않는 transaction pooling
    # proxy 뒤처럼.
    connection = _ScriptedConnection(itertools.chain(["on"], itertools.repeat("off")))

    checks = check_database(connection, expect=11, require_idle=True)

    assert checks[0].status == "OK" and checks[0].name == "session"
    assert len(checks) == connection.transactions > 10
    assert {(check.status, check.detail) for check in checks[1:]} == {("FAIL", _NOT_READ_ONLY)}
    session_statements = [
        _READ_ONLY_TRANSACTION,
        _READ_ONLY_GUARD,
        " ".join(release_check._SESSION_SQL.split()),
    ]
    assert connection.statements == session_statements + [
        _READ_ONLY_TRANSACTION,
        _READ_ONLY_GUARD,
    ] * (connection.transactions - 1)


def test_db_session_that_cannot_be_configured_runs_no_check(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    statements: list[str] = []

    class _RefusingConnection:
        def __enter__(self) -> _RefusingConnection:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def execute(self, statement: Any, params: Any = None) -> None:
            statements.append(str(statement))
            raise psycopg.OperationalError("SET refused for migrator-secret@db.internal")

        def transaction(self) -> Any:  # pragma: no cover - must never be reached
            raise AssertionError("a check transaction was opened")

    monkeypatch.setattr(psycopg, "connect", lambda *args, **kwargs: _RefusingConnection())

    status = release_check.main(
        ["db", "--expect", "11"], {"MIGRATOR_DATABASE_URL": "postgresql://unused"}
    )

    assert status == 1
    assert capsys.readouterr().out == (
        "FAIL session could not configure (OperationalError)\nFAIL result 1 FAIL, 0 WARN\n"
    )
    assert statements == ["SET default_transaction_read_only = on"]


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
            assert normalized in (*_SESSION_SETS, _READ_ONLY_TRANSACTION)
        else:
            assert keyword in {"SELECT", "SHOW"}, normalized
        assert _WRITE_WORDS.search(normalized) is None, normalized
    assert "SET default_transaction_read_only = on" in executed
    assert _READ_ONLY_TRANSACTION in executed and _READ_ONLY_GUARD in executed


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
    guide = (ROOT / "deploy" / "oracle" / "README.md").read_text(encoding="utf-8")
    compose = (ROOT / "deploy" / "oracle" / "compose.quiz-by-quiz.yaml").read_text(encoding="utf-8")
    command = "/app/.venv/bin/python -m app.release_check"
    lines = guide.splitlines()

    def documented(fragment: str) -> str:
        return next(line for line in lines if fragment in line)

    database = documented(f"{command} db --expect 11")
    assert "run --rm --no-deps quiz-by-quiz-migrate" in database
    # 3단계의 012 뒤 점검은 후보 API가 아직 돌지 않았음(랭킹 표가 빔)까지 exit status로 요구한다
    assert "the same command with `--expect 12 --require-empty-rankings`" in guide
    # 앞선 011 경계의 점검(모두 20000)도 기록으로 남는다
    assert "`--expect 11 --require-default-question-time`" in guide
    assert "--require-idle" in guide
    # bank는 migration 011 전에 후보 migrate 이미지로 돈다. API 이미지를 미리 빌드하면
    # 다음 up 이 010 API 를 011 전에 바꿀 수 있어서다. migrate 서비스에는 bank mount와
    # QUESTION_BANK_DIR 이 없으므로 명령이 둘을 직접 넘긴다 — API 서비스와 같은 경로다
    bank = documented(f"{command} bank")
    assert "--profile migration run --build --rm --no-deps" in bank
    assert "-e QUESTION_BANK_DIR=/run/quiz-by-quiz/online-bank" in bank
    assert ':/run/quiz-by-quiz/online-bank:ro" quiz-by-quiz-migrate' in bank

    # db는 migrator URL을 가진 서비스에서 돌고, bank 경로는 API 서비스가 쓰는 것과 같다
    migrate_service, api_service = compose.split("  quiz-by-quiz-api:", 1)
    assert "MIGRATOR_DATABASE_URL:" in migrate_service
    assert "QUESTION_BANK_DIR: /run/quiz-by-quiz/online-bank" in api_service
    assert "target: /run/quiz-by-quiz/online-bank" in api_service
    dockerfile = (ROOT / "server" / "Dockerfile").read_text(encoding="utf-8")
    runtime_stage = dockerfile.split("FROM base AS runtime", 1)[1]
    assert "COPY --chown=app:app server/app ./app" in runtime_stage
    assert "COPY --chown=app:app server/migrations ./migrations" in runtime_stage


def test_ci_hands_the_database_tests_a_test_only_url() -> None:
    workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")

    # app.migrate 뒤의 전체 pytest 한 줄에만 넘긴다(MIGRATION_UPGRADE_DATABASE_URL과 같은 방식)
    assert (
        "          uv run --locked python -m app.migrate\n"
        '          RELEASE_CHECK_TEST_DATABASE_URL="$MIGRATOR_DATABASE_URL" \\\n'
        "            uv run --locked python -m pytest -q\n"
    ) in workflow
    assert workflow.count("RELEASE_CHECK_TEST_DATABASE_URL") == 1
    # 도구 자신은 test 이름을 모른다 — 운영에서는 MIGRATOR_DATABASE_URL만 읽는다
    assert "RELEASE_CHECK_TEST_DATABASE_URL" not in SOURCE


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
@needs_database
def test_latest_database_passes_expect_12_with_only_read_statements(
    recorded_statements: list[str],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert TEST_MIGRATOR_URL is not None
    environment = _RecordingEnvironment({"MIGRATOR_DATABASE_URL": TEST_MIGRATOR_URL})
    runs: list[str] = []
    real_run = release_check._run

    def counting_run(connection: Any, name: str, check: Any) -> list[Check]:
        runs.append(name)
        return real_run(connection, name, check)

    monkeypatch.setattr(release_check, "_run", counting_run)

    status = release_check.main(["db", "--expect", "12"], environment)

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
    assert "OK rankings-table quiz_online.online_rankings has 15 columns" in output
    assert "OK rankings-constraints 6 checks validated" in output
    assert "OK rankings-indexes" in output
    assert "OK rankings-retention quiz_online.prune_online_rankings() SECURITY DEFINER" in output
    assert "INFO rankings-records" in output
    assert (
        "OK runtime-rankings-access quiz_by_quiz_app can only SELECT/INSERT "
        "quiz_online.online_rankings"
    ) in output
    assert "OK log_statement none" in output
    assert "INFO active-matches" in output and "INFO recent-members" in output
    # 접속 문자열도, 그 안의 비밀번호도 출력하지 않는다
    password = conninfo_to_dict(TEST_MIGRATOR_URL).get("password")
    assert TEST_MIGRATOR_URL not in output
    assert not password or str(password) not in output
    assert environment.read == {"MIGRATOR_DATABASE_URL"}

    # 실제로 보낸 문장: 세션을 read-only로 만드는 SET이 먼저, 그다음 점검마다 READ ONLY로 연
    # transaction과 그 확인, 나머지는 읽기뿐이다
    assert recorded_statements[: len(_SESSION_SETS)] == list(_SESSION_SETS)
    rest = [" ".join(statement.split()) for statement in recorded_statements[len(_SESSION_SETS) :]]
    opened = [index for index, statement in enumerate(rest) if statement == _READ_ONLY_TRANSACTION]
    assert opened[0] == 0
    assert len(opened) == len(runs) > 15
    assert all(rest[index + 1] == _READ_ONLY_GUARD for index in opened)
    for statement in rest:
        if statement != _READ_ONLY_TRANSACTION:
            assert statement.split(" ", 1)[0].upper() in {"SELECT", "SHOW"}, statement


@pytest.mark.integration
@needs_database
def test_latest_database_fails_expect_10(capsys: pytest.CaptureFixture[str]) -> None:
    assert TEST_MIGRATOR_URL is not None

    status = release_check.main(
        ["db", "--expect", "10"], {"MIGRATOR_DATABASE_URL": TEST_MIGRATOR_URL}
    )

    output = capsys.readouterr().out
    assert status == 1
    assert "FAIL ledger latest version is 12, expected 10" in output
    assert "FAIL schema-version" in output
    assert "FAIL question-time-columns migration 011 columns already exist" in output
    assert "FAIL question-time-constraints migration 011 constraints already exist" in output
    assert "allows 0..40000, expected 0..20000" in output
    assert "FAIL rankings-table migration 012 table already exists" in output
    assert output.splitlines()[-1].startswith("FAIL result ")


@pytest.mark.integration
@needs_database
def test_latest_database_fails_expect_11(capsys: pytest.CaptureFixture[str]) -> None:
    """012 뒤의 DB를 012 전 점검(3단계의 첫 명령)으로 보면 랭킹 표가 있어 멈춘다."""
    assert TEST_MIGRATOR_URL is not None

    status = release_check.main(
        ["db", "--expect", "11"], {"MIGRATOR_DATABASE_URL": TEST_MIGRATOR_URL}
    )

    output = capsys.readouterr().out
    lines = _lines(output)
    assert status == 1
    assert "FAIL ledger latest version is 12, expected 11" in output
    assert "FAIL rankings-table migration 012 table already exists" in output
    # 011이 더한 것은 그대로 맞다
    assert lines["question-time-columns"] == ["OK"]
    assert lines["elapsed-ms-check"] == ["OK"]
    assert "rankings-constraints" not in lines and "runtime-rankings-access" not in lines


@pytest.mark.integration
@needs_database
def test_every_check_transaction_is_read_only_even_without_the_session_setting() -> None:
    assert TEST_MIGRATOR_URL is not None
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        # 세션 SET 없이 연 연결이다. 그래도 점검의 transaction은 서버가 쓰기를 막는다
        default = connection.execute("SHOW default_transaction_read_only").fetchone()
        assert default is not None and default[0] == "off"

        def attempt_write(conn: Any) -> Iterator[Check]:
            # 고치는 행이 없는 UPDATE다. read-only가 아니어도 아무것도 바꾸지 않는다
            conn.execute("UPDATE quiz_online.schema_migrations SET version = version WHERE false")
            yield Check("OK", "probe", "wrote")

        checks = release_check._run(connection, "probe", attempt_write)

    assert checks == [Check("FAIL", "probe", "query failed (ReadOnlySqlTransaction 25006)")]


@pytest.mark.integration
@needs_database
def test_a_running_migrator_is_reported_without_failing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert TEST_MIGRATOR_URL is not None
    environment = {"MIGRATOR_DATABASE_URL": TEST_MIGRATOR_URL}
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as migrator:
        migrator.execute("SELECT pg_advisory_lock(%s)", (_ADVISORY_LOCK_KEY,))
        try:
            held = release_check.main(["db", "--expect", "12"], environment)
            held_output = capsys.readouterr().out
        finally:
            migrator.execute("SELECT pg_advisory_unlock(%s)", (_ADVISORY_LOCK_KEY,))

    assert held == 0
    assert "WARN migration-lock held by another session: app.migrate is running" in held_output
    release_check.main(["db", "--expect", "12"], environment)
    assert "OK migration-lock not held" in capsys.readouterr().out


@pytest.mark.integration
@needs_database
def test_question_times_must_stay_at_the_default_until_the_candidate_api_runs() -> None:
    """011 뒤 그 후보 API로 바꾸기 전(011 경계의 3단계)에는 모든 방·판이 20000이다.

    40000은 그 순서를 어긴 흔적이다. 001..011만 깐 DB를 한 transaction에서 만들고 되돌린다.
    """
    assert TEST_MIGRATOR_URL is not None
    migrations = discover_migrations()
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        connection.execute("SET lock_timeout = '10s'")
        # 둘 다 되돌린다 — 이 DB는 다시 최신이다
        with connection.transaction(force_rollback=True):
            _install(connection, migrations[:11])
            _seed_room(connection, question_time_ms=20_000)
            at_default = check_database(connection, expect=11, require_default_question_time=True)
        with connection.transaction(force_rollback=True):
            _install(connection, migrations[:11])
            _seed_room(connection, question_time_ms=20_000)
            _seed_room(connection, question_time_ms=40_000)
            too_early = check_database(connection, expect=11, require_default_question_time=True)
            after_step_4 = check_database(connection, expect=11)

    assert [check.render() for check in at_default if check.status == "FAIL"] == []
    values = next(check for check in at_default if check.name == "question-time-values")
    assert values.status == "OK" and values.detail.endswith("; every row at 20000")

    assert [check.name for check in too_early if check.status == "FAIL"] == ["question-time-values"]
    early = next(check for check in too_early if check.name == "question-time-values")
    assert "rooms 20000=" in early.detail and " 40000=1;" in early.detail
    assert "--require-default-question-time needs every row at 20000" in early.detail

    # 후보 API가 돈 뒤에는 40000이 정상이다
    assert _statuses(after_step_4)["question-time-values"] == "INFO"
    assert [check.name for check in after_step_4 if check.status == "FAIL"] == []


@pytest.mark.integration
@needs_database
def test_a_column_grant_on_the_ledger_fails_runtime_ledger_access() -> None:
    assert TEST_MIGRATOR_URL is not None
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        connection.execute("SET lock_timeout = '10s'")
        with connection.transaction(force_rollback=True):
            connection.execute(
                sql.SQL("GRANT SELECT (version) ON quiz_online.schema_migrations TO {}").format(
                    sql.Identifier(_RUNTIME_ROLE_NAME)
                )
            )
            # 표 단위 검사는 이 열 권한을 세지 않는다 — 그래서 열 권한까지 보는 함수로 본다
            privileges = connection.execute(
                "SELECT has_table_privilege(%s, 'quiz_online.schema_migrations', 'SELECT'),"
                " has_any_column_privilege(%s, 'quiz_online.schema_migrations', 'SELECT')",
                (_RUNTIME_ROLE_NAME, _RUNTIME_ROLE_NAME),
            ).fetchone()
            assert privileges == (False, True)
            checks = check_database(connection, expect=12)

    assert [check.render() for check in checks if check.status == "FAIL"] == [
        f"FAIL runtime-ledger-access {_RUNTIME_ROLE_NAME} holds SELECT on "
        "quiz_online.schema_migrations (table or column grant)"
    ]


@pytest.mark.integration
@needs_database
def test_migration_10_database_passes_expect_10_and_fails_expect_11() -> None:
    """001..010만 깐 DB를 같은 DB 안의 한 transaction에서 만들고 점검한 뒤 되돌린다."""
    assert TEST_MIGRATOR_URL is not None
    migrations = discover_migrations()
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
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
    assert "INFO pending-migrations app.migrate from this image would apply 11, 12" in rendered_10
    assert (
        "OK rankings-table quiz_online.online_rankings absent, as at migration 10" in rendered_10
    )
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


@pytest.mark.integration
@needs_database
def test_migration_11_database_passes_expect_11_and_fails_expect_12() -> None:
    """001..011만 깐 DB(012 전, 3단계의 첫 점검)를 한 transaction에서 만들고 점검한 뒤 되돌린다."""
    assert TEST_MIGRATOR_URL is not None
    migrations = discover_migrations()
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        connection.execute("SET lock_timeout = '10s'")
        with connection.transaction(force_rollback=True):
            _install(connection, migrations[:11])
            # 011 API는 40초 방을 연다 — 012 단계에서는 정상이다
            _seed_room(connection, question_time_ms=40_000)
            connection.execute("SET TRANSACTION READ ONLY")

            at_11 = check_database(connection, expect=11)
            at_12 = check_database(connection, expect=12)
            empty_12 = check_database(connection, expect=12, require_empty_rankings=True)

    rendered_11 = [check.render() for check in at_11]
    assert [line for line in rendered_11 if line.startswith("FAIL")] == []
    assert "OK ledger versions 1..11 contiguous, latest 11" in rendered_11
    assert "INFO pending-migrations app.migrate from this image would apply 12" in rendered_11
    assert (
        "OK rankings-table quiz_online.online_rankings absent, as at migration 11" in rendered_11
    )
    assert _statuses(at_11)["question-time-values"] == "INFO"

    failed_12 = {check.name for check in at_12 if check.status == "FAIL"}
    assert failed_12 == {
        "ledger",
        "schema-version",
        "rankings-table",
        "rankings-constraints",
        "rankings-indexes",
        "rankings-retention",
        "rankings-records",
        "runtime-rankings-access",
    }
    assert {check.name for check in empty_12 if check.status == "FAIL"} == failed_12


@pytest.mark.integration
@needs_database
def test_rankings_must_stay_empty_until_the_candidate_api_runs() -> None:
    """012 뒤 후보 API로 바꾸기 전(README 3단계)에는 011 API만 돈다. 그 API는 랭킹을 모른다.

    기록이 있으면 후보 API가 너무 일찍 돌았다는 뜻이다. 4단계 뒤에는 기록이 정상이다.
    """
    assert TEST_MIGRATOR_URL is not None
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        connection.execute("SET lock_timeout = '10s'")
        # 점검의 transaction은 READ ONLY가 되어 바깥 transaction에 남는다 — 쓰기는 점검 앞에 둔다
        with connection.transaction(force_rollback=True):
            connection.execute("DELETE FROM quiz_online.online_rankings")
            empty = check_database(connection, expect=12, require_empty_rankings=True)
        with connection.transaction(force_rollback=True):
            connection.execute("DELETE FROM quiz_online.online_rankings")
            _seed_ranking(connection)
            too_early = check_database(connection, expect=12, require_empty_rankings=True)
            after_step_4 = check_database(connection, expect=12)

    assert [check.render() for check in empty if check.status == "FAIL"] == []
    records = next(check for check in empty if check.name == "rankings-records")
    assert records.render() == "OK rankings-records 0 records in 0 boards; empty"

    assert [check.render() for check in too_early if check.status == "FAIL"] == [
        "FAIL rankings-records 1 records in 1 boards; --require-empty-rankings needs 0 "
        "(only the candidate API records)"
    ]
    assert _statuses(after_step_4)["rankings-records"] == "INFO"
    assert [check.name for check in after_step_4 if check.status == "FAIL"] == []


@pytest.mark.integration
@needs_database
@pytest.mark.parametrize(
    ("grant", "held"),
    [
        ("GRANT UPDATE (nickname) ON quiz_online.online_rankings TO {}", "UPDATE"),
        ("GRANT DELETE ON quiz_online.online_rankings TO {}", "DELETE"),
        ("GRANT TRUNCATE ON quiz_online.online_rankings TO {}", "TRUNCATE"),
    ],
)
def test_runtime_rankings_access_allows_only_insert_and_select(grant: str, held: str) -> None:
    assert TEST_MIGRATOR_URL is not None
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        connection.execute("SET lock_timeout = '10s'")
        with connection.transaction(force_rollback=True):
            connection.execute(sql.SQL(grant).format(sql.Identifier(_RUNTIME_ROLE_NAME)))
            granted = check_database(connection, expect=12)
        with connection.transaction(force_rollback=True):
            connection.execute(
                sql.SQL("REVOKE INSERT ON quiz_online.online_rankings FROM {}").format(
                    sql.Identifier(_RUNTIME_ROLE_NAME)
                )
            )
            revoked = check_database(connection, expect=12)

    assert [check.render() for check in granted if check.status == "FAIL"] == [
        f"FAIL runtime-rankings-access {_RUNTIME_ROLE_NAME} on quiz_online.online_rankings: "
        f"holds {held} (table or column grant)"
    ]
    assert [check.render() for check in revoked if check.status == "FAIL"] == [
        f"FAIL runtime-rankings-access {_RUNTIME_ROLE_NAME} on quiz_online.online_rankings: "
        "lacks INSERT"
    ]


@pytest.mark.integration
@needs_database
def test_rankings_owner_key_must_stay_a_32_byte_secret_derived_key() -> None:
    """«내 기록»은 player id와 토큰에서 나온 owner_key가 함께 가린다 — 열과 길이 제약."""
    assert TEST_MIGRATOR_URL is not None
    with psycopg.connect(TEST_MIGRATOR_URL, autocommit=True) as connection:
        connection.execute("SET lock_timeout = '10s'")
        with connection.transaction(force_rollback=True):
            connection.execute(
                "ALTER TABLE quiz_online.online_rankings "
                "DROP CONSTRAINT online_rankings_owner_key_length"
            )
            dropped = check_database(connection, expect=12)
        with connection.transaction(force_rollback=True):
            connection.execute(
                "ALTER TABLE quiz_online.online_rankings "
                "DROP CONSTRAINT online_rankings_owner_key_length, "
                "ADD CONSTRAINT online_rankings_owner_key_length "
                "CHECK (owner_key IS NULL OR octet_length(owner_key) > 0)"
            )
            loosened = check_database(connection, expect=12)
        with connection.transaction(force_rollback=True):
            connection.execute("ALTER TABLE quiz_online.online_rankings DROP COLUMN owner_key")
            missing = check_database(connection, expect=12)

    assert [check.render() for check in dropped if check.status == "FAIL"] == [
        "FAIL rankings-constraints online_rankings_owner_key_length on online_rankings is missing"
    ]
    assert [check.render() for check in loosened if check.status == "FAIL"] == [
        "FAIL rankings-constraints online_rankings_owner_key_length does not require "
        "32-byte owner keys"
    ]
    failed = [check.render() for check in missing if check.status == "FAIL"]
    assert any(
        line.startswith("FAIL rankings-table") and "owner_key" in line for line in failed
    ), failed


def _install(connection: psycopg.Connection[Any], migrations: Iterable[Any]) -> None:
    """quiz_online을 지우고 주어진 migration만 다시 깐다. 부르는 쪽의 transaction이 되돌린다."""
    connection.execute("DROP SCHEMA quiz_online CASCADE")
    for migration in migrations:
        connection.execute(_migration_body(migration.path))


def _seed_ranking(connection: psycopg.Connection[Any]) -> None:
    connection.execute(
        """
        INSERT INTO quiz_online.online_rankings (
            match_id, player_id, mode, category_id, score, correct_count, total_questions,
            question_time_ms, nickname, character_id, recorded_at
        )
        VALUES (%s, %s, 'category', 'history', 70, 7, 10, 20000, '점검', 'slime-blue', now())
        """,
        (uuid4(), uuid4()),
    )


def _migration_body(path: Path) -> str:
    """The migration without its own BEGIN/COMMIT, so the test's transaction can roll it back."""
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines.count("BEGIN;") == 1 and lines.count("COMMIT;") == 1, path.name
    return "\n".join(line for line in lines if line not in {"BEGIN;", "COMMIT;"})


def _seed_room(
    connection: psycopg.Connection[Any], *, question_time_ms: int | None = None
) -> tuple[UUID, UUID]:
    """A host and their room; ``question_time_ms`` only on a migration-011 schema."""
    player_id = uuid4()
    connection.execute(
        """
        INSERT INTO quiz_online.players (id, token_hash, nickname, character_id)
        VALUES (%s, %s, '점검방장', 'slime-blue')
        """,
        (player_id, hashlib.sha256(player_id.bytes).digest()),
    )
    code = uuid4().hex[:6].upper()
    if question_time_ms is None:
        room_row = connection.execute(
            """
            INSERT INTO quiz_online.rooms (code, name, capacity, is_public, host_player_id)
            VALUES (%s, '점검 방', 2, true, %s)
            RETURNING id
            """,
            (code, player_id),
        ).fetchone()
    else:
        room_row = connection.execute(
            """
            INSERT INTO quiz_online.rooms (
                code, name, capacity, is_public, host_player_id, question_time_ms
            )
            VALUES (%s, '점검 방', 2, true, %s, %s)
            RETURNING id
            """,
            (code, player_id, question_time_ms),
        ).fetchone()
    assert room_row is not None
    return player_id, room_row[0]


def _seed_active_match(connection: psycopg.Connection[Any]) -> None:
    player_id, room_id = _seed_room(connection)
    connection.execute(
        """
        INSERT INTO quiz_online.room_members (room_id, player_id, nickname, character_id)
        VALUES (%s, %s, '점검방장', 'slime-blue')
        """,
        (room_id, player_id),
    )
    connection.execute(
        """
        INSERT INTO quiz_online.matches (room_id, total_questions, deadline_at, expires_at)
        VALUES (%s, 10, now() + interval '20 seconds', now() + interval '2 hours')
        """,
        (room_id,),
    )
