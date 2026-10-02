// 대기실 가구의 논리 좌석과 워커 배치 좌표.
//
// 테이블은 장식이고 실제로 앉을 수 있는 자리만 이 목록에 둔다. DOM과 상태는
// 문자열을 임의로 믿지 않고 이 좁은 목록을 통해서만 오간다.

import {
  isWaitingRoomSeatId,
  WAITING_ROOM_SEAT_IDS,
  type WaitingRoomSeatId,
} from '../online/movement-contract.js';
import type { Point } from './walker.js';

export {
  isWaitingRoomSeatId,
  WAITING_ROOM_SEAT_IDS,
  type WaitingRoomSeatId,
};

/** 같은 자리를 다시 고르면 일어서고, 다른 자리를 고르면 그쪽으로 옮겨 앉는다. */
export function nextWaitingRoomSeat(
  current: WaitingRoomSeatId | null,
  requested: WaitingRoomSeatId,
): WaitingRoomSeatId | null {
  return current === requested ? null : requested;
}

export interface WaitingRoomSeatClaim {
  playerId: string;
  seatId: WaitingRoomSeatId;
}

/**
 * 동시에 같은 자리를 고른 browser들도 같은 결론을 내리도록 player id 순으로 고른다.
 * server가 좌석 상태를 저장하지 않아도 승자가 결정되고, 진 쪽은 즉시 standing frame을 보낸다.
 */
export function waitingRoomSeatWinner(
  seatId: WaitingRoomSeatId,
  claims: readonly WaitingRoomSeatClaim[],
): string | null {
  let winner: string | null = null;
  for (const claim of claims) {
    if (claim.seatId !== seatId || !claim.playerId) continue;
    if (winner === null || claim.playerId < winner) winner = claim.playerId;
  }
  return winner;
}

export interface WaitingRoomSeatLeaseController {
  /** 유효한 seated heartbeat마다 만료 시각을 뒤로 민다. */
  refresh(playerId: string): void;
  /** standing frame 또는 퇴장 snapshot이 오면 만료 예약을 없앤다. */
  clear(playerId: string): void;
  /** 현재 room snapshot에 없는 참가자의 예약만 지운다. */
  retain(playerIds: ReadonlySet<string>): void;
  /** 화면·방 수명이 끝날 때 모든 예약을 지운다. */
  reset(): void;
}

interface WaitingRoomSeatLeaseOptions {
  staleMs: number;
  onExpire: (playerId: string) => void;
  schedule?: (callback: () => void, delay: number) => number;
  cancel?: (timer: number) => void;
}

/**
 * seat claim은 room snapshot에 저장하지 않는 realtime lease다. 종료 frame 없이 tab이
 * 죽어도 영구 점유가 남지 않게 하고, 교체된 timer callback은 token 비교로 무시한다.
 */
export function createWaitingRoomSeatLeaseController({
  staleMs,
  onExpire,
  schedule = (callback, delay) => window.setTimeout(callback, delay),
  cancel = (timer) => window.clearTimeout(timer),
}: WaitingRoomSeatLeaseOptions): WaitingRoomSeatLeaseController {
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new RangeError('staleMs must be positive');
  const timers = new Map<string, number>();

  const clear = (playerId: string): void => {
    const timer = timers.get(playerId);
    if (timer === undefined) return;
    timers.delete(playerId);
    cancel(timer);
  };

  return {
    refresh(playerId) {
      clear(playerId);
      let timer = 0;
      timer = schedule(() => {
        if (timers.get(playerId) !== timer) return;
        timers.delete(playerId);
        onExpire(playerId);
      }, staleMs);
      timers.set(playerId, timer);
    },

    clear,

    retain(playerIds) {
      for (const playerId of timers.keys()) {
        if (!playerIds.has(playerId)) clear(playerId);
      }
    },

    reset() {
      for (const playerId of [...timers.keys()]) clear(playerId);
    },
  };
}

/**
 * screen walker는 보이는 몸통 가운데로 버튼을 고른다. 좌석 버튼의 가운데와
 * 몸통 가운데를 맞추려면 논리적 발끝은 몸통 높이의 절반만큼 아래에 있어야 한다.
 * 숨은 화면의 0px 좌석은 배치하지 않고, 화면이 열린 뒤 다시 잰다.
 */
export function waitingRoomSeatPoint(
  box: Readonly<{ left: number; top: number; width: number; height: number }>,
  characterHeight: number,
): Point | null {
  if (
    !Number.isFinite(box.left)
    || !Number.isFinite(box.top)
    || !Number.isFinite(box.width)
    || !Number.isFinite(box.height)
    || !Number.isFinite(characterHeight)
    || box.width <= 0
    || box.height <= 0
    || characterHeight <= 0
  ) return null;

  // 착석 pose는 몸통을 발끝 기준으로 낮게 압축한다. 논리 좌표를 그대로 좌석
  // 가운데에 두면 압축된 몸이 의자 다리 앞까지 내려오므로 높이의 3/8만큼 올린다.
  const seatedRise = characterHeight * 3 / 8;
  return {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2 + characterHeight / 2 - seatedRise,
  };
}
