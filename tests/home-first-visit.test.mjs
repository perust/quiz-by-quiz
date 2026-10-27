import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, lengthOf, loadStyles, node, valueOf } from './css-cascade.mjs';

// 처음 온 사람의 홈 (U01·U04·U06). 시작 전에 «몇 문제·몇 초·속도 점수 없음·무엇이 답·기록은 어디»를
// 읽을 수 있어야 하고(「게임 방법」), dock 이 한 판의 길이를 말해야 하며(«분야 골라 10문제»·«25문제»),
// 문제 은행 알림은 닫을 수 있어야 한다 — 예전에는 분야 하나만 못 받아도 세션 내내 홈에서 걸을 수 없었다.
// 시작 시트·카운트다운·코치마크는 두지 않는다(정적 정보만, FR-3.12). 화면 모듈을 가짜 DOM 위에 실제로 띄운다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const html = await source('index.html');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

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
    this.parent = null;
    this.focusable = [];
  }
  append(...nodes) { nodes.forEach((child) => { child.parent = this; }); this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return null; }
  querySelectorAll() { return this.focusable; }
  closest(selector) { return selector === '[data-screen]' ? this.screen ?? null : null; }
  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView() {}
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id.startsWith('open-') || id.endsWith('-close') || id.endsWith('-reload') ? 'button' : 'div'));
  return elements.get(id);
};

const homeScreenElement = new FakeElement('section');
byId('home-stage').screen = homeScreenElement;
// 알림 안의 버튼은 알림의 자손이다 — 닫은 뒤 포커스를 옮길지 이것으로 본다
byId('home-note').append(byId('home-note-text'), byId('home-note-reload'), byId('home-note-close'));
byId('home-note').hidden = true;
byId('rules-dialog').hidden = true;
byId('nickname-dialog').hidden = true;
byId('open-online').setAttribute('aria-label', '온라인, 방을 만들거나 참가해요');
byId('open-online-desc').textContent = '방을 만들거나 참가해요';
const rulesPanel = new FakeElement('div');

/** 문서에 단 keydown 리스너. 캡처 단계인지와 함께 순서대로 부른다 */
const keyListeners = [];
const fakeDocument = new EventTarget();
Object.assign(fakeDocument, {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  // 이동 조작부(walk-*)는 없는 문서로 둔다 — 키보드 워커만으로도 화면은 돈다
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '#rules-dialog [role="dialog"]') return rulesPanel;
    if (selector === '.dialog-backdrop:not([hidden])') {
      return ['rules-dialog', 'nickname-dialog'].map(byId).find((dialog) => !dialog.hidden) ?? null;
    }
    return null;
  },
  querySelectorAll: () => [],
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  addEventListener(type, listener, options) {
    if (type === 'keydown') keyListeners.push({ listener, capture: options === true || options?.capture === true });
  },
});
fakeDocument.activeElement = fakeDocument.body;
fakeDocument.documentElement.style = {
  setProperty: (name, value) => { rootStyle.set(name, value); },
  removeProperty: (name) => { rootStyle.delete(name); },
  getPropertyValue: (name) => rootStyle.get(name) ?? '',
};
globalThis.document = fakeDocument;
globalThis.HTMLElement = FakeElement;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
/** 홈이 단 MutationObserver 들. 무엇을 어떤 옵션으로 보는지와 콜백을 남긴다 (layout-01) */
const mutationObservers = [];
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.targets = []; mutationObservers.push(this); }
  observe(target, options) { this.targets.push({ target, options }); }
  disconnect() {}
};
/** 문서 뿌리의 사용자 속성(--home-dock-h)을 읽을 수 있게 한다 */
const rootStyle = new Map();
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

class FakeKey extends Event {
  constructor(key) {
    super('keydown', { cancelable: true, bubbles: true });
    this.key = key;
    this.repeat = false;
    this.ctrlKey = false;
    this.metaKey = false;
    this.altKey = false;
    this.shiftKey = false;
    this.stopped = false;
  }
  stopPropagation() { this.stopped = true; }
}

