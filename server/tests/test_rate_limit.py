from __future__ import annotations

import time

import pytest

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


def test_atomic_multi_window_reports_when_every_exhausted_claim_frees_a_slot() -> None:
    now = [100.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    player = RateLimitClaim(key="player", limit=2, window_seconds=60)
    address = RateLimitClaim(key="address", limit=3, window_seconds=10)

    assert limiter.try_acquire((player, address)) is None
    now[0] = 104.0
    assert limiter.try_acquire((player, address)) is None
    now[0] = 105.0
    # player는 100초의 첫 시도가 160초에 빠져야 자리가 난다 (Retry-After의 정직한 값)
    assert limiter.try_acquire((player, address)) == 55.0
    assert limiter.allow((player, address)) is False

    # 두 claim이 함께 막히면 둘 다 풀릴 때까지 기다려야 한다
    assert limiter.try_acquire((address,)) is None
    now[0] = 106.0
    assert limiter.try_acquire((address,)) == 4.0
    assert limiter.try_acquire((player, address)) == 54.0

    now[0] = 160.01
    assert limiter.try_acquire((player, address)) is None


def test_atomic_multi_window_rejection_with_wait_consumes_nothing() -> None:
    now = [0.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    strict = RateLimitClaim(key="strict", limit=1, window_seconds=30)
    shared = RateLimitClaim(key="shared", limit=2, window_seconds=30)

    assert limiter.try_acquire((strict, shared)) is None
    assert limiter.try_acquire((strict, shared)) == 30.0
    # 거절은 shared를 먹지 않았다 — 한 자리가 그대로 남아 있다
    assert limiter.try_acquire((shared,)) is None
    assert limiter.try_acquire((shared,)) == 30.0


def _fill_with_attacker_keys(limiter: AtomicMultiWindowLimiter, count: int) -> RateLimitClaim:
    """한 번씩만 들어온 열쇠 `count`개와, 그것으로 가득 찬 프로세스 몫을 남긴다."""
    process = RateLimitClaim(key="process", limit=count, window_seconds=60)
    for index in range(count):
        assert limiter.allow(
            (RateLimitClaim(key=f"player:{index}", limit=120, window_seconds=60), process)
        )
    return process


def test_atomic_multi_window_rejections_do_not_sweep_every_retained_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # N01 리뷰 security-3: 사람마다의 열쇠(player id + 토큰 해시)는 공격자가 수천 개로 늘릴 수 있다.
    # 거절을 포함한 모든 호출이 남은 열쇠를 다 훑으면 호출 한 번의 값이 열쇠 수에 비례한다
    now = [0.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    process = _fill_with_attacker_keys(limiter, 3_000)
    sweeps = 0
    full_prune = limiter._prune

    def counting_prune(at: float) -> None:
        nonlocal sweeps
        sweeps += 1
        full_prune(at)

    monkeypatch.setattr(limiter, "_prune", counting_prune)
    for index in range(1_000):
        now[0] = index * 0.0005
        assert (
            limiter.try_acquire(
                (RateLimitClaim(key=f"forged:{index}", limit=120, window_seconds=60), process)
            )
            is not None
        )

    # 0.5초 동안의 거절 1,000번에 전체 정리는 많아야 한 번이다
    assert sweeps <= 1


def test_atomic_multi_window_touched_claims_expire_between_sweeps() -> None:
    now = [0.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    short = RateLimitClaim(key="short", limit=1, window_seconds=0.5)

    assert limiter.try_acquire((short,)) is None
    now[0] = 0.4
    assert limiter.try_acquire((short,)) == pytest.approx(0.1)
    # 전체 정리 간격(1초) 안이어도 지금 묻는 claim은 제 창을 지난 시도를 버린다
    now[0] = 0.6
    assert limiter.try_acquire((short,)) is None


def test_atomic_multi_window_untouched_keys_are_still_reclaimed() -> None:
    # 메모리는 그대로 묶인다 — 다시 묻지 않는 열쇠도 창 + 정리 간격 안에 사라진다
    now = [0.0]
    limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
    for index in range(50):
        assert limiter.allow((RateLimitClaim(key=f"once:{index}", limit=1, window_seconds=10),))
    assert len(limiter._attempts) == 50

    now[0] = 10.5
    assert limiter.allow((RateLimitClaim(key="fresh", limit=1, window_seconds=10),))
    assert len(limiter._attempts) == 1
    assert limiter.retained_key_count == 1


def test_atomic_multi_window_rejection_cost_does_not_scale_with_retained_keys() -> None:
    # 거칠게 잰다: 남은 열쇠가 3,000개여도 거절 한 번의 값은 열쇠가 둘일 때와 비슷해야 한다.
    # 고치기 전에는 약 100배였다. 잡음(GC·스케줄링)에 흔들리지 않게 다섯 번 중 가장 빠른 값을 쓴다
    def best_rejection_seconds(retained: int) -> float:
        now = [0.0]
        limiter = AtomicMultiWindowLimiter(clock=lambda: now[0])
        process = _fill_with_attacker_keys(limiter, retained)
        claims = (RateLimitClaim(key="forged", limit=120, window_seconds=60), process)
        assert limiter.try_acquire(claims) is not None
        best = float("inf")
        for _ in range(5):
            started = time.perf_counter()
            for _ in range(2_000):
                limiter.try_acquire(claims)
            best = min(best, time.perf_counter() - started)
        return best

    small = best_rejection_seconds(2)
    large = best_rejection_seconds(3_000)
    assert large < small * 10, (small, large)
