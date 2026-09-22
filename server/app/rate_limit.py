from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from math import isfinite


@dataclass(frozen=True, slots=True)
class RateLimitClaim:
    key: str
    limit: int
    window_seconds: float

    def __post_init__(self) -> None:
        if not self.key:
            raise ValueError("rate limit key must not be empty")
        if isinstance(self.limit, bool) or self.limit <= 0:
            raise ValueError("rate limit must be a positive integer")
        if not isfinite(self.window_seconds) or self.window_seconds <= 0:
            raise ValueError("rate limit window must be positive and finite")


class AtomicMultiWindowLimiter:
    """Consume several sliding-window claims as one all-or-none operation."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._attempts: dict[RateLimitClaim, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        for claim, attempts in tuple(self._attempts.items()):
            cutoff = now - claim.window_seconds
            while attempts and attempts[0] <= cutoff:
                attempts.popleft()
            if not attempts:
                del self._attempts[claim]

    def allow(self, claims: tuple[RateLimitClaim, ...]) -> bool:
        unique_claims = tuple(dict.fromkeys(claims))
        now = self._clock()
        with self._lock:
            self._prune(now)
            if any(
                len(self._attempts.get(claim, ())) >= claim.limit
                for claim in unique_claims
            ):
                return False
            for claim in unique_claims:
                self._attempts.setdefault(claim, deque()).append(now)
            return True

    @property
    def retained_key_count(self) -> int:
        now = self._clock()
        with self._lock:
            self._prune(now)
            return len(self._attempts)


class SlidingWindowLimiter:
    def __init__(
        self,
        *,
        limit: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if limit < 1 or window_seconds <= 0:
            raise ValueError("rate limit and window must be positive")
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._attempts: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        cutoff = now - self._window
        for stale_key, attempts in tuple(self._attempts.items()):
            while attempts and attempts[0] <= cutoff:
                attempts.popleft()
            if not attempts:
                del self._attempts[stale_key]

    def allow(self, key: str) -> bool:
        now = self._clock()
        with self._lock:
            self._prune(now)
            attempts = self._attempts.setdefault(key, deque())
            if len(attempts) >= self._limit:
                return False
            attempts.append(now)
            return True

    @property
    def retained_key_count(self) -> int:
        now = self._clock()
        with self._lock:
            self._prune(now)
            return len(self._attempts)


class MinimumIntervalGate:
    """Permits the first event, then one event per minimum interval."""

    def __init__(
        self,
        *,
        interval_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if interval_seconds <= 0:
            raise ValueError("minimum interval must be positive")
        self._interval = interval_seconds
        self._clock = clock
        self._last_allowed: float | None = None

    def allow(self) -> bool:
        now = self._clock()
        if self._last_allowed is not None and now - self._last_allowed < self._interval:
            return False
        self._last_allowed = now
        return True
