import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// 걷는 캐릭터가 무엇을 밟았는지 보는 자리(선택점)는 규칙 하나다 (U10, CLAUDE.md «선택점은 규칙 하나다»).
// 몸통 가운데(발끝에서 키의 절반 위)이고, 퀴즈 무대만 발끝(1px 위)이다. 한때 홈·내 캐릭터·퀴즈 무대는
// 발끝, 로비·대기실·결과·랭킹·«푼 문제»는 몸통 가운데로 보아 같은 걸음이 화면마다 다른 것을 켰다.
//
// 화면 모듈을 기하 가짜 DOM 위에 실제로 띄우고, 워커가 `elementFromPoint`에 묻는 자리를 화면마다 잰다.
// 가짜 DOM 은 상자(rect)를 단 요소를 단 차례대로 쌓아 그리고, 위에 그린 것이 점을 가져간다.
// 모듈은 불러오는 순간 document·window 에 리스너를 단다. 그 전에 필요한 만큼만 흉내 낸다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── 기하 가짜 DOM ─────────────────────────────────────────────────

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

/** 상자를 단 요소. 나중에 단 것이 위에 그려진다 */
const painted = [];
/** 워커가 물어본 점 */
const queries = [];

/** 워커들이 쓰는 선택자 조각만 흉내 낸다. 모르는 조각은 맞지 않는다 */
function matchesPart(element, part) {
  switch (part) {
    case 'button':
    case 'summary':
    case 'textarea':
    case 'select':
      return element.tagName === part.toUpperCase();
    case 'a[href]': return element.tagName === 'A' && element.getAttribute('href') !== null;
    case '[role="button"]': return element.getAttribute('role') === 'button';
    case 'input:not([type="hidden"])': return element.tagName === 'INPUT' && element.type !== 'hidden';
    case '.arena-tile[data-selectable="true"]':
      return element.className.split(/\s+/).includes('arena-tile') && element.dataset.selectable === 'true';
    case '[data-screen]': return element.dataset.screen !== undefined;
    default: return false;
  }
}

class FakeElement extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.attributes = new Map();
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.parent = null;
    this.rect = null;
  }
  /** 화면에 그린다. 위치는 viewport 기준이다 */
  paint({ left, top, width, height }) {
    this.rect = { left, top, width, height, right: left + width, bottom: top + height };
    painted.push(this);
    return this;
  }
  append(...nodes) { nodes.forEach((child) => { child.parent = this; }); this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }
  matches(selector) { return selector.split(',').some((part) => matchesPart(this, part.trim())); }
  closest(selector) {
    for (let at = this; at; at = at.parent) if (at.matches(selector)) return at;
    return null;
  }
  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  click() { this.dispatchEvent(new Event('click')); }
  scrollIntoView() {}
}

function inside(rect, x, y) {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

const elements = new Map();
const BUTTON_IDS = new Set(['open-characters', 'open-ranking', 'open-online', 'start-all', 'characters-back']);
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(BUTTON_IDS.has(id) ? 'button' : 'div'));
  return elements.get(id);
};

// 손가락 조작부. 화면 아래 모서리에 떠 있는 스틱은 어느 화면의 자손도 아니다
const controlsRoot = byId('walk-controls');
const stick = byId('walk-stick');
const knob = byId('walk-knob');
const confirmButton = Object.assign(byId('walk-confirm'), { tagName: 'BUTTON' });
controlsRoot.append(stick, confirmButton);
stick.append(knob);

