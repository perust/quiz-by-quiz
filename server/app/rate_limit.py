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


# 남은 열쇠를 모두 훑는 정리는 많아야 이만큼에 한 번이다 (N01 리뷰 security-3). 한 호출은 제가
# 묻는 claim만 정리한다 — 사람마다의 열쇠는 공격자가 수천 개로 늘릴 수 있어, 거절까지 모든 호출이
# 다 훑으면 호출 한 번의 값이 열쇠 수에 비례했다(3,000개에서 약 150배). 메모리는 그대로 묶인다:
# 다시 묻지 않는 열쇠도 제 창 + 이 간격 안에 사라진다.
FULL_SWEEP_INTERVAL_SECONDS = 1.0


class AtomicMultiWindowLimiter:
    """Consume several sliding-window claims as one all-or-none operation."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._attempts: dict[RateLimitClaim, deque[float]] = {}
        self._lock = threading.Lock()
        self._last_sweep = float("-inf")

    def _prune(self, now: float) -> None:
        for claim, attempts in tuple(self._attempts.items()):
            cutoff = now - claim.window_seconds
            while attempts and attempts[0] <= cutoff:
                attempts.popleft()
            if not attempts:
                del self._attempts[claim]
        self._last_sweep = now

    def _live_attempts(self, claim: RateLimitClaim, now: float) -> deque[float] | None:
        """이 claim의 창 안에 남은 시도. 창을 지난 것은 지금 버린다(없으면 열쇠째)."""
        attempts = self._attempts.get(claim)
        if attempts is None:
            return None
        cutoff = now - claim.window_seconds
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if not attempts:
            del self._attempts[claim]
            return None
        return attempts

    def try_acquire(self, claims: tuple[RateLimitClaim, ...]) -> float | None:
        """Consume every claim or none of them.

        Returns ``None`` when admitted. Otherwise nothing is consumed and the result is the
        number of seconds until every exhausted claim frees a slot — the honest value for an
        HTTP ``Retry-After`` hint (a sliding window frees the slot of its oldest live attempt).
        """
        unique_claims = tuple(dict.fromkeys(claims))
        now = self._clock()
        with self._lock:
            if now - self._last_sweep >= FULL_SWEEP_INTERVAL_SECONDS:
                self._prune(now)
            blocked = False
            wait = 0.0
            for claim in unique_claims:
                attempts = self._live_attempts(claim, now)
                if attempts is None or len(attempts) < claim.limit:
                    continue
                blocked = True
                # Rejections never append, so a full bucket holds exactly `limit` attempts and
                # frees a slot once the oldest of them leaves the window.
                oldest = attempts[len(attempts) - claim.limit]
                wait = max(wait, oldest + claim.window_seconds - now)
            if blocked:
                return wait
            for claim in unique_claims:
                self._attempts.setdefault(claim, deque()).append(now)
            return None

    def allow(self, claims: tuple[RateLimitClaim, ...]) -> bool:
        return self.try_acquire(claims) is None

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
