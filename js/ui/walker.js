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

/** 눌러서 쓰는 input. 커서가 머물지 않아 «적는 칸»이 아니다 */
const TAP_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color']);

/**
 * 글자를 적어 넣는 자리인가.
 *
 * 체크박스·라디오·버튼처럼 생긴 `input`은 여기서 빠진다 — 그것들은 «들어가는» 것이
 * 아니라 «누르는» 것이고, 커서가 머물지 않으니 갇힐 일도 없다.
 */
function isTypingTarget(node) {
  if (!node) return false;
  if (node.isContentEditable) return true;
  if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
  return node.tagName === 'INPUT' && !TAP_INPUTS.has(node.type);
}

/**
 * 지금 키를 워커가 받으면 안 되는 상황인가.
 *
 * - 글자를 입력하는 중이면 방향키와 Enter는 그쪽 것이다. 결과 화면에는
 *   닉네임 칸이 있어, 이 검사가 없으면 이름을 적는 동안 캐릭터가 같이 걸어간다.
 * - 다이얼로그가 열려 있으면 그 안이 전부다. 뒤에서 캐릭터가 걸어 다니면
 *   가려진 자리를 밟게 되고, 갇혀 있어야 할 조작이 밖으로 샌다.
 */
function isBlocked() {
  if (isTypingTarget(document.activeElement)) return true;
  return Boolean(document.querySelector('.dialog-backdrop:not([hidden])'));
}

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
const confirmEl = document.getElementById('walk-confirm');

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

// 손가락에는 Enter가 없다. 스틱으로 걸어간 자리를 확정할 길이 있어야
// «걸어가서 고르기»가 성립한다. 없으면 결국 칸을 직접 눌러야 해서 스틱이 헛돈다.
//
// 입력칸에 들어가 있을 때는 **나가는 버튼이 된다.** 손가락에는 Esc도 없어서,
// 이게 없으면 걸어서 들어간 사람이 소프트 키보드 앞에 갇힌다.
confirmEl?.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  const node = document.activeElement;
  if (isTypingTarget(node)) node.blur();
  else active?.confirm();
  paintConfirm();
});

/**
 * 확정 버튼의 말이 지금 하는 일을 따라가게 한다.
 *
 * **바뀌는 자리에서 곧바로 부른다.** 포커스 이벤트에만 기대면 창이 포커스를 갖지
 * 않은 동안(`document.hasFocus()`가 false) 이벤트가 미뤄져 버튼이 거짓말을 한다.
 * 리스너는 워커를 거치지 않는 길(Tab, 칸을 손가락으로 직접 누르기)을 위해 함께 둔다.
 */
function paintConfirm(node = document.activeElement) {
  if (confirmEl) confirmEl.textContent = isTypingTarget(node) ? '나가기' : '선택';
}
document.addEventListener('focusin', () => paintConfirm());
// 나가는 쪽은 «어디로 가는지»(relatedTarget)를 보고 곧바로 정한다. focusout 시점에는
// activeElement가 아직 넘어가는 중이라 한 프레임 미뤄야 했는데, 프레임이 멈춘
// 화면에서는 그 갱신이 영영 오지 않았다
document.addEventListener('focusout', (event) => paintConfirm(event.relatedTarget));

