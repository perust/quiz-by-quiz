from __future__ import annotations

import asyncio
import threading

import pytest

from app.password_work import BoundedPasswordWork, PasswordWorkBusy


class BlockingHasher:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._release = threading.Event()
        self.first_entered = threading.Event()
        self.two_entered = threading.Event()
        self.finished = threading.Event()
        self.calls = 0
        self.active = 0
        self.max_active = 0

    def _run(self, result: object) -> object:
        with self._lock:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.first_entered.set()
            if self.calls >= 2:
                self.two_entered.set()
        try:
            if not self._release.wait(timeout=5):
                raise TimeoutError("test did not release blocking password operation")
            return result
        finally:
            with self._lock:
                self.active -= 1
                self.finished.set()

    def hash(self, password: str) -> str:
        return str(self._run(f"hash:{password}"))

    def verify(self, encoded: str, password: str) -> bool:
        return bool(self._run(encoded == f"hash:{password}"))

    def release(self) -> None:
        self._release.set()


def test_password_work_runs_at_most_two_argon_jobs() -> None:
    async def exercise() -> None:
        hasher = BlockingHasher()
        work = BoundedPasswordWork(hasher=hasher, max_active=2, max_inflight=6)
        tasks = [
            asyncio.create_task(work.hash("alpha")),
            asyncio.create_task(work.verify("hash:bravo", "bravo")),
            asyncio.create_task(work.hash("charlie")),
            asyncio.create_task(work.verify("hash:delta", "delta")),
            asyncio.create_task(work.hash("echo")),
            asyncio.create_task(work.verify("hash:foxtrot", "foxtrot")),
        ]
        try:
            entered = await asyncio.to_thread(hasher.two_entered.wait, 2)
            assert entered, "two worker threads did not enter the fake hasher"
            await asyncio.sleep(0.05)
            assert hasher.calls == 2
            assert hasher.max_active == 2
        finally:
            hasher.release()
            await asyncio.gather(*tasks, return_exceptions=True)

        assert hasher.calls == 6
        assert hasher.max_active == 2

    asyncio.run(exercise())


def test_password_work_rejects_the_seventh_admitted_job_without_queueing() -> None:
    async def exercise() -> None:
        hasher = BlockingHasher()
        work = BoundedPasswordWork(hasher=hasher, max_active=2, max_inflight=6)
        tasks = [asyncio.create_task(work.hash(str(index))) for index in range(6)]
        try:
            assert await asyncio.to_thread(hasher.two_entered.wait, 2)
            for _ in range(6):
                await asyncio.sleep(0)
            with pytest.raises(PasswordWorkBusy):
                await work.hash("overflow")
            assert hasher.calls == 2
        finally:
            hasher.release()
            results = await asyncio.gather(*tasks)

        assert results == [f"hash:{index}" for index in range(6)]
        assert hasher.max_active == 2

    asyncio.run(exercise())


def test_password_work_cancelling_a_waiter_returns_admission_capacity() -> None:
    async def exercise() -> None:
        hasher = BlockingHasher()
        work = BoundedPasswordWork(hasher=hasher, max_active=1, max_inflight=2)
        active = asyncio.create_task(work.hash("active"))
        assert await asyncio.to_thread(hasher.first_entered.wait, 2)
        waiter = asyncio.create_task(work.hash("cancelled"))
        for _ in range(4):
            await asyncio.sleep(0)

        with pytest.raises(PasswordWorkBusy):
            await work.hash("full-before-cancel")

        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter

        replacement = asyncio.create_task(work.hash("replacement"))
        for _ in range(4):
            await asyncio.sleep(0)
        with pytest.raises(PasswordWorkBusy):
            await work.hash("full-after-replacement")

        hasher.release()
        assert await active == "hash:active"
        assert await replacement == "hash:replacement"
        assert hasher.calls == 2
        assert hasher.max_active == 1

    asyncio.run(exercise())


def test_password_work_cancelling_active_job_keeps_capacity_until_thread_finishes() -> None:
    async def exercise() -> None:
        hasher = BlockingHasher()
        work = BoundedPasswordWork(hasher=hasher, max_active=1, max_inflight=1)
        active = asyncio.create_task(work.hash("active"))
        assert await asyncio.to_thread(hasher.first_entered.wait, 2)

        active.cancel()
        replacement = asyncio.create_task(work.hash("replacement"))
        try:
            await asyncio.sleep(0.05)
            assert hasher.calls == 1
        finally:
            hasher.release()

        with pytest.raises(asyncio.CancelledError):
            await active
        with pytest.raises(PasswordWorkBusy):
            await replacement
        assert await asyncio.to_thread(hasher.finished.wait, 2)
        for _ in range(4):
            await asyncio.sleep(0)
        assert hasher.max_active == 1
        assert await work.hash("after-cancellation") == "hash:after-cancellation"

    asyncio.run(exercise())


def test_password_work_returns_capacity_after_hasher_exception() -> None:
    class FlakyHasher:
        def __init__(self) -> None:
            self.calls = 0

        def hash(self, password: str) -> str:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("injected hasher failure")
            return f"recovered:{password}"

        def verify(self, encoded: str, password: str) -> bool:
            return encoded == password

    async def exercise() -> None:
        hasher = FlakyHasher()
        work = BoundedPasswordWork(hasher=hasher, max_active=1, max_inflight=1)
        with pytest.raises(RuntimeError, match="injected hasher failure"):
            await work.hash("first")
        assert await work.hash("second") == "recovered:second"

    asyncio.run(exercise())


def test_password_work_passes_through_hash_and_verify_results() -> None:
    class RecordingHasher:
        def hash(self, password: str) -> str:
            return f"encoded:{password}"

        def verify(self, encoded: str, password: str) -> bool:
            return encoded == f"encoded:{password}"

    async def exercise() -> None:
        work = BoundedPasswordWork(hasher=RecordingHasher())
        assert await work.hash("secret") == "encoded:secret"
        assert await work.verify("encoded:secret", "secret") is True
        assert await work.verify("encoded:other", "secret") is False

    asyncio.run(exercise())


def test_password_work_pins_the_deployed_argon2_profile_and_bounds() -> None:
    work = BoundedPasswordWork()

    assert work.max_active == 2
    assert work.max_inflight == 6
    assert work.hasher.time_cost == 3
    assert work.hasher.memory_cost == 65_536
    assert work.hasher.parallelism == 4
    assert work.hasher.hash_len == 32
    assert work.hasher.salt_len == 16


@pytest.mark.parametrize(
    ("max_active", "max_inflight"),
    [(0, 1), (True, 1), (2, 1), (1, False)],
)
def test_password_work_rejects_invalid_bounds(max_active: int, max_inflight: int) -> None:
    with pytest.raises(ValueError):
        BoundedPasswordWork(max_active=max_active, max_inflight=max_inflight)
