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

  toggle(name, force = !this.#names.has(name)) {
    if (force) this.#names.add(name);
    else this.#names.delete(name);
    return force;
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
    return {
      left: 0,
      top: 0,
      right: this.offsetWidth,
      bottom: this.offsetHeight,
      width: this.offsetWidth,
      height: this.offsetHeight,
    };
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

function click(detail) {
  const event = new Event('click', { cancelable: true });
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

/** 모듈은 한 번만 불러오고, 테스트마다 새 DOM 흉내로 컴포넌트를 만든다 */
async function mount() {
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
  const counts = { inputChanges: 0, confirms: 0 };
  const controls = createWalkControls({
    onStickInput: () => { counts.inputChanges += 1; },
    onConfirm: () => { counts.confirms += 1; },
  });
  return { root, stick, knob, confirm, controls, counts };
}

test('공용 이동 UI는 포인터 소유권·해제·idempotent show를 한 상태로 관리한다', async () => {
  const { root, stick, knob, confirm, controls, counts } = await mount();

  controls.show({ placement: 'home-dock' });
  assert.equal(root.classList.contains('walk-controls--on'), true);
  assert.equal(root.dataset.placement, 'home-dock');
  assert.equal(controls.contains(knob), true);
  assert.equal(controls.contains(new FakeElement()), false);

  stick.dispatchEvent(pointer('pointerdown', 1, 72, 48));
  assert.deepEqual(controls.vector(), [1, 0]);
  assert.deepEqual(stick.captured, [1]);
  assert.equal(counts.inputChanges, 1);

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

  // 선택은 누르는 순간이 아니라 버튼 안에서 뗄 때 확정한다 — 스친 엄지가 답을 내지 않는다
  confirm.dispatchEvent(pointer('pointerdown', 3, 36, 36));
  assert.equal(counts.confirms, 0, '닿기만 해서는 확정하지 않는다');
  assert.deepEqual(confirm.captured, [3]);
  assert.equal(confirm.classList.contains('walk-confirm--pressed'), true);
  confirm.dispatchEvent(pointer('pointerup', 3, 40, 30));
  assert.equal(counts.confirms, 1);
  assert.equal(confirm.classList.contains('walk-confirm--pressed'), false);

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

test('선택 버튼은 밖으로 빼고 떼거나 입력이 끊기면 취소하고, 스틱 손가락과 따로 센다', async () => {
  const { stick, confirm, controls, counts } = await mount();
  controls.show();

  // 버튼 밖으로 빼면 눌림을 거두고, 거기서 떼면 아무것도 고르지 않는다
  confirm.dispatchEvent(pointer('pointerdown', 1, 36, 36));
  confirm.dispatchEvent(pointer('pointermove', 1, 120, 36));
  assert.equal(confirm.classList.contains('walk-confirm--pressed'), false, '밖에서는 취소를 미리 보인다');
  confirm.dispatchEvent(pointer('pointermove', 1, 50, 50));
  assert.equal(confirm.classList.contains('walk-confirm--pressed'), true, '돌아오면 다시 눌린다');
  confirm.dispatchEvent(pointer('pointermove', 1, 36, -10));
  confirm.dispatchEvent(pointer('pointerup', 1, 36, -10));
  assert.equal(counts.confirms, 0);

  // OS 제스처·통화로 끊기거나 capture를 잃으면 뒤늦은 pointerup도 확정하지 않는다
  confirm.dispatchEvent(pointer('pointerdown', 2, 36, 36));
  confirm.dispatchEvent(pointer('pointercancel', 2));
  confirm.dispatchEvent(pointer('pointerup', 2, 36, 36));
  confirm.dispatchEvent(pointer('pointerdown', 3, 36, 36));
  confirm.dispatchEvent(pointer('lostpointercapture', 3));
  confirm.dispatchEvent(pointer('pointerup', 3, 36, 36));
  assert.equal(counts.confirms, 0);
  assert.equal(confirm.classList.contains('walk-confirm--pressed'), false);

  // 누르는 사이 조작부가 거둬지면(잠금·화면 전환) 그 손가락은 확정하지 못한다
  confirm.dispatchEvent(pointer('pointerdown', 4, 36, 36));
  controls.hide();
  confirm.dispatchEvent(pointer('pointerup', 4, 36, 36));
  assert.equal(counts.confirms, 0);
  assert.equal(confirm.classList.contains('walk-confirm--pressed'), false);

  // 꺼진 조작부는 누르기를 받지 않는다
  confirm.dispatchEvent(pointer('pointerdown', 5, 36, 36));
  confirm.dispatchEvent(pointer('pointerup', 5, 36, 36));
  assert.equal(counts.confirms, 0);

  // 두 엄지: 스틱을 미는 중에도 선택이 되고, 선택을 떼도 스틱은 그대로 민다
  controls.show();
  stick.dispatchEvent(pointer('pointerdown', 6, 72, 48));
  confirm.dispatchEvent(pointer('pointerdown', 7, 36, 36));
  // 이미 누르고 있는 버튼에 닿은 다른 손가락은 따로 확정하지 않는다
  confirm.dispatchEvent(pointer('pointerdown', 8, 36, 36));
  confirm.dispatchEvent(pointer('pointerup', 8, 36, 36));
  assert.equal(counts.confirms, 0);
  confirm.dispatchEvent(pointer('pointerup', 7, 36, 36));
  assert.equal(counts.confirms, 1);
  assert.deepEqual(controls.vector(), [1, 0]);

  // capture가 실패한 손가락은 소유권을 남기지 않는다 — 다음 누르기가 바로 된다
  confirm.throwCapture = true;
  confirm.dispatchEvent(pointer('pointerdown', 9, 36, 36));
  confirm.dispatchEvent(pointer('pointerup', 9, 36, 36));
  assert.equal(counts.confirms, 1);
  confirm.dispatchEvent(pointer('pointerdown', 10, 36, 36));
  confirm.dispatchEvent(pointer('pointerup', 10, 36, 36));
  assert.equal(counts.confirms, 2);

  // 손가락·마우스의 click(detail ≥ 1)은 pointerup이 이미 처리했다. 키보드가 누른 click만 받는다
  confirm.dispatchEvent(click(1));
  assert.equal(counts.confirms, 2);
  confirm.dispatchEvent(click(0));
  assert.equal(counts.confirms, 3);
});

test('입력 상태만 조작부 모습을 바꾼다: 글자를 적는 동안 거두고, 누를 대상이 없으면 흐리게', async () => {
  const { root, stick, confirm, controls, counts } = await mount();
  controls.show({ placement: 'viewport' });

  stick.dispatchEvent(pointer('pointerdown', 1, 72, 48));
  confirm.dispatchEvent(pointer('pointerdown', 2, 36, 36));
  controls.setTyping(true);
  assert.equal(root.dataset.typing, 'true');
  assert.equal(root.classList.contains('walk-controls--on'), true, '화면 상태(--on)는 그대로 둔다');
  assert.deepEqual(controls.vector(), [0, 0], '숨긴 스틱이 캐릭터를 계속 밀지 않는다');
  confirm.dispatchEvent(pointer('pointerup', 2, 36, 36));
  assert.equal(counts.confirms, 0, '숨기기 전에 누르던 선택도 취소한다');

  controls.setTyping(false);
  assert.equal('typing' in root.dataset, false);

  controls.setArmed(false);
  assert.equal(root.dataset.armed, 'false');
  controls.setArmed(true);
  assert.equal(root.dataset.armed, 'true');
});
