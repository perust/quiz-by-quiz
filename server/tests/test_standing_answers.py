from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID

import pytest

from app.main import StandingAnswers, _movement_message, _standing_answer_message
from app.repository import MatchView

# 발밑 칸 초안 (U13). 화면이 실제로 움직인 뒤 선 칸을 방 소켓으로 보내면 API가 메모리에 두고,
# 마감이 빈 답을 채울 때 그 칸을 답으로 남긴다. 여기서는 메시지 검증과 메모리의 한도·정리를 본다.

CODE = "ABC234"
OTHER_CODE = "XYZ789"
MATCH = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
NEXT_MATCH = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
HOST = UUID("11111111-1111-4111-8111-111111111111")
GUEST = UUID("22222222-2222-4222-8222-222222222222")
THIRD = UUID("33333333-3333-4333-8333-333333333333")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def _message(**changes: object) -> str:
    value: dict[str, object] = {
        "type": "standing-answer",
        "matchId": str(MATCH),
        "position": 3,
        "choiceIndex": 2,
    }
    value.update(changes)
    return json.dumps(value)


def test_a_standing_answer_message_carries_only_match_position_and_tile() -> None:
    assert _standing_answer_message(_message()) == (MATCH, 3, 2)
    # 칸에서 내려섰다 — 지운다
    assert _standing_answer_message(_message(choiceIndex=None)) == (MATCH, 3, None)
    assert _standing_answer_message(_message(position=25, choiceIndex=0)) == (MATCH, 25, 0)


@pytest.mark.parametrize(
    "message",
    [
        _message(choiceIndex=4),
        _message(choiceIndex=-1),
        _message(choiceIndex=True),
        _message(choiceIndex=1.0),
        _message(choiceIndex="2"),
        _message(position=0),
        _message(position=26),
        _message(position=True),
        _message(position=3.0),
        _message(matchId="not-a-uuid"),
        _message(matchId=str(MATCH).upper() + "0"),
        _message(matchId=7),
        _message(type="movement"),
        json.dumps({"type": "standing-answer", "matchId": str(MATCH), "position": 3}),
        # 누구의 초안인지는 소켓 티켓이 정한다. 화면이 보낸 신원은 받지 않는다
        _message(playerId=str(GUEST)),
        _message(pad="x" * 200),
        "[]",
        "{not json",
        '"standing-answer"',
    ],
)
def test_a_malformed_standing_answer_is_ignored(message: str) -> None:
    assert _standing_answer_message(message) is None


def test_movement_and_standing_answers_never_parse_as_each_other() -> None:
    movement = json.dumps({"type": "movement", "x": 0.5, "y": 0.5, "moving": False})
    assert _standing_answer_message(movement) is None
    assert _movement_message(_message()) is None


def test_each_player_keeps_one_draft_and_only_the_asked_question_is_returned() -> None:
    drafts = StandingAnswers(wall_clock=lambda: datetime(2026, 10, 27, tzinfo=UTC))
    drafts.record(CODE, HOST, match_id=MATCH, position=3, choice_index=0)
    drafts.record(CODE, HOST, match_id=MATCH, position=3, choice_index=2)
    drafts.record(CODE, GUEST, match_id=MATCH, position=2, choice_index=1)
    drafts.record(OTHER_CODE, THIRD, match_id=MATCH, position=3, choice_index=3)

    assert len(drafts) == 3, "새 초안이 그 사람의 앞 초안을 갈아 치운다"
    answers = drafts.for_question(CODE, MATCH, 3)
    assert set(answers) == {HOST}
    assert answers[HOST].choice_index == 2
    assert answers[HOST].received_at == datetime(2026, 10, 27, tzinfo=UTC)
    assert drafts.for_question(CODE, NEXT_MATCH, 3) == {}
    assert set(drafts.for_question(OTHER_CODE, MATCH, 3)) == {THIRD}

    drafts.clear(CODE, HOST)
    assert drafts.for_question(CODE, MATCH, 3) == {}
    drafts.clear(CODE, HOST)  # 없어도 조용하다


