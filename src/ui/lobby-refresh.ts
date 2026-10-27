// 로비 방 목록을 조용히 다시 읽는 시계 (WP-E)
//
// 로비는 한때 목록을 주기적으로 다시 읽지 않았다 — 같은 주소 뒤의 여럿이 IP당 요청 한도(120/60초)를 나눠 썼다.
// N01(#106)이 몫을 사람마다 120/60초·IP 1,500/60초로 나눈 뒤로는 30초에 한 번이 넉넉하다 — 한 교실 서른 명이 모두
// 로비에 있어도 분당 60번, IP 몫의 4%다. 그래도 «보일 때만, 한 번에 하나, 실패하면 물러선다»를 지킨다.
//
// - 화면이 시킬 때만 돈다. `start()`는 로비가 보인 뒤(`activate`), `stop()`은 로비를 떠날 때(closers → `hide`)
// - 문서가 숨으면(다른 탭·앱) 시계를 끄고, 돌아오면 밀린 차례를 곧바로 한 번 읽는다
// - 차례가 와도 지금 읽으면 안 되면(`canRefresh` — 목록 요청이 도는 중, 방 목록 칸이 닫힘, 사람이 목록의 무엇을
//   고르는 중) 그 차례를 건너뛴다. 요청을 겹치지 않는다
// - 실패하면 간격을 두 배씩 늘린다(30초 → 1분 → 2분 → 4분에서 멈춘다). 한 번 읽으면 30초로 돌아온다
// - 사람이 누른 새로고침·다시 시도·나가기도 목록을 읽는다(`loaded`). 그때부터 다시 센다
//
// DOM을 모른다. 무엇을 읽고 그릴지는 화면(`ui/online.ts`)이 `refresh`로 정한다.

/** 로비 목록을 다시 읽는 기본 간격 */
export const LOBBY_REFRESH_MS = 30_000;
/** 실패가 이어질 때 늘어나는 간격의 끝 */
export const LOBBY_REFRESH_MAX_MS = 240_000;

/** 연달아 실패한 횟수에 맞는 다음 간격. 0번이면 기본 간격이다 */
export function lobbyRefreshDelayMs(failures: number): number {
  const steps = Math.min(Math.max(Math.floor(failures), 0), 8);
  return Math.min(LOBBY_REFRESH_MS * 2 ** steps, LOBBY_REFRESH_MAX_MS);
}

export interface LobbyRefreshClock {
  now(): number;
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface LobbyRefreshDeps {
  /** 목록을 한 번 조용히 다시 읽는다. 읽었으면 true, 실패했으면 false */
  refresh(): Promise<boolean>;
  /** 지금 읽어도 되는가. 아니면 이 차례를 건너뛴다 */
  canRefresh(): boolean;
  /** 문서가 숨었는가 (`document.visibilityState`) */
  documentHidden(): boolean;
  clock?: LobbyRefreshClock;
}

export interface LobbyRefresh {
  /** 로비가 보인 뒤. 마지막으로 읽은 때(`loaded`)부터 간격을 센다 */
  start(): void;
  /** 로비를 떠난다. 도는 요청의 결과도 더는 차례를 정하지 않는다 */
  stop(): void;
  /** 다른 길(사람이 누른 새로고침 등)로 목록을 읽었다. 그때부터 다시 센다 */
  loaded(ok: boolean): void;
  /** `visibilitychange` — 숨으면 시계를 끄고, 보이면 밀린 차례를 잡는다 */
  visibilityChanged(): void;
  readonly running: boolean;
}

// 30초 간격이라 기기 시계(Date)로 충분하다. 시계가 크게 바뀌면 한 차례가 이르거나 늦을 뿐이다
const browserClock: LobbyRefreshClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createLobbyRefresh(
  { refresh, canRefresh, documentHidden, clock = browserClock }: LobbyRefreshDeps,
): LobbyRefresh {
  let running = false;
  /** start·stop마다 바뀐다. 떠난 로비에서 출발한 요청이 다음 로비의 차례를 정하지 못하게 한다 */
  let session = 0;
  let failures = 0;
  /** 다음 차례의 시각. null이면 아직 아무것도 읽지 않았다 — start가 지금부터 센다 */
  let dueAt: number | null = null;
  let timer: number | null = null;
  let inFlight = false;

  function clear(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    clear();
    if (!running || inFlight || documentHidden()) return;
    if (dueAt === null) dueAt = clock.now() + lobbyRefreshDelayMs(failures);
    timer = clock.setTimeout(fire, Math.max(dueAt - clock.now(), 0));
  }

  function record(ok: boolean): void {
    failures = ok ? 0 : failures + 1;
    dueAt = clock.now() + lobbyRefreshDelayMs(failures);
    schedule();
  }

  function fire(): void {
    timer = null;
    if (!running || inFlight || documentHidden()) return;
    if (!canRefresh()) {
      // 이 차례는 건너뛴다. 간격은 그대로 다시 센다(실패가 아니다)
      dueAt = clock.now() + lobbyRefreshDelayMs(failures);
      schedule();
      return;
    }
    const owner = session;
    inFlight = true;
    refresh().then((ok) => ok, () => false).then((ok) => {
      if (owner !== session) return;
      inFlight = false;
      record(ok);
    });
  }

  return {
    start() {
      if (!running) {
        running = true;
        session += 1;
        inFlight = false;
      }
      schedule();
    },
    stop() {
      running = false;
      session += 1;
      inFlight = false;
      failures = 0;
      dueAt = null;
      clear();
    },
    loaded(ok) {
      failures = ok ? 0 : failures + 1;
      dueAt = clock.now() + lobbyRefreshDelayMs(failures);
      schedule();
    },
    visibilityChanged() {
      if (documentHidden()) clear();
      else schedule();
    },
    get running() {
      return running;
    },
  };
}