/** 브라우저처럼 캡처 리스너부터 부르고, 캡처에서 전파가 멈추면 나머지는 부르지 않는다 */
function press(key) {
  const event = new FakeKey(key);
  for (const { listener } of keyListeners.filter(({ capture }) => capture)) listener(event);
  if (!event.stopped) for (const { listener } of keyListeners.filter(({ capture }) => !capture)) listener(event);
  return event;
}

const { createHomeScreen } = await import('../js/ui/home.js');
const { createRulesDialog } = await import('../js/ui/rules-dialog.js');
const { CATEGORIES } = await import('../js/constants.js');

const reloads = [];
const home = createHomeScreen({
  onSelectCategory() {}, onStartAll() {}, onOpenRanking() {}, onOpenCharacters() {}, onOpenOnline() {},
  onReturnToRoom() {}, onNickname() {},
  onReload: () => reloads.push('reload'),
});
let timeLimitMs = 20_000;
createRulesDialog({ getTimeLimit: () => timeLimitMs });

const question = (id, category) => ({
  id, category, question: `${id}?`, choices: ['가', '나', '다', '라'], answerIndex: 0, explanation: '', difficulty: 'easy', tags: [],
});
const fullBanks = Object.fromEntries(CATEGORIES.map(({ id }) => [id, Array.from({ length: 12 }, (_, i) => question(`${id}-${i}`, id))]));

function renderHome({ banks = fullBanks, bestScores = {}, allCount = 25 } = {}) {
  homeScreenElement.hidden = false;
  home.render({ categories: CATEGORIES, banks, bestScores, allCount, characterId: 'slime-blue', nickname: '퀴즈왕' });
}

// ── 한 판의 길이 (U04) ────────────────────────────────────────────

test('홈 dock 은 «분야 골라 10문제», 기록이 없는 전체 도전은 «25문제»를 말한다 — 기록이 생기면 «최고 N점»', () => {
  assert.equal(byId('category-caption').textContent, '분야 골라 10문제');

  renderHome();
  assert.equal(byId('start-all-meta').hidden, false);
  assert.equal(byId('start-all-meta').textContent, '25문제');
  assert.equal(byId('start-all').getAttribute('aria-label'), '전체 도전, 25문제', '짧은 화면에서 표식이 접혀도 이름에 남는다');

  renderHome({ bestScores: { all: 180 } });
  assert.equal(byId('start-all-meta').textContent, '최고 180점');
  assert.equal(byId('start-all').getAttribute('aria-label'), '전체 도전, 최고 180점');

  // 은행이 모자라면 실제로 나갈 문항 수다 — 은행 크기(12)가 아니다
  renderHome({ allCount: 23 });
  assert.equal(byId('start-all-meta').textContent, '23문제');
  const cards = byId('category-grid').children;
  assert.equal(cards.length, 5);
  for (const card of cards) assert.doesNotMatch(card.getAttribute('aria-label'), /12|문제 풀기,.*문제/, '분야 칸은 은행 크기를 말하지 않는다');
});

test('홈 dock 캡션: 어두운 dock 위의 보조 글자이고, 짧은 가로 화면에서는 눈에서만 접는다', () => {
  const stage = node('div.home-stage#home-stage', node("section.screen[data-screen='home']", node('main.app', node('body'))));
  const caption = node('p.home-quests__caption#category-caption', node('div.home-quests#home-quests', stage));
  for (const env of [MOBILE, DESKTOP, NARROW]) {
    assert.equal(valueOf(rules, caption, 'color', env), 'var(--hud-text-muted)');
    assert.equal(valueOf(rules, caption, 'font-size', env), 'var(--text-xs)', '일반 UI 글자는 12px 아래로 내리지 않는다');
    assert.notEqual(valueOf(rules, caption, 'position', env), 'absolute', `${env.width}×${env.height}: 보인다`);
  }
  const landscape = { width: 844, height: 390, pointer: 'coarse', hover: 'none', reducedMotion: false };
  assert.equal(valueOf(rules, caption, 'position', landscape), 'absolute');
  assert.equal(valueOf(rules, caption, 'clip-path', landscape), 'inset(50%)', '분야 칸 묶음의 이름으로는 그대로 읽힌다');
});

// ── dock 높이 (layout-01) ──────────────────────────────────────────

