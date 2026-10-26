import test from 'node:test';
import assert from 'node:assert/strict';

// 로비를 가짜 DOM 위에 실제로 띄워 확인한다.
// - 「다시 시도」가 통해 오류 칸이 접히면 포커스가 <body>로 떨어지지 않고 나타난 목록으로 간다 (a11y-ux-07)
// - 움직임 줄이기(설정·기기)를 켜면 동작 카드의 스크롤이 미끄러지지 않는다 (U55)
// 가짜 요소는 브라우저처럼 포커스를 다룬다 — 잠긴(disabled) 버튼은 포커스를 놓고, 숨은 칸 안의
// 요소에는 focus()가 듣지 않는다. 그래야 «숨은 버튼에 포커스를 돌려준다»가 실제처럼 실패한다.

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
  #disabled = false;
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.type = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.parentElement = null;
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.scrolls = [];
  }
  get disabled() { return this.#disabled; }
  set disabled(value) {
    this.#disabled = Boolean(value);
    // 브라우저는 잠긴 요소에서 포커스를 거둔다
    if (this.#disabled && globalThis.document.activeElement === this) {
      globalThis.document.activeElement = globalThis.document.body;
    }
  }
  get isConnected() { return true; }
  get renderedHidden() {
    for (let node = this; node; node = node.parentElement) if (node.hidden) return true;
    return false;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  /** 이 테스트가 쓰는 선택자 하나만 안다: 목록 안의 누를 수 있는 첫 버튼 */
  querySelector(selector) {
    if (selector !== 'button:not([disabled])') return null;
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.tagName === 'BUTTON' && !child.disabled) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() {
    // 숨은 칸 안이거나 잠긴 요소에는 포커스가 가지 않는다 (브라우저와 같다)
    if (this.disabled || this.renderedHidden) return;
    globalThis.document.activeElement = this;
  }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView(options) { this.scrolls.push(options); }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
  reset() {}
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id.includes('action') || id.endsWith('refresh') ? 'button' : 'div'));
  return elements.get(id);
};
const screen = new FakeElement('section');
const header = new FakeElement('header');
// 빈 상태의 버튼은 #room-empty 안에 있다 (index.html) — 칸이 접히면 버튼도 숨는다
byId('room-empty').append(byId('room-empty-action'));

let reduceMotionQuery = false;
globalThis.HTMLElement = FakeElement;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  matchMedia: (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' && reduceMotionQuery }),
};
globalThis.document = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '[data-screen="online"]') return screen;
    if (selector === '[data-screen="online"] .online-hero__header') return header;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
console.warn = () => {};

const { createOnlineScreen } = await import('../js/ui/online.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 5; i += 1) await tick();
}

function room(code, name, changes = {}) {
  return {
    code,
    name,
    categoryId: null,
    capacity: 6,
    gameMode: true,
    players: [{ id: 'host', nickname: '방장', characterId: 'slime-blue', isReady: false, connected: true }],
    isPublic: true,
    hasPassword: false,
    isMine: false,
    joined: false,
    createdAt: '2026-10-27T00:00:00.000Z',
    status: 'waiting',
    ...changes,
  };
}

let listRooms = async () => [];
let createRoom = async () => ({ ok: false, message: '만들지 않는다' });
const entered = [];
const lobby = createOnlineScreen({
  roomStore: {
    isNetworked: true,
    isPersistent: true,
    me: () => 'me',
    listRooms: () => listRooms(),
    createRoom: (spec) => createRoom(spec),
  },
  onHome: () => {},
  onPractice: () => {},
  onEnterRoom: (code) => entered.push(code),
  getPlayer: () => ({ nickname: '퀴즈왕', characterId: 'slime-blue' }),
});

/** 목록 안의 첫 «참가» 버튼 */
function firstRoomButton() {
  return byId('room-list').querySelector('button:not([disabled])');
}

test('「다시 시도」가 통해 오류 칸이 접히면 포커스는 <body>가 아니라 나타난 목록의 첫 버튼으로 간다 (a11y-ux-07)', async () => {
  listRooms = async () => { throw new Error('Failed to fetch'); };
  screen.hidden = false;
  await lobby.show('slime-blue');
  const retry = byId('room-empty-action');
  assert.equal(byId('room-empty').hidden, false);
  assert.equal(retry.dataset.action, 'retry');
  assert.equal(retry.textContent, '다시 시도');

  retry.focus();
  assert.equal(document.activeElement, retry);
  listRooms = async () => [room('ABC234', '우리 반'), room('BCD345', '점심 퀴즈')];
  retry.click();
  await settle();

  assert.equal(byId('room-empty').hidden, true, '오류 칸이 접혔다');
  assert.notEqual(document.activeElement, document.body, 'Tab 자리를 잃지 않는다');
  assert.equal(document.activeElement, firstRoomButton());
  assert.match(document.activeElement.getAttribute('aria-label'), /참가$/);
  lobby.hide();
});

