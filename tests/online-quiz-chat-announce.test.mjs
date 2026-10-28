import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 매치 중 채팅 낭독 (U42, 소유자 결정: 화면 낭독기는 매치 중에도 채팅을 읽는다).
// - 대화 로그는 role="log"·aria-live="polite"·aria-relevant="additions"이고 줄을 하나씩 붙이기만 한다 — 새 줄(말한
//   사람 이름 + 말)만 낭독되고, 로그 전체를 다시 그리지 않으며, 포커스를 옮기지 않는다
// - 새 문항(질문 제목으로 포커스)과 남은 5초 경고가 먼저다. 같은 순간에 온 채팅 줄은 잠깐 기다렸다 그 뒤에 붙는다
// - 숨긴 사람(N06)의 말은 기다리는 사이에 숨겨도 낭독되지 않는다
// 온라인 퀴즈 화면을 가짜 DOM과 가짜 시계 위에 띄워 실제로 그려 본다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

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
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get firstElementChild() { return this.children.find((child) => child instanceof FakeElement) ?? null; }
  get childElementCount() { return this.children.filter((child) => child instanceof FakeElement).length; }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this;
      this.children.push(node);
      // 붙인 만큼 칸 안이 길어진다 — 화면이 끝에 맞추는지 보려는 값
      this.scrollHeight += 20;
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.scrollHeight = 0;
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  matches(selector) {
    return selector.startsWith('.') && `${this.className}`.split(/\s+/).includes(selector.slice(1));
  }
  querySelectorAll(selector) {
    return this.children
      .filter((child) => child instanceof FakeElement)
      .flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView() {}
}

/** 가짜 시계. 화면이 window.setTimeout 으로 건 일을 advance(ms)가 시각 순서대로 돌린다 */
const clock = { now: 0, next: 1, tasks: new Map() };
function advance(ms) {
  const end = clock.now + ms;
  for (;;) {
    const due = [...clock.tasks.entries()]
      .filter(([, task]) => task.at <= end)
      .sort((left, right) => left[1].at - right[1].at)[0];
    if (!due) break;
    clock.tasks.delete(due[0]);
    clock.now = due[1].at;
    due[1].run();
  }
  clock.now = end;
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const screen = new FakeElement('section');

globalThis.HTMLElement = FakeElement;
globalThis.HTMLLIElement = FakeElement;
globalThis.HTMLButtonElement = FakeElement;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  setInterval: () => 1,
  clearInterval() {},
  setTimeout: (run, ms) => {
    const id = clock.next++;
    clock.tasks.set(id, { at: clock.now + ms, run });
    return id;
  },
  clearTimeout: (id) => { clock.tasks.delete(id); },
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

const { createChatLineQueue, CHAT_PRIORITY_HOLD_MS } = await import('../js/ui/chat-queue.js');
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
  code: 'CHT234', name: '우리 반', categoryId: null, capacity: 6, gameMode: true,
  players: [
    { id: 'me', nickname: '퀴즈왕', characterId: 'slime-blue', isReady: true, connected: true },
    { id: 'guest', nickname: '민수', characterId: 'slime-blue', isReady: true, connected: true },
    { id: 'friend', nickname: '지수', characterId: 'slime-blue', isReady: true, connected: true },
  ],
  isPublic: true, hasPassword: false, isMine: true, joined: true,
  createdAt: '2026-10-27T00:00:00.000Z', status: 'playing', inMatch: true,
};

const MATCH = '12345678-1234-5678-9234-567812345678';
function running(position, remainingMs, changes = {}) {
  return {
    matchId: MATCH, state: 'running', categoryId: 'history', gameMode: true,
    currentPosition: position, totalQuestions: 10, deadlineAt: '2026-10-27T11:00:20+00:00', remainingMs,
    questionTimeMs: 20_000,
    question: {
      id: `history-00${position}`, categoryId: 'history', question: `${position}번 문제`,
      choices: ['가', '나', '다', '라'], position, total: 10,
    },
    ownSubmission: null,
    scores: [],
    ...changes,
  };
}

