import test from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
  #names = new Set();

  add(name) {
    this.#names.add(name);
  }

  remove(name) {
    this.#names.delete(name);
  }

  contains(name) {
    return this.#names.has(name);
  }
}

class FakeElement extends EventTarget {
  constructor({ width = 0, height = 0, parent = null } = {}) {
    super();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = { translate: '' };
    this.offsetWidth = width;
    this.offsetHeight = height;
    this.parent = parent;
    this.textContent = '';
    this.captured = [];
    this.throwCapture = false;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight };
  }

  setPointerCapture(pointerId) {
    if (this.throwCapture) {
      this.throwCapture = false;
      throw new Error('stale pointer');
    }
    this.captured.push(pointerId);
  }

  contains(node) {
    for (let current = node; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
}

function pointer(type, pointerId, clientX = 0, clientY = 0) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

test('공용 이동 UI는 포인터 소유권·해제·idempotent show를 한 상태로 관리한다', async () => {
  const root = new FakeElement();
  const stick = new FakeElement({ width: 96, height: 96, parent: root });
  const knob = new FakeElement({ width: 48, height: 48, parent: stick });
  const confirm = new FakeElement({ width: 72, height: 72, parent: root });
  const elements = new Map([
    ['walk-controls', root],
    ['walk-stick', stick],
    ['walk-knob', knob],
    ['walk-confirm', confirm],
  ]);
  globalThis.document = { getElementById: (id) => elements.get(id) ?? null };

  const { createWalkControls } = await import('../js/ui/walk-controls.js');
  let inputChanges = 0;
  let confirms = 0;
  const controls = createWalkControls({
    onStickInput: () => { inputChanges += 1; },
    onConfirm: () => { confirms += 1; },
  });

  controls.show({ placement: 'home-dock' });
  assert.equal(root.classList.contains('walk-controls--on'), true);
  assert.equal(root.dataset.placement, 'home-dock');
  assert.equal(controls.contains(knob), true);
  assert.equal(controls.contains(new FakeElement()), false);

  stick.dispatchEvent(pointer('pointerdown', 1, 72, 48));
  assert.deepEqual(controls.vector(), [1, 0]);
  assert.deepEqual(stick.captured, [1]);
  assert.equal(inputChanges, 1);

  // 두 번째 손가락과 그 취소는 첫 번째 손가락의 이동을 끊지 않는다.
  stick.dispatchEvent(pointer('pointerdown', 2, 24, 48));
  stick.dispatchEvent(pointer('pointercancel', 2));
  assert.deepEqual(controls.vector(), [1, 0]);
  assert.deepEqual(stick.captured, [1]);

  // 같은 활성 상태를 다시 보여도 진행 중인 drag는 보존하고 배치만 갱신한다.
  controls.show({ placement: 'viewport' });
  assert.deepEqual(controls.vector(), [1, 0]);
  assert.equal(root.dataset.placement, 'viewport');

  stick.dispatchEvent(pointer('lostpointercapture', 1));
  assert.deepEqual(controls.vector(), [0, 0]);
  assert.equal(knob.style.translate, '');

  confirm.dispatchEvent(pointer('pointerdown', 3));
  assert.equal(confirms, 1);
  controls.setConfirmLabel('나가기');
  assert.equal(confirm.textContent, '나가기');

  stick.dispatchEvent(pointer('pointerdown', 4, 24, 48));
  assert.deepEqual(controls.vector(), [-1, 0]);
  controls.hide();
  assert.equal(root.classList.contains('walk-controls--on'), false);
  assert.deepEqual(controls.vector(), [0, 0]);

  controls.show();
  stick.throwCapture = true;
  stick.dispatchEvent(pointer('pointerdown', 5, 72, 48));
  assert.deepEqual(controls.vector(), [0, 0], 'capture 실패는 죽은 pointerId를 남기지 않는다');

  stick.offsetWidth = 44;
  stick.offsetHeight = 44;
  knob.offsetWidth = 24;
  knob.offsetHeight = 24;
  stick.dispatchEvent(pointer('pointerdown', 6, 25, 22));
  assert.ok(controls.vector()[0] > 0, '44px 스틱은 3px 입력도 deadzone 밖으로 읽는다');
  stick.dispatchEvent(pointer('pointerup', 6));
});
