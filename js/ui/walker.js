// 캐릭터를 걸어 다니게 하는 공용 장치
//
// 퀴즈 무대(보기 고르기), 홈(메뉴 고르기), 캐릭터 화면(캐릭터 고르기)이 모두 이걸 쓴다.
// 화면마다 «칸»의 뜻만 다르고 움직이는 방식은 같다.
//
// **게임 규칙은 갖지 않는다.** 밟은 칸의 번호를 넘길 뿐이고, 그 번호가 무엇을
// 뜻하는지는 부르는 쪽이 정한다.
//
// 한 번에 하나만 움직인다. 화면이 바뀌면 이전 것을 끄고 새것을 켠다 —
// 키와 스틱은 모듈 하나에 모아두고 지금 켜진 워커에게만 전달한다.

/** 초당 이동 거리(px). 한 화면을 가로지르는 데 1초 남짓 걸린다 */
const SPEED = 320;

/** 프레임 간격이 이보다 벌어지면 잘라낸다. 탭이 백그라운드에 갔다 오면 크게 튄다 */
const MAX_STEP_MS = 50;

/** 눌러서 걸어갈 때 «도착했다»고 보는 거리 */
const ARRIVE_PX = 4;

/** 이보다 조금 밀린 것은 손 떨림으로 보고 무시한다 */
const STICK_DEADZONE = 5;

/**
 * 방향키 → (dx, dy). 두 개를 함께 누르면 대각선이 된다.
 * 칸을 세지 않는다 — 자유롭게 움직이고 «발이 어느 칸에 있는지»만 본다.
 */
const DIRECTIONS = {
  ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
  ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
  ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
};

export const PICK_KEYS = ['Enter', ' '];

// ── 입력 (모듈 하나에 모아둔다) ──────────────────────────────────

/**
 * 지금 눌려 있는 방향키. 대각선은 «두 방향을 같이 누른 상태»로 판정한다.
 * 창을 벗어나면 keyup을 놓칠 수 있어 blur에서 비운다.
 */
const held = new Set();

/** 스틱을 민 방향과 세기. -1 ~ 1 이고 길이가 곧 속도 비율이다 */
const stick = { x: 0, y: 0 };
let stickPointerId = null;

/** 지금 움직이고 있는 워커. 화면 하나만 켜지므로 하나면 된다 */
let active = null;

const stickEl = document.getElementById('walk-stick');
const knobEl = document.getElementById('walk-knob');

function releaseStick() {
  stickPointerId = null;
  stick.x = 0;
  stick.y = 0;
  if (knobEl) knobEl.style.translate = '';
}

/**
 * 손잡이가 밀려날 수 있는 최대 거리. 값을 박아두지 않고 크기에서 뽑는다 —
 * 짧은 화면에서 스틱이 작아지기 때문이다.
 */
function stickRadius() {
  return (stickEl.offsetWidth - knobEl.offsetWidth) / 2;
}

function updateStick(event) {
  const radius = stickRadius();
  const box = stickEl.getBoundingClientRect();
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  const distance = Math.hypot(dx, dy);

  if (distance < STICK_DEADZONE) {
    stick.x = 0;
    stick.y = 0;
  } else {
    // 민 거리가 그대로 속도가 된다. 끝까지 밀면 1(최고 속도)
    const strength = Math.min(distance, radius) / radius;
    stick.x = (dx / distance) * strength;
    stick.y = (dy / distance) * strength;
  }

  // 손잡이는 테두리 안에서만 움직인다
  const capped = Math.min(distance, radius);
  const kx = distance > 0 ? (dx / distance) * capped : 0;
  const ky = distance > 0 ? (dy / distance) * capped : 0;
  knobEl.style.translate = `${kx}px ${ky}px`;

  active?.onStickInput();
}

if (stickEl && knobEl) {
  stickEl.addEventListener('pointerdown', (event) => {
    if (!active) return;
    event.preventDefault();
    stickPointerId = event.pointerId;
    stickEl.setPointerCapture(event.pointerId);
    updateStick(event);
  });

  stickEl.addEventListener('pointermove', (event) => {
    if (event.pointerId !== stickPointerId) return;
    updateStick(event);
  });

  // 손을 떼거나 통화 등으로 입력이 끊기면 제자리로 돌린다
  stickEl.addEventListener('pointerup', releaseStick);
  stickEl.addEventListener('pointercancel', releaseStick);
}

// 눌린 방향키를 따라간다. 처리는 handleKey에서 하고 여기서는 상태만 둔다
document.addEventListener('keyup', (event) => held.delete(event.key));
window.addEventListener('blur', () => held.clear());
window.addEventListener('resize', () => active?.relayout());

