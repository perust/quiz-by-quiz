import test from 'node:test';
import assert from 'node:assert/strict';

// 대기실의 «이 사람 말 숨기기»(N06)와 방장의 «내보내기»(U24)를 가짜 DOM 위에 실제로 띄워 확인한다.
// - 말 숨기기는 내 화면에서만: 그 사람의 대화 줄·말풍선을 그리지 않고, 켜고 끌 때 조용한 한 줄을 남긴다.
//   이름은 고정이고 상태는 aria-pressed 다. 방 snapshot 이 명단을 다시 만들어도 상태와 포커스가 남는다
// - 내보내기는 방장 화면의 남의 액자마다 있고, 인페이지 확인을 거친다. 확인창은 접속 중인 사람(잠시 다시
//   들어올 수 없다)과 끊긴 사람(돌아오면 다시 참가할 수 있다)을 다르게 말하고, 확인한 상태를 그대로 보낸다.
//   내보낸 사람은 «나갔어요»가 아니라 «내보냈어요» 한 줄로 남고, 닫으면 갈 곳으로 포커스를 옮긴다
// - 내보내진 사람이 돌아오면 «방이 사라졌다»가 아니라 «방장이 내보냈다»를 듣는다
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
console.warn = () => {};

const { createWaitingRoom } = await import('../js/ui/waiting-room.js');
const { createChatMutes } = await import('../js/ui/chat-mutes.js');
const { RemovedFromRoom, REMOVED_BY_HOST_MESSAGE, REMOVED_BY_HOST_MESSAGES } = await import('../js/online/rules.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 5; i += 1) await tick();
}

const ME = 'me';
function player(id, nickname, { isReady = false, connected = true } = {}) {
  return { id, nickname, characterId: 'slime-blue', isReady, connected };
}
function snapshot(players, changes = {}) {
  return {
    code: 'SAF234',
    name: '우리 반',
    categoryId: null,
    capacity: 6,
    gameMode: true,
    players,
    isPublic: true,
    hasPassword: false,
    isMine: true,
    joined: true,
    createdAt: '2026-10-27T00:00:00.000Z',
    status: 'waiting',
    inMatch: false,
    ...changes,
  };
}

let roomEvents = null;
const behaviour = {};
const removeCalls = [];
let getRoomCalls = 0;
const roomStore = {
  isNetworked: true,
  isPersistent: true,
  me: () => ME,
  getRoom: (code) => {
    getRoomCalls += 1;
    return behaviour.getRoom(code);
  },
  subscribe: (code, handler) => {
    roomEvents = handler;
    return () => { if (roomEvents === handler) roomEvents = null; };
  },
  sendMovement: () => false,
  removeMember: (spec) => {
    removeCalls.push(spec);
    return behaviour.removeMember(spec);
  },
};

const left = [];
const chatMutes = createChatMutes();
const waiting = createWaitingRoom({
  roomStore,
  onLeave: (code, entryGeneration, reason) => left.push({ code, reason }),
  onStart: () => {},
  onMatchInvalidated: () => {},
  getPlayer: () => ({ nickname: '퀴즈왕', characterId: 'slime-blue' }),
  chatMutes,
});

function textOf(node) {
  return typeof node === 'string' ? node : node.textContent + node.children.map(textOf).join('');
}
const chatLines = () => byId('chat-log').children.map(textOf);

/** 그 사람 액자의 작은 버튼. 없으면 undefined */
function portraitButton(playerId, action) {
  const item = byId('lounge-players').children.find((child) => child.dataset.playerId === playerId);
  return item?.children.find((child) => child.dataset?.portraitAction === action);
}

/** 그 사람 캐릭터의 말풍선 (원격 캐릭터 첫 자식) */
function remoteBubble(playerId) {
  const figure = byId('waiting-remote-characters').children
    .find((child) => child.dataset.movingPlayerId === playerId);
  return figure?.children[0];
}

async function enter(room) {
  behaviour.getRoom = async () => room;
  screen.hidden = true;
  await waiting.show(room.code, 'slime-blue', 1);
  screen.hidden = false;
  waiting.activate();
}

const chat = (playerId, nickname, text) => ({ type: 'chat', playerId, nickname, text, at: 0 });

