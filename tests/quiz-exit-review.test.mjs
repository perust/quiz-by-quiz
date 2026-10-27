import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 나가면서 푼 문제 보기 (N04, FR-3.6).
// 25문제 전체 도전의 24번에서 나가면 남는 것이 하나도 없었다. 한 문제라도 풀었으면 나가기 확인에
// «나가고 푼 문제 N개 해설 보기»가 생기고, 누르면 판을 나가기와 똑같이 접은 뒤 푼 문제를 정답·해설과 함께
// 보는 화면(`quiz-review`)으로 간다. **끝까지 풀지 않은 판이라 기록되지 않는다** — 결과 화면이 아니므로
// 랭킹 등록·최고 점수 비교·떠날 때의 자동 저장(FR-6.1)이 없다. 화면 모듈을 가짜 DOM 위에 실제로 띄운다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── 가짜 DOM (quiz-time-limit.test.mjs 와 같은 모양) ────────────────────

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
byId('arena-tiles').getBoundingClientRect = () => ({ left: 0, top: 400, right: 360, bottom: 565, width: 360, height: 165 });
const selectorNodes = new Map();

const fakeDocument = new EventTarget();
Object.assign(fakeDocument, {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '[data-screen="quiz"]') return quizSection;
    if (selector === '.dialog-backdrop:not([hidden])') return null;
    if (!selectorNodes.has(selector)) selectorNodes.set(selector, new FakeElement());
    return selectorNodes.get(selector);
  },
  querySelectorAll: () => [],
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  contains: () => true,
  hasFocus: () => true,
});
globalThis.document = fakeDocument;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};

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

const { createQuizScreen, exitReviewLabel } = await import('../js/ui/quiz.js');
const { createQuizReviewScreen, answeredReviewSummary, answeredGroupCount } = await import('../js/ui/quiz-review.js');
const { createSession } = await import('../js/core/session.js');
const { reviewAnswered } = await import('../js/core/scoring.js');
const { backStepFor } = await import('../js/ui/back-guard.js');

const exits = [];
const reviews = [];
const completed = [];
const quizScreen = createQuizScreen({
  onExit: () => exits.push('exit'),
  onComplete: (session) => completed.push(session),
  onReview: (session) => reviews.push(session),
});

function question(id, category = 'science') {
  return {
    id, category, question: `${id}?`, choices: ['가', '나', '다', '라'],
    answerIndex: 1, explanation: `${id} 해설`, difficulty: 'easy', tags: [],
  };
}

function startRound(questions = [question('q1'), question('q2'), question('q3')], mode = 'category') {
  frames.clear();
  clock = 0;
  exits.length = 0;
  reviews.length = 0;
  byId('feedback').hidden = true;
  const session = createSession({ questions, mode, categoryId: mode === 'all' ? null : 'science' });
  quizScreen.start(session, { categoryLabel: '과학' });
  return session;
}

/** 지금 문항의 보기를 누른다 (index 1 이 정답이다) */
const choose = (index) => byId('choices').children[index].children[0].click();
const dialogOpen = () => !byId('exit-dialog').hidden;

test('한 문제도 풀지 않았으면 나가기 확인에 «해설 보기»가 없다 — 볼 것이 없다', () => {
  startRound();
  byId('quiz-exit').click();
  assert.ok(dialogOpen());
  assert.equal(byId('exit-review').hidden, true);
  assert.equal(fakeDocument.activeElement, byId('exit-cancel'), '포커스는 여전히 «계속 풀기»에 먼저 선다');
  byId('exit-cancel').click();
  assert.equal(dialogOpen(), false);
  quizScreen.hide();
});

