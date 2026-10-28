// 랭킹 화면 렌더링 (FR-6.2 ~ FR-6.6, FR-6.10, FR-6.12) · 기록 내보내기 (N02) · 온라인 랭킹 (FR-7.13 2단계)
// 기록을 어디서 읽고 지우고 내보내는지는 app.js가 넘겨준 콜백이 안다.
// 이 파일은 저장소를 직접 알지 못한다 — 온라인 랭킹도 app.ts가 넘긴 콜백으로만 읽는다.

import { CATEGORIES } from '../constants.js';
import { need, needOne } from '../dom.js';
import { createScreenWalker, pointBelowRightEdge } from './screen-walker.js';
import { formatPlayedAt } from './format.js';
import { trapFocus } from './quiz.js';
import { announce } from './screens.js';
import { createBody } from './sprite.js';
import type { OnlineRankingBoard, OnlineRankingEntry, OnlineRankingPeriod } from '../online/adapter.js';
import type { RankingTarget, RecordsExportFile, ScoreRecord } from '../types.js';

/** 탭 하나. key는 전체 도전이면 'all', 아니면 카테고리 id다 */
interface RankingTab {
  key: string;
  label: string;
  target: RankingTarget;
}

/**
 * 탭 하나가 랭킹 하나에 대응한다 (FR-6.2).
 * 전체 모드는 카테고리가 없으므로 category가 null이다.
 */
const TABS: RankingTab[] = [
  { key: 'all', label: '전체 도전', target: { mode: 'all', category: null } },
  ...CATEGORIES.map((category) => ({
    key: category.id,
    label: category.name,
    target: { mode: 'category' as const, category: category.id },
  })),
];

/** 어느 기록을 보는가. 온라인은 서버가 채점한 온라인 판, 로컬은 이 브라우저에 남은 혼자 하기 기록이다 */
export type RankingScope = 'online' | 'local';

const PERIOD_LABELS: Readonly<Record<OnlineRankingPeriod, string>> = { week: '이번 주', all: '전체 기간' };

/** 저장 범위 줄 (FR-6.10). 어느 기록인지 맨 위에서 말한다 */
const SCOPE_NOTES: Readonly<Record<RankingScope, string>> = {
  local: '이 브라우저에 저장된 내 기록이에요.',
  online: '온라인 방에서 끝까지 푼 판이 모두 남아요. 같은 점수면 먼저 남긴 기록이 위예요.',
};

/**
 * 온라인 랭킹을 읽은 결과. app.ts가 저장소의 답과 오류를 이 모양으로 옮긴다 — 이 화면은 오류의 종류를
 * 모르고 보일 말만 받는다
 */
export type OnlineRankingLoad =
  | { status: 'ok'; board: OnlineRankingBoard }
  /** 이 API에는 서버 랭킹이 없다(세션이 `rankings: true`를 알리지 않는다). 온라인 랭킹을 숨긴다 */
  | { status: 'unsupported' }
  /**
   * 읽지 못했다. action은 빈 칸 버튼이 하는 일이다 — 'retry'(기본)는 «다시 시도», 'home'은 다시 해도 같은
   * 실패라(저장된 닉네임이 금칙 규칙에 걸렸다) 닉네임을 고칠 홈으로 보낸다
   */
  | { status: 'error'; message: string; action?: 'retry' | 'home' };

/** 온라인 랭킹 (FR-7.13 2단계). 없으면 이 화면은 예전처럼 이 브라우저의 기록만 보인다 */
export interface OnlineRankingDeps {
  /** 온라인 랭킹이 있는가 — true·false(이 API·로컬 방에는 없다)·null(아직 묻지 않아 모른다) */
  available: () => boolean | null;
  load: (target: RankingTarget, period: OnlineRankingPeriod) => Promise<OnlineRankingLoad>;
  /** 빈 온라인 랭킹의 다음 행동: 온라인 로비를 연다 */
  onOpenOnline: () => void;
}

