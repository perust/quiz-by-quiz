import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, nodeFromHtml, valueOf } from './css-cascade.mjs';

// 결과 화면은 «등록»을 누르지 않고 떠나도 기록을 남긴다 (FR-6.1, U21).
// 전에는 「다시 하기」·「홈으로」를 누르면 기록이 조용히 사라졌고, 다음 판의 최고 기록 비교와
// 홈의 별 점수도 그 판을 몰랐다. 화면 모듈을 가짜 DOM 위에 실제로 띄워 그 길을 확인한다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── 가짜 DOM ───────────────────────────────────────────────────────
// 워커 모듈은 불러오는 순간 document·window 에 리스너를 단다. 그 전에 필요한 만큼만 흉내 낸다.
// 각 테스트 파일은 따로 된 프로세스에서 돌아 다른 테스트로 새지 않는다.

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
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.scrolled = null;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() {}
  querySelector() { return null; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView(options) { this.scrolled = options; }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const screen = new FakeElement('section');
const header = new FakeElement('header');

globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};
globalThis.document = {
  body: new FakeElement('body'),
  activeElement: null,
  // 이동 조작부(walk-*)는 없는 문서로 둔다 — 키보드 워커만으로도 화면은 돈다
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '[data-screen="result"]') return screen;
    if (selector === '[data-screen="result"] .result-header') return header;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { createResultScreen, autoSaveNickname, describeOutcome } = await import('../js/ui/result.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function summary({ review = [] } = {}) {
  return {
    mode: 'category',
    categoryId: 'science',
    score: 70,
    maxScore: 100,
    correctCount: 7,
    totalCount: 10,
    accuracy: 0.7,
    durationMs: 61000,
    grade: { label: '상식인', message: '좋아요' },
    byCategory: [],
    review,
    questionResults: [],
  };
}

const REVIEW = [
  { question: '물의 끓는점은?', chosenChoice: '90도', correctChoice: '100도', explanation: '1기압에서 100도', timedOut: false },
  { question: '빛의 삼원색이 아닌 것은?', chosenChoice: null, correctChoice: '노랑', explanation: '빨강·초록·파랑', timedOut: true },
];

// 화면 모듈은 같은 DOM 요소에 리스너를 단다. 테스트마다 새로 띄우면 앞 화면의 리스너가 남아
// 같은 클릭을 두 번 받으므로, 화면은 한 번만 띄우고 판마다 다시 show 한다.
// 저장이 어떻게 끝날지는 판마다 `saveWith` 로 바꿔 끼운다.
const calls = [];
let saveWith = () => Promise.resolve({ rank: 2, kept: true, stored: true });
/** 대기실로 옮기는 길. 네트워크를 기다리는 느린 이동을 흉내 낼 때 바꿔 끼운다 */
let roomWith = () => Promise.resolve();
const resultScreen = createResultScreen({
  onRegister(nickname) {
    calls.push(['register', nickname]);
    return saveWith();
  },
  onRetry: async () => { calls.push(['retry']); },
  onHome: async () => { calls.push(['home']); },
  onRoom: () => {
    calls.push(['room']);
    return roomWith();
  },
  onRanking: async () => { calls.push(['ranking']); },
});

function showRound({ nickname = '퀴즈왕', review = [], inRoom = false } = {}) {
  calls.length = 0;
  byId('announcer').textContent = '';
  byId('result-room').textContent = '대기실로';
  resultScreen.show({
    summary: summary({ review }),
    modeLabel: '과학',
    bestScore: null,
    nickname,
    characterId: 'slime-blue',
    inRoom,
  });
}

