"""room-invalidated fan-out 줄이기: 방 판 번호와 준비 토글 고칠 거리.

CLAUDE.md «room-invalidated 재조회는 합친다»의 서버 쪽이다.

화면은 번호가 붙은 snapshot을 가지면 그 번호 이하의 무효화를 다시 읽지 않고, 준비 토글은 바로 앞
번호의 방에 덧대어 GET 없이 고친다. 그래서 서버는 셋을 지켜야 한다 — snapshot의 번호는 DB를 읽기
전에 읽고, 방송하지 않는 변화(판 시작·30분 정리)도 번호를 올리며, 접속 상태 변화가 아직 방송되지
않았으면 고칠 거리를 싣지 않는다. 이전 화면은 더한 키를 모르고 예전처럼 다시 읽는다.
"""

from __future__ import annotations

import asyncio
import re
import threading
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from test_api import (
    HEADERS,
    PLAYER_ID,
    FakeClock,
    FakeRepository,
    register,
    wait_until,
    ws_protocols,
)

from app.main import EventHub, _movement_message, create_app
from app.repository import CleanupCounts, MatchSetup, PlayerView, RoomView
from app.room_versions import RoomVersions

OTHER_ID = UUID("87654321-4321-4765-8321-876543218765")
MATCH_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
EPOCH_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


# ── 번호 자체 ─────────────────────────────────────────────────────────


def test_versions_rise_across_the_process_and_remember_each_room_previous_change() -> None:
    versions = RoomVersions()

    assert versions.label() == 0
    assert versions.bump("ABC234") == (1, 0)
    assert versions.bump("XYZ789") == (2, 0)
    # 이 방이 바로 앞에 바뀐 번호는 다른 방의 번호와 섞이지 않는다
    assert versions.bump("ABC234") == (3, 1)
    assert versions.label() == 3


def test_forgotten_rooms_never_let_a_version_go_backwards() -> None:
    versions = RoomVersions(max_rooms=2)
    versions.bump("AAAAAA")  # 1
    versions.bump("BBBBBB")  # 2
    versions.bump("CCCCCC")  # 3, AAAAAA을 버린다

    # 버린 방의 «바로 앞 번호»는 버린 번호 이상으로 크게 나간다 — 화면이 한 번 더 읽을 뿐이다
    version, previous = versions.bump("AAAAAA")
    assert version == 4
    assert previous >= 1
    assert previous < version


def test_a_change_that_names_no_room_moves_every_room_previous_version() -> None:
    versions = RoomVersions()
    versions.bump("ABC234")
    versions.bump("XYZ789")

    cleaned = versions.bump_all()

    assert cleaned == 3
    assert versions.bump("ABC234") == (4, 3)
    assert versions.bump("XYZ789") == (5, 3)


def test_each_process_names_its_versions_differently() -> None:
    first = RoomVersions()
    second = RoomVersions()

    assert EPOCH_PATTERN.match(first.epoch)
    assert EPOCH_PATTERN.match(second.epoch)
    assert first.epoch != second.epoch


def test_ready_writes_take_turns_per_room_and_leave_no_lock_behind() -> None:
    versions = RoomVersions()
    trace: list[str] = []

    async def write(code: str, name: str, pause: float) -> None:
        async with versions.writing(code):
            trace.append(f"{name}:start")
            await asyncio.sleep(pause)
            trace.append(f"{name}:end")

    async def scenario() -> None:
        await asyncio.gather(
            write("ABC234", "first", 0.02),
            write("ABC234", "second", 0),
            write("XYZ789", "other", 0),
        )

    asyncio.run(scenario())

    same_room = [entry for entry in trace if not entry.startswith("other")]
    assert same_room == ["first:start", "first:end", "second:start", "second:end"]
    # 다른 방은 기다리지 않는다
    assert trace.index("other:end") < trace.index("first:end")
    assert versions._locks == {}  # noqa: SLF001 - 잠금을 남기지 않는지 본다


# ── API ──────────────────────────────────────────────────────────────


