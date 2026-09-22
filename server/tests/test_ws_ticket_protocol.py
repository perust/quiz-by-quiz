from __future__ import annotations

from typing import Any, cast

from starlette.datastructures import Headers

from app.main import _websocket_ticket

TOKEN = "A" * 43


class HeaderOnlyWebSocket:
    def __init__(self, *protocol_fields: str) -> None:
        self.headers = Headers(
            raw=[
                (b"sec-websocket-protocol", value.encode("ascii"))
                for value in protocol_fields
            ]
        )


def parse(*protocol_fields: str) -> str | None:
    return _websocket_ticket(cast(Any, HeaderOnlyWebSocket(*protocol_fields)))


def test_websocket_ticket_requires_exact_public_and_ticket_protocols() -> None:
    assert parse(f"qbb.v1, qbb.ticket.{TOKEN}") == TOKEN
    assert parse(f"qbb.ticket.{TOKEN}, qbb.v1") == TOKEN
    assert parse("qbb.v1", f"qbb.ticket.{TOKEN}") == TOKEN

    assert parse(f"qbb.v1, qbb.ticket.{TOKEN}, extra.protocol") is None
    assert parse(f"qbb.v1, qbb.ticket.{TOKEN}", "extra.protocol") is None
    assert parse(f"qbb.v1, qbb.v1, qbb.ticket.{TOKEN}") is None
    assert parse(f"qbb.v1, qbb.ticket.{TOKEN}, qbb.ticket.{TOKEN}") is None
    assert parse(f"qbb.ticket.{TOKEN}") is None
    assert parse("qbb.v1") is None


def test_websocket_ticket_rejects_non_base64url_ticket_bytes() -> None:
    assert parse(f"qbb.v1, qbb.ticket.{'A' * 42}=") is None
    assert parse("qbb.v1, qbb.ticket.too-short") is None