/** 문서에 단 리스너. keyup 으로 눌린 방향키를 놓는다 */
const documentListeners = new Map();
const fakeDocument = {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: byId,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => new FakeElement(tag),
  addEventListener(type, listener) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
  },
  elementFromPoint(x, y) {
    queries.push({ x, y });
    for (let index = painted.length - 1; index >= 0; index -= 1) {
      const element = painted[index];
      if (!element.hidden && inside(element.rect, x, y)) return element;
    }
    return null;
  },
};
fakeDocument.activeElement = fakeDocument.body;
globalThis.document = fakeDocument;
globalThis.HTMLElement = FakeElement;
globalThis.window = {
  innerWidth: 1280, innerHeight: 900, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const frames = [];
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
globalThis.cancelAnimationFrame = () => {};

/** 쌓인 프레임을 돌린다. 서 있는 워커는 프레임을 다시 예약하지 않는다 */
function runFrames(limit = 20) {
  for (let i = 0; i < limit && frames.length; i += 1) frames.shift()(performance.now());
}

function key(name) {
  return {
    key: name, repeat: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {},
  };
}

function releaseKey(name) {
  for (const listener of documentListeners.get('keyup') ?? []) listener(key(name));
}

/** 워커가 그린 발끝(논리 좌표) */
function footOf(character) {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(character.style.transform ?? '');
  assert.ok(match, '워커가 자리를 잡았다');
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** 발끝에서 선택점까지. 마지막으로 물어본 점을 본다 */
function pickOffset(character) {
  const foot = footOf(character);
  const asked = queries.at(-1);
  assert.ok(asked, '워커가 선택점을 물었다');
  return { dx: foot.x - asked.x, dy: foot.y - asked.y };
}

const { createWalker } = await import('../js/ui/walker.js');
const { createScreenWalker, pointBelowRightEdge } = await import('../js/ui/screen-walker.js');
const { walkerHitPoint, DEFAULT_WALKER_HIT_ANCHOR } = await import('../js/ui/walker-geometry.js');
const { waitingRoomSeatPoint } = await import('../js/ui/waiting-room-seating.js');
const { createCharactersScreen } = await import('../js/ui/characters-screen.js');
const { createHomeScreen } = await import('../js/ui/home.js');
const { createArena } = await import('../js/ui/arena.js');
const { CHARACTERS } = await import('../js/characters.js');
const { CATEGORIES } = await import('../js/constants.js');

/** 화면 걷는 캐릭터(`.walker--home`, 40×48) */
function screenCharacter() {
  return Object.assign(new FakeElement('div'), { offsetWidth: 40, offsetHeight: 48 });
}

// ── 규칙 ──────────────────────────────────────────────────────────

test('선택점 규칙: 기본은 몸통 가운데(발끝에서 키의 절반 위), 퀴즈 무대의 발끝은 1px 위다', () => {
  assert.equal(DEFAULT_WALKER_HIT_ANCHOR, 'center');
  assert.deepEqual(walkerHitPoint({ x: 100, y: 300 }, { height: 48 }, 'center'), { x: 100, y: 276 });
  assert.deepEqual(walkerHitPoint({ x: 100, y: 300 }, { height: 42 }, 'center'), { x: 100, y: 279 });
  assert.deepEqual(walkerHitPoint({ x: 100, y: 300 }, { height: 42 }, 'foot'), { x: 100, y: 299 });
  // 아직 크기를 못 잰 캐릭터(0px)는 발끝과 같은 자리를 본다 — 엉뚱한 위쪽을 집지 않는다
  assert.deepEqual(walkerHitPoint({ x: 100, y: 300 }, { height: 0 }, 'center'), { x: 100, y: 300 });
});

// ── 화면마다 잰다 ─────────────────────────────────────────────────

test('직접 만든 워커는 선택점을 넘기지 않으면 몸통 가운데로 본다', () => {
  const character = screenCharacter();
  const walker = createWalker({ character, startAt: () => ({ x: 200, y: 400 }) });
  queries.length = 0;
  walker.setEnabled(true);
  runFrames();
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 24 });
  walker.setEnabled(false);
});

