import test from 'node:test';
import assert from 'node:assert/strict';

// 대기실을 가짜 DOM 위에 실제로 띄워 확인한다.
// - 겹친 이름 알림(U02)은 화면이 보인 뒤에 대화 로그(role=log)에 들어간다 (a11y-ux-01)
// - 거절된 시작 뒤 다시 읽지 못해도 상태 줄이 «다시 확인하는 중…»에 멈추지 않는다 (online-client-5)
// - 방 작업 실패는 이유를 아는 오류(요청 한도·시간 초과·서버의 4xx)면 그 말을 쓴다 (U40)
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
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  select() {}
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const screen = new FakeElement('section');

globalThis.HTMLElement = FakeElement;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  // 2초 heartbeat 를 진짜로 걸면 테스트 프로세스가 끝나지 않는다
  setInterval: () => 1,
  clearInterval() {},
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id),
};
globalThis.document = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => (selector === '[data-screen="waiting"]' ? screen : null),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// 개발 상세는 콘솔에만 남긴다(onlineErrorText). 테스트 출력이 덮이지 않게 모아 둔다
const warnings = [];
console.warn = (...args) => { warnings.push(args); };

const { createWaitingRoom } = await import('../js/ui/waiting-room.js');
const { OnlinePlayerError } = await import('../js/online/rules.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 5; i += 1) await tick();
}

const ME = 'me';
function player(id, nickname, isReady = false) {
  return { id, nickname, characterId: 'slime-blue', isReady, connected: true };
}
function snapshot(players, changes = {}) {
  return {
    code: 'ABC234',
    name: '우리 반',
    categoryId: null,
    capacity: 6,
    gameMode: true,
    questionTimeMs: 20_000,
    players,
    isPublic: true,
    hasPassword: false,
    isMine: true,
    joined: true,
    createdAt: '2026-10-27T00:00:00.000Z',
    status: 'waiting',
    ...changes,
  };
}

/** 저장소 흉내. 테스트마다 behaviour 의 함수를 갈아 끼운다 */
let roomEvents = null;
const behaviour = {};
const roomStore = {
  isNetworked: true,
  isPersistent: true,
  me: () => ME,
  getRoom: (code) => behaviour.getRoom(code),
  subscribe: (code, handler) => {
    roomEvents = handler;
    return () => { if (roomEvents === handler) roomEvents = null; };
  },
  sendMovement: () => false,
  updateRoom: (spec) => behaviour.updateRoom(spec),
  setReady: (spec) => behaviour.setReady(spec),
  startGame: (spec) => behaviour.startGame(spec),
  sendChat: (spec) => behaviour.sendChat(spec),
  leaveRoom: (spec) => behaviour.leaveRoom(spec),
};

const left = [];
const waiting = createWaitingRoom({
  roomStore,
  onLeave: (code, entryGeneration, reason) => left.push({ code, reason }),
  onStart: () => {},
  onMatchInvalidated: () => {},
  getPlayer: () => ({ nickname: '퀴즈왕', characterId: 'slime-blue' }),
});

/** 대화 로그의 줄 글자 */
function chatLines() {
  const textOf = (node) => (typeof node === 'string'
    ? node
    : node.textContent + node.children.map(textOf).join(''));
  return byId('chat-log').children.map(textOf);
}

/** app.ts 의 openWaitingRoom 순서: show(숨은 채로) → goTo('waiting') → activate() */
async function enter(room, { activate = true } = {}) {
  behaviour.getRoom = async () => room;
  screen.hidden = true;
  await waiting.show(room.code, 'slime-blue', 1);
  if (!activate) return;
  screen.hidden = false;
  waiting.activate();
}

const READY_ROOM = snapshot([player(ME, '퀴즈왕'), player('guest', '민수', true)]);

