import test from 'node:test';
import assert from 'node:assert/strict';

// 로비 방 목록의 주기 새로고침 (WP-E). N01(#106)이 요청 몫을 사람마다 나눈 뒤로 30초에 한 번 조용히 다시 읽는다.
// - 로비가 보이고 문서가 보이고 도는 목록 요청이 없을 때만 읽는다. 숨으면 쉬고, 돌아오면 밀린 차례를 곧바로 읽는다
// - 로비를 떠나면(closers → hide, 참가로 대기실) 멈춘다. 실패하면 간격을 두 배씩 늘리고 마지막 목록을 그대로 둔다
// - 요청을 겹치지 않는다 — 사람이 누른 새로고침은 주기 새로고침이 끝난 뒤에 보낸다
// - 포커스를 빼앗지 않는다: 사람이 목록에서 고르는 중(포커스·캐릭터의 발밑)이면 그 차례를 건너뛴다
// - 누르려는 줄을 옮기지 않는다: 마우스·손가락이 목록 위에 있거나 막 떠났거나, 캐릭터가 걷거나 목록 쪽에 서 있어도 건너뛴다
// - 바뀐 것이 없으면 다시 그리지 않고, 바뀌어도 낭독되는 요약 줄은 방 수가 달라질 때만 고친다
// 로비를 가짜 DOM과 가짜 시계 위에 실제로 띄워 확인한다 (tests/online-lobby-runtime.test.mjs 와 같은 방식).

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
    for (const child of this.children) if (child instanceof FakeElement) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  contains(target) {
    for (let node = target; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  /** 이 테스트가 쓰는 선택자만 안다: 누를 수 있는 첫 버튼, `.이름` */
  querySelector(selector) {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      const hit = selector === 'button:not([disabled])'
        ? child.tagName === 'BUTTON' && !child.disabled
        : selector.startsWith('.') && child.classList.contains(selector.slice(1));
      if (hit) return child;
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
    if (this.disabled || this.renderedHidden) return;
    globalThis.document.activeElement = this;
  }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView() {}
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
byId('room-empty').append(byId('room-empty-action'));

/** 요약 줄(role=status)에 몇 번 썼는가. 같은 말로 다시 써도 낭독될 수 있어 쓴 횟수를 센다 */
const summary = byId('room-list-summary');
let summaryText = '';
let summaryWrites = 0;
Object.defineProperty(summary, 'textContent', {
  get: () => summaryText,
  set: (value) => { summaryWrites += 1; summaryText = value; },
});

const documentListeners = new Map();
const windowListeners = new Map();
globalThis.HTMLElement = FakeElement;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener(type, listener) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(listener);
  },
  removeEventListener() {}, scrollBy() {}, scrollTo() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  matchMedia: () => ({ matches: false }),
};
globalThis.document = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  visibilityState: 'visible',
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '[data-screen="online"]') return screen;
    if (selector === '[data-screen="online"] .online-hero__header') return header;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener(type, listener) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(listener);
  },
  removeEventListener() {},
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
console.warn = () => {};

const {
  createLobbyRefresh, lobbyRefreshDelayMs, LOBBY_REFRESH_MS, LOBBY_REFRESH_MAX_MS,
} = await import('../js/ui/lobby-refresh.js');
const { createOnlineScreen, ROOM_LIST_SETTLE_MS } = await import('../js/ui/online.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 6; i += 1) await tick();
}

/** 가짜 시계. 로비가 refreshClock 으로 건 일만 advance(ms)가 시각 순서대로 돌린다 */
function fakeClock() {
  const clock = {
    at: 0,
    next: 1,
    tasks: new Map(),
    now: () => clock.at,
    setTimeout: (run, ms) => {
      const id = clock.next++;
      clock.tasks.set(id, { due: clock.at + ms, run });
      return id;
    },
    clearTimeout: (id) => { clock.tasks.delete(id); },
    async advance(ms) {
      const end = clock.at + ms;
      for (;;) {
        const due = [...clock.tasks.entries()]
          .filter(([, task]) => task.due <= end)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!due) break;
        clock.tasks.delete(due[0]);
        clock.at = due[1].due;
        due[1].run();
        await settle();
      }
      clock.at = end;
      await settle();
    },
  };
  return clock;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
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