test('dock 높이: dock 안의 DOM 이나 홈의 hidden 이 바뀌면 MutationObserver 가 그 틱 안에서 --home-dock-h 를 맞춘다', () => {
  // ResizeObserver 는 다음 프레임 직전에야 알리고 숨은 탭에서는 알리지 않는다. 그동안 조작부·두 입구가
  // 대체값(148px)에 서서 선택 원이 「게임 방법」을, 스틱이 dock 을 덮었다
  const dock = byId('home-quests');
  const watcher = mutationObservers.find((observer) => observer.targets.some(({ target }) => target === dock));
  assert.ok(watcher, 'dock 을 보는 MutationObserver 가 있다');
  const onDock = watcher.targets.find(({ target }) => target === dock).options;
  assert.equal(onDock.subtree, true);
  assert.equal(onDock.childList, true, '분야 칸·표식 글을 바꾸면');
  assert.equal(onDock.characterData, true, '«연결 중…» 같은 글이 바뀌면');
  assert.deepEqual(onDock.attributeFilter, ['hidden'], '방 복귀 줄·표식을 펴고 접으면 — 워커의 is-standing 같은 class 는 보지 않는다');
  const onScreen = watcher.targets.find(({ target }) => target === homeScreenElement)?.options;
  assert.deepEqual(onScreen?.attributeFilter, ['hidden'], '홈이 다시 보이면(숨은 동안 화면 크기가 바뀌었을 수 있다)');
  assert.notEqual(onScreen?.subtree, true);

  let height = 128;
  dock.getBoundingClientRect = () => ({ left: 0, top: 232, right: 700, bottom: 360, width: 700, height });
  watcher.callback([]);
  assert.equal(rootStyle.get('--home-dock-h'), '128px');
  height = 71.5;
  watcher.callback([]);
  assert.equal(rootStyle.get('--home-dock-h'), '72px', '올려 잡아 dock 위 1px 도 덮지 않는다');
  // 숨은 홈(높이 0)에서는 맞추지 않는다 — 다시 보일 때 맞춘다
  height = 0;
  watcher.callback([]);
  assert.equal(rootStyle.get('--home-dock-h'), '72px');
  delete dock.getBoundingClientRect;
});

// ── 「게임 방법」 (U01) ────────────────────────────────────────────

test('「게임 방법」 입구: 홈 화면 안의 edge HUD 원이고, 설정 버튼 바로 아래(높이 480px 이하는 옆) 44px 이다', () => {
  const homeMarkup = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const shortcuts = between(homeMarkup, '<nav class="home-menu"', '</nav>');
  assert.match(shortcuts, /<button type="button" class="icon-button home-rules" id="open-rules" aria-haspopup="dialog">\s*<span class="icon-button__icon icon" data-icon="question" aria-hidden="true"><\/span>\s*<span class="sr-only">게임 방법<\/span>/);
  assert.doesNotMatch(between(html, '<div class="app-bar">', '</div>'), /open-rules/, '앱 바에 두면 다른 화면의 머리말과 겹친다');

  const stage = node('div.home-stage#home-stage', node("section.screen[data-screen='home']", node('main.app', node('body'))));
  const button = node('button.icon-button.home-rules#open-rules', node('nav.home-menu', stage));
  for (const env of [MOBILE, DESKTOP, NARROW]) {
    assert.equal(valueOf(rules, button, 'position', env), 'absolute');
    // 설정 버튼은 위 여백 12px 에서 44px — 그 아래 8px 띄워 선다
    assert.equal(lengthOf(rules, valueOf(rules, button, 'top', env), env), 12 + 44 + 8);
    assert.equal(lengthOf(rules, valueOf(rules, button, 'width', env), env), 44);
    assert.ok(lengthOf(rules, valueOf(rules, button, 'min-height', env), env) >= 44);
    assert.equal(valueOf(rules, button, 'z-index', env), null, 'z-index 없이 DOM 순서로 그린다');
    assert.equal(lengthOf(rules, valueOf(rules, button, 'right', env), env), 12, '설정 버튼과 같은 오른쪽 끝');
  }
  // 높이 480px 이하는 설정 버튼 왼쪽 옆 같은 줄이다 (layout-01). 아래로 쌓은 오른쪽 HUD 열(위 여백 + 96px)이
  // 568×320 에서는 dock 위 모서리의 랭킹 입구와, 740×360 에서는 방 복귀 줄로 올라온 선택 원과 겹쳤다
  const touch = (width, height) => ({ width, height, pointer: 'coarse', hover: 'none', reducedMotion: false });
  for (const env of [touch(740, 360), touch(568, 320), touch(844, 390), touch(926, 428), { ...DESKTOP, width: 740, height: 360 }]) {
    const at = `${env.width}×${env.height} ${env.pointer}`;
    assert.equal(lengthOf(rules, valueOf(rules, button, 'top', env), env), 12, `${at}: 설정 버튼과 같은 줄`);
    assert.equal(lengthOf(rules, valueOf(rules, button, 'right', env), env), 12 + 44 + 8, `${at}: 설정 버튼 왼쪽 8px`);
  }
  for (const env of [touch(375, 667), touch(320, 568), touch(1024, 768)]) {
    assert.equal(lengthOf(rules, valueOf(rules, button, 'top', env), env), 12 + 44 + 8, `${env.width}×${env.height}: 높은 화면은 아래 그대로`);
  }
  const hovered = node('button.icon-button.home-rules#open-rules:hover', node('nav.home-menu', stage));
  assert.equal(valueOf(rules, hovered, 'background', DESKTOP), 'var(--hud-bg)', 'hover 에도 흰 아이콘이 어두운 HUD 위에 남는다');
  const standing = node('button.icon-button.home-rules.is-standing#open-rules', node('nav.home-menu', stage));
  assert.equal(valueOf(rules, standing, 'outline-color', MOBILE), 'var(--focus-on-hud)');
});