def test_drafts_are_forgotten_when_the_question_advances_or_the_match_ends() -> None:
    drafts = StandingAnswers()
    drafts.record(CODE, HOST, match_id=MATCH, position=3, choice_index=0)
    drafts.record(CODE, GUEST, match_id=MATCH, position=4, choice_index=1)
    drafts.record(CODE, THIRD, match_id=NEXT_MATCH, position=1, choice_index=2)

    view = _view(state="running", position=4)
    # 4번이 도는 중이면 3번까지의 초안만 버린다 — 도는 문항의 초안은 남는다
    drafts.settle_view(CODE, view)
    assert drafts.for_question(CODE, MATCH, 3) == {}
    assert set(drafts.for_question(CODE, MATCH, 4)) == {GUEST}
    # 4번을 공개하면 4번의 초안도 버린다. 다른 판(같은 방의 새 판)의 초안은 그대로다
    drafts.settle_view(CODE, replace(view, state="revealing"))
    assert drafts.for_question(CODE, MATCH, 4) == {}
    assert set(drafts.for_question(CODE, NEXT_MATCH, 1)) == {THIRD}

    drafts.record(CODE, HOST, match_id=MATCH, position=9, choice_index=0)
    drafts.settle_view(CODE, replace(view, state="finished"))
    assert drafts.for_question(CODE, MATCH, 9) == {}
    assert len(drafts) == 1

    # 마감 sweep은 넘기기 전의 문항까지 버린다
    drafts.record(CODE, HOST, match_id=NEXT_MATCH, position=2, choice_index=1)
    drafts.settle(CODE, NEXT_MATCH, through_position=1)
    assert drafts.for_question(CODE, NEXT_MATCH, 1) == {}
    assert set(drafts.for_question(CODE, NEXT_MATCH, 2)) == {HOST}
    drafts.settle(CODE, NEXT_MATCH, through_position=None)
    assert len(drafts) == 0


def test_drafts_end_with_membership_and_the_room() -> None:
    drafts = StandingAnswers()
    drafts.record(CODE, HOST, match_id=MATCH, position=1, choice_index=0)
    drafts.record(CODE, GUEST, match_id=MATCH, position=1, choice_index=1)
    drafts.record(OTHER_CODE, GUEST, match_id=MATCH, position=1, choice_index=1)

    drafts.forget_member(CODE, GUEST)
    assert set(drafts.for_question(CODE, MATCH, 1)) == {HOST}
    drafts.forget_room(CODE)
    assert drafts.for_question(CODE, MATCH, 1) == {}
    assert set(drafts.for_question(OTHER_CODE, MATCH, 1)) == {GUEST}


def test_old_drafts_expire_and_the_store_is_bounded() -> None:
    clock = FakeClock()
    drafts = StandingAnswers(record_seconds=90, max_records=2, clock=clock)
    drafts.record(CODE, HOST, match_id=MATCH, position=1, choice_index=0)
    clock.now += 30
    drafts.record(CODE, GUEST, match_id=MATCH, position=1, choice_index=1)
    clock.now += 30
    # 넘치면 가장 오래된 것부터 버린다
    drafts.record(CODE, THIRD, match_id=MATCH, position=1, choice_index=2)
    assert len(drafts) == 2
    assert set(drafts.for_question(CODE, MATCH, 1)) == {GUEST, THIRD}

    # 기억하는 시간이 지나면 버린다 — 문항은 길어야 40초다
    clock.now += 61
    assert set(drafts.for_question(CODE, MATCH, 1)) == {THIRD}
    clock.now += 30
    assert drafts.for_question(CODE, MATCH, 1) == {}
    assert len(drafts) == 0


def test_store_limits_must_be_positive() -> None:
    with pytest.raises(ValueError):
        StandingAnswers(record_seconds=0)
    with pytest.raises(ValueError):
        StandingAnswers(max_records=0)


def _view(*, state: str, position: int) -> MatchView:
    return MatchView(
        id=MATCH,
        state=state,
        category_id="history",
        game_mode=True,
        current_position=position,
        total_questions=10,
        deadline_at=None,
        question=None,
        own_answer=None,
        scores=(),
    )
