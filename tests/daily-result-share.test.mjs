import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 오늘의 퀴즈 결과 공유. 다섯 문제를 끝낸 날의 결과(«푼 문제» 화면)에만 «결과 공유하기» 입구가 있고,
// 누르면 그 클릭 안에서 Web Share(없으면 클립보드)를 한 번 부른다. 공유 글은 서비스 이름·연도를 단 KST 날짜·
// 정답 수/5·문제 순서의 정오 다섯 개·공식 주소 하나뿐이다. 실제 소비자(DailyController → quiz-review 화면)를
// index.html 에서 읽은 요소로 만든 가짜 DOM 위에 띄운다 — HTML 에 없는 요소는 없다(null).

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const html = await source('index.html');

// ── 가짜 DOM: index.html 에 선언된 id 만 있다 ────────────────────────

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
    this.readOnly = false;
    this.value = '';
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
    this.selected = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    const on = force ?? !this.attributes.has(name);
    if (on) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return on;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
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
  select() { this.selected = true; }
  setSelectionRange() { this.selected = true; }
  scrollIntoView() {}
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

/** index.html 의 id 선언: 태그와 처음 hidden·readonly 여부 */
const declared = new Map();
for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*?)\sid="([^"]+)"([^>]*)>/g)) {
  const attrs = `${match[2]} ${match[4]}`;
  declared.set(match[3], {
    tag: match[1],
    hidden: /(^|\s)hidden(\s|=|$)/.test(attrs),
    readOnly: /(^|\s)readonly(\s|=|$)/.test(attrs),
  });
}
const elements = new Map();
const byId = (id) => {
  if (!declared.has(id)) return null;
  if (!elements.has(id)) {
    const spec = declared.get(id);
    const element = new FakeElement(spec.tag);
    element.id = id;
    element.hidden = spec.hidden;
    element.readOnly = spec.readOnly;
    elements.set(id, element);
  }
  return elements.get(id);
};
const selectorNodes = new Map();

const fakeDocument = new EventTarget();
Object.assign(fakeDocument, {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '.dialog-backdrop:not([hidden])') return null;
    const idPanel = /^#([\w-]+) \[role="dialog"\]$/.exec(selector);
    if (idPanel && !declared.has(idPanel[1])) return null;
    if (!selectorNodes.has(selector)) selectorNodes.set(selector, new FakeElement());
    return selectorNodes.get(selector);
  },
  querySelectorAll: () => [],
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  contains: () => true,
  hasFocus: () => true,
});
fakeDocument.activeElement = fakeDocument.body;
globalThis.document = fakeDocument;

function memoryStorage({ failWrites = false } = {}) {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      writes.push(key);
      if (failWrites) throw new Error('QuotaExceededError');
      values.set(key, String(value));
    },
    removeItem: (key) => { values.delete(key); },
  };
}