test('「게임 방법」 대화상자: 다른 대화상자와 같은 인페이지 구조이고, 피드백 패널보다 위에 그려진다', () => {
  const dialog = between(html, '<div class="dialog-backdrop" id="rules-dialog"', '<!-- 온라인 매치 나가기 확인');
  assert.match(dialog, /^<div class="dialog-backdrop" id="rules-dialog" hidden>\s*<div class="dialog" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="rules-dialog-title">/);
  assert.match(dialog, /<h2 class="dialog__title" id="rules-dialog-title">게임 방법<\/h2>/);
  for (const [term, id] of [['한 판', 'rules-length'], ['문항 시간', 'rules-time'], ['점수', 'rules-score'], ['답하기', 'rules-answer'], ['기록', 'rules-record']]) {
    assert.match(dialog, new RegExp(`<dt>${term}</dt>\\s*<dd id="${id}"></dd>`), term);
  }
  assert.match(dialog, /<dt>움직이기<\/dt>\s*<dd>[^<]*<kbd>W<\/kbd>/, '홈에서도 걸을 수 있다는 것을 말한다');
  // 용어 목록은 혼자 하기 규칙이라고 이름을 달고, 온라인은 다른 것만 따로 한 줄로 말한다 (local-ux-1)
  assert.match(dialog, /id="rules-dialog-title">게임 방법<\/h2>\s*(?:<!--[\s\S]*?-->\s*)?<h3 class="dialog__heading">혼자 하기<\/h3>\s*<dl class="help-list">/);
  assert.match(dialog, /<\/dl>\s*<h3 class="dialog__heading">온라인<\/h3>\s*<p class="dialog__body" id="rules-online"><\/p>\s*<div class="dialog__actions">/);
  assert.match(dialog, /id="rules-close">닫기<\/button>/);
  assert.doesNotMatch(dialog, /<select|<input/);
  assert.ok(html.indexOf('id="feedback"') < html.indexOf('id="rules-dialog"'));
});

