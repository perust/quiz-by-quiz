// 대기실 재접속 복구.
//
// WebSocket은 상태 그 자체가 아니라 «다시 읽어야 한다»는 신호다. 아래 함수는
// 인증된 REST snapshot만으로 진행 중인 판 진입을 결정한다. 브라우저 자체 판으로
// 돌아가거나 끝난 판을 다시 열지 않는다.

import type { OnlineMatchSnapshot } from './adapter.js';
import { rateLimitRetryDelayMs } from './rules.js';

export interface ActiveNetworkMatchRecoveryDeps {
  getMatch(code: string): Promise<OnlineMatchSnapshot | null>;
  /** Whether this is still the room/screen that asked for recovery. */
  isStillCurrent(): boolean;
  /** Another recovery/event may already have opened the match controller. */
  hasOpenMatch(): boolean;
  openMatch(code: string): Promise<void>;
  /** 요청 한도(429)에 걸린 GET을 다시 보내기 전의 기다림과 jitter (N01). 테스트가 가짜 시계를 넣는다 */
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

function browserSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
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
 *
 * 요청 한도(429)에 걸린 GET은 match controller와 같이 Retry-After(상한 약 3초)와 jitter를 두고 **한 번만**
 * 다시 보낸다 (N01 리뷰 client-retry-5). 넘어가지 않은 답은 방송하지 않으므로 여기서 버리면 다음 phase
 * 방송까지(문항 하나 20–40초) 대기실에 남아 그 문항을 놓친다. 기다린 뒤 이 화면이 아직 복구를 원하는지
 * 다시 본다 — 그사이 화면을 옮겼거나 다른 길로 판이 열렸으면 보내지 않는다.
 */
export async function recoverActiveNetworkMatch(
  code: string,
  {
    getMatch,
    isStillCurrent,
    hasOpenMatch,
    openMatch,
    sleep = browserSleep,
    random = Math.random,
  }: ActiveNetworkMatchRecoveryDeps,
): Promise<boolean> {
  try {
    let match: OnlineMatchSnapshot | null;
    try {
      match = await getMatch(code);
    } catch (error) {
      const delayMs = rateLimitRetryDelayMs(error, random);
      if (delayMs === null) return false;
      await sleep(delayMs);
      if (!isStillCurrent() || hasOpenMatch()) return false;
      match = await getMatch(code);
    }
    if (!isStillCurrent() || hasOpenMatch() || match === null || match.state === 'finished') {
      return false;
    }
    await openMatch(code);
    return true;
  } catch {
    return false;
  }
}