const chat = (playerId, nickname, text) => ({ type: 'chat', playerId, nickname, text, at: 0 });
const textOf = (node) => (typeof node === 'string' ? node : node.textContent + node.children.map(textOf).join(''));
const log = () => byId('online-chat-log');
const lines = () => log().children.map(textOf);
const bubbleOf = (playerId) => byId('online-remote-characters').children
  .find((child) => child.dataset.movingPlayerId === playerId)?.children[0];

function enterMatch() {
  hidden.clear();
  document.activeElement = document.body;
  quiz.startPresence();
  quiz.setRoom(room);
}

test('채팅 줄은 붙이기만 한다: 말한 사람 이름이 앞에 오고, 한도를 넘으면 오래된 줄만 떼며 포커스를 옮기지 않는다', () => {
  enterMatch();
  document.activeElement = document.body;
  quiz.updateChat(chat('friend', '지수', '안녕'));
  assert.deepEqual(lines(), ['지수 안녕'], '우선 낭독이 없으면 곧바로 붙는다');
  assert.equal(log().children[0].children[0].className, 'chat-log__who', '말한 사람 이름이 줄 맨 앞이다');
  assert.equal(document.activeElement, document.body, '포커스를 옮기지 않는다');

  for (const text of ['둘', '셋', '넷']) quiz.updateChat(chat('guest', '민수', text));
  const before = [...log().children];
  quiz.updateChat(chat('friend', '지수', '다섯'));
  assert.deepEqual(lines(), ['민수 둘', '민수 셋', '민수 넷', '지수 다섯'], '최근 네 줄만 남는다');
  // 로그를 다시 그리지 않는다 — 남은 줄은 같은 요소 그대로라 낭독기는 붙은 한 줄만 읽는다
  assert.deepEqual(log().children.slice(0, 3), before.slice(1));
  assert.equal(log().scrollTop, log().scrollHeight, '높이가 묶인 로그는 가장 새 줄이 보이게 끝에 맞춘다');
  assert.equal(document.activeElement, document.body);
  quiz.stopPresence();
});

test('새 문항이 먼저다: 질문 제목으로 포커스를 옮긴 순간에 온 채팅은 잠깐 기다렸다 그 뒤에 붙는다 (U42)', () => {
  enterMatch();
  quiz.render(running(1, 20_000));
  assert.equal(document.activeElement, byId('online-question-text'), '새 문항은 포커스로 낭독된다');

  quiz.updateChat(chat('friend', '지수', '이거 어렵다'));
  assert.deepEqual(lines(), [], '같은 순간의 채팅 줄은 문항 낭독 앞에 끼어들지 않는다');
  assert.equal(bubbleOf('friend').hidden, false, '눈으로 보는 말풍선은 기다리지 않는다');
  quiz.updateChat(chat('guest', '민수', '나도'));

  advance(CHAT_PRIORITY_HOLD_MS - 1);
  assert.deepEqual(lines(), []);
  advance(1);
  assert.deepEqual(lines(), ['지수 이거 어렵다', '민수 나도'], '기다린 줄은 온 차례대로 한 줄씩 붙는다');
  assert.equal(document.activeElement, byId('online-question-text'), '채팅이 포커스를 가져가지 않는다');

  // 기다림이 끝나면 다시 곧바로 붙는다
  quiz.updateChat(chat('friend', '지수', '찍자'));
  assert.equal(lines().at(-1), '지수 찍자');

  // 같은 문항을 다시 그려도(재조회) 포커스·기다림이 되풀이되지 않는다
  quiz.render(running(1, 15_000));
  quiz.updateChat(chat('guest', '민수', '그대로'));
  assert.equal(lines().at(-1), '민수 그대로');
  quiz.stopPresence();
});

