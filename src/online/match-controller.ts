// Server-authoritative online match lifecycle.
//
// The controller deliberately never calculates correctness, score, rank, deadlines,
// or question progression. A WebSocket only says “invalidate”; the next visible
// state always comes from an authenticated REST snapshot.
//
// 무효화는 몰려 올 수 있다(phase가 바뀌면 방 전체에 방송된다). 그래서 GET은 한 번에 하나만 보내고,
// 그동안 온 무효화는 끝난 뒤의 후속 GET 한 번으로 합친다.
//
// 같은 IP(교실·집 NAT) 뒤의 여럿이 요청 한도를 나눠 쓰므로 요청을 아낀다 (N01).
// - 답을 낸 뒤에는 따로 GET을 보내지 않는다. 제출 응답의 snapshot이 곧 서버가 그 답을 받은 뒤의
//   상태이고, 넘어가지 않은 답은 서버가 방송하지도 않는다(남의 running 화면에는 바뀌는 것이 없다).
// - 요청 한도(429)에 걸린 GET은 Retry-After(상한 약 3초)와 jitter를 두고 한 번만 다시 보낸다.
// - 남은 시간이 지나고 2초가 더 지나도 phase가 그대로면 한 번 다시 읽는다. 놓친 방송 하나가
//   사람을 공개 화면에 가두지 않게 하는 안전망이다. 답을 대신 내지 않는다 — 판정은 서버가 한다.

import type {
  OnlineMatchAnswerResult,
  OnlineMatchSnapshot,
  RoomEventHandler,
  Unsubscribe,
} from './adapter.js';
import { onlineErrorText, rateLimitRetryDelayMs } from './rules.js';

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

/** 표시용 마감이 지나고 이만큼 더 기다려도 phase가 그대로면 한 번 다시 읽는다 (N01) */
export const SAFETY_REREAD_GRACE_MS = 2_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/** 다시 읽기의 기다림과 jitter. 테스트가 가짜 시계를 넣는다 */
export interface OnlineMatchTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  random(): number;
}

const BROWSER_TIMERS: OnlineMatchTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  random: () => Math.random(),
};

export interface OnlineMatchControllerDeps {
  gateway: OnlineMatchGateway;
  /** A snapshot has already passed the adapter’s phase/redaction validation. */
  onSnapshot: (snapshot: OnlineMatchSnapshot) => void;
  /** The room no longer has an active or recently finished match. */
  onMissing: () => void;
  /** Network/schema failures must be visible and retain their lifecycle owner. */
  onError: (message: string, context: OnlineMatchErrorContext) => void;
  /** The active match socket also carries authenticated room presence and chat updates. */
  onPresenceEvent?: (
    event: Extract<Parameters<RoomEventHandler>[0], { type: 'room' | 'movement' | 'chat' }>,
  ) => void;
  timers?: OnlineMatchTimers;
}

export interface OnlineMatchController {
  /** Subscribe before the first fetch so a start/advance event cannot race the initial read. */
  open(code: string): Promise<void>;
  /** Sends only the selected server question position and choice; draws the server's answer snapshot. */
  submit(spec: OnlineMatchSubmissionOwner & { choiceIndex: number }): Promise<void>;
  /** Ignore any later completion from this controller generation and release its socket. */
  close(): void;
}

/**
 * 화면에 넘기는 말 (U40). 어댑터 오류의 개발 상세(«서버 매치 snapshot이 …», «Failed to fetch»)는
 * 콘솔에만 남기고, 이유를 플레이어의 말로 가진 오류(`OnlinePlayerError`)만 그 말을 쓴다.
 */
const REFRESH_FAILED_MESSAGE = '게임 상태를 불러오지 못했어요. 잠시 뒤 다시 맞춰요.';
const SUBMIT_FAILED_MESSAGE = '답을 보내지 못했어요. 다시 골라 주세요.';

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

const NOT_DELIVERED: RefreshOutcome = { delivered: false, error: null };

/** 한 번의 GET이 지켜야 할 소유권. 아래 guard는 응답이 왔을 때 이것을 지금 상태와 견준다. */
interface RefreshRequest {
  /** 요청한 순간에 정한 번호. 뒤에 다른 요청이 오면 이 GET은 더 이상 «최신»이 아니다. */
  id: number;
  code: string;
  generation: number;
  reportError: boolean;
  expectedMatchId: string | null;
  identityVersion: number;
  /** 이 GET 하나로 합쳐진 요청들. 모두 같은 결과를 받는다. */
  waiters: Array<(outcome: RefreshOutcome) => void>;
}

