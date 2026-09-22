from __future__ import annotations

from app.rate_limit import (
    AtomicMultiWindowLimiter,
    MinimumIntervalGate,
    RateLimitClaim,
    SlidingWindowLimiter,
)


def test_sliding_window_rejects_only_after_limit_and_recovers() -> None:
    now = [100.0]
    limiter = SlidingWindowLimiter(limit=3, window_seconds=10, clock=lambda: now[0])

    assert limiter.allow("browser") is True
    assert limiter.allow("browser") is True
    assert limiter.allow("browser") is True
    assert limiter.allow("browser") is False
    assert limiter.allow("other-browser") is True

    now[0] = 110.01
    assert limiter.allow("browser") is True


def test_rejected_attempt_does_not_extend_the_window() -> None:
    now = [0.0]
    limiter = SlidingWindowLimiter(limit=1, window_seconds=5, clock=lambda: now[0])

    assert limiter.allow("key") is True
    now[0] = 4.0
    assert limiter.allow("key") is False
    now[0] = 5.01
    assert limiter.allow("key") is True


def test_sliding_window_reclaims_expired_suffix_behind_live_prefix() -> None:
    now = [0.0]
    limiter = SlidingWindowLimiter(limit=10, window_seconds=10, clock=lambda: now[0])

    for index in range(64):
        assert limiter.allow(f"live:{index}")
    assert limiter.allow("stale:a")
    assert limiter.allow("stale:b")

    now[0] = 9.0
    for index in range(64):
        assert limiter.allow(f"live:{index}")

    now[0] = 11.0
    assert limiter.allow("trigger")
    assert limiter.retained_key_count == 65


def test_minimum_interval_gate_allows_one_immediate_heartbeat_then_throttles() -> None:
    now = [100.0]
    gate = MinimumIntervalGate(interval_seconds=15, clock=lambda: now[0])

    assert gate.allow() is True
    assert gate.allow() is False
    now[0] = 114.9
    assert gate.allow() is False
    now[0] = 115.0
    assert gate.allow() is True


def test_atomic_multi_window_rejects_without_partial_consumption() -> None:
    now = [100.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    strict = RateLimitClaim(key="strict", limit=1, window_seconds=60)
    permissive = RateLimitClaim(key="permissive", limit=2, window_seconds=60)

    assert limiter.allow((strict, permissive)) is True
    assert limiter.allow((strict, permissive)) is False

    # The rejected compound check must not consume the permissive bucket.
    assert limiter.allow((permissive,)) is True
    assert limiter.allow((permissive,)) is False


def test_atomic_multi_window_expires_each_window_independently() -> None:
    now = [0.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    short = RateLimitClaim(key="short", limit=1, window_seconds=5)
    long = RateLimitClaim(key="long", limit=2, window_seconds=20)

    assert limiter.allow((short, long)) is True
    assert limiter.allow((short, long)) is False

    now[0] = 5.01
    assert limiter.allow((short, long)) is True

    now[0] = 10.02
    assert limiter.allow((short, long)) is False

    now[0] = 20.01
    assert limiter.allow((short, long)) is True


def test_atomic_multi_window_reclaims_stale_keys() -> None:
    now = [0.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])

    for index in range(50):
        assert limiter.allow(
            (RateLimitClaim(key=f"client:{index}", limit=1, window_seconds=10),)
        )
    assert limiter.retained_key_count == 50

    now[0] = 10.01
    assert limiter.allow((RateLimitClaim(key="fresh", limit=1, window_seconds=10),))
    assert limiter.retained_key_count == 1


def test_atomic_multi_window_rejected_unique_keys_do_not_grow_state() -> None:
    now = [0.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    global_claim = RateLimitClaim(key="process", limit=1, window_seconds=60)

    assert limiter.allow(
        (
            RateLimitClaim(key="client:accepted", limit=60, window_seconds=60),
            global_claim,
        )
    )
    retained_after_accept = limiter.retained_key_count

    for index in range(1_000):
        assert (
            limiter.allow(
                (
                    RateLimitClaim(
                        key=f"client:rejected:{index}",
                        limit=60,
                        window_seconds=60,
                    ),
                    global_claim,
                )
            )
            is False
        )

    assert limiter.retained_key_count == retained_after_accept
