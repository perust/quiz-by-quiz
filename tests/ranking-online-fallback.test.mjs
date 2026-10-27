import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 랭킹 화면의 온라인 랭킹이 «물어보기 전»(세션 전)에 읽히지 않을 때 (FR-7.13 2단계).
// - 아무도 범위를 고르지 않았는데 이 API가 랭킹을 아는지 모른 채 읽지 못했으면(서버에 닿지 않는다, 저장된 닉네임이
//   금칙 규칙에 걸렸다) 오류 대신 이 브라우저의 기록을 보인다. 범위 탭은 남아 «온라인 랭킹»을 다시 고를 수 있다.
// - 사람이 고른 온라인 범위가 읽히지 않으면 무슨 일인지와 다음 행동을 말한다. 닉네임 탓이면 «다시 시도»(다시 해도
//   같다) 대신 «홈으로»다.
// 다른 랭킹 테스트와 한 화면을 나눠 쓰지 않도록 따로 띄운다(화면의 상태가 테스트 사이에 남는다).

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

const { createRankingScreen } = await import('../js/ui/ranking.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let index = 0; index < 4; index += 1) await tick(); };
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const WEEK = { start: '2026-10-25T15:00:00+00:00', end: '2026-11-01T15:00:00+00:00' };
const HISTORY = { mode: 'category', category: 'history' };
const NICKNAME_MESSAGE = '닉네임에 쓸 수 없는 말이 들어 있어요. 홈에서 닉네임을 바꿔 주세요.';

/** 세션을 아직 열지 않았다(null). 열리면 true가 된다 */
let available = null;
let answer = () => ({ status: 'error', message: '연결을 확인하고 다시 시도해 주세요.' });
const loads = [];
const opened = [];

const ranking = createRankingScreen({
  onHome: () => opened.push('home'),
  onStart: (target) => opened.push(target),
  canStart: () => true,
  loadRankings: async (target) => (target.category === 'history'
    ? [{
      id: 'local-1', nickname: '로컬기록', mode: 'category', category: 'history', score: 70,
      correctCount: 7, totalCount: 10, durationMs: 1000, playedAt: '2026-10-27T00:00:00.000Z',
    }]
    : []),
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

const rows = () => byId('ranking-list').children;

test('세션 전 처음 연 랭킹이 온라인을 읽지 못하면 오류 대신 이 브라우저의 기록이다 — 범위 탭은 남는다', async () => {
  await ranking.show({ target: HISTORY });
  // 처음에는 온라인을 보여 주며 묻는다
  assert.equal(loads.length, 1);
  await settle();

  assert.equal(byId('ranking-scope-tabs').hidden, false, '«온라인 랭킹»을 다시 고를 수 있다');
  assert.equal(byId('ranking-scope-local').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('ranking-scope-online').getAttribute('aria-pressed'), 'false');
  assert.equal(byId('ranking-scope-note').textContent, '이 브라우저에 저장된 내 기록이에요.');
  assert.equal(byId('ranking-online-status').hidden, true);
  assert.equal(byId('ranking-periods').hidden, true);
  assert.equal(byId('ranking-empty').hidden, true);
  assert.equal(rows()[0].children[1].textContent, '로컬기록');

  // 이 페이지에서 다시 열어도 기다리게 하지 않는다 — 처음부터 이 브라우저의 기록이다
  await ranking.show({ target: HISTORY });
  await settle();
  assert.equal(loads.length, 1);
  assert.equal(byId('ranking-scope-local').getAttribute('aria-pressed'), 'true');
});

test('사람이 고른 온라인 랭킹이 닉네임 때문에 막히면 「다시 시도」가 아니라 「홈으로」다', async () => {
  answer = () => ({ status: 'error', message: NICKNAME_MESSAGE, action: 'home' });
  opened.length = 0;
  byId('ranking-scope-online').click();
  await settle();

  assert.equal(byId('ranking-scope-online').getAttribute('aria-pressed'), 'true', '고른 범위는 그대로다');
  assert.equal(byId('ranking-online-status').textContent, '온라인 랭킹을 불러오지 못했어요.');
  assert.equal(byId('ranking-empty').hidden, false);
  assert.equal(byId('ranking-empty-message').textContent, NICKNAME_MESSAGE);
  assert.equal(byId('ranking-empty-start').textContent, '홈으로');
  byId('ranking-empty-start').click();
  assert.deepEqual(opened, ['home'], '홈에서 닉네임을 바꾼다');

  // 연결 문제면 예전처럼 「다시 시도」다
  answer = () => ({ status: 'error', message: '연결을 확인하고 다시 시도해 주세요.' });
  await ranking.show({ target: HISTORY });
  await settle();
  assert.equal(byId('ranking-empty-start').textContent, '다시 시도');
});

test('부른 곳이 온라인을 정했으면(온라인 결과의 «온라인 랭킹 보기») 읽지 못해도 오류와 다음 행동을 말한다', async () => {
  const fresh = createRankingScreen({
    onHome() {}, onStart() {}, canStart: () => true,
    loadRankings: async () => [],
    clearRankings: async () => {},
    exportRecords: async () => ({ fileName: 'x.json', data: { records: [] } }),
    online: {
      available: () => null,
      load: async () => ({ status: 'error', message: '연결을 확인하고 다시 시도해 주세요.' }),
      onOpenOnline() {},
    },
  });
  await fresh.show({ target: HISTORY, scope: 'online', period: 'week' });
  await settle();
  assert.equal(byId('ranking-scope-online').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('ranking-online-status').textContent, '온라인 랭킹을 불러오지 못했어요.');
  assert.equal(byId('ranking-empty-start').textContent, '다시 시도');
});

test('랭킹이 있다고 이미 알면(세션을 열었다) 처음 범위는 온라인이고 잠깐의 실패도 오류로 말한다', async () => {
  const known = [];
  const confirmed = createRankingScreen({
    onHome() {}, onStart() {}, canStart: () => true,
    loadRankings: async () => [],
    clearRankings: async () => {},
    exportRecords: async () => ({ fileName: 'x.json', data: { records: [] } }),
    online: {
      available: () => true,
      load: async (target, period) => {
        known.push(period);
        return known.length === 1
          ? { status: 'error', message: '연결을 확인하고 다시 시도해 주세요.' }
          : { status: 'ok', board: { target, period, window: WEEK, entries: [] } };
      },
      onOpenOnline() {},
    },
  });
  await confirmed.show({ target: HISTORY });
  await settle();
  assert.equal(byId('ranking-scope-online').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('ranking-empty-start').textContent, '다시 시도');
});

test('app.ts: 닉네임 거절은 「홈으로」로, 결과 화면의 등록 이름은 규칙을 지날 때만 홈의 닉네임이 된다', async () => {
  const app = await source('src/app.ts');
  assert.match(app, /action: isNicknameRejection\(error\) \? 'home' : 'retry',/);
  const register = app.slice(app.indexOf('async function registerRecord('));
  const body = register.slice(0, register.indexOf('\n  }\n'));
  const guard = body.indexOf('if (nicknameProblem(nickname) === null) {');
  assert.ok(guard !== -1, '금칙 규칙에 걸린 이름은 온라인 프로필로 올리지 않는다');
  assert.ok(guard < body.indexOf('savedNickname = nickname;'));
  assert.ok(guard < body.indexOf('syncRoomPlayer();'));
  assert.ok(guard < body.indexOf('await preferences.setNickname(nickname);'));
  // 이 브라우저의 기록은 그 전에, 아무것도 기다리지 않고 남긴다(pagehide)
  assert.ok(body.indexOf('rankingStore.saveRecord(') < guard);

  const { registeredNameNote } = await import('../js/ui/result.js');
  assert.equal(registeredNameNote('퀴즈왕'), '');
  assert.equal(registeredNameNote('kim@mail'), '이 이름은 온라인에서 쓸 수 없어 홈의 닉네임은 그대로예요.');
  const result = await source('src/ui/result.ts');
  assert.match(result, /const note = registeredNameNote\(nickname\);\s*setMessage\(note \? `\$\{text\} \$\{note\}` : text, tone\);/);
});
