from __future__ import annotations

import asyncio
from uuid import UUID

import pytest

from app.main import EventHub

ACTOR_A = UUID("11111111-1111-4111-8111-111111111111")
ACTOR_B = UUID("22222222-2222-4222-8222-222222222222")


class FakeWebSocket:
    def __init__(
        self,
        *,
        block_send: bool = False,
        block_close: bool = False,
        fail_close: bool = False,
    ) -> None:
        self.block_send = block_send
        self.block_close = block_close
        self.fail_close = fail_close
        self.sent: list[dict[str, object]] = []
        self.closed: list[int] = []
        self.close_calls = 0
        self.close_started = asyncio.Event()
        self.release_close = asyncio.Event()

    async def send_json(self, event: dict[str, object]) -> None:
        if self.block_send:
            await asyncio.Event().wait()
        self.sent.append(event)

    async def close(self, *, code: int) -> None:
        self.close_calls += 1
        self.close_started.set()
        if self.block_close:
            await self.release_close.wait()
        if self.fail_close:
            raise RuntimeError("close failed")
        self.closed.append(code)


def test_event_hub_enforces_actor_room_room_and_process_caps() -> None:
    hub = EventHub(max_actor_room=1, max_room=2, max_total=2)
    first = FakeWebSocket()
    same_actor = FakeWebSocket()
    second_actor = FakeWebSocket()
    other_room = FakeWebSocket()

    assert hub.connect("ABC234", ACTOR_A, first)
    assert not hub.connect("ABC234", ACTOR_A, same_actor)
    assert hub.connect("ABC234", ACTOR_B, second_actor)
    assert not hub.connect("XYZ789", ACTOR_A, other_room)
    assert hub.connection_count == 2

    hub.disconnect("ABC234", first)
    assert hub.connect("XYZ789", ACTOR_A, other_room)
    assert hub.connection_count == 2


def test_event_hub_reservation_is_not_broadcast_until_activated() -> None:
    hub = EventHub(max_actor_room=1, max_room=1, max_total=1)
    pending = FakeWebSocket()

    assert hub.reserve("ABC234", ACTOR_A, pending)
    assert hub.connection_count == 1

    asyncio.run(hub.broadcast("ABC234", {"type": "room-invalidated"}))

    assert pending.sent == []
    assert pending.closed == []
    assert hub.activate("ABC234", ACTOR_A, pending)

    asyncio.run(hub.broadcast("ABC234", {"type": "room-invalidated"}))

    assert pending.sent == [{"type": "room-invalidated"}]


def test_event_hub_broadcasts_concurrently_and_drops_timed_out_socket() -> None:
    hub = EventHub(send_timeout_seconds=0.01)
    blocked = FakeWebSocket(block_send=True)
    healthy = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, blocked)
    assert hub.connect("ABC234", ACTOR_B, healthy)

    asyncio.run(hub.broadcast("ABC234", {"type": "room-invalidated"}))

    assert healthy.sent == [{"type": "room-invalidated"}]
    assert blocked.closed == [1011]
    assert hub.connection_count == 1


def test_event_hub_disconnects_actor_and_revalidates_membership() -> None:
    hub = EventHub()
    first = FakeWebSocket()
    second = FakeWebSocket()
    third = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, first)
    assert hub.connect("ABC234", ACTOR_A, second)
    assert hub.connect("ABC234", ACTOR_B, third)

    async def scenario() -> None:
        await hub.disconnect_actor("ABC234", ACTOR_A)
        assert first.closed == [4403]
        assert second.closed == [4403]
        assert hub.connection_count == 1

        async def is_member(actor_id: UUID, code: str) -> bool:
            return actor_id == ACTOR_A and code == "ABC234"

        await hub.revalidate(is_member)

    asyncio.run(scenario())
    assert third.closed == [4403]
    assert hub.connection_count == 0


def test_event_hub_revalidation_does_not_close_a_later_connection() -> None:
    hub = EventHub()
    stale = FakeWebSocket()
    fresh = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, stale)

    async def scenario() -> None:
        membership_started = asyncio.Event()
        release_membership = asyncio.Event()

        async def is_member(actor_id: UUID, code: str) -> bool:
            assert actor_id == ACTOR_A
            assert code == "ABC234"
            membership_started.set()
            await release_membership.wait()
            return False

        revalidation = asyncio.create_task(hub.revalidate(is_member))
        await membership_started.wait()
        assert hub.connect("ABC234", ACTOR_A, fresh)
        release_membership.set()
        await revalidation

    asyncio.run(scenario())

    assert stale.closed == [4403]
    assert fresh.closed == []
    assert hub.is_connected(fresh)
    assert hub.connection_count == 1