test('다시 시도가 또 실패하거나 방이 여전히 없으면 같은 자리의 버튼에 포커스를 둔다', async () => {
  listRooms = async () => { throw new Error('Failed to fetch'); };
  screen.hidden = false;
  await lobby.show('slime-blue');
  const retry = byId('room-empty-action');

  retry.focus();
  retry.click();
  await settle();
  assert.equal(document.activeElement, retry, '다시 실패했다 — 그 버튼이 그대로 보인다');

  listRooms = async () => [];
  retry.click();
  await settle();
  assert.equal(retry.dataset.action, 'create', '방이 없으면 같은 자리가 «방 만들고 친구 부르기»가 된다');
  assert.equal(document.activeElement, retry);
  lobby.hide();
});

test('「필터 초기화」로 칸이 접혀도 목록의 첫 버튼으로 옮긴다 — 캐릭터가 밟아 누른 것이면 옮기지 않는다', async () => {
  listRooms = async () => [room('ABC234', '우리 반')];
  screen.hidden = false;
  await lobby.show('slime-blue');
  const reset = byId('room-empty-action');

  byId('room-search').value = '없는 방';
  byId('room-search').dispatchEvent(new Event('input'));
  assert.equal(reset.dataset.action, 'reset');

  reset.focus();
  reset.click();
  await settle();
  assert.equal(byId('room-empty').hidden, true);
  assert.equal(document.activeElement, firstRoomButton());

  // 걷는 사람은 포커스를 놓은 채 발밑을 누른다. 버튼에 포커스를 주면 다음 Enter 가 그 버튼을 누른다
  byId('room-search').value = '없는 방';
  byId('room-search').dispatchEvent(new Event('input'));
  document.activeElement = document.body;
  reset.click();
  await settle();
  assert.equal(document.activeElement, document.body);
  lobby.hide();
});

test('움직임 줄이기를 켜면(설정 또는 기기) 동작 카드의 스크롤이 미끄러지지 않는다 (U55)', async () => {
  listRooms = async () => [];
  screen.hidden = false;
  await lobby.show('slime-blue');
  const join = byId('private-join-block');

  byId('open-private-join').click();
  assert.deepEqual(join.scrolls.at(-1), { behavior: 'smooth', block: 'nearest' });

  document.documentElement.dataset.motion = 'reduce';
  byId('open-private-join').click();
  assert.deepEqual(join.scrolls.at(-1), { behavior: 'auto', block: 'nearest' }, '설정의 «움직임 줄이기»');
  delete document.documentElement.dataset.motion;

  reduceMotionQuery = true;
  byId('open-create-room').click();
  assert.deepEqual(byId('create-room-block').scrolls.at(-1), { behavior: 'auto', block: 'nearest' }, '기기의 움직임 줄이기');
  reduceMotionQuery = false;
  lobby.hide();
});

test('방 만들기 폼의 문항 시간은 20초가 기본이고, 고른 값(40초)을 그대로 저장소에 넘긴다 (FR-3.7)', async () => {
  listRooms = async () => [];
  screen.hidden = false;
  await lobby.show('slime-blue');
  const select = byId('create-question-time');
  // 서버와 같은 두 값뿐이다 — 온라인에는 제한 없음이 없다
  assert.deepEqual(
    select.children.map((option) => [option.value, option.textContent]),
    [['20000', '20초'], ['40000', '40초']],
  );
  assert.equal(select.value, '20000');

  const specs = [];
  createRoom = async (spec) => {
    specs.push(spec);
    return { ok: true, room: room('NEW234', spec.name, { isMine: true, joined: true, questionTimeMs: spec.questionTimeMs }) };
  };
  byId('open-create-room').click();
  byId('create-name').value = '느긋한 방';
  select.value = '40000';
  byId('create-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();

  assert.equal(specs.length, 1);
  assert.equal(specs[0].questionTimeMs, 40_000);
  assert.equal(typeof specs[0].questionTimeMs, 'number', '글자 «40000»이 아니라 값을 넘긴다');
  assert.deepEqual(entered.at(-1), 'NEW234');
  assert.equal(select.value, '20000', '다음 방은 다시 기본 20초에서 시작한다');
  lobby.hide();
});
