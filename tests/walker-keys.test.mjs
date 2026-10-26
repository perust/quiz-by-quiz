import test from 'node:test';
import assert from 'node:assert/strict';

// 워커가 어떤 키를 가져가고 어떤 키를 브라우저에 남기는지 (CLAUDE.md «키를 누가 갖는가»).
// 모듈은 불러오는 순간 document·window 에 리스너를 단다. 그 전에 필요한 만큼만 흉내 낸다.
// 각 테스트 파일은 따로 된 프로세스에서 돌아 다른 테스트로 새지 않는다.

const PICKABLE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT']);

class FakeHTMLElement {
  constructor(tag = 'div', props = {}) {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.clicks = 0;
    this.blurred = 0;
    this.listeners = new Map();
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
    Object.assign(this, props);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click() {
    this.clicks += 1;
  }

  focus() {
    document.activeElement = this;
  }

  blur() {
    this.blurred += 1;
    if (document.activeElement === this) document.activeElement = document.body;
  }

  /** 워커의 `pickable` 선택자를 흉내 낸다. 버튼·입력칸이면 자기 자신이다 */
  closest() {
    return PICKABLE_TAGS.has(this.tagName) ? this : null;
  }

  contains() {
    return false;
  }
}

const documentListeners = new Map();
const frames = [];
const body = new FakeHTMLElement('body');
const controlsRoot = new FakeHTMLElement('div');
/** 지금 캐릭터 선택점 아래에 있는 것 */
let underfoot = new FakeHTMLElement('div');

globalThis.HTMLElement = FakeHTMLElement;
globalThis.window = { innerWidth: 390, innerHeight: 844, scrollY: 0, addEventListener() {}, scrollBy() {} };
globalThis.document = {
  body,
  activeElement: body,
  getElementById: (id) => (id === 'walk-controls' ? controlsRoot : null),
  // 열린 다이얼로그는 없다
  querySelector: () => null,
  addEventListener(type, listener) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
  },
  elementFromPoint: () => underfoot,
};
globalThis.requestAnimationFrame = (callback) => frames.push(callback);
globalThis.cancelAnimationFrame = () => {};

const { createWalker } = await import('../js/ui/walker.js');

function runFrames(limit = 12) {
  for (let i = 0; i < limit && frames.length; i += 1) frames.shift()(performance.now());
}

function emit(type, event) {
  for (const listener of documentListeners.get(type) ?? []) listener(event);
}

function key(name, options = {}) {
  return { key: name, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...options };
}

/** 키를 눌렀다 뗀다. 뗀 것을 알려야 «눌린 방향키»가 남지 않는다 */
function press(walker, name, options) {
  const handled = walker.handleKey(key(name, options));
  emit('keyup', { key: name });
  runFrames();
  return handled;
}

function stand(walker, element) {
  underfoot = element;
  walker.refresh();
}

const walker = createWalker({ character: new FakeHTMLElement('div') });
walker.setEnabled(true);
runFrames();

test('발밑이 비면 Space·Enter는 브라우저 몫이다 — 빈자리의 Space는 페이지를 내린다', () => {
  stand(walker, new FakeHTMLElement('div'));
  assert.equal(walker.standingElement(), null);
  assert.equal(controlsRoot.dataset.armed, 'false', '누를 것이 없으면 선택 버튼이 흐려진다');
  assert.equal(press(walker, ' '), false);
  assert.equal(press(walker, 'Enter'), false);
  assert.equal(press(walker, ' ', { repeat: true }), false, '빈자리에서 길게 누른 Space는 계속 내린다');
});

test('발밑의 버튼은 누른 만큼만 고른다 — 길게 눌러 되풀이되는 keydown은 삼키기만 한다', () => {
  const button = new FakeHTMLElement('button');
  stand(walker, button);
  assert.equal(walker.standingElement(), button);
  assert.equal(controlsRoot.dataset.armed, 'true');

  assert.equal(press(walker, ' '), true);
  assert.equal(button.clicks, 1);
  assert.equal(press(walker, ' ', { repeat: true }), true, '되풀이된 Space가 그사이 페이지를 내리지 않는다');
  assert.equal(press(walker, 'Enter', { repeat: true }), true);
  assert.equal(button.clicks, 1, '키를 누르고 있어도 한 번만 누른다');
  assert.equal(press(walker, 'Enter'), true);
  assert.equal(button.clicks, 2);
});

test('Ctrl·Meta·Alt 조합은 걷기 키와 같아도 브라우저 단축키로 남긴다', () => {
  const button = new FakeHTMLElement('button');
  stand(walker, button);
  frames.length = 0;

  assert.equal(press(walker, 's', { ctrlKey: true }), false, 'Ctrl+S(저장)의 s로 걷지 않는다');
  assert.equal(walker.handleKey(key('ArrowLeft', { altKey: true })), false, 'Alt+←(뒤로 가기)');
  assert.equal(frames.length, 0, '단축키로는 이동 루프가 깨지 않는다');
  emit('keyup', { key: 'ArrowLeft' });
  assert.equal(press(walker, 'Enter', { metaKey: true }), false);
  assert.equal(press(walker, ' ', { ctrlKey: true }), false);
  assert.equal(button.clicks, 0, '단축키가 발밑을 누르지 않는다');
});