/** 눌려 있는 키와 스틱을 합쳐 방향을 만든다. 대각선은 여기서 생긴다 */
function inputVector() {
  // 스틱을 밀고 있으면 그쪽이 우선. 민 정도가 속도가 된다
  if (stick.x !== 0 || stick.y !== 0) return [stick.x, stick.y];

  let dx = 0;
  let dy = 0;
  for (const key of held) {
    const direction = DIRECTIONS[key];
    if (!direction) continue;
    dx += direction[0];
    dy += direction[1];
  }
  dx = Math.sign(dx);
  dy = Math.sign(dy);
  // 대각선이 더 빠르지 않도록 길이를 1로 맞춘다
  if (dx !== 0 && dy !== 0) return [dx * Math.SQRT1_2, dy * Math.SQRT1_2];
  return [dx, dy];
}

/** 스틱을 그릴지 말지. 움직일 수 있는 화면에서만 보인다 */
function showStick(value) {
  if (!stickEl) return;
  stickEl.classList.toggle('walk-stick--on', value);
  if (!value) releaseStick();
}

// ── 워커 ─────────────────────────────────────────────────────────

/**
 * @param {{
 *   stage: HTMLElement,           좌표 기준이 되는 요소
 *   character: HTMLElement,       움직일 요소
 *   getZones: () => HTMLElement[] 지금 밟을 수 있는 칸들
 *   onPick: (index: number) => void,
 *   onZoneChange?: (index: number|null, previous: number|null) => void,
 *   edge?: number,                무대 안쪽 여백
 *   startAt?: () => {x: number, y: number}|null  처음 설 자리. 없으면 한가운데
 *   footInset?: number            칸을 눌러 갈 때 아래에서 띄울 거리. 글자를 피한다
 * }} config
 */
