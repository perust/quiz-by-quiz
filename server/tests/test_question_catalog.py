from __future__ import annotations

import json
import logging
import math
import random
import subprocess
import sys
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path

import pytest

from app.question_catalog import (
    DIFFICULTIES,
    CatalogError,
    QuestionCatalog,
    _all_round_quotas,
    _CatalogQuestion,
)

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


# ── 한 판의 난이도는 분야 은행의 비율을 따른다 (FR-1.10, N05) ─────────────────────
# 로컬 `core/sampler.ts`와 같은 규칙이다 — `tests/sampler-difficulty.test.mjs`가 같은 경우를 본다.


def _levels(sizes: dict[str, int]) -> list[object]:
    return [level for level, count in sizes.items() for _ in range(count)]


def _write_levelled_catalog(root: Path, levels: list[object]) -> None:
    """분야마다 같은 난이도 배열을 쓴다. 값이 ``...``이면 ``difficulty`` 키를 아예 두지 않는다."""
    root.mkdir(exist_ok=True)
    for category in CATEGORIES:
        items = []
        for number, level in enumerate(levels):
            item = _question(category, number)
            if level is ...:
                del item["difficulty"]
            else:
                item["difficulty"] = level
            items.append(item)
        (root / f"{category}.json").write_text(json.dumps(items), encoding="utf-8")


