import test from 'node:test';
import assert from 'node:assert/strict';

// 공유 무대 좌표 (U31)를 화면에 실제로 띄워 확인한다 — 대기실은 라운지, 온라인 퀴즈는 2×2 바닥이다.
// 보낼 때는 지금 배치로 무대를 다시 재고, 받을 때는 이 화면 무대의 같은 자리에 세운다.
// 모듈은 불러오는 순간 document·window 에 리스너를 단다. 그 전에 필요한 만큼만 흉내 낸다.

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

const NO_BOX = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

class FakeElement extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.parentElement = null;
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.box = NO_BOX;
  }
  get firstElementChild() { return this.children.find((child) => child instanceof FakeElement) ?? null; }
  get isConnected() { return true; }
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
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children.filter((child) => child instanceof FakeElement) ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(node, reference) {
    node.remove();
    const at = reference === null ? this.children.length : this.children.indexOf(reference);
    node.parentElement = this;
    this.children.splice(at, 0, node);
    return node;
  }
  matches() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() {
    const { left, top, width, height } = this.box;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  select() {}
  scrollIntoView() {}
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const screens = {
  '[data-screen="waiting"]': new FakeElement('section'),
  '[data-screen="online-quiz"]': new FakeElement('section'),
};
const windowListeners = new Map();

globalThis.HTMLElement = FakeElement;
globalThis.HTMLLIElement = FakeElement;
globalThis.HTMLButtonElement = FakeElement;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener(type, listener) {
    const listeners = windowListeners.get(type) ?? [];
    listeners.push(listener);
    windowListeners.set(type, listeners);
  },
  removeEventListener() {}, scrollBy() {}, scrollTo() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  // 2초 heartbeat 를 진짜로 걸면 테스트 프로세스가 끝나지 않는다
  setInterval: () => 1,
  clearInterval() {},
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id),
  matchMedia: () => ({ matches: false }),
  // 라운지 바닥 높이는 디자인 토큰이다(voxel-theme.css 의 --lounge-floor)
  getComputedStyle: () => ({
    getPropertyValue: (name) => (name === '--lounge-floor' ? ' 176px' : ''),
  }),
};
globalThis.document = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => screens[selector] ?? null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const scroll = () => { for (const listener of windowListeners.get('scroll') ?? []) listener(); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ME = '12345678-1234-4678-9234-567812345600';
const FRIEND = '12345678-1234-4678-9234-567812345601';

function remoteNode(containerId) {
  const node = byId(containerId).children.find((child) => child.dataset?.movingPlayerId === FRIEND);
  assert.ok(node, 'remote character was not drawn');
  return node;
}

test('온라인 퀴즈: 바닥 위의 내 자리를 무대 좌표로 보내고, 친구의 무대 좌표는 이 화면 바닥의 같은 칸에 세운다', async () => {
  const { createOnlineQuizScreen } = await import('../js/ui/online-quiz.js');
  let arenaDeps = null;
  const fakeArena = new Proxy({}, { get: () => () => undefined });
  const sent = [];
  const quiz = createOnlineQuizScreen({
    onSubmit: async () => {},
    onMovement: (sample) => sent.push(sample),
    onSendChat: async () => ({ ok: true }),
    onExit: () => {},
    onFinished: () => {},
    getPlayerId: () => ME,
    createCharacterArena: (deps) => { arenaDeps = deps; return fakeArena; },
    trapFocus: () => {},
  });
  // 휴대폰 세로: 질문·보기 아래의 바닥
  const tiles = byId('online-arena-tiles');
  tiles.box = { left: 16, top: 560, width: 358, height: 172 };

  quiz.startPresence();
  quiz.setRoom({
    code: 'ABC234', name: '교실', categoryId: null, capacity: 12, gameMode: true,
    questionTimeMs: 20_000, isPublic: true, hasPassword: false, isMine: true, joined: true,
    createdAt: '2026-10-27T00:00:00+00:00', status: 'playing', inMatch: true, hostReadyImplicit: true,
    players: [
      { id: ME, nickname: '퀴즈왕', characterId: 'slime-blue', isReady: false, connected: true },
      { id: FRIEND, nickname: '친구', characterId: 'slime-pink', isReady: false, connected: true },
    ],
  });

  // 3번 칸(왼쪽 아래)에 멈춰 섰다
  arenaDeps.onMove({ x: 16 + 358 * 0.25, y: 560 + 172 * 0.8 }, false);
  const stopped = sent.at(-1);
  assert.equal(stopped.stage, 'arena');
  assert.ok(Math.abs(stopped.stageX - 0.25) <= 0.0005 && Math.abs(stopped.stageY - 0.8) <= 0.0005);
  assert.equal(stopped.viewportWidth, 390, '무대 좌표를 모르는 화면은 예전 필드로 그린다');

  // 스크롤로 바닥이 올라갔다 — 캐릭터는 화면에 붙어 있어 바닥 위 자리가 바뀌었다. 묶어서 한 번 보낸다
  const before = sent.length;
  tiles.box = { ...tiles.box, top: 540 };
  scroll();
  scroll();
  await pause(160);
  assert.equal(sent.length, before + 1);
  assert.ok(Math.abs(sent.at(-1).stageY - (697.6 - 540) / 172) < 0.001, `${sent.at(-1).stageY}`);

  // 데스크톱의 친구가 바닥 한가운데(십자)에 섰다 — 이 화면 바닥의 한가운데에 세운다
  quiz.updateMovement({
    type: 'movement', playerId: FRIEND, x: 0.5, y: 0.42, moving: false,
    viewportWidth: 1440, viewportHeight: 900,
    stage: 'arena', stageX: 0.5, stageY: 0.5,
    sequence: 1, connectionGeneration: 1,
  });
  const friend = remoteNode('online-remote-characters');
  assert.equal(friend.style.transform, 'translate(195px, 626px) translate(-50%, -100%)');
  assert.equal(friend.classList.contains('walker--relayout'), false, '이동 frame 사이는 전환으로 잇는다');
  // 스크롤하면 바닥과 함께 움직인다 — 전환 없이(바닥을 늦게 따라 미끄러지지 않는다)
  tiles.box = { ...tiles.box, top: 500 };
  scroll();
  assert.equal(friend.style.transform, 'translate(195px, 586px) translate(-50%, -100%)');
  assert.equal(friend.classList.contains('walker--relayout'), true);

  // 무대 좌표가 없는 이전 화면의 친구는 예전처럼 화면 중심의 px다
  quiz.updateMovement({
    type: 'movement', playerId: FRIEND, x: 0.5, y: 0.42, moving: false,
    viewportWidth: 1440, viewportHeight: 900,
    sequence: 2, connectionGeneration: 1,
  });
  assert.match(friend.style.transform, /^translate\(clamp\(/);
  assert.equal(friend.classList.contains('walker--relayout'), false, '다음 이동이 전환을 되살린다');

  // 공개 카드로 스크롤한 뒤 arena가 캐릭터를 바닥의 같은 자리(3번 칸)로 옮겨 놓았다 — 이동은 알리지 않는다.
  // 보낼 때는 지금 그려진 캐릭터로 재므로 바닥 위 자리가 그대로다(표본의 옛 자리로 재면 바닥 밖이다)
  const character = byId('online-arena-character');
  const placeCharacter = (arenaTop) => {
    character.box = { left: 16 + 358 * 0.25 - 20, top: arenaTop + 172 * 0.8 - 48, width: 40, height: 48 };
  };
  placeCharacter(500);
  scroll();
  await pause(160);
  const restored = sent.at(-1);
  assert.equal(restored.stage, 'arena');
  assert.deepEqual([restored.stageX, restored.stageY], [0.25, 0.8]);
  const settledCount = sent.length;
  await pause(160);
  tiles.box = { ...tiles.box, top: 300 };
  placeCharacter(300);
  scroll();
  await pause(160);
  assert.equal(sent.length, settledCount, '바닥과 함께 옮긴 캐릭터는 바닥 위 자리가 같아 다시 보내지 않는다');
  quiz.stopPresence();
});

test('대기실: 라운지 바닥의 내 자리를 보내고, 친구는 이 화면 라운지의 같은 바닥에 선다', async () => {
  const { createWaitingRoom } = await import('../js/ui/waiting-room.js');
  const sent = [];
  let roomEvents = null;
  const room = {
    code: 'ABC234', name: '우리 반', categoryId: null, capacity: 6, gameMode: true,
    questionTimeMs: 20_000, isPublic: true, hasPassword: false, isMine: true, joined: true,
    createdAt: '2026-10-27T00:00:00.000Z', status: 'waiting', hostReadyImplicit: true,
    players: [
      { id: ME, nickname: '퀴즈왕', characterId: 'slime-blue', isReady: false, connected: true },
      { id: FRIEND, nickname: '친구', characterId: 'slime-pink', isReady: false, connected: true },
    ],
  };
  const waiting = createWaitingRoom({
    roomStore: {
      isNetworked: true,
      isPersistent: true,
      me: () => ME,
      getRoom: async () => room,
      subscribe: (_code, handler) => { roomEvents = handler; return () => { roomEvents = null; }; },
      sendMovement: (spec) => { sent.push(spec); return true; },
    },
    onLeave: () => {},
    onStart: () => {},
    onMatchInvalidated: () => {},
    getPlayer: () => ({ nickname: '퀴즈왕', characterId: 'slime-blue' }),
  });
  // 휴대폰: 액자 한 줄의 라운지 360px. 바닥(아래 176px)이 184px부터다
  const lounge = byId('lounge');
  lounge.box = { left: 16, top: 400, width: 358, height: 360 };
  const screen = screens['[data-screen="waiting"]'];

  screen.hidden = true;
  await waiting.show('ABC234', 'slime-blue', 1);
  screen.hidden = false;
  waiting.activate();

  // 시작 자리(라운지 왼쪽 아래, 바닥 위)를 무대 좌표로 알린다
  const placed = sent.at(-1);
  assert.equal(placed.code, 'ABC234');
  assert.equal(placed.stage, 'lounge');
  assert.ok(Math.abs(placed.stageX - 40 / 358) < 0.001, `${placed.stageX}`);
  assert.ok(placed.stageY > 0.5, '바닥 띠');
  assert.ok(Math.abs(placed.stageY - (0.5 + 0.5 * (86 / 176))) < 0.001, `${placed.stageY}`);

  // 데스크톱 친구: 라운지 바닥 아래 끝에서 30px 위(탁자 앞)
  const floorUnit = 0.5 + 0.5 * ((176 - 30) / 176);
  roomEvents({
    type: 'movement', playerId: FRIEND, x: 0.5, y: 0.6, moving: false,
    viewportWidth: 1440, viewportHeight: 900,
    stage: 'lounge', stageX: 0.5, stageY: Number(floorUnit.toFixed(4)),
    sequence: 1, connectionGeneration: 1,
  });
  const friend = remoteNode('waiting-remote-characters');
  const match = friend.style.transform.match(/^translate\(([\d.]+)px, ([\d.]+)px\)/);
  assert.ok(match, friend.style.transform);
  assert.ok(Math.abs(Number(match[1]) - (16 + 179)) < 0.5);
  // 이 화면 라운지의 바닥 아래 끝(760)에서도 30px 위다 — 소파·탁자와 같은 자리
  assert.ok(Math.abs(760 - Number(match[2]) - 30) < 0.5, friend.style.transform);
  assert.equal(friend.classList.contains('walker--relayout'), false);

  // 라운지가 스크롤로 올라가면 바닥과 함께, 전환 없이 옮긴다 — 보간하면 스크롤 중에 바닥에서 떨어진다
  lounge.box = { ...lounge.box, top: 300 };
  scroll();
  const scrolled = friend.style.transform.match(/^translate\(([\d.]+)px, ([\d.]+)px\)/);
  assert.ok(scrolled, friend.style.transform);
  assert.ok(Math.abs(660 - Number(scrolled[2]) - 30) < 0.5, friend.style.transform);
  assert.equal(friend.classList.contains('walker--relayout'), true);
  lounge.box = { ...lounge.box, top: 400 };
  scroll();

  // 라운지에서 보낸 것이 아닌 무대(퀴즈 바닥)는 예전 길로 그린다
  roomEvents({
    type: 'movement', playerId: FRIEND, x: 0.5, y: 0.6, moving: false,
    viewportWidth: 1440, viewportHeight: 900,
    stage: 'arena', stageX: 0.5, stageY: 0.5,
    sequence: 2, connectionGeneration: 1,
  });
  assert.match(friend.style.transform, /^translate\(clamp\(/);
  waiting.hide();
});
