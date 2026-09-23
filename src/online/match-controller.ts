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

export interface OnlineMatchSubmissionOwner {
  readonly token: number;
  readonly matchId: string;
  readonly position: number;
}

export type OnlineMatchErrorContext =
  | Readonly<{ source: 'refresh' }>
  | (Readonly<{ source: 'submit' }> & OnlineMatchSubmissionOwner);

export interface OnlineMatchControllerDeps {
  gateway: OnlineMatchGateway;
  /** A snapshot has already passed the adapter’s phase/redaction validation. */
  onSnapshot: (snapshot: OnlineMatchSnapshot) => void;
  /** The room no longer has an active or recently finished match. */
  onMissing: () => void;
  /** Network/schema failures must be visible and retain their lifecycle owner. */
  onError: (message: string, context: OnlineMatchErrorContext) => void;
}

export interface OnlineMatchController {
  /** Subscribe before the first fetch so a start/advance event cannot race the initial read. */
  open(code: string): Promise<void>;
  /** Sends only the selected server question position and choice; then rereads authority. */
  submit(spec: OnlineMatchSubmissionOwner & { choiceIndex: number }): Promise<void>;
  /** Ignore any later completion from this controller generation and release its socket. */
  close(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function phaseRank(snapshot: OnlineMatchSnapshot): number {
  if (snapshot.state === 'finished') return 2;
  if (snapshot.state === 'revealing') return 1;
  return 0;
}

/** Server match progress is monotonic even when network response order is not. */
function compareSnapshotProgress(
  candidate: OnlineMatchSnapshot,
  current: OnlineMatchSnapshot | null,
): -1 | 0 | 1 | null {
  if (current === null) return 1;
  if (candidate.matchId !== current.matchId) return null;
  if (candidate.currentPosition !== current.currentPosition) {
    return candidate.currentPosition > current.currentPosition ? 1 : -1;
  }
  const candidatePhase = phaseRank(candidate);
  const currentPhase = phaseRank(current);
  if (candidatePhase !== currentPhase) return candidatePhase > currentPhase ? 1 : -1;
  if (candidate.state === 'running' && current.state === 'running') {
    const candidateSubmitted = candidate.ownSubmission === null ? 0 : 1;
    const currentSubmitted = current.ownSubmission === null ? 0 : 1;
    if (candidateSubmitted !== currentSubmitted) {
      return candidateSubmitted > currentSubmitted ? 1 : -1;
    }
  }
  return 0;
}

function isSnapshotAhead(
  candidate: OnlineMatchSnapshot,
  current: OnlineMatchSnapshot | null,
): boolean {
  return compareSnapshotProgress(candidate, current) === 1;
}

interface RefreshOutcome {
  delivered: boolean;
  error: string | null;
}

export function createOnlineMatchController(
  { gateway, onSnapshot, onMissing, onError }: OnlineMatchControllerDeps,
): OnlineMatchController {
  let code: string | null = null;
  let unsubscribe: Unsubscribe | null = null;
  /** Every open/close invalidates work started by an older match lifecycle. */
  let generation = 0;
  /** Monotonic request id plus the latest successful delivery. */
  let newestRefresh = 0;
  let refreshDeliveryWatermark = 0;
  let lastSnapshot: OnlineMatchSnapshot | null = null;
  let progressSnapshot: OnlineMatchSnapshot | null = null;
  let requiredMatchId: string | null = null;
  let awaitingUnknownIdentity = false;
  let matchIdentityVersion = 0;

  async function refresh(
    expectedGeneration: number,
    reportError = true,
    expectedMatchId: string | null = requiredMatchId,
    expectedIdentityVersion = matchIdentityVersion,
  ): Promise<RefreshOutcome> {
    const activeCode = code;
    if (!activeCode) return { delivered: false, error: null };
    const refreshId = ++newestRefresh;
    try {
      const snapshot = await gateway.getMatch(activeCode);
      if (
        expectedGeneration !== generation
        || activeCode !== code
        || expectedIdentityVersion !== matchIdentityVersion
        || (
          snapshot !== null
          && expectedMatchId !== null
          && snapshot.matchId !== expectedMatchId
        )
        || (
          snapshot !== null
          && requiredMatchId !== null
          && snapshot.matchId !== requiredMatchId
        )
        || (snapshot === null && refreshId !== newestRefresh)
      ) return { delivered: false, error: null };
      if (snapshot === null) {
        refreshDeliveryWatermark = Math.max(refreshDeliveryWatermark, refreshId);
        awaitingUnknownIdentity = false;
        onMissing();
        return { delivered: true, error: null };
      }
      if (requiredMatchId === null) requiredMatchId = snapshot.matchId;
      awaitingUnknownIdentity = false;
      const progress = compareSnapshotProgress(snapshot, progressSnapshot);
      if (progress === -1) return { delivered: false, error: null };
      if (
        refreshId <= refreshDeliveryWatermark
        && progress !== 1
      ) return { delivered: false, error: null };
      refreshDeliveryWatermark = Math.max(refreshDeliveryWatermark, refreshId);
      lastSnapshot = snapshot;
      progressSnapshot = snapshot;
      onSnapshot(snapshot);
      return { delivered: true, error: null };
    } catch (error) {
      const ownsError = (
        expectedGeneration === generation
        && expectedIdentityVersion === matchIdentityVersion
        && refreshId === newestRefresh
        && activeCode === code
        && (
          expectedMatchId === null
          || requiredMatchId === null
          || expectedMatchId === requiredMatchId
        )
      );
      if (ownsError && expectedMatchId === null) awaitingUnknownIdentity = false;
      const message = ownsError ? errorMessage(error) : null;
      if (message !== null && reportError) onError(message, { source: 'refresh' });
      return { delivered: false, error: message };
    }
  }

  function close(): void {
    generation += 1;
    newestRefresh += 1;
    unsubscribe?.();
    unsubscribe = null;
    code = null;
    lastSnapshot = null;
    progressSnapshot = null;
    requiredMatchId = null;
    awaitingUnknownIdentity = false;
    matchIdentityVersion += 1;
  }

  return {
    async open(nextCode) {
      close();
      const openedGeneration = ++generation;
      code = nextCode;
      unsubscribe = gateway.subscribe(nextCode, (event) => {
        if (openedGeneration !== generation || code !== nextCode || event.type !== 'match') return;
        if (event.phase === 'started') {
          if (
            event.matchId !== null
            && event.matchId === requiredMatchId
            && !awaitingUnknownIdentity
          ) {
            void refresh(openedGeneration, true, event.matchId, matchIdentityVersion);
            return;
          }
          matchIdentityVersion += 1;
          requiredMatchId = event.matchId;
          awaitingUnknownIdentity = event.matchId === null;
          progressSnapshot = null;
          void refresh(openedGeneration, true, event.matchId, matchIdentityVersion);
          return;
        }
        if (event.phase === 'invalidated') {
          if (event.matchId === null) {
            matchIdentityVersion += 1;
            requiredMatchId = null;
            awaitingUnknownIdentity = true;
            void refresh(openedGeneration, true, null, matchIdentityVersion);
            return;
          }
          if (awaitingUnknownIdentity) return;
          if (requiredMatchId !== null && requiredMatchId !== event.matchId) return;
          if (requiredMatchId === null) requiredMatchId = event.matchId;
          void refresh(openedGeneration, true, event.matchId, matchIdentityVersion);
        }
      });
      await refresh(openedGeneration);
    },

    async submit({ token, matchId, position, choiceIndex }) {
      const activeCode = code;
      const expectedGeneration = generation;
      const expectedIdentityVersion = matchIdentityVersion;
      const ownsActiveIdentity = (): boolean => (
        expectedIdentityVersion === matchIdentityVersion
        && (requiredMatchId === null || requiredMatchId === matchId)
      );
      if (!activeCode || !ownsActiveIdentity()) {
        onError(
          activeCode
            ? '새 온라인 매치가 시작되어 이전 문제 답안을 보낼 수 없습니다.'
            : '온라인 매치 연결이 없습니다. 대기실에서 다시 시작해 주세요.',
          { source: 'submit', token, matchId, position },
        );
        return;
      }
      try {
        const result = await gateway.submitMatchAnswer({ code: activeCode, position, choiceIndex });
        if (result.match.matchId !== matchId) {
          throw new Error('서버 답안 응답의 매치가 요청한 매치와 다릅니다.');
        }
        if (expectedGeneration === generation && activeCode === code && ownsActiveIdentity()) {
          const mutationProgress = compareSnapshotProgress(result.match, progressSnapshot);
          if (mutationProgress === 0 || mutationProgress === 1) progressSnapshot = result.match;
          const outcome = await refresh(
            expectedGeneration,
            false,
            matchId,
            expectedIdentityVersion,
          );
          if (
            !outcome.delivered
            && expectedGeneration === generation
            && activeCode === code
            && ownsActiveIdentity()
            && isSnapshotAhead(result.match, lastSnapshot)
          ) {
            lastSnapshot = result.match;
            progressSnapshot = result.match;
            onSnapshot(result.match);
          }
          if (
            outcome.error !== null
            && expectedGeneration === generation
            && activeCode === code
            && ownsActiveIdentity()
          ) onError(outcome.error, { source: 'refresh' });
        }
      } catch (error) {
        if (expectedGeneration === generation && activeCode === code && ownsActiveIdentity()) {
          onError(errorMessage(error), { source: 'submit', token, matchId, position });
        }
      }
    },

    close,
  };
}