def _difficulty_of(catalog: QuestionCatalog, selected: tuple[object, ...]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for question in selected:
        level = catalog.get(question.id).difficulty or "unknown"  # type: ignore[attr-defined]
        counts[level] = counts.get(level, 0) + 1
    return counts


def test_category_round_follows_the_bank_difficulty_share(tmp_path: Path) -> None:
    # 40/42/28: 3.64 · 3.82 · 2.55 → 내림 3·3·2 + 나머지가 큰 보통·쉬움 → 4·4·2
    _write_levelled_catalog(tmp_path, _levels({"easy": 40, "normal": 42, "hard": 28}))
    catalog = QuestionCatalog.from_directory(tmp_path)

    for seed in range(30):
        selected = catalog.select_round(
            category_id="science",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        assert len(selected) == 10
        assert _difficulty_of(catalog, selected) == {"easy": 4, "normal": 4, "hard": 2}


def test_equal_remainders_are_broken_at_random(tmp_path: Path) -> None:
    # 40/41/29: 나머지가 쉬움·어려움 같다(70/110). 보통은 늘 넷, 남은 한 자리는 판마다 갈린다.
    # 정수로 셈하므로 3.6363…·2.6363…이 부동소수 오차로 늘 한쪽에 기울지 않는다
    _write_levelled_catalog(tmp_path, _levels({"easy": 40, "normal": 41, "hard": 29}))
    catalog = QuestionCatalog.from_directory(tmp_path)

    splits = set()
    for seed in range(60):
        counts = _difficulty_of(
            catalog,
            catalog.select_round(
                category_id="art",
                random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
            ),
        )
        assert counts["normal"] == 4
        assert counts["easy"] + counts["hard"] == 6
        splits.add((counts["easy"], counts["hard"]))
    assert splits == {(4, 2), (3, 3)}


def test_unseen_questions_still_come_before_difficulty_balance(tmp_path: Path) -> None:
    # 안 본 열 문제(010~019)가 모두 보통이다. 난이도를 맞추려고 본 쉬움·어려움을 꺼내지 않는다
    _write_levelled_catalog(tmp_path, _levels({"easy": 5, "hard": 5, "normal": 10}))
    catalog = QuestionCatalog.from_directory(tmp_path)
    recent = {f"online-history-{number:03d}": 1.0 for number in range(10)}

    for seed in range(20):
        selected = catalog.select_round(
            category_id="history",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
            recent_use=recent,
        )
        assert _ids(selected) == {f"online-history-{number:03d}" for number in range(10, 20)}


def test_a_short_difficulty_is_filled_from_other_unseen_questions(tmp_path: Path) -> None:
    # 8/8/4 → 몫 4·4·2. 안 본 어려운 문제는 하나(019)뿐이다.
    # 본 어려운 문제 대신 안 본 쉬움·보통이 채운다
    _write_levelled_catalog(tmp_path, _levels({"easy": 8, "normal": 8, "hard": 4}))
    catalog = QuestionCatalog.from_directory(tmp_path)
    seen_hard = {f"online-history-{number:03d}": 5.0 for number in (16, 17, 18)}

    for seed in range(20):
        selected = catalog.select_round(
            category_id="history",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
            recent_use=seen_hard,
        )
        counts = _difficulty_of(catalog, selected)
        assert len(selected) == 10
        assert _ids(selected).isdisjoint(seen_hard)
        assert counts["hard"] == 1
        assert counts["easy"] >= 4
        assert counts["normal"] >= 4
        assert counts["easy"] + counts["normal"] == 9


def test_seen_questions_of_one_match_are_balanced_but_older_matches_come_first(
    tmp_path: Path,
) -> None:
    # 열두 문제를 다 봤다. 000~005(쉬움 셋·보통 둘·어려움 하나)는 오래전 판, 006~011은 지난 판이다.
    # 오래전 판의 여섯이 먼저 다 나오고, 지난 판에서는 모자란 난이도부터 넷을 채운다 — 같은 판에서
    # 나온 문제끼리는 순서가 없으니(시각이 같다) 그 안에서 난이도를 맞춰도
    # «오래된 것부터»를 어기지 않는다
    levels: list[object] = ["easy", "easy", "easy", "normal", "normal", "hard"]
    levels += ["easy", "normal", "normal", "hard", "hard", "easy"]
    _write_levelled_catalog(tmp_path, levels)
    catalog = QuestionCatalog.from_directory(tmp_path)
    recent = {
        f"online-geography-{number:03d}": (1.0 if number < 6 else 2.0) for number in range(12)
    }

    for seed in range(20):
        selected = catalog.select_round(
            category_id="geography",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
            recent_use=recent,
        )
        assert len(selected) == 10
        assert {f"online-geography-{number:03d}" for number in range(6)} <= _ids(selected)
        # 은행 4/4/4 → 몫 3·3·3 + 하나. 오래된 여섯이 쉬움 셋·보통 둘·어려움 하나를 채웠으니
        # 지난 판에서는 보통 하나·어려움 둘부터 고른다 — 쉬움은 남은 한 자리를 얻었을 때만이다
        counts = _difficulty_of(catalog, selected)
        assert counts["normal"] >= 3, counts
        assert counts["hard"] >= 3, counts


def test_missing_or_unknown_difficulty_shares_one_bucket_like_before(tmp_path: Path) -> None:
    # 비공개 은행에 난이도가 없을 수 있다. 거절하지 않고, 셋 밖의 값은 모두 «모름» 한 칸이다
    _write_levelled_catalog(tmp_path, [..., None, "expert", 3, "", ..., "EASY", None, ..., ...])
    catalog = QuestionCatalog.from_directory(tmp_path)
    assert {catalog.get(f"online-art-{number:03d}").difficulty for number in range(10)} == {None}

    for seed in range(10):
        selected = catalog.select_round(
            category_id="art",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        assert len(selected) == 10
        assert _difficulty_of(catalog, selected) == {"unknown": 10}

    # 일부만 모르면 그 칸도 제 비율의 몫을 받는다
    mixed = tmp_path / "mixed"
    _write_levelled_catalog(mixed, ["easy"] * 10 + [...] * 10)
    mixed_catalog = QuestionCatalog.from_directory(mixed)
    for seed in range(10):
        selected = mixed_catalog.select_round(
            category_id="art",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        assert _difficulty_of(mixed_catalog, selected) == {"easy": 5, "unknown": 5}


# 전체 판은 분야마다 다섯 문제를 지키고 **판 전체**가 비율을 따른다. 분야마다 따로 나누던
# 때는 지금 은행에서 다섯 분야 모두 어려움이 늘 하나로 내림돼(5 × 29/110 = 1.32, 나머지가
# 가장 작다) 25문제에 어려움이 늘 다섯이었다.


def _assert_each_category_within_its_share(
    catalog: QuestionCatalog, selected: tuple[object, ...], count: int = 5
) -> None:
    """분야마다 문항 수를 지키고, 칸마다 제 은행의 정확한 몫의 내림이나 올림이다.

    정확한 몫은 문항 수 × 칸의 문제 수 ÷ 은행 크기다.
    """
    for category, bank in catalog.by_category.items():
        take = min(count, len(bank))
        mine = tuple(
            question
            for question in selected
            if question.category == category  # type: ignore[attr-defined]
        )
        assert len(mine) == take, category
        counts = _difficulty_of(catalog, mine)
        sizes: dict[str, int] = {}
        for question in bank:
            level = question.difficulty or "unknown"
            sizes[level] = sizes.get(level, 0) + 1
        for level, size in sizes.items():
            share = Fraction(take * size, len(bank))
            assert counts.get(level, 0) in (math.floor(share), math.ceil(share)), (
                category,
                level,
                counts,
            )


def _write_catalog_per_category(root: Path, levels_by_category: dict[str, list[object]]) -> None:
    root.mkdir(exist_ok=True)
    for category, levels in levels_by_category.items():
        items = []
        for number, level in enumerate(levels):
            item = _question(category, number)
            if level is ...:
                del item["difficulty"]
            else:
                item["difficulty"] = level
            items.append(item)
        (root / f"{category}.json").write_text(json.dumps(items), encoding="utf-8")


def test_all_round_follows_the_bank_share_across_the_whole_round(tmp_path: Path) -> None:
    # 40/41/29 다섯 은행: 25 × 200/205/145 ÷ 550 = 9.09 · 9.32 · 6.59 → 9·9·6 + 어려움 → 9·9·7
    _write_levelled_catalog(tmp_path, _levels({"easy": 40, "normal": 41, "hard": 29}))
    catalog = QuestionCatalog.from_directory(tmp_path)

    hard_counts: dict[str, set[int]] = {category: set() for category in CATEGORIES}
    for seed in range(40):
        selected = catalog.select_round(
            category_id=None,
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        assert len(selected) == 25
        assert len({question.id for question in selected}) == 25
        assert _difficulty_of(catalog, selected) == {"easy": 9, "normal": 9, "hard": 7}
        _assert_each_category_within_its_share(catalog, selected)
        for category in CATEGORIES:
            mine = tuple(question for question in selected if question.category == category)
            hard_counts[category].add(_difficulty_of(catalog, mine).get("hard", 0))
    # 어려움 둘을 받는 분야가 판마다 바뀐다
    assert all(seen == {1, 2} for seen in hard_counts.values()), hard_counts


def test_all_round_on_the_current_bank_shape_has_six_or_seven_hard(tmp_path: Path) -> None:
    # 지금 공개 은행의 모양: 한국사·과학 40/42/28, 나머지 40/41/29
    # → 판의 목표 9.09 · 9.41 · 6.5 → 9·9·7
    shapes = {
        "history": {"easy": 40, "normal": 42, "hard": 28},
        "science": {"easy": 40, "normal": 42, "hard": 28},
        "geography": {"easy": 40, "normal": 41, "hard": 29},
        "general": {"easy": 40, "normal": 41, "hard": 29},
        "art": {"easy": 40, "normal": 41, "hard": 29},
    }
    _write_catalog_per_category(
        tmp_path, {category: _levels(shape) for category, shape in shapes.items()}
    )
    catalog = QuestionCatalog.from_directory(tmp_path)

    for seed in range(100):
        selected = catalog.select_round(
            category_id=None,
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        counts = _difficulty_of(catalog, selected)
        assert 6 <= counts["hard"] <= 7, counts
        assert counts == {"easy": 9, "normal": 9, "hard": 7}
        _assert_each_category_within_its_share(catalog, selected)


def test_all_round_target_is_the_sum_of_category_shares_not_the_pooled_bank(
    tmp_path: Path,
) -> None:
    # 합친 은행의 비율(어려움 10/110)로 나누면 어려움은 둘 남짓이어야 하지만, 한국사 다섯은
    # 모두 어려움이다. 분야마다의 정확한 몫(한국사 어려움 5, 나머지 분야 쉬움 5씩)의 합이
    # 판의 목표다
    _write_catalog_per_category(
        tmp_path,
        {
            category: (["hard"] * 10 if category == "history" else ["easy"] * 25)
            for category in CATEGORIES
        },
    )
    catalog = QuestionCatalog.from_directory(tmp_path)
    for seed in range(10):
        selected = catalog.select_round(
            category_id=None,
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        assert _difficulty_of(catalog, selected) == {"easy": 20, "hard": 5}
        _assert_each_category_within_its_share(catalog, selected)


def test_all_round_moves_a_blocked_rounding_to_another_category() -> None:
    # 분야마다 한 문제. 한국사는 쉬움 3·보통 2, 과학은 쉬움 3·어려움 2 → 판의 목표 쉬움 1.2 ·
    # 보통 0.4 · 어려움 0.4 → 쉬움 하나에 보통이나 어려움 하나. 나머지가 가장 큰 쉬움부터 고르면
    # 먼저 고른 분야가 쉬움을 가져가 남은 분야가 판의 몫과 어긋날 수 있다 — 증가 경로가 그
    # 올림을 다른 분야로 옮긴다
    def make(category: str, levels: list[str]) -> list[_CatalogQuestion]:
        return [
            _CatalogQuestion(
                id=f"online-{category}-{number:03d}",
                category=category,
                question="?",
                choices=("a", "b", "c", "d"),
                answer_index=0,
                explanation="",
                difficulty=level,
            )
            for number, level in enumerate(levels)
        ]

    banks = [
        make("history", ["easy"] * 3 + ["normal"] * 2),
        make("science", ["easy"] * 3 + ["hard"] * 2),
    ]
    outcomes = set()
    for seed in range(60):
        quotas = _all_round_quotas(
            banks,
            1,
            random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        assert [sum(row.values()) for row in quotas] == [1, 1]
        totals = {level: sum(row.get(level, 0) for row in quotas) for level in DIFFICULTIES}
        assert totals["easy"] == 1, totals
        assert totals["normal"] + totals["hard"] == 1
        outcomes.add("normal" if totals["normal"] else "hard")
    assert outcomes == {"normal", "hard"}


def test_all_round_with_unknown_difficulty_keeps_five_per_category(tmp_path: Path) -> None:
    _write_levelled_catalog(tmp_path, [...] * 12)
    catalog = QuestionCatalog.from_directory(tmp_path)
    for seed in range(10):
        selected = catalog.select_round(
            category_id=None,
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        assert _difficulty_of(catalog, selected) == {"unknown": 25}
        _assert_each_category_within_its_share(catalog, selected)


def test_selected_round_order_is_shuffled_across_difficulties(tmp_path: Path) -> None:
    _write_levelled_catalog(tmp_path, _levels({"easy": 40, "normal": 42, "hard": 28}))
    catalog = QuestionCatalog.from_directory(tmp_path)

    first_levels = set()
    last_levels = set()
    for seed in range(40):
        selected = catalog.select_round(
            category_id="general",
            random_source=random.Random(seed),  # noqa: S311 - deterministic fixture only
        )
        first_levels.add(catalog.get(selected[0].id).difficulty)
        last_levels.add(catalog.get(selected[-1].id).difficulty)
    assert first_levels == {"easy", "normal", "hard"}
    assert last_levels == {"easy", "normal", "hard"}
