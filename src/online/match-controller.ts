// Server-authoritative online match lifecycle.
//
// The controller deliberately never calculates correctness, score, rank, deadlines,
// or question progression. A WebSocket only says “invalidate”; the next visible
// state always comes from an authenticated REST snapshot.

import type {
  OnlineMatchAnswerResult,
  OnlineMatchSnapshot,
  RoomEventHandler,
  Unsubscribe,
} from './adapter.js';

export interface OnlineMatchGateway {
  getMatch(code: string): Promise<OnlineMatchSnapshot | null>;
  submitMatchAnswer(spec: {
    code: string;
    position: number;
    choiceIndex: number;
  }): Promise<OnlineMatchAnswerResult>;
  subscribe(code: string, handler: RoomEventHandler): Unsubscribe;
}

export interface OnlineMatchControllerDeps {
  gateway: OnlineMatchGateway;
  /** A snapshot has already passed the adapter’s phase/redaction validation. */
  onSnapshot: (snapshot: OnlineMatchSnapshot) => void;
  /** The room no longer has an active or recently finished match. */
  onMissing: () => void;
  /** Network/schema failures must be visible; never silently fall back to local play. */
  onError: (message: string) => void;
}

export interface OnlineMatchController {
  /** Subscribe before the first fetch so a start/advance event cannot race the initial read. */
  open(code: string): Promise<void>;
  /** Sends only the selected server question position and choice; then rereads authority. */
  submit(spec: { position: number; choiceIndex: number }): Promise<void>;
  /** Ignore any later completion from this controller generation and release its socket. */
  close(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOnlineMatchController(
  { gateway, onSnapshot, onMissing, onError }: OnlineMatchControllerDeps,
): OnlineMatchController {
  let code: string | null = null;
  let unsubscribe: Unsubscribe | null = null;
  /** Every open/close invalidates work started by an older match lifecycle. */
  let generation = 0;
  /** Within one lifecycle, a newer refresh wins over a late older response. */
  let newestRefresh = 0;

  async function refresh(expectedGeneration: number): Promise<void> {
    const activeCode = code;
    if (!activeCode) return;
    const refreshId = ++newestRefresh;
    try {
      const snapshot = await gateway.getMatch(activeCode);
      if (
        expectedGeneration !== generation
        || refreshId !== newestRefresh
        || activeCode !== code
      ) return;
      if (snapshot === null) {
        onMissing();
        return;
      }
      onSnapshot(snapshot);
    } catch (error) {
      if (
        expectedGeneration === generation
        && refreshId === newestRefresh
        && activeCode === code
      ) onError(errorMessage(error));
    }
  }

  function close(): void {
    generation += 1;
    newestRefresh += 1;
    unsubscribe?.();
    unsubscribe = null;
    code = null;
  }

  return {
    async open(nextCode) {
      close();
      const openedGeneration = ++generation;
      code = nextCode;
      unsubscribe = gateway.subscribe(nextCode, (event) => {
        if (openedGeneration !== generation || code !== nextCode) return;
        if (event.type === 'match' && (event.phase === 'started' || event.phase === 'invalidated')) {
          void refresh(openedGeneration);
        }
      });
      await refresh(openedGeneration);
    },

    async submit({ position, choiceIndex }) {
      const activeCode = code;
      const expectedGeneration = generation;
      if (!activeCode) {
        onError('온라인 매치 연결이 없습니다. 대기실에서 다시 시작해 주세요.');
        return;
      }
      try {
        await gateway.submitMatchAnswer({ code: activeCode, position, choiceIndex });
        if (expectedGeneration === generation && activeCode === code) {
          await refresh(expectedGeneration);
        }
      } catch (error) {
        if (expectedGeneration === generation && activeCode === code) onError(errorMessage(error));
      }
    },

    close,
  };
}