test('로비·대기실·결과·랭킹·«푼 문제»(screen walker): 몸이 다 덮은 44px 버튼을 발이 그 아래여도 고른다', () => {
  const character = screenCharacter();
  // 머리말 오른쪽의 버튼 하나 (9fc9779 의 실측). 발끝은 버튼 아래 끝에서 1.2px 아래다
  const header = new FakeElement('header').paint({ left: 12, top: 40, width: 1256, height: 72 });
  const leave = new FakeElement('button').paint({ left: 813, top: 52, width: 80, height: 47.594 });
  leave.parent = header;
  const walker = createScreenWalker({ screen: { hidden: false }, character, startPoint: () => ({ x: 600, y: 400 }) });
  walker.show('slime-blue');
  runFrames();

  queries.length = 0;
  walker.placeAt({ x: 853.044, y: 100.798 }, false);
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 24 });
  assert.equal(leave.classList.contains('is-standing'), true, '몸통 가운데가 버튼 안이다');
  // 발끝으로 보았다면 버튼 아래를 물었다 — 몸이 버튼을 다 덮었는데 아무것도 켜지지 않았다
  assert.equal(inside(leave.rect, 853.044, 100.798 - 1), false);

  // 몸 전체가 버튼 아래로 내려오면 놓는다 — 쉬는 자리는 버튼을 밟지 않는다
  walker.placeAt({ x: 853.044, y: leave.rect.bottom + 48 + 6 }, false);
  assert.equal(leave.classList.contains('is-standing'), false);
  walker.hide();
  header.hidden = true;
  leave.hidden = true;
});

test('로비의 시작 자리: 짧은 가로 touch 화면에서도 «방 만들기» 카드를 밟지 않는다 (발끝으로 보면 밟는다)', () => {
  // 740×360 의 실측: 머리말 아래 끝 79px, 동작 카드 「방 만들기」는 130px 부터. 시작 발끝은 133px 이다
  window.innerWidth = 740;
  window.innerHeight = 360;
  const character = screenCharacter();
  const header = new FakeElement('header').paint({ left: 17, top: 17, width: 706, height: 62 });
  const create = new FakeElement('button').paint({ left: 489, top: 130, width: 230, height: 56 });
  const walker = createScreenWalker({
    screen: { hidden: false },
    character,
    startPoint: () => pointBelowRightEdge(header, character),
  });
  queries.length = 0;
  walker.show('slime-blue');
  runFrames();

  assert.deepEqual(footOf(character), { x: 691, y: 133 }, '시작 자리는 그대로다');
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 24 });
  assert.equal(create.classList.contains('is-standing'), false, '들어오자마자 Enter 가 만들기 폼을 열지 않는다');
  assert.equal(inside(create.rect, 691, 133 - 1), true, '발끝으로 보았다면 카드 위였다');
  walker.hide();
  header.hidden = true;
  create.hidden = true;
  window.innerWidth = 1280;
  window.innerHeight = 900;
});

test('대기실 좌석: 앉은 의자는 아래쪽이 스틱 밑이어도 몸통 가운데로 켜진다 (발끝은 스틱에 든다)', () => {
  // 390×844 touch 의 실측: 왼쪽 의자 27–75 × 714–780, 스틱 16–112 × 732–828
  window.innerWidth = 390;
  window.innerHeight = 844;
  const character = screenCharacter();
  const chair = new FakeElement('button').paint({ left: 27, top: 714, width: 48, height: 66 });
  stick.paint({ left: 16, top: 732, width: 96, height: 96 });
  const walker = createScreenWalker({ screen: { hidden: false }, character, startPoint: () => ({ x: 52, y: 706 }) });
  walker.show('slime-blue');
  runFrames();

  const seat = waitingRoomSeatPoint(chair.getBoundingClientRect(), character.offsetHeight);
  queries.length = 0;
  walker.placeAt(seat, false);
  assert.deepEqual(footOf(character), { x: 51, y: 753 }, '좌석 자리는 그대로다');
  assert.equal(chair.classList.contains('is-standing'), true, '앉은 의자를 다시 고르면 일어선다 — 고를 수 있어야 한다');
  assert.equal(inside(stick.rect, 51, 753 - 1), true, '발끝으로 보았다면 조작부 위라 버렸다');
  walker.hide();
  chair.hidden = true;
  stick.hidden = true;
  window.innerWidth = 1280;
  window.innerHeight = 900;
});

