from __future__ import annotations

import json
import random
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CATEGORY_IDS = ("history", "science", "geography", "general", "art")
QUESTIONS_PER_CATEGORY_ROUND = 10
QUESTIONS_PER_CATEGORY_IN_ALL = 5
CHOICE_COUNT = 4
# 한 방이 기억하는 최근 출제 문항 수 (N08). 로컬 FR-1.4의 `RECENT_QUESTION_MEMORY`처럼 한 판이
# 아니라 여러 판을 기억한다 — 분야 판 12번, 전체 판 4~5번 분량이다. 기억이 은행을 다 덮어도
# 깨지지 않는다: 안 본 문제가 모자라면 오래전에 본 것부터 채운다.
RECENT_QUESTION_MEMORY = 120


class CatalogError(RuntimeError):
    """The checked-in static question bank cannot safely drive an online match."""


@dataclass(frozen=True)
class PublicQuestion:
    """Question payload safe to send before a player submits an answer."""

    id: str
    category: str
    question: str
    choices: tuple[str, ...]
    position: int
    total: int


@dataclass(frozen=True)
class SelectedQuestion:
    """A match-specific option order retained exclusively at the server boundary."""

    id: str
    category: str
    question: str
    choices: tuple[str, ...]
    answer_index: int
    correct_choice: str
    explanation: str

    def to_public(self, *, position: int, total: int) -> PublicQuestion:
        return PublicQuestion(
            id=self.id,
            category=self.category,
            question=self.question,
            choices=self.choices,
            position=position,
            total=total,
        )


@dataclass(frozen=True)
class _CatalogQuestion:
    id: str
    category: str
    question: str
    choices: tuple[str, ...]
    answer_index: int
    explanation: str

    def shuffled(self, random_source: random.Random) -> SelectedQuestion:
        order = list(range(CHOICE_COUNT))
        random_source.shuffle(order)
        choices = tuple(self.choices[index] for index in order)
        answer_index = order.index(self.answer_index)
        return SelectedQuestion(
            id=self.id,
            category=self.category,
            question=self.question,
            choices=choices,
            answer_index=answer_index,
            correct_choice=self.choices[self.answer_index],
            explanation=self.explanation,
        )


@dataclass(frozen=True)
class QuestionCatalog:
    """Validated immutable source for server-authoritative online match questions.

    Questions remain checked-in static assets rather than rows in PostgreSQL. The
    match repository persists only an immutable ID and the match-specific option
    order/answer position it needs to grade submissions after a deploy.
    """

    by_category: dict[str, tuple[_CatalogQuestion, ...]]

    @classmethod
    def from_directory(cls, directory: Path) -> QuestionCatalog:
        by_category: dict[str, tuple[_CatalogQuestion, ...]] = {}
        seen_ids: set[str] = set()

        for category in CATEGORY_IDS:
            path = directory / f"{category}.json"
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError as error:
                raise CatalogError(
                    f"required static question file is missing: {path.name}"
                ) from error
            except (OSError, json.JSONDecodeError) as error:
                raise CatalogError(f"could not read static question file: {path.name}") from error

            if not isinstance(raw, list) or not raw:
                raise CatalogError(f"{path.name} must contain a non-empty JSON array")

            questions: list[_CatalogQuestion] = []
            for index, item in enumerate(raw):
                question = _parse_question(
                    item, expected_category=category, source=f"{path.name}[{index}]"
                )
                if question.id in seen_ids:
                    raise CatalogError(f"duplicate question id: {question.id}")
                seen_ids.add(question.id)
                questions.append(question)
            by_category[category] = tuple(questions)

        return cls(by_category=by_category)

    def select_round(
        self,
        *,
        category_id: str | None,
        random_source: random.Random | None = None,
        recent_use: Mapping[str, float] | None = None,
    ) -> tuple[SelectedQuestion, ...]:
        """한 판의 문제를 고른다.

        ``recent_use``는 이 방에서 최근에 낸 문항 ID → 마지막으로 낸 시각(클수록 최근)이다 (N08).
        안 본 문제를 먼저 내고, 모자랄 때만 본 문제를 **오래전에 본 것부터** 채운다 — 로컬
        FR-1.4(`core/sampler.ts`)와 같은 규칙이다. 본 문제를 무작위로 섞어 채우면 은행이 바닥났을 때
        방금 푼 문제가 곧바로 다음 판에 돌아온다.
        """
        rng = random_source or secrets.SystemRandom()
        recent = recent_use or {}
        if category_id is not None:
            if category_id not in self.by_category:
                raise CatalogError(f"unsupported category: {category_id}")
            selected = _sample(
                self.by_category[category_id],
                QUESTIONS_PER_CATEGORY_ROUND,
                rng,
                recent,
            )
        else:
            selected = [
                question
                for category in CATEGORY_IDS
                for question in _sample(
                    self.by_category[category], QUESTIONS_PER_CATEGORY_IN_ALL, rng, recent
                )
            ]
            rng.shuffle(selected)

        if not selected:
            raise CatalogError("the static question bank has no selectable questions")
        return tuple(question.shuffled(rng) for question in selected)

    def get(self, question_id: str) -> _CatalogQuestion:
        for questions in self.by_category.values():
            for question in questions:
                if question.id == question_id:
                    return question
        raise CatalogError(f"unknown question id in static catalog: {question_id}")


