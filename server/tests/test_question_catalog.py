from __future__ import annotations

import json
import logging
import random
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

from app.question_catalog import CatalogError, QuestionCatalog

CATEGORIES = ("history", "science", "geography", "general", "art")


def _question(category: str, number: int) -> dict[str, object]:
    return {
        "id": f"online-{category}-{number:03d}",
        "category": category,
        "question": f"{category} question {number}?",
        "choices": ["one", "two", "three", "four"],
        "answerIndex": number % 4,
        "explanation": f"why {number}",
        "difficulty": "normal",
        "tags": [],
    }


def _write_catalog(root: Path, count: int = 10) -> None:
    root.mkdir(exist_ok=True)
    for category in CATEGORIES:
        (root / f"{category}.json").write_text(
            json.dumps([_question(category, number) for number in range(count)]),
            encoding="utf-8",
        )


def test_catalog_selects_category_round_and_keeps_answer_server_side(tmp_path: Path) -> None:
    _write_catalog(tmp_path)
    catalog = QuestionCatalog.from_directory(tmp_path)

    selected = catalog.select_round(
        category_id="history",
        random_source=random.Random(7),  # noqa: S311 - deterministic fixture only
    )

    assert len(selected) == 10
    assert {question.category for question in selected} == {"history"}
    assert len({question.id for question in selected}) == 10
    assert all(
        question.choices[question.answer_index] == question.correct_choice for question in selected
    )

    public = selected[0].to_public(position=1, total=len(selected))
    assert public.id == selected[0].id
    assert public.choices == selected[0].choices
    assert not hasattr(public, "answer_index")
    assert not hasattr(public, "correct_choice")
    assert not hasattr(public, "explanation")


def test_catalog_resolves_question_ids_and_fails_closed_for_unknown_id(tmp_path: Path) -> None:
    _write_catalog(tmp_path)
    catalog = QuestionCatalog.from_directory(tmp_path)

    resolved = catalog.get("online-science-003")
    assert resolved.id == "online-science-003"
    assert resolved.category == "science"

    with pytest.raises(CatalogError, match="unknown question id"):
        catalog.get("not-in-the-static-bank")


def test_catalog_selects_equal_category_mix_for_all_round(tmp_path: Path) -> None:
    _write_catalog(tmp_path)
    catalog = QuestionCatalog.from_directory(tmp_path)

    selected = catalog.select_round(
        category_id=None,
        random_source=random.Random(13),  # noqa: S311 - deterministic fixture only
    )

    assert len(selected) == 25
    assert {question.category for question in selected} == set(CATEGORIES)
    assert {
        category: sum(question.category == category for question in selected)
        for category in CATEGORIES
    } == {category: 5 for category in CATEGORIES}
    assert len({question.id for question in selected}) == len(selected)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda items: items.__setitem__(0, {**items[0], "answerIndex": 4}), "answerIndex"),
        (lambda items: items.__setitem__(0, {**items[0], "category": "other"}), "category"),
        (lambda items: items.__setitem__(1, {**items[1], "id": items[0]["id"]}), "duplicate"),
    ],
)
def test_catalog_rejects_malformed_or_duplicate_static_questions(
    tmp_path: Path,
    mutate: Callable[[list[dict[str, object]]], None],
    message: str,
) -> None:
    _write_catalog(tmp_path)
    history_path = tmp_path / "history.json"
    items = json.loads(history_path.read_text(encoding="utf-8"))
    mutate(items)
    history_path.write_text(json.dumps(items), encoding="utf-8")

    with pytest.raises(CatalogError, match=message):
        QuestionCatalog.from_directory(tmp_path)


def test_catalog_fails_closed_when_a_required_category_file_is_missing(tmp_path: Path) -> None:
    _write_catalog(tmp_path)
    (tmp_path / "art.json").unlink()

    with pytest.raises(CatalogError, match="art.json"):
        QuestionCatalog.from_directory(tmp_path)


# ── 공개 `data/`의 번호는 싣지 않고, 온라인 형식이 아닌 번호는 개수만 경고한다 ─────────


def _rewrite(root: Path, category: str, edit: Callable[[list[dict[str, object]]], None]) -> None:
    path = root / f"{category}.json"
    items = json.loads(path.read_text(encoding="utf-8"))
    edit(items)
    path.write_text(json.dumps(items), encoding="utf-8")


def _set_id(index: int, question_id: str) -> Callable[[list[dict[str, object]]], None]:
    return lambda items: items[index].__setitem__("id", question_id)