test('말 숨기기: 남의 액자에만 있고, 이름은 고정·상태는 aria-pressed 다 (N06)', async () => {
  await enter(snapshot([player(ME, '퀴즈왕'), player('guest', '민수')]));
  assert.equal(portraitButton(ME, 'mute'), undefined, '내 말은 숨길 일이 없다');
  const mute = portraitButton('guest', 'mute');
  assert.ok(mute, '남의 액자에는 말 숨기기가 있다');
  assert.equal(mute.tagName, 'BUTTON', '걸어가 밟고 누를 수 있는 진짜 버튼이다');
  assert.equal(mute.getAttribute('aria-label'), '민수 님 말 숨기기');
  assert.equal(mute.getAttribute('aria-pressed'), 'false');
  waiting.hide();
});

test('말 숨기기를 켜면 그 사람의 줄·말풍선이 내 화면에서 사라지고, 뒤에 온 말도 그리지 않는다 (N06)', async () => {
  await enter(snapshot([player(ME, '퀴즈왕'), player('guest', '민수'), player('friend', '지수')]));
  roomEvents(chat('guest', '민수', '안녕'));
  roomEvents(chat('friend', '지수', '반가워'));
  assert.deepEqual(chatLines(), ['민수 안녕', '지수 반가워']);
  assert.equal(remoteBubble('guest').hidden, false, '말풍선이 떠 있다');

  portraitButton('guest', 'mute').click();
  assert.equal(portraitButton('guest', 'mute').getAttribute('aria-pressed'), 'true');
  assert.equal(chatMutes.isMuted('SAF234', 'guest'), true, '그 방의 온라인 퀴즈가 같은 목록을 본다');
  assert.equal(remoteBubble('guest').hidden, true, '떠 있던 말풍선도 거둔다');
  assert.deepEqual(chatLines(), ['지수 반가워', '민수 님의 말을 숨겼어요. 내 화면에서만 숨겨져요.']);

  roomEvents(chat('guest', '민수', '또 왔다'));
  roomEvents(chat(ME, '퀴즈왕', '나는 보인다'));
  assert.deepEqual(chatLines().slice(-1), ['퀴즈왕 나는 보인다'], '숨긴 사람의 새 말은 그리지 않고 내 말은 그린다');
  assert.equal(remoteBubble('guest').hidden, true);

  // 방 snapshot 이 명단을 다시 만들어도 숨김은 그대로다
  roomEvents({ type: 'room', room: snapshot([player(ME, '퀴즈왕'), player('guest', '민수', { isReady: true }), player('friend', '지수')]) });
  assert.equal(portraitButton('guest', 'mute').getAttribute('aria-pressed'), 'true');

  portraitButton('guest', 'mute').click();
  assert.equal(chatLines().at(-1), '민수 님의 말을 다시 보여요.');
  roomEvents(chat('guest', '민수', '다시 보이니'));
  assert.equal(chatLines().at(-1), '민수 다시 보이니');
  assert.equal(chatMutes.isMuted('SAF234', 'guest'), false);
  waiting.hide();
});

test('방 snapshot 이 명단을 다시 만들어도 액자 버튼의 키보드 자리를 잃지 않는다', async () => {
  await enter(snapshot([player(ME, '퀴즈왕'), player('guest', '민수')]));
  portraitButton('guest', 'mute').focus();
  roomEvents({ type: 'room', room: snapshot([player(ME, '퀴즈왕'), player('guest', '민수', { isReady: true })]) });
  assert.equal(globalThis.document.activeElement, portraitButton('guest', 'mute'), '새로 만든 같은 버튼으로 옮긴다');

  // 그 사람이 나가 버튼이 없어지면 <body> 로 떨어뜨리지 않는다
  roomEvents({ type: 'room', room: snapshot([player(ME, '퀴즈왕')]) });
  assert.notEqual(globalThis.document.activeElement, globalThis.document.body);
  assert.ok([byId('waiting-start'), screen].includes(globalThis.document.activeElement));
  waiting.hide();
});

test('내보내기는 방장 화면의 남의 액자마다 있다 (U24, 소유자 결정)', async () => {
  const players = [player(ME, '퀴즈왕'), player('guest', '민수'), player('ghost', '유령', { connected: false })];
  await enter(snapshot(players));
  for (const [id, nickname] of [['guest', '민수'], ['ghost', '유령']]) {
    const remove = portraitButton(id, 'remove');
    assert.ok(remove, `${nickname} 님 액자에 내보내기가 있다`);
    assert.equal(remove.tagName, 'BUTTON', '걸어가 밟고 누를 수 있는 진짜 버튼이다');
    assert.equal(remove.textContent, '내보내기');
    assert.equal(remove.getAttribute('aria-label'), `${nickname} 님 내보내기`, '보이는 글자를 이름에 품는다');
    assert.equal(remove.getAttribute('aria-haspopup'), 'dialog');
  }
  assert.equal(portraitButton(ME, 'remove'), undefined);
  waiting.hide();

  await enter(snapshot([player('host', '방장'), player(ME, '퀴즈왕'), player('ghost', '유령', { connected: false })], { isMine: false }));
  assert.equal(portraitButton('host', 'remove'), undefined, '방장이 아니면 내보낼 수 없다');
  assert.equal(portraitButton('ghost', 'remove'), undefined);
  assert.ok(portraitButton('ghost', 'mute'), '말 숨기기는 누구나 쓴다');
  waiting.hide();
});

