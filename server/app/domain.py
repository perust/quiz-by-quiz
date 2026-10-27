from __future__ import annotations

import re
from dataclasses import dataclass

from .nickname_filter import nickname_problem

ALLOWED_CAPACITIES = frozenset({2, 4, 6, 8, 10, 12})
ALLOWED_CATEGORIES = frozenset({"history", "science", "geography", "general", "art"})
# 방장이 방마다 고르는 온라인 문항 시간(ms). 제한 없음은 없다 — 한 사람이 답하지 않으면
# 방 전체가 마감까지 멈춘다. migration 011의 CHECK와 같은 목록이다.
DEFAULT_QUESTION_TIME_MS = 20_000
ALLOWED_QUESTION_TIMES_MS = frozenset({DEFAULT_QUESTION_TIME_MS, 40_000})
# 판을 여는 데 필요한 세는 사람(방장 + 연결된 참가자)의 수. 방장 혼자서도 연다 — 혼자 하고 싶은
# 사람도 온라인 방을 만들어 푼다(소유자 방향: 언젠가 혼자 하기를 온라인 방 하나로 모은다). 방·세션
# 응답이 `minPlayers`로 싣는다. 이 값을 모르는 이전 API는 둘이었다(화면은 없으면 2로 읽는다).
MIN_MATCH_PLAYERS = 1
# 혼자 푸는 온라인 판의 방 (FR-7.13 3단계, migration 013의 solo_rooms). 홈의 분야 칸이 곧바로 연다 —
# 로비 목록에 남에게 보이지 않고 남이 들어오지 못한다. 방 표의 정원 CHECK(2명부터)를 지키려고 가장
# 작은 정원을 쓴다. 이름은 그 사람에게만 보인다(홈의 «풀던 혼자 판» 줄은 이름 대신 제 말을 쓴다).
SOLO_ROOM_NAME = "혼자 하기"
SOLO_ROOM_CAPACITY = 2
ROOM_NAME_MAX_UNITS = 16
ROOM_PASSWORD_MIN_UNITS = 4
ROOM_PASSWORD_MAX_UNITS = 12
NICKNAME_MAX_UNITS = 10
CHAT_MAX_UNITS = 60
DEFAULT_CHARACTER_ID = "slime-blue"
_CODE_LENGTH = 6
_CHARACTER_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


class DomainError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ValidatedRoom:
    name: str
    category_id: str | None
    capacity: int
    is_public: bool
    password: str | None
    game_mode: bool
    question_time_ms: int = DEFAULT_QUESTION_TIME_MS


@dataclass(frozen=True)
class ValidatedPlayer:
    nickname: str
    character_id: str


def _utf16_units(value: str) -> int:
    """Match JavaScript string-length limits used by the static frontend."""
    return len(value.encode("utf-16-le")) // 2


def _truncate_utf16(value: str, limit: int) -> str:
    kept: list[str] = []
    units = 0
    for character in value:
        width = _utf16_units(character)
        if units + width > limit:
            break
        kept.append(character)
        units += width
    return "".join(kept)


def validate_room(
    *,
    name: str,
    category_id: str | None,
    capacity: int,
    is_public: bool,
    password: str | None,
    game_mode: bool = True,
    question_time_ms: int = DEFAULT_QUESTION_TIME_MS,
) -> ValidatedRoom:
    normalized_name = str(name or "").strip()
    if not normalized_name or _utf16_units(normalized_name) > ROOM_NAME_MAX_UNITS:
        raise DomainError("invalid-name", "방 이름은 1자 이상 16자 이하여야 해요.")

    if category_id is not None and category_id not in ALLOWED_CATEGORIES:
        raise DomainError("invalid-category", "지원하지 않는 게임 형식이에요.")

    if type(capacity) is not int or capacity not in ALLOWED_CAPACITIES:
        raise DomainError("invalid-capacity", "인원은 2, 4, 6, 8, 10, 12명 중에서 골라야 해요.")

    public = bool(is_public)
    normalized_password: str | None = None
    if not public:
        normalized_password = str(password or "")
        password_units = _utf16_units(normalized_password)
        if not ROOM_PASSWORD_MIN_UNITS <= password_units <= ROOM_PASSWORD_MAX_UNITS:
            raise DomainError("invalid-password", "비밀번호는 4자 이상 12자 이하여야 해요.")

    validate_question_time(question_time_ms)

    return ValidatedRoom(
        name=normalized_name,
        category_id=category_id,
        capacity=capacity,
        is_public=public,
        password=normalized_password,
        game_mode=True,
        question_time_ms=question_time_ms,
    )