const A = room('ABC234', '우리 반');
const B = room('BCD345', '점심 퀴즈', { createdAt: '2026-10-27T00:01:00.000Z' });
const C = room('CDE456', '방과 후', { createdAt: '2026-10-27T00:02:00.000Z' });

// 저장소 흉내. 목록 요청이 동시에 몇 개 도는지 센다
let respond = async () => [A, B];
const store = { calls: 0, active: 0, maxActive: 0 };
const clock = fakeClock();
const entered = [];
const lobby = createOnlineScreen({
  roomStore: {
    isNetworked: true,
    isPersistent: true,
    me: () => 'me',
    listRooms: () => {
      store.calls += 1;
      store.active += 1;
      store.maxActive = Math.max(store.maxActive, store.active);
      return Promise.resolve().then(() => respond()).finally(() => { store.active -= 1; });
    },
    joinRoom: async ({ code }) => ({ ok: true, room: room(code, '들어간 방', { joined: true }) }),
  },
  onHome: () => {},
  onPractice: () => {},
  onEnterRoom: (code) => entered.push(code),
  getPlayer: () => ({ nickname: '퀴즈왕', characterId: 'slime-blue' }),
  refreshClock: clock,
});

const list = byId('room-list');
const refresh = byId('room-refresh');
const roomButtons = () => list.children.flatMap((item) => item.children.at(-1).children);

/** app.ts 의 openOnline 순서: show(숨은 채로) → goTo('online') → activate() */
async function openLobby(rooms = [A, B]) {
  respond = async () => rooms;
  document.activeElement = document.body;
  document.visibilityState = 'visible';
  screen.hidden = true;
  await lobby.show('slime-blue');
  screen.hidden = false;
  lobby.activate();
  store.calls = 0;
  store.maxActive = 0;
}

function fireVisibilityChange() {
  for (const listener of documentListeners.get('visibilitychange') ?? []) listener();
}

function fireScroll() {
  for (const listener of windowListeners.get('scroll') ?? []) listener();
}

/** 포인터 경계 이벤트. 마우스는 올라오면 enter·나가면 leave, 손가락은 닿을 때 enter·떼거나 스크롤로 넘어갈 때 leave */
function pointer(target, type, pointerId = 1) {
  target.dispatchEvent(Object.assign(new Event(type), { pointerId }));
}

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
const roomLabels = () => roomButtons().map((button) => button.getAttribute('aria-label'));

test('간격: 30초에서 시작해 실패할 때마다 두 배, 4분에서 멈춘다', () => {
  assert.equal(LOBBY_REFRESH_MS, 30_000);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(lobbyRefreshDelayMs), [30_000, 60_000, 120_000, 240_000, 240_000, 240_000]);
  assert.equal(LOBBY_REFRESH_MAX_MS, 240_000);
});

test('시계: 한 번에 하나만 읽고, 건너뛴 차례는 실패가 아니며, 떠난 뒤 끝난 요청은 차례를 정하지 못한다', async () => {
  const fake = fakeClock();
  let pending = null;
  let ready = true;
  const refresher = createLobbyRefresh({
    refresh: () => { pending = deferred(); return pending.promise; },
    canRefresh: () => ready,
    documentHidden: () => false,
    clock: fake,
  });
  let reads = 0;
  const count = () => { if (pending) { reads += 1; } };

  refresher.start();
  await fake.advance(30_000);
  count();
  assert.equal(reads, 1);
  // 요청이 도는 동안에는 시계를 걸지 않는다 — 몇 분이 지나도 둘째 요청이 나가지 않는다
  const first = pending;
  await fake.advance(600_000);
  assert.equal(pending, first);
  assert.equal(fake.tasks.size, 0);
  first.resolve(false);
  await settle();
  assert.equal([...fake.tasks.values()][0].due - fake.at, 60_000, '실패했으니 다음은 1분 뒤');

  // 사람이 다른 길로 읽었다(loaded) — 그때부터 30초
  refresher.loaded(true);
  assert.equal([...fake.tasks.values()][0].due - fake.at, 30_000);

  // 지금 읽으면 안 되는 차례는 건너뛴다. 실패로 세지 않아 간격이 늘지 않는다
  ready = false;
  pending = null;
  await fake.advance(30_000);
  assert.equal(pending, null);
  assert.equal([...fake.tasks.values()][0].due - fake.at, 30_000);

  // 떠난 뒤 끝난 요청은 다음 로비의 시계를 건드리지 않는다
  ready = true;
  await fake.advance(30_000);
  const stale = pending;
  refresher.stop();
  assert.equal(refresher.running, false);
  stale.resolve(true);
  await settle();
  assert.equal(fake.tasks.size, 0);
});