test('남은 5초 경고도 먼저다: 경고를 낸 순간에 온 채팅은 그 뒤에 붙는다 — 이미 냈으면 경고도 기다림도 없다', () => {
  enterMatch();
  quiz.render(running(2, 20_000));
  advance(CHAT_PRIORITY_HOLD_MS);
  const announcer = byId('announcer');
  announcer.textContent = '';

  // 같은 문항의 다음 snapshot이 남은 5초 안을 알린다 — 문항 포커스는 다시 옮기지 않고 경고만 낸다
  quiz.render(running(2, 4_000));
  assert.equal(announcer.textContent, '시간이 얼마 남지 않았어요.');
  quiz.updateChat(chat('friend', '지수', '빨리'));
  assert.deepEqual(lines(), [], '경고와 같은 순간의 채팅은 경고 뒤에 선다');
  advance(CHAT_PRIORITY_HOLD_MS);
  assert.deepEqual(lines(), ['지수 빨리']);
  // 채팅 줄은 announce()로 알리지 않는다 — 로그 자신이 라이브 리전이다(겹쳐 부르면 두 번 읽힌다)
  assert.equal(announcer.textContent, '시간이 얼마 남지 않았어요.');

  // 이미 낸 사람에게는 경고가 없으므로 채팅도 기다리지 않는다
  quiz.render(running(3, 20_000, { ownSubmission: { choiceIndex: 1 } }));
  advance(CHAT_PRIORITY_HOLD_MS);
  quiz.render(running(3, 4_000, { ownSubmission: { choiceIndex: 1 } }));
  quiz.updateChat(chat('guest', '민수', '나도 냈어'));
  assert.equal(lines().at(-1), '민수 나도 냈어');
  quiz.stopPresence();
});

test('채팅칸에 적는 중이면 포커스를 빼앗지 않으므로 채팅도 기다리지 않는다', () => {
  enterMatch();
  quiz.render(running(1, 20_000));
  advance(CHAT_PRIORITY_HOLD_MS);

  byId('online-chat-input').focus();
  quiz.render(running(2, 20_000));
  assert.equal(document.activeElement, byId('online-chat-input'), '쓰던 글과 caret을 빼앗지 않는다');
  quiz.updateChat(chat('friend', '지수', '다음 문제다'));
  assert.equal(lines().at(-1), '지수 다음 문제다', '대화하던 사람에게 줄이 늦게 오지 않는다');
  quiz.stopPresence();
});

test('숨긴 사람의 말은 낭독되지 않는다 — 기다리는 사이에 숨겨도 붙지 않는다 (N06)', () => {
  enterMatch();
  hidden.add('guest');
  quiz.updateChat(chat('guest', '민수', '정답은 2번'));
  assert.deepEqual(lines(), []);

  hidden.clear();
  quiz.render(running(1, 20_000));
  quiz.updateChat(chat('guest', '민수', '이번엔 3번'));
  quiz.updateChat(chat('friend', '지수', '몰라'));
  hidden.add('guest');
  advance(CHAT_PRIORITY_HOLD_MS);
  assert.deepEqual(lines(), ['지수 몰라'], '기다리던 줄도 붙이기 직전에 다시 거른다');

  // 내 말은 숨기지 않는다
  quiz.updateChat(chat('me', '퀴즈왕', '같이 풀자'));
  assert.equal(lines().at(-1), '퀴즈왕 같이 풀자');
  quiz.stopPresence();
});

test('매치를 떠나면 기다리던 줄을 버린다 — 다음 화면의 로그에 늦게 붙지 않는다', () => {
  enterMatch();
  quiz.render(running(1, 20_000));
  quiz.updateChat(chat('friend', '지수', '잘 가'));
  quiz.stopPresence();
  advance(CHAT_PRIORITY_HOLD_MS * 2);
  assert.deepEqual(lines(), []);
  assert.equal(clock.tasks.size, 0, '걸어 둔 시계도 거둔다');
});

