"""닉네임 금칙 규칙 (PRD 12.1, FR-7.13 2단계).

온라인 랭킹은 모두에게 보이므로 서버가 받는 닉네임에서 욕설과 개인 정보 모양(전화번호처럼 긴 숫자,
이메일, 주소창 주소)을 막는다. 같은 이름은 그대로 허용한다(방 안에서만 뒤에 숫자를 붙인다).

규칙의 값은 `nickname_rules.json` 한 곳에 있고, 화면은 `src/online/nickname-rules.ts`에 같은 값과
같은 판정을 둔다 — 홈의 닉네임 대화상자가 보내기 전에 같은 말로 설명한다. 두 곳을 함께 고친다
(`tests/nickname-rules.test.mjs`가 값과 사례 판정을 견준다).

판정은 일부러 단순하다. 정규화(전각 → 반각, 소문자) 뒤에
- 숫자가 `maxDigitRun`개를 넘어 이어지면 전화번호 모양이다. 사이에 영문·한글 음절이
  아닌 것(공백·하이픈·점·빗금·물결·쉼표·대시, 모음 «ㅡ»로 쓴 줄표 같은 자모)이 끼어도
  이어진 것으로 본다,
- `글자@글자`면 이메일 모양,
- `://`·`www.`나 `무엇.<주소 끝>`(com, kr …)이면 주소창 주소 모양,
- 욕설은 두 목록이다. `blockedWords`는 글자만 남긴 꼴(숫자·기호·공백을 지운다)의
  **어디에** 들어 있어도 걸린다. `blockedTokens`는 흔한 이름·낱말 안에도 들어 있는 말이라
  **따로 선 말**일 때만 걸린다 — 앞뒤가 같은 글자(영문이면 영문, 한글이면 한글 음절)로
  이어지지 않을 때다. 숫자·기호를 지운 꼴(«s.h.i.t맨» → «shit맨»)과 공백으로 바꾼 꼴
  («my-shit» → «my shit»)을 둘 다 보고(공백은 남긴다), 글자만 남긴 이름 전체가 그 말이어도
  («s h i t») 걸린다. «Shitae»·«Ashita»·«생존나라»는 통과하고 «shit»·«존나 짱»은 걸린다.
목록은 짧고 보수적으로 둔다. 걸러지는 말을 늘릴 때는 같은 말을 쓰는 흔한 낱말·이름이
걸리지 않는지 보고, 걸리면 `blockedTokens`에 넣는다. 사례 표
(`server/tests/fixtures/nickname_cases.json`)에 통과해야 할 이름을 함께 더한다.
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
# 숫자 사이에 끼어도 «이어진 숫자»로 보는 글자: 숫자·영문·한글 음절이 아닌 모든 것. 화면
# (nickname-rules.ts)과 같은 글자다. 몇 가지 기호만 세면 «1234/5678»·«1234ㅡ5678»이 빠졌다.
_DIGIT_JOINER = r"[^0-9a-z가-힣]"
_EMAIL = re.compile(r"[0-9a-z._%+\-]@[0-9a-z]")
_URL_MARKERS = re.compile(r"://|www\.")
# 금칙어는 글자만 남긴 꼴에서 찾는다 — «시1발»·«시 발»도 같은 말이다.
_NOT_LETTER = re.compile(r"[^a-z가-힣ㄱ-ㅎㅏ-ㅣ]")
# 따로 선 말(blockedTokens)은 공백을 남긴 꼴에서 찾는다 — 낱말의 경계가 보여야 한다.
_NOT_LETTER_OR_SPACE = re.compile(r"[^a-z가-힣ㄱ-ㅎㅏ-ㅣ ]")
_LATIN_WORD = re.compile(r"[a-z]+")
_HANGUL_WORD = re.compile(r"[가-힣]+")
_FULL_WIDTH = {code: code - 0xFEE0 for code in range(0xFF01, 0xFF5F)} | {0x3000: 0x20}


@dataclass(frozen=True)
class NicknameRules:
    max_digit_run: int
    url_suffixes: tuple[str, ...]
    blocked_words: tuple[str, ...]
    blocked_tokens: tuple[str, ...]

    @classmethod
    def from_file(cls, path: Path = _RULES_PATH) -> NicknameRules:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("nickname rules must be an object")
        max_digit_run = raw.get("maxDigitRun")
        suffixes = raw.get("urlSuffixes")
        words = raw.get("blockedWords")
        tokens = raw.get("blockedTokens")
        if type(max_digit_run) is not int or max_digit_run < 1:
            raise ValueError("maxDigitRun must be a positive integer")
        if not _strings(suffixes) or not _strings(words) or not _strings(tokens):
            raise ValueError(
                "urlSuffixes, blockedWords and blockedTokens must be non-empty string lists"
            )
        for suffix in suffixes:
            if not re.fullmatch(r"[a-z]{2,10}", suffix):
                raise ValueError("url suffixes are lowercase ascii letters")
        for word in words:
            if word != compact(word) or not word:
                raise ValueError("blocked words must already be in compact form")
        for token in tokens:
            # 경계를 그 말의 글자로 정하므로 한 가지 글자로만 된 말이어야 한다
            if not (_LATIN_WORD.fullmatch(token) or _HANGUL_WORD.fullmatch(token)):
                raise ValueError("blocked tokens are lowercase latin or hangul syllables only")
        if set(words) & set(tokens):
            raise ValueError("a word is either a blocked word or a blocked token")
        return cls(
            max_digit_run=max_digit_run,
            url_suffixes=tuple(suffixes),
            blocked_words=tuple(words),
            blocked_tokens=tuple(tokens),
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


def token_views(value: str) -> tuple[str, str]:
    """따로 선 말을 찾는 두 꼴: 정규화한 뒤 숫자·기호를 지운 꼴과 공백으로 바꾼 꼴."""
    normalized = normalize(value)
    return _NOT_LETTER_OR_SPACE.sub("", normalized), _NOT_LETTER_OR_SPACE.sub(" ", normalized)


@cache
def default_rules() -> NicknameRules:
    return NicknameRules.from_file()


def _token_pattern(token: str) -> str:
    # 뒤돌아보기(lookbehind)는 쓰지 않는다 — 화면이 같은 식을 쓰는데 오래된 Safari가 못 읽는다
    letter = "a-z" if _LATIN_WORD.fullmatch(token) else "가-힣"
    return rf"(?:^|[^{letter}]){re.escape(token)}(?![{letter}])"


@cache
def _patterns(
    rules: NicknameRules,
) -> tuple[re.Pattern[str], re.Pattern[str], re.Pattern[str]]:
    digits = re.compile(rf"[0-9](?:{_DIGIT_JOINER}*[0-9]){{{rules.max_digit_run},}}")
    suffixes = "|".join(re.escape(suffix) for suffix in rules.url_suffixes)
    url = re.compile(rf"[^ .]\.(?:{suffixes})(?![0-9a-z])")
    tokens = re.compile("|".join(_token_pattern(token) for token in rules.blocked_tokens))
    return digits, url, tokens


def nickname_problem(value: str, rules: NicknameRules | None = None) -> NicknameProblem | None:
    """닉네임이 걸리는 까닭. 괜찮으면 None이다. 길이는 여기서 보지 않는다(domain이 본다)."""
    active = rules or default_rules()
    normalized = normalize(value)
    digits, url, tokens = _patterns(active)
    if digits.search(normalized):
        return "digits"
    if _EMAIL.search(normalized):
        return "email"
    if _URL_MARKERS.search(normalized) or url.search(normalized):
        return "url"
    letters = compact(value)
    if any(word in letters for word in active.blocked_words):
        return "profanity"
    if letters in active.blocked_tokens or any(tokens.search(view) for view in token_views(value)):
        return "profanity"
    return None


def ranking_nickname(value: str) -> str:
    """랭킹 기록에 남길 이름. 지금 규칙에 걸리는 옛 이름은 익명으로 남긴다."""
    return ANONYMOUS_NICKNAME if nickname_problem(value) is not None else value
