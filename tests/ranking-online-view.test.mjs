import test from 'node:test';
import assert from 'node:assert/strict';

// 랭킹 화면의 온라인 랭킹 (FR-7.13 2단계)과 온라인 결과의 «랭킹에 기록됐어요».
// 화면 모듈을 가짜 DOM 위에 실제로 띄워 본다.
// - 범위 탭(온라인 랭킹 · 이 브라우저의 기록), 기간(이번 주 · 전체), 같은 분야 탭 여섯. 이 브라우저의 기록은
//   예전 그대로다(지우기·내보내기도 그쪽에만 있다).
// - 서버가 가린 내 기록에 «나». 비었을 때·못 읽었을 때 무슨 일인지 상태 줄과 빈 칸이 말한다.
// - 랭킹을 모르는 API(세션에 rankings 없음)·로컬 방이면 범위 탭을 거두고 예전 화면만 보인다.

class FakeClassList {
  #names = new Set();
  add(...names) { names.forEach((name) => this.#names.add(name)); }
  remove(...names) { names.forEach((name) => this.#names.delete(name)); }
  toggle(name, force) {
    const on = force ?? !this.#names.has(name);
    if (on) this.#names.add(name);
    else this.#names.delete(name);
    return on;
  }
  contains(name) { return this.#names.has(name); }
}

class FakeElement extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this.className = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.offsetWidth = 40;
    this.offsetHeight = 48;
  }
  get textContent() {
    return this._text + this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }
  remove() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const screen = new FakeElement('section');
const header = new FakeElement('header');

globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};
globalThis.document = {
  body: new FakeElement('body'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '[data-screen="ranking"]') return screen;
    if (selector === '[data-screen="ranking"] .ranking-header') return header;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { createRankingScreen, rankingWeekLabel, onlineRankingSummary } = await import('../js/ui/ranking.js');
const { createOnlineResultScreen, onlineMatchRankingTarget } = await import('../js/ui/online-result.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let index = 0; index < 4; index += 1) await tick(); };

const WEEK = { start: '2026-10-25T15:00:00+00:00', end: '2026-11-01T15:00:00+00:00' };

function entry(rank, changes = {}) {
  return {
    rank, nickname: `참가자${rank}`, characterId: 'slime-blue', score: 100 - rank * 10,
    correctCount: 10 - rank, totalCount: 10, recordedAt: '2026-10-27T03:10:52+00:00', isMine: false,
    ...changes,
  };
}

/** 지금 화면에 걸린 온라인 대답. 판·기간마다 고를 수 있다 */
let answer = () => ({ status: 'ok', board: { target: null, period: 'week', window: WEEK, entries: [] } });
let available = true;
const loads = [];
const opened = [];
const localRecords = {
  history: [{
    id: 'local-1', nickname: '로컬기록', mode: 'category', category: 'history', score: 70,
    correctCount: 7, totalCount: 10, durationMs: 1000, playedAt: '2026-10-27T00:00:00.000Z',
  }],
};
const keyOf = (target) => (target.mode === 'all' ? 'all' : target.category);

const ranking = createRankingScreen({
  onHome: () => opened.push('home'),
  onStart: (target) => opened.push(target),
  canStart: () => true,
  loadRankings: async (target) => localRecords[keyOf(target)] ?? [],
  clearRankings: async () => {},
  exportRecords: async () => ({ fileName: 'x.json', data: { records: [] } }),
  online: {
    available: () => available,
    load: async (target, period) => {
      loads.push({ target, period });
      return answer(target, period);
    },
    onOpenOnline: () => opened.push('online'),
  },
});

const HISTORY = { mode: 'category', category: 'history' };

function rows() {
  return byId('ranking-list').children;
}

test('처음 열면 온라인 랭킹의 이번 주다: 범위·기간 탭이 보이고, 이 브라우저의 기록 칸은 거둔다', async () => {
  available = true;
  loads.length = 0;
  let arrive;
  answer = (target, period) => new Promise((resolve) => {
    arrive = () => resolve({
      status: 'ok',
      board: { target, period, window: WEEK, entries: [entry(1), entry(2, { isMine: true }), entry(3)] },
    });
  });
  await ranking.show({ target: HISTORY });
  // 응답을 기다리지 않고 불러오는 중을 그린 채 돌아온다(app.ts가 곧바로 화면을 옮긴다)
  assert.equal(byId('ranking-online-status').textContent, '온라인 랭킹을 불러오는 중…');
  assert.equal(byId('ranking-online-status').hidden, false);
  assert.equal(byId('ranking-list').hidden, true);
  arrive();
  await settle();

  assert.deepEqual(loads, [{ target: HISTORY, period: 'week' }]);
  assert.equal(byId('ranking-scope-tabs').hidden, false);
  assert.equal(byId('ranking-scope-online').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('ranking-scope-local').getAttribute('aria-pressed'), 'false');
  assert.equal(byId('ranking-periods').hidden, false);
  assert.equal(byId('ranking-period-week').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('ranking-scope-note').textContent, '온라인 방에서 끝까지 푼 판이 모두 남아요. 같은 점수면 먼저 남긴 기록이 위예요.');
  assert.equal(byId('ranking-footer').hidden, true, '서버 기록은 지울 수 없다');
  assert.equal(byId('ranking-export').hidden, true, '서버 기록은 이 브라우저의 파일로 내보내지 않는다');
  assert.equal(byId('ranking-window').hidden, false);
  assert.match(byId('ranking-window').textContent, /^10월 26일 \(월\) ~ 11월 1일 \(일\) · 월요일 0시\(한국 시간\)에 새로 시작해요\.$/);
  assert.equal(byId('ranking-online-status').textContent, '이번 주 한국사 온라인 랭킹 · 기록 3개 · 내 기록 1개');

  assert.equal(byId('ranking-list').hidden, false);
  assert.equal(byId('ranking-empty').hidden, true);
  assert.equal(rows().length, 3);
  const [first, mine] = rows();
  const [rank, figure, nickname, score, date] = first.children;
  assert.equal(rank.textContent, '1');
  assert.equal(figure.className, 'ranking-item__figure');
  assert.equal(figure.attributes['aria-hidden'], 'true', '캐릭터는 그림이다 — 이름은 옆 글자가 말한다');
  assert.equal(nickname.textContent, '참가자1');
  assert.equal(score.textContent, '90점 9/10');
  assert.match(date.textContent, /^2026\.10\.27 \d\d:10$/);
  assert.ok(mine.classList.contains('ranking-item--mine'));
  assert.equal(mine.children[2].textContent, '참가자2 나', '내 기록은 색과 함께 «나» 글자로 짚는다');
  assert.ok(!first.classList.contains('ranking-item--mine'));
});

test('기간·분야를 바꾸면 그 판을 다시 묻고, 늦게 온 앞 대답은 버린다', async () => {
  const pending = [];
  answer = (target, period) => new Promise((resolve) => pending.push(() => resolve({
    status: 'ok',
    board: { target, period, window: period === 'week' ? WEEK : null, entries: [entry(1, { nickname: `${keyOf(target)}-${period}` })] },
  })));
  loads.length = 0;
  byId('ranking-period-all').click();
  assert.equal(byId('ranking-period-all').getAttribute('aria-pressed'), 'true');
  // 여섯 탭 가운데 전체 도전(맨 앞)을 누른다
  byId('ranking-tabs').children[0].click();
  assert.deepEqual(loads.map(({ target, period }) => `${keyOf(target)}-${period}`), ['history-all', 'all-all']);

  pending[1]();
  await settle();
  pending[0]();
  await settle();
  assert.equal(rows()[0].children[2].textContent, 'all-all', '앞에서 물은 한국사 대답이 전체 도전 화면을 덮지 않는다');
  assert.equal(byId('ranking-window').hidden, true, '전체 기간에는 주가 없다');
  assert.equal(byId('ranking-online-status').textContent, '전체 기간 전체 도전 온라인 랭킹 · 기록 1개');
});

test('빈 온라인 랭킹은 가상 기록 없이 무슨 판을 끝내면 남는지 말하고 온라인 방을 연다', async () => {
  answer = (target, period) => ({ status: 'ok', board: { target, period, window: WEEK, entries: [] } });
  opened.length = 0;
  await ranking.show({ target: { mode: 'category', category: 'science' }, scope: 'online', period: 'week' });
  await settle();

  assert.equal(byId('ranking-online-status').textContent, '이번 주 과학 온라인 랭킹에 아직 기록이 없어요.');
  assert.equal(byId('ranking-list').hidden, true);
  assert.equal(byId('ranking-empty').hidden, false);
  assert.equal(byId('ranking-empty-message').textContent, '온라인 방에서 과학 판을 끝까지 풀면 점수가 여기에 남아요.');
  assert.equal(byId('ranking-empty-start').textContent, '온라인 방 열기');
  byId('ranking-empty-start').click();
  assert.deepEqual(opened, ['online'], '이 탭의 혼자 하기 판이 아니라 온라인 방으로 간다');
});

test('못 읽었으면 그렇다고 말하고 「다시 시도」로 다시 묻는다 — 통하면 포커스는 지금 탭으로', async () => {
  let fail = true;
  answer = (target, period) => (fail
    ? { status: 'error', message: '연결을 확인하고 다시 시도해 주세요.' }
    : { status: 'ok', board: { target, period, window: WEEK, entries: [entry(1)] } });
  loads.length = 0;
  await ranking.show({ target: HISTORY, scope: 'online', period: 'week' });
  await settle();
  assert.equal(byId('ranking-online-status').textContent, '온라인 랭킹을 불러오지 못했어요.');
  assert.equal(byId('ranking-empty-message').textContent, '연결을 확인하고 다시 시도해 주세요.');
  assert.equal(byId('ranking-empty-start').textContent, '다시 시도');

  fail = false;
  byId('ranking-empty-start').focus();
  byId('ranking-empty-start').click();
  await settle();
  assert.equal(loads.length, 2);
  assert.equal(byId('ranking-empty').hidden, true);
  assert.equal(rows().length, 1);
  assert.equal(globalThis.document.activeElement, byId('ranking-tabs').children[1], '사라진 버튼 대신 한국사 탭');

  // 대답이 던져도(연결 끊김) 같은 말이다
  answer = () => { throw new Error('Failed to fetch'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await ranking.show({ target: HISTORY, scope: 'online' });
    await settle();
  } finally {
    console.warn = warn;
  }
  assert.equal(byId('ranking-online-status').textContent, '온라인 랭킹을 불러오지 못했어요.');
  assert.equal(byId('ranking-empty-start').textContent, '다시 시도');
});

test('이 브라우저의 기록은 예전 화면 그대로다 — 결과 화면이 부르면 그 범위로 연다', async () => {
  answer = (target, period) => ({ status: 'ok', board: { target, period, window: WEEK, entries: [entry(1)] } });
  loads.length = 0;
  await ranking.show({ target: HISTORY, scope: 'local', highlightId: 'local-1' });
  await settle();
  assert.equal(loads.length, 0, '온라인 랭킹을 묻지 않는다');
  assert.equal(byId('ranking-scope-local').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('ranking-periods').hidden, true);
  assert.equal(byId('ranking-online-status').hidden, true);
  assert.equal(byId('ranking-scope-note').textContent, '이 브라우저에 저장된 내 기록이에요.');
  assert.equal(byId('ranking-footer').hidden, false);
  assert.equal(byId('ranking-export').hidden, false);
  assert.equal(rows()[0].children[1].textContent, '로컬기록 방금 등록');

  // 범위 탭으로 온라인을 고르면 다시 묻는다. 홈에서 다시 열면 마지막 범위를 기억한다
  byId('ranking-scope-online').click();
  await settle();
  assert.equal(loads.length, 1);
  await ranking.show({ target: HISTORY });
  await settle();
  assert.equal(byId('ranking-scope-online').getAttribute('aria-pressed'), 'true');
});

test('랭킹을 모르는 API면 한 번 물어본 뒤 범위 탭을 거두고 예전 화면으로 돌아간다', async () => {
  available = null; // 아직 세션을 열지 않아 모른다
  answer = () => ({ status: 'unsupported' });
  loads.length = 0;
  await ranking.show({ target: HISTORY, scope: 'online' });
  await settle();
  assert.equal(loads.length, 1);
  assert.equal(byId('ranking-scope-tabs').hidden, true, '온라인 랭킹을 권하지 않는다');
  assert.equal(byId('ranking-periods').hidden, true);
  assert.equal(byId('ranking-online-status').hidden, true);
  assert.equal(byId('ranking-scope-note').textContent, '이 브라우저에 저장된 내 기록이에요.');
  assert.equal(rows()[0].children[1].textContent, '로컬기록');

  // 다시 열어도 묻지 않는다
  await ranking.show({ target: HISTORY, scope: 'online' });
  await settle();
  assert.equal(loads.length, 1);
});

test('온라인 랭킹이 없다고 이미 알면(로컬 방·이전 API) 묻지도 않고 범위 탭도 그리지 않는다', async () => {
  const quiet = createRankingScreen({
    onHome() {}, onStart() {}, canStart: () => true,
    loadRankings: async (target) => localRecords[keyOf(target)] ?? [],
    clearRankings: async () => {},
    exportRecords: async () => ({ fileName: 'x.json', data: { records: [] } }),
    online: { available: () => false, load: async () => assert.fail('묻지 않는다'), onOpenOnline() {} },
  });
  await quiet.show({ target: HISTORY });
  await settle();
  assert.equal(byId('ranking-scope-tabs').hidden, true);
  assert.equal(byId('ranking-scope-note').textContent, '이 브라우저에 저장된 내 기록이에요.');
});

test('주의 두 끝은 서울 날짜다 — 끝(다음 월요일 0시)은 하루 앞인 일요일로 읽는다', () => {
  assert.equal(rankingWeekLabel(WEEK), '10월 26일 (월) ~ 11월 1일 (일)');
  assert.equal(
    onlineRankingSummary('과학', 'all', [entry(1)]),
    '전체 기간 과학 온라인 랭킹 · 기록 1개',
  );
});

test('온라인 결과: 서버가 랭킹에 남긴 판이면 그렇다고 말하고 그 분야의 이번 주 랭킹을 연다', () => {
  const openedRankings = [];
  const result = createOnlineResultScreen({
    onAgain: async () => {}, onRoom() {}, onHome() {}, getPlayerId: () => 'me',
    onOpenRanking: (target) => openedRankings.push(target),
  });
  const snapshot = (changes) => ({
    matchId: '32345678-1234-5678-9234-567812345678', state: 'finished', categoryId: 'geography', gameMode: true,
    currentPosition: 10, totalQuestions: 10, deadlineAt: null, question: null, ownSubmission: null, reveal: null,
    scores: [{ playerId: 'me', nickname: '나야', characterId: 'slime-blue', score: 70, correctCount: 7, answeredCount: 10 }],
    ...changes,
  });

  result.show(snapshot({ rankingRecorded: true }), { inRoom: true });
  assert.equal(byId('online-final-recorded').hidden, false);
  assert.equal(byId('online-final-open-ranking').hidden, false);
  byId('online-final-open-ranking').click();
  assert.deepEqual(openedRankings, [{ mode: 'category', category: 'geography' }]);

  // 이전 API의 판(필드 없음)이나 남지 않은 판은 랭킹 이야기를 하지 않는다
  for (const changes of [{}, { rankingRecorded: false }]) {
    result.show(snapshot(changes), { inRoom: true });
    assert.equal(byId('online-final-recorded').hidden, true);
    assert.equal(byId('online-final-open-ranking').hidden, true);
  }
  assert.deepEqual(onlineMatchRankingTarget({ categoryId: null }), { mode: 'all', category: null });
  result.hide();
  assert.equal(byId('online-final-recorded').hidden, true);
});
