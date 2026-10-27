import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';

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
/** 창에 단 리스너. resize 로 워커의 relayout 을 부른다 */
const windowListeners = new Map();
globalThis.window = {
  innerWidth: 1280, innerHeight: 900, scrollY: 0,
  addEventListener(type, listener) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
  },
  removeEventListener() {}, scrollBy() {}, scrollTo() {},
};

function dispatchWindow(type) {
  for (const listener of windowListeners.get(type) ?? []) listener({});
}
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

/** 내 캐릭터 화면은 하나만 만든다 — 만들 때마다 문서에 keydown 리스너가 하나씩 붙는다 */
const charactersSelected = [];
let charactersScreen = null;
function openCharacters(selectedId, cardTop) {
  if (!charactersScreen) {
    const stage = byId('character-stage');
    stage.parent = Object.assign(new FakeElement('section'), { dataset: { screen: 'characters' } });
    charactersScreen = createCharactersScreen({ onSelect: (id) => charactersSelected.push(id), onBack() {} });
  }
  charactersSelected.length = 0;
  queries.length = 0;
  charactersScreen.show(selectedId);
  // 카드는 112px 정사각에 가깝고 세 줄로 놓인다. 시작 발끝은 카드 아래 끝에서 26px 위다
  const cards = byId('character-grid').children;
  cards.forEach((card, index) => {
    card.paint({ left: 16 + (index % 3) * 124, top: cardTop + Math.floor(index / 3) * 124, width: 112, height: 112 });
  });
  runFrames();
  return cards;
}

function closeCharacters() {
  charactersScreen.hide();
  byId('character-grid').children.forEach((card) => { card.hidden = true; });
}

/** 문서가 받은 keydown 을 화면들의 리스너에 넘긴다 (내 캐릭터 화면은 제 리스너로 워커에 넘긴다) */
function pressKey(name) {
  for (const listener of documentListeners.get('keydown') ?? []) listener(key(name));
}

test('내 캐릭터: 몸통 가운데로 보고, 지금 입은 카드가 화면 안이면 들어오자마자 그 카드에 선다', () => {
  const character = byId('character-walker');
  const cards = openCharacters(CHARACTERS[0].id, 120);

  assert.deepEqual(footOf(character), { x: 72, y: 232 - 26 });
  assert.deepEqual(pickOffset(character), { dx: 0, dy: 24 });
  assert.equal(cards[0].classList.contains('is-standing'), true);
  assert.deepEqual(charactersSelected, []);
  closeCharacters();
});

test('내 캐릭터: 지금 입은 카드가 접힘 아래면 clamp된 자리가 다른 카드를 밟아도 걷기 전에는 입히지 않는다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 568×320 의 실측: 카드 줄 162–274 · 286–398 · 410–522 · 534–646, 화면 높이 320. 일곱째 카드(셋째 줄)를 입고 있다
  window.innerWidth = 568;
  window.innerHeight = 320;
  const character = byId('character-walker');
  const current = CHARACTERS[6].id;
  const cards = openCharacters(current, 162);

  // 시작 발끝(카드 아래 끝 522 − 26)은 화면 밖이라 아래 끝 7px 안으로 clamp된다 — 선택점은 위 줄의 넷째 카드다
  assert.deepEqual(footOf(character), { x: 72, y: 320 - 7 });
  assert.equal(cards[3].classList.contains('is-standing'), true, '선택점 아래 카드에는 불이 켜진다');
  t.mock.timers.tick(1000);
  assert.deepEqual(charactersSelected, [], '화면을 열기만 해서는 캐릭터가 바뀌지도 저장되지도 않는다');
  assert.equal(cards[6].getAttribute('aria-pressed'), 'true', '지금 입은 카드가 그대로 눌린 카드다');
  assert.equal(cards[3].getAttribute('aria-pressed'), 'false');

  // 화면 크기가 바뀌어 다시 세워도(relayout) 고른 것이 아니다
  dispatchWindow('resize');
  t.mock.timers.tick(1000);
  assert.deepEqual(charactersSelected, []);

  // 실제로 한 걸음 걷고 멈추면 그때는 발밑의 카드를 입힌다 — 문은 닫힌 것이 아니라 걷기를 기다린다
  pressKey('ArrowUp');
  runFrames(2);
  releaseKey('ArrowUp');
  runFrames();
  assert.deepEqual(charactersSelected, [CHARACTERS[3].id]);
  assert.equal(cards[3].getAttribute('aria-pressed'), 'true');

  closeCharacters();
  window.innerWidth = 1280;
  window.innerHeight = 900;
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
  'src/ui/home.ts': { factory: 'createWalker', anchor: 'center' }, // 무대와 다르다 — 「게임 방법」이 그 차이를 말한다 (맨 아래)
  'src/ui/characters-screen.ts': { factory: 'createWalker', anchor: 'center' },
  'src/ui/screen-walker.ts': { factory: 'createWalker', anchor: 'center' },
  'src/ui/online.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/waiting-room.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/result.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/ranking.ts': { factory: 'createScreenWalker', anchor: 'center' },
  'src/ui/quiz-review.ts': { factory: 'createScreenWalker', anchor: 'center' },
};

