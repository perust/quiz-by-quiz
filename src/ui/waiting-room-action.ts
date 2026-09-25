import type { PublicRoom } from '../online/adapter.js';

export interface WaitingRoomActionOwnership {
  request: number;
  code: string;
  snapshot: PublicRoom;
}

export interface WaitingRoomActionState {
  request: number | null;
  room: PublicRoom | null;
}

export interface WaitingRoomControls {
  readyDisabled: boolean;
  startHidden: boolean;
  startDisabled: boolean;
}

/** 역할과 server 시작 조건을 그대로 반영한 대기실 CTA 상태. */
export function waitingRoomControls(room: PublicRoom, playerId: string): WaitingRoomControls {
  const me = room.players.find((player) => player.id === playerId) ?? null;
  const readyDisabled = !room.joined || me === null;
  const canStart = room.isMine
    && !readyDisabled
    && room.players.length >= 2
    && room.players.every((player) => player.isReady);

  return {
    readyDisabled,
    startHidden: !room.isMine,
    startDisabled: !canStart,
  };
}

/**
 * An awaited action may mutate the waiting-room UI only while the show request
 * and room still belong to it. Snapshot identity also prevents an old REST
 * response from replacing a newer subscription snapshot from the same room.
 */
export function isCurrentWaitingRoomAction(
  action: WaitingRoomActionOwnership,
  state: WaitingRoomActionState,
  requireSameSnapshot = true,
): boolean {
  return state.request === action.request
    && state.room?.code === action.code
    && (!requireSameSnapshot || state.room === action.snapshot);
}
