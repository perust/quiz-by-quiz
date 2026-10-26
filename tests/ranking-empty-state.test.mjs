import test from 'node:test';
import assert from 'node:assert/strict';

// 빈 랭킹 탭 (FR-6.12, FR-6.6, U23).
// 「퀴즈 시작하기」는 홈으로만 돌려보내 분야를 다시 고르게 했고, 기록이 하나도 없어도
// 「모든 기록 지우기」가 보였다. 화면 모듈을 가짜 DOM 위에 실제로 띄워 확인한다.

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
    this.textContent = '';
    this.className = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.offsetWidth = 40;
    this.offsetHeight = 48;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
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

const { createRankingScreen } = await import('../js/ui/ranking.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 저장된 기록. 키는 'all' 또는 카테고리 id */
let stored = {};
const keyOf = (target) => (target.mode === 'all' ? 'all' : target.category);
const record = (id, category) => ({
  id, nickname: '퀴즈왕', mode: 'category', category, score: 70,
  correctCount: 7, totalCount: 10, durationMs: 1000, playedAt: '2026-10-27T00:00:00.000Z',
});

const started = [];
const ranking = createRankingScreen({
  onHome: () => started.push('home'),
  onStart: (target) => started.push(target),
  loadRankings: async (target) => stored[keyOf(target)] ?? [],
  clearRankings: async () => { stored = {}; },
});

test('빈 탭의 행동은 그 탭 이름으로 판을 곧바로 열고, 기록이 하나도 없으면 지울 버튼을 숨긴다', async () => {
  stored = {};
  await ranking.show({ target: { mode: 'all', category: null } });
  assert.equal(byId('ranking-empty').hidden, false);
  assert.equal(byId('ranking-empty-start').textContent, '전체 도전 시작하기');
  assert.equal(byId('ranking-footer').hidden, true, '어느 탭에도 기록이 없으면 지울 것이 없다');

  byId('ranking-empty-start').click();
  assert.deepEqual(started, [{ mode: 'all', category: null }], '홈으로 돌려보내지 않고 이 탭의 판을 연다');

  started.length = 0;
  await ranking.show({ target: { mode: 'category', category: 'science' } });
  assert.equal(byId('ranking-empty-start').textContent, '과학 시작하기');
  byId('ranking-empty-start').click();
  assert.deepEqual(started, [{ mode: 'category', category: 'science' }]);
});

test('지금 탭이 비었어도 다른 탭에 기록이 있으면 「모든 기록 지우기」는 남는다 — 모든 랭킹을 지우는 버튼이다', async () => {
  stored = { history: [record('a', 'history')] };
  await ranking.show({ target: { mode: 'category', category: 'science' } });
  assert.equal(byId('ranking-empty').hidden, false);
  assert.equal(byId('ranking-footer').hidden, false);

  await ranking.show({ target: { mode: 'category', category: 'history' } });
  assert.equal(byId('ranking-empty').hidden, true);
  assert.equal(byId('ranking-list').hidden, false);
  assert.equal(byId('ranking-footer').hidden, false);
});

test('모두 지운 뒤 포커스는 숨은 버튼이 아니라 빈 탭의 시작 행동으로 간다', async () => {
  stored = { history: [record('a', 'history')] };
  await ranking.show({ target: { mode: 'category', category: 'history' } });
  byId('ranking-clear').click();
  assert.equal(byId('clear-dialog').hidden, false);

  byId('clear-confirm').click();
  await tick();
  await tick();
  assert.deepEqual(stored, {});
  assert.equal(byId('ranking-footer').hidden, true);
  assert.equal(globalThis.document.activeElement, byId('ranking-empty-start'), '되돌릴 수 없는 조작 뒤에는 갈 곳을 남긴다');
  assert.equal(byId('announcer').textContent, '저장된 기록을 모두 지웠습니다.');
});