/** 워커를 만드는 함수. 이 이름이 코드에 나오는 자리는 아래가 하나도 빼지 않고 가려 본다 */
const FACTORIES = new Set(['createWalker', 'createScreenWalker']);
/** 그 함수를 내보내는 모듈 */
const FACTORY_MODULE = /(^|\/)(screen-)?walker\.js$/;

/**
 * 한 파일에서 워커를 만드는 곳(`makers`)과 선택점을 읽을 수 없는 자리(`problems`)를 찾는다.
 *
 * 글자 맞추기가 아니라 TypeScript 구문 나무로 본다. 한때 `createWalker({` 글자만 찾아, 설정을 변수에 담아 넘기거나
 * (`createWalker(config)`) 펼치거나 선택점을 변수로 주면 표에 없는 워커가 그대로 지나갔다. 이제 두 함수의 이름이
 * 나오는 자리를 모두 본다 — 정의·들여오기·`typeof`·객체 키는 그냥 두고, 부르는 곳은 설정을 읽고, 나머지(값으로
 * 넘기기·이름 바꿔 들여오기·다시 내보내기·모듈째 들여오기·`import()`·`['createWalker']`)는 문제로 적는다.
 * **읽을 수 없으면 통과시키지 않는다** — 선택점은 부르는 자리에서 글자로 보여야 한다.
 */