test('로비가 보이는 동안 30초마다 조용히 다시 읽는다 — 바뀐 것이 없으면 다시 그리지 않고 낭독할 말도 없다', async () => {
  await openLobby([A, B]);
  assert.equal(summaryText, '전체 2개 중 2개 방');
  const items = [...list.children];
  const writes = summaryWrites;

  await clock.advance(LOBBY_REFRESH_MS - 1);
  assert.equal(store.calls, 0, '30초 전에는 읽지 않는다');
  await clock.advance(1);
  assert.equal(store.calls, 1);
  assert.deepEqual(list.children, items, '같은 목록이면 방 카드를 다시 만들지 않는다');
  assert.equal(summaryWrites, writes, '요약 줄(라이브 리전)도 건드리지 않는다');

  // 방이 하나 늘었다 — 목록을 다시 그리고 요약 줄이 방 수를 한 번 말한다
  respond = async () => [A, B, C];
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 2);
  assert.equal(list.children.length, 3);
  assert.equal(summaryText, '전체 3개 중 3개 방');
  assert.equal(summaryWrites, writes + 1);

  // 방 수는 같고 안의 인원만 바뀌었다 — 카드는 새로 그리지만 요약 줄은 같은 말이라 쓰지 않는다
  const before = [...list.children];
  respond = async () => [A, room(B.code, B.name, { createdAt: B.createdAt, players: [...B.players, { id: 'p2', nickname: '민수', characterId: 'slime-blue', isReady: false, connected: true }] }), C];
  await clock.advance(LOBBY_REFRESH_MS);
  assert.notDeepEqual(list.children, before);
  assert.equal(summaryWrites, writes + 1, '방 수가 그대로면 다시 낭독하지 않는다');

  // 조용한 새로고침은 새로고침 버튼을 잠그지 않는다 — 잠그면 그 버튼의 포커스가 떨어졌다 돌아오며 다시 읽힌다
  const slow = deferred();
  respond = () => slow.promise;
  refresh.focus();
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 4);
  assert.equal(refresh.disabled, false);
  assert.equal(refresh.getAttribute('aria-busy'), null);
  assert.equal(document.activeElement, refresh, '포커스를 옮기지 않는다');
  slow.resolve([A, B, C]);
  await settle();
  lobby.hide();
});

test('사람이 목록에서 고르는 중이면 그 차례를 건너뛴다 — 포커스도 캐릭터 발밑도 빼앗지 않는다', async () => {
  await openLobby([A, B]);
  respond = async () => [C, A, B];

  // 키보드로 방 버튼에 서 있다
  const button = roomButtons()[0];
  button.focus();
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 0, '읽지 않는다');
  assert.equal(document.activeElement, button, '그 버튼에 그대로 있다');

  // 캐릭터가 방 버튼을 밟고 있다 — 다시 그리면 같은 자리의 Enter가 다른 방을 누른다
  document.activeElement = document.body;
  button.classList.add('is-standing');
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 0);
  button.classList.remove('is-standing');

  // 코드 참가 본문을 연 동안에는 목록이 숨어 있다
  byId('open-private-join').click();
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 0);
  byId('open-public-rooms').click();

  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 1, '다 비키면 다음 차례에 읽는다');
  assert.equal(list.children.length, 3);
  lobby.hide();
});

test('마우스가 목록 위에 있으면 다시 그리지 않는다 — 새 방이 맨 앞에 드는 목록이 와도 누르려던 「참가」를 옮기지 않는다', async () => {
  await openLobby([A, B]);
  const items = [...list.children];
  assert.deepEqual(roomLabels(), ['점심 퀴즈 참가', '우리 반 참가'], '같은 무리에서는 새 방이 앞이다');

  // 마우스가 방 줄 위에 있다. Safari의 클릭·손가락 탭은 누르기 전에 포커스를 옮기지 않아 포커스로는 모른다
  respond = async () => [A, B, C];
  pointer(list, 'pointerenter');
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 0, '그 차례는 읽지도 않는다');
  pointer(list, 'pointerleave');

  // 비켜 있을 때 나간 요청이, 기다리는 사이 다시 올라온 마우스 밑으로 돌아왔다
  const slow = deferred();
  respond = () => slow.promise;
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 1);
  pointer(list, 'pointerenter');
  slow.resolve([A, B, C]);
  await settle();
  assert.deepEqual(list.children, items, '「점심 퀴즈 참가」 자리에 방과 후가 들어오지 않는다');
  assert.equal(summaryText, '전체 2개 중 2개 방');

  // 치우면 다음 차례에 그린다
  respond = async () => [A, B, C];
  pointer(list, 'pointerleave');
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 2);
  assert.deepEqual(roomLabels(), ['방과 후 참가', '점심 퀴즈 참가', '우리 반 참가']);

  // 떠난 로비의 목록에는 pointerleave가 오지 않을 수 있다 — 다음 로비는 남은 포인터에 묶이지 않는다
  pointer(list, 'pointerenter', 2);
  lobby.hide();
  await openLobby([A, B]);
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 1);
  lobby.hide();
});

