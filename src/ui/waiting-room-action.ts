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