function walkerMakers(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const makers = [];
  const problems = [];
  const at = (node) => `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;

  function readCall(call, factory) {
    const [config, ...rest] = call.arguments;
    if (!config || !ts.isObjectLiteralExpression(config) || rest.length > 0) {
      problems.push(`${at(call)} ${factory}의 설정은 그 자리의 객체 하나로 적는다 — 변수로 넘기면 선택점이 보이지 않는다`);
      return;
    }
    let anchor = null;
    for (const property of config.properties) {
      if (ts.isSpreadAssignment(property)) {
        problems.push(`${at(property)} ${factory}의 설정을 펼치지 않는다 — 펼친 것에 hitAnchor 가 숨는다`);
        continue;
      }
      const { name } = property;
      if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))) {
        problems.push(`${at(property)} ${factory}의 설정 이름을 계산하지 않는다`);
        continue;
      }
      if (name.text !== 'hitAnchor') continue;
      if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) {
        anchor = property.initializer.text;
      } else {
        problems.push(`${at(property)} hitAnchor 는 글자('foot')로 적는다 — 변수로 주면 선택점이 보이지 않는다`);
      }
    }
    makers.push({ path, factory, anchor });
  }

  /** 두 함수의 이름 하나가 나온 자리를 가린다 */
  function classify(node) {
    const factory = node.text;
    const { parent } = node;
    // 정의와 타입 자리는 워커를 만들지 않는다
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return;
    if (ts.isTypeQueryNode(parent)) return;
    if (ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) {
      const imported = parent.propertyName?.text ?? parent.name.text;
      if (imported !== parent.name.text) problems.push(`${at(node)} ${factory}를 다른 이름으로 들여오지 않는다`);
      return;
    }
    if (ts.isExportSpecifier(parent)) {
      problems.push(`${at(node)} ${factory}를 다시 내보내지 않는다 — 부르는 곳의 이름이 달라진다`);
      return;
    }
    if (ts.isCallExpression(parent) && parent.expression === node) {
      readCall(parent, factory);
      return;
    }
    // `walkers.createWalker({ … })`
    if (ts.isPropertyAccessExpression(parent) && parent.name === node
      && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      readCall(parent.parent, factory);
      return;
    }
    // 객체 키·인터페이스 멤버의 이름은 워커가 아니다. 그 밖에 값으로 쓰면 그 값을 부르는 곳이 보이지 않는다
    const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)
      || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
    if (!isKey) problems.push(`${at(node)} ${factory}를 값으로 넘기지 않는다 — 부르는 자리에서 선택점이 보여야 한다`);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && FACTORY_MODULE.test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        problems.push(`${at(node)} 워커 모듈을 통째로 들여오지 않는다 — 이름으로 들여온다`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (!specifier || !ts.isStringLiteralLike(specifier) || FACTORY_MODULE.test(specifier.text)) {
        problems.push(`${at(node)} 워커 모듈을 import() 로 들여오지 않는다`);
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      && FACTORIES.has(node.argumentExpression.text)) {
      problems.push(`${at(node)} ${node.argumentExpression.text}를 글자 열쇠로 꺼내지 않는다`);
    }
    if (ts.isIdentifier(node) && FACTORIES.has(node.text)) classify(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { makers, problems };
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

test('걷는 화면의 표: 설정을 변수로 넘기거나 펼치거나 이름을 바꿔도 찾는다 (읽지 못하면 막는다)', () => {
  const probe = (text) => walkerMakers('src/ui/zz-probe.ts', `import { createWalker } from './walker.js';\n${text}`);
  // 글자 맞추기 때 그대로 지나갔던 모양 (리뷰의 재현): 설정을 변수에 담아 넘긴다
  const passedByName = probe(`const config = { character: document.body, hitAnchor: 'foot' };
export const probe = () => createWalker(config);`);
  assert.equal(passedByName.problems.length, 1, passedByName.problems.join('\n'));
  assert.deepEqual(passedByName.makers, []);
  for (const text of [
    'createWalker({ ...base, character });',
    'createWalker({ character, hitAnchor });',
    'createWalker({ character, hitAnchor: anchor });',
    "createWalker({ character, ['hitAnchor']: 'foot' });",
    'const make = createWalker; make({ character });',
    "createWalker.call(null, { character, hitAnchor: 'foot' });",
  ]) {
    assert.ok(probe(text).problems.length > 0, text);
  }
  for (const text of [
    "import { createWalker as make } from './walker.js'; make({ character });",
    "import * as walkers from './walker.js'; walkers['createWalker']({ character });",
    "export { createScreenWalker as screenWalker } from './screen-walker.js';",
    "const { createWalker: make } = await import('./walker.js');",
  ]) {
    assert.ok(walkerMakers('src/ui/zz-probe.ts', text).problems.length > 0, text);
  }
  // 읽을 수 있는 모양은 문제가 아니라 표에 올릴 워커다 — 표에 없으면 아래 테스트가 막는다
  assert.deepEqual(probe("createWalker({ character, hitAnchor: 'foot' });"), {
    makers: [{ path: 'src/ui/zz-probe.ts', factory: 'createWalker', anchor: 'foot' }],
    problems: [],
  });
  // 주석과 글자 속의 이름은 워커가 아니다
  assert.deepEqual(probe("// createWalker(config)\nconst text = 'createWalker(config)';"), { makers: [], problems: [] });
});

test('걷는 화면의 표: 모든 워커가 표에 있고, 선택점을 넘기는 곳은 퀴즈 무대의 발끝 하나다', async () => {
  const files = await sourceFiles('src');
  const makers = [];
  const problems = [];
  for (const path of files) {
    const found = walkerMakers(path, await source(path));
    makers.push(...found.makers);
    problems.push(...found.problems);
  }
  assert.deepEqual(problems, [], '선택점을 읽을 수 없는 워커가 없다');
  assert.deepEqual(
    [...new Set(makers.map(({ path }) => path))].sort(),
    Object.keys(WALKER_SCREENS).sort(),
    '워커를 만드는 화면이 표와 같다 — 새 화면은 선택점을 정해 표에 적는다',
  );
  for (const { path, factory, anchor } of makers) {
    const expected = WALKER_SCREENS[path];
    assert.equal(factory, expected.factory, `${path}: ${expected.factory} 로 만든다`);
    if (expected.anchor === DEFAULT_WALKER_HIT_ANCHOR) {
      assert.equal(anchor, null, `${path}: 기본 선택점을 쓴다 — 화면이 따로 고르지 않는다`);
    } else {
      assert.equal(anchor, expected.anchor, `${path}: ${expected.anchor} 를 넘긴다`);
    }
  }
  // 두 퀴즈 화면은 같은 무대를 쓴다
  assert.match(await source('src/ui/quiz.ts'), /createArena\(\{/);
  assert.match(await source('src/app.ts'), /createCharacterArena:\s*createArena/);
  assert.match(await source('src/ui/walker.ts'), /hitAnchor\s*=\s*DEFAULT_WALKER_HIT_ANCHOR/);
});

test('「게임 방법」의 움직이기: 홈은 몸통 가운데라 «홈에서 미리»는 걷기만 말하고, 바닥 칸의 발끝 규칙을 따로 말한다', async () => {
  // 홈을 무대의 연습장처럼 말하면, 홈에서 «몸이 덮으면 켜진다»를 배운 사람이 바닥에서는 발을 틈에 둔 채
  // 위 칸을 덮고 기다리다 시간 초과가 된다. 표의 두 선택점이 다른 동안 이 줄이 바닥의 규칙을 말해야 한다
  assert.equal(WALKER_SCREENS['src/ui/home.ts'].anchor, 'center');
  assert.equal(WALKER_SCREENS['src/ui/arena.ts'].anchor, 'foot');
  const html = await source('index.html');
  const dialog = html.slice(html.indexOf('id="rules-dialog"'), html.indexOf('id="rules-close"'));
  const moving = /<dt>움직이기<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(dialog)?.[1];
  assert.ok(moving, '「게임 방법」에 움직이기 줄이 있다');
  const text = moving.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.match(text, /불이 켜진 칸이나 버튼을 눌러요/, '어느 화면에서나 맞는 말 — 불이 켜진 것이 눌린다');
  assert.match(text, /바닥 칸은 몸이 덮어도 발이 닿아야 불이 켜져요/, '바닥 칸만 발끝이다');
  assert.match(text, /걷기는 홈에서 미리 해 볼 수 있어요/, '홈에서 연습하는 것은 걷기다');
  assert.doesNotMatch(text, /발밑을 눌러요/, '홈은 발끝으로 고르지 않는다');
});
