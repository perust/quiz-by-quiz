import test from 'node:test';
import assert from 'node:assert/strict';

// 공개 카드(aria-live="polite") 안의 미니 점수판에서 낭독되는 것은 «이번 문제 정답 n/m명» 한 줄뿐이다 (U30).
// 큰 방의 «그 밖에 N명»도 순위 목록과 같은 aria-live="off" 덩어리 안에 있어야 한다 — 목록 없이 낭독된
// «그 밖에 2명»은 무엇의 수인지 알 수 없다 (a11y-04). 온라인 퀴즈 화면을 가짜 DOM 위에 띄워 실제로 그려 본다.

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
  get childElementCount() { return this.children.filter((child) => child instanceof FakeElement).length; }
  /** `.이름` 하나만 알아듣는다 — 화면 코드가 보기의 표식 칸을 찾는 데 쓴다 */
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

const ME = 'a2345678-1234-5678-9234-567812345678';
const id = (n) => `b${String(n).padStart(7, '0')}-1234-5678-9234-567812345678`;
const quiz = createOnlineQuizScreen({
  onSubmit: async () => {},
  onMovement: () => {},
  onSendChat: async () => ({ ok: true }),
  onExit: () => {},
  onFinished: () => {},
  getPlayerId: () => ME,
  isChatHidden: () => false,
  createCharacterArena: quietArena,
  trapFocus: () => {},
});

function score(playerId, nickname, points, lastAnswerCorrect) {
  return {
    playerId, nickname, characterId: 'slime-blue',
    score: points, correctCount: points / 10, answeredCount: 3,
    ...(lastAnswerCorrect === undefined ? {} : { lastAnswerCorrect }),
  };
}

function revealing(scores) {
  return {
    matchId: '12345678-1234-5678-9234-567812345678', state: 'revealing', categoryId: 'history', gameMode: true,
    currentPosition: 3, totalQuestions: 10, deadlineAt: '2026-09-18T11:00:20+00:00', remainingMs: 8000,
    questionTimeMs: 20000,
    question: {
      id: 'history-003', categoryId: 'history', question: '문제',
      choices: ['가', '나', '다', '라'], position: 3, total: 10,
    },
    ownSubmission: null,
    reveal: { position: 3, choiceIndex: 1, timedOut: false, correct: true, answerIndex: 1, explanation: '해설' },
    scores,
  };
}

const textOf = (node) => (typeof node === 'string' ? node : node.textContent + node.children.map(textOf).join(''));

/** 점수판 안에서 라이브 리전에 남는(낭독되는) 글. aria-live="off" 아래는 뺀다 */
function announced(node) {
  if (typeof node === 'string') return [node];
  if (node.getAttribute('aria-live') === 'off') return [];
  const own = node.textContent ? [node.textContent] : [];
  return [...own, ...node.children.flatMap(announced)];
}

test('큰 방의 공개 점수판: «정답 n/m명»만 낭독되고 «그 밖에 N명»은 순위 목록과 함께 aria-live="off" 안이다 (a11y-04)', () => {
  quiz.startPresence();
  // 아홉 사람, 다섯째 점수가 겹치지 않는다 — 위 다섯 줄과 내 줄만 그리고 셋이 «그 밖에»로 남는다
  const points = [90, 80, 70, 60, 50, 40, 30, 20, 10];
  const scores = points.map((value, index) => score(index === 8 ? ME : id(index), `참가자${index}`, value, value > 40));
  quiz.render(revealing(scores));

  const standings = byId('online-standings');
  assert.equal(standings.hidden, false, '먼저 펼치고 넣는다');
  assert.match(textOf(standings), /그 밖에 3명/, '큰 방이라 «그 밖에» 줄이 있다');
  assert.deepEqual(announced(standings), ['이번 문제 정답 5/9명'], '낭독되는 것은 정답자 수 한 줄뿐이다');

  // 구버전 서버(정오를 모른다)라 «정답 n/m명»이 없어도 «그 밖에 3명»만 덩그러니 낭독되지 않는다
  quiz.render(revealing(points.map((value, index) => score(index === 8 ? ME : id(index), `참가자${index}`, value))));
  assert.match(textOf(standings), /그 밖에 3명/);
  assert.deepEqual(announced(standings), [], '낭독할 정답자 수가 없으면 점수판은 조용하다');
  quiz.stopPresence();
});
