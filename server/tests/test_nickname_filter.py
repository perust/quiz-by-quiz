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
    token_views,
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
    assert list(rules.blocked_tokens) == raw["blockedTokens"]
    assert list(rules.url_suffixes) == raw["urlSuffixes"]
    # 짧고 보수적으로 둔다. 늘릴 때는 흔한 낱말이 걸리지 않는지 사례 표에 함께 더한다
    assert len(rules.blocked_words) + len(rules.blocked_tokens) <= 60
    assert len(set(rules.blocked_words)) == len(rules.blocked_words)
    assert len(set(rules.blocked_tokens)) == len(rules.blocked_tokens)
    assert not set(rules.blocked_words) & set(rules.blocked_tokens)
    assert all(word == compact(word) for word in rules.blocked_words)
    assert all(token == compact(token) for token in rules.blocked_tokens)


def test_words_found_inside_common_names_only_count_as_standalone_words() -> None:
    # «shit»·«porn»·«존나»는 흔한 이름·낱말 안에도 있다(일본어 ashita, 태국 이름 Pornchai,
    # 생존+나라). 그래서 어디에 있어도 걸리는 목록이 아니라 따로 선 말일 때만 걸리는 목록이다
    rules = default_rules()
    assert {"shit", "porn", "존나"} <= set(rules.blocked_tokens)
    assert not {"shit", "porn", "존나"} & set(rules.blocked_words)
    for name in ("Shitae", "Ashita", "Yoshitaka", "Pornchai", "생존나라", "보존나무"):
        assert nickname_problem(name) is None, name
    # 따로 섰거나 기호·숫자로 갈라 쓴 것, 이름 전체가 그 말이면 걸린다
    for name in ("shit", "Shit맨", "s.h.i.t", "shit123", "s h i t", "my-shit", "존나 짱"):
        assert nickname_problem(name) == "profanity", name
    # 숫자·기호를 지운 꼴과 공백으로 바꾼 꼴. 공백은 둘 다 남는다
    assert token_views("My-S.h.i.t 1") == ("myshit ", "my s h i t  ")


def test_digit_groups_split_by_any_non_letter_are_one_run() -> None:
    # 빗금·물결·쉼표·대시·모음 «ㅡ»로 쓴 줄표도 이어진 숫자다 — 전화번호를 이렇게 적어도 걸린다
    for name in ("1234/5678", "1234ㅡ5678", "1234—5678", "1234–5678", "1234~5678", "1234,5678"):
        assert nickname_problem(name) == "digits", name
    # 10자에서 자르고 남는 «010ㅡ1234ㅡ5»도 걸린다
    with pytest.raises(DomainError):
        validate_player("010ㅡ1234ㅡ5678", None)
    # 글자(영문·한글 음절)가 끼면 이어진 것이 아니다
    for name in ("1등2등3등4등", "a1b2c3d4e5f6", "퀴즈왕12345"):
        assert nickname_problem(name) is None, name


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
        # 거절한 이름은 한 글자도 저장하지 않는다 — 받아 준 PUT이 덮기 전에 본다
        assert repository.session_player is None
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
        {**good, "blockedTokens": []},
        {**good, "blockedTokens": ["sh it"]},
        # 경계를 그 말의 글자로 정하므로 영문과 한글을 섞지 않는다
        {**good, "blockedTokens": ["shit맨"]},
        {**good, "blockedTokens": ["ㅅㅂ"]},
        {key: value for key, value in good.items() if key != "blockedTokens"},
        {**good, "blockedTokens": [*good["blockedTokens"], good["blockedWords"][0]]},
    ):
        path = tmp_path / "rules.json"
        path.write_text(json.dumps(broken), encoding="utf-8")
        with pytest.raises(ValueError):
            NicknameRules.from_file(path)