def test_catalog_refuses_a_host_copy_of_the_public_pages_bank(tmp_path: Path) -> None:
    public = Path(__file__).resolve().parents[2] / "data"
    if not (public / "history.json").is_file():
        pytest.skip("the public Pages data/ directory is not part of this checkout")
    # 호스트가 `data/`를 mount 자리에 복사해 둔 경우다 — 경로가 달라 config.py는 알아보지 못한다
    mounted = tmp_path / "online-bank"
    mounted.mkdir()
    texts: list[str] = []
    total = 0
    for category in CATEGORIES:
        raw = (public / f"{category}.json").read_text(encoding="utf-8")
        (mounted / f"{category}.json").write_text(raw, encoding="utf-8")
        items = json.loads(raw)
        total += len(items)
        texts.extend(
            text
            for item in items[:3]
            for text in (item["question"], item["explanation"], *item["choices"])
        )

    with pytest.raises(CatalogError, match="public Pages bank format") as refused:
        QuestionCatalog.from_directory(mounted)

    message = str(refused.value)
    assert message.startswith(f"{total} question ids ")
    assert all(text not in message for text in texts)


@pytest.mark.parametrize(
    ("category", "question_id"),
    [
        ("history", "history-000"),
        # 분야는 파일과 상관없이 다섯 모두를 본다
        ("history", "art-007"),
        # 공개 은행이 세 자리를 넘겨도 같다
        ("science", "science-1000"),
    ],
)
def test_catalog_refuses_even_one_public_format_id(
    tmp_path: Path, category: str, question_id: str
) -> None:
    _write_catalog(tmp_path)

    def leak(items: list[dict[str, object]]) -> None:
        items[0].update(
            id=question_id,
            question="SECRET question text",
            choices=["SECRET choice A", "SECRET choice B", "SECRET choice C", "SECRET choice D"],
            explanation="SECRET explanation",
        )

    _rewrite(tmp_path, category, leak)

    with pytest.raises(CatalogError, match="public Pages bank format") as refused:
        QuestionCatalog.from_directory(tmp_path)

    message = str(refused.value)
    assert message.startswith("1 question ids ")
    assert f"({category}.json)" in message
    assert "SECRET" not in message