test('끊긴 사람의 내보내기는 인페이지 확인을 거치고, 내보낸 사람은 «내보냈어요» 한 줄로만 남는다 (U24)', async () => {
  removeCalls.length = 0;
  const players = [player(ME, '퀴즈왕'), player('ghost', '유령', { connected: false })];
  await enter(snapshot(players));
  const dialog = byId('remove-member-dialog');
  dialog.hidden = true;

  // 그대로 두기: 확인창을 닫고 연 버튼으로 돌아간다
  portraitButton('ghost', 'remove').click();
  assert.equal(dialog.hidden, false);
  assert.equal(byId('remove-member-title').textContent, '유령 님을 내보낼까요?');
  assert.match(byId('remove-member-body').textContent, /돌아오면 방 코드로 다시 참가할 수 있어요/);
  assert.equal(globalThis.document.activeElement, byId('remove-member-cancel'), '되돌릴 수 없는 쪽에 먼저 서지 않는다');
  byId('remove-member-cancel').click();
  assert.equal(dialog.hidden, true);
  assert.equal(globalThis.document.activeElement, portraitButton('ghost', 'remove'));
  assert.deepEqual(removeCalls, []);

  let resolve;
  behaviour.removeMember = () => new Promise((done) => { resolve = done; });
  portraitButton('ghost', 'remove').click();
  byId('remove-member-confirm').click();
  await tick();
  assert.equal(byId('remove-member-confirm').disabled, true, '보내는 동안 겹쳐 누를 수 없다');
  assert.equal(byId('remove-member-confirm').textContent, '내보내는 중…');
  assert.deepEqual(removeCalls, [{ code: 'SAF234', playerId: 'ghost', connected: false }], '확인창이 말한 상태를 그대로 보낸다');

  resolve({ ok: true, room: snapshot([player(ME, '퀴즈왕')]) });
  await settle();
  assert.equal(dialog.hidden, true);
  assert.equal(byId('remove-member-confirm').disabled, false);
  assert.equal(chatLines().at(-1), '유령 님을 내보냈어요.');
  assert.ok(!chatLines().some((line) => line.includes('나갔어요')), '같은 일을 두 줄로 쓰지 않는다');
  assert.equal(portraitButton('ghost', 'remove'), undefined);
  assert.ok([byId('waiting-start'), screen].includes(globalThis.document.activeElement), '사라진 버튼 대신 갈 곳을 남긴다');
  waiting.hide();
});

test('접속 중인 사람의 내보내기는 «잠시 다시 들어올 수 없어요»를 보이고 그 뜻을 실어 보낸다', async () => {
  removeCalls.length = 0;
  await enter(snapshot([player(ME, '퀴즈왕'), player('guest', '민수'), player('friend', '지수')]));
  const dialog = byId('remove-member-dialog');
  dialog.hidden = true;

  portraitButton('guest', 'remove').click();
  assert.equal(dialog.hidden, false);
  assert.equal(byId('remove-member-title').textContent, '민수 님을 방에서 내보낼까요?');
  assert.match(byId('remove-member-body').textContent, /^잠시 다시 들어올 수 없어요\./);
  assert.equal(globalThis.document.activeElement, byId('remove-member-cancel'));

  behaviour.removeMember = async () => ({ ok: true, room: snapshot([player(ME, '퀴즈왕'), player('friend', '지수')]) });
  byId('remove-member-confirm').click();
  await settle();
  assert.deepEqual(removeCalls, [{ code: 'SAF234', playerId: 'guest', connected: true }]);
  assert.equal(dialog.hidden, true);
  assert.equal(chatLines().at(-1), '민수 님을 내보냈어요.');
  assert.ok(!chatLines().some((line) => line.includes('나갔어요')));
  assert.equal(portraitButton('guest', 'remove'), undefined);
  assert.ok(portraitButton('friend', 'remove'), '남은 사람의 버튼은 그대로다');
  assert.notEqual(globalThis.document.activeElement, globalThis.document.body, '포커스를 잃지 않는다');

  // 끊긴 사람으로 열었던 확인창 다음에도 상태를 다시 읽어 맞는 말을 한다
  roomEvents({ type: 'room', room: snapshot([player(ME, '퀴즈왕'), player('friend', '지수', { connected: false })]) });
  portraitButton('friend', 'remove').click();
  assert.equal(byId('remove-member-title').textContent, '지수 님을 내보낼까요?');
  assert.match(byId('remove-member-body').textContent, /다시 참가할 수 있어요/);
  byId('remove-member-cancel').click();
  waiting.hide();
});

