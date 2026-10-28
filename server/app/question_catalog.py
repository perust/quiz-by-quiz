from __future__ import annotations

import itertools
import json
import logging
import random
import re
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
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
# 한 판의 난이도 비율을 분야 은행에 맞출 때 쓰는 값 (FR-1.10, 로컬 `core/sampler.ts`와 같은 규칙).
# 몫을 나누는 순서이기도 하다. 비공개 은행에는 `difficulty`가 없을 수 있다 — 없거나 이 셋 밖이면
# 모두 «모름» 한 칸에 모으므로, 은행 전체가 그러면 칸이 하나뿐이라 난이도를 보지 않던 예전과 같다.
DIFFICULTIES = ("easy", "normal", "hard")
_UNKNOWN_DIFFICULTY = "unknown"
# 공개 Pages `data/`의 문항 번호 모양이다 (`tools/check_bank.py`가 `<분야>-NNN`으로
# 잠근다). 그 문제는 정답·해설까지 Pages와 공개 Git에 있으므로, 온라인 은행에 이 모양의
# 번호가 하나라도 있으면 싣지 않는다 — 호스트가 `data/`의 사본을 mount 자리에 두면
# `config.py`의 경로 비교로는 알 수 없다. 분야는 파일과 상관없이 다섯 모두를 보고,
# 자릿수는 묶지 않아 공개 은행이 세 자리를 넘겨도 그대로 잡는다.
_PUBLIC_QUESTION_ID = re.compile(rf"(?:{'|'.join(map(re.escape, CATEGORY_IDS))})-[0-9]+")
# 온라인 문항 번호 (`deploy/oracle/ONLINE_QUESTION_BANK.md`). «이 문제 이상해요»가 이
# 번호를 공개 GitHub 이슈로 보내므로 번호만 담는다. 이 모양이 아니어도 싣되(번호에 내용이
# 담겼는지는 서버가 판정할 수 없다) 운영자가 docker logs에서 보도록 개수만 한 번 경고한다.
_ONLINE_QUESTION_ID = {
    category: re.compile(rf"online-{re.escape(category)}-[0-9]+") for category in CATEGORY_IDS
}