def _two_player_room(*, ready: bool = False) -> RoomView:
    return RoomView(
        code="ABC234",
        name="온라인 퀴즈",
        category_id="history",
        capacity=12,
        game_mode=True,
        players=(
            PlayerView(id=PLAYER_ID, nickname="퀴즈왕", character_id="slime-blue"),
            PlayerView(
                id=OTHER_ID,
                nickname="친구",
                character_id="slime-pink",
                is_ready=ready,
            ),
        ),
        is_public=False,
        has_password=True,
        is_mine=True,
        joined=True,
        created_at="2026-09-17T00:00:00+00:00",
    )


class VersionedRepository(FakeRepository):
    def __init__(self) -> None:
        super().__init__()
        self.member = True
        self.room = _two_player_room()
        self.during_read: Any = None
        self.cleanup = CleanupCounts()
        self.cleaned = threading.Event()

    async def get_room(self, actor_id: UUID, code: str) -> RoomView | None:
        if self.during_read is not None:
            # 읽는 사이 다른 요청이 commit하고 번호를 올렸다
            self.during_read()
        return await super().get_room(actor_id, code)

    async def set_ready(self, actor_id: UUID, code: str, is_ready: bool) -> RoomView:
        self.room = replace(
            self.room,
            players=tuple(
                replace(player, is_ready=is_ready) if player.id == actor_id else player
                for player in self.room.players
            ),
        )
        return self.room

    async def start_game(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSetup:
        self.room = replace(
            self.room,
            players=tuple(replace(player, is_ready=False) for player in self.room.players),
        )
        return MatchSetup(id=MATCH_ID, category_id="history", game_mode=True, total_questions=10)

    async def cleanup_expired_resources(self) -> CleanupCounts:
        counts, self.cleanup = self.cleanup, CleanupCounts()
        if counts.changed:
            self.cleaned.set()
        return counts

    async def advance_expired_matches(self, *, standing_answers: Any | None = None) -> list[Any]:
        return []


def _connect(client: TestClient) -> Any:
    ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
    return client.websocket_connect("/v1/rooms/ABC234/events", subprotocols=ws_protocols(ticket))


def test_room_snapshots_carry_the_version_read_before_the_database() -> None:
    repository = VersionedRepository()
    versions = RoomVersions()
    with TestClient(create_app(repository=repository, room_versions=versions)) as client:
        register(client)
        first = client.get("/v1/rooms/ABC234", headers=HEADERS).json()
        versions.bump("ABC234")
        repository.during_read = lambda: versions.bump("ABC234")
        racing = client.get("/v1/rooms/ABC234", headers=HEADERS).json()
        listed = client.get("/v1/rooms", headers=HEADERS).json()

    assert (first["roomEpoch"], first["roomVersion"]) == (versions.epoch, 0)
    # 읽는 사이 올라간 번호(2)를 붙이지 않는다 — 그 변화가 이 snapshot에 담겼는지 모른다
    assert racing["roomVersion"] == 1
    # 목록은 구독이 쓰지 않는다. 번호를 싣지 않는다
    assert "roomVersion" not in listed[0]


def test_a_ready_toggle_carries_the_one_change_a_screen_may_apply_without_a_get() -> None:
    repository = VersionedRepository()
    versions = RoomVersions()
    with TestClient(create_app(repository=repository, room_versions=versions)) as client:
        register(client)
        with _connect(client) as websocket:
            before = client.get("/v1/rooms/ABC234", headers=HEADERS).json()
            readied = client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": True})
            ready_event = websocket.receive_json()
            patched = client.patch("/v1/rooms/ABC234", headers=HEADERS, json={"capacity": 8})
            patch_event = websocket.receive_json()
            unready = client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": False})
            unready_event = websocket.receive_json()

    assert readied.status_code == 200
    assert ready_event == {
        "type": "room-invalidated",
        "roomEpoch": versions.epoch,
        "roomVersion": 1,
        "readyChange": {"previousVersion": 0, "playerId": str(PLAYER_ID), "isReady": True},
    }
    # 응답의 번호는 바꾸기 전에 읽은 것이다. 화면은 곧 오는 제 방송(1)을 덧대어 고친다
    assert readied.json()["roomVersion"] == before["roomVersion"] == 0
    # 준비 말고는 고칠 거리가 없다 — 모두 다시 읽는다
    assert patched.status_code == 200
    assert patch_event == {
        "type": "room-invalidated",
        "roomEpoch": versions.epoch,
        "roomVersion": 2,
    }
    assert unready.status_code == 200
    assert unready_event["readyChange"] == {
        "previousVersion": 2,
        "playerId": str(PLAYER_ID),
        "isReady": False,
    }
    assert unready_event["roomVersion"] == 3


def test_starting_a_match_moves_the_version_without_a_room_broadcast() -> None:
    # 판 시작은 모두의 준비를 되돌린다. game-started만 보내지만 번호를 올려, 시작 전의 방을 가진
    # 화면이 다음 준비 토글을 덧대어 고치지 못하게 한다(바로 앞 번호가 맞지 않아 다시 읽는다).
    repository = VersionedRepository()
    repository.room = _two_player_room(ready=True)
    versions = RoomVersions()
    with TestClient(create_app(repository=repository, room_versions=versions)) as client:
        register(client)
        with _connect(client) as websocket:
            before_start = client.get("/v1/rooms/ABC234", headers=HEADERS).json()["roomVersion"]
            started = client.post("/v1/rooms/ABC234/start", headers=HEADERS)
            started_event = websocket.receive_json()
            client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": True})
            ready_event = websocket.receive_json()

    assert started.status_code == 201
    assert started_event["type"] == "game-started"
    assert ready_event["readyChange"]["previousVersion"] > before_start


def test_cleanup_that_changed_something_moves_every_room_previous_version() -> None:
    repository = VersionedRepository()
    versions = RoomVersions()
    app = create_app(
        repository=repository,
        room_versions=versions,
        cleanup_interval_seconds=0.01,
    )
    with TestClient(app) as client:
        register(client)
        with _connect(client) as websocket:
            before = client.get("/v1/rooms/ABC234", headers=HEADERS).json()["roomVersion"]
            repository.cleanup = CleanupCounts(members_removed=1)
            assert repository.cleaned.wait(timeout=2)
            wait_until(lambda: versions.label() > before, "cleanup did not move the versions")
            client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": True})
            event = websocket.receive_json()

    # 정리 전의 방(before)에는 덧댈 수 없다 — 바로 앞 번호가 정리 뒤다
    assert event["readyChange"]["previousVersion"] > before


def test_no_ready_change_while_a_presence_change_is_not_yet_announced() -> None:
    # 친구가 유예를 넘겨 끊겼는데 sweep이 아직 알리지 않았다. 방 snapshot의 connected는 이미 바뀌어
    # 있으므로 덧대어 고치면 화면이 낡은 접속 상태를 이어 쓴다 — 고칠 거리를 싣지 않는다.
    repository = VersionedRepository()
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    app = create_app(
        repository=repository,
        event_hub=hub,
        presence_interval_seconds=3_600,
    )
    with TestClient(app) as client:
        register(client)
        with _connect(client) as websocket:
            wait_until(lambda: hub.is_present("ABC234", PLAYER_ID), "socket was not activated")
            fresh = client.get("/v1/rooms/ABC234", headers=HEADERS).json()
            assert [player["connected"] for player in fresh["players"]] == [True, True]
            client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": True})
            settled = websocket.receive_json()

            clock.now += 61
            assert not hub.presence_settled("ABC234")
            client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": False})
            unsettled = websocket.receive_json()

            # sweep이 알리고 나면 다시 고칠 거리를 싣는다
            hub.sweep_presence()
            assert hub.presence_settled("ABC234")
            client.put("/v1/rooms/ABC234/ready", headers=HEADERS, json={"isReady": True})
            announced = websocket.receive_json()

    assert "readyChange" in settled
    assert unsettled["type"] == "room-invalidated"
    assert "readyChange" not in unsettled
    assert "readyChange" in announced


def test_a_reconnected_member_is_unsettled_until_the_sweep_announces_it() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    socket = object()
    assert hub.connect("ABC234", OTHER_ID, socket)  # type: ignore[arg-type]
    hub.disconnect("ABC234", socket)  # type: ignore[arg-type]
    clock.now += 61
    hub.sweep_presence()
    assert hub.presence_settled("ABC234")

    again = object()
    assert hub.connect("ABC234", OTHER_ID, again)  # type: ignore[arg-type]
    assert not hub.presence_settled("ABC234")
    hub.sweep_presence()
    assert hub.presence_settled("ABC234")


# ── 공유 무대 좌표 (U31) ───────────────────────────────────────────────


def _stage_movement(**changes: object) -> dict[str, object]:
    base: dict[str, object] = {
        "type": "movement",
        "x": 0.25,
        "y": 0.75,
        "moving": False,
        "viewportWidth": 390,
        "viewportHeight": 844,
        "stage": "arena",
        "stageX": 0.5,
        "stageY": 0.25,
    }
    base.update(changes)
    return base


def test_stage_coordinates_are_bounded_named_and_need_the_viewport() -> None:
    import json

    accepted = _movement_message(json.dumps(_stage_movement()))
    assert accepted is not None
    assert (accepted.stage, accepted.stage_x, accepted.stage_y) == ("arena", 0.5, 0.25)

    seated = _movement_message(json.dumps(_stage_movement(stage="lounge", seatId="sofa-left")))
    assert seated is not None and (seated.seat_id, seated.stage) == ("sofa-left", "lounge")

    # 가장 긴 모양도 256자 안이다(소켓 한 줄 한도는 그대로다)
    longest = json.dumps(
        _stage_movement(
            x=0.1234, y=0.1234, viewportWidth=8192, viewportHeight=8192,
            seatId="chair-right", stage="lounge", stageX=0.1234, stageY=0.1234,
        ),
        separators=(",", ":"),
    )
    assert len(longest) <= 256
    assert _movement_message(longest) is not None

    rejected = [
        _stage_movement(stage="table"),
        _stage_movement(stageX=1.5),
        _stage_movement(stageY=-0.1),
        _stage_movement(stageX=True),
        _stage_movement(stageY="0.5"),
        _stage_movement(stageX=float("nan")),
    ]
    for payload in rejected:
        assert _movement_message(json.dumps(payload)) is None, payload
    partial = _stage_movement()
    del partial["stageY"]
    assert _movement_message(json.dumps(partial)) is None
    legacy_with_stage = {"type": "movement", "x": 0.2, "y": 0.3, "moving": True,
                         "stage": "arena", "stageX": 0.5, "stageY": 0.5}
    assert _movement_message(json.dumps(legacy_with_stage)) is None


def test_stage_coordinates_are_advertised_and_relayed_only_as_received() -> None:
    repository = VersionedRepository()
    with TestClient(create_app(repository=repository)) as client:
        register(client)
        ticket_body = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()
        assert ticket_body["movementStage"] == "stage-unit-v1"
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket_body["ticket"]),
        ) as websocket:
            websocket.send_json(_stage_movement(stage="table"))
            websocket.send_json(_stage_movement())
            staged = websocket.receive_json()
            websocket.send_json(
                {"type": "movement", "x": 0.4, "y": 0.6, "moving": True,
                 "viewportWidth": 1440, "viewportHeight": 900}
            )
            plain = websocket.receive_json()

    assert staged["stage"] == "arena"
    assert (staged["stageX"], staged["stageY"]) == (0.5, 0.25)
    assert (staged["x"], staged["viewportWidth"]) == (0.25, 390)
    # 무대를 싣지 않은 이동은 예전 모양 그대로다
    assert "stage" not in plain and "stageX" not in plain and "stageY" not in plain
    assert plain["viewportWidth"] == 1440


@pytest.mark.parametrize("key", ["stage", "stageX", "stageY"])
def test_a_movement_with_one_stage_key_is_dropped_like_any_unknown_shape(key: str) -> None:
    import json

    payload = {"type": "movement", "x": 0.2, "y": 0.3, "moving": False,
               "viewportWidth": 390, "viewportHeight": 844, key: "arena" if key == "stage" else 0.5}
    assert _movement_message(json.dumps(payload)) is None