/** app.ts가 넘겨주는 콜백 뭉치 */
export interface RankingScreenDeps {
  onHome: () => void;
  /** 빈 탭에서 그 탭의 판을 곧바로 연다 (FR-6.12). 홈으로 돌려보내 다시 고르게 하지 않는다 */
  onStart: (target: RankingTarget) => void;
  /**
   * 그 탭의 판을 지금 열 수 있는가. 홈의 분야 칸·전체 도전이 잠기는 것과 같은 규칙이다 —
   * 문제를 불러오지 못한 분야에 「… 시작하기」를 권하면 눌렀을 때 홈으로 튕겨 나간다
   */
  canStart: (target: RankingTarget) => boolean;
  loadRankings: (target: RankingTarget) => Promise<ScoreRecord[]>;
  clearRankings: () => Promise<void>;
  /**
   * 이 브라우저의 모든 랭킹 기록을 선생님께 낼 파일 하나로 묶는다 (N02). 모양과 이름은 app.ts가
   * 정하고(`core/records-export.ts`) 이 화면은 내려받기·복사만 한다 — 저장소를 직접 부르지 않는다
   */
  exportRecords: () => Promise<RecordsExportFile>;
  online?: OnlineRankingDeps;
}

/**
 * target을 주면 그 랭킹 탭을 열고, highlightId를 주면 그 기록을 강조한다.
 * scope를 주면 그 범위(온라인·이 브라우저)를, period를 주면 온라인 랭킹의 그 기간을 연다.
 */
export interface RankingView {
  target?: RankingTarget | null;
  highlightId?: string | null;
  characterId?: string;
  scope?: RankingScope;
  period?: OnlineRankingPeriod;
}

export interface RankingScreen {
  /** 랭킹 화면을 그린다 */
  show(view?: RankingView): Promise<void>;

  /** 화면을 떠난다. 캐릭터와 손가락 조작부를 함께 거둔다 */
  hide(): void;
}

/** «이번 주»의 두 끝을 서울 날짜로: «10월 26일 (월) ~ 11월 1일 (일)». 끝은 다음 월요일 0시라 하루 앞이다 */
export function rankingWeekLabel(window: { start: string; end: string }): string {
  const start = new Date(window.start);
  const last = new Date(new Date(window.end).getTime() - 1);
  try {
    const day = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    });
    return `${day.format(start)} ~ ${day.format(last)}`;
  } catch {
    // 시간대를 모르는 오래된 브라우저: 날짜만 숫자로 보인다(서울 시각으로 옮기지 못한다)
    return `${formatPlayedAt(window.start).slice(0, 10)} ~ ${formatPlayedAt(last.toISOString()).slice(0, 10)}`;
  }
}

/** 상태 줄(role=status)의 한 문장. 무엇을 봤고 몇 개인지 말한다 — 글이 바뀔 때만 낭독된다 */
export function onlineRankingSummary(
  tabLabel: string,
  period: OnlineRankingPeriod,
  entries: readonly OnlineRankingEntry[],
): string {
  const where = `${PERIOD_LABELS[period]} ${tabLabel} 온라인 랭킹`;
  if (entries.length === 0) return `${where}에 아직 기록이 없어요.`;
  const mine = entries.filter(({ isMine }) => isMine).length;
  return mine > 0
    ? `${where} · 기록 ${entries.length}개 · 내 기록 ${mine}개`
    : `${where} · 기록 ${entries.length}개`;
}

