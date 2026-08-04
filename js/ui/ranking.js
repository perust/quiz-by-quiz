// 랭킹 화면 렌더링 (FR-6.2 ~ FR-6.6, FR-6.10, FR-6.12)
// 기록을 어디서 읽고 지우는지는 app.js가 넘겨준 콜백이 안다.
// 이 파일은 저장소를 직접 알지 못한다.

import { CATEGORIES } from '../constants.js';
import { formatPlayedAt } from './format.js';
import { trapFocus } from './quiz.js';
import { announce } from './screens.js';

/**
 * 탭 하나가 랭킹 하나에 대응한다 (FR-6.2).
 * 전체 모드는 카테고리가 없으므로 category가 null이다.
 */
const TABS = [
  { key: 'all', label: '전체 도전', target: { mode: 'all', category: null } },
  ...CATEGORIES.map((category) => ({
    key: category.id,
    label: category.name,
    target: { mode: 'category', category: category.id },
  })),
];

/**
 * @param {{
 *   onHome: () => void,
 *   loadRankings: (target: object) => Promise<object[]>,
 *   clearRankings: () => Promise<void>
 * }} callbacks
 */
export function createRankingScreen({ onHome, loadRankings, clearRankings }) {
  const el = {
    tabs: document.getElementById('ranking-tabs'),
    list: document.getElementById('ranking-list'),
    empty: document.getElementById('ranking-empty'),
    homeButton: document.getElementById('ranking-home'),
    clearButton: document.getElementById('ranking-clear'),
    dialog: document.getElementById('clear-dialog'),
    dialogCancel: document.getElementById('clear-cancel'),
    dialogConfirm: document.getElementById('clear-confirm'),
  };

  let activeKey = TABS[0].key;
  /** 방금 등록한 기록 ID. 다른 탭으로 옮기면 지운다 (FR-6.5) */
  let highlightId = null;

  const tabButtons = new Map();

  // ── 탭 ─────────────────────────────────────────────────────────

  function buildTabs() {
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

  function syncTabs() {
    for (const [key, button] of tabButtons) {
      const isActive = key === activeKey;
      button.classList.toggle('ranking-tab--active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  }

  // ── 목록 ───────────────────────────────────────────────────────

  function createItem(record, rank) {
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

  async function render() {
    syncTabs();

    const tab = TABS.find((item) => item.key === activeKey) ?? TABS[0];
    const records = await loadRankings(tab.target);

    el.list.replaceChildren();

    if (records.length === 0) {
      // 가상 기록을 심지 않고 빈 상태를 그대로 안내한다 (FR-6.12)
      el.empty.textContent = `${tab.label} 기록이 아직 없습니다. 한 판 풀고 첫 기록을 남겨보세요.`;
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

  function openClearDialog() {
    el.dialog.hidden = false;
    el.dialogCancel.focus();
  }

  function closeClearDialog() {
    if (el.dialog.hidden) return;
    el.dialog.hidden = true;
    el.clearButton.focus(); // 열기 전 자리로 되돌린다
  }

  async function confirmClear() {
    el.dialog.hidden = true;
    await clearRankings();
    highlightId = null;
    await render();
    el.clearButton.focus();
    announce('저장된 기록을 모두 지웠습니다.');
  }

  buildTabs();

  el.homeButton.addEventListener('click', () => onHome());
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
    /**
     * 랭킹 화면을 그린다.
     *
     * @param {{ target?: object, highlightId?: string|null }} view
     *   target을 주면 그 랭킹 탭을 열고, highlightId를 주면 그 기록을 강조한다.
     */
    async show({ target = null, highlightId: nextHighlight = null } = {}) {
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
      await render();
    },
  };
}
