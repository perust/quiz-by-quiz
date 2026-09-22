// 대기실 재접속 복구.
//
// WebSocket은 상태 그 자체가 아니라 «다시 읽어야 한다»는 신호다. 아래 함수는
// 인증된 REST snapshot만으로 진행 중인 판 진입을 결정한다. 브라우저 자체 판으로
// 돌아가거나 끝난 판을 다시 열지 않는다.

import type { OnlineMatchSnapshot } from './adapter.js';

export interface ActiveNetworkMatchRecoveryDeps {
  getMatch(code: string): Promise<OnlineMatchSnapshot | null>;
  /** Whether this is still the room/screen that asked for recovery. */
  isStillCurrent(): boolean;
  /** Another recovery/event may already have opened the match controller. */
  hasOpenMatch(): boolean;
  openMatch(code: string): Promise<void>;
}

/**
 * A waiting-room entry can outlive its REST request. A later navigation or a
 * match opened by another event must win over that stale continuation.
 */
export interface WaitingRoomEntryState {
  code: string;
  activeRoomCode: string | null;
  onlineMatchRoomCode: string | null;
  entryGeneration: number;
  currentGeneration: number;
}

/** Whether an awaited waiting-room entry still owns the visible destination. */
export function isCurrentWaitingRoomEntry({
  code,
  activeRoomCode,
  onlineMatchRoomCode,
  entryGeneration,
  currentGeneration,
}: WaitingRoomEntryState): boolean {
  return activeRoomCode === code
    && onlineMatchRoomCode === null
    && entryGeneration === currentGeneration;
}

/**
 * Recover an in-progress server match after a waiting-room socket invalidation.
 *
 * `false` intentionally leaves the user in the waiting room: terminal,
 * missing, stale, and transport-failure states must not invent a local match
 * or move the browser based on an unverified event.
 */
export async function recoverActiveNetworkMatch(
  code: string,
  { getMatch, isStillCurrent, hasOpenMatch, openMatch }: ActiveNetworkMatchRecoveryDeps,
): Promise<boolean> {
  try {
    const match = await getMatch(code);
    if (!isStillCurrent() || hasOpenMatch() || match === null || match.state === 'finished') {
      return false;
    }
    await openMatch(code);
    return true;
  } catch {
    return false;
  }
}
