// 방 소켓을 붙들어 두는 자리 (U24).
//
// 서버는 방 소켓이 없는 참가자를 60초 유예 뒤 «연결 끊김»으로 본다(`main.py`의 EventHub
// presence). 그런데 온라인 최종 순위 화면은 매치 controller를 닫아 소켓이 하나도 없었다.
// 그래서 결과를 1분 넘게 읽는 사람은 아직 방에 있는데도 다음 판의 시작 판정에서 빠지고,
// 방장이면 방장 자리를 다음 사람에게 넘겨 버렸다.
//
// 이 모듈은 그동안 같은 `subscribe` 길로 소켓 하나를 붙든다. 소켓이 열려 있는 것만으로
// 접속 중이고(25초 ping은 저장소가 보낸다), 방 snapshot·이동·채팅은 그리지 않는다.
// **방에서 판이 새로 열렸다는 이벤트만** 넘긴다 — 판에 넣어진 사람이 결과 화면에 남아
// 문제마다 시간 초과를 받지 않게 하려는 것이다. 무효화는 끝난 판에 대한 것이라 무시한다.

import type { RoomEventHandler, Unsubscribe } from './adapter.js';

export interface RoomKeepaliveGateway {
  subscribe(code: string, handler: RoomEventHandler): Unsubscribe;
}

export interface RoomKeepalive {
  /**
   * 이 방의 소켓을 붙든다. 같은 방이면 이미 붙든 소켓을 그대로 두고(다시 열지 않는다),
   * 다른 방이면 먼저 놓는다. `onMatchStarted`는 그 방에서 새 판이 열렸을 때만 부른다.
   */
  hold(code: string, onMatchStarted: (matchId: string | null) => void): void;
  /** 붙든 소켓을 닫는다. 붙든 것이 없으면 아무 일도 하지 않는다. */
  release(): void;
  /** 지금 붙든 방. 없으면 null */
  heldCode(): string | null;
}

export function createRoomKeepalive(gateway: RoomKeepaliveGateway): RoomKeepalive {
  let held: { code: string; unsubscribe: Unsubscribe } | null = null;
  /** 늦게 도착한 이전 hold의 이벤트를 버리는 세대 */
  let generation = 0;
  let onStarted: (matchId: string | null) => void = () => undefined;

  function release(): void {
    generation += 1;
    const current = held;
    held = null;
    current?.unsubscribe();
  }

  return {
    hold(code, onMatchStarted) {
      onStarted = onMatchStarted;
      if (held?.code === code) return;
      release();
      const owned = generation;
      const unsubscribe = gateway.subscribe(code, (event) => {
        if (owned !== generation) return;
        if (event.type === 'match' && event.phase === 'started') onStarted(event.matchId);
      });
      // subscribe 안에서 동기로 이벤트가 와 release가 불렸으면 여기서 정리한다
      if (owned !== generation) {
        unsubscribe();
        return;
      }
      held = { code, unsubscribe };
    },
    release,
    heldCode: () => held?.code ?? null,
  };
}