const browserStorage = memoryStorage();
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  localStorage: browserStorage,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};
Object.defineProperty(globalThis, 'performance', { value: { now: () => 0 }, configurable: true, writable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// 공유는 서버·외부에 아무것도 보내지 않는다
const fetchCalls = [];
globalThis.fetch = (...args) => { fetchCalls.push(args); return Promise.reject(new Error('network is not allowed')); };

// ── 가짜 navigator: 부른 순간·받은 글을 적고, 끝은 테스트가 정한다 ──────────

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function installNavigator({ share = true, clipboard = true } = {}) {
  const log = { share: [], shareArgs: [], clipboard: [], pendingShare: [], pendingClip: [] };
  const nav = {};
  if (share) {
    nav.share = (...args) => {
      log.shareArgs.push(args.length);
      log.share.push(structuredClone(args[0]));
      const pending = deferred();
      log.pendingShare.push(pending);
      return pending.promise;
    };
  }
  if (clipboard) {
    nav.clipboard = {
      writeText: (text) => {
        log.clipboard.push(text);
        const pending = deferred();
        log.pendingClip.push(pending);
        return pending.promise;
      },
    };
  }
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  return log;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const abortError = () => new DOMException('Share canceled', 'AbortError');

const { createDailyStore, dailyKey } = await import('../js/storage/daily-store.js');
const flowModule = await import('../js/ui/daily.js');
const { createDailyController, DAILY_UNSAVED_SCOPE } = flowModule;
const { createQuizReviewScreen } = await import('../js/ui/quiz-review.js');

const CATEGORY_IDS = ['history', 'science', 'geography', 'general', 'art'];
const realBanks = Object.fromEntries(await Promise.all(CATEGORY_IDS.map(async (id) =>
  [id, JSON.parse(await source(`data/${id}.json`))])));
const kst = (text) => Date.parse(`${text}+09:00`);

const leaves = [];
const reviewScreen = createQuizReviewScreen({ onLeave: () => leaves.push('leave') });

/** app.ts 의 showReview 와 같은 모양으로 넘긴다 (아래 마지막 테스트가 app.ts 를 견준다) */
function harness({ storage = memoryStorage(), persistent = true, clock } = {}) {
  const time = clock ?? { now: kst('2026-11-25T08:00:00') };
  const calls = { play: [], review: [] };
  const controller = createDailyController({
    store: createDailyStore(storage, { persistent }),
    banks: realBanks,
    now: () => time.now,
    newSessionId: (() => { let n = 0; return () => `s${(n += 1)}`; })(),
    play: (session, view) => calls.play.push({ session, view }),
    showReview: (view) => {
      calls.review.push(view);
      reviewScreen.show({
        review: view.review,
        modeLabel: '',
        characterId: 'slime-blue',
        inRoom: false,
        title: view.title,
        scope: view.scope,
        summary: view.summary,
        share: view.share,
      });
    },
    showUnavailable: () => {},
    setHomeStatus: () => {},
    announce: () => {},
    schedule: () => () => {},
  });
  const session = () => calls.play.at(-1).session;
  return { controller, calls, storage, time, session };
}

/** 오늘의 퀴즈를 열어 picks(o = 정답, x = 오답) 차례로 답한다. 끝까지면 «결과 보기»를 누른다 */
function play(h, picks, { finish = true } = {}) {
  h.controller.open();
  const s = h.session();
  picks.forEach((pick, index) => {
    const question = s.currentQuestion();
    const choiceIndex = pick === 'o' ? question.answerIndex : (question.answerIndex + 1) % 4;
    s.submit({ choiceIndex, elapsedMs: 1000 + index });
    if (index < picks.length - 1) s.goNext();
  });
  if (finish) h.controller.complete(s);
  return s.record();
}

const OFFICIAL_URL = 'https://perust.github.io/quiz-by-quiz/';
/** 기대하는 공유 글. 레코드의 날짜(연도 포함)와 같은 답 배열의 정답 수·정오 */
function expectedShare(record) {
  const [year, month, day] = record.dateKey.split('-').map(Number);
  const score = record.answers.filter((answer) => answer.correct).length;
  const marks = record.answers.map((answer) => (answer.correct ? '✅' : '❌')).join('');
  return `Quiz by Quiz · ${year}년 ${month}월 ${day}일\n${score}/5\n${marks}\n${OFFICIAL_URL}`;
}

const shareArea = () => byId('quiz-review-share');
const shareButton = () => byId('quiz-review-share-button');
const textButton = () => byId('quiz-review-share-text-open');
const statusLine = () => byId('quiz-review-share-status');

/** 입구가 보이고 누를 수 있는가. 없으면 의미 있는 실패로 멈춘다 */
function assertShareVisible(message) {
  assert.ok(shareArea(), `${message}: «푼 문제» 화면에 결과 공유 영역(#quiz-review-share)이 없다`);
  assert.equal(shareArea().hidden, false, `${message}: 결과 공유 영역이 숨어 있다`);
  assert.ok(shareButton(), `${message}: «결과 공유하기» 버튼(#quiz-review-share-button)이 없다`);
  assert.equal(shareButton().hidden, false, `${message}: «결과 공유하기» 버튼이 숨어 있다`);
}

function assertShareHidden(message) {
  // 입구가 아예 없거나(아직 만들지 않음) 숨어 있으면 «보이지 않는다»
  if (shareArea()) assert.equal(shareArea().hidden, true, message);
}

// ── 실제 소비자: 완료한 판 → 결과 화면 → 공유 ────────────────────────────

test('완료한 오늘의 퀴즈 결과에 «결과 공유하기»가 있고, 누르기 전 0회 · 누른 그 클릭 안에서 정확한 글로 한 번 공유한다', async () => {
  const log = installNavigator();
  const h = harness();
  const record = play(h, ['o', 'x', 'o', 'o', 'x']);
  assert.equal(h.calls.review.at(-1).title, '오늘의 퀴즈 결과');
  assertShareVisible('완료 직후');
  assert.match(html, /<button type="button"[^>]*id="quiz-review-share-button"[^>]*>결과 공유하기<\/button>/);
  assert.equal(log.share.length + log.clipboard.length, 0, '누르기 전에는 공유·복사를 부르지 않는다');

  shareButton().click();
  // 같은 클릭 스택: 기다림 없이 이미 불렸다
  assert.equal(log.share.length, 1, '클릭 안에서 곧바로 navigator.share 를 부른다');
  assert.deepEqual(log.share[0], { text: expectedShare(record) });
  assert.equal(log.shareArgs[0], 1);
  assert.equal(log.clipboard.length, 0);
  assert.equal(statusLine().textContent, '', '공유 창이 답하기 전에는 아무 말도 하지 않는다');

  log.pendingShare[0].resolve();
  await settle();
  assert.equal(statusLine().textContent, '공유 창에 결과를 넘겼어요.');
  assert.doesNotMatch(statusLine().textContent, /게시|올렸|공유했어요|보냈어요/, 'OS 공유 창에 넘긴 것을 게시 완료라고 말하지 않는다');
  reviewScreen.hide();
});

test('정오 다섯 개와 정답 수는 같은 답 배열에서 나온다 — 모두 정답 · 모두 오답 · 섞임', async () => {
  for (const [picks, score, marks] of [
    [['o', 'o', 'o', 'o', 'o'], 5, '✅✅✅✅✅'],
    [['x', 'x', 'x', 'x', 'x'], 0, '❌❌❌❌❌'],
    [['x', 'o', 'x', 'o', 'o'], 3, '❌✅❌✅✅'],
  ]) {
    const log = installNavigator();
    const h = harness();
    const record = play(h, picks);
    assertShareVisible(picks.join(''));
    shareButton().click();
    const text = log.share[0].text;
    const lines = text.split('\n');
    assert.equal(lines[1], `${score}/5`);
    assert.equal(lines[2], marks);
    assert.equal(text, expectedShare(record));
    log.pendingShare[0].resolve();
    await settle();
    reviewScreen.hide();
  }
});

test('입구는 끝낸 오늘의 퀴즈 결과에만 — 덜 푼 판·빈 기록·일반 판 풀이에는 없고 다른 화면으로 넘어가지 않는다', async () => {
  const log = installNavigator();
  // 덜 푼 판: 나가기 확인의 «나가고 푼 문제 해설 보기»
  const partial = harness();
  play(partial, ['o', 'x'], { finish: false });
  partial.controller.reviewAnswered(partial.session());
  assert.equal(partial.calls.review.at(-1).title, '오늘의 퀴즈 · 푼 문제');
  assertShareHidden('덜 푼 판에는 공유 입구가 없다');

  // 빈 기록: 열자마자 아무것도 풀지 않고 푼 문제 보기
  const empty = harness();
  empty.controller.open();
  empty.controller.reviewAnswered(empty.session());
  assertShareHidden('빈 기록에는 공유 입구가 없다');

  // 끝낸 판을 본 뒤 일반 판의 «푼 문제»(share 없음)로 다시 그리면 거둔다
  const done = harness();
  play(done, ['o', 'o', 'x', 'o', 'o']);
  assertShareVisible('완료');
  reviewScreen.show({
    review: { mode: 'category', categoryId: 'science', totalCount: 10, answeredCount: 1, correctCount: 1, items: [] },
    modeLabel: '과학', characterId: 'slime-blue', inRoom: false,
  });
  assertShareHidden('일반 판의 푼 문제에는 공유 입구가 없다');
  reviewScreen.hide();
  assert.equal(log.share.length + log.clipboard.length, 0);

  // 공유 영역·대화상자는 «푼 문제» 화면의 것이다. 결과·온라인 결과 화면에는 없다
  const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
  assert.match(section('data-screen="quiz-review"', '</section>'), /id="quiz-review-share"[^>]*\shidden/);
  for (const screen of ['result', 'online-result']) {
    assert.doesNotMatch(section(`data-screen="${screen}"`, '</section>'), /share/i, `${screen} 화면에는 결과 공유가 없다`);
  }
  for (const path of ['src/ui/online-result.ts', 'src/ui/result.ts', 'src/ui/ranking.ts']) {
    assert.doesNotMatch(await source(path), /daily-share|quiz-review-share/, path);
  }
});

test('끝낸 날을 다시 열어도, KST 자정을 넘겨 끝냈어도 레코드의 날짜·답으로 같은 글이다 (지금 시계를 쓰지 않는다)', async () => {
  const storage = memoryStorage();
  const clock = { now: kst('2026-11-24T23:59:30') };
  const h = harness({ storage, clock });
  h.controller.open();
  const s = h.session();
  ['o', 'x', 'x', 'o', 'o'].forEach((pick, index) => {
    if (index === 1) clock.now = kst('2026-11-25T00:00:30');
    const question = s.currentQuestion();
    s.submit({ choiceIndex: pick === 'o' ? question.answerIndex : (question.answerIndex + 1) % 4, elapsedMs: 900 });
    if (index < 4) s.goNext();
  });
  h.controller.complete(s);
  const record = s.record();
  assert.equal(record.dateKey, '2026-11-24');

  let log = installNavigator();
  assertShareVisible('자정을 넘겨 끝낸 판');
  shareButton().click();
  assert.equal(log.share[0].text, expectedShare(record));
  assert.match(log.share[0].text, /2026년 11월 24일/);
  assert.doesNotMatch(log.share[0].text, /11월 25일/);
  log.pendingShare[0].resolve();
  await settle();
  reviewScreen.hide();

  // 다음 날 새로고침한 탭이 어제 날짜의 기록을 다시 연다(재진입) — 홈은 새 날이지만 끝낸 기록의 화면은 그 날짜다
  clock.now = kst('2026-11-24T23:59:59');
  const reopened = harness({ storage, clock });
  reopened.controller.open();
  assert.equal(reopened.calls.play.length, 0, '끝낸 날은 다시 풀지 않는다');
  log = installNavigator();
  assertShareVisible('완료 재진입');
  assert.equal(log.share.length + log.clipboard.length, 0, '다시 열어도 누르기 전에는 0회');
  shareButton().click();
  assert.equal(log.share[0].text, expectedShare(record));
  log.pendingShare[0].resolve();
  await settle();
  reviewScreen.hide();
});

test('Web Share 가 없으면 같은 클릭 안에서 클립보드에 같은 글을 쓰고, 실제로 끝난 뒤에만 «복사했어요»', async () => {
  const log = installNavigator({ share: false });
  const h = harness();
  const record = play(h, ['o', 'o', 'x', 'x', 'o']);
  assertShareVisible('공유 미지원');
  shareButton().click();
  assert.deepEqual(log.clipboard, [expectedShare(record)], '같은 클릭 안에서 곧바로 복사를 시도한다');
  assert.equal(statusLine().textContent, '', '클립보드가 끝나기 전에는 성공을 말하지 않는다');
  await settle();
  assert.equal(statusLine().textContent, '');
  log.pendingClip[0].resolve();
  await settle();
  assert.equal(statusLine().textContent, '결과를 복사했어요. 원하는 곳에 붙여 넣어 주세요.');
  reviewScreen.hide();

  // 클립보드도 없으면 복사했다고 하지 않고 직접 고르는 길을 말한다
  const none = installNavigator({ share: false, clipboard: false });
  const h2 = harness();
  play(h2, ['o', 'o', 'o', 'x', 'o']);
  shareButton().click();
  await settle();
  assert.equal(none.share.length + none.clipboard.length, 0);
  assert.equal(statusLine().textContent, '복사하지 못했어요. 「공유 글 보기」에서 직접 골라 복사해 주세요.');
  assert.equal(textButton().hidden, false);
  reviewScreen.hide();
});

test('공유 창을 닫은 것(AbortError)은 취소다 — 클립보드로 내려가지 않고 아무 말도 하지 않으며, 다시 누르면 다시 공유한다', async () => {
  const log = installNavigator();
  const h = harness();
  const record = play(h, ['x', 'o', 'o', 'o', 'o']);
  shareButton().click();
  log.pendingShare[0].reject(abortError());
  await settle();
  assert.equal(log.clipboard.length, 0, '취소 뒤 자동 복사 없음');
  assert.equal(statusLine().textContent, '', '취소는 실패도 성공도 아니다');

  shareButton().click();
  assert.equal(log.share.length, 2, '취소한 뒤 다시 누르면 다시 공유한다');
  assert.equal(log.share[1].text, expectedShare(record));
  log.pendingShare[1].resolve();
  await settle();
  assert.equal(statusLine().textContent, '공유 창에 결과를 넘겼어요.');
  reviewScreen.hide();
});

test('그 밖의 공유 실패는 클립보드로 내려간다 — 성공·실패 모두 끝난 뒤에만 말하고, 직접 고르는 길은 남는다', async () => {
  let log = installNavigator();
  const h = harness();
  const record = play(h, ['o', 'x', 'o', 'x', 'o']);
  shareButton().click();
  log.pendingShare[0].reject(new DOMException('not allowed', 'NotAllowedError'));
  await settle();
  assert.deepEqual(log.clipboard, [expectedShare(record)]);
  assert.equal(statusLine().textContent, '', '클립보드가 끝나기 전에는 성공을 말하지 않는다');
  log.pendingClip[0].resolve();
  await settle();
  assert.equal(statusLine().textContent, '결과를 복사했어요. 원하는 곳에 붙여 넣어 주세요.');
  assert.equal(textButton().hidden, false, '복사가 통해도 직접 고르는 길이 있다');

  log = installNavigator();
  shareButton().click();
  log.pendingShare[0].reject(new TypeError('share failed'));
  await settle();
  log.pendingClip[0].reject(new DOMException('denied', 'NotAllowedError'));
  await settle();
  assert.equal(statusLine().textContent, '복사하지 못했어요. 「공유 글 보기」에서 직접 골라 복사해 주세요.');
  assert.doesNotMatch(statusLine().textContent, /복사했어요/);

  // 직접 고르는 길: 읽기 전용 글에 같은 글. 고른 것만으로 «복사했어요»라고 하지 않는다
  const before = statusLine().textContent;
  textButton().click();
  const dialog = byId('daily-share-dialog');
  const text = byId('daily-share-text');
  assert.ok(dialog && text, '직접 고르는 대화상자와 글 칸이 있다');
  assert.equal(dialog.hidden, false);
  assert.equal(text.readOnly, true, '글 칸은 읽기 전용이다');
  assert.equal(text.value, expectedShare(record));
  assert.equal(fakeDocument.activeElement, text, '열면 글 칸에 선다');
  assert.equal(text.selected, true, '글을 골라 둔다');
  assert.equal(statusLine().textContent, before, '고르기만 한 것은 복사 성공이 아니다');
  assert.doesNotMatch(byId('daily-share-dialog-hint')?.textContent ?? '', /복사했어요/);
  assert.equal(log.share.length, 1, '글 보기는 공유를 부르지 않는다');
  assert.equal(log.clipboard.length, 1, '글 보기는 클립보드를 부르지 않는다');
  byId('daily-share-close').click();
  assert.equal(dialog.hidden, true);
  assert.equal(fakeDocument.activeElement, textButton(), '닫으면 연 자리로 돌아간다');
  reviewScreen.hide();
});

test('느린 공유·연달아 누르기·화면 떠나기·다른 결과로 바뀜 — 효과가 겹치지 않고 늦은 답이 새 화면을 덮지 않는다', async () => {
  let log = installNavigator();
  const first = harness();
  play(first, ['o', 'o', 'o', 'o', 'x']);
  shareButton().click();
  shareButton().click();
  shareButton().click();
  assert.equal(log.share.length, 1, '공유 창이 열린 동안 다시 눌러도 한 번이다');
  assert.equal(shareButton().getAttribute('aria-busy'), 'true');
  // 화면을 떠난다(goTo 의 closers). 늦게 끝난 공유가 아무 말도 남기지 않는다
  reviewScreen.hide();
  log.pendingShare[0].resolve();
  await settle();
  assert.equal(statusLine().textContent, '');
  assert.equal(shareButton().getAttribute('aria-busy'), null);

  // 떠난 뒤에 실패한 공유는 클립보드로 내려가지 않는다
  log = installNavigator();
  const second = harness();
  play(second, ['x', 'x', 'o', 'o', 'o']);
  shareButton().click();
  reviewScreen.hide();
  log.pendingShare[0].reject(new TypeError('late failure'));
  await settle();
  assert.equal(log.clipboard.length, 0, '떠난 화면의 실패로 복사하지 않는다');
  assert.equal(statusLine().textContent, '');

  // 다른 결과로 바뀜: 앞 결과의 공유가 늦게 끝나도 새 결과의 상태 줄은 비어 있다
  log = installNavigator();
  const a = harness();
  play(a, ['o', 'x', 'x', 'x', 'x']);
  shareButton().click();
  const storage = memoryStorage();
  const b = harness({ storage, clock: { now: kst('2026-11-26T09:00:00') } });
  const recordB = play(b, ['o', 'o', 'o', 'o', 'o']);
  assert.equal(statusLine().textContent, '');
  log.pendingShare[0].resolve();
  await settle();
  assert.equal(statusLine().textContent, '', '앞 결과의 늦은 성공이 새 결과를 덮지 않는다');
  shareButton().click();
  assert.equal(log.share.length, 2);
  assert.equal(log.share[1].text, expectedShare(recordB), '새 결과의 글이다');
  log.pendingShare[1].resolve();
  await settle();
  assert.equal(statusLine().textContent, '공유 창에 결과를 넘겼어요.');
  reviewScreen.hide();
});

test('직접 고르는 대화상자: Esc 로 닫고 연 자리로 돌아가며, 화면을 떠나면 조용히 접히고, 다시 열어도 같다', async () => {
  const log = installNavigator();
  const h = harness();
  const record = play(h, ['o', 'x', 'o', 'x', 'x']);
  assertShareVisible('대화상자');
  const dialog = byId('daily-share-dialog');
  for (let round = 0; round < 2; round += 1) {
    textButton().focus();
    textButton().click();
    assert.equal(dialog.hidden, false);
    assert.equal(byId('daily-share-text').value, expectedShare(record));
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    fakeDocument.dispatchEvent(escape);
    assert.equal(dialog.hidden, true, 'Esc 로 닫힌다');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(fakeDocument.activeElement, textButton(), '닫으면 연 버튼으로 돌아간다');
  }
  textButton().click();
  assert.equal(dialog.hidden, false);
  reviewScreen.hide();
  assert.equal(dialog.hidden, true, '화면을 떠나면 대화상자도 접힌다');
  assert.equal(log.share.length + log.clipboard.length, 0, '글 보기·닫기는 공유·복사를 부르지 않는다');

  // 덜 푼 판으로 다시 그리면 글 보기도 열리지 않는다
  const partial = harness();
  play(partial, ['o'], { finish: false });
  partial.controller.reviewAnswered(partial.session());
  textButton().click();
  assert.equal(dialog.hidden, true);
  reviewScreen.hide();
});

test('공유 글은 정해진 네 줄뿐이다 — 문제·보기·해설·ID·닉네임·방 코드·토큰·localhost·query·hash 가 없고 공식 주소는 한 번', async () => {
  const log = installNavigator();
  const h = harness();
  const record = play(h, ['o', 'x', 'o', 'o', 'x']);
  shareButton().click();
  const text = log.share[0].text;
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Quiz by Quiz · \d{4}년 \d{1,2}월 \d{1,2}일$/);
  assert.match(lines[1], /^[0-5]\/5$/);
  assert.match(lines[2], /^[✅❌]{5}$/u);
  assert.equal(lines[3], OFFICIAL_URL);
  assert.equal(text.split(OFFICIAL_URL).length - 1, 1, '공식 주소는 정확히 한 번');
  assert.equal((text.match(/https?:\/\//g) ?? []).length, 1);
  assert.equal(Object.keys(log.share[0]).join(','), 'text', '주소를 url 칸에 따로 실어 두 번 보이게 하지 않는다');
  for (const question of record.questions) {
    assert.equal(text.includes(question.id), false, question.id);
    for (const part of [question.question, question.explanation, ...question.choices]) {
      if (part.length >= 4) assert.equal(text.includes(part), false, part);
    }
  }
  for (const forbidden of [/퀴즈왕/, /localhost|127\.0\.0\.1|\[::1\]/, /\?|#/, /token|session|room/i, /인증|순위|연속|streak|%|초|분/, record.sessionId]) {
    assert.doesNotMatch(text, forbidden instanceof RegExp ? forbidden : new RegExp(forbidden));
  }
  log.pendingShare[0].resolve();
  await settle();
  reviewScreen.hide();
});

test('공유는 기록·저장 진실성·랭킹·온라인에 닿지 않는다 — 메모리에만 남은 결과도 공유하되 저장했다고 하지 않는다', async () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  const record = play(h, ['o', 'x', 'o', 'x', 'o']);
  const snapshot = new Map(storage.values);
  const writes = storage.writes.length;
  const browserWrites = browserStorage.writes.length;
  const browserSnapshot = new Map(browserStorage.values);
  const fetches = fetchCalls.length;

  let log = installNavigator();
  shareButton().click();
  log.pendingShare[0].reject(new TypeError('x'));
  await settle();
  log.pendingClip[0].resolve();
  await settle();
  textButton().click();
  byId('daily-share-close').click();
  log = installNavigator({ share: false });
  shareButton().click();
  log.pendingClip[0].reject(new Error('denied'));
  await settle();

  assert.deepEqual(new Map(storage.values), snapshot, '오늘의 퀴즈 레코드가 그대로다');
  assert.equal(storage.writes.length, writes, '공유는 저장소에 쓰지 않는다');
  assert.equal(browserStorage.writes.length, browserWrites, '이 브라우저의 다른 열쇠에도 쓰지 않는다');
  assert.deepEqual(new Map(browserStorage.values), browserSnapshot);
  assert.equal(fetchCalls.length, fetches, '서버·외부 요청이 없다');
  assert.equal(JSON.parse(storage.getItem(dailyKey('2026-11-25'))).completedAt, record.completedAt);
  reviewScreen.hide();

  // 저장소를 못 쓰는 창: 공유는 되지만 저장 범위 줄은 여전히 «저장하지 못했어요»다
  const broken = harness({ storage: memoryStorage({ failWrites: true }) });
  const memoryRecord = play(broken, ['o', 'o', 'x', 'o', 'x']);
  assert.equal(broken.calls.review.at(-1).scope, DAILY_UNSAVED_SCOPE);
  assert.equal(byId('quiz-review-scope').textContent, DAILY_UNSAVED_SCOPE);
  log = installNavigator();
  assertShareVisible('메모리에만 남은 결과');
  shareButton().click();
  assert.equal(log.share[0].text, expectedShare(memoryRecord));
  assert.doesNotMatch(log.share[0].text, /저장/);
  log.pendingShare[0].resolve();
  await settle();
  assert.doesNotMatch(statusLine().textContent, /저장/);
  reviewScreen.hide();
});

test('app·층 경계: 공유 글은 core 의 순수 함수, 효과는 ui 의 한 모듈 — 저장소·온라인·랭킹을 import 하지 않는다', async () => {
  const app = await source('src/app.ts');
  const start = app.indexOf('showReview: (view) => {');
  assert.ok(start > 0);
  const body = app.slice(start, app.indexOf('goTo(\'quiz-review\');', start));
  assert.match(body, /share: view\.share,/, 'app.ts 가 오늘의 퀴즈 결과의 공유 글을 «푼 문제» 화면에 넘긴다');
  const showAnswered = app.slice(app.indexOf('function showAnsweredReview('), app.indexOf('\n  }\n', app.indexOf('function showAnsweredReview(')));
  assert.doesNotMatch(showAnswered.slice(showAnswered.indexOf('quizReviewScreen.show')), /share/, '일반 판의 푼 문제는 공유 글을 넘기지 않는다');

  const core = await source('src/core/daily-share.ts');
  assert.doesNotMatch(core, /document|window|navigator/, 'core 는 DOM·브라우저를 모른다');
  const ui = await source('src/ui/daily-share.ts');
  for (const text of [core, ui]) {
    assert.doesNotMatch(text, /storage\/|rankingStore|preferences|roomStore|online\/|fetch\(|localStorage/);
  }
  assert.match(ui, /navigator\.share|\.share\(/);
  const constants = await source('src/constants.ts');
  assert.match(constants, /export const SERVICE_NAME = 'Quiz by Quiz';/);
  assert.match(constants, /export const SERVICE_URL = 'https:\/\/perust\.github\.io\/quiz-by-quiz\/';/);
  // 상태 줄은 처음부터 보이는 라이브 리전이고(«숨긴 채로 채우면 낭독되지 않는다»), 대화상자는 <main> 뒤에 있다
  assert.match(html, /<p[^>]*id="quiz-review-share-status"[^>]*role="status"|<p[^>]*role="status"[^>]*id="quiz-review-share-status"/);
  assert.ok(html.indexOf('id="daily-share-dialog"') > html.indexOf('</main>'));
  assert.match(html, /<textarea[^>]*id="daily-share-text"[^>]*readonly/);
});