export function createOnlineMatchController(
  {
    gateway,
    onSnapshot,
    onMissing,
    onError,
    onPresenceEvent = () => undefined,
    timers = BROWSER_TIMERS,
  }: OnlineMatchControllerDeps,
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
  /**
   * 지금 날아가는 GET의 표식. 한 번에 하나만 보낸다 — 무효화가 몰려 올 때(재연결 복구와 phase
   * 방송이 겹치거나, 답 하나마다 방송하던 N01 이전 서버) 오는 대로 GET을 보내면 같은 와이파이의
   * 여럿이 요청 한도를 먼저 먹는다.
   * close()가 비우므로 늦게 끝난 이전 lifecycle의 GET이 새 매치의 첫 읽기를 막지 않는다.
   */
  let refreshInFlight: object | null = null;
  /** 날아가는 동안 들어온 요청은 모두 이 하나의 후속 GET으로 합친다. */
  let queuedRefresh: RefreshRequest | null = null;
  /** 마감 뒤 다시 읽기의 타이머와, 그것을 이미 건 phase. phase마다 한 번뿐이다 */
  let safetyTimer: TimerHandle | null = null;
  let safetyPhase: string | null = null;

  function clearSafetyReread(): void {
    if (safetyTimer !== null) timers.clearTimeout(safetyTimer);
    safetyTimer = null;
  }

  /**
   * 마감 뒤 다시 읽기 (N01). phase가 바뀌면 서버가 방송하지만, 그 방송이나 뒤따른 GET을 놓치면
   * (요청 한도·끊긴 소켓) 다음 방송이 오지 않는 곳 — 특히 마지막 공개 — 에서 화면이 멈춘다. 그래서
   * 받은 snapshot의 남은 시간이 지나고 `SAFETY_REREAD_GRACE_MS`가 더 지나도 phase가 그대로면 GET을
   * 한 번 보낸다. 마감이 지난 판을 읽는 GET은 서버가 그 자리에서 넘기므로 남은 사람들도 함께 풀린다.
   * 같은 phase의 snapshot이 또 와도 다시 걸지 않는다 — phase마다 한 번이라 되풀이 GET이 생기지 않는다.
   */
  function armSafetyReread(snapshot: OnlineMatchSnapshot): void {
    if (snapshot.state === 'finished' || snapshot.remainingMs === undefined) {
      clearSafetyReread();
      safetyPhase = null;
      return;
    }
    const phase = `${snapshot.matchId}:${snapshot.currentPosition}:${snapshot.state}`;
    if (phase === safetyPhase) return;
    clearSafetyReread();
    safetyPhase = phase;
    const armedGeneration = generation;
    safetyTimer = timers.setTimeout(() => {
      safetyTimer = null;
      if (armedGeneration !== generation || code === null) return;
      void refresh(armedGeneration);
    }, Math.max(snapshot.remainingMs, 0) + SAFETY_REREAD_GRACE_MS);
  }

  function deliver(snapshot: OnlineMatchSnapshot): void {
    lastSnapshot = snapshot;
    progressSnapshot = snapshot;
    armSafetyReread(snapshot);
    onSnapshot(snapshot);
  }

  /**
   * GET /match 하나. 요청 한도(429)에 걸리면 Retry-After(상한 약 3초)와 jitter를 두고 **한 번만** 다시
   * 보낸다 (N01). 조용히 버리면 phase가 바뀌는 순간의 429 하나가 문항 하나를 통째로 가렸다. 기다리는
   * 동안에도 이 GET이 자리를 쥐고 있어 그사이 온 무효화는 후속 GET 하나로 합쳐진다.
   */
  async function readMatch(
    activeCode: string,
    expectedGeneration: number,
  ): Promise<OnlineMatchSnapshot | null> {
    try {
      return await gateway.getMatch(activeCode);
    } catch (error) {
      const delayMs = rateLimitRetryDelayMs(error, timers.random);
      if (delayMs === null) throw error;
      await new Promise<void>((resolve) => {
        timers.setTimeout(resolve, delayMs);
      });
      // 그사이 닫혔거나 다른 방을 열었으면 보내지 않는다. 처음 거절은 아래 guard가 버린다
      if (expectedGeneration !== generation || activeCode !== code) throw error;
      return gateway.getMatch(activeCode);
    }
  }

  /**
   * 요청을 합쳐 보낸다. 날아가는 GET이 없으면 바로 보내고, 있으면 끝난 뒤 **정확히 한 번** 더 읽는다.
   * 날아가던 GET은 무효화 전에 출발했을 수 있으므로 후속 GET 없이 끝내면 낡은 화면이 남는다.
   */
  function refresh(
    expectedGeneration: number,
    reportError = true,
    expectedMatchId: string | null = requiredMatchId,
    expectedIdentityVersion = matchIdentityVersion,
  ): Promise<RefreshOutcome> {
    const activeCode = code;
    if (!activeCode) return Promise.resolve(NOT_DELIVERED);
    // 번호는 요청한 순간에 매긴다. 그래서 후속 GET이 예약되면 날아가던 GET은 «최신»이 아니게 되어
    // 그 null(매치 없음)이나 오류가 화면을 옮기지 못하고 후속 GET의 판정을 기다린다.
    const id = ++newestRefresh;
    return new Promise((resolve) => {
      const merged = queuedRefresh;
      queuedRefresh = {
        id,
        code: activeCode,
        generation: expectedGeneration,
        // 합친 요청 가운데 하나라도 알려 달라고 했으면 알린다. 실패를 조용히 삼키지 않는다.
        reportError: (merged?.reportError ?? false) || reportError,
        // 기대값은 가장 최근 요청의 것을 쓴다. identity가 바뀌었다면 그것이 지금의 매치다.
        expectedMatchId,
        identityVersion: expectedIdentityVersion,
        waiters: [...(merged?.waiters ?? []), resolve],
      };
      pumpRefresh();
    });
  }

  function pumpRefresh(): void {
    if (refreshInFlight !== null || queuedRefresh === null) return;
    const request = queuedRefresh;
    queuedRefresh = null;
    const flight = {};
    refreshInFlight = flight;
    void runRefresh(request).then((outcome) => {
      if (refreshInFlight === flight) refreshInFlight = null;
      for (const resolve of request.waiters) resolve(outcome);
      pumpRefresh();
    });
  }

  async function runRefresh(
    {
      id: refreshId,
      code: activeCode,
      generation: expectedGeneration,
      reportError,
      expectedMatchId,
      identityVersion: expectedIdentityVersion,
    }: RefreshRequest,
  ): Promise<RefreshOutcome> {
    try {
      const snapshot = await readMatch(activeCode, expectedGeneration);
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
        clearSafetyReread();
        safetyPhase = null;
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
      deliver(snapshot);
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
      const message = ownsError ? onlineErrorText(error, REFRESH_FAILED_MESSAGE) : null;
      if (message !== null && reportError) onError(message, { source: 'refresh' });
      return { delivered: false, error: message };
    }
  }

  function close(): void {
    generation += 1;
    newestRefresh += 1;
    // 예약된 후속 GET은 보내지 않는다. 기다리던 쪽은 «전달되지 않음»으로 끝난다.
    const dropped = queuedRefresh;
    queuedRefresh = null;
    refreshInFlight = null;
    for (const resolve of dropped?.waiters ?? []) resolve(NOT_DELIVERED);
    clearSafetyReread();
    safetyPhase = null;
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
        if (openedGeneration !== generation || code !== nextCode) return;
        if (event.type === 'room' || event.type === 'movement' || event.type === 'chat') {
          onPresenceEvent(event);
          return;
        }
        if (event.type !== 'match') return;
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
            ? '새 게임이 시작돼 이전 문제의 답은 보낼 수 없어요.'
            : '게임 연결이 끊겼어요. 대기실에서 다시 들어와 주세요.',
          { source: 'submit', token, matchId, position },
        );
        return;
      }
      try {
        const result = await gateway.submitMatchAnswer({ code: activeCode, position, choiceIndex });
        if (result.match.matchId !== matchId) {
          throw new Error('서버 답안 응답의 매치가 요청한 매치와 다릅니다.');
        }
        if (
          expectedGeneration === generation
          && activeCode === code
          && ownsActiveIdentity()
          && isSnapshotAhead(result.match, progressSnapshot)
        ) {
          // 제출 응답의 snapshot이 곧 서버가 이 답을 받은 뒤의 상태다. 따로 GET을 보내지 않는다 (N01).
          // 이미 더 앞선 화면(먼저 온 공개·다음 문항)이 있으면 되돌리지 않는다(isSnapshotAhead).
          // 이 응답 전에 출발한 GET은 같은 진행의 더 낡은 snapshot으로 덮지 못한다(watermark).
          if (requiredMatchId === null) requiredMatchId = result.match.matchId;
          awaitingUnknownIdentity = false;
          refreshDeliveryWatermark = Math.max(refreshDeliveryWatermark, newestRefresh);
          deliver(result.match);
        }
      } catch (error) {
        if (expectedGeneration === generation && activeCode === code && ownsActiveIdentity()) {
          onError(onlineErrorText(error, SUBMIT_FAILED_MESSAGE), { source: 'submit', token, matchId, position });
        }
      }
    },

    close,
  };
}
