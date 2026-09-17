"""문제 은행의 구조와 반복·편향 신호를 검증한다.

기본 실행::

    python3 tools/check_bank.py

카테고리 하나의 문제를 사람이 검토할 때::

    python3 tools/check_bank.py --category 과학 --show-questions

카테고리와 전체 도전 문항 수는 별도로 복사하지 않고 ``src/constants.ts``에서
읽는다. 오류는 종료 코드 1, 잘못된 CLI 인자는 종료 코드 2다. 사람의 판단이
필요한 휴리스틱은 경고로만 출력하고 성공 종료한다.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

LEVELS = ("easy", "normal", "hard")
REQUIRED_FIELDS = (
    "id",
    "category",
    "question",
    "choices",
    "answerIndex",
    "explanation",
    "difficulty",
    "tags",
)
DIFFICULTY_TARGET = {"easy": 0.40, "normal": 0.40, "hard": 0.20}
SUPERLATIVE = re.compile(
    r"가장|제일|최초|최대|최소|최고|최장|최단|최상|유일|으뜸|"
    r"\d+\s*번째|[첫둘두셋세넷네]\s*번째|첫째|둘째|셋째|\d+\s*위"
)
QUALIFIER = re.compile(
    "면적|넓이|인구|길이|높이|깊이|수심|해발|지름|부피|무게|생산량|규모|수용|낙차|"
    "현존|기록상|상용화|공식|기준|가운데|중에서|중\\s|에서|나라|대륙|태양계|지구|"
    "대한민국|우리나라|세계|한반도|아프리카|아시아|유럽|일\\s*년|열두\\s*달|가까운"
)
UNICODE_ESCAPE = re.compile(r"\\u[0-9a-fA-F]{4}")
CATEGORIES_BLOCK = re.compile(
    r"export\s+const\s+CATEGORIES(?:\s*:\s*[^=]+)?\s*=\s*\[(?P<body>.*?)\]\s*;",
    re.DOTALL,
)
CATEGORY_OBJECT = re.compile(r"\{(?P<body>[^{}]*)\}", re.DOTALL)


@dataclass(frozen=True)
class Category:
    code: str
    name: str


@dataclass(frozen=True)
class ProjectConfig:
    categories: tuple[Category, ...]
    questions_per_round: int
    questions_per_category_in_all: int

    @property
    def category_codes(self) -> tuple[str, ...]:
        return tuple(category.code for category in self.categories)

    @property
    def aliases(self) -> dict[str, str]:
        return {category.name: category.code for category in self.categories}

    @property
    def all_round_questions(self) -> int:
        return len(self.categories) * self.questions_per_category_in_all

    def name_for(self, code: str) -> str:
        return next(
            category.name for category in self.categories if category.code == code
        )


@dataclass(frozen=True)
class QuestionRow:
    id: str
    category: str
    question: str
    choices: tuple[str, ...]
    answer_index: int
    explanation: str
    difficulty: str
    tags: tuple[str, ...]
    source: str

    @property
    def answer(self) -> str:
        return self.choices[self.answer_index]

    @property
    def answer_is_longest(self) -> bool:
        other_lengths = [
            len(choice)
            for index, choice in enumerate(self.choices)
            if index != self.answer_index
        ]
        return len(self.answer) > max(other_lengths)


@dataclass(frozen=True)
class CategoryStats:
    count: int
    difficulty: Counter[str]
    answer_positions: Counter[int]
    longest_answers: int


@dataclass
class AuditReport:
    config: ProjectConfig
    questions: list[QuestionRow] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats: dict[str, CategoryStats] = field(default_factory=dict)

    @property
    def total_questions(self) -> int:
        return len(self.questions)


class ConfigError(ValueError):
    """The application constants could not be read safely."""


def _integer_constant(source: str, name: str) -> int:
    match = re.search(
        rf"export\s+const\s+{re.escape(name)}\s*=\s*(\d[\d_]*)\s*;", source
    )
    if not match:
        raise ConfigError(f"src/constants.ts에서 {name} 값을 찾지 못했습니다")
    return int(match.group(1).replace("_", ""))


def _category_string_field(body: str, field_name: str) -> str:
    pattern = re.compile(
        rf"\b{re.escape(field_name)}\s*:\s*(?P<quote>['\"])(?P<value>.*?)(?P=quote)",
        re.DOTALL,
    )
    matches = list(pattern.finditer(body))
    if len(matches) != 1 or not matches[0].group("value").strip():
        raise ConfigError(
            f"CATEGORIES 항목마다 {field_name} 문자열이 정확히 하나 필요합니다"
        )
    return matches[0].group("value").strip()


def load_project_config(root: Path) -> ProjectConfig:
    path = root / "src" / "constants.ts"
    try:
        source = path.read_text(encoding="utf-8")
    except UnicodeError as error:
        raise ConfigError(f"{path}: UTF-8 디코딩 실패 — {error}") from error
    except OSError as error:
        raise ConfigError(f"{path}: 읽기 실패 — {error}") from error

    block = CATEGORIES_BLOCK.search(source)
    if not block:
        raise ConfigError("src/constants.ts에서 CATEGORIES 배열을 찾지 못했습니다")
    block_body = block.group("body")
    objects = list(CATEGORY_OBJECT.finditer(block_body))
    if not objects:
        raise ConfigError("src/constants.ts에서 CATEGORIES 항목을 찾지 못했습니다")

    remainder = CATEGORY_OBJECT.sub("", block_body)
    remainder = re.sub(r"//[^\n]*|/\*.*?\*/", "", remainder, flags=re.DOTALL)
    if remainder.strip(" \t\r\n,"):
        raise ConfigError(
            "src/constants.ts의 CATEGORIES에 해석할 수 없는 항목이 있습니다"
        )

    categories_list: list[Category] = []
    for item in objects:
        body = item.group("body")
        code = _category_string_field(body, "id")
        name = _category_string_field(body, "name")
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", code):
            raise ConfigError(
                f"CATEGORIES의 카테고리 코드 형식이 잘못되었습니다: {code!r}"
            )
        categories_list.append(Category(code, name))
    categories = tuple(categories_list)
    codes = [category.code for category in categories]
    names = [category.name for category in categories]
    if len(codes) != len(set(codes)) or len(names) != len(set(names)):
        raise ConfigError("src/constants.ts의 카테고리 코드 또는 이름이 중복됩니다")

    questions_per_round = _integer_constant(source, "QUESTIONS_PER_ROUND")
    questions_per_category_in_all = _integer_constant(
        source, "QUESTIONS_PER_CATEGORY_IN_ALL"
    )
    if questions_per_round < 1 or questions_per_category_in_all < 1:
        raise ConfigError("출제 문항 수 상수는 양의 정수여야 합니다")

    return ProjectConfig(
        categories=categories,
        questions_per_round=questions_per_round,
        questions_per_category_in_all=questions_per_category_in_all,
    )


def normalize(text: str) -> str:
    return re.sub(r"[^가-힣a-zA-Z0-9]", "", text).casefold()


def _label(path: Path, index: int, row: object) -> str:
    if isinstance(row, dict) and isinstance(row.get("id"), str):
        return f"[{row['id']}]"
    return f"[{path.as_posix()}:{index + 1}]"


def _read_bank(path: Path, report: AuditReport) -> list[object]:
    relative = path.relative_to(path.parents[1]).as_posix()
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeError as error:
        report.errors.append(f"{relative}: UTF-8 디코딩 실패 — {error}")
        return []
    except OSError as error:
        report.errors.append(f"{relative}: 읽기 실패 — {error}")
        return []

    if UNICODE_ESCAPE.search(raw):
        report.errors.append(
            f"{relative}: \\uXXXX Unicode 이스케이프가 있습니다. "
            "ensure_ascii=False로 한글을 그대로 저장하세요"
        )

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        report.errors.append(f"{relative}: JSON 파싱 실패 — {error}")
        return []
    if not isinstance(parsed, list):
        report.errors.append(f"{relative}: 최상위가 배열이 아님")
        return []
    return parsed


def _validated_question(
    path: Path,
    category: str,
    index: int,
    value: object,
    report: AuditReport,
) -> QuestionRow | None:
    label = _label(path, index, value)
    if not isinstance(value, dict):
        report.errors.append(f"{label} 문제 항목이 객체가 아님")
        return None

    for key in REQUIRED_FIELDS:
        if key not in value:
            report.errors.append(f"{label} 키 없음: {key}")

    qid = value.get("id")
    if not isinstance(qid, str) or not qid.strip():
        report.errors.append(f"{label} id는 비어 있지 않은 문자열이어야 함")
        qid = ""
    elif not re.fullmatch(rf"{re.escape(category)}-\d{{3}}", qid):
        report.errors.append(f"{label} ID 형식이 파일과 맞지 않음: {category}-NNN 필요")

    row_category = value.get("category")
    if row_category != category:
        report.errors.append(f"{label} category가 파일명과 다름: {row_category!r}")

    question = value.get("question")
    if not isinstance(question, str) or not question.strip():
        report.errors.append(f"{label} question은 비어 있지 않은 문자열이어야 함")
        question = ""

    choices_value = value.get("choices")
    choices: list[str] = []
    if not isinstance(choices_value, list):
        report.errors.append(f"{label} choices는 배열이어야 함")
    else:
        choices = choices_value
        if len(choices) != 4:
            report.errors.append(f"{label} 보기는 4개여야 함: {len(choices)}개")
        if any(not isinstance(choice, str) or not choice.strip() for choice in choices):
            report.errors.append(f"{label} 모든 보기는 비어 있지 않은 문자열이어야 함")
        comparable = [choice.strip() for choice in choices if isinstance(choice, str)]
        if len(comparable) != len(set(comparable)):
            report.errors.append(f"{label} 보기 중복")

    answer_index = value.get("answerIndex")
    valid_index = type(answer_index) is int and 0 <= answer_index < 4
    if not valid_index:
        report.errors.append(
            f"{label} answerIndex는 0부터 3 사이 정수여야 함: {answer_index!r}"
        )

    explanation = value.get("explanation")
    if not isinstance(explanation, str) or not explanation.strip():
        report.errors.append(f"{label} explanation은 비어 있지 않은 문자열이어야 함")
        explanation = ""

    difficulty = value.get("difficulty")
    if difficulty not in LEVELS:
        report.errors.append(f"{label} difficulty 규정 밖: {difficulty!r}")
        difficulty = ""

    tags_value = value.get("tags")
    tags: list[str] = []
    if not isinstance(tags_value, list) or not tags_value:
        report.errors.append(f"{label} tags는 비어 있지 않은 배열이어야 함")
    else:
        tags = tags_value
        if any(not isinstance(tag, str) or not tag.strip() for tag in tags):
            report.errors.append(f"{label} tags에는 비어 있지 않은 문자열만 허용됨")

    can_use = (
        bool(qid)
        and bool(question)
        and isinstance(row_category, str)
        and len(choices) == 4
        and all(isinstance(choice, str) and choice.strip() for choice in choices)
        and valid_index
        and bool(explanation)
        and difficulty in LEVELS
        and bool(tags)
        and all(isinstance(tag, str) and tag.strip() for tag in tags)
    )
    if not can_use:
        return None

    # can_use가 보장하는 런타임 타입을 정적 검사기에도 알려 준다.
    assert isinstance(row_category, str)
    assert type(answer_index) is int

    row = QuestionRow(
        id=qid,
        # 파일 경로가 통계와 중복 검사의 소속 기준이다. JSON 필드가 다르면 위에서
        # 오류로 보고하되, 잘못된 값 때문에 후속 진단 자체가 예외를 내면 안 된다.
        category=category,
        question=question.strip(),
        choices=tuple(choice.strip() for choice in choices),
        answer_index=answer_index,
        explanation=explanation.strip(),
        difficulty=difficulty,
        tags=tuple(tag.strip() for tag in tags),
        source=f"data/{category}.json:{index + 1}",
    )

    for field_name, text in (
        ("question", row.question),
        ("explanation", row.explanation),
    ):
        if SUPERLATIVE.search(text) and not QUALIFIER.search(text):
            report.warnings.append(
                f"[{row.id}] {field_name}의 최상급에 기준·범위가 안 보임: {text[:60]}"
            )
    return row


def _cross_question_checks(report: AuditReport) -> None:
    by_id: defaultdict[str, list[str]] = defaultdict(list)
    by_question: defaultdict[str, list[str]] = defaultdict(list)
    by_answer: defaultdict[tuple[str, str], list[str]] = defaultdict(list)

    for row in report.questions:
        by_id[row.id].append(row.source)
        by_question[normalize(row.question)].append(row.id)
        by_answer[(row.category, normalize(row.answer))].append(row.id)

    for qid, sources in by_id.items():
        if len(sources) > 1:
            report.errors.append(f"ID 중복: {qid} — {', '.join(sources)}")
    for ids in by_question.values():
        if len(ids) > 1:
            report.errors.append(f"문항 문장 중복: {', '.join(ids)}")
    for (category, answer), ids in by_answer.items():
        if len(ids) > 1:
            name = report.config.name_for(category)
            report.warnings.append(
                f"{name} 정답이 같은 문항: {', '.join(ids)} → {answer}"
            )


def _build_stats(report: AuditReport) -> None:
    minimum_bank_size = max(
        report.config.questions_per_round,
        report.config.questions_per_category_in_all,
    )
    for category in report.config.category_codes:
        rows = [row for row in report.questions if row.category == category]
        report.stats[category] = CategoryStats(
            count=len(rows),
            difficulty=Counter(row.difficulty for row in rows),
            answer_positions=Counter(row.answer_index for row in rows),
            longest_answers=sum(row.answer_is_longest for row in rows),
        )
        if len(rows) < minimum_bank_size:
            report.errors.append(
                f"{report.config.name_for(category)} 유효 문항 {len(rows)}개: "
                f"출제 수 {minimum_bank_size}문제보다 적음"
            )

    counts = {code: stats.count for code, stats in report.stats.items()}
    if counts and len(set(counts.values())) > 1:
        detail = ", ".join(
            f"{report.config.name_for(code)} {count}" for code, count in counts.items()
        )
        report.warnings.append(f"카테고리별 문항 수가 다름: {detail}")

    for code, stats in report.stats.items():
        if not stats.count:
            continue
        deviation = sum(
            abs(stats.difficulty.get(level, 0) / stats.count - DIFFICULTY_TARGET[level])
            for level in LEVELS
        )
        if deviation > 0.30:
            report.warnings.append(
                f"{report.config.name_for(code)} 난이도 분포 편차가 큼: "
                + "/".join(str(stats.difficulty.get(level, 0)) for level in LEVELS)
                + " (목표 40%/40%/20%)"
            )


def audit_repository(root: Path) -> AuditReport:
    root = root.resolve()
    config = load_project_config(root)
    report = AuditReport(config=config)
    data_dir = root / "data"

    expected = {f"{code}.json" for code in config.category_codes}
    try:
        actual = {path.name for path in data_dir.glob("*.json")}
    except OSError as error:
        report.errors.append(f"data/: 파일 목록 읽기 실패 — {error}")
        actual = set()

    for unknown in sorted(actual - expected):
        report.errors.append(f"data/{unknown}: 알 수 없는 카테고리 파일")

    for category in config.category_codes:
        path = data_dir / f"{category}.json"
        if not path.exists():
            report.errors.append(f"data/{category}.json: 카테고리 파일 없음")
            continue
        if not path.is_file():
            report.errors.append(f"data/{category}.json: 일반 파일이 아님")
            continue
        for index, value in enumerate(_read_bank(path, report)):
            row = _validated_question(path, category, index, value, report)
            if row is not None:
                report.questions.append(row)

    _cross_question_checks(report)
    _build_stats(report)
    return report


def resolve_category(config: ProjectConfig, token: str | None) -> str | None:
    if not token:
        return None
    stripped = token.strip()
    lowered = stripped.casefold()
    for code in config.category_codes:
        if lowered == code.casefold():
            return code
    return config.aliases.get(stripped)


def _print_summary(report: AuditReport, category: str | None) -> None:
    selected_codes = (category,) if category else report.config.category_codes
    selected_rows = [
        row for row in report.questions if category is None or row.category == category
    ]
    scope = report.config.name_for(category) if category else "전체 카테고리"
    print(
        f"대상: {scope} · 유효 문항 {len(selected_rows)}개 "
        f"(전체 {report.total_questions}개)"
    )
    print(
        f"출제 수: 카테고리 {report.config.questions_per_round}문제 · "
        f"전체 도전 {report.config.all_round_questions}문제"
    )
    for code in selected_codes:
        stats = report.stats[code]
        if not stats.count:
            print(f"  {report.config.name_for(code):<6}   0개")
            continue
        difficulty = " ".join(
            f"{level} {stats.difficulty.get(level, 0):>2}" for level in LEVELS
        )
        positions = "/".join(
            str(stats.answer_positions.get(index, 0)) for index in range(4)
        )
        longest_ratio = stats.longest_answers / stats.count * 100
        print(
            f"  {report.config.name_for(code):<6} {stats.count:>3}개 | "
            f"{difficulty} | 정답위치 {positions} | 정답이 최장 {longest_ratio:.0f}%"
        )


def _print_questions(report: AuditReport, category: str | None) -> None:
    rows = [
        row for row in report.questions if category is None or row.category == category
    ]
    print("\n문항 목록")
    for row in rows:
        print(f"\n[{row.id}] {row.difficulty} · {row.question}")
        for index, choice in enumerate(row.choices):
            marker = "  ← 정답" if index == row.answer_index else ""
            print(f"  {index}. {choice}{marker}")
        print(f"  해설: {row.explanation}")
        print(f"  태그: {', '.join(row.tags)}")


def _print_similar(report: AuditReport, category: str | None, threshold: float) -> None:
    rows = [
        row for row in report.questions if category is None or row.category == category
    ]
    candidates: list[tuple[float, QuestionRow, QuestionRow]] = []
    for left_index, left in enumerate(rows):
        left_text = normalize(left.question)
        for right in rows[left_index + 1 :]:
            ratio = SequenceMatcher(None, left_text, normalize(right.question)).ratio()
            if ratio >= threshold:
                candidates.append((ratio, left, right))
    candidates.sort(key=lambda item: (-item[0], item[1].id, item[2].id))

    print(f"\n유사 문항 후보 {len(candidates)}건 (기준 {threshold:.2f} 이상)")
    for ratio, left, right in candidates:
        print(f"  {ratio:.0%} · {left.id} ↔ {right.id}")
        print(f"    {left.question}")
        print(f"    {right.question}")


def _print_findings(report: AuditReport, category: str | None) -> None:
    def applies(message: str) -> bool:
        if category is None:
            return True
        category_ids = {row.id for row in report.questions if row.category == category}
        if any(f"[{qid}]" in message for qid in category_ids):
            return True
        return report.config.name_for(category) in message or "카테고리별" in message

    warnings = [message for message in report.warnings if applies(message)]
    if warnings:
        print(f"\n확인 필요 {len(warnings)}건")
        for message in warnings:
            print("  ?", message)
    if report.errors:
        print(f"\n실패 {len(report.errors)}건")
        for message in report.errors:
            print("  !!", message)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="퀴즈 문제 은행을 검증합니다")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--category", help="카테고리 코드 또는 한국어 이름")
    parser.add_argument(
        "--show-questions",
        action="store_true",
        help="사실 검토용으로 질문·보기·정답·해설을 모두 출력",
    )
    parser.add_argument(
        "--show-similar",
        action="store_true",
        help="문장 유사도가 높은 문항 쌍을 사람이 검토할 후보로 출력",
    )
    parser.add_argument(
        "--similarity-threshold",
        type=float,
        default=0.70,
        help="--show-similar의 유사도 기준(0부터 1, 기본 0.70)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        report = audit_repository(args.root)
    except ConfigError as error:
        print(f"검증 실패: {error}", file=sys.stderr)
        return 1

    category = resolve_category(report.config, args.category)
    if args.category and category is None:
        available = ", ".join(
            f"{item.name}({item.code})" for item in report.config.categories
        )
        parser.error(f"알 수 없는 카테고리: {args.category!r}. 사용 가능: {available}")
    if not 0 <= args.similarity_threshold <= 1:
        parser.error("--similarity-threshold는 0부터 1 사이여야 합니다")

    _print_summary(report, category)
    if args.show_questions:
        _print_questions(report, category)
    if args.show_similar:
        _print_similar(report, category, args.similarity_threshold)
    _print_findings(report, category)
    if report.errors:
        return 1
    print("\n통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