def test_event_hub_retains_capacity_until_failed_close_has_a_proven_disconnect() -> None:
    hub = EventHub(max_actor_room=1, max_room=1, max_total=1)
    failed = FakeWebSocket(fail_close=True)
    replacement = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, failed)

    asyncio.run(hub.disconnect_actor("ABC234", ACTOR_A))

    assert failed.close_calls == 1
    assert hub.connection_count == 1
    assert not hub.connect("XYZ789", ACTOR_B, replacement)

    # The receive handler's finally block is independent proof that the old
    # transport no longer consumes an admitted connection.
    hub.disconnect("ABC234", failed)
    assert hub.connect("XYZ789", ACTOR_B, replacement)


def test_event_hub_shares_one_tracked_close_until_it_finishes() -> None:
    hub = EventHub(max_total=1, send_timeout_seconds=1)
    socket = FakeWebSocket(block_close=True)
    assert hub.connect("ABC234", ACTOR_A, socket)

    async def scenario() -> None:
        actor_close = asyncio.create_task(hub.disconnect_actor("ABC234", ACTOR_A))
        await socket.close_started.wait()
        shutdown_close = asyncio.create_task(hub.close_all())
        await asyncio.sleep(0)
        try:
            assert hub.connection_count == 1
            assert socket.close_calls == 1
        finally:
            socket.release_close.set()
            await asyncio.gather(actor_close, shutdown_close)

    asyncio.run(scenario())
    assert hub.connection_count == 0


def test_event_hub_shutdown_fails_closed_when_transport_close_cannot_complete() -> None:
    hub = EventHub(max_total=1)
    failed = FakeWebSocket(fail_close=True)
    assert hub.connect("ABC234", ACTOR_A, failed)

    with pytest.raises(RuntimeError, match="did not close"):
        asyncio.run(hub.close_all())

    assert hub.connection_count == 1


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def test_event_hub_presence_waits_one_grace_before_marking_a_member_absent() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    socket = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, socket)
    assert hub.is_present("ABC234", ACTOR_A)

    hub.disconnect("ABC234", socket)
    clock.now += 59
    assert hub.is_present("ABC234", ACTOR_A)
    assert hub.absent_actors("ABC234") == frozenset()

    clock.now += 1
    assert not hub.is_present("ABC234", ACTOR_A)
    assert hub.absent_actors("ABC234") == frozenset({ACTOR_A})
    assert hub.absent_actors("XYZ789") == frozenset()

    # 다시 붙으면 즉시 접속 중이다. 끊긴 시각도 지운다.
    assert hub.connect("ABC234", ACTOR_A, FakeWebSocket())
    assert hub.is_present("ABC234", ACTOR_A)
    assert hub.absent_actors("ABC234") == frozenset()


def test_event_hub_presence_keeps_an_actor_with_another_live_socket() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    first = FakeWebSocket()
    second = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, first)
    assert hub.connect("ABC234", ACTOR_A, second)

    hub.disconnect("ABC234", first)
    clock.now += 120
    assert hub.is_present("ABC234", ACTOR_A)

    hub.disconnect("ABC234", second)
    clock.now += 60
    assert not hub.is_present("ABC234", ACTOR_A)


def test_event_hub_presence_counts_an_unseen_member_from_the_first_question() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)

    # 서버가 다시 뜬 뒤 돌아오지 않는 유령, 막 들어와 아직 소켓을 열지 않은 사람.
    assert hub.is_present("ABC234", ACTOR_B)
    clock.now += 30
    assert hub.is_present("ABC234", ACTOR_B)
    clock.now += 30
    assert not hub.is_present("ABC234", ACTOR_B)

    # 예약만 하고 활성화하지 못한 소켓은 접속으로 세지 않는다.
    pending = FakeWebSocket()
    assert hub.reserve("ABC234", ACTOR_B, pending)
    assert not hub.is_present("ABC234", ACTOR_B)
    hub.disconnect("ABC234", pending)
    assert hub.absent_actors("ABC234") == frozenset({ACTOR_B})


