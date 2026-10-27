"""방 snapshot의 판 번호 — room-invalidated fan-out 줄이기.

방이 바뀌면 API가 `room-invalidated`를 방 전원에게 보내고 모두가
`GET /v1/rooms/{code}`를 다시 읽는다. 준비 토글이 몰리는 1분에는 이 재조회가 요청의
40%쯤이었다(PR #106 부하 측정). 그래서 방송과 snapshot에 번호를 붙여, 이미 그 번호까지
담은 방을 가진 화면은 다시 읽지 않고, 가장 잦은 준비 토글은 바로 앞 번호의 방을 가진
화면이 GET 없이 고칠 수 있게 한다.

- **번호는 프로세스 전체에서 하나씩 오른다.** 방마다 따로 세지 않는다 — 기록을 버려도
  (가장 오래된 것부터, `max_rooms`) 번호가 뒤로 가지 않는다. 방마다는 «마지막으로 바뀐
  번호»만 둔다
- **snapshot에는 DB를 읽기 전에 읽은 번호(`label`)를 붙인다.** 바꾸는 쪽은 commit 뒤에
  번호를 올리므로 번호 v가 붙은 snapshot은 v까지 알린 변화를 모두 담는다(더 담을 수는
  있다)
- **바꾼 것을 방송하지 않는 변화도 번호를 올린다.** 판 시작(모두의 준비를 되돌린다)은
  `game-started`만 보내고, 30분 정리는 어느 방이 바뀌었는지 모른다 — 앞은 그 방을, 뒤는
  모든 방을(`bump_all`) 올린다. 그래야 다음 준비 토글의 «바로 앞 번호»가 화면이 가진
  번호와 어긋나 화면이 다시 읽는다
- **준비를 바꾸는 쓰기는 방마다 차례로 번호를 받는다** (`writing`). 같은 사람의 준비를 두
  탭이 거의 같이 바꾸거나 준비와 판 시작이 겹치면, commit 순서와 번호 순서가 뒤집혀
  화면이 늦은 값을 덮어쓸 수 있다. DB도 방 행을 잠가 어차피 하나씩 지나가므로 기다림이
  늘지 않는다
- **단일 worker 계약이다** (presence·`RemovedMembers`와 같다). 다시 띄우면 번호가
  처음부터지만 `epoch`이 바뀌어 화면이 예전 번호와 견주지 않는다 — 다른 epoch의 번호는
  «모른다»이고 늘 다시 읽는다. worker를 늘려도 epoch이 서로 달라 화면은 예전처럼 늘 다시
  읽는다(틀리게 건너뛰지 않는다)
"""

from __future__ import annotations

import asyncio
import secrets
from collections import OrderedDict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

# 방마다의 «마지막으로 바뀐 번호» 기록 수. 넘치면 가장 오래 바뀌지 않은 방부터 버리고,
# 버린 번호는 `floor`가 대신 기억한다(그 방의 다음 «바로 앞 번호»가 실제보다 크게 나가
# 화면이 한 번 더 읽을 뿐이다).
MAX_ROOM_VERSIONS = 4_096


class RoomVersions:
    def __init__(
        self,
        *,
        max_rooms: int = MAX_ROOM_VERSIONS,
        epoch: str | None = None,
    ) -> None:
        if max_rooms < 1:
            raise ValueError("room version records must be positive")
        self._max_rooms = max_rooms
        # 화면이 견주는 묶음 이름. 다시 띄우면 바뀐다 (128비트 무작위, URL-safe)
        self._epoch = epoch if epoch is not None else secrets.token_urlsafe(16)
        self._counter = 0
        # 기록이 없는 방의 «마지막으로 바뀐 번호»의 상한. 버린 기록·`bump_all`이 올린다
        self._floor = 0
        self._rooms: OrderedDict[str, int] = OrderedDict()
        self._locks: dict[str, tuple[asyncio.Lock, list[int]]] = {}

    @property
    def epoch(self) -> str:
        return self._epoch

    def label(self) -> int:
        """snapshot에 붙일 번호.

        **DB를 읽기 전에** 읽는다 — 이 번호까지 알린 변화는 이미 commit됐다.
        """
        return self._counter

    def bump(self, code: str) -> tuple[int, int]:
        """그 방이 바뀌었다(commit 뒤에 부른다). (새 번호, 그 방이 바로 앞에 바뀐 번호)."""
        previous = self._rooms.pop(code, self._floor)
        self._counter += 1
        self._rooms[code] = self._counter
        while len(self._rooms) > self._max_rooms:
            _, forgotten = self._rooms.popitem(last=False)
            self._floor = max(self._floor, forgotten)
        return self._counter, previous

    def bump_all(self) -> int:
        """어느 방이 바뀌었는지 모르는 변화(30분 정리).

        모든 방의 «바로 앞 번호»가 이 번호가 된다 — 그 전에 읽은 방에는 준비를 덧대지 못한다.
        """
        self._counter += 1
        self._floor = self._counter
        self._rooms.clear()
        return self._counter

    @asynccontextmanager
    async def writing(self, code: str) -> AsyncIterator[None]:
        """준비를 바꾸는 쓰기(준비·판 시작)를 방마다 하나씩 지나가게 한다.

        그 안에서 commit과 `bump`를 한다.
        """
        entry = self._locks.get(code)
        if entry is None:
            entry = (asyncio.Lock(), [0])
            self._locks[code] = entry
        lock, holders = entry
        holders[0] += 1
        try:
            async with lock:
                yield
        finally:
            holders[0] -= 1
            if holders[0] == 0 and self._locks.get(code) is entry:
                del self._locks[code]
