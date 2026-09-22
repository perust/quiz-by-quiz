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