test('빈 칸의 버튼 위에 있어도 같다 — 방이 생기면 그 자리에 「참가」가 들어온다', async () => {
  await openLobby([]);
  const empty = byId('room-empty');
  assert.equal(empty.hidden, false);
  respond = async () => [A];
  pointer(empty, 'pointerenter');
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 0);
  assert.equal(empty.hidden, false, '「방 만들고 친구 부르기」가 그대로 있다');

  pointer(empty, 'pointerleave');
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 1);
  assert.equal(empty.hidden, true);
  assert.deepEqual(roomLabels(), ['우리 반 참가']);
  lobby.hide();
});

test('손가락은 닿기 전에는 목록 위에 있지 않다 — 떼거나 로비를 민 뒤 잠깐도 고르는 중으로 본다', async () => {
  await openLobby([A, B]);
  respond = async () => [A, B, C];

  // 목록을 밀어 읽고 손가락을 뗐다(스크롤로 넘어가면 pointercancel 뒤 pointerleave). 곧 겨눈 탭이 온다
  await clock.advance(LOBBY_REFRESH_MS - ROOM_LIST_SETTLE_MS + 1);
  pointer(list, 'pointerenter', 7);
  pointer(list, 'pointerleave', 7);
  await clock.advance(ROOM_LIST_SETTLE_MS - 1);
  assert.equal(store.calls, 0, '뗀 지 5초가 안 된 차례는 건너뛴다');

  // 머리말을 밀어 목록으로 내려왔다(휴대폰은 목록이 접힘 아래라 목록 밖에서 민다)
  await clock.advance(LOBBY_REFRESH_MS - ROOM_LIST_SETTLE_MS + 1);
  fireScroll();
  await clock.advance(ROOM_LIST_SETTLE_MS - 1);
  assert.equal(store.calls, 0, '로비를 민 지 5초가 안 된 차례도 건너뛴다');

  // 가만히 읽는 동안의 차례는 읽는다
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 1);
  assert.equal(list.children.length, 3);
  lobby.hide();
});

test('캐릭터가 걷는 중이거나 목록 쪽에 서 있으면 건너뛴다 — 줄 사이·목록 아래 빈자리의 발밑에도 다른 방이 들어온다', async () => {
  await openLobby([A, B]);
  respond = async () => [A, B, C];
  const character = byId('online-character');
  list.getBoundingClientRect = () => rect(16, 300, 358, 200);

  // 걷는 중 — 어디로 가는지 모른다
  character.classList.add('walker--walking');
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 0);
  character.classList.remove('walker--walking');

  // 목록 아래 빈자리에 멈춰 섰다. 줄이 늘면 그 발밑에 새 방이 든다(밟은 표시가 생기고 Enter가 그 방에 들어간다)
  character.getBoundingClientRect = () => rect(170, 520, 40, 48);
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 0);

  // 목록 위(머리말 쪽)로 비켰다 — 다시 그려도 그 자리는 움직이지 않는다
  character.getBoundingClientRect = () => rect(170, 200, 40, 48);
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 1);
  assert.equal(list.children.length, 3);

  delete list.getBoundingClientRect;
  delete character.getBoundingClientRect;
  lobby.hide();
});