def test_event_hub_presence_sweep_reports_each_change_once() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    socket = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, socket)
    assert hub.connect("XYZ789", ACTOR_B, FakeWebSocket())
    hub.disconnect("ABC234", socket)

    assert hub.sweep_presence() == frozenset()
    clock.now += 61
    assert hub.sweep_presence() == frozenset({"ABC234"})
    assert hub.sweep_presence() == frozenset()

    assert hub.connect("ABC234", ACTOR_A, FakeWebSocket())
    assert hub.sweep_presence() == frozenset({"ABC234"})
    assert hub.sweep_presence() == frozenset()


def test_event_hub_presence_forgets_members_who_left_and_old_records() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    left = FakeWebSocket()
    stale = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, left)
    assert hub.connect("ABC234", ACTOR_B, stale)
    hub.disconnect("ABC234", left)
    hub.disconnect("ABC234", stale)
    clock.now += 61
    assert hub.sweep_presence() == frozenset({"ABC234"})

    hub.forget_presence("ABC234", ACTOR_A)
    assert hub.absent_actors("ABC234") == frozenset({ACTOR_B})
    assert hub.sweep_presence() == frozenset()

    # 30분 정리 뒤에도 남은 오래된 기록은 버린다. 다시 물으면 처음 본 사람처럼 센다.
    clock.now += 3_600
    assert hub.sweep_presence() == frozenset()
    assert hub.absent_actors("ABC234") == frozenset()
    assert hub.is_present("ABC234", ACTOR_B)


def test_event_hub_lists_absent_members_per_room_for_the_sweep() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    first = FakeWebSocket()
    second = FakeWebSocket()
    assert hub.connect("ABC234", ACTOR_A, first)
    assert hub.connect("XYZ789", ACTOR_B, second)
    hub.disconnect("ABC234", first)
    hub.disconnect("XYZ789", second)
    assert hub.absent_by_room() == {}

    clock.now += 60
    assert hub.absent_by_room() == {
        "ABC234": frozenset({ACTOR_A}),
        "XYZ789": frozenset({ACTOR_B}),
    }
    # sweep이 집합 변화를 알린 뒤에도 끊긴 사람이 있는 방은 계속 보인다 (server-1).
    assert hub.sweep_presence() == frozenset({"ABC234", "XYZ789"})
    assert hub.sweep_presence() == frozenset()
    assert set(hub.absent_by_room()) == {"ABC234", "XYZ789"}


def test_event_hub_retains_presence_only_for_current_members() -> None:
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    for actor_id in (ACTOR_A, ACTOR_B):
        socket = FakeWebSocket()
        assert hub.connect("ABC234", actor_id, socket)
        hub.disconnect("ABC234", socket)
    other = FakeWebSocket()
    assert hub.connect("XYZ789", ACTOR_A, other)
    hub.disconnect("XYZ789", other)
    clock.now += 61
    assert hub.sweep_presence() == frozenset({"ABC234", "XYZ789"})

    # 30분 정리가 B를 뺐다. 남은 A의 기록과 다른 방의 기록은 그대로다.
    assert hub.retain_presence("ABC234", frozenset({ACTOR_A})) is True
    assert hub.absent_actors("ABC234") == frozenset({ACTOR_A})
    assert hub.retain_presence("ABC234", frozenset({ACTOR_A})) is False
    # 버린 기록은 다시 붙은 것으로 방송하지 않는다.
    assert hub.sweep_presence() == frozenset()

    # 방이 사라졌으면 그 방의 기록을 모두 버린다.
    assert hub.retain_presence("XYZ789", None) is True
    assert hub.absent_by_room() == {"ABC234": frozenset({ACTOR_A})}
    assert hub.sweep_presence() == frozenset()

    # 다시 들어온 사람은 처음 본 사람처럼 새 유예로 센다.
    assert hub.is_present("ABC234", ACTOR_B)
    hub.forget_presence("ABC234", ACTOR_A)
    assert hub.is_present("ABC234", ACTOR_A)
    assert hub.absent_by_room() == {}


def test_event_hub_rejects_a_non_positive_presence_grace() -> None:
    with pytest.raises(ValueError, match="presence grace"):
        EventHub(presence_grace_seconds=0)