test('내 캐릭터: 몸통 가운데로 보고, 들어오면 지금 입은 카드에 선다', () => {
  const stage = byId('character-stage');
  stage.parent = Object.assign(new FakeElement('section'), { dataset: { screen: 'characters' } });
  const character = byId('character-walker');
  const screen = createCharactersScreen({ onSelect() {}, onBack() {} });
  queries.length = 0;
  screen.show(CHARACTERS[0].id);
  // 카드는 112px 정사각에 가깝다. 시작 발끝은 카드 아래 끝에서 26px 위다
  byId('character-grid').children.forEach((card, index) => {
    card.paint({ left: 16 + (index % 3) * 124, top: 120 + Math.floor(index / 3) * 124, width: 112, height: 112 });
  });
  runFrames();

  const first = byId('character-grid').children[0];
  assert.deepEqual(footOf(character), { x: 72, y: 232 - 26 });
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 24 });
  assert.equal(first.classList.contains('is-standing'), true);
  screen.hide();
  byId('character-grid').children.forEach((card) => { card.hidden = true; });
});

test('홈: 몸통 가운데로 본다 — 시작 자리는 그대로 「내 캐릭터」 입구 바로 아래 빈 바닥이다', () => {
  const stage = byId('home-stage');
  stage.parent = Object.assign(new FakeElement('section'), { dataset: { screen: 'home' } });
  byId('home-note').hidden = true;
  byId('nickname-dialog').hidden = true;
  const entry = byId('open-characters').paint({ left: 16, top: 120, width: 120, height: 44 });
  const character = byId('home-character');
  const home = createHomeScreen({
    onSelectCategory() {}, onStartAll() {}, onOpenRanking() {}, onOpenCharacters() {}, onOpenOnline() {},
    onReturnToRoom() {}, onNickname() {}, onReload() {},
  });
  const question = (id, category) => ({
    id, category, question: `${id}?`, choices: ['가', '나', '다', '라'], answerIndex: 0, explanation: '', difficulty: 'easy', tags: [],
  });
  queries.length = 0;
  home.render({
    categories: CATEGORIES,
    banks: Object.fromEntries(CATEGORIES.map(({ id }) => [id, [question(`${id}-1`, id)]])),
    bestScores: {},
    allCount: 25,
    characterId: 'slime-blue',
    nickname: '퀴즈왕',
  });
  runFrames();

  assert.deepEqual(footOf(character), { x: 76, y: 164 + 48 + 6 });
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 24 });
  assert.equal(entry.classList.contains('is-standing'), false, '시작부터 입구를 밟지 않는다');
  home.hide();
  entry.hidden = true;
});

test('퀴즈 무대만 발끝으로 본다 — 십자 틈에 선 발은 아무 칸도 아니고, 몸통 가운데였다면 위 칸이 켜졌다', () => {
  window.innerWidth = 390;
  window.innerHeight = 844;
  const character = Object.assign(byId('arena-character'), { offsetWidth: 34, offsetHeight: 42 });
  const arena = createArena({
    onChoose() {},
    getChoiceNodes: () => [],
    trapFocus() {},
  });
  arena.setEnabled(true);
  arena.reset(4);
  // 390×844 의 실측: 칸 사이 틈 12px
  const grid = byId('arena-tiles').paint({ left: 32, top: 534, width: 326, height: 181 });
  const boxes = [
    { left: 32, top: 534, width: 157, height: 85 },
    { left: 201, top: 534, width: 157, height: 85 },
    { left: 32, top: 631, width: 157, height: 84 },
    { left: 201, top: 631, width: 157, height: 84 },
  ];
  grid.children.forEach((tile, index) => tile.paint(boxes[index]));
  queries.length = 0;
  runFrames();

  // 십자 한가운데(중립)에서 시작한다. 발끝 바로 위는 틈이다
  assert.deepEqual(footOf(character), { x: 195, y: 624.5 });
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 1 });
  assert.equal(arena.standingIndex(), null);

  // 실제로 한 걸음 움직여야 발밑 칸이 답이 된다 (movedSinceReset)
  arena.handleKey(key('ArrowRight'));
  runFrames(2);
  releaseKey('ArrowRight');
  runFrames();

  // 오른쪽으로 걸어 발이 가로 틈(619–631)에 남았다 — 아무 칸도 아니다
  arena.restoreCharacterAnchor({ x: 244 - 32, y: 625 - 534 });
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 1 });
  assert.equal(arena.standingIndex(), null, '틈에 서 있으면 시간이 끝나도 시간 초과다');
  const centre = walkerHitPoint({ x: 244, y: 625 }, { height: 42 }, 'center');
  assert.equal(inside(grid.children[1].rect, centre.x, centre.y), true, '몸통 가운데로 보았다면 위 2번 칸이 켜졌다');

  // 발이 아래 칸에 들어서는 순간 그 칸이다
  arena.restoreCharacterAnchor({ x: 244 - 32, y: 632 - 534 });
  assert.equal(arena.standingIndex(), 3);
  assert.equal(grid.children[3].classList.contains('is-standing'), true);
  arena.setEnabled(false);
  window.innerWidth = 1280;
  window.innerHeight = 900;
});

