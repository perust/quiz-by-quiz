"""닉네임 금칙 규칙 (PRD 12.1, FR-7.13 2단계).

온라인 랭킹은 모두에게 보이므로 서버가 받는 닉네임에서 욕설과 개인 정보 모양(전화번호처럼 긴 숫자,
이메일, 주소창 주소)을 막는다. 같은 이름은 그대로 허용한다(방 안에서만 뒤에 숫자를 붙인다).

규칙의 값은 `nickname_rules.json` 한 곳에 있고, 화면은 `src/online/nickname-rules.ts`에 같은 값과
같은 판정을 둔다 — 홈의 닉네임 대화상자가 보내기 전에 같은 말로 설명한다. 두 곳을 함께 고친다
(`tests/nickname-rules.test.mjs`가 값과 사례 판정을 견준다).

판정은 일부러 단순하다. 정규화(전각 → 반각, 소문자) 뒤에
- 숫자가 `maxDigitRun`개를 넘어 이어지면(사이의 공백·하이픈·점·밑줄은 무시) 전화번호 모양,
- `글자@글자`면 이메일 모양,
- `://`·`www.`나 `무엇.<주소 끝>`(com, kr …)이면 주소창 주소 모양,
- 글자만 남긴 꼴(숫자·기호·공백을 지운다)에 금칙어가 들어 있으면 욕설이다.
목록은 짧고 보수적으로 둔다. 걸러지는 말을 늘릴 때는 같은 말을 쓰는 흔한 낱말이 걸리지 않는지 본다.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Literal

NicknameProblem = Literal["profanity", "digits", "email", "url"]

# 랭킹 기록에 남길 닉네임이 지금 규칙에 걸리면(규칙이 생기기 전에 지은 이름) 대신 남기는 이름.
ANONYMOUS_NICKNAME = "익명"

_RULES_PATH = Path(__file__).with_name("nickname_rules.json")
# 사이에 끼어도 «이어진 숫자»로 보는 구분 기호. 화면(nickname-rules.ts)과 같은 글자다.
_DIGIT_SEPARATORS = r"[ .\-_]"
_EMAIL = re.compile(r"[0-9a-z._%+\-]@[0-9a-z]")
_URL_MARKERS = re.compile(r"://|www\.")
# 금칙어는 글자만 남긴 꼴에서 찾는다 — «시1발»·«시 발»도 같은 말이다.
_NOT_LETTER = re.compile(r"[^a-z가-힣ㄱ-ㅎㅏ-ㅣ]")
_FULL_WIDTH = {code: code - 0xFEE0 for code in range(0xFF01, 0xFF5F)} | {0x3000: 0x20}


@dataclass(frozen=True)
class NicknameRules:
    max_digit_run: int
    url_suffixes: tuple[str, ...]
    blocked_words: tuple[str, ...]

    @classmethod
    def from_file(cls, path: Path = _RULES_PATH) -> NicknameRules:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("nickname rules must be an object")
        max_digit_run = raw.get("maxDigitRun")
        suffixes = raw.get("urlSuffixes")
        words = raw.get("blockedWords")
        if type(max_digit_run) is not int or max_digit_run < 1:
            raise ValueError("maxDigitRun must be a positive integer")
        if not _strings(suffixes) or not _strings(words):
            raise ValueError("urlSuffixes and blockedWords must be non-empty string lists")
        for suffix in suffixes:
            if not re.fullmatch(r"[a-z]{2,10}", suffix):
                raise ValueError("url suffixes are lowercase ascii letters")
        for word in words:
            if word != compact(word) or not word:
                raise ValueError("blocked words must already be in compact form")
        return cls(
            max_digit_run=max_digit_run,
            url_suffixes=tuple(suffixes),
            blocked_words=tuple(words),
        )


def _strings(value: object) -> bool:
    return isinstance(value, list) and bool(value) and all(
        isinstance(item, str) for item in value
    )


def normalize(value: str) -> str:
    """전각 영숫자·기호(０１＠．)와 대문자를 한 꼴로 모은다. 화면도 같은 순서다.

    NFKC는 쓰지 않는다 — 한글 호환 자모(ㅅ·ㅂ)까지 첫가끝 자모로 풀어 «ㅅㅂ»을 놓친다. 그래서 NFC로
    풀린 음절만 다시 모으고, 전각 ASCII(U+FF01–U+FF5E)와 전각 공백만 반각으로 옮긴 뒤 소문자로 둔다.
    """
    composed = unicodedata.normalize("NFC", value)
    return composed.translate(_FULL_WIDTH).lower()


def compact(value: str) -> str:
    """정규화한 뒤 영문 소문자와 한글만 남긴다."""
    return _NOT_LETTER.sub("", normalize(value))


@cache
def default_rules() -> NicknameRules:
    return NicknameRules.from_file()


@cache
def _patterns(rules: NicknameRules) -> tuple[re.Pattern[str], re.Pattern[str]]:
    digits = re.compile(rf"[0-9](?:{_DIGIT_SEPARATORS}*[0-9]){{{rules.max_digit_run},}}")
    suffixes = "|".join(re.escape(suffix) for suffix in rules.url_suffixes)
    url = re.compile(rf"[^ .]\.(?:{suffixes})(?![0-9a-z])")
    return digits, url


def nickname_problem(value: str, rules: NicknameRules | None = None) -> NicknameProblem | None:
    """닉네임이 걸리는 까닭. 괜찮으면 None이다. 길이는 여기서 보지 않는다(domain이 본다)."""
    active = rules or default_rules()
    normalized = normalize(value)
    digits, url = _patterns(active)
    if digits.search(normalized):
        return "digits"
    if _EMAIL.search(normalized):
        return "email"
    if _URL_MARKERS.search(normalized) or url.search(normalized):
        return "url"
    letters = compact(value)
    if any(word in letters for word in active.blocked_words):
        return "profanity"
    return None


def ranking_nickname(value: str) -> str:
    """랭킹 기록에 남길 이름. 지금 규칙에 걸리는 옛 이름은 익명으로 남긴다."""
    return ANONYMOUS_NICKNAME if nickname_problem(value) is not None else value