test('차례 대기열: 기다리는 동안 온 줄은 차례를 지키고 한도만큼만 남으며, 다시 양보하면 기다림이 늘어난다', () => {
  const appended = [];
  const tasks = new Map();
  let next = 1;
  const queue = createChatLineQueue({
    append: (line) => appended.push(line),
    limit: 2,
    holdMs: 100,
    timers: {
      setTimeout: (run, ms) => { const id = next++; tasks.set(id, { run, ms }); return id; },
      clearTimeout: (id) => { tasks.delete(id); },
    },
  });
  const fireAll = () => { const pending = [...tasks.values()]; tasks.clear(); pending.forEach((task) => task.run()); };

  queue.push('하나');
  assert.deepEqual(appended, ['하나']);
  queue.yieldTo();
  assert.equal(queue.holding, true);
  queue.push('둘');
  queue.push('셋');
  queue.push('넷');
  queue.yieldTo();
  assert.equal(tasks.size, 1, '다시 양보하면 시계를 새로 건다(늘어난다)');
  fireAll();
  assert.deepEqual(appended, ['하나', '셋', '넷'], '한도를 넘으면 가장 오래 기다린 줄부터 버린다');
  assert.equal(queue.holding, false);

  queue.yieldTo();
  queue.push('다섯');
  queue.reset();
  assert.equal(tasks.size, 0);
  queue.push('여섯');
  assert.deepEqual(appended, ['하나', '셋', '넷', '여섯'], 'reset 은 기다리던 줄을 버리고 곧바로 붙는 상태로 돌아간다');
});

test('마크업: 두 대화 로그는 붙인 줄만 읽는 polite log 이고, 최근 대화가 채팅칸 위에 온다 (U42·U39)', async () => {
  const [html, quizSource] = await Promise.all([source('index.html'), source('src/ui/online-quiz.ts')]);
  for (const id of ['chat-log', 'online-chat-log']) {
    // role="log" 는 <ul> 이 받을 수 없는 역할이다(axe aria-allowed-role). 그래서 로그는 div, 줄도 div 다
    assert.doesNotMatch(html, new RegExp(`<ul[^>]*id="${id}"`), `#${id}: ul 에 log 역할을 주지 않는다`);
    const tag = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
    assert.match(tag, /role="log"/, `#${id}`);
    assert.match(tag, /aria-live="polite"/, `#${id}`);
    assert.match(tag, /aria-relevant="additions"/, `#${id}: 떼어 내는 오래된 줄은 읽지 않는다`);
    assert.doesNotMatch(tag, /aria-atomic="true"/, `#${id}: 로그 전체를 다시 읽지 않는다`);
    assert.doesNotMatch(tag, /class="[^"]*sr-only/, `#${id}: 말풍선을 볼 수 없는 사람에게는 이것이 대화 그 자체다`);
  }
  // 가장 새 줄이 채팅칸 바로 위에 와서, 휴대폰의 OS 키보드가 덮는 아래쪽에 남지 않는다
  assert.ok(html.indexOf('id="chat-log"') < html.indexOf('id="chat-form"'));
  assert.ok(html.indexOf('id="online-chat-log"') < html.indexOf('id="online-chat-form"'));

  // 채팅 줄을 쓰는 자리는 announce()를 부르지 않는다(로그 자신이 라이브 리전이다)
  const write = quizSource.slice(
    quizSource.indexOf('  function writeChatLine('),
    quizSource.indexOf('  function chatNotice('),
  );
  assert.ok(write.length > 0);
  assert.doesNotMatch(write, /announce\(/);
  assert.doesNotMatch(write, /\.focus\(/);
  // 질문 제목에 포커스를 옮긴 바로 그 자리와 남은 5초 경고에서만 채팅이 양보한다
  assert.match(quizSource, /el\.question\.focus\(\{ preventScroll: true \}\);\s*\/\/[^\n]*\n\s*chatLines\.yieldTo\(\);/);
  assert.match(quizSource, /announce\('시간이 얼마 남지 않았어요\.'\);\s*\/\/[^\n]*\n\s*chatLines\.yieldTo\(\);/);
});