/** 끝나는 때를 테스트가 정하는 이동 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('자동 저장 이름: 칸이 규칙에 맞으면 그 이름, 아니면 저장된 이름, 그것도 아니면 기본 이름', () => {
  assert.equal(autoSaveNickname('  새이름 ', '퀴즈왕'), '새이름');
  assert.equal(autoSaveNickname('', '홈이름'), '홈이름', '비워 두고 떠나도 막지 않고 저장된 이름으로 남긴다');
  assert.equal(autoSaveNickname('가', '홈이름'), '홈이름', '한 글자만 적다 떠나도 막지 않는다');
  assert.equal(autoSaveNickname('열한글자가넘는긴이름이다', '홈이름'), '홈이름');
  assert.equal(autoSaveNickname('', ''), '퀴즈왕');
  assert.equal(autoSaveNickname('', '너무너무너무너무긴옛이름'), '퀴즈왕');
});

test('저장 문구는 순위가 이 브라우저 안의 순위임을 밝힌다 (U09)', () => {
  assert.equal(describeOutcome({ rank: 3, kept: true, stored: true }).text, '이 브라우저 기록 중 3위로 저장했어요.');
  assert.equal(describeOutcome({ rank: 3, kept: true, stored: true }).tone, 'done');
  assert.equal(describeOutcome({ rank: 11, kept: false, stored: true }).tone, null);
  assert.equal(describeOutcome({ rank: 1, kept: false, stored: false }).tone, 'error');
  for (const outcome of [{ rank: 1, kept: true, stored: true }, { rank: 11, kept: false, stored: true }]) {
    assert.doesNotMatch(describeOutcome(outcome).text, /습니다/, '한 화면 안에서 해요체로 맞춘다');
  }
});

test('결과 화면: 등록 칸은 받은 닉네임으로 채워지고, 「등록」 없이 떠나도 기록을 남긴 뒤 옮긴다', async () => {
  // ① 등록 칸이 홈 HUD와 같은 이름으로 채워진다 (U02)
  showRound({ nickname: '퀴즈왕' });
  assert.equal(byId('nickname-input').value, '퀴즈왕');

  // ② 「다시 하기」만 눌러도 저장을 마친 **뒤에** 다음 판을 연다 (U21)
  byId('result-retry').click();
  await tick();
  assert.deepEqual(calls, [['register', '퀴즈왕'], ['retry']]);
  assert.equal(byId('nickname-input').disabled, true, '저장한 판은 다시 등록하지 못하게 잠근다');
  assert.equal(byId('register-message').textContent, '이 브라우저 기록 중 2위로 저장했어요.');
  assert.equal(byId('announcer').textContent, '', '성공은 다음 화면에서 따로 알리지 않는다');

  // ③ 「등록」을 누르고 곧바로 「랭킹 보기」를 눌러도 한 번만 저장한다
  showRound({ nickname: '퀴즈왕' });
  byId('nickname-input').value = '새이름';
  byId('register-form').dispatchEvent(new Event('submit', { cancelable: true }));
  byId('result-ranking').click();
  await tick();
  assert.deepEqual(calls, [['register', '새이름'], ['ranking']]);
  byId('result-home').click();
  await tick();
  assert.deepEqual(calls, [['register', '새이름'], ['ranking'], ['home']], '이미 남긴 판은 다시 저장하지 않는다');

  // ④ 한 글자만 적다 「홈으로」를 눌러도 막지 않고 저장된 이름으로 남긴다
  showRound({ nickname: '홈이름' });
  byId('nickname-input').value = '가';
  byId('result-home').click();
  await tick();
  assert.deepEqual(calls, [['register', '홈이름'], ['home']]);

  // ⑤ 버튼을 연달아 눌러도 한 번만 옮긴다
  showRound();
  byId('result-retry').click();
  byId('result-retry').click();
  byId('result-home').click();
  await tick();
  assert.deepEqual(calls, [['register', '퀴즈왕'], ['retry']]);

  // ⑥ 탭을 닫거나 새로고침할 때(pagehide)는 기다릴 수 없다. **부르는 자리에서 곧바로**
  // 저장을 시작해야 로컬 저장소가 그 안에서 써진다
  showRound();
  resultScreen.flush();
  assert.deepEqual(calls, [['register', '퀴즈왕']], 'flush 는 기다리지 않고 저장을 부른다');
  await tick();
  resultScreen.flush();
  byId('result-home').click();
  await tick();
  assert.deepEqual(calls, [['register', '퀴즈왕'], ['home']], 'flush 로 남긴 판도 두 번 저장하지 않는다');
});

test('결과 화면: 오답이 있으면 요약 칩 아래 링크가 개수를 말하고, 주소를 바꾸지 않고 풀이 제목으로 간다', () => {
  showRound({ review: REVIEW });
  assert.equal(byId('result-review-jump').hidden, false);
  assert.equal(byId('result-review-link').textContent, '틀린 문제 2개 해설 보기');

  const click = new Event('click', { cancelable: true });
  byId('result-review-link').dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, '주소에 #을 붙이지 않는다 (해시 라우팅 없음)');
  assert.equal(globalThis.document.activeElement, byId('result-review-title'));
  assert.deepEqual(byId('result-review-title').scrolled, { block: 'start' });

  showRound({ review: [] });
  assert.equal(byId('result-review-jump').hidden, true, '틀린 문제가 없으면 링크도 없다');
});

test('결과 화면: 자동 저장이 실패해도 이동은 막지 않고, 옮긴 화면에서 한 번 알린다', async () => {
  try {
    // 저장 공간이 꽉 차 쓰지 못했다
    saveWith = () => Promise.resolve({ rank: 1, kept: false, stored: false });
    showRound();
    byId('result-home').click();
    await tick();
    assert.deepEqual(calls, [['register', '퀴즈왕'], ['home']], '실패해도 홈으로 간다');
    assert.equal(byId('announcer').textContent, '기록을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');

    // 저장소가 던졌다
    saveWith = () => Promise.reject(new Error('쓰기 거절'));
    showRound();
    byId('result-retry').click();
    await tick();
    assert.deepEqual(calls, [['register', '퀴즈왕'], ['retry']], '던져도 다음 판을 연다');
    assert.equal(byId('announcer').textContent, '기록을 저장하지 못했어요: 쓰기 거절');
    assert.equal(byId('nickname-input').disabled, false, '남기지 못한 판은 잠그지 않는다');
  } finally {
    saveWith = () => Promise.resolve({ rank: 2, kept: true, stored: true });
  }
});

test('결과 화면: 「대기실로」가 오래 걸려도 다른 행동·«뒤로»는 막히지 않고, 나중에 누른 것이 이긴다', async () => {
  const room = deferred();
  try {
    roomWith = () => room.promise;
    showRound({ inRoom: true });
    byId('result-room').click();
    await tick();
    assert.deepEqual(calls, [['register', '퀴즈왕'], ['room']]);
    // 저장은 이미 끝났다. 기다리는 동안 「등록」이 살아 있는 것처럼 보이면 눌러도 아무 일이 없다
    assert.equal(byId('nickname-input').disabled, true, '저장한 판은 기다리는 동안에도 잠겨 있다');
    assert.equal(byId('register-button').textContent, '등록 완료');
    // 무엇을 기다리는지 글자와 aria-busy 로 말한다
    assert.equal(byId('result-room').attributes['aria-busy'], 'true');
    assert.equal(byId('result-room').textContent, '연결 중…');
    assert.equal(byId('result-room').disabled, false, '잠그지 않는다 — 다른 길로 갈아탈 수 있어야 한다');

    // 같은 버튼을 다시 눌러도 이동을 겹쳐 보내지 않는다
    byId('result-room').click();
    await tick();
    assert.deepEqual(calls, [['register', '퀴즈왕'], ['room']]);

    // 「홈으로」(브라우저 «뒤로»도 이 버튼을 누른다)는 기다리지 않고 옮긴다. 다시 저장하지도 않는다
    byId('result-home').click();
    await tick();
    assert.deepEqual(calls, [['register', '퀴즈왕'], ['room'], ['home']]);
    assert.equal(byId('result-room').attributes['aria-busy'], undefined, '넘겨받았으니 바쁨 표시를 걷는다');
    assert.equal(byId('result-room').textContent, '대기실로');
    assert.equal(byId('register-message').textContent, '이 브라우저 기록 중 2위로 저장했어요.');

    // 늦게 끝난 대기실 이동은 등록 칸도 알림도 다시 건드리지 않는다
    byId('register-message').textContent = '';
    room.resolve();
    await tick();
    assert.equal(byId('register-message').textContent, '');
    assert.equal(byId('announcer').textContent, '');
  } finally {
    roomWith = () => Promise.resolve();
  }
});

test('결과 화면: 느린 「대기실로」를 다른 행동이 넘겨받아도 저장 실패는 옮긴 화면에서 한 번만 알린다', async () => {
  const room = deferred();
  try {
    saveWith = () => Promise.resolve({ rank: 1, kept: false, stored: false });
    roomWith = () => room.promise;
    showRound({ inRoom: true });
    byId('result-room').click();
    await tick();
    assert.equal(byId('announcer').textContent, '', '아직 옮기지 않았으니 알리지 않는다');

    byId('result-retry').click();
    await tick();
    assert.deepEqual(calls, [['register', '퀴즈왕'], ['room'], ['retry']]);
    assert.equal(byId('announcer').textContent, '기록을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');

    byId('announcer').textContent = '';
    room.resolve();
    await tick();
    assert.equal(byId('announcer').textContent, '', '늦게 끝난 이동이 같은 말을 또 하지 않는다');
  } finally {
    saveWith = () => Promise.resolve({ rank: 2, kept: true, stored: true });
    roomWith = () => Promise.resolve();
  }
});

// ── 화면 계약 ─────────────────────────────────────────────────────

test('등록 칸 위에 «떠나면 저장»과 저장 범위를 함께 알리고, 칸의 설명으로 이어 둔다', async () => {
  const html = await source('index.html');
  const result = html.slice(html.indexOf('data-screen="result"'), html.indexOf('data-screen="ranking"'));
  assert.match(result, /<h2 class="result-block__title">랭킹에 기록 남기기<\/h2>\s*(?:<!--[\s\S]*?-->\s*)?<p class="ranking-scope" id="register-scope">화면을 나가면 이 이름으로 저장돼요 · 이 브라우저에만 저장돼요<\/p>/);
  assert.match(result, /aria-describedby="register-scope register-message"/);
  assert.ok(result.indexOf('id="register-scope"') < result.indexOf('id="register-form"'));
});

test('오답 풀이로 건너가는 길은 버튼이 아니라 요약 칩 아래의 글자 링크다', async () => {
  const html = await source('index.html');
  const result = html.slice(html.indexOf('data-screen="result"'), html.indexOf('data-screen="ranking"'));
  const stats = result.indexOf('class="result-stats"');
  const jump = result.indexOf('id="result-review-jump"');
  const actions = result.indexOf('class="result-actions"');
  assert.ok(stats < jump && jump < actions, '요약 칩 → 링크 → 다음 행동 줄 순서다');
  assert.match(result, /<a class="result-review-link" id="result-review-link" href="#result-review-title">/);
  assert.match(result, /id="result-review-title" tabindex="-1"/, '포커스를 받을 수 있어야 스크린리더가 거기서부터 읽는다');
  const actionRow = result.slice(actions, result.indexOf('</div>', actions));
  assert.equal((actionRow.match(/<button /g) ?? []).length, 4, '결과 행동 줄은 그대로 넷이다');
});

test('결과의 안내 줄과 링크: 랭킹 안내와 같은 모양이되 주차 공간은 비우지 않고, 링크도 44px 목표다', async () => {
  const [html, rules] = await Promise.all([
    source('index.html'),
    loadStyles(['css/style.css', 'css/voxel-theme.css']),
  ]);
  const scope = nodeFromHtml(html, 'register-scope');
  const link = nodeFromHtml(html, 'result-review-link');
  for (const env of [MOBILE, DESKTOP]) {
    assert.equal(valueOf(rules, scope, 'background', env), 'var(--world-glass)', '랭킹 화면의 저장 범위 줄과 같은 표면');
    assert.equal(valueOf(rules, scope, 'padding-inline-end', env), 'var(--space-3)', '결과 워커는 여기 주차하지 않는다');
    assert.equal(valueOf(rules, link, 'min-height', env), '44px');
    assert.equal(valueOf(rules, link, 'text-decoration', env), 'underline', '버튼이 아니라 링크로 읽힌다');
    assert.equal(valueOf(rules, link, 'color', env), 'var(--accent-ink)');
  }
  // 걸어서 올라서면 다른 버튼과 같은 초점 고리로 «지금 누르면 된다»를 알린다
  const standing = { ...link, classes: [...link.classes, 'is-standing'] };
  assert.equal(valueOf(rules, standing, 'outline', MOBILE), 'var(--focus-width) solid var(--focus)');
});

// ── app.ts 배선 ───────────────────────────────────────────────────

test('app: 기본 닉네임을 처음 한 번 저장해 홈·결과·온라인이 같은 이름을 읽는다 (U02)', async () => {
  const app = await source('src/app.ts');
  assert.match(app, /const storedNickname = await preferences\.getNickname\(\);\s*let savedNickname = storedNickname \|\| DEFAULT_NICKNAME;/);
  assert.match(app, /if \(!storedNickname\) await preferences\.setNickname\(savedNickname\);/);
  // 결과 등록 칸이 빈칸이 되던 자리. 저장값이 비면 홈 HUD와 같은 이름으로 채운다
  assert.match(app, /nickname: nickname \|\| savedNickname,/);
});

test('app: 직접 등록과 자동 저장은 같은 한 길로 저장하고, 문항별 정오까지 똑같이 남긴다', async () => {
  const [app, result] = await Promise.all([source('src/app.ts'), source('src/ui/result.ts')]);
  assert.equal((app.match(/rankingStore\.saveRecord\(/g) ?? []).length, 1, '저장하는 자리는 registerRecord 하나뿐이다');
  assert.match(app, /onRegister: registerRecord,/);
  assert.match(app, /questionResults: summary\.questionResults,/);
  // 결과 화면을 떠나는 버튼은 모두 저장을 거친다
  for (const [button, callback] of [['retryButton', 'onRetry'], ['rankingButton', 'onRanking'], ['homeButton', 'onHome'], ['roomButton', 'onRoom']]) {
    assert.ok(result.includes(`el.${button}.addEventListener('click', () => { void leave(${callback}, el.${button}`), button);
  }
  // 떠나며 거는 잠금은 저장까지만이다. 옮기기를 기다리는 동안에는 다른 행동이 넘겨받는다
  assert.match(result, /const settled = await commitIfNeeded\(\);\s*leaving = false;[\s\S]*?await next\(\);/);
  // 저장 실패가 이동을 막지 않는다 — 옮긴 뒤 한 번 알린다
  assert.match(result, /await next\(\);[\s\S]*?if \(failure\) announce\(failure\);/);
});