def validate_solo_room(*, category_id: str | None, question_time_ms: int) -> ValidatedRoom:
    """혼자 푸는 온라인 판의 방 (FR-7.13 3단계). 분야(전체 도전이면 None)와 문항 시간만 고른다.

    문항 시간은 친구와 푸는 방과 같은 20초·40초다 — «제한 없음»은 연습(기록 안 남음)에만 있다
    (PRD 10.2 #2의 기본값). 비밀번호는 없다: 남은 목록에서 볼 수도, 코드로 들어올 수도 없다.
    """
    if category_id is not None and category_id not in ALLOWED_CATEGORIES:
        raise DomainError("invalid-category", "지원하지 않는 게임 형식이에요.")
    validate_question_time(question_time_ms)
    return ValidatedRoom(
        name=SOLO_ROOM_NAME,
        category_id=category_id,
        capacity=SOLO_ROOM_CAPACITY,
        is_public=True,
        password=None,
        game_mode=True,
        question_time_ms=question_time_ms,
    )


def validate_question_time(question_time_ms: object) -> int:
    """온라인 문항 시간은 20초·40초 둘뿐이다. bool·실수·글자는 받지 않는다."""
    if type(question_time_ms) is not int or question_time_ms not in ALLOWED_QUESTION_TIMES_MS:
        raise DomainError("invalid-question-time", "문항 시간은 20초나 40초 중에서 골라 주세요.")
    return question_time_ms


# 닉네임 금칙 규칙(PRD 12.1)에 걸렸을 때의 오류. 화면은 코드를 보고 제 말로 옮긴다
# (src/online/rules.ts의 NICKNAME_REJECTION_MESSAGES). 같은 이름은 막지 않는다.
NICKNAME_PROFANITY_CODE = "nickname-profanity"
NICKNAME_PERSONAL_INFO_CODE = "nickname-personal-info"


def validate_player(nickname: str | None, character_id: str | None) -> ValidatedPlayer:
    normalized_nickname = str(nickname or "").strip() or "손님"
    normalized_nickname = _truncate_utf16(normalized_nickname, NICKNAME_MAX_UNITS)
    problem = nickname_problem(normalized_nickname)
    if problem == "profanity":
        raise DomainError(
            NICKNAME_PROFANITY_CODE,
            "닉네임에 쓸 수 없는 말이 들어 있어요. 다른 닉네임으로 바꿔 주세요.",
        )
    if problem is not None:
        raise DomainError(
            NICKNAME_PERSONAL_INFO_CODE,
            "전화번호·이메일·인터넷 주소처럼 보이는 닉네임은 쓸 수 없어요. "
            "다른 닉네임으로 바꿔 주세요.",
        )

    normalized_character = (
        DEFAULT_CHARACTER_ID if character_id is None else str(character_id).strip()
    )
    if not _CHARACTER_RE.fullmatch(normalized_character):
        raise DomainError("invalid-character", "지원하지 않는 캐릭터 식별자예요.")

    return ValidatedPlayer(
        nickname=normalized_nickname,
        character_id=normalized_character,
    )


def validate_chat(text: str | None) -> str:
    normalized = str(text or "").strip()
    if not normalized:
        raise DomainError("invalid-chat", "보낼 말을 입력해 주세요.")
    return _truncate_utf16(normalized, CHAT_MAX_UNITS)


def normalize_code(value: str | None) -> str:
    normalized = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    if len(normalized) != _CODE_LENGTH:
        raise DomainError("invalid-code", "방 코드는 여섯 글자여야 해요.")
    return normalized