def test_catalog_warns_once_with_only_a_count_for_ids_outside_the_online_format(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _write_catalog(tmp_path)
    off_format = (
        # 내용을 담은 이름이다 — 공개 이슈로 나가면 안 된다
        "online-history-hangul-1446",
        # 다른 분야의 번호
        "online-science-900",
        "presence-history-001",
    )
    _rewrite(tmp_path, "history", _set_id(0, off_format[0]))
    _rewrite(tmp_path, "history", _set_id(1, off_format[1]))
    _rewrite(tmp_path, "history", _set_id(2, off_format[2]))
    caplog.set_level(logging.WARNING, logger="app.question_catalog")

    catalog = QuestionCatalog.from_directory(tmp_path)

    # 경고일 뿐 은행은 그대로 실린다
    assert catalog.get(off_format[0]).category == "history"
    records = [record for record in caplog.records if record.name == "app.question_catalog"]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    message = records[0].getMessage()
    assert "3 question ids are not in the online-<category>-<digits> format" in message
    assert all(question_id not in message for question_id in off_format)
    assert "question 0?" not in message


def test_catalog_in_the_online_format_loads_without_a_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _write_catalog(tmp_path)
    caplog.set_level(logging.DEBUG, logger="app.question_catalog")

    QuestionCatalog.from_directory(tmp_path)

    assert [record for record in caplog.records if record.name == "app.question_catalog"] == []


def test_off_format_warning_reaches_stderr_under_the_runtime_uvicorn_logging(
    tmp_path: Path,
) -> None:
    _write_catalog(tmp_path)
    _rewrite(tmp_path, "art", _set_id(0, "art-named-mona-lisa"))
    # Dockerfile의 CMD처럼 uvicorn이 `--log-level warning`으로 logging을 설정한 뒤 app factory가
    # catalog를 읽는다. root에 handler가 없어 이 경고는 logging의 lastResort가 stderr로 낸다.
    script = (
        "import sys\n"
        "from pathlib import Path\n"
        "import uvicorn\n"
        "from app.question_catalog import QuestionCatalog\n"
        "uvicorn.Config('app.main:create_app', factory=True, log_level='warning')\n"
        "QuestionCatalog.from_directory(Path(sys.argv[1]))\n"
    )

    result = subprocess.run(  # noqa: S603 - fixed interpreter and script, test-owned path
        [sys.executable, "-c", script, str(tmp_path)],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "1 question ids are not in the online-<category>-<digits> format" in result.stderr
    assert "art-named-mona-lisa" not in result.stderr
    assert result.stdout == ""


# ── 같은 방의 «한 판 더»가 방금 푼 문제를 되풀이하지 않는다 (N08) ─────────────────


def _ids(selected: tuple[object, ...]) -> set[str]:
    return {question.id for question in selected}  # type: ignore[attr-defined]


def test_round_prefers_questions_this_room_has_not_seen(tmp_path: Path) -> None:
    _write_catalog(tmp_path, count=20)
    catalog = QuestionCatalog.from_directory(tmp_path)
    first = catalog.select_round(
        category_id="history",
        random_source=random.Random(3),  # noqa: S311 - deterministic fixture only
    )
    recent = {question.id: 100.0 for question in first}

    for seed in range(20):
        rematch = catalog.select_round(
            category_id="history",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
            recent_use=recent,
        )
        # 안 본 문제가 열 개 남아 있으면 본 문제는 하나도 다시 나오지 않는다
        assert len(rematch) == 10
        assert _ids(rematch).isdisjoint(_ids(first))


def test_round_fills_from_the_oldest_seen_questions_when_unseen_run_out(tmp_path: Path) -> None:
    _write_catalog(tmp_path, count=12)
    catalog = QuestionCatalog.from_directory(tmp_path)
    # 열두 문제를 모두 봤다. 판마다 시각이 다르다 — 숫자가 클수록 최근이다
    recent = {f"online-history-{number:03d}": float(number) for number in range(12)}

    for seed in range(20):
        selected = catalog.select_round(
            category_id="history",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
            recent_use=recent,
        )
        # 가장 최근에 본 둘(010·011)은 빠지고 오래전에 본 열 개가 나온다
        assert _ids(selected) == {f"online-history-{number:03d}" for number in range(10)}


def test_round_takes_every_unseen_question_before_any_seen_one(tmp_path: Path) -> None:
    _write_catalog(tmp_path, count=14)
    catalog = QuestionCatalog.from_directory(tmp_path)
    # 안 본 문제는 넷(010~013)뿐이다. 본 열 개 가운데 오래된 여섯이 채운다
    recent = {f"online-history-{number:03d}": float(100 - number) for number in range(10)}

    selected = catalog.select_round(
        category_id="history",
        random_source=random.Random(5),  # noqa: S311 - deterministic fixture only
        recent_use=recent,
    )

    assert _ids(selected) == {
        *(f"online-history-{number:03d}" for number in range(10, 14)),
        # 100 - number 가 작을수록 오래전이다: 009, 008, … 004
        *(f"online-history-{number:03d}" for number in range(4, 10)),
    }


def test_all_round_applies_the_room_memory_to_each_category(tmp_path: Path) -> None:
    _write_catalog(tmp_path, count=10)
    catalog = QuestionCatalog.from_directory(tmp_path)
    first = catalog.select_round(
        category_id=None,
        random_source=random.Random(11),  # noqa: S311 - deterministic fixture only
    )
    recent = {question.id: 1.0 for question in first}

    rematch = catalog.select_round(
        category_id=None,
        random_source=random.Random(12),  # noqa: S311 - deterministic fixture only
        recent_use=recent,
    )

    # 분야마다 열 문제 중 다섯을 봤으니 남은 다섯이 그대로 나온다 — 분야별 다섯 개도 그대로다
    assert len(rematch) == 25
    assert _ids(rematch).isdisjoint(_ids(first))
    assert {
        category: sum(question.category == category for question in rematch)
        for category in CATEGORIES
    } == {category: 5 for category in CATEGORIES}


def test_unknown_or_empty_room_memory_keeps_the_plain_random_round(tmp_path: Path) -> None:
    _write_catalog(tmp_path, count=10)
    catalog = QuestionCatalog.from_directory(tmp_path)

    plain = catalog.select_round(
        category_id="science",
        random_source=random.Random(9),  # noqa: S311 - deterministic fixture only
    )
    remembered_elsewhere = catalog.select_round(
        category_id="science",
        random_source=random.Random(9),  # noqa: S311 - deterministic fixture only
        # 다른 분야·없어진 문제의 기억은 이 분야의 판을 바꾸지 않는다
        recent_use={"online-history-001": 1.0, "retired-question": 2.0},
    )

    assert [question.id for question in remembered_elsewhere] == [
        question.id for question in plain
    ]
