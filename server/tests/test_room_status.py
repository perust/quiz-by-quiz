"""로비가 미리 알리는 방 상태와, 브라우저가 이유별로 옮기는 거절 코드의 계약 (U32·U33)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from test_api import HEADERS, PLAYER_ID, FakeRepository, make_client, register, room_view

from app.postgres import _ROOM_ROWS_SQL, _build_room_views
from app.repository import MatchInProgress, RoomView


def test_room_payload_reports_waiting_by_default_and_playing_during_a_match() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        register(client)
        waiting = client.get("/v1/rooms", headers=HEADERS)

        repository.room = room_view(status="playing")
        listed = client.get("/v1/rooms", headers=HEADERS)
        single = client.get(f"/v1/rooms/{repository.room.code}", headers=HEADERS)

    assert waiting.status_code == 200
    assert waiting.json()[0]["status"] == "waiting"
    assert listed.json()[0]["status"] == "playing"
    assert single.json()["status"] == "playing"


def test_room_payload_tells_a_member_whether_the_running_match_is_theirs() -> None:
    # U24: 끊겨서 판에서 빠진 멤버는 status가 playing인데 inMatch가 false다. 대기실이 이것으로
    # «다음 판에 함께할 수 있어요»와 「준비 완료」를 그린다.
    repository = FakeRepository()
    with make_client(repository) as client:
        register(client)
        waiting = client.get(f"/v1/rooms/{repository.room.code}", headers=HEADERS)
        repository.room = room_view(status="playing", in_match=False)
        left_out = client.get(f"/v1/rooms/{repository.room.code}", headers=HEADERS)
        repository.room = room_view(status="playing", in_match=True)
        playing = client.get(f"/v1/rooms/{repository.room.code}", headers=HEADERS)

    assert waiting.json()["inMatch"] is False
    assert (left_out.json()["status"], left_out.json()["inMatch"]) == ("playing", False)
    assert (playing.json()["status"], playing.json()["inMatch"]) == ("playing", True)


def test_room_rows_compute_the_actor_match_seat_once_per_room() -> None:
    normalized = " ".join(_ROOM_ROWS_SQL.lower().split())
    seat = (
        "exists ( select 1 from quiz_online.matches my_match"
        " join quiz_online.match_players my_player on my_player.match_id = my_match.id"
        " where my_match.room_id = candidate.id"
        " and my_match.state in ('running', 'revealing')"
        " and my_player.player_id = %(actor_id)s ) as in_match"
    )

    assert seat in normalized
    assert normalized.index(seat) < normalized.index("limit %(room_limit)s")
    assert "selected.in_match" in normalized


def test_join_and_leave_during_a_match_keep_the_game_in_progress_code() -> None:
    """브라우저는 이 code 로 «연결 문제»와 «끝나면 된다»를 가른다."""
    repository = FakeRepository()

    async def busy_join(actor_id: UUID, code: str) -> RoomView:
        raise MatchInProgress

    async def busy_leave(
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> RoomView | None:
        raise MatchInProgress

    repository.join_room = busy_join  # type: ignore[method-assign]
    repository.leave_room = busy_leave  # type: ignore[method-assign]
    with make_client(repository) as client:
        register(client)
        joined = client.post(
            f"/v1/rooms/{repository.room.code}/join",
            headers=HEADERS,
            json={"password": None},
        )
        left = client.delete(f"/v1/rooms/{repository.room.code}/members/me", headers=HEADERS)

    assert joined.status_code == 409
    assert joined.json()["detail"]["code"] == "game-in-progress"
    assert left.status_code == 409
    assert left.json()["detail"]["code"] == "game-in-progress"


def test_room_rows_compute_playing_once_per_room_from_active_matches() -> None:
    normalized = " ".join(_ROOM_ROWS_SQL.lower().split())
    playing = (
        "exists ( select 1 from quiz_online.matches active_match"
        " where active_match.room_id = candidate.id"
        " and active_match.state in ('running', 'revealing') ) as is_playing"
    )

    # join_room 이 MatchInProgress 를 내는 조건과 같고, 부모 방을 자르는 CTE 안에서
    # 방마다 한 번만 계산한다 (참가자 줄마다 다시 묻지 않는다).
    assert playing in normalized
    assert normalized.index(playing) < normalized.index("limit %(room_limit)s")
    assert "selected.is_playing" in normalized


def test_room_views_map_active_match_to_playing_status() -> None:
    created_at = datetime(2026, 9, 17, tzinfo=UTC)

    def row(code: str, *, is_playing: bool) -> dict[str, object]:
        return {
            "room_id": UUID(int=len(code) + int(is_playing)),
            "code": code,
            "name": "상태 검증",
            "category_id": None,
            "capacity": 4,
            "game_mode": True,
            "is_public": True,
            "has_password": False,
            "is_mine": False,
            "joined": False,
            "is_playing": is_playing,
            "in_match": is_playing,
            "created_at": created_at,
            "player_id": PLAYER_ID,
            "nickname": "퀴즈왕",
            "character_id": "slime-blue",
            "is_ready": False,
        }

    views = _build_room_views([row("WAIT23", is_playing=False), row("PLAY23", is_playing=True)])

    assert [(view.code, view.status, view.in_match) for view in views] == [
        ("WAIT23", "waiting", False),
        ("PLAY23", "playing", True),
    ]
