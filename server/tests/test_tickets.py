from __future__ import annotations

from uuid import UUID

from app.tickets import WebSocketTickets

PLAYER_ID = UUID("12345678-1234-5678-9234-567812345678")


def test_ticket_is_room_bound_single_use_and_expires() -> None:
    now = [1000.0]
    tickets = WebSocketTickets(ttl_seconds=30, clock=lambda: now[0])

    token = tickets.issue(PLAYER_ID, "ABC234")
    assert token not in repr(tickets)
    assert tickets.consume(token, "ZZZ999") is None
    assert tickets.consume(token, "ABC234") is None

    valid = tickets.issue(PLAYER_ID, "ABC234")
    assert tickets.consume(valid, "ABC234") == PLAYER_ID
    assert tickets.consume(valid, "ABC234") is None

    expired = tickets.issue(PLAYER_ID, "ABC234")
    now[0] += 30
    assert tickets.consume(expired, "ABC234") is None
