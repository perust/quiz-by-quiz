import test from "node:test";
import assert from "node:assert/strict";

// 실제 createWalker와 모듈의 keyup/blur listener를 제어 RAF 위에서 실행한다.
// 프레임 간격은 결정적 입력 계약용이며 실제 브라우저 지연시간 측정이 아니다.
class Element {
  constructor(tag = "div", props = {}) {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.offsetWidth = 40;
    this.offsetHeight = 48;
    this.blurred = 0;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name); else classes.delete(name);
      },
    };
    Object.assign(this, props);
  }
  addEventListener() {}
  closest() { return null; }
  blur() { this.blurred++; document.activeElement = document.body; }
}
const listeners = { document: new Map(), window: new Map() };
function listen(scope, type, callback) {
  const list = listeners[scope].get(type) ?? [];
  list.push(callback);
  listeners[scope].set(type, list);
}
function emit(scope, type, event = {}) {
  for (const callback of listeners[scope].get(type) ?? []) callback(event);
}
const frames = new Map();
let nextFrame = 0;
let now = 1000;
let dialog = false;
const body = new Element("body");
globalThis.HTMLElement = Element;
globalThis.performance = { now: () => now };
globalThis.window = {
  innerWidth: 1280, innerHeight: 800, scrollY: 0, scrollBy() {},
  addEventListener: (type, callback) => listen("window", type, callback),
};
globalThis.document = {
  body, activeElement: body, getElementById: () => null,
  querySelector: () => dialog ? new Element() : null,
  elementFromPoint: () => null,
  addEventListener: (type, callback) => listen("document", type, callback),
};
globalThis.requestAnimationFrame = callback => {
  const id = ++nextFrame;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = id => frames.delete(id);
const { createWalker } = await import("../js/ui/walker.js");

function frame(elapsed = 16, timestamp = now + elapsed) {
  const pending = [...frames.values()];
  frames.clear();
  now += elapsed;
  for (const callback of pending) callback(timestamp);
}
function idle() {
  for (let i = 0; i < 4 && frames.size; i++) frame();
  assert.equal(frames.size, 0, "입력이 없으면 RAF가 잠든다");
}
const key = (name, props = {}) => ({
  key: name, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...props,
});
function release(name) { emit("document", "keyup", key(name)); }
function setup(t) {
  dialog = false;
  document.activeElement = body;
  const moves = [];
  const walker = createWalker({
    character: new Element(), onMove: (point, moving) => moves.push({ point, moving }),
  });
  walker.setEnabled(true);
  idle();
  t.after(() => {
    emit("window", "blur");
    walker.setEnabled(false);
    dialog = false;
    document.activeElement = body;
    idle();
  });
  return { walker, point: () => ({ ...moves.at(-1).point }) };
}
function down(walker, name) { assert.equal(walker.handleKey(key(name)), true); }
function neutral(walker, point, first, second) {
  down(walker, first);
  frame();
  down(walker, second);
  const before = point();
  frame();
  assert.deepEqual(point(), before, "반대 키는 여전히 중립이다");
  assert.equal(frames.size, 0, "중립에서 루프가 실제로 잠들었다");
  return before;
}
function displacement(before, after, dx, dy) {
  const step = 320 * 16 / 1000;
  assert.ok(Math.abs(after.x - before.x - dx * step) < 1e-8);
  assert.ok(Math.abs(after.y - before.y - dy * step) < 1e-8);
}

const releasePairs = [
  ["ArrowLeft", "ArrowRight", 1, 0], ["ArrowRight", "ArrowLeft", -1, 0],
  ["ArrowUp", "ArrowDown", 0, 1], ["ArrowDown", "ArrowUp", 0, -1],
  ["a", "d", 1, 0], ["D", "A", -1, 0],
  ["w", "s", 0, 1], ["S", "W", 0, -1],
];
for (const [first, second, dx, dy] of releasePairs) {
  test(`${first}+${second}: 첫 키 release만으로 다음 RAF에서 남은 방향 이동`, t => {
    const { walker, point } = setup(t);
    const before = neutral(walker, point, first, second);
    release(first);
    assert.equal(frames.size, 1, "keyup이 잠든 RAF를 한 번 깨워야 한다 (추가 keydown/repeat 없음)");
    frame();
    displacement(before, point(), dx, dy);
    assert.equal(frames.size, 1, "움직이는 루프는 하나뿐이다");
    release(second);
    idle();
    const stopped = point();
    frame();
    assert.deepEqual(point(), stopped, "모든 키를 떼면 멈춘다");
  });
}


// RAF의 frame-start timestamp와 callback 실행 시각은 다르다. release보다 앞선
// timestamp를 넘겨도 시간을 거꾸로 쓰거나 다음 프레임에 중복해서 세지 않는다.
for (const [first, second, dx, dy] of releasePairs) {
  test(`${first}+${second}: release보다 이른 RAF는 역행 없이 실제 경과부터 잇는다`, t => {
    const { walker, point } = setup(t);
    const before = neutral(walker, point, first, second);
    now += 8;
    const wakeAt = now;
    release(first);
    assert.equal(frames.size, 1, "추가 keydown/repeat 없이 release가 한 번 깨운다");
    frame(1, wakeAt - 6.638);
    t.diagnostic(JSON.stringify({ wakeAt, firstTimestamp: wakeAt - 6.638, before, after: point() }));
    assert.deepEqual(point(), before, "release 이전 frame-start는 0초다: 역행하거나 이동을 꾸미지 않는다");
    assert.equal(frames.size, 1, "0초 callback도 다음 RAF를 하나만 잇는다");
    frame(1, wakeAt);
    assert.deepEqual(point(), before, "기준 시각을 과거로 돌려 다음 프레임 시간을 부풀리지 않는다");
    frame(16, wakeAt + 16);
    displacement(before, point(), dx, dy);
    const normal = point();
    frame(100, wakeAt + 116);
    assert.ok(Math.abs(point().x - normal.x - dx * 320 * 0.05) < 1e-8, "최대 50ms step은 그대로다");
    assert.ok(Math.abs(point().y - normal.y - dy * 320 * 0.05) < 1e-8);
    release(second);
    idle();
    const stopped = point();
    frame();
    assert.deepEqual(point(), stopped);
    assert.equal(frames.size, 0, "모두 놓으면 루프가 잠든다");
  });
}

test("비겹침 방향전환과 마지막 release는 정지/RAF sleep을 유지한다", t => {
  const { walker, point } = setup(t);
  down(walker, "ArrowLeft");
  const start = point();
  frame();
  displacement(start, point(), -1, 0);
  release("ArrowLeft");
  idle();
  const middle = point();
  down(walker, "ArrowRight");
  frame();
  displacement(middle, point(), 1, 0);
  release("ArrowRight");
  idle();
});

test("대각선 normalization/속도와 축 release, 중복 RAF 방지를 유지한다", t => {
  const { walker, point } = setup(t);
  down(walker, "ArrowRight");
  down(walker, "ArrowUp");
  assert.equal(frames.size, 1);
  const before = point();
  frame();
  displacement(before, point(), Math.SQRT1_2, -Math.SQRT1_2);
  release("ArrowUp");
  assert.equal(frames.size, 1, "기존 RAF가 있으면 추가 예약하지 않는다");
  const diagonal = point();
  frame();
  displacement(diagonal, point(), 1, 0);
  release("ArrowRight");
  idle();
});

test("방향 release는 포커스를 빼앗지 않고 무관/미수락 keyup은 깨우지 않는다", t => {
  const { walker, point } = setup(t);
  neutral(walker, point, "ArrowLeft", "ArrowRight");
  for (const name of ["x", "Enter", " ", "ArrowUp"]) {
    release(name);
    assert.equal(frames.size, 0, `${name} release는 무효다`);
  }
  const button = new Element("button");
  document.activeElement = button;
  release("ArrowLeft");
  assert.equal(frames.size, 1);
  assert.equal(document.activeElement, button);
  assert.equal(button.blurred, 0, "onStickInput의 dropFocus를 재사용하지 않는다");
  frame();
  release("ArrowRight");
  idle();
  release("ArrowRight");
  assert.equal(frames.size, 0, "중복 release도 입력 상태를 바꾸지 않는다");
});

for (const kind of ["input", "textarea", "select", "contenteditable", "dialog"]) {
  test(`${kind}에서 release는 새 이동을 시작하지 않고 held 상태만 제거한다`, t => {
    const { walker, point } = setup(t);
    const before = neutral(walker, point, "ArrowLeft", "ArrowRight");
    if (kind === "dialog") dialog = true;
    else document.activeElement = new Element(kind, { type: "text", isContentEditable: kind === "contenteditable" });
    const focused = document.activeElement;
    release("ArrowLeft");
    assert.equal(frames.size, 0, "blocked release는 RAF를 깨우지 않는다");
    assert.equal(walker.handleKey(key("ArrowUp")), false);
    release("ArrowRight");
    release("ArrowUp");
    assert.equal(document.activeElement, focused);
    assert.equal(focused.blurred, 0);
    dialog = false;
    document.activeElement = body;
    frame();
    assert.deepEqual(point(), before, "차단 해제 후 유령 이동도 없다");
    down(walker, "ArrowDown");
    frame();
    displacement(before, point(), 0, 1);
    release("ArrowDown");
    idle();
  });
}

for (const state of ["locked", "disabled", "blur", "screen-switch"]) {
  test(`${state} 경계에서 release/복귀가 유령 방향을 남기지 않는다`, t => {
    const { walker, point } = setup(t);
    const before = neutral(walker, point, "ArrowLeft", "ArrowRight");
    if (state === "locked") walker.setLocked(true);
    if (state === "disabled") walker.setEnabled(false);
    if (state === "blur") emit("window", "blur");
    let next;
    if (state === "screen-switch") {
      next = createWalker({ character: new Element() });
      next.setEnabled(true);
      idle();
      assert.equal(walker.isEnabled(), false);
    }
    release("ArrowLeft");
    release("ArrowRight");
    assert.equal(frames.size, 0);
    assert.deepEqual(point(), before);
    next?.setEnabled(false);
    if (state === "locked") walker.setLocked(false);
    if (state === "disabled" || state === "screen-switch") walker.setEnabled(true);
    idle();
    const resumed = point();
    frame();
    assert.deepEqual(point(), resumed);
    down(walker, "ArrowDown");
    frame();
    displacement(resumed, point(), 0, 1);
    release("ArrowDown");
    idle();
  });
}