export function createRankingScreen(
  { onHome, onStart, canStart, loadRankings, clearRankings, exportRecords, online }: RankingScreenDeps,
): RankingScreen {
  const el = {
    tabs: need('ranking-tabs'),
    header: needOne<HTMLElement>('[data-screen="ranking"] .ranking-header'),
    character: need('ranking-character'),
    scopeTabs: need('ranking-scope-tabs'),
    scopeOnline: need<HTMLButtonElement>('ranking-scope-online'),
    scopeLocal: need<HTMLButtonElement>('ranking-scope-local'),
    scopeNote: need('ranking-scope-note'),
    periods: need('ranking-periods'),
    periodWeek: need<HTMLButtonElement>('ranking-period-week'),
    periodAll: need<HTMLButtonElement>('ranking-period-all'),
    window: need('ranking-window'),
    onlineStatus: need('ranking-online-status'),
    list: need('ranking-list'),
    empty: need('ranking-empty'),
    emptyMessage: need('ranking-empty-message'),
    emptyStartButton: need<HTMLButtonElement>('ranking-empty-start'),
    homeButton: need<HTMLButtonElement>('ranking-home'),
    footer: need('ranking-footer'),
    clearButton: need<HTMLButtonElement>('ranking-clear'),
    dialog: need('clear-dialog'),
    dialogCancel: need<HTMLButtonElement>('clear-cancel'),
    dialogConfirm: need<HTMLButtonElement>('clear-confirm'),
    exportBlock: need('ranking-export'),
    exportFile: need<HTMLButtonElement>('ranking-export-file'),
    exportCopy: need<HTMLButtonElement>('ranking-export-copy'),
    exportText: need<HTMLTextAreaElement>('ranking-export-text'),
    exportStatus: need('ranking-export-status'),
  };

  const walker = createScreenWalker({
    screen: needOne<HTMLElement>('[data-screen="ranking"]'),
    character: el.character,
    startPoint: () => pointBelowRightEdge(el.header, el.character),
  });

  let activeKey = TABS[0].key;
  /** 방금 등록한 기록 ID. 다른 탭으로 옮기면 지운다 (FR-6.5) */
  let highlightId: string | null = null;
  /**
   * 부른 곳이 정했거나 사람이 고른 범위. 이 페이지가 열려 있는 동안 마지막 것을 기억한다. null이면 아무도
   * 고르지 않았다 — 그때는 `defaultScope()`를 따른다
   */
  let scope: RankingScope | null = null;
  /**
   * 아무도 범위를 고르지 않아 온라인으로 열었는데, 이 API가 랭킹을 아는지 모르는 채(세션을 열지 못했다) 읽지
   * 못했다. 이 페이지에서는 기본 범위를 이 브라우저의 기록으로 둔다 — 랭킹을 연 사람의 기록을 오류 뒤에 숨기지
   * 않고, 잠깐 끊길 때마다 처음 화면이 오류가 되지 않게
   */
  let defaultFellBack = false;
  let period: OnlineRankingPeriod = 'week';
  /** 늦게 온 온라인 응답이 그 뒤에 고른 탭·기간을 덮지 않게 한다 */
  let onlineRequest = 0;
  /** 빈 칸의 버튼이 하는 일. 글자를 그린 때와 같은 판정으로 누른다 */
  let emptyAction: 'start' | 'home' | 'online' | 'retry' = 'start';
  /** 읽어 보니 이 API에는 서버 랭킹이 없었다. 이 페이지에서는 다시 권하지 않는다 */
  let onlineMissing = false;

  const tabButtons = new Map<string, HTMLButtonElement>();

  /** 온라인 랭킹을 보일 수 있는가. 이 API·로컬 방에 없다고 알았으면 거두고 이 브라우저의 기록만 보인다 */
  function onlineOffered(): boolean {
    return online !== undefined && !onlineMissing && online.available() !== false;
  }

  /**
   * 아무도 범위를 고르지 않았을 때의 범위. 온라인 랭킹이 있다고 알면 온라인이고, 아직 모르면(세션 전) 온라인을
   * 보여 주며 묻는다. 그렇게 물었다가 읽지 못했으면 이 브라우저의 기록이다(`defaultFellBack`)
   */
  function defaultScope(): RankingScope {
    if (!onlineOffered()) return 'local';
    if (online?.available() === true) return 'online';
    return defaultFellBack ? 'local' : 'online';
  }

  function activeScope(): RankingScope {
    return (scope ?? defaultScope()) === 'online' && onlineOffered() ? 'online' : 'local';
  }

  // ── 탭 ─────────────────────────────────────────────────────────

  function buildTabs(): void {
    el.tabs.replaceChildren();

    for (const tab of TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ranking-tab';
      button.textContent = tab.label;
      button.addEventListener('click', () => {
        if (activeKey === tab.key) return;
        activeKey = tab.key;
        highlightId = null; // 다른 랭킹으로 옮겼으니 하이라이트는 의미가 없다
        void render();
      });

      tabButtons.set(tab.key, button);
      el.tabs.append(button);
    }
  }

  function syncPressed(button: HTMLButtonElement, pressed: boolean, activeClass = 'ranking-tab--active'): void {
    button.classList.toggle(activeClass, pressed);
    button.setAttribute('aria-pressed', String(pressed));
  }

  /** 범위·기간의 두 칸. 랭킹 탭과 같은 분절 버튼이지만 탭 여섯(.ranking-tab)과 섞이지 않게 제 이름을 쓴다 */
  function syncOption(button: HTMLButtonElement, pressed: boolean): void {
    syncPressed(button, pressed, 'ranking-switch__option--active');
  }

  function syncTabs(): void {
    for (const [key, button] of tabButtons) syncPressed(button, key === activeKey);
    const current = activeScope();
    // 온라인 랭킹이 없으면 범위 탭도 거둔다 — 예전 화면 그대로다
    el.scopeTabs.hidden = !onlineOffered();
    syncOption(el.scopeOnline, current === 'online');
    syncOption(el.scopeLocal, current === 'local');
    el.scopeNote.textContent = SCOPE_NOTES[current];
    el.periods.hidden = current !== 'online';
    syncOption(el.periodWeek, period === 'week');
    syncOption(el.periodAll, period === 'all');
  }

  /**
   * 누른 버튼이 사라지면 포커스가 <body>로 떨어진다. 그 버튼에 포커스가 있었을 때만 지금 탭으로 옮긴다 —
   * 캐릭터가 밟아 누른 것이면 옮기지 않는다(포커스가 생기면 다음 Enter가 발밑이 아니라 그 버튼을 누른다)
   */
  function keepFocus(hadFocus: boolean, gone: () => boolean): void {
    if (!hadFocus || !gone()) return;
    tabButtons.get(activeKey)?.focus();
  }

  // ── 목록 ───────────────────────────────────────────────────────

  function createItem(record: ScoreRecord, rank: number): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'ranking-item';
    if (record.id === highlightId) {
      item.classList.add('ranking-item--mine');
    }

    const rankLabel = document.createElement('span');
    rankLabel.className = 'ranking-item__rank';
    rankLabel.textContent = String(rank);

    const nickname = document.createElement('span');
    nickname.className = 'ranking-item__nickname';
    nickname.textContent = record.nickname;

    // 방금 등록한 기록임을 색상 말고 글자로도 알린다
    if (record.id === highlightId) {
      const badge = document.createElement('span');
      badge.className = 'ranking-item__badge';
      badge.textContent = '방금 등록';
      nickname.append(' ', badge);
    }

    const score = document.createElement('span');
    score.className = 'ranking-item__score';
    score.textContent = `${record.score}점`;

    // 점수만 보여주면 만점이 다른 기록끼리 잘못 비교된다.
    // 카테고리가 늘면 전체 도전 만점이 함께 커지는데(400 → 500) 기록은 같은
    // 목록에 쌓이므로, 몇 문제 중 몇 개인지를 붙여 읽는 사람이 가늠하게 한다.
    const hits = document.createElement('span');
    hits.className = 'ranking-item__hits';
    hits.textContent = `${record.correctCount}/${record.totalCount}`;
    score.append(' ', hits);

    // 소요 시간은 목록에 넣지 않는다 (FR-6.4)
    const date = document.createElement('span');
    date.className = 'ranking-item__date';
    date.textContent = formatPlayedAt(record.playedAt);

    item.append(rankLabel, nickname, score, date);
    return item;
  }

  /**
   * 온라인 랭킹 한 줄. 순위는 서버가 정한 그대로다(같은 점수는 먼저 남긴 기록이 위, 1·2·3). 내 기록은
   * 색과 함께 «나» 글자로 짚는다 — 이 브라우저의 신분으로 서버가 가린 것이다
   */
  function createOnlineItem(entry: OnlineRankingEntry): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'ranking-item ranking-item--online';
    item.classList.toggle('ranking-item--mine', entry.isMine);

    const rankLabel = document.createElement('span');
    rankLabel.className = 'ranking-item__rank';
    rankLabel.textContent = String(entry.rank);

    // 캐릭터는 그림이다. 누구인지는 옆의 이름 글자가 말한다
    const figure = document.createElement('span');
    figure.className = 'ranking-item__figure';
    figure.setAttribute('aria-hidden', 'true');
    figure.append(createBody(entry.characterId));

    const nickname = document.createElement('span');
    nickname.className = 'ranking-item__nickname';
    nickname.textContent = entry.nickname;
    if (entry.isMine) {
      const badge = document.createElement('span');
      badge.className = 'ranking-item__badge';
      badge.textContent = '나';
      nickname.append(' ', badge);
    }

    const score = document.createElement('span');
    score.className = 'ranking-item__score';
    score.textContent = `${entry.score}점`;
    const hits = document.createElement('span');
    hits.className = 'ranking-item__hits';
    hits.textContent = `${entry.correctCount}/${entry.totalCount}`;
    score.append(' ', hits);

    const date = document.createElement('span');
    date.className = 'ranking-item__date';
    date.textContent = formatPlayedAt(entry.recordedAt);

    item.append(rankLabel, figure, nickname, score, date);
    return item;
  }

  function currentTab(): RankingTab {
    return TABS.find((item) => item.key === activeKey) ?? TABS[0];
  }

  /** role=status는 늘 펼쳐 둔다(«숨긴 채로 채우면 낭독되지 않는다»). 같은 말이면 다시 넣지 않는다 */
  function setOnlineStatus(text: string): void {
    if (el.onlineStatus.textContent === text) return;
    el.onlineStatus.textContent = text;
  }

  async function render(): Promise<void> {
    syncTabs();
    if (activeScope() === 'online') {
      // 불러오는 중인 상태를 그리고 곧바로 돌아온다 — app.ts는 그린 뒤 화면을 옮기므로(«내용을 그린 뒤
      // goTo») 응답을 기다리면 홈의 입구가 멈춘 것처럼 보인다. 응답이 오면 그 자리에서 다시 그린다
      void renderOnline();
      return;
    }
    await renderLocal();
  }

  async function renderLocal(): Promise<void> {
    onlineRequest += 1; // 온라인에서 넘어왔으면 그 응답은 이제 쓸 데가 없다
    el.onlineStatus.hidden = true;
    el.onlineStatus.textContent = '';
    el.window.hidden = true;

    const tab = currentTab();
    // 「모든 기록 지우기」는 이 탭이 아니라 **모든 랭킹**을 지운다. 그래서 숨기는 기준도 모든
    // 탭이다 — 이 탭이 비었어도 다른 탭에 기록이 있으면 지울 것이 있다 (FR-6.6)
    const lists = await Promise.all(TABS.map((item) => loadRankings(item.target)));
    // 기다리는 사이 온라인으로 옮겼으면 그 화면을 덮지 않는다
    if (activeScope() !== 'local') return;
    const records = lists[TABS.indexOf(tab)] ?? [];
    const noRecords = lists.every((list) => list.length === 0);
    el.footer.hidden = noRecords;
    // 내보낼 것이 없으면 내보내기도 거둔다 — 빈 파일을 선생님께 보내게 하지 않는다
    el.exportBlock.hidden = noRecords;
    if (noRecords) resetExport();

    el.list.replaceChildren();

    if (records.length === 0) {
      // 가상 기록을 심지 않고 빈 상태를 그대로 안내한다 (FR-6.12).
      // 첫 판은 이 탭의 판이다 — 홈으로 보내 분야를 다시 고르게 하지 않는다.
      // 다만 그 판을 열 수 없으면(문제를 불러오지 못했다) 시작을 권하지 않고 홈으로 돌려보낸다
      emptyAction = canStart(tab.target) ? 'start' : 'home';
      el.emptyMessage.textContent = `${tab.label} 기록이 아직 없어요.`;
      el.emptyStartButton.textContent = emptyAction === 'start' ? `${tab.label} 시작하기` : '홈으로';
      el.empty.hidden = false;
      el.list.hidden = true;
      return;
    }

    el.empty.hidden = true;
    el.list.hidden = false;
    records.forEach((record, index) => el.list.append(createItem(record, index + 1)));
  }

  /**
   * 온라인 랭킹 (FR-7.13 2단계). 이 브라우저의 기록 칸(내보내기·지우기)은 거둔다 — 서버 기록은 지우거나
   * 내보낼 수 없다. 기다리는 동안·비었을 때·못 읽었을 때 무슨 일인지 상태 줄과 빈 칸이 말한다
   */
  async function renderOnline(): Promise<void> {
    if (!online) return;
    const tab = currentTab();
    const shown = period;
    const request = ++onlineRequest;
    el.footer.hidden = true;
    el.exportBlock.hidden = true;
    el.list.replaceChildren();
    el.list.hidden = true;
    el.empty.hidden = true;
    el.window.hidden = true;
    el.onlineStatus.hidden = false;
    setOnlineStatus('온라인 랭킹을 불러오는 중…');

    let result: OnlineRankingLoad;
    try {
      result = await online.load(tab.target, shown);
    } catch (error) {
      console.warn('[온라인 랭킹] 읽지 못했습니다', error);
      result = { status: 'error', message: '연결을 확인하고 다시 시도해 주세요.' };
    }
    // 기다리는 사이 다른 탭·기간·범위를 골랐으면 이 답은 버린다
    if (request !== onlineRequest || activeScope() !== 'online') return;

    if (result.status === 'unsupported') {
      // 이 API에는 서버 랭킹이 없다. 범위 탭을 거두고 이 브라우저의 기록으로 돌아간다
      const hadFocus = document.activeElement === el.scopeOnline || document.activeElement === el.scopeLocal;
      onlineMissing = true;
      scope = 'local';
      await render();
      keepFocus(hadFocus, () => el.scopeTabs.hidden);
      return;
    }

    if (result.status === 'error') {
      // 아무도 온라인을 고르지 않았고 이 API가 랭킹을 아는지도 모른 채 읽지 못했다(서버에 닿지 않는다, 저장된
      // 닉네임이 금칙 규칙에 걸려 세션을 열지 않았다). 오류 대신 이 브라우저의 기록을 보인다 — 범위 탭은 그대로라
      // «온라인 랭킹»을 눌러 다시 물을 수 있고, 그때는 아래의 오류와 다음 행동을 말한다
      if (scope === null && online.available() !== true) {
        defaultFellBack = true;
        await render();
        return;
      }
      // 다시 해도 같은 실패(닉네임)면 「다시 시도」를 권하지 않고 닉네임을 고칠 홈으로 보낸다
      const toHome = result.action === 'home';
      setOnlineStatus('온라인 랭킹을 불러오지 못했어요.');
      emptyAction = toHome ? 'home' : 'retry';
      el.emptyMessage.textContent = result.message;
      el.emptyStartButton.textContent = toHome ? '홈으로' : '다시 시도';
      el.empty.hidden = false;
      return;
    }

    const { board } = result;
    if (board.window) {
      el.window.textContent = `${rankingWeekLabel(board.window)} · 월요일 0시(한국 시간)에 새로 시작해요.`;
      el.window.hidden = false;
    }
    setOnlineStatus(onlineRankingSummary(tab.label, shown, board.entries));
    if (board.entries.length === 0) {
      // 가상 기록을 심지 않는다 (FR-6.12). 기록은 온라인 방에서 끝까지 푼 판에서만 생긴다
      emptyAction = 'online';
      el.emptyMessage.textContent = tab.target.mode === 'all'
        ? '온라인 방에서 전체 도전 판을 끝까지 풀면 점수가 여기에 남아요.'
        : `온라인 방에서 ${tab.label} 판을 끝까지 풀면 점수가 여기에 남아요.`;
      el.emptyStartButton.textContent = '온라인 방 열기';
      el.empty.hidden = false;
      return;
    }
    el.list.hidden = false;
    board.entries.forEach((entry) => el.list.append(createOnlineItem(entry)));
  }

  // ── 전체 초기화 (FR-6.6) ───────────────────────────────────────
  // window.confirm 대신 페이지 안 다이얼로그를 쓴다.

  function openClearDialog(): void {
    el.dialog.hidden = false;
    el.dialogCancel.focus();
  }

  function closeClearDialog(): void {
    if (el.dialog.hidden) return;
    el.dialog.hidden = true;
    el.clearButton.focus(); // 열기 전 자리로 되돌린다
  }

  async function confirmClear(): Promise<void> {
    el.dialog.hidden = true;
    await clearRankings();
    highlightId = null;
    await render();
    // 지우고 나면 「모든 기록 지우기」가 숨는다. 거기 두면 포커스가 <body>로 떨어지므로
    // 빈 탭이 주는 다음 행동(「… 시작하기」)으로 옮긴다 — 되돌릴 수 없는 조작 뒤에는 갈 곳을 남긴다
    (el.empty.hidden ? el.clearButton : el.emptyStartButton).focus();
    announce('저장된 기록을 모두 지웠어요.');
  }

  // ── 기록 내보내기 (N02) ─────────────────────────────────────────
  // 학생이 F12 콘솔에 스니펫을 붙여 넣던 길을 화면으로 옮겼다. 파일(Blob + <a download>)이 먼저고,
  // 앱 안 브라우저처럼 내려받기가 막힌 곳을 위해 「기록 복사」를 늘 함께 둔다. 클립보드도 막혔으면
  // 글을 펼쳐 모두 골라 둔다(대기실 초대 링크와 같은 길). 의존성 없이 브라우저 기능만 쓴다.

  /** 한 번에 하나만. 겹쳐 누르면 같은 파일이 둘 생긴다 */
  let exporting = false;

  /** role=status 는 늘 펼쳐져 있다(«먼저 펼치고 넣는다»). 같은 말을 다시 넣어도 낭독되게 비웠다 넣는다 */
  function setExportStatus(text: string): void {
    el.exportStatus.textContent = '';
    el.exportStatus.textContent = text;
  }

  function resetExport(): void {
    el.exportText.hidden = true;
    el.exportText.value = '';
    el.exportStatus.textContent = '';
  }

  /** 파일로 내려받는다. 브라우저가 내려받기를 시작할 수 없으면 false — 실제로 저장됐는지는 알 길이 없다 */
  function saveFile(fileName: string, text: string): boolean {
    if (typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      // 곧바로 거두면 일부 브라우저가 내려받기를 시작하기 전에 주소를 잃는다
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    } catch (error) {
      console.warn('[기록 내보내기] 파일을 만들지 못했습니다', error);
      return false;
    }
  }

  async function copyOut(text: string, count: number, prefix = ''): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      el.exportText.hidden = true;
      el.exportText.value = '';
      setExportStatus(`${prefix}기록 ${count}개를 복사했어요. 메시지나 메모에 붙여 넣어 선생님께 보내 주세요.`);
    } catch {
      // 클립보드를 못 쓰는 브라우저(권한·비보안 문맥)는 글을 펼쳐 모두 골라 둔다
      el.exportText.value = text;
      el.exportText.hidden = false;
      el.exportText.focus();
      el.exportText.select();
      setExportStatus(`${prefix}복사하지 못했어요. 아래 글이 모두 골라져 있으니 복사해서 보내 주세요.`);
    }
  }

  async function exportOut(how: 'file' | 'copy'): Promise<void> {
    if (exporting) return;
    exporting = true;
    try {
      const file = await exportRecords();
      const text = JSON.stringify(file.data, null, 2);
      const count = file.data.records.length;
      if (how === 'copy') {
        await copyOut(text, count);
      } else if (saveFile(file.fileName, text)) {
        el.exportText.hidden = true;
        setExportStatus(`기록 ${count}개를 «${file.fileName}» 파일로 내보냈어요. 파일이 보이지 않으면 「기록 복사」를 눌러 주세요.`);
      } else {
        await copyOut(text, count, '파일로 내려받지 못해 대신 ');
      }
    } catch (error) {
      console.warn('[기록 내보내기] 실패', error);
      setExportStatus('기록을 내보내지 못했어요. 잠시 뒤 다시 눌러 주세요.');
    } finally {
      exporting = false;
    }
  }

  el.exportFile.addEventListener('click', () => { void exportOut('file'); });
  el.exportCopy.addEventListener('click', () => { void exportOut('copy'); });

  buildTabs();

  el.homeButton.addEventListener('click', () => onHome());
  // 글자를 그린 때와 같은 판정으로 고른다. 열 수 없는 판을 열려다 홈으로 튕기지 않는다
  el.emptyStartButton.addEventListener('click', () => {
    const { target } = currentTab();
    if (emptyAction === 'retry') {
      const hadFocus = document.activeElement === el.emptyStartButton;
      void render().then(() => keepFocus(hadFocus, () => el.empty.hidden));
    } else if (emptyAction === 'online') {
      online?.onOpenOnline();
    } else if (emptyAction === 'start' && canStart(target)) {
      onStart(target);
    } else {
      onHome();
    }
  });

  function chooseScope(next: RankingScope): void {
    if (activeScope() === next) return;
    scope = next;
    highlightId = null;
    void render();
  }
  el.scopeOnline.addEventListener('click', () => chooseScope('online'));
  el.scopeLocal.addEventListener('click', () => chooseScope('local'));

  function choosePeriod(next: OnlineRankingPeriod): void {
    if (period === next) return;
    period = next;
    void render();
  }
  el.periodWeek.addEventListener('click', () => choosePeriod('week'));
  el.periodAll.addEventListener('click', () => choosePeriod('all'));

  el.clearButton.addEventListener('click', openClearDialog);
  el.dialogCancel.addEventListener('click', closeClearDialog);
  el.dialogConfirm.addEventListener('click', confirmClear);

  document.addEventListener('keydown', (event) => {
    if (el.dialog.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeClearDialog();
    } else if (event.key === 'Tab') {
      trapFocus(el.dialog, event);
    }
  });

  return {
    hide() {
      onlineRequest += 1; // 떠난 화면에 늦은 응답을 그리지 않는다
      walker.hide();
    },

    async show({
      target = null,
      highlightId: nextHighlight = null,
      characterId,
      scope: nextScope,
      period: nextPeriod,
    } = {}) {
      walker.show(characterId);
      if (target) {
        const matched = TABS.find(
          (tab) =>
            tab.target.mode === target.mode &&
            (tab.target.category ?? null) === (target.category ?? null)
        );
        if (matched) activeKey = matched.key;
      }
      // 부른 곳이 범위를 말하면 그것이고(결과 화면의 «랭킹 보기»는 이 브라우저의 기록, 온라인 결과의 «온라인
      // 랭킹 보기»는 온라인), 아니면 이 페이지에서 마지막으로 고른 범위, 아무도 고르지 않았으면 `defaultScope()`
      // (온라인 랭킹이 있으면 온라인, 모르면 물어보고 못 읽으면 이 브라우저의 기록)다
      if (nextScope) scope = nextScope;
      if (nextPeriod) period = nextPeriod;

      highlightId = nextHighlight;
      closeClearDialog();
      // 지난번 내보내기의 안내와 펼친 글은 이번 방문의 것이 아니다
      resetExport();
      await render();
    },
  };
}