test('요청을 겹치지 않는다 — 누른 새로고침이 도는 동안 차례를 건너뛰고, 주기 새로고침 중에 누르면 그 뒤에 보낸다', async () => {
  await openLobby([A]);

  // 사람이 누른 새로고침이 길어진다. 그동안 주기 새로고침은 나가지 않는다
  const manual = deferred();
  respond = () => manual.promise;
  refresh.click();
  await settle();
  assert.equal(store.calls, 1);
  await clock.advance(LOBBY_REFRESH_MS * 3);
  assert.equal(store.calls, 1);
  manual.resolve([A, B]);
  await settle();
  // 다 읽은 때부터 다시 센다
  respond = async () => [A, B];
  await clock.advance(LOBBY_REFRESH_MS - 1);
  assert.equal(store.calls, 1);

  // 주기 새로고침이 도는 중에 사람이 누르면, 끝난 뒤에 새로 보낸다(나가기 뒤의 상태를 읽어야 할 수도 있다)
  const quiet = deferred();
  respond = () => quiet.promise;
  await clock.advance(1);
  assert.equal(store.calls, 2);
  respond = async () => [A, B, C];
  refresh.click();
  await settle();
  assert.equal(store.calls, 2, '도는 요청이 끝나기를 기다린다');
  assert.equal(refresh.getAttribute('aria-busy'), 'true', '누른 쪽은 잠기고 바쁨을 단다');
  quiet.resolve([A]);
  await settle();
  assert.equal(store.calls, 3);
  assert.equal(store.maxActive, 1, '목록 요청은 언제나 하나뿐이다');
  assert.equal(list.children.length, 3, '늦게 시작한 사람의 조회가 이긴다 — 주기 새로고침의 낡은 결과는 버린다');
  assert.equal(refresh.getAttribute('aria-busy'), null);
  lobby.hide();
});

test('실패하면 마지막 목록을 그대로 두고 1분 → 2분으로 물러서며, 다시 읽히면 30초로 돌아온다', async () => {
  await openLobby([A, B]);
  const writes = summaryWrites;
  respond = async () => { throw new Error('Failed to fetch'); };

  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 1);
  assert.equal(byId('room-empty').hidden, true, '«연결할 수 없어요»로 바꾸지 않는다');
  assert.equal(list.children.length, 2);
  assert.equal(summaryWrites, writes, '낭독할 말도 없다');

  await clock.advance(60_000 - 1);
  assert.equal(store.calls, 1);
  await clock.advance(1);
  assert.equal(store.calls, 2, '두 번째는 1분 뒤');
  await clock.advance(120_000 - 1);
  assert.equal(store.calls, 2);
  respond = async () => [A, B, C];
  await clock.advance(1);
  assert.equal(store.calls, 3, '세 번째는 2분 뒤');
  assert.equal(list.children.length, 3);
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 4, '읽히면 다시 30초');
  lobby.hide();
});

test('문서가 숨으면 쉬고, 돌아오면 밀린 차례를 곧바로 한 번 읽는다', async () => {
  await openLobby([A, B]);
  document.visibilityState = 'hidden';
  fireVisibilityChange();
  await clock.advance(LOBBY_REFRESH_MS * 10);
  assert.equal(store.calls, 0, '다른 탭·앱에 있는 동안에는 읽지 않는다');
  assert.equal(clock.tasks.size, 0, '시계도 걸어 두지 않는다');

  document.visibilityState = 'visible';
  fireVisibilityChange();
  await clock.advance(0);
  assert.equal(store.calls, 1, '돌아오면 곧바로');
  await clock.advance(LOBBY_REFRESH_MS);
  assert.equal(store.calls, 2);
  lobby.hide();
});

test('로비를 떠나면 멈춘다 — closers 의 hide 와 참가로 대기실에 가는 길 모두', async () => {
  await openLobby([A, B]);
  lobby.hide();
  await clock.advance(LOBBY_REFRESH_MS * 10);
  assert.equal(store.calls, 0);
  assert.equal(clock.tasks.size, 0);

  await openLobby([A, B]);
  const enteredBefore = entered.length;
  roomButtons()[0].click();
  await settle();
  assert.equal(entered.length, enteredBefore + 1, '「참가」로 대기실에 들어갔다');
  await clock.advance(LOBBY_REFRESH_MS * 10);
  assert.equal(store.calls, 0, '대기실로 간 뒤에는 읽지 않는다');

  // 화면을 떠난 뒤의 늦은 activate 는 시계를 다시 켜지 않는다
  lobby.activate();
  await clock.advance(LOBBY_REFRESH_MS * 2);
  assert.equal(store.calls, 0);
  lobby.hide();
});