test('겹친 이름 알림은 숨은 대기실이 아니라 펼친 뒤의 대화 로그에 들어간다 (U02, a11y-ux-01)', async () => {
  const renamed = snapshot([player('host', '퀴즈왕'), player(ME, '퀴즈왕1')], { code: 'NIC234', isMine: false });

  await enter(renamed, { activate: false });
  assert.equal(screen.hidden, true, '판 복구를 묻는 동안 대기실은 아직 숨어 있다');
  assert.deepEqual(chatLines(), [], '숨은 role=log 에 넣으면 낭독되지 않는다');

  // 숨은 동안 온 room snapshot 도 알림을 소진하지 않는다
  roomEvents({ type: 'room', room: { ...renamed } });
  assert.deepEqual(chatLines(), []);

  screen.hidden = false;
  waiting.activate();
  assert.deepEqual(chatLines(), ['이 방에서는 퀴즈왕1로 보여요.'], '펼친 뒤에 넣어 낭독된다');

  // 방·이름마다 한 번뿐이다
  roomEvents({ type: 'room', room: { ...renamed } });
  waiting.activate();
  assert.deepEqual(chatLines(), ['이 방에서는 퀴즈왕1로 보여요.']);
  waiting.hide();
});

test('시작이 not-ready 로 거절된 뒤 다시 읽지 못하면 상태 줄이 «확인하는 중»에 멈추지 않는다 (online-client-5)', async () => {
  await enter(READY_ROOM);
  const status = byId('waiting-start-status');
  assert.equal(status.textContent, '모두 준비됐어요. 게임을 시작해 보세요.');

  let reload;
  behaviour.startGame = async () => ({ ok: false, reason: 'not-ready' });
  behaviour.getRoom = () => new Promise((_resolve, reject) => { reload = reject; });
  byId('waiting-start').click();
  await settle();
  assert.equal(status.textContent, '그 사이 준비 상태가 바뀌었어요. 다시 확인하는 중…');

  reload(new OnlinePlayerError('잠시 뒤 다시 시도해 주세요.')); // 요청 한도(429)
  await settle();
  assert.equal(
    status.textContent,
    '준비 상태를 다시 확인하지 못했어요. 잠시 뒤 다시 눌러 주세요.',
    '아무것도 돌지 않는데 확인 중이라고 말하지 않는다',
  );

  // 다음 snapshot 이 오면 그 방으로 다시 그린다
  roomEvents({ type: 'room', room: snapshot([player(ME, '퀴즈왕'), player('guest', '민수', false)]) });
  assert.equal(status.textContent, '준비 1/2명 · 민수 님 기다리는 중');
  waiting.hide();
});

test('거절 뒤 다시 읽어 보니 방이 사라졌으면 그렇다고 말하고 상태 줄도 멈춰 두지 않는다', async () => {
  await enter(READY_ROOM);
  behaviour.startGame = async () => ({ ok: false, reason: 'not-ready' });
  behaviour.getRoom = async () => null;
  byId('waiting-start').click();
  await settle();

  assert.equal(byId('waiting-start-status').textContent, '준비 상태를 다시 확인하지 못했어요. 잠시 뒤 다시 눌러 주세요.');
  assert.equal(chatLines().at(-1), '그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.');
  waiting.hide();
});

test('거절 뒤 다시 읽은 방이 오면 그 방으로 상태 줄을 다시 그린다', async () => {
  await enter(READY_ROOM);
  behaviour.startGame = async () => ({ ok: false, reason: 'not-ready' });
  behaviour.getRoom = async () => snapshot([player(ME, '퀴즈왕'), player('guest', '민수', false)]);
  byId('waiting-start').click();
  await settle();

  assert.equal(byId('waiting-start-status').textContent, '준비 1/2명 · 민수 님 기다리는 중');
  waiting.hide();
});