test('「게임 방법」: 열면 지금 고른 문항 시간과 규칙을 말하고, Esc 로 닫으면 연 버튼으로 돌아온다', () => {
  const opener = byId('open-rules');
  const dialog = byId('rules-dialog');
  opener.focus();
  opener.click();
  assert.equal(dialog.hidden, false);
  assert.equal(fakeDocument.activeElement, rulesPanel, '200% 확대에서도 제목부터 보이게 패널이 먼저 받는다');
  assert.equal(byId('rules-length').textContent, '분야 10문제 · 전체 도전 25문제');
  assert.equal(byId('rules-time').textContent, '문항당 20초 · 설정에서 바꿀 수 있어요');
  assert.equal(byId('rules-score').textContent, '정답당 10점 · 빨리 답해도 점수는 같아요');
  assert.match(byId('rules-answer').textContent, /보기나 바닥 칸을 누르면 바로 답이 나가요\. 시간이 끝나면 캐릭터가 서 있는 칸이 답이에요\. 십자 틈에 서 있으면 답하지 않은 것이 돼요\./);
  assert.equal(byId('rules-record').textContent, '이 브라우저에만 저장돼요');
  assert.match(byId('rules-online').textContent, /칸에 서 있기만 해서는 제출되지 않아요/, '온라인은 서 있기만 하면 답이 나가지 않는다');
  assert.match(byId('rules-online').textContent, /방장이 20초나 40초로 정해요/);

  // 열려 있는 동안 홈 캐릭터는 방향키를 받지 않고, 키는 화면 쪽으로 새지 않는다
  renderHome();
  const arrow = press('ArrowDown');
  assert.equal(arrow.stopped, true, '캡처 단계에서 멈춘다');
  assert.equal(arrow.defaultPrevented, false, '뒤의 홈 워커가 걷지 않는다');

  const escape = press('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(dialog.hidden, true);
  assert.equal(fakeDocument.activeElement, opener);

  // 설정에서 시간을 바꾸면 다음에 열 때 그 값을 말한다 (FR-3.7)
  timeLimitMs = null;
  fakeDocument.activeElement = fakeDocument.body; // 걸어가서 눌렀다 (워커는 걷기 시작할 때 포커스를 놓는다)
  opener.click();
  assert.equal(byId('rules-time').textContent, '시간 제한 없음 · 설정에서 바꿀 수 있어요');
  assert.match(byId('rules-answer').textContent, /칸 위에서 선택 버튼이나 Enter · Space를 눌러요/);
  assert.doesNotMatch(byId('rules-answer').textContent, /시간이 끝나면/, '제한 없음 판에는 시간 초과가 없다');
  byId('rules-close').click();
  assert.equal(dialog.hidden, true);
  assert.equal(fakeDocument.activeElement, opener, '걸어가서 열었으면 「게임 방법」 버튼으로 돌아온다');
  timeLimitMs = 20_000;
});

test('「게임 방법」: Tab 은 대화상자 안에서 맴돈다', () => {
  const opener = byId('open-rules');
  const close = byId('rules-close');
  byId('rules-dialog').focusable = [close];
  opener.click();
  const tab = press('Tab');
  assert.equal(tab.defaultPrevented, true);
  assert.equal(fakeDocument.activeElement, close, '패널에서 Tab 은 닫기로');
  assert.equal(press('Tab').defaultPrevented, true, '하나뿐인 조작부에서 Tab 은 제자리를 맴돈다');
  assert.equal(fakeDocument.activeElement, close);
  press('Escape');
});

test('app: 「게임 방법」은 지금 고른 문항 시간을 읽고, 화면을 옮길 때 접는다', async () => {
  const app = await source('src/app.ts');
  // 온라인 한 줄은 세션을 열 때 서버가 알려 준 규칙을 따른다 (U13·혼자 여는 방)
  // 「혼자 하기」 줄은 분야 칸이 지금 여는 판의 규칙이다 (FR-7.13 3단계 — 혼자 온라인 판·연습·예전 혼자 하기)
  assert.match(app, /const rulesDialog = createRulesDialog\(\{\s*getTimeLimit: \(\) => timeLimitMs,\s*getOnlineRules: \(\) => roomStore\.onlineRules\(\),[\s\S]*?getPlayMode: \(\) => \(playMode === 'online' \? 'online' : playMode === 'practice' \? 'practice' : 'local'\),\s*\}\);/);
  assert.match(app, /settingsDialog\.dismiss\(\);\s*rulesDialog\.dismiss\(\);/);
});

// ── 문제 은행 알림 (U06) ──────────────────────────────────────────

test('문제 은행 알림: 보이는 동안 캐릭터가 꺼지고, 「닫기」로 거두면 다시 걷는다 — 「다시 불러오기」는 새로 읽는다', () => {
  renderHome();
  assert.equal(press('ArrowLeft').defaultPrevented, true, '알림이 없으면 홈 캐릭터가 방향키를 받는다');
  press('Escape');

  home.setNote('문제를 불러오지 못한 카테고리가 있어요: 과학');
  assert.equal(byId('home-note').hidden, false);
  assert.equal(byId('home-note-text').textContent, '문제를 불러오지 못한 카테고리가 있어요: 과학');
  assert.equal(press('ArrowLeft').defaultPrevented, false, '알림이 보이는 동안 캐릭터와 조작부는 꺼져 있다');

  // 홈을 다시 그려도 알림이 있는 동안은 꺼진 채다
  renderHome();
  assert.equal(press('ArrowLeft').defaultPrevented, false);

  byId('home-note-reload').click();
  assert.deepEqual(reloads, ['reload']);

  byId('home-note-close').focus();
  byId('home-note-close').click();
  assert.equal(byId('home-note').hidden, true);
  assert.equal(byId('home-note-text').textContent, '');
  assert.equal(fakeDocument.activeElement, homeScreenElement, '사라진 버튼 대신 홈 화면에 포커스를 둔다 — body 로 떨어지지 않는다');
  assert.equal(press('ArrowLeft').defaultPrevented, true, '닫으면 세션 내내 꺼져 있지 않고 곧바로 다시 걷는다');

  renderHome();
  assert.equal(press('ArrowLeft').defaultPrevented, true, '닫은 알림은 홈에 다시 와도 돌아오지 않는다');
});

test('문제 은행 알림: 라이브 리전은 글뿐이고 버튼은 그 밖이다. 못 받은 분야 칸은 이름이 이유를 말한다', () => {
  const homeMarkup = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const note = between(homeMarkup, '<div class="home-note" id="home-note" hidden>', '</section>');
  assert.match(note, /<p class="home-note__text" id="home-note-text" role="alert"><\/p>/);
  assert.match(note, /<div class="home-note__actions">\s*<button type="button" class="button button--ghost button--small" id="home-note-reload">다시 불러오기<\/button>\s*<button type="button" class="button button--ghost button--small" id="home-note-close">닫기<\/button>/);
  assert.doesNotMatch(note.slice(0, note.indexOf('home-note__actions')), /<button/);

  renderHome({ banks: { ...fullBanks, science: [] } });
  const science = byId('category-grid').children.find((card) => card.dataset.category === 'science');
  assert.equal(science.disabled, true);
  assert.equal(science.getAttribute('aria-label'), '과학 문제 풀기, 불러오지 못함');
});

test('홈 온라인 입구: 세션이 알려 준 시작 인원으로 보조 줄과 이름을 바꾸고, 바쁨을 거두면 그 말로 돌아온다', () => {
  const desc = byId('open-online-desc');
  const button = byId('open-online');
  home.setOnlineMinPlayers(1);
  assert.equal(desc.textContent, '혼자서도 · 친구와 함께');
  assert.equal(button.getAttribute('aria-label'), '온라인, 혼자서도 친구와 함께');

  home.setOnlineBusy(true);
  assert.equal(desc.textContent, '연결 중…');
  // 로비를 불러오는 사이 둘부터인 이전 API라는 것을 알았다 — 바쁨 표시는 그대로 두고, 거둘 때 쓴다
  home.setOnlineMinPlayers(2);
  assert.equal(desc.textContent, '연결 중…');
  assert.equal(button.getAttribute('aria-label'), '온라인, 연결 중');
  home.setOnlineBusy(false);
  assert.equal(desc.textContent, '친구와 함께 · 2명부터');
  assert.equal(button.getAttribute('aria-label'), '온라인, 친구와 함께 2명부터');

  home.setOnlineMinPlayers(null);
  assert.equal(desc.textContent, '방을 만들거나 참가해요', '아직 모르면 어느 API든 맞는 말');
  assert.equal(button.getAttribute('aria-label'), '온라인, 방을 만들거나 참가해요');
});