test('푼 문제가 있으면 개수를 말하는 «나가고 푼 문제 N개 해설 보기»가 생기고, 누르면 판을 접고 그 판을 넘긴다', () => {
  const session = startRound();
  choose(1); // 맞힘
  assert.equal(byId('feedback').hidden, false, '해설을 보는 중이다 — 이 문제도 «푼 문제»다');
  byId('quiz-exit').click();
  assert.equal(byId('exit-review').hidden, false);
  assert.equal(byId('exit-review').textContent, '나가고 푼 문제 1개 해설 보기');
  assert.equal(exitReviewLabel(24), '나가고 푼 문제 24개 해설 보기');
  byId('exit-cancel').click();

  // 다음 문항이 도는 중에 나간다. 아직 답하지 않은 문제는 세지 않는다
  byId('next-button').click();
  byId('quiz-exit').click();
  assert.equal(byId('exit-review').textContent, '나가고 푼 문제 1개 해설 보기');
  byId('exit-review').click();
  assert.deepEqual(reviews, [session], '끝까지 풀지 않은 그 판이 넘어간다');
  assert.deepEqual(exits, [], '나가기 길(홈·대기실)로 가지 않고 «푼 문제» 화면이 맡는다');
  assert.deepEqual(completed, [], '완주(결과 화면)가 아니다 — 기록할 길에 오르지 않는다');
  assert.equal(dialogOpen(), false);
  assert.equal(byId('feedback').hidden, true, '피드백 시트는 <main> 밖이라 함께 접는다');

  // 나간 판의 타이머가 다른 화면에서 깨어나지 않는다 — 1분이 흘러도 시간 초과가 남지 않는다
  clock += 60_000;
  runFrames();
  assert.equal(byId('feedback').hidden, true);
  assert.equal(session.getAnswers().length, 1);
});

test('「나가기」는 그대로 나가기다 — «해설 보기»로 새지 않는다', () => {
  startRound();
  choose(0);
  byId('quiz-exit').click();
  byId('exit-confirm').click();
  assert.deepEqual(exits, ['exit']);
  assert.deepEqual(reviews, []);
});

test('확인창 뒤에서 시간이 끝나면 그 문제도 센다 — 열린 확인창의 개수가 따라온다 (FR-3.12)', () => {
  const session = startRound();
  choose(3); // 틀림
  byId('next-button').click();
  assert.equal(session.getAnswers().length, 1);
  byId('quiz-exit').click();
  assert.equal(byId('exit-review').textContent, '나가고 푼 문제 1개 해설 보기');

  clock = 21_000;
  runFrames();
  assert.equal(session.getAnswers().length, 2, '확인하는 동안에도 시간은 흐른다');
  assert.equal(byId('exit-review').textContent, '나가고 푼 문제 2개 해설 보기');
  assert.equal(fakeDocument.activeElement, byId('exit-cancel'), '시간 초과가 갇힌 포커스를 가져가지 않는다');
  byId('exit-review').click();
  assert.equal(reviews[0].getAnswers().length, 2);
});

test('reviewAnswered: 푼 문제를 맞힌 것까지 푼 순서대로 담고, 점수·등급·소요 시간은 만들지 않는다', () => {
  const session = startRound([question('a1', 'history'), question('a2', 'science'), question('a3', 'history'), question('a4', 'art')], 'all');
  choose(1);
  byId('next-button').click();
  choose(2);
  byId('next-button').click();
  clock += 21_000;
  runFrames();
  quizScreen.hide();

  const review = reviewAnswered({
    questions: session.getQuestions(), answers: session.getAnswers(), mode: session.mode, categoryId: session.categoryId,
  });
  assert.deepEqual(
    { mode: review.mode, categoryId: review.categoryId, totalCount: review.totalCount, answeredCount: review.answeredCount, correctCount: review.correctCount },
    { mode: 'all', categoryId: null, totalCount: 4, answeredCount: 3, correctCount: 1 },
  );
  assert.deepEqual(review.items.map(({ id, correct, timedOut, chosenChoice }) => [id, correct, timedOut, chosenChoice]), [
    ['a1', true, false, '나'],
    ['a2', false, false, '다'],
    ['a3', false, true, null],
  ]);
  for (const key of ['score', 'maxScore', 'grade', 'durationMs', 'questionResults']) {
    assert.equal(key in review, false, `랭킹 레코드가 될 ${key} 가 없다`);
  }
});

// ── «푼 문제» 화면 ──────────────────────────────────────────────────

const leaves = [];
const reviewScreen = createQuizReviewScreen({ onLeave: () => leaves.push('leave') });

const item = (id, category, correct, timedOut = false) => ({
  id, category, question: `${id}?`, choices: ['가', '나', '다', '라'],
  chosenChoice: correct ? '나' : (timedOut ? null : '가'), correctChoice: '나', explanation: `${id} 해설`, correct, timedOut,
});

