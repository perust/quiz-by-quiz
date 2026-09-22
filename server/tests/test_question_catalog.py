from __future__ import annotations

import json
import random
from collections.abc import Callable
from pathlib import Path

import pytest

from app.question_catalog import CatalogError, QuestionCatalog

CATEGORIES = ("history", "science", "geography", "general", "art")


def _question(category: str, number: int) -> dict[str, object]:
    return {
        "id": f"{category}-{number:03d}",
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

    resolved = catalog.get("science-003")
    assert resolved.id == "science-003"
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
