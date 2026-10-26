import test from 'node:test';
import assert from 'node:assert/strict';

// 대기실에서 «말 숨기기»를 켠 사람의 말은 그 방의 온라인 퀴즈에서도 그리지 않는다 (N06).
// 온라인 퀴즈 화면을 가짜 DOM 위에 띄우고, 매치 소켓이 전한 채팅을 그대로 넣어 본다.

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
  scrollIntoView() {}
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
  matchMedia: () => ({ matches: false }),
};
globalThis.document = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: (id) => byId(id),
  querySelector: (selector) => (selector === '[data-screen="online-quiz"]' ? screen : null),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { createOnlineQuizScreen } = await import('../js/ui/online-quiz.js');

/** 무대는 이 검사의 관심사가 아니다. 무엇을 물어도 아무 일도 하지 않는다 */
const quietArena = () => new Proxy({}, { get: () => () => undefined });

const hidden = new Set();
const quiz = createOnlineQuizScreen({
  onSubmit: async () => {},
  onMovement: () => {},
  onSendChat: async () => ({ ok: true }),
  onExit: () => {},
  onFinished: () => {},
  getPlayerId: () => 'me',
  isChatHidden: (playerId) => hidden.has(playerId),
  createCharacterArena: quietArena,
  trapFocus: () => {},
});

const room = {
  code: 'SAF234', name: '우리 반', categoryId: null, capacity: 6, gameMode: true,
  players: [
    { id: 'me', nickname: '퀴즈왕', characterId: 'slime-blue', isReady: true, connected: true },
    { id: 'guest', nickname: '민수', characterId: 'slime-blue', isReady: true, connected: true },
    { id: 'friend', nickname: '지수', characterId: 'slime-blue', isReady: true, connected: true },
  ],
  isPublic: true, hasPassword: false, isMine: true, joined: true,
  createdAt: '2026-10-27T00:00:00.000Z', status: 'playing', inMatch: true,
};
const chat = (playerId, nickname, text) => ({ type: 'chat', playerId, nickname, text, at: 0 });
const textOf = (node) => (typeof node === 'string' ? node : node.textContent + node.children.map(textOf).join(''));
const lines = () => byId('online-chat-log').children.map(textOf);
const bubbleOf = (playerId) => byId('online-remote-characters').children
  .find((child) => child.dataset.movingPlayerId === playerId)?.children[0];

test('대기실에서 숨긴 사람의 말은 매치 중에도 로그·말풍선에 그리지 않는다 (N06)', () => {
  quiz.startPresence();
  quiz.setRoom(room);
  hidden.add('guest');

  quiz.updateChat(chat('guest', '민수', '정답은 2번'));
  quiz.updateChat(chat('friend', '지수', '어렵다'));
  quiz.updateChat(chat('me', '퀴즈왕', '같이 풀자'));
  assert.deepEqual(lines(), ['지수 어렵다', '퀴즈왕 같이 풀자'], '숨긴 사람만 빠지고 내 말과 남의 말은 그대로다');
  assert.equal(bubbleOf('guest').hidden, true, '말풍선도 띄우지 않는다');
  assert.equal(bubbleOf('friend').hidden, false);

  // 대기실에서 다시 보기로 바꾸면 그 뒤의 말은 보인다
  hidden.delete('guest');
  quiz.updateChat(chat('guest', '민수', '다시 보여?'));
  assert.equal(lines().at(-1), '민수 다시 보여?');
  quiz.stopPresence();
});
