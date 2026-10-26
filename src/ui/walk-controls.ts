// 모든 워커가 함께 쓰는 손가락 이동 UI
//
// DOM·포인터 캡처·반응형 배치 상태는 이 컴포넌트 하나가 소유한다. 화면은 별도 스틱을
// 만들거나 CSS로 현재 화면을 추측하지 않고, walker 설정으로 배치만
// 선언한다. 실제 이동·발밑 선택 규칙은 walker.ts가 맡는다.
//
// 화면이 아니라 입력 상태만 조작부의 모습을 바꾼다 — 글자를 적는 동안(data-typing)과
// 누를 대상이 없을 때(data-armed="false"). 둘 다 walker.ts가 알려 준다.

import { maybe } from '../dom.js';

/** 조작부를 화면 어디에 고정할지. 모양과 크기는 모든 배치가 공유한다. */
export type WalkControlsPlacement = 'viewport' | 'home-dock';

export interface WalkControlsOptions {
  placement?: WalkControlsPlacement;
}

export interface WalkControlsHandlers {
  /** 스틱 방향이나 세기가 바뀌었을 때 이동 루프를 깨운다. */
  onStickInput: () => void;
  /**
   * 오른쪽 선택 버튼. 활성 walker의 Enter/Space와 같은 동작을 연결한다.
   * 누르는 순간이 아니라 **버튼 안에서 손을 뗄 때** 부른다.
   */
  onConfirm: () => void;
}

export interface WalkControls {
  /** 활성 walker의 배치 계약으로 공용 조작부를 켠다. */
  show(options?: WalkControlsOptions): void;
  /** 조작부와 남아 있는 포인터 입력을 함께 거둔다. */
  hide(): void;
  /** 현재 스틱 방향과 세기(-1~1). */
  vector(): readonly [number, number];
  /** 화면 전환·잠금 때 스틱을 중앙으로 돌리고, 누르던 선택도 취소한다. */
  release(): void;
  /** 글자를 적는 동안에는 조작부를 거둔다. 입력칸을 벗어나면 다시 보인다. */
  setTyping(value: boolean): void;
  /** 지금 누르면 고를 것이 있는가. 없으면 선택 버튼을 흐리게 그린다. */
  setArmed(value: boolean): void;
  /** walker hit-test가 컴포넌트 내부를 선택 대상으로 오인하지 않게 한다. */
  contains(node: Element): boolean;
}

/** 이보다 작은 움직임은 손 떨림으로 본다. */
const STICK_DEADZONE = 5;

