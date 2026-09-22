from __future__ import annotations

import re
from dataclasses import dataclass

ALLOWED_CAPACITIES = frozenset({2, 4, 6, 8, 10, 12})
ALLOWED_CATEGORIES = frozenset({"history", "science", "geography", "general", "art"})
ROOM_NAME_MAX_UNITS = 16
ROOM_PASSWORD_MIN_UNITS = 4
ROOM_PASSWORD_MAX_UNITS = 12
NICKNAME_MAX_UNITS = 10
CHAT_MAX_UNITS = 60
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


@dataclass(frozen=True)
class ValidatedPlayer:
    nickname: str
    character_id: str | None


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
    game_mode: bool = False,
) -> ValidatedRoom:
    normalized_name = str(name or "").strip()
    if not normalized_name or _utf16_units(normalized_name) > ROOM_NAME_MAX_UNITS:
        raise DomainError("invalid-name", "방 이름은 1자 이상 16자 이하여야 합니다.")

    if category_id is not None and category_id not in ALLOWED_CATEGORIES:
        raise DomainError("invalid-category", "지원하지 않는 게임 형식입니다.")

    if type(capacity) is not int or capacity not in ALLOWED_CAPACITIES:
        raise DomainError("invalid-capacity", "인원은 2, 4, 6, 8, 10, 12명 중에서 골라야 합니다.")

    public = bool(is_public)
    normalized_password: str | None = None
    if not public:
        normalized_password = str(password or "")
        password_units = _utf16_units(normalized_password)
        if not ROOM_PASSWORD_MIN_UNITS <= password_units <= ROOM_PASSWORD_MAX_UNITS:
            raise DomainError("invalid-password", "비밀번호는 4자 이상 12자 이하여야 합니다.")

    return ValidatedRoom(
        name=normalized_name,
        category_id=category_id,
        capacity=capacity,
        is_public=public,
        password=normalized_password,
        game_mode=bool(game_mode),
    )


def validate_player(nickname: str | None, character_id: str | None) -> ValidatedPlayer:
    normalized_nickname = str(nickname or "").strip() or "손님"
    normalized_nickname = _truncate_utf16(normalized_nickname, NICKNAME_MAX_UNITS)

    normalized_character = str(character_id or "").strip() or None
    if normalized_character is not None and not _CHARACTER_RE.fullmatch(normalized_character):
        normalized_character = None

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
        raise DomainError("invalid-code", "방 코드는 여섯 글자여야 합니다.")
    return normalized
