from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from typing import Any, TypeVar

from argon2 import PasswordHasher
from starlette.concurrency import run_in_threadpool

_Result = TypeVar("_Result")


class PasswordWorkBusy(RuntimeError):
    """Raised before queueing when the bounded password-work envelope is full."""


class BoundedPasswordWork:
    def __init__(
        self,
        *,
        hasher: Any | None = None,
        max_active: int = 2,
        max_inflight: int = 6,
    ) -> None:
        if isinstance(max_active, bool) or not isinstance(max_active, int) or max_active < 1:
            raise ValueError("max_active must be a positive integer")
        if isinstance(max_inflight, bool) or not isinstance(max_inflight, int):
            raise ValueError("max_inflight must be an integer")
        if max_inflight < max_active:
            raise ValueError("max_inflight must be at least max_active")

        self._hasher = hasher or PasswordHasher(
            time_cost=3,
            memory_cost=65_536,
            parallelism=4,
            hash_len=32,
            salt_len=16,
        )
        self._max_active = max_active
        self._max_inflight = max_inflight
        self._active_slots = asyncio.Semaphore(max_active)
        self._admission_lock = threading.Lock()
        self._inflight = 0
        self._jobs: set[asyncio.Task[Any]] = set()

    @property
    def max_active(self) -> int:
        return self._max_active

    @property
    def max_inflight(self) -> int:
        return self._max_inflight

    @property
    def hasher(self) -> Any:
        return self._hasher

    def _admit(self) -> None:
        with self._admission_lock:
            if self._inflight >= self._max_inflight:
                raise PasswordWorkBusy
            self._inflight += 1

    def _release_admission(self) -> None:
        with self._admission_lock:
            self._inflight -= 1
            if self._inflight < 0:  # pragma: no cover - invariant tripwire
                raise RuntimeError("password-work admission counter underflow")

    def _job_finished(self, job: asyncio.Task[Any]) -> None:
        self._jobs.discard(job)
        if not job.cancelled():
            job.exception()

    async def _run(self, operation: Callable[..., _Result], *args: str) -> _Result:
        self._admit()
        try:
            await self._active_slots.acquire()
        except BaseException:
            self._release_admission()
            raise

        async def execute() -> _Result:
            try:
                return await run_in_threadpool(operation, *args)
            finally:
                self._active_slots.release()
                self._release_admission()

        try:
            job = asyncio.create_task(execute())
        except BaseException:
            self._active_slots.release()
            self._release_admission()
            raise
        self._jobs.add(job)
        job.add_done_callback(self._job_finished)
        return await asyncio.shield(job)

    async def hash(self, password: str) -> str:
        return await self._run(self._hasher.hash, password)

    async def verify(self, encoded: str, password: str) -> bool:
        return await self._run(self._hasher.verify, encoded, password)