def _sample(
    questions: tuple[_CatalogQuestion, ...],
    count: int,
    random_source: random.Random,
    recent_use: Mapping[str, float],
) -> list[_CatalogQuestion]:
    # A malformed or temporarily shortened checked-in bank stays usable without
    # duplicating a question in the same match. Production validation guarantees
    # sufficient entries; this also makes fixture catalogs practical.
    unseen = [question for question in questions if question.id not in recent_use]
    if len(unseen) >= count:
        return random_source.sample(unseen, k=count)
    seen = [question for question in questions if question.id in recent_use]
    # 같은 판에서 함께 나온 문제는 시각이 같다. 그 사이의 순서는 정하지 않도록 먼저 섞고,
    # 안정 정렬로 오래전에 본 것부터 세운다.
    random_source.shuffle(seen)
    seen.sort(key=lambda question: recent_use[question.id])
    picked = unseen + seen[: count - len(unseen)]
    # 채운 본 문제가 늘 판 끝에 몰리지 않게 섞는다.
    random_source.shuffle(picked)
    return picked


def _parse_question(item: object, *, expected_category: str, source: str) -> _CatalogQuestion:
    if not isinstance(item, dict):
        raise CatalogError(f"{source} must be an object")

    question_id = _required_text(item, "id", source)
    category = _required_text(item, "category", source)
    if category != expected_category:
        raise CatalogError(f"{source}.category must be {expected_category!r}")

    prompt = _required_text(item, "question", source)
    explanation = _required_text(item, "explanation", source)
    choices_raw = item.get("choices")
    if (
        not isinstance(choices_raw, list)
        or len(choices_raw) != CHOICE_COUNT
        or any(not isinstance(choice, str) or not choice.strip() for choice in choices_raw)
        or len(set(choices_raw)) != CHOICE_COUNT
    ):
        raise CatalogError(f"{source}.choices must be {CHOICE_COUNT} distinct non-empty strings")

    answer_index = item.get("answerIndex")
    if type(answer_index) is not int or answer_index not in range(CHOICE_COUNT):
        raise CatalogError(f"{source}.answerIndex must be an integer from 0 to {CHOICE_COUNT - 1}")

    return _CatalogQuestion(
        id=question_id,
        category=category,
        question=prompt,
        choices=tuple(choices_raw),
        answer_index=answer_index,
        explanation=explanation,
    )


def _required_text(item: dict[str, Any], key: str, source: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise CatalogError(f"{source}.{key} must be a non-empty string")
    return value