test('분야 판: 한 목록 — 맞힌 문제는 «내 답 · 정답» 한 줄, 틀린 문제는 내 답 ✗ / 정답 ✓, 문제마다 신고 링크', () => {
  const review = {
    mode: 'category', categoryId: 'science', totalCount: 10, answeredCount: 3, correctCount: 1,
    items: [item('s1', 'science', true), item('s2', 'science', false), item('s3', 'science', false, true)],
  };
  reviewScreen.show({ review, modeLabel: '과학', characterId: 'slime-blue', inRoom: false });
  assert.equal(byId('quiz-review-summary').textContent, '과학 · 10문제 중 3문제를 풀었어요 · 맞힌 문제 1개');
  assert.equal(byId('quiz-review-leave-label').textContent, '홈');

  const list = byId('quiz-review-list');
  assert.equal(list.classList.contains('review--grouped'), false);
  assert.deepEqual(list.children.map((entry) => entry.className), ['review__item', 'review__item', 'review__item']);
  const rows = (entry) => entry.children.map((row) => row.className);
  assert.deepEqual(rows(list.children[0]), ['review__question', 'review__row review__row--mine-correct', 'review__explanation', 'review__report']);
  assert.deepEqual(rows(list.children[1]), ['review__question', 'review__row review__row--mine', 'review__row review__row--answer', 'review__explanation', 'review__report']);
  assert.equal(list.children[2].children[1].children[1].textContent, '시간 초과');
  const link = list.children[1].children.at(-1).children[0];
  assert.equal(new URL(link.href).searchParams.get('title'), '[문제 신고] s2', '결과 화면과 같은 신고 링크다 (FR-5.8)');

  byId('quiz-review-leave').click();
  assert.deepEqual(leaves, ['leave']);
  reviewScreen.hide();
});

test('전체 도전: 결과의 오답 풀이처럼 분야별 접힌 묶음이고, 개수 알약은 «N문제 중 M개 틀림»·«N문제 모두 정답»이다', () => {
  const review = {
    mode: 'all', categoryId: null, totalCount: 25, answeredCount: 24, correctCount: 21,
    items: [item('h1', 'history', true), item('s1', 'science', false), item('h2', 'history', false), item('a1', 'art', true)],
  };
  reviewScreen.show({ review, modeLabel: '전체 도전', characterId: 'slime-blue', inRoom: true });
  assert.equal(byId('quiz-review-leave-label').textContent, '대기실', '방에서 연 판이면 나가기처럼 대기실로 돌아간다');
  assert.equal(byId('quiz-review-summary').textContent, '전체 도전 · 25문제 중 24문제를 풀었어요 · 맞힌 문제 21개');

  const list = byId('quiz-review-list');
  assert.equal(list.classList.contains('review--grouped'), true);
  const heads = list.children.map((entry) => entry.children[0].children[0]);
  assert.deepEqual(heads.map((head) => head.children.map((part) => [part.className, part.textContent])), [
    [['review-group__name', '한국사'], ['review-group__count', '2문제 중 1개 틀림']],
    [['review-group__name', '과학'], ['review-group__count', '1문제 중 1개 틀림']],
    [['review-group__name', '예술과문화'], ['review-group__count review-group__count--clear', '1문제 모두 정답']],
  ]);
  assert.ok(list.children.every((entry) => entry.children[0].open === false), '여럿이면 접어 둔다');
  reviewScreen.hide();

  assert.deepEqual(answeredGroupCount([item('x', 'art', true)]), { text: '1문제 모두 정답', clear: true });
  assert.equal(answeredReviewSummary({ totalCount: 10, answeredCount: 1, correctCount: 0 }, ''), '10문제 중 1문제를 풀었어요 · 맞힌 문제 0개');
});

// ── 기록하지 않는다 · 화면 계약 ──────────────────────────────────────