// ── 걷는 화면의 표 ────────────────────────────────────────────────

/**
 * 워커를 만드는 모든 화면과 그 선택점. 화면을 더하면 여기에 적는다 — 표에 없는 워커는 막는다.
 * `factory`는 그 파일이 부르는 것, `anchor`는 그 화면의 선택점이다.
 */
const WALKER_SCREENS = {
  'src/ui/arena.ts': { factory: 'createWalker', anchor: 'foot' }, // 로컬 퀴즈(quiz.ts)·온라인 퀴즈(app.ts 가 넘긴다)
  'src/ui/home.ts': { factory: 'createWalker', anchor: 'center' },
  'src/ui/characters-screen.ts': { factory: 'createWalker', anchor: 'center' },
  'src/ui/screen-walker.ts': { factory: 'createWalker', anchor: 'center' },
  'src/ui/online.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/waiting-room.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/result.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/ranking.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/quiz-review.ts': { factory: 'createScreenWalker', anchor: 'center' },
};

/** `name({` 로 시작하는 호출의 인자 객체(짝 맞는 중괄호까지)를 모두 꺼낸다. 함수 정의는 호출이 아니다 */
function callArguments(text, name) {
  const found = [];
  const pattern = new RegExp(`(?<!function )\\b${name}\\(\\{`, 'g');
  for (const match of text.matchAll(pattern)) {
    let depth = 0;
    const start = match.index + match[0].length - 1;
    for (let at = start; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1;
      if (text[at] === '}') depth -= 1;
      if (depth === 0) {
        found.push(text.slice(start, at + 1));
        break;
      }
    }
  }
  return found;
}

async function sourceFiles(dir) {
  const entries = await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

test('걷는 화면의 표: 모든 워커가 표에 있고, 선택점을 넘기는 곳은 퀴즈 무대의 발끝 하나다', async () => {
  const files = await sourceFiles('src');
  const makers = [];
  for (const path of files) {
    const text = await source(path);
    for (const factory of ['createWalker', 'createScreenWalker']) {
      for (const args of callArguments(text, factory)) makers.push({ path, factory, args });
    }
  }
  assert.deepEqual(
    [...new Set(makers.map(({ path }) => path))].sort(),
    Object.keys(WALKER_SCREENS).sort(),
    '워커를 만드는 화면이 표와 같다 — 새 화면은 선택점을 정해 표에 적는다',
  );
  for (const { path, factory, args } of makers) {
    const expected = WALKER_SCREENS[path];
    assert.equal(factory, expected.factory, `${path}: ${expected.factory} 로 만든다`);
    const passed = /hitAnchor:\s*'(\w+)'/.exec(args)?.[1] ?? null;
    if (expected.anchor === DEFAULT_WALKER_HIT_ANCHOR) {
      assert.equal(passed, null, `${path}: 기본 선택점을 쓴다 — 화면이 따로 고르지 않는다`);
    } else {
      assert.equal(passed, expected.anchor, `${path}: ${expected.anchor} 를 넘긴다`);
    }
  }
  // 두 퀴즈 화면은 같은 무대를 쓴다
  assert.match(await source('src/ui/quiz.ts'), /createArena\(\{/);
  assert.match(await source('src/app.ts'), /createCharacterArena:\s*createArena/);
  assert.match(await source('src/ui/walker.ts'), /hitAnchor\s*=\s*DEFAULT_WALKER_HIT_ANCHOR/);
});
