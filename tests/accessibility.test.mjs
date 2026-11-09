import test from "node:test";
import assert from "node:assert/strict";

const { trapFocus } = await import("../js/ui/accessibility.js");

class FakeElement {
  constructor(name, hidden = false) {
    this.name = name;
    this.hidden = hidden;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
}

class FakeKey {
  constructor(shiftKey = false) {
    this.shiftKey = shiftKey;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

function fixture() {
  const first = new FakeElement("first");
  const hidden = new FakeElement("hidden", true);
  const middle = new FakeElement("middle");
  const last = new FakeElement("last");
  const selectors = [];
  const container = {
    querySelectorAll(selector) {
      selectors.push(selector);
      return [first, hidden, middle, last];
    },
  };
  globalThis.document = { activeElement: null };
  return { container, first, hidden, middle, last, selectors };
}

test("패널에서 Tab과 Shift+Tab은 보이는 첫·마지막 조작부로 들어간다", () => {
  const { container, first, last, selectors } = fixture();
  globalThis.document.activeElement = container;

  const forward = new FakeKey();
  trapFocus(container, forward);
  assert.equal(forward.defaultPrevented, true);
  assert.equal(globalThis.document.activeElement, first);

  globalThis.document.activeElement = container;
  const backward = new FakeKey(true);
  trapFocus(container, backward);
  assert.equal(backward.defaultPrevented, true);
  assert.equal(globalThis.document.activeElement, last);
  assert.deepEqual(selectors, [
    "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])",
    "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])",
  ]);
});

test("양 끝은 순환하고 가운데 Tab은 브라우저 기본 동작으로 남는다", () => {
  const { container, first, middle, last } = fixture();

  globalThis.document.activeElement = last;
  const forward = new FakeKey();
  trapFocus(container, forward);
  assert.equal(forward.defaultPrevented, true);
  assert.equal(globalThis.document.activeElement, first);

  const backward = new FakeKey(true);
  trapFocus(container, backward);
  assert.equal(backward.defaultPrevented, true);
  assert.equal(globalThis.document.activeElement, last);

  globalThis.document.activeElement = middle;
  const inside = new FakeKey();
  trapFocus(container, inside);
  assert.equal(inside.defaultPrevented, false);
  assert.equal(globalThis.document.activeElement, middle);
});

test("보이는 조작부가 없으면 Tab 기본 동작을 막지 않는다", () => {
  globalThis.document = { activeElement: null };
  const event = new FakeKey();
  trapFocus({ querySelectorAll: () => [] }, event);
  assert.equal(event.defaultPrevented, false);
});
