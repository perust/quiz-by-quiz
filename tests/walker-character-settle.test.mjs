import test from 'node:test';
import assert from 'node:assert/strict';

// 내 캐릭터 화면: 걸어가는 길에 스쳐 지나간 카드는 입히지 않는다.
// 같은 카드에 잠깐 머물거나 멈춰 서야 그 캐릭터가 되고, 직접 누르면 곧바로 입고 돌아간다.
// 모듈은 불러오는 순간 document·window 에 리스너를 단다. 그 전에 필요한 만큼만 흉내 낸다.

const PICKABLE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT']);

class FakeHTMLElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
      contains: (name) => classes.has(name),
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click() {
    for (const listener of this.listeners.get('click') ?? []) listener({});
  }

  closest() {
    return PICKABLE_TAGS.has(this.tagName) ? this : null;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  querySelector() {
    return null;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  remove() {}

  blur() {}

  contains() {
    return false;
  }
}

const documentListeners = new Map();
const windowListeners = new Map();
const frames = [];
const screen = { hidden: false };
const elements = new Map([
  ['character-stage', Object.assign(new FakeHTMLElement('div'), { closest: () => screen })],
  ['character-grid', new FakeHTMLElement('div')],
  ['character-walker', new FakeHTMLElement('div')],
  ['characters-back', new FakeHTMLElement('button')],
]);
/** 지금 캐릭터 발밑에 있는 것 */
let underfoot = null;

globalThis.HTMLElement = FakeHTMLElement;
globalThis.window = {
  innerWidth: 390,
  innerHeight: 844,
  scrollY: 0,
  addEventListener(type, listener) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
  },
  scrollBy() {},
};
globalThis.document = {
  body: new FakeHTMLElement('body'),
  activeElement: null,
  getElementById: (id) => elements.get(id) ?? null,
  querySelector: () => null,
  createElement: (tag) => new FakeHTMLElement(tag),
  addEventListener(type, listener) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
  },
  elementFromPoint: () => underfoot,
};
document.activeElement = document.body;
globalThis.requestAnimationFrame = (callback) => frames.push(callback);
globalThis.cancelAnimationFrame = () => {};

const { CHARACTERS } = await import('../js/characters.js');
const { createCharactersScreen } = await import('../js/ui/characters-screen.js');

const selected = [];
let backs = 0;
const charactersScreen = createCharactersScreen({
  onSelect: (id) => selected.push(id),
  onBack: () => { backs += 1; },
});
const grid = elements.get('character-grid');
const back = elements.get('characters-back');

function runFrames(limit = 12) {
  for (let i = 0; i < limit && frames.length; i += 1) frames.shift()(performance.now());
}

function emit(target, type, event) {
  for (const listener of target.get(type) ?? []) listener(event);
}

/** 사용자가 스스로 스크롤했을 때처럼 발밑이 바뀐다. 루프가 멈춰 있어도 워커가 다시 본다 */
function stepOnto(node) {
  underfoot = node;
  emit(windowListeners, 'scroll', {});
}

function keydown(key) {
  const event = { key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} };
  emit(documentListeners, 'keydown', event);
}

function enter(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  selected.length = 0;
  backs = 0;
  charactersScreen.show(CHARACTERS[0].id);
  const cards = grid.children;
  cards[0].rect = { left: 0, top: 0, right: 100, bottom: 120, width: 100, height: 120 };
  underfoot = cards[0];
  runFrames();
  return cards;
}

test('걸어가는 길에 스쳐 지나간 카드는 입히지도 저장하지도 않는다', (t) => {
  const cards = enter(t);
  assert.equal(selected.length, 0, '처음 선 자리는 지금 쓰는 캐릭터다');

  stepOnto(cards[1]);
  t.mock.timers.tick(120);
  stepOnto(cards[2]);
  t.mock.timers.tick(120);
  stepOnto(back);
  t.mock.timers.tick(1000);
  assert.deepEqual(selected, [], '「홈」까지 걸어 나가는 동안 캐릭터가 바뀌지 않는다');
  charactersScreen.hide();
});

test('같은 카드에 잠깐 머물면 그 자리에서 바뀐다', (t) => {
  const cards = enter(t);
  stepOnto(cards[3]);
  t.mock.timers.tick(249);
  assert.deepEqual(selected, []);
  t.mock.timers.tick(1);
  assert.deepEqual(selected, [CHARACTERS[3].id]);
  assert.equal(cards[3].attributes['aria-pressed'], 'true');
  assert.equal(backs, 0, '밟아서 바꾸는 것은 미리보기라 화면에 머문다');
  charactersScreen.hide();
});

test('멈춰 서면 기다리지 않고 발밑의 카드를 입힌다', (t) => {
  const cards = enter(t);
  underfoot = cards[4];
  keydown('ArrowDown');
  runFrames(1);
  assert.deepEqual(selected, [], '걷는 중에는 아직이다');
  emit(documentListeners, 'keyup', { key: 'ArrowDown' });
  runFrames();
  assert.deepEqual(selected, [CHARACTERS[4].id]);
  charactersScreen.hide();
});

test('화면을 떠나면 기다리던 카드는 버린다', (t) => {
  const cards = enter(t);
  stepOnto(cards[5]);
  charactersScreen.hide();
  t.mock.timers.tick(1000);
  assert.deepEqual(selected, []);
});

test('카드를 직접 누르거나 걸어가 Enter로 고르면 곧바로 입고 돌아간다', (t) => {
  const cards = enter(t);
  cards[6].click();
  assert.deepEqual(selected, [CHARACTERS[6].id]);
  assert.equal(backs, 1);
  t.mock.timers.tick(1000);
  assert.deepEqual(selected, [CHARACTERS[6].id], '기다리던 것이 뒤늦게 덮어쓰지 않는다');

  // 이름은 화면에 그리지 않고 스크린리더에만 알린다
  assert.equal(cards[6].attributes['aria-label'], CHARACTERS[6].name);
  assert.equal(cards[6].textContent ?? '', '');
  charactersScreen.hide();
});