test('끊긴 자리를 비우려던 사이 다시 붙어 거절되면 이유를 말하고 방을 다시 읽는다', async () => {
  await enter(snapshot([player(ME, '퀴즈왕'), player('ghost', '유령', { connected: false })]));
  behaviour.removeMember = async () => ({ ok: false, reason: 'member-connected' });
  // 서버가 본 방: 그 사람은 다시 접속 중이다
  behaviour.getRoom = async () => snapshot([player(ME, '퀴즈왕'), player('ghost', '유령')]);
  const readsBefore = getRoomCalls;
  portraitButton('ghost', 'remove').click();
  byId('remove-member-confirm').click();
  await settle();
  assert.equal(byId('remove-member-dialog').hidden, true);
  assert.equal(chatLines().at(-1), '유령 님이 다시 연결됐어요. 그래도 내보내려면 다시 눌러 주세요.');
  assert.equal(getRoomCalls, readsBefore + 1, 'presence sweep 을 기다리지 않고 방을 다시 읽는다');
  assert.equal(globalThis.document.activeElement, portraitButton('ghost', 'remove'), '새로 그린 같은 버튼으로 돌아간다');

  // 다시 누르면 접속 중인 사람의 확인창이 열린다 — 확인창이 말하지 않은 차단은 걸리지 않는다
  portraitButton('ghost', 'remove').click();
  assert.equal(byId('remove-member-title').textContent, '유령 님을 방에서 내보낼까요?');

  // 화면을 떠나면 확인창도 접는다 — <main> 밖이라 다음 화면 위에 남는다
  waiting.hide();
  assert.equal(byId('remove-member-dialog').hidden, true);
});

test('내보내진 사람이 돌아오면 «방이 사라졌다»가 아니라 «방장이 내보냈다»를 듣는다 (U24)', async () => {
  left.length = 0;
  behaviour.getRoom = async () => { throw new RemovedFromRoom(); };
  screen.hidden = true;
  await waiting.show('SAF234', 'slime-blue', 1);
  assert.deepEqual(left, [{ code: 'SAF234', reason: REMOVED_BY_HOST_MESSAGE }]);

  // 접속 중에 내보내져 아직 막혀 있으면 잠시 뒤에 들어올 수 있다고 말한다
  left.length = 0;
  behaviour.getRoom = async () => { throw new RemovedFromRoom('kicked'); };
  screen.hidden = true;
  await waiting.show('SAF234', 'slime-blue', 1);
  assert.deepEqual(left, [{ code: 'SAF234', reason: REMOVED_BY_HOST_MESSAGES.kicked }]);

  // 대기실을 연 채 끊겨 있다가 다시 붙으려는 순간 들은 경우도 같다
  left.length = 0;
  await enter(snapshot([player('host', '방장'), player(ME, '퀴즈왕')], { isMine: false }));
  roomEvents({ type: 'removed', kind: 'removed' });
  assert.deepEqual(left, [{ code: 'SAF234', reason: REMOVED_BY_HOST_MESSAGE }]);
  assert.match(REMOVED_BY_HOST_MESSAGE, /방장이 방에서 내보냈어요/);
  waiting.hide();

  // 대기실에 있는 동안 방장이 나를 내보냈다 — 열린 소켓으로 곧바로 듣고 로비로 간다
  left.length = 0;
  await enter(snapshot([player('host', '방장'), player(ME, '퀴즈왕')], { isMine: false }));
  roomEvents({ type: 'removed', kind: 'kicked' });
  assert.deepEqual(left, [{ code: 'SAF234', reason: '방장이 방에서 내보냈어요. 잠시 뒤에 다시 들어올 수 있어요.' }]);
  waiting.hide();
});