export function createWalkControls({
  onStickInput,
  onConfirm,
}: WalkControlsHandlers): WalkControls {
  // 손가락 조작부가 없는 문서에서도 키보드 walker는 그대로 동작한다.
  const root = maybe('walk-controls');
  const stick = maybe('walk-stick');
  const knob = maybe('walk-knob');
  const confirm = maybe<HTMLButtonElement>('walk-confirm');

  let pointerId: number | null = null;
  const direction = { x: 0, y: 0 };
  /** 선택 버튼을 누르고 있는 손가락. 스틱 손가락과 따로 센다 — 두 엄지가 함께 쓴다 */
  let confirmPointerId: number | null = null;

  function releaseStick(): void {
    pointerId = null;
    direction.x = 0;
    direction.y = 0;
    if (knob) knob.style.translate = '';
  }

  function releaseConfirm(): void {
    confirmPointerId = null;
    confirm?.classList.remove('walk-confirm--pressed');
  }

  function release(): void {
    releaseStick();
    releaseConfirm();
  }

  function releasePointer(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    releaseStick();
  }

  /** 붙잡은 손가락이 아직 선택 버튼 위에 있는가. capture 중이라 pointerleave가 오지 않아 직접 잰다 */
  function insideConfirm(event: PointerEvent): boolean {
    if (!confirm) return false;
    const box = confirm.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX <= box.left + box.width
      && event.clientY >= box.top && event.clientY <= box.top + box.height;
  }

  /** 손잡이가 움직일 수 있는 거리는 실제 렌더 크기에서 계산한다. */
  function radius(): number {
    if (!stick || !knob) return 0;
    return Math.max(0, (stick.offsetWidth - knob.offsetWidth) / 2);
  }

  function update(event: PointerEvent): void {
    if (!stick || !knob) return;
    const limit = radius();
    if (limit === 0) {
      releaseStick();
      return;
    }

    const box = stick.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const distance = Math.hypot(dx, dy);

    // 44px compact stick은 손잡이 travel이 10px뿐이다. 고정 5px deadzone을 그대로
    // 쓰면 절반이 죽으므로 travel의 ¼보다 커지지 않게 한다.
    const deadzone = Math.min(STICK_DEADZONE, limit / 4);
    if (distance < deadzone) {
      direction.x = 0;
      direction.y = 0;
    } else {
      const strength = Math.min(distance, limit) / limit;
      direction.x = (dx / distance) * strength;
      direction.y = (dy / distance) * strength;
    }

    const capped = Math.min(distance, limit);
    const x = distance > 0 ? (dx / distance) * capped : 0;
    const y = distance > 0 ? (dy / distance) * capped : 0;
    knob.style.translate = `${x}px ${y}px`;
    onStickInput();
  }

  if (root && stick && knob) {
    stick.addEventListener('pointerdown', (event) => {
      if (!root.classList.contains('walk-controls--on')) return;
      if (pointerId !== null) return;
      event.preventDefault();
      try {
        stick.setPointerCapture(event.pointerId);
      } catch {
        // 이미 끝난 포인터라면 소유권을 남기지 않는다. 다음 손가락이 바로 쓸 수 있다.
        releaseStick();
        return;
      }
      pointerId = event.pointerId;
      update(event);
    });

    stick.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      update(event);
    });

    // 손을 떼거나 OS 제스처·통화로 입력이 끊겨도 이동을 반드시 멈춘다.
    stick.addEventListener('pointerup', releasePointer);
    stick.addEventListener('pointercancel', releasePointer);
    stick.addEventListener('lostpointercapture', releasePointer);
  }

  // 선택은 **뗄 때** 확정한다. 누르는 순간 확정하면 엄지가 스치기만 해도 지나가던 칸이
  // 답이 되고, 낸 답은 되돌릴 수 없다(FR-3.3). 스틱과 같은 capture 수명을 쓴다 — 누르면
  // 붙잡아 눌림을 보이고, 버튼 안에서 떼면 확정, 밖에서 떼거나 입력이 끊기면 취소한다.
  if (root && confirm) {
    confirm.addEventListener('pointerdown', (event) => {
      // 포커스와 호환 마우스 이벤트를 가져가지 않게 한다. 확정은 pointerup의 몫이다
      event.preventDefault();
      if (!root.classList.contains('walk-controls--on')) return;
      if (confirmPointerId !== null) return;
      try {
        confirm.setPointerCapture(event.pointerId);
      } catch {
        releaseConfirm();
        return;
      }
      confirmPointerId = event.pointerId;
      confirm.classList.add('walk-confirm--pressed');
    });

    // 밖으로 빠지면 눌림을 거둬 «여기서 떼면 취소»를 미리 보인다. 돌아오면 다시 눌린다
    confirm.addEventListener('pointermove', (event) => {
      if (event.pointerId !== confirmPointerId) return;
      confirm.classList.toggle('walk-confirm--pressed', insideConfirm(event));
    });

    confirm.addEventListener('pointerup', (event) => {
      if (event.pointerId !== confirmPointerId) return;
      const inside = insideConfirm(event);
      releaseConfirm();
      if (inside) onConfirm();
    });

    const cancelConfirm = (event: PointerEvent): void => {
      if (event.pointerId !== confirmPointerId) return;
      releaseConfirm();
    };
    confirm.addEventListener('pointercancel', cancelConfirm);
    confirm.addEventListener('lostpointercapture', cancelConfirm);

    // 키보드·보조기기가 버튼을 «누른» 경우(detail 0). 손가락·마우스가 낸 click은
    // detail이 1 이상이고 위 pointerup이 이미 처리했으므로 두 번 고르지 않는다.
    confirm.addEventListener('click', (event) => {
      if (event.detail === 0) onConfirm();
    });
  }

  return {
    show(options = {}) {
      if (!root) return;
      const wasVisible = root.classList.contains('walk-controls--on');
      root.dataset.placement = options.placement ?? 'viewport';
      root.classList.add('walk-controls--on');
      if (!wasVisible) release();
    },

    hide() {
      root?.classList.remove('walk-controls--on');
      release();
    },

    vector() {
      return [direction.x, direction.y] as const;
    },

    release,

    setTyping(value) {
      if (!root) return;
      // 화면의 --on 상태는 그대로 둔다. 화면 아래 비움이 사라져 입력하던 칸이
      // 키보드가 올라오는 순간 튀지 않게, 보이는 것만 CSS가 거둔다
      if (value) {
        root.dataset.typing = 'true';
        release();
      } else {
        delete root.dataset.typing;
      }
    },

    setArmed(value) {
      if (root) root.dataset.armed = String(value);
    },

    contains(node) {
      return Boolean(root?.contains(node));
    },
  };
}