logger = logging.getLogger(__name__)


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
    # 셋 가운데 하나이거나 None(없음·규정 밖). 출제 몫에만 쓰고 응답에는 싣지 않는다
    difficulty: str | None = None

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
        public_id_count = 0
        public_id_files: list[str] = []
        off_format_id_count = 0

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
            file_public_ids = 0
            for index, item in enumerate(raw):
                question = _parse_question(
                    item, expected_category=category, source=f"{path.name}[{index}]"
                )
                if question.id in seen_ids:
                    raise CatalogError(f"duplicate question id: {question.id}")
                seen_ids.add(question.id)
                if _PUBLIC_QUESTION_ID.fullmatch(question.id):
                    file_public_ids += 1
                elif not _ONLINE_QUESTION_ID[category].fullmatch(question.id):
                    off_format_id_count += 1
                questions.append(question)
            by_category[category] = tuple(questions)
            if file_public_ids:
                public_id_count += file_public_ids
                public_id_files.append(path.name)

        # Both messages carry counts and file names only. They reach the container log (the
        # refusal through the startup traceback), so no question text, choice, answer or
        # explanation may appear — and the off-format warning omits the ids themselves.
        if public_id_count:
            raise CatalogError(
                f"{public_id_count} question ids use the public Pages bank format "
                f"<category>-NNN ({', '.join(public_id_files)}); the online bank must be "
                "authored independently of the public data/ directory"
            )
        if off_format_id_count:
            logger.warning(
                "online question bank: %d question ids are not in the online-<category>-<digits> "
                "format; the in-game report link sends ids to a public GitHub issue",
                off_format_id_count,
            )
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

        그 안에서 한 판의 난이도는 분야 은행의 난이도 비율을 따른다 (FR-1.10, 로컬과 같은 규칙).
        전체 판은 분야마다 다섯 문제를 지키면서 **판 전체**가 비율을 따르게 나눈다
        (`_all_round_quotas`). 고른 순서는 섞는다.
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
            banks = [self.by_category[category] for category in CATEGORY_IDS]
            quotas = _all_round_quotas(banks, QUESTIONS_PER_CATEGORY_IN_ALL, rng)
            selected = [
                question
                for bank, bank_quotas in zip(banks, quotas, strict=True)
                for question in _sample(
                    bank, QUESTIONS_PER_CATEGORY_IN_ALL, rng, recent, quotas=bank_quotas
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


def _difficulty_bucket(question: _CatalogQuestion) -> str:
    # `_parse_question`이 셋 밖의 값을 None으로 바꿔 둔다
    return question.difficulty or _UNKNOWN_DIFFICULTY


def _difficulty_quotas(
    questions: Sequence[_CatalogQuestion], take: int, random_source: random.Random
) -> dict[str, int]:
    """은행의 난이도 비율 × 낼 문항 수를 최대 나머지 방식으로 정수로 나눈다 (FR-1.10).

    내림한 몫을 먼저 주고 남은 자리는 나머지가 큰 칸부터 하나씩 더 준다. 나머지가 같은 칸끼리는
    무작위로 고른다. 정수로만 셈해 같은 나머지가 부동소수 오차로 갈리지 않는다(로컬과 같다).
    ``take``가 은행 크기를 넘지 않으면 어느 칸의 몫도 그 칸의 문제 수를 넘지 않는다.
    """
    if not questions:
        return {}
    sizes: dict[str, int] = {}
    for question in questions:
        bucket = _difficulty_bucket(question)
        sizes[bucket] = sizes.get(bucket, 0) + 1
    buckets = [bucket for bucket in (*DIFFICULTIES, _UNKNOWN_DIFFICULTY) if bucket in sizes]
    quotas: dict[str, int] = {}
    ranked: list[tuple[int, float, str]] = []
    for bucket in buckets:
        share = take * sizes[bucket]
        quotas[bucket] = share // len(questions)
        ranked.append((share % len(questions), random_source.random(), bucket))
    # 나머지가 큰 칸부터, 같으면 무작위 순서로
    ranked.sort(key=lambda entry: (-entry[0], entry[1]))
    for _, _, bucket in ranked[: max(0, take - sum(quotas.values()))]:
        quotas[bucket] += 1
    return quotas


@dataclass(eq=False)
class _RoundingCell:
    """전체 판의 몫을 나눌 때 분야 하나·난이도 하나의 칸 가운데 올림할 수 있는 칸.

    나머지가 0인 칸은 몫이 정수라 올림할 것이 없어 담지 않는다.
    """

    row: int
    bucket: str
    # 정확한 몫의 나머지(0보다 크고 1보다 작다)
    remainder: Fraction
    tie: float


def _all_round_quotas(
    banks: Sequence[Sequence[_CatalogQuestion]], count: int, random_source: random.Random
) -> list[dict[str, int]]:
    """전체 판의 난이도 몫을 분야마다 나눈다 (FR-1.10, 로컬 `allRoundQuotas`와 같은 규칙).

    분야마다 ``count``(은행이 작으면 있는 만큼) 문항 수는 그대로 두고 **판 전체**가
    은행의 비율을 따르게 한다. 분야마다 따로 최대 나머지로 나누면 지금 은행에서는 다섯 분야
    모두 어려움의 나머지가 가장 작아 어려움이 늘 하나로 내림됐다 — 25문제 판에 어려움이 늘
    다섯(20%)인데 은행은 26%다.

    1. 분야 c·난이도 d의 정확한 몫은 ``c의 문항 수 × (c의 d 문제 수) ÷ (c의 문제 수)``다.
       판의 목표는 난이도마다 그 합이고(분야마다 무작위로 뽑던 예전 출제의 기댓값), 그것을
       최대 나머지 방식으로 나눈 것이 판의 몫이다. 분수(``Fraction``)로만 셈해 같은 나머지가
       부동소수 오차로 갈리지 않는다.
    2. 칸마다 내림을 먼저 주고, 분야마다 남은 자리는 판의 몫이 모자란 난이도의 칸을 나머지가
       큰 것부터(같으면 무작위) 올림한다. 막히면 증가 경로로 다른 분야의 올림을 옮긴다 —
       맞출 수 있으면 언제나 맞춘다.
    3. 맞출 길이 없는 은행 모양이면 남은 자리는 그 분야 안에서 나머지가 큰 칸부터 올림한다.

    어느 칸도 정확한 몫의 내림·올림 밖으로 나가지 않는다 — 분야마다 문항 수는 그대로이고
    칸의 문제 수를 넘지 않는다.
    """
    quotas: list[dict[str, int]] = []
    need: list[int] = []
    cells: list[_RoundingCell] = []
    floor_sums: dict[str, int] = {}
    remainder_sums: dict[str, Fraction] = {}
    total = 0
    for row, questions in enumerate(banks):
        take = min(count, len(questions))
        total += take
        sizes: dict[str, int] = {}
        for question in questions:
            bucket = _difficulty_bucket(question)
            sizes[bucket] = sizes.get(bucket, 0) + 1
        row_quotas: dict[str, int] = {}
        given = 0
        for bucket in (*DIFFICULTIES, _UNKNOWN_DIFFICULTY):
            if bucket not in sizes:
                continue
            share = Fraction(take * sizes[bucket], len(questions))
            floor = share.numerator // share.denominator
            remainder = share - floor
            row_quotas[bucket] = floor
            given += floor
            floor_sums[bucket] = floor_sums.get(bucket, 0) + floor
            remainder_sums[bucket] = remainder_sums.get(bucket, Fraction(0)) + remainder
            if remainder:
                cells.append(_RoundingCell(row, bucket, remainder, random_source.random()))
        quotas.append(row_quotas)
        need.append(take - given)

    # 1. 판의 몫: 난이도마다 «내림의 합 + 나머지 합의 정수 부분», 남은 자리는 소수 부분이
    #    큰 난이도부터. ``want``는 «내림 위에 더 올림할 칸 수»다
    want: dict[str, int] = {}
    ranked: list[tuple[Fraction, float, str]] = []
    given = 0
    for bucket in (*DIFFICULTIES, _UNKNOWN_DIFFICULTY):
        if bucket not in remainder_sums:
            continue
        whole = remainder_sums[bucket].numerator // remainder_sums[bucket].denominator
        want[bucket] = whole
        given += floor_sums[bucket] + whole
        ranked.append((remainder_sums[bucket] - whole, random_source.random(), bucket))
    ranked.sort(key=lambda entry: (-entry[0], entry[1]))
    for _, _, bucket in ranked[: max(0, total - given)]:
        want[bucket] += 1

    # 2. 올림할 칸: 나머지가 큰 칸부터
    cells.sort(key=lambda cell: (-cell.remainder, cell.tie))
    raised: list[_RoundingCell] = []

    def raise_cell(cell: _RoundingCell) -> None:
        raised.append(cell)
        need[cell.row] -= 1
        want[cell.bucket] = want.get(cell.bucket, 0) - 1

    for cell in cells:
        if need[cell.row] > 0 and want.get(cell.bucket, 0) > 0:
            raise_cell(cell)

    def augment(start: int) -> bool:
        # «올림하지 않은 칸으로 난이도에 닿고, 그 난이도를 올림한 다른 분야로 건너가 그 올림을
        # 내리는» 길을 넓이 우선으로 찾는다. 지나간 분야·난이도의 올림 수는 그대로이고 start와
        # 끝 난이도만 하나씩 채워진다
        reached_bucket: dict[str, _RoundingCell] = {}
        reached_row: dict[int, _RoundingCell] = {}
        queue = [start]
        seen_rows = {start}
        while queue:
            row = queue.pop(0)
            for cell in cells:
                if cell.row != row or cell in raised or cell.bucket in reached_bucket:
                    continue
                reached_bucket[cell.bucket] = cell
                if want.get(cell.bucket, 0) > 0:
                    # 끝에서부터 거꾸로: 닿은 칸은 올림하고, 건너온 분야의 올림은 내린다
                    step = cell
                    while True:
                        raised.append(step)
                        if step.row == start:
                            break
                        lowered = reached_row[step.row]
                        raised.remove(lowered)
                        step = reached_bucket[lowered.bucket]
                    need[start] -= 1
                    want[cell.bucket] -= 1
                    return True
                for other in raised:
                    if other.bucket != cell.bucket or other.row in seen_rows:
                        continue
                    seen_rows.add(other.row)
                    reached_row[other.row] = other
                    queue.append(other.row)
        return False

    # 한 분야에서 막혀도 다른 분야의 경로가 올림을 옮긴 뒤에는 열릴 수 있어, 한 바퀴 내내
    # 옮긴 것이 없을 때까지 돈다
    progressed = True
    while progressed:
        progressed = False
        for row in range(len(banks)):
            while need[row] > 0 and augment(row):
                progressed = True

    # 3. 맞출 길이 없는 분야는 제 안에서 나머지가 큰 칸부터 올림한다
    for cell in cells:
        if need[cell.row] > 0 and cell not in raised:
            raise_cell(cell)

    for cell in raised:
        quotas[cell.row][cell.bucket] += 1
    return quotas


def _pick_by_quota(
    tiers: Sequence[Sequence[_CatalogQuestion]], take: int, quotas: Mapping[str, int]
) -> list[_CatalogQuestion]:
    """출제 순서의 층을 앞에서부터 돌며 난이도 몫대로 고른다 (FR-1.4 안의 FR-1.10).

    한 층 안에서는 몫이 남은 난이도부터 고르고, 그 층에서 몫을 다 채우지 못하면 같은 층의 나머지를
    층의 순서대로 채운 뒤에야 다음 층으로 간다 — 난이도를 맞추려고 안 본 문제를 두고 본 문제를 내지
    않는다. 다음 층에서는 아직 모자란 난이도부터 다시 채운다.
    """
    room = dict(quotas)
    picked: list[_CatalogQuestion] = []
    for tier in tiers:
        passed: list[_CatalogQuestion] = []
        for question in tier:
            if len(picked) >= take:
                return picked
            bucket = _difficulty_bucket(question)
            if room.get(bucket, 0) > 0:
                picked.append(question)
                room[bucket] -= 1
            else:
                passed.append(question)
        for question in passed:
            if len(picked) >= take:
                return picked
            picked.append(question)
    return picked


def _sample(
    questions: Sequence[_CatalogQuestion],
    count: int,
    random_source: random.Random,
    recent_use: Mapping[str, float],
    *,
    quotas: Mapping[str, int] | None = None,
) -> list[_CatalogQuestion]:
    # ``quotas``가 없으면 이 은행만의 난이도 몫(분야 판)이다. 전체 판은
    # `_all_round_quotas`가 판 전체로 나눈 몫을 넘긴다.
    # A malformed or temporarily shortened checked-in bank stays usable without
    # duplicating a question in the same match. Production validation guarantees
    # sufficient entries; this also makes fixture catalogs practical.
    take = min(count, len(questions))
    unseen = [question for question in questions if question.id not in recent_use]
    random_source.shuffle(unseen)
    seen = [question for question in questions if question.id in recent_use]
    # 같은 판에서 함께 나온 문제는 시각이 같다. 그 사이의 순서는 정하지 않도록 먼저 섞고,
    # 안정 정렬로 오래전에 본 것부터 세운다.
    random_source.shuffle(seen)
    seen.sort(key=lambda question: recent_use[question.id])
    # 안 본 문제가 한 층이고, 본 문제는 같은 시각(같은 판)끼리 한 층이다 — 같은 판에서 나온 문제
    # 사이에는 순서가 없으니 그 안에서 난이도를 맞춰도 «오래전에 본 것부터»를 어기지 않는다.
    tiers = [
        unseen,
        *(list(group) for _, group in itertools.groupby(seen, key=lambda q: recent_use[q.id])),
    ]
    if quotas is None:
        quotas = _difficulty_quotas(questions, take, random_source)
    picked = _pick_by_quota(tiers, take, quotas)
    # 고른 순서(난이도·본 순서)대로 판에 몰려 나오지 않게 섞는다.
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

    # 난이도는 거절하지 않는다 — 비공개 은행에 없을 수 있다. 셋 밖이면 «모름» 칸으로 출제한다
    difficulty = item.get("difficulty")
    return _CatalogQuestion(
        id=question_id,
        category=category,
        question=prompt,
        choices=tuple(choices_raw),
        answer_index=answer_index,
        explanation=explanation,
        difficulty=difficulty if difficulty in DIFFICULTIES else None,
    )


def _required_text(item: dict[str, Any], key: str, source: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise CatalogError(f"{source}.{key} must be a non-empty string")
    return value