/**
 * **입력칸에서 빠져나오는 길.** 캐릭터로 입력칸을 밟아 들어갈 수 있게 되면서
 * 필요해졌다 — 커서가 들어간 순간 방향키는 그쪽 것이 되어 캐릭터가 멈추고,
 * 나오는 길을 모르면 걷기로 돌아갈 수 없다.
 *
 * **캡처 단계에서 받아 화면 쪽으로 넘기지 않는다.** 화면들은 Escape를 «뒤로 가기»로
 * 쓰는데(로비 → 홈), 방 코드를 적다 Esc를 누른 사람이 홈으로 튕겨 나가면 적던 것이
 * 통째로 날아간다.
 *
 * **다이얼로그 안은 예외다.** 거기서는 Escape가 «취소»이고 갇힌 상태에서 나가는
 * 유일한 길이라, 입력칸에 커서가 있어도 다이얼로그 쪽에 양보한다.
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !active) return;
  const node = document.activeElement;
  if (!isTypingTarget(node) || node.closest('.dialog')) return;
  event.preventDefault();
  event.stopPropagation();
  node.blur();
  paintConfirm();
}, true);

// 눌린 방향키를 따라간다. 처리는 handleKey에서 하고 여기서는 상태만 둔다
document.addEventListener('keyup', (event) => held.delete(event.key));
window.addEventListener('blur', () => held.clear());
window.addEventListener('resize', () => active?.relayout());
// 화면 전체를 걸어 다닐 때는 캐릭터가 화면에 붙어 있어, 사용자가 스스로 스크롤하면
// 캐릭터는 그대로인데 발밑만 바뀐다. 루프가 멈춰 있어도 표시를 맞춰 준다
window.addEventListener('scroll', () => active?.refresh(), { passive: true });

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

/**
 * 손가락 조작부(스틱·확정 버튼)를 그릴지 말지.
 * 움직일 수 있는 화면에서, 잠기지 않았을 때만 보인다.
 * 잠긴 뒤에도 남아 있으면 «다음 문제» 버튼을 가린다.
 */
function showControls(value) {
  stickEl?.classList.toggle('walk-stick--on', value);
  confirmEl?.classList.toggle('walk-confirm--on', value);
  if (!value) releaseStick();
}

// ── 워커 ─────────────────────────────────────────────────────────

/**
 * 캐릭터는 **화면 전체를 걸어 다닌다.**
 *
 * 밟을 칸 목록을 받지 않고 **발밑에 실제로 무엇이 있는지**를
 * `document.elementFromPoint`로 그때그때 본다. 고르면 그 자리를 진짜로
 * 누른다(`element.click()`) — 버튼에 달린 리스너가 마우스로 눌렀을 때와 똑같이
 * 움직이므로, 화면 쪽에 «무엇을 골랐는지»를 잇는 코드를 둘 필요가 없다.
 *
 * 글자를 적는 칸도 밟아서 들어갈 수 있다. 거기서는 «누르기» 대신 커서를
 * 넣고(`focus()`), Esc를 누르면 다시 걷기로 돌아온다.
 *
 * 캐릭터가 화면에 붙어(`position: fixed`) 있어 밖으로 나갈 일이 없고, 대신
 * 가장자리를 밀면 페이지가 스크롤된다.
 *
 * @param {{
 *   character: HTMLElement,       움직일 요소
 *   pickable?: string,            «누를 수 있는 것»으로 볼 선택자
 *   standClass?: string,          발밑에 붙일 클래스. 기본 is-standing
 *   onStep?: (element: HTMLElement|null) => void,  발밑이 바뀔 때
 *   edge?: number,                화면 안쪽 여백
 *   startAt?: () => {x: number, y: number}|null  처음 설 자리. 없으면 한가운데
 * }} config
 */
