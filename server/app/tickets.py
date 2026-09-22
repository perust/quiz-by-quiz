from __future__ import annotations

import hashlib
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True)
class _Ticket:
    player_id: UUID
    room_code: str
    expires_at: float


class WebSocketTickets:
    """Short-lived, single-use tickets so bearer tokens never enter WebSocket URLs."""

    def __init__(
        self,
        *,
        ttl_seconds: int = 30,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._tickets: dict[bytes, _Ticket] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _digest(token: str) -> bytes:
        return hashlib.sha256(token.encode("utf-8")).digest()

    def issue(self, player_id: UUID, room_code: str) -> str:
        token = secrets.token_urlsafe(32)
        now = self._clock()
        with self._lock:
            self._prune(now)
            self._tickets[self._digest(token)] = _Ticket(
                player_id=player_id,
                room_code=room_code,
                expires_at=now + self._ttl_seconds,
            )
        return token

    def consume(self, token: str, room_code: str) -> UUID | None:
        if not token:
            return None
        digest = self._digest(token)
        now = self._clock()
        with self._lock:
            self._prune(now)
            ticket = self._tickets.pop(digest, None)
            if ticket is None or ticket.room_code != room_code:
                return None
            return ticket.player_id

    def _prune(self, now: float) -> None:
        expired = [digest for digest, ticket in self._tickets.items() if ticket.expires_at <= now]
        for digest in expired:
            self._tickets.pop(digest, None)