export function createWalker(config) {
  const {
    stage, character, getZones, onPick, onZoneChange,
    edge = 7, startAt, footInset = 10,
  } = config;

  let enabled = false;
  /** 잠기면 움직이지도 고르지도 못한다 */
  let locked = false;

  /** 무대 기준 «발» 좌표 */
  const pos = { x: 0, y: 0 };
  /** 지금 밟고 있는 칸. 아무 칸도 아니면 null */
  let standing = null;
  let zoneNodes = [];
  let zoneBoxes = [];
  let stageSize = { width: 0, height: 0 };

  /**
   * 자리를 잡았는가. 화면이 아직 보이지 않으면 크기를 0으로 재게 되어
   * 세울 수 없다. 그때는 false로 남아 어느 경로로 들어오든 다시 세운다.
   */
  let placed = false;

  let frameId = null;
  let lastTs = 0;
  /** 눌러서 걸어갈 지점. 방향키나 스틱을 쓰면 취소된다 */
  let autoTarget = null;

  function measure() {
    const base = stage.getBoundingClientRect();
    if (base.width === 0) return; // 아직 배치되지 않았다

    stageSize = { width: base.width, height: base.height };
    zoneNodes = getZones();
    zoneBoxes = zoneNodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        left: box.left - base.left,
        top: box.top - base.top,
        right: box.right - base.left,
        bottom: box.bottom - base.top,
      };
    });
  }

  /** 발이 놓인 칸. 칸 사이 빈자리면 null */
  function zoneAt(x, y) {
    for (let index = 0; index < zoneBoxes.length; index += 1) {
      const box = zoneBoxes[index];
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return index;
    }
    return null;
  }

  function clampPosition() {
    if (stageSize.width === 0) return;

    const half = character.offsetWidth / 2;
    const height = character.offsetHeight;
    pos.x = Math.min(Math.max(pos.x, edge + half), stageSize.width - edge - half);
    // 머리가 무대 위로 솟지 않도록 위쪽은 캐릭터 높이만큼 띄운다
    pos.y = Math.min(Math.max(pos.y, edge + height), stageSize.height - edge);
  }

  function render() {
    character.style.transform =
      `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`;

    const zone = zoneAt(pos.x, pos.y);
    if (zone === standing) return;
    const previous = standing;
    standing = zone;
    onZoneChange?.(standing, previous);
  }

  /** 캐릭터를 처음 자리에 세운다 */
  function place() {
    measure();
    if (stageSize.width === 0) return; // 아직 크기를 얻지 못했다. placed는 false로 남는다

    const start = startAt?.();
    pos.x = start ? start.x : stageSize.width / 2;
    pos.y = start ? start.y : stageSize.height / 2;
    clampPosition();
    standing = null; // 새로 판정하도록 비운다
    render();
    placed = true;
  }

  function loop(ts) {
    frameId = null;
    if (!enabled || locked) return;

    if (!placed) {
      place();
      lastTs = ts;
      frameId = requestAnimationFrame(loop);
      return;
    }

    const dt = Math.min(ts - lastTs, MAX_STEP_MS) / 1000;
    lastTs = ts;

    let [vx, vy] = inputVector();
    const pressing = vx !== 0 || vy !== 0;

    if (pressing) {
      autoTarget = null; // 손으로 미는 쪽이 우선이다
    } else if (autoTarget) {
      const dx = autoTarget.x - pos.x;
      const dy = autoTarget.y - pos.y;
      const distance = Math.hypot(dx, dy);
      if (distance < ARRIVE_PX) {
        autoTarget = null;
        pos.x += dx;
        pos.y += dy;
        render();
        pick(); // 눌러서 왔으면 도착한 자리로 확정한다
        return;
      }
      vx = dx / distance;
      vy = dy / distance;
    }

    const moving = vx !== 0 || vy !== 0;
    // 움직일 때는 걷는 동작, 서 있을 때는 제자리 뛰기
    character.classList.toggle('walker--walking', moving);
    character.classList.toggle('walker--idle', !moving);

    if (moving) {
      pos.x += vx * SPEED * dt;
      pos.y += vy * SPEED * dt;
      clampPosition();
      render();
    }

    frameId = requestAnimationFrame(loop);
  }

  function start() {
    if (frameId !== null || !enabled || locked) return;
    lastTs = performance.now();
    frameId = requestAnimationFrame(loop);
  }

  function stop() {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    character.classList.remove('walker--walking');
  }

  function pick() {
    if (!enabled || locked || standing === null) return;
    character.classList.remove('walker--idle');
    character.classList.add('walker--hop');
    onPick(standing);
  }

  const walker = {
    /**
     * 이 워커를 켜고 끈다. **켜면 이전에 켜져 있던 것은 꺼진다.**
     *
     * 이미 켜져 있을 때 다시 켜도 안전하다 — 자리와 입력을 처음 상태로 되돌리므로
     * «초기화»가 필요할 때도 이걸 부르면 된다. 별도의 reset을 두지 않는 이유다.
     * 화면이 바뀌면 이 워커가 조용히 꺼져 있을 수 있어, 다시 쓰기 전에는
     * 반드시 여기를 거쳐야 한다.
     */
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) {
        if (active === walker) {
          active = null;
          showStick(false);
        }
        stop();
        character.classList.remove('walker--walking', 'walker--idle');
        return;
      }

      if (active && active !== walker) active.setEnabled(false);
      active = walker;
      held.clear();
      releaseStick();
      showStick(true);
      locked = false;
      placed = false;
      autoTarget = null;
      // 배치가 잡힌 다음 프레임에 좌표를 잰다
      requestAnimationFrame(() => {
        place();
        start();
      });
    },

    isEnabled() {
      return enabled;
    },

    /** 잠그면 더 움직이지도 고르지도 못한다 */
    setLocked(value) {
      locked = Boolean(value);
      if (locked) stop();
      else start();
    },

    /** 지금 밟고 있는 칸. 아무 칸도 아니면 null */
    standingIndex() {
      return enabled ? standing : null;
    },

    /** 칸을 눌렀을 때. 그 자리까지 걸어간 뒤 고른다 */
    goTo(index) {
      if (!enabled || locked) return;
      const box = zoneBoxes[index];
      if (!box) return;

      autoTarget = {
        x: (box.left + box.right) / 2,
        // 칸 아래쪽을 딛는다. footInset 으로 글자를 피할 만큼 띄운다
        y: box.bottom - Math.min(footInset, (box.bottom - box.top) / 2),
      };
      held.clear();
      releaseStick();
      start();
    },

    /** 크기가 바뀌면 비율을 지켜 옮긴다 */
    relayout() {
      if (!enabled) return;
      if (!placed) {
        place();
        return;
      }
      const previous = { ...stageSize };
      measure();
      if (previous.width > 0 && stageSize.width > 0) {
        pos.x *= stageSize.width / previous.width;
        pos.y *= stageSize.height / previous.height;
      }
      clampPosition();
      render();
    },

    /** 스틱 입력이 들어왔을 때 루프를 깨운다 */
    onStickInput() {
      autoTarget = null;
      start();
    },

    /**
     * 화면이 받은 키를 넘겨준다. 처리했으면 true.
     * 방향키는 «눌린 상태»로만 기록하고 실제 이동은 루프가 한다.
     */
    handleKey(event) {
      if (!enabled) return false;

      if (DIRECTIONS[event.key]) {
        // 잠겨 있어도 눌린 키는 기록해 둔다. 안 그러면 다음에 유령 방향이 생긴다
        held.add(event.key);
        if (locked) return false;
        start();
        return true; // 화면이 스크롤되지 않게 막는다
      }

      if (locked) return false;

      if (PICK_KEYS.includes(event.key)) {
        // 버튼에 포커스가 있으면 그건 버튼이 처리할 입력이다
        if (document.activeElement?.closest('button')) return false;
        pick();
        return true;
      }
      return false;
    },
  };

  return walker;
}