export function createWalker(config) {
  const {
    character,
    // 입력칸도 넣는다 — 걸어 다니는 사람만 «여기는 못 간다»가 되면 화면 절반이
    // 캐릭터에게 막힌 셈이다. 로비의 방 코드, 대기실의 채팅칸이 그렇다
    pickable = 'button, a[href], [role="button"], summary, input:not([type="hidden"]), textarea, select',
    onStep, standClass = 'is-standing', edge = 7, startAt,
  } = config;

  let enabled = false;
  /** 잠기면 움직이지도 고르지도 못한다 */
  let locked = false;

  /** 화면 기준 «발» 좌표 */
  const pos = { x: 0, y: 0 };
  /** 발밑에 있는 «누를 수 있는 것» */
  let underFoot = null;
  /** 걸어 다닐 수 있는 범위. 화면이 곧 무대다 */
  let stageSize = { width: 0, height: 0 };

  /**
   * 자리를 잡았는가. 화면이 아직 보이지 않으면 크기를 0으로 재게 되어
   * 세울 수 없다. 그때는 false로 남아 어느 경로로 들어오든 다시 세운다.
   */
  let placed = false;

  let frameId = null;
  let lastTs = 0;

  function measure() {
    stageSize = { width: window.innerWidth, height: window.innerHeight };
  }

  function clampPosition() {
    if (stageSize.width === 0) return;

    const half = character.offsetWidth / 2;
    pos.x = Math.min(Math.max(pos.x, edge + half), stageSize.width - edge - half);

    // 위쪽은 캐릭터 높이만큼 띄우지 않는다. 띄우면 **화면 맨 위의 버튼에 발이
    // 닿지 않는다** — 앱 바가 딱 그 높이에 있다. 대신 맨 위에서는 머리가 화면
    // 밖으로 조금 잘린다.
    pos.y = Math.min(Math.max(pos.y, edge), stageSize.height - edge);
  }

  /**
   * 발밑에 있는 «누를 수 있는 것».
   *
   * 캐릭터 자신은 `.walker`가 `pointer-events: none`이라 잡히지 않는다.
   * 화면에 띄운 조작부(스틱·확정 버튼)는 어느 화면의 자손도 아니고 늘 같은 자리에
   * 있어서, 그 위에 올라섰다고 «고를 수 있다»고 보면 안 된다.
   */
  function pickableUnderFoot() {
    const hit = document.elementFromPoint(pos.x, pos.y - 1);
    if (!hit || hit.closest('.walk-stick, .walk-confirm')) return null;

    const target = hit.closest(pickable);
    if (!target || target.disabled) return null;
    return target;
  }

  function render() {
    character.style.transform =
      `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`;

    const next = pickableUnderFoot();
    if (next === underFoot) return;
    underFoot?.classList.remove(standClass);
    underFoot = next;
    underFoot?.classList.add(standClass);
    onStep?.(underFoot);
  }

  /**
   * 캐릭터가 화면에 붙어 있어 밖으로 나갈 일이 없으므로, **가장자리에 닿은 채
   * 더 밀 때만** 페이지를 그만큼 움직인다.
   *
   * «여백에 들어오면 민다»로 하면 화면 가장자리 가까이 있는 것은 밟고 설 수가
   * 없다 — 다가가는 순간 페이지가 도망간다.
   *
   * **움직이는 동안에만 부른다.** `place()`에서 부르면 화면에 들어올 때마다
   * 캐릭터 쪽으로 스크롤이 끌려가 위쪽 글이 밀려난다.
   */
  function pushScroll(vy, dt) {
    if (vy === 0) return;

    const height = character.offsetHeight;
    const atTop = pos.y <= edge + height + 0.5;
    const atBottom = pos.y >= stageSize.height - edge - 0.5;
    if ((vy < 0 && atTop) || (vy > 0 && atBottom)) {
      window.scrollBy(0, vy * SPEED * dt);
    }
  }

  /** 캐릭터를 처음 자리에 세운다 */
  function place() {
    measure();
    if (stageSize.width === 0) return; // 아직 크기를 얻지 못했다. placed는 false로 남는다

    const start = startAt?.();
    pos.x = start ? start.x : stageSize.width / 2;
    pos.y = start ? start.y : stageSize.height / 2;
    clampPosition();
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

    const [vx, vy] = inputVector();
    const moving = vx !== 0 || vy !== 0;
    // 움직일 때는 걷는 동작, 서 있을 때는 제자리 뛰기
    character.classList.toggle('walker--walking', moving);
    character.classList.toggle('walker--idle', !moving);

    if (!moving) {
      // 움직이지 않으면 루프를 멈춘다. 매 프레임 깨어나 아무 일도 하지 않으면
      // 휴대폰 배터리만 쓴다. 제자리 뛰기는 CSS 애니메이션이라 프레임을
      // 돌리지 않아도 계속 뛰고, 입력이 오면 start()가 다시 깨운다
      // (handleKey 와 onStickInput 이 start를 부른다).
      return;
    }

    pos.x += vx * SPEED * dt;
    pos.y += vy * SPEED * dt;
    clampPosition();
    render();
    pushScroll(vy, dt);

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

  /**
   * 한 번 뛰기가 끝나면 스스로 뗀다.
   *
   * `walker--hop`은 `--idle`을 이기도록 CSS에서 뒤에 두었고, `walker-land`는 한 번만
   * 도는 애니메이션이다. 그래서 남아 있으면 **제자리 뛰기가 영영 가려진다.**
   *
   * 화면을 옮기는 자리(홈에서 카테고리를 고르는 것 등)는 다음 `setEnabled(true)`가
   * 떼어 주지만, **그 자리에 머무는 자리**(로비의 «만들기»·«새로고침», 랭킹 탭,
   * 앱 바 토글)는 다시 켜지지 않아 캐릭터가 그대로 굳었다.
   *
   * 숨은 탭에서는 CSS 애니메이션이 멈춰 이 이벤트가 오지 않을 수 있다.
   * `setEnabled`가 떼는 것은 그래서 남겨 둔다.
   */
  character.addEventListener('animationend', (event) => {
    if (event.animationName !== 'walker-land') return;
    character.classList.remove('walker--hop');
    // 루프는 서 있는 동안 멈춰 있다. 걷는 중이 아니면 제자리 뛰기를 되돌려 준다
    if (enabled && !character.classList.contains('walker--walking')) {
      character.classList.add('walker--idle');
    }
  });

  /**
   * 발밑을 «그 자리에서» 고른다. 버튼이 제 리스너로 알아서 움직이므로
   * 워커는 무엇을 골랐는지 알 필요가 없다.
   *
   * 글자를 적는 칸만 다르다. `click()`은 커서를 넣어 준다는 보장이 없고,
   * 넣어 준다 해도 **누르는 것과 들어가는 것은 뜻이 다르다** — 폼의 「만들기」를
   * 밟았을 때처럼 무언가 일어나는 게 아니라 이제부터 적겠다는 것이다.
   */
  function pick() {
    if (!enabled || locked || !underFoot) return;
    character.classList.remove('walker--idle');
    character.classList.add('walker--hop');
    if (isTypingTarget(underFoot)) underFoot.focus();
    else underFoot.click();
    paintConfirm();
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
          showControls(false);
        }
        stop();
        character.classList.remove('walker--walking', 'walker--idle', 'walker--hop');
        // 화면을 떠나면서 밟고 있던 표시도 거둔다. 남겨 두면 돌아왔을 때
        // 캐릭터가 없는 자리에 불이 켜져 있다
        underFoot?.classList.remove(standClass);
        underFoot = null;
        return;
      }

      if (active && active !== walker) active.setEnabled(false);
      active = walker;
      held.clear();
      releaseStick();
      // 고를 때 붙인 «한 번 뛰기»를 여기서 뗀다. 이 클래스는 겹칠 때 이기려고
      // --idle 뒤에 두었기 때문에, 남아 있으면 제자리 뛰기가 영영 가려진다.
      // 실제로 그래서 2번 문제부터 캐릭터가 굳어 있었다.
      character.classList.remove('walker--hop');
      showControls(true);
      locked = false;
      placed = false;
      // 배치가 잡힌 다음 프레임에 좌표를 잰다
      requestAnimationFrame(() => {
        place();
        start();
      });
    },

    isEnabled() {
      return enabled;
    },

    /** 잠그면 더 움직이지도 고르지도 못한다. 조작부도 함께 치운다 */
    setLocked(value) {
      locked = Boolean(value);
      // CSS 선택자로 숨기지 않는다 — 조작부는 화면에 띄운(fixed) 요소라
      // 어느 화면의 자손도 아니다. 잠금은 워커가 아는 상태이므로 여기서 처리한다
      showControls(enabled && !locked);
      if (locked) stop();
      else start();
    },

    /** 손가락 확정 버튼이 부른다. 키보드의 Enter와 같은 일을 한다 */
    confirm() {
      pick();
    },

    /** 지금 발밑에 있는 요소. 아무것도 없으면 null */
    standingElement() {
      return enabled ? underFoot : null;
    },

    /**
     * 화면이 스크롤되면 캐릭터는 그대로인데 발밑이 바뀐다.
     * 루프는 서 있는 동안 멈춰 있으므로 여기서 한 번 다시 본다.
     */
    refresh() {
      if (!enabled || !placed) return;
      render();
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
      start();
    },

    /**
     * 화면이 받은 키를 넘겨준다. 처리했으면 true.
     * 방향키는 «눌린 상태»로만 기록하고 실제 이동은 루프가 한다.
     */
    handleKey(event) {
      if (!enabled || isBlocked()) return false;

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
