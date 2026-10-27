"""닉네임 금칙 규칙 (PRD 12.1).

화면(src/online/nickname-rules.ts)과 같은 사례 표로 판정을 견준다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_api import HEADERS, FakeRepository, make_client

from app.domain import (
    NICKNAME_PERSONAL_INFO_CODE,
    NICKNAME_PROFANITY_CODE,
    DomainError,
    validate_player,
)
from app.nickname_filter import (
    ANONYMOUS_NICKNAME,
    NicknameRules,
    compact,
    default_rules,
    nickname_problem,
    normalize,
    ranking_nickname,
)

CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "nickname_cases.json").read_text(encoding="utf-8")
)["cases"]
RULES_FILE = Path(__file__).parents[1] / "app" / "nickname_rules.json"


@pytest.mark.parametrize("case", CASES, ids=[case["nickname"] for case in CASES])
def test_shared_cases_get_the_same_verdict_as_the_browser(case: dict[str, object]) -> None:
    assert nickname_problem(str(case["nickname"])) == case["problem"]


def test_rules_live_in_one_short_data_file() -> None:
    raw = json.loads(RULES_FILE.read_text(encoding="utf-8"))
    rules = default_rules()

    assert rules == NicknameRules.from_file(RULES_FILE)
    assert rules.max_digit_run == raw["maxDigitRun"] == 5
    assert list(rules.blocked_words) == raw["blockedWords"]
    assert list(rules.url_suffixes) == raw["urlSuffixes"]
    # 짧고 보수적으로 둔다. 늘릴 때는 흔한 낱말이 걸리지 않는지 사례 표에 함께 더한다
    assert len(rules.blocked_words) <= 60
    assert len(set(rules.blocked_words)) == len(rules.blocked_words)
    assert all(word == compact(word) for word in rules.blocked_words)


def test_normalize_folds_full_width_and_case_but_keeps_hangul_jamo() -> None:
    assert normalize("ＡＢＣ１２３＠．") == "abc123@."
    # NFKC였다면 호환 자모 ㅅ·ㅂ이 첫가끝 자모로 풀려 금칙어를 놓쳤다
    assert normalize("ㅅㅂ") == "ㅅㅂ"
    assert compact("시 1 발!") == "시발"
    # 풀어 쓴 한글(첫가끝)도 음절로 모은다
    assert normalize("가") == "가"


def test_session_rejects_blocked_nicknames_with_codes_the_screen_maps() -> None:
    assert validate_player("퀴즈왕", None).nickname == "퀴즈왕"
    with pytest.raises(DomainError) as profanity:
        validate_player("ㅅㅂ", None)
    assert profanity.value.code == NICKNAME_PROFANITY_CODE == "nickname-profanity"
    for nickname in ("01012345678", "kim@mail", "quiz.com"):
        with pytest.raises(DomainError) as personal:
            validate_player(nickname, None)
        assert personal.value.code == NICKNAME_PERSONAL_INFO_CODE == "nickname-personal-info"
    # 같은 이름은 막지 않는다 — 방 안에서만 뒤에 숫자를 붙인다
    assert validate_player("같은이름", None).nickname == validate_player("같은이름", None).nickname


def test_the_checked_nickname_is_the_one_that_is_stored() -> None:
    # 10자에서 자른 뒤의 이름을 본다. 자르기 전에만 보면 잘린 꼬리가 숫자를 이어 붙일 수 있다
    assert validate_player("가나다라마바12345", None).nickname == "가나다라마바1234"
    with pytest.raises(DomainError):
        validate_player("가나다라123456789", None)


def test_ranking_keeps_good_names_and_hides_old_ones_that_now_fail() -> None:
    assert ranking_nickname("퀴즈왕1") == "퀴즈왕1"
    assert ranking_nickname("kim@mail.kr") == ANONYMOUS_NICKNAME
    assert ranking_nickname("ㅅㅂ") == ANONYMOUS_NICKNAME
    assert nickname_problem(ANONYMOUS_NICKNAME) is None


def test_put_session_answers_400_with_the_mapped_code_and_stores_nothing() -> None:
    repository = FakeRepository()
    client: TestClient
    with make_client(repository) as client:
        profanity = client.put(
            "/v1/session",
            headers=HEADERS,
            json={"nickname": "시발", "characterId": "slime-blue"},
        )
        personal = client.put(
            "/v1/session",
            headers=HEADERS,
            json={"nickname": "010 1234 5678", "characterId": "slime-blue"},
        )
        accepted = client.put(
            "/v1/session",
            headers=HEADERS,
            json={"nickname": "퀴즈왕", "characterId": "slime-blue"},
        )

    assert profanity.status_code == 400
    assert profanity.json()["detail"]["code"] == "nickname-profanity"
    assert personal.status_code == 400
    assert personal.json()["detail"]["code"] == "nickname-personal-info"
    # 해요체 한 문장으로 이유를 말한다. 받은 이름을 되풀이하지 않는다
    for response in (profanity, personal):
        message = response.json()["detail"]["message"]
        assert message.endswith("바꿔 주세요.")
        assert "시발" not in message and "1234" not in message
    assert accepted.status_code == 200
    assert repository.session_player is not None
    assert repository.session_player.nickname == "퀴즈왕"


def test_rules_file_refuses_shapes_the_filter_could_not_use(tmp_path: Path) -> None:
    good = json.loads(RULES_FILE.read_text(encoding="utf-8"))
    for broken in (
        {**good, "maxDigitRun": 0},
        {**good, "urlSuffixes": ["Com"]},
        {**good, "blockedWords": ["시 발"]},
        {**good, "blockedWords": []},
    ):
        path = tmp_path / "rules.json"
        path.write_text(json.dumps(broken), encoding="utf-8")
        with pytest.raises(ValueError):
            NicknameRules.from_file(path)