test('방 작업 실패: 요청 한도·시간 초과처럼 이유를 아는 오류는 그 말을, 모르는 오류는 연결 안내를 쓴다 (U40)', async () => {
  await enter(READY_ROOM);
  const rateLimited = () => Promise.reject(new OnlinePlayerError('잠시 뒤 다시 시도해 주세요.'));
  const offline = () => Promise.reject(new Error('Failed to fetch'));

  behaviour.updateRoom = rateLimited;
  byId('setting-category').click();
  await settle();
  assert.equal(chatLines().at(-1), '방 설정을 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요.');

  behaviour.updateRoom = offline;
  byId('setting-category').click();
  await settle();
  assert.equal(chatLines().at(-1), '방 설정을 바꾸지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
  assert.ok(warnings.some(([, error]) => error?.message === 'Failed to fetch'), '개발 상세는 콘솔에만 남는다');

  behaviour.setReady = rateLimited;
  byId('waiting-ready').click();
  await settle();
  assert.equal(chatLines().at(-1), '준비 상태를 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요.');

  behaviour.startGame = () => Promise.reject(new OnlinePlayerError('응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.'));
  byId('waiting-start').click();
  await settle();
  assert.equal(chatLines().at(-1), '판을 시작하지 못했어요. 응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.');

  behaviour.leaveRoom = rateLimited;
  byId('waiting-leave').click();
  await settle();
  assert.equal(chatLines().at(-1), '방에서 나오지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  assert.deepEqual(left, [], '거절됐으면 방을 떠나지 않는다');

  behaviour.sendChat = () => Promise.reject(new OnlinePlayerError('채팅은 잠시 뒤 다시 보낼 수 있습니다.'));
  byId('chat-input').value = '안녕';
  byId('chat-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(chatLines().at(-1), '메시지를 보내지 못했어요. 채팅은 잠시 뒤 다시 보낼 수 있습니다.');
  assert.equal(byId('chat-input').value, '안녕', '보내지 못한 글은 칸에 남긴다');
  waiting.hide();
});

test('문항 시간 칸: 모두에게 같은 값이 보이고 방장만 20초 ↔ 40초로 돌린다 (FR-3.7)', async () => {
  const patches = [];
  behaviour.updateRoom = async ({ patch }) => {
    patches.push(patch);
    return { ok: true, room: snapshot(READY_ROOM.players, { questionTimeMs: patch.questionTimeMs }) };
  };
  await enter(READY_ROOM);
  const button = byId('setting-question-time');
  const value = byId('setting-question-time-value');
  assert.equal(value.textContent, '20초');
  assert.equal(button.disabled, false, '방장은 돌릴 수 있다');

  button.click();
  await settle();
  assert.deepEqual(patches, [{ questionTimeMs: 40_000 }], '20초 다음은 40초다');
  assert.equal(value.textContent, '40초', '저장소가 돌려준 방으로 다시 그린다');

  button.click();
  await settle();
  assert.deepEqual(patches.at(-1), { questionTimeMs: 20_000 }, '40초 다음은 다시 20초다 — 제한 없음이 없다');
  assert.equal(value.textContent, '20초');
  waiting.hide();

  // 참가자에게도 보이지만 잠겨 있다. 바꾸는 판정은 저장소가 한다 (not-host)
  const guestRoom = snapshot([player('host', '민수'), player(ME, '퀴즈왕')], {
    code: 'GST234', isMine: false, questionTimeMs: 40_000,
  });
  await enter(guestRoom);
  assert.equal(value.textContent, '40초');
  assert.equal(button.disabled, true);
  // 대기실에 있는 동안 방장이 바꾸면 같은 칸이 따라 바뀐다
  roomEvents({ type: 'room', room: { ...guestRoom, questionTimeMs: 20_000 } });
  assert.equal(value.textContent, '20초');
  waiting.hide();

  // 판이 도는 동안에는 방장도 바꾸지 못한다 (판에서 빠진 방장이 대기실에 있을 때). 서버가 거절할 버튼을 열어 두지 않는다
  await enter(snapshot(READY_ROOM.players, { code: 'PLY234', status: 'playing', inMatch: false }));
  for (const id of ['setting-category', 'setting-capacity', 'setting-question-time']) {
    assert.equal(byId(id).disabled, true, id);
  }
  roomEvents({ type: 'room', room: snapshot(READY_ROOM.players, { code: 'PLY234', status: 'waiting' }) });
  assert.equal(button.disabled, false, '판이 끝나면 다시 돌릴 수 있다');
  waiting.hide();
});
