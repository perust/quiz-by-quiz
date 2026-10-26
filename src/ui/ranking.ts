// 랭킹 화면 렌더링 (FR-6.2 ~ FR-6.6, FR-6.10, FR-6.12) · 기록 내보내기 (N02)
// 기록을 어디서 읽고 지우고 내보내는지는 app.js가 넘겨준 콜백이 안다.
// 이 파일은 저장소를 직접 알지 못한다.

import { CATEGORIES } from '../constants.js';
import { need, needOne } from '../dom.js';
import { createScreenWalker, pointBelowRightEdge } from './screen-walker.js';
import { formatPlayedAt } from './format.js';
import { trapFocus } from './quiz.js';
import { announce } from './screens.js';
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
}

/**
 * target을 주면 그 랭킹 탭을 열고, highlightId를 주면 그 기록을 강조한다.
 */
export interface RankingView {
  target?: RankingTarget | null;
  highlightId?: string | null;
  characterId?: string;
}

export interface RankingScreen {
  /** 랭킹 화면을 그린다 */
  show(view?: RankingView): Promise<void>;

  /** 화면을 떠난다. 캐릭터와 손가락 조작부를 함께 거둔다 */
  hide(): void;
}

export function createRankingScreen(
  { onHome, onStart, canStart, loadRankings, clearRankings, exportRecords }: RankingScreenDeps,
): RankingScreen {
  const el = {
    tabs: need('ranking-tabs'),
    header: needOne<HTMLElement>('[data-screen="ranking"] .ranking-header'),
    character: need('ranking-character'),
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

  const tabButtons = new Map<string, HTMLButtonElement>();

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
        render();
      });

      tabButtons.set(tab.key, button);
      el.tabs.append(button);
    }
  }

  function syncTabs(): void {
    for (const [key, button] of tabButtons) {
      const isActive = key === activeKey;
      button.classList.toggle('ranking-tab--active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
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

  function currentTab(): RankingTab {
    return TABS.find((item) => item.key === activeKey) ?? TABS[0];
  }

  async function render(): Promise<void> {
    syncTabs();

    const tab = currentTab();
    // 「모든 기록 지우기」는 이 탭이 아니라 **모든 랭킹**을 지운다. 그래서 숨기는 기준도 모든
    // 탭이다 — 이 탭이 비었어도 다른 탭에 기록이 있으면 지울 것이 있다 (FR-6.6)
    const lists = await Promise.all(TABS.map((item) => loadRankings(item.target)));
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
      el.emptyMessage.textContent = `${tab.label} 기록이 아직 없어요.`;
      el.emptyStartButton.textContent = canStart(tab.target) ? `${tab.label} 시작하기` : '홈으로';
      el.empty.hidden = false;
      el.list.hidden = true;
      return;
    }

    el.empty.hidden = true;
    el.list.hidden = false;
    records.forEach((record, index) => el.list.append(createItem(record, index + 1)));
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
    if (canStart(target)) onStart(target);
    else onHome();
  });
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
      walker.hide();
    },

    async show({ target = null, highlightId: nextHighlight = null, characterId } = {}) {
      walker.show(characterId);
      if (target) {
        const matched = TABS.find(
          (tab) =>
            tab.target.mode === target.mode &&
            (tab.target.category ?? null) === (target.category ?? null)
        );
        if (matched) activeKey = matched.key;
      }

      highlightId = nextHighlight;
      closeClearDialog();
      // 지난번 내보내기의 안내와 펼친 글은 이번 방문의 것이 아니다
      resetExport();
      await render();
    },
  };
}