test('app: «푼 문제»로 가는 길은 기록·최고 점수·자동 저장에 닿지 않는다 (FR-3.6, FR-6.1)', async () => {
  const app = await source('src/app.ts');
  const start = app.indexOf('function showAnsweredReview(');
  const body = app.slice(start, app.indexOf('\n  }\n', start));
  assert.ok(start > 0);
  for (const forbidden of ['registerRecord', 'saveRecord', 'getBestScore', 'pending', 'resultScreen', 'summarizeRound', "goTo('result')"]) {
    assert.equal(body.includes(forbidden), false, `showAnsweredReview 가 ${forbidden} 를 쓰지 않는다`);
  }
  assert.match(body, /reviewAnswered\(\{/);
  assert.match(body, /goTo\('quiz-review'\);/);
  assert.match(app, /onReview: showAnsweredReview,/);
  // 떠나는 곳은 나가기와 같다(방에서 연 판이면 대기실)
  assert.match(app, /onExit: leaveRound,/);
  assert.match(app, /createQuizReviewScreen\(\{ onLeave: leaveRound \}\)/);
  // 새 화면은 closers 에 한 줄이 있다 — 손가락 조작부·캐릭터가 다음 화면으로 따라가지 않는다
  assert.match(app, /'quiz-review': \(\) => quizReviewScreen\.hide\(\),/);
  // 탭 닫기·새로고침의 자동 저장은 결과 화면에서만이다
  assert.match(app, /if \(currentScreen === 'result'\) resultScreen\.flush\(\);/);

  const reviewModule = await source('src/ui/quiz-review.ts');
  assert.doesNotMatch(reviewModule, /storage\/|rankingStore|preferences|onRegister/, '화면은 저장소를 모른다');
});

test('브라우저 «뒤로»는 «푼 문제»의 떠나는 버튼을 누른다 — 저장 없이 나가기와 같은 곳으로', () => {
  assert.deepEqual(backStepFor('quiz-review', { dialogOpen: false, landedOnGuard: true }), { kind: 'control', id: 'quiz-review-leave' });
  assert.deepEqual(backStepFor('quiz-review', { dialogOpen: true, landedOnGuard: true }), { kind: 'close-dialog' });
});

test('마크업: 덧붙은 행동은 확정 줄 밖·확인창 안이고 처음엔 숨어 있다. «푼 문제» 화면은 걸어 다니고 저장 범위를 말한다', async () => {
  const html = await source('index.html');
  const dialog = html.slice(html.indexOf('id="exit-dialog"'), html.indexOf('id="clear-dialog"'));
  const actions = dialog.slice(dialog.indexOf('class="dialog__actions"'), dialog.indexOf('</div>', dialog.indexOf('class="dialog__actions"')));
  assert.doesNotMatch(actions, /exit-review/, '«계속 풀기 · 나가기» 두 칸 줄에 끼우지 않는다 — 이름이 길다');
  assert.match(dialog, /<button type="button" class="button button--ghost dialog__extra" id="exit-review" hidden>나가고 푼 문제 해설 보기<\/button>/);

  const screen = html.slice(html.indexOf('data-screen="quiz-review"'), html.indexOf('<!-- ─────────── 랭킹'));
  assert.match(screen, /aria-labelledby="quiz-review-title"/);
  assert.match(screen, /<h1 class="ranking-title" id="quiz-review-title">푼 문제 다시 보기<\/h1>/);
  assert.match(screen, /id="quiz-review-leave"/);
  assert.match(screen, /class="ranking-scope"[^>]*>끝까지 풀지 않은 판이라 점수와 기록은 남지 않아요\.<\/p>/);
  assert.match(screen, /<ol class="review" id="quiz-review-list"/);
  assert.match(screen, /class="walker walker--home" id="quiz-review-character" aria-hidden="true"/);
  assert.doesNotMatch(screen, /register|nickname-input|result-best/, '등록 칸·최고 기록이 없다');

  const css = await source('css/style.css');
  assert.match(css, /\[data-screen='quiz-review'\] > :not\(\.walker\):not\(\.sr-only\),/, '결과·랭킹과 같은 읽기 폭');
  assert.match(css, /\.dialog__extra \{\s*width: 100%;/);
  const theme = await source('css/voxel-theme.css');
  assert.match(theme, /\.review-group__count--clear \{\s*background: var\(--correct-soft\);\s*color: var\(--correct-ink\);/);

  // CLAUDE.md 의 규칙: 새 화면은 tools/check-screens.js 에 한 걸음을 더한다
  const check = await source('tools/check-screens.js');
  assert.match(check, /눌러\('exit-review'/);
  assert.match(check, /살펴본다\('[^']*', 'quiz-review', true\)/);
});
