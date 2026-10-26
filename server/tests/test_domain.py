from __future__ import annotations

import pytest

from app.domain import (
    ALLOWED_QUESTION_TIMES_MS,
    DomainError,
    normalize_code,
    validate_chat,
    validate_player,
    validate_question_time,
    validate_room,
)


def test_validate_room_normalizes_supported_public_room() -> None:
    room = validate_room(
        name="  같이 풀어요  ",
        category_id="history",
        capacity=12,
        is_public=True,
        password="ignored-for-public",  # noqa: S106 - 공개방에서 버리는 테스트 더미
    )

    assert room.name == "같이 풀어요"
    assert room.category_id == "history"
    assert room.capacity == 12
    assert room.is_public is True
    assert room.password is None


def test_validate_room_requires_private_password_and_rejects_unknown_capacity() -> None:
    with pytest.raises(DomainError, match="비밀번호") as missing:
        validate_room(
            name="잠긴 방",
            category_id=None,
            capacity=12,
            is_public=False,
            password="",
        )
    assert missing.value.code == "invalid-password"

    with pytest.raises(DomainError, match="인원") as capacity:
        validate_room(
            name="열세 명 방",
            category_id=None,
            capacity=13,
            is_public=True,
            password=None,
        )
    assert capacity.value.code == "invalid-capacity"


def test_validate_room_keeps_the_hosts_question_time_and_defaults_to_20_seconds() -> None:
    def room(**changes: object) -> object:
        return validate_room(
            name="시간 방",
            category_id=None,
            capacity=4,
            is_public=True,
            password=None,
            **changes,  # type: ignore[arg-type]
        )

    assert room().question_time_ms == 20_000
    assert room(question_time_ms=40_000).question_time_ms == 40_000
    assert ALLOWED_QUESTION_TIMES_MS == frozenset({20_000, 40_000})


@pytest.mark.parametrize("value", [30_000, 0, -20_000, 60_000, True, 40_000.0, "40000", None])
def test_validate_room_rejects_question_times_other_than_20_or_40_seconds(value: object) -> None:
    # 온라인에는 제한 없음이 없다 — 한 사람이 답하지 않으면 방 전체가 멈춘다
    with pytest.raises(DomainError, match="20초나 40초") as caught:
        validate_room(
            name="시간 방",
            category_id=None,
            capacity=4,
            is_public=True,
            password=None,
            question_time_ms=value,  # type: ignore[arg-type]
        )
    assert caught.value.code == "invalid-question-time"
    with pytest.raises(DomainError):
        validate_question_time(value)


@pytest.mark.parametrize("value", ["", "   ", "12345678901234567"])
def test_validate_room_rejects_invalid_names(value: str) -> None:
    with pytest.raises(DomainError) as caught:
        validate_room(
            name=value,
            category_id="science",
            capacity=4,
            is_public=True,
            password=None,
        )
    assert caught.value.code == "invalid-name"


def test_validate_room_rejects_unknown_category_and_bool_capacity() -> None:
    with pytest.raises(DomainError) as category:
        validate_room(
            name="분야 오류",
            category_id="unknown",
            capacity=4,
            is_public=True,
            password=None,
        )
    assert category.value.code == "invalid-category"

    with pytest.raises(DomainError) as capacity:
        validate_room(
            name="불리언 인원",
            category_id="art",
            capacity=True,
            is_public=True,
            password=None,
        )
    assert capacity.value.code == "invalid-capacity"


def test_validate_room_normalizes_legacy_false_to_character_only() -> None:
    room = validate_room(
        name="캐릭터 전용 방",
        category_id="art",
        capacity=4,
        is_public=True,
        password=None,
        game_mode=False,
    )

    assert room.game_mode is True


def test_validate_player_and_chat_bound_untrusted_text() -> None:
    player = validate_player("  퀴즈왕  ", "pixel-dragon")
    assert player.nickname == "퀴즈왕"
    assert player.character_id == "pixel-dragon"

    assert validate_chat("  안녕하세요  ") == "안녕하세요"
    assert validate_chat("가" * 100) == "가" * 60

    with pytest.raises(DomainError) as empty:
        validate_chat("   ")
    assert empty.value.code == "invalid-chat"


def test_validate_player_assigns_a_character_to_legacy_clients() -> None:
    assert validate_player("퀴즈왕", None).character_id == "slime-blue"


@pytest.mark.parametrize("character_id", ["", "not valid!", "UPPERCASE"])
def test_validate_player_requires_supported_character_identifier(character_id: str) -> None:
    with pytest.raises(DomainError) as caught:
        validate_player("퀴즈왕", character_id)

    assert caught.value.code == "invalid-character"


def test_normalize_code_accepts_human_separators_but_requires_six_characters() -> None:
    assert normalize_code(" ab-cd 12 ") == "ABCD12"
    with pytest.raises(DomainError) as caught:
        normalize_code("abc")
    assert caught.value.code == "invalid-code"