test('방향키는 여전히 걷기이고, 다이얼로그가 돌려준 포커스를 놓는다 (#67)', () => {
  stand(walker, new FakeHTMLElement('div'));
  const opener = new FakeHTMLElement('button');
  opener.focus();
  assert.equal(walker.handleKey(key('ArrowDown')), true);
  assert.equal(opener.blurred, 1);
  assert.equal(document.activeElement, body);
  emit('keyup', { key: 'ArrowDown' });
  runFrames();
});

test('WASD도 방향키처럼 걷고, 조작법과 무대 안내가 그렇게 말한다 (U52)', async () => {
  stand(walker, new FakeHTMLElement('div'));
  for (const name of ['w', 'a', 's', 'd', 'W', 'A', 'S', 'D']) {
    assert.equal(walker.handleKey(key(name)), true, `${name} 로 걷는다`);
    emit('keyup', { key: name });
  }
  runFrames();

  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['help-dialog', 'online-help-dialog']) {
    const start = html.indexOf(`id="${id}"`);
    const dialog = html.slice(start, html.indexOf('</dl>', start));
    assert.match(
      dialog,
      /<kbd>←<\/kbd> <kbd>↑<\/kbd> <kbd>→<\/kbd> <kbd>↓<\/kbd> 또는 <kbd>W<\/kbd> <kbd>A<\/kbd> <kbd>S<\/kbd> <kbd>D<\/kbd>/,
      `#${id} 의 «움직이기»가 WASD를 함께 말한다`,
    );
  }
  const hints = [...html.matchAll(/<span class="arena__hint-key">([^<]*)<\/span>/g)].map(([, text]) => text);
  assert.equal(hints.length, 2, '로컬·온라인 무대의 키보드 안내');
  for (const text of hints) assert.match(text, /방향키·WASD/);
});

test('제 키를 스스로 쓰는 것에 포커스가 있으면 발밑에 버튼이 있어도 비켜난다 (#58)', () => {
  const button = new FakeHTMLElement('button');
  stand(walker, button);
  const checkbox = new FakeHTMLElement('input', { type: 'checkbox' });
  checkbox.focus();
  assert.equal(press(walker, ' '), false, '체크박스의 Space는 체크박스 것이다');
  assert.equal(button.clicks, 0);
  checkbox.blur();
});

test('글자를 적는 동안에는 조작부를 거두고, 칸을 벗어나면 다시 보인다', () => {
  const input = new FakeHTMLElement('input', { type: 'text' });
  input.focus();
  emit('focusin', { target: input });
  assert.equal(controlsRoot.dataset.typing, 'true');
  assert.equal(controlsRoot.classList.contains('walk-controls--on'), true, '화면의 켜짐 상태는 그대로다');

  // 같은 칸에서는 방향키가 커서 것이다
  assert.equal(walker.handleKey(key('ArrowLeft')), false);
  emit('keyup', { key: 'ArrowLeft' });

  input.blur();
  emit('focusout', { target: input, relatedTarget: null });
  assert.equal('typing' in controlsRoot.dataset, false);

  // 체크박스처럼 누르는 input은 «적는 칸»이 아니라 조작부를 거두지 않는다
  const checkbox = new FakeHTMLElement('input', { type: 'checkbox' });
  checkbox.focus();
  emit('focusin', { target: checkbox });
  assert.equal('typing' in controlsRoot.dataset, false);
  checkbox.blur();
  emit('focusout', { target: checkbox, relatedTarget: null });
});

test('밟은 입력칸을 고르면 커서가 들어가고 그 순간 조작부가 숨는다', () => {
  const input = new FakeHTMLElement('input', { type: 'text' });
  stand(walker, input);
  assert.equal(controlsRoot.dataset.armed, 'true');
  walker.confirm();
  assert.equal(document.activeElement, input);
  assert.equal(input.clicks, 0, '적는 칸은 누르지 않고 들어간다');
  assert.equal(controlsRoot.dataset.typing, 'true');
  input.blur();
  emit('focusout', { target: input, relatedTarget: null });
  assert.equal('typing' in controlsRoot.dataset, false);
});

test('화면이 아직 고를 수 없다고 하면(canPick) 흐리게 두고 Enter도 넘긴다', () => {
  let open = false;
  const button = new FakeHTMLElement('button');
  const gated = createWalker({ character: new FakeHTMLElement('div'), canPick: () => open });
  underfoot = button;
  gated.setEnabled(true);
  assert.equal(controlsRoot.dataset.armed, 'false', '켜자마자는 아직 서지 않았다');
  runFrames();
  assert.equal(gated.standingElement(), button);
  assert.equal(controlsRoot.dataset.armed, 'false');
  assert.equal(press(gated, 'Enter'), false);
  assert.equal(button.clicks, 0);

  open = true;
  gated.refresh();
  assert.equal(controlsRoot.dataset.armed, 'true');
  assert.equal(press(gated, 'Enter'), true);
  assert.equal(button.clicks, 1);

  // 잠그면 조작부를 거두고, 잠금이 풀린 뒤에도 실제 발밑을 다시 칠한다
  gated.setLocked(true);
  assert.equal(controlsRoot.classList.contains('walk-controls--on'), false);
  assert.equal(press(gated, 'Enter'), false);
  gated.setLocked(false);
  assert.equal(controlsRoot.dataset.armed, 'true');
  gated.setEnabled(false);
  runFrames();
});
