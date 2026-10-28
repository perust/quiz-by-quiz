import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 퀴즈 화면의 문항 시간 (FR-3.7, PRD v1.2 / U42).
// 판마다 고른 시간으로 타이머를 만들고, «제한 없음»이면 프레임을 돌리지 않아 시간 초과로 가는 길이
// 아예 없다. HUD·질문 설명·조작법이 그 판의 시간을 말한다. 화면 모듈을 가짜 DOM 위에 실제로 띄운다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── 가짜 DOM ───────────────────────────────────────────────────────

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
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.attributes = new Map();
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.isConnected = true;
    this.scrollTop = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    const on = force ?? !this.attributes.has(name);
    if (on) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return on;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    // 이 테스트가 쓰는 «.클래스» 하나짜리 선택자만 안다
    const name = selector.startsWith('.') ? selector.slice(1) : null;
    const found = [];
    const walk = (element) => {
      for (const child of element.children ?? []) {
        if (name && String(child.className).split(/\s+/).includes(name)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  closest() { return null; }
  contains() { return true; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView() {}
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const quizSection = new FakeElement('section');
// 무대에 크기가 있어야 캐릭터가 십자 한가운데에 서고 워커의 프레임이 멎는다
byId('arena-tiles').getBoundingClientRect = () => ({ left: 0, top: 400, right: 360, bottom: 565, width: 360, height: 165 });
const selectorNodes = new Map();

const fakeDocument = new EventTarget();
Object.assign(fakeDocument, {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  // 이동 조작부(walk-*)는 없는 문서로 둔다 — 키보드 워커만으로도 화면은 돈다
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '[data-screen="quiz"]') return quizSection;
    // 열린 대화상자는 없다. 열린 것을 흉내 낼 때는 이 값을 바꾼다
    if (selector === '.dialog-backdrop:not([hidden])') return fakeDocument.openDialog ?? null;
    if (!selectorNodes.has(selector)) selectorNodes.set(selector, new FakeElement());
    return selectorNodes.get(selector);
  },
  querySelectorAll: () => [],
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  contains: () => true,
  hasFocus: () => true,
  openDialog: null,
});
globalThis.document = fakeDocument;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};

// 시계와 프레임을 손으로 돌린다. 숨은 탭처럼 rAF 가 멈춰 있어도 타이머는 시작 시각으로 답한다
let clock = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
const frames = new Map();
let frameNumber = 0;
globalThis.requestAnimationFrame = (callback) => { frames.set(++frameNumber, callback); return frameNumber; };
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
function runFrames(count = 3) {
  for (let i = 0; i < count; i += 1) {
    const due = [...frames.values()];
    frames.clear();
    due.forEach((callback) => callback(clock));
  }
}

const { createQuizScreen } = await import('../js/ui/quiz.js');
const { createSession } = await import('../js/core/session.js');

const completed = [];
const quizScreen = createQuizScreen({ onExit() {}, onComplete: (session) => completed.push(session) });

function question(id) {
  return {
    id, category: 'science', question: `${id}?`, choices: ['가', '나', '다', '라'],
    answerIndex: 1, explanation: '해설', difficulty: 'easy', tags: [],
  };
}

function startRound(timeLimitMs, view = {}) {
  frames.clear();
  clock = 0;
  byId('feedback').hidden = true;
  const session = createSession({
    questions: [question('q1'), question('q2')],
    ...(timeLimitMs === undefined ? {} : { timeLimitMs }),
  });
  quizScreen.start(session, { categoryLabel: '과학', ...view });
  return session;
}

const feedbackShown = () => !byId('feedback').hidden;

test('기본 20초 판: 21초가 지나면 시간 초과 오답이 되고 해설이 뜬다 (FR-3.10)', () => {
  const session = startRound();
  assert.equal(byId('timer-text').textContent, '남은 시간 20초');
  assert.equal(byId('question-time-limit').textContent, '문항당 20초');
  clock = 21_000;
  runFrames();
  assert.ok(feedbackShown(), '시간 초과 패널이 뜬다');
  assert.equal(byId('feedback-verdict').textContent, '시간 초과예요');
  assert.equal(session.getAnswers()[0].elapsedMs, 20_000);
  quizScreen.hide();
});

test('40초 판: 25초에는 아직 15초가 남고, 41초에 시간 초과가 된다', () => {
  const session = startRound(40_000);
  assert.equal(byId('timer-text').textContent, '남은 시간 40초');
  assert.equal(byId('question-time-limit').textContent, '문항당 40초', '질문 제목의 설명이 그 판의 시간을 말한다');
  assert.equal(byId('help-time-limit').textContent, '문항당 40초예요.');
  assert.equal(byId('help-rule-timed').hidden, false);
  assert.equal(byId('help-rule-untimed').hidden, true);

  runFrames(10);
  assert.ok(frames.size > 0, '제한이 있으면 남은 시간을 매 프레임 다시 잰다');
  clock = 25_000;
  runFrames();
  assert.equal(feedbackShown(), false, '20초 판이었다면 끝났을 자리에서 깨어나지 않는다');
  assert.equal(byId('timer-text').textContent, '남은 시간 15초');
  assert.equal(byId('timer').classList.contains('timer--warning'), false);

  clock = 36_000;
  runFrames();
  assert.equal(byId('timer').classList.contains('timer--warning'), true, '남은 5초 경고는 그대로다 (FR-3.9)');
  assert.equal(byId('timer-text').textContent, '4초 남았어요');

  clock = 41_000;
  runFrames();
  assert.ok(feedbackShown());
  assert.equal(session.getAnswers()[0].timedOut, true);
  assert.equal(session.getAnswers()[0].elapsedMs, 40_000);
  quizScreen.hide();
});

test('제한 없음 판: 프레임을 돌리지 않고, 25초·한 시간이 지나도 시간 초과가 없다', () => {
  const session = startRound(null);
  assert.equal(byId('timer-text').textContent, '시간 제한 없음');
  assert.equal(byId('timer').classList.contains('timer--unlimited'), true, '막대는 디자인 층이 거둔다');
  assert.equal(byId('question-time-limit').textContent, '시간 제한 없음');
  assert.equal(byId('help-time-limit').textContent, '시간 제한이 없어요.');
  assert.equal(byId('help-rule-timed').hidden, true, '«시간이 다 되면 밟은 칸이 답» 규칙은 감춘다');
  assert.equal(byId('help-rule-untimed').hidden, false);
  runFrames(10);
  assert.equal(frames.size, 0, '셀 것이 없어 rAF 를 걸지 않는다 — 캐릭터가 자리를 잡으면 프레임이 멎는다');

  for (const at of [25_000, 3_600_000]) {
    clock = at;
    runFrames();
    assert.equal(feedbackShown(), false, `${at / 1000}초가 지나도 시간 초과가 없다`);
    assert.equal(session.isAnswered(), false);
  }
  assert.equal(byId('timer').classList.contains('timer--warning'), false, '남은 5초 경고도 없다');

  // 직접 고르면 그대로 채점되고 쓴 시간은 자르지 않는다 (FR-5.3)
  byId('choices').children[0].children[0].click();
  assert.ok(feedbackShown());
  assert.equal(session.getAnswers()[0].elapsedMs, 3_600_000);
  assert.equal(session.getAnswers()[0].timedOut, false);
  quizScreen.hide();
});

test('다음 판이 20초로 돌아오면 막대와 규칙도 돌아온다', () => {
  startRound(null);
  quizScreen.hide();
  startRound(20_000);
  assert.equal(byId('timer').classList.contains('timer--unlimited'), false);
  assert.equal(byId('help-rule-timed').hidden, false);
  assert.equal(byId('timer-text').textContent, '남은 시간 20초');
  quizScreen.hide();
});

test('무대 아래 규칙 줄은 판의 문항 시간을 말하고, 처음 몇 판만 짧은 화면에서도 접지 않는다 (U01)', () => {
  startRound(20_000, { pinRules: true });
  assert.equal(byId('arena-hint-rule').textContent, '보기를 누르면 바로 답 · 시간이 끝나면 선 칸이 답');
  assert.equal(byId('arena-hint').dataset.pinned, 'true', '세는 것은 app.ts 이고 화면은 받은 대로 단다');
  quizScreen.hide();

  startRound(null, { pinRules: true });
  assert.equal(byId('arena-hint-rule').textContent, '보기를 누르면 바로 답 · 칸 위에서 선택하면 답', '제한 없음에는 «시간이 끝나면»이 없다');
  quizScreen.hide();

  startRound(40_000);
  assert.equal(byId('arena-hint').dataset.pinned, 'false', '넘기지 않으면 예전처럼 접는다');
  assert.equal(byId('arena-hint-rule').textContent, '보기를 누르면 바로 답 · 시간이 끝나면 선 칸이 답');
  quizScreen.hide();
});

test('설정 대화상자 뒤에서 시간이 끝나면 포커스를 가져가지 않고, 닫으면 「다음 문제」로 이어 간다', () => {
  startRound();
  const settingsBackdrop = new FakeElement();
  fakeDocument.openDialog = settingsBackdrop;
  const inside = new FakeElement('button');
  inside.focus();
  clock = 21_000;
  runFrames();
  assert.ok(feedbackShown(), '시간은 대화상자 뒤에서도 흐른다 (FR-3.12)');
  assert.equal(fakeDocument.activeElement, inside, '갇혀 있어야 할 포커스를 밖으로 빼지 않는다');
  assert.equal(quizScreen.resumeAfterDialog(), false, '아직 열려 있으면 이어 가지 않는다');

  fakeDocument.openDialog = null;
  assert.equal(quizScreen.resumeAfterDialog(), true);
  assert.equal(fakeDocument.activeElement, byId('next-button'), '닫으면 「다음 문제」에 선다');
  assert.equal(quizScreen.resumeAfterDialog(), false, '한 번만 이어 간다');
  quizScreen.hide();
});

test('마크업: 질문 제목은 숨긴 설명으로 문항 시간을 함께 읽고, 그 설명은 라이브 리전이 아니다', async () => {
  const html = await source('index.html');
  assert.match(html, /<h1 class="question" id="question-text" tabindex="-1" aria-describedby="question-time-limit"><\/h1>/);
  const description = html.match(/<p id="question-time-limit"([^>]*)>([^<]*)<\/p>/);
  assert.ok(description, '설명 요소가 있다');
  assert.match(description[1], /\bhidden\b/, '브라우즈 모드에서 두 번 읽히지 않게 숨긴다');
  assert.doesNotMatch(description[1], /aria-live|role=/);
  assert.equal(description[2], '문항당 20초');

  const help = html.slice(html.indexOf('id="help-dialog"'), html.indexOf('id="online-help-dialog"'));
  assert.match(help, /<span id="help-time-limit">문항당 20초예요\.<\/span>/);
  assert.match(help, /<span id="help-rule-timed">[\s\S]*<strong>시간이 다 되면 그때 밟고 있는 칸이 답<\/strong>/);
  assert.match(help, /<span id="help-rule-untimed" hidden>[\s\S]*칸에 서 있기만 해서는 답이 나가지 않으니/);

  // 막대만 거두고 글은 남긴다. 제한 없음에서 막대가 «가득 찬 채 멈춘 시간»으로 읽히지 않게 한다
  const css = await source('css/style.css');
  assert.match(css, /\.timer--unlimited \.timer__track \{\s*display: none;\s*\}/);
});
