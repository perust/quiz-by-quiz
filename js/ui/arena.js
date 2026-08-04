// 게임 모드 무대
//
// 바닥을 십자로 나눈 2×2 칸 위를 캐릭터가 **자유롭게 돌아다닌다.**
// 칸 단위로 튀는 것이 아니라 방향키를 누르는 동안 조금씩 움직이고,
// 지금 밟고 있는 칸에 불이 들어온다. 시간이 다 되면 **그때 서 있는 칸이 답**이다.
//
//   ┌─────┬─────┐
//   │  1  │  2  │
//   ├──── ● ────┤   ← 십자 한가운데에서 시작한다. 여기는 «아무 칸도 아님»
//   │  3  │  4  │
//   └─────┴─────┘
//
// 가운데에서 시작하는 것이 중요하다. 가만히 있으면 아무 칸도 밟지 않은 채로
// 시간이 끝나 지금까지처럼 시간 초과 오답이 된다. 보통 모드와 난이도가 같아지고,
// 두 모드가 같은 랭킹에 쌓여도 공정하다.
//
// **게임 규칙은 갖지 않는다.** 몇 번이 정답인지 판단하지 않고, 밟고 있는 칸 번호를
// 넘길 뿐이다. 채점은 core/session.js가 한다. 정답 표시도 스스로 정하지 않고
// quiz.js가 알려준 인덱스를 그대로 칠한다.
//
// 진짜 조작 대상은 위 패널의 보기 버튼이다. 무대는 aria-hidden이라 같은 보기를
// 두 번 낭독하지 않는다. 그래서 이 무대를 꺼도 게임을 온전히 할 수 있다.

/** 초당 이동 거리(px). 바닥을 가로지르는 데 1초 남짓 걸린다 */
const SPEED = 320;

/** 프레임 간격이 이보다 벌어지면 잘라낸다. 탭이 백그라운드에 갔다 오면 크게 튄다 */
const MAX_STEP_MS = 50;

/** 바닥 안쪽 여백. 캐릭터가 바닥 밖으로 나가지 않게 막는 값이다 */
const EDGE = 7;

/** 눌러서 걸어갈 때 «도착했다»고 보는 거리 */
const ARRIVE_PX = 4;

/** 이보다 조금 밀린 것은 손 떨림으로 보고 무시한다 */
const STICK_DEADZONE = 5;

/**
 * 방향키 → (dx, dy). 두 개를 함께 누르면 대각선이 된다.
 * 칸을 세지 않는다 — 자유롭게 움직이고 «발이 어느 칸에 있는지»만 본다.
 * 그래서 바닥을 2×2가 아닌 다른 모양으로 깔아도 이 코드는 그대로 맞는다.
 */
const DIRECTIONS = {
  ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
  ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
  ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
};

const PICK_KEYS = ['Enter', ' '];

/**
 * @param {{ onChoose: (index: number) => void,
 *           trapFocus: (container: HTMLElement, event: KeyboardEvent) => void }} deps
 */
export function createArena({ onChoose, trapFocus }) {
  const el = {
    root: document.getElementById('arena'),
    character: document.getElementById('arena-character'),
    tiles: document.getElementById('arena-tiles'),
    stick: document.getElementById('arena-stick'),
    knob: document.getElementById('arena-knob'),
    help: document.getElementById('arena-help'),
    helpDialog: document.getElementById('help-dialog'),
    helpClose: document.getElementById('help-close'),
  };

  /** 켜져 있는가. 꺼져 있으면 키 입력도 받지 않는다 */
  let enabled = false;
  /** 답을 낸 뒤에는 더 고를 수 없다 (FR-3.3을 화면에서도 지킨다) */
  let locked = true;

  /** 무대 기준 «발» 좌표 */
  const pos = { x: 0, y: 0 };
  /** 지금 밟고 있는 칸. 십자 틈에 있으면 null — 아무것도 고르지 않은 상태다 */
  let standing = null;
  /** 무대 기준 칸 사각형. 화면 폭에 따라 달라지므로 다시 잰다 */
  let tileBoxes = [];
  let stageSize = { width: 0, height: 0 };
  /**
   * 이번 문항에서 캐릭터를 십자 한가운데에 세웠는가.
   * 화면이 아직 보이지 않으면 크기를 0으로 재게 되어 자리를 잡을 수 없다.
   * 그때는 이 값이 false로 남아, 어느 경로로 들어오든 다시 세운다.
   */
  let placed = false;

  /** 움직임 루프 */
  let frameId = null;
  let lastTs = 0;
  /** 바닥을 눌렀을 때 걸어갈 지점. 방향키를 누르면 취소된다 */
  let autoTarget = null;

  const tileNodes = [];

  /**
   * 지금 눌려 있는 방향키. 대각선은 «두 방향을 같이 누른 상태»로 판정한다.
   * 창을 벗어나면 keyup을 놓칠 수 있어 blur에서 비운다.
   */
  const held = new Set();

  /**
   * 스틱을 민 방향과 세기. -1 ~ 1 이고 길이가 곧 속도 비율이다.
   * 방향키는 켜짐/꺼짐뿐이지만 스틱은 살살 밀면 천천히 움직인다.
   */
  const stick = { x: 0, y: 0 };
  /** 스틱을 잡고 있는 포인터. 손가락 두 개가 엉키지 않게 하나만 받는다 */
  let stickPointerId = null;

  /** 도움말을 연 버튼. 닫을 때 포커스를 되돌려 준다 */
  let helpOpener = null;

  // ── 도움말 ─────────────────────────────────────────────────────
  // 조작법을 무대에 늘 펼쳐두면 세로를 너무 먹어 대화상자로 옮겼다.
  // 나가기 확인과 같은 인페이지 방식이다 — window.alert는 쓰지 않는다.

  function openHelp() {
    if (!enabled) return;
    helpOpener = document.activeElement;
    el.helpDialog.hidden = false;
    el.helpClose.focus();
  }

  function closeHelp() {
    if (el.helpDialog.hidden) return;
    el.helpDialog.hidden = true;
    // 열기 전에 있던 자리로 포커스를 돌려준다
    if (helpOpener && document.contains(helpOpener)) helpOpener.focus();
    helpOpener = null;
  }

  // ── 잠금 ───────────────────────────────────────────────────────

  /** 답을 낸 뒤에는 바닥이 눌리지 않는다는 것을 눈으로도 알린다 */
  function setLocked(value) {
    locked = value;
    el.root.classList.toggle('arena--locked', value);
    if (value) stopLoop();
  }

  // ── 무대 재기 ──────────────────────────────────────────────────

  /**
   * 칸 사각형을 무대 기준 좌표로 다시 잰다.
   * 칸 크기는 화면 폭에 따라 달라지므로 값을 저장해 두지 않고 필요할 때마다 잰다.
   */
  function measure() {
    const stage = el.character.parentElement;
    if (!stage) return;

    const base = stage.getBoundingClientRect();
    if (base.width === 0) return; // 아직 배치되지 않았다

    stageSize = { width: base.width, height: base.height };
    tileBoxes = tileNodes.map((tile) => {
      const box = tile.getBoundingClientRect();
      return {
        left: box.left - base.left,
        top: box.top - base.top,
        right: box.right - base.left,
        bottom: box.bottom - base.top,
      };
    });
  }

  /** 발이 놓인 칸. 십자 틈에 있으면 null */
  function zoneAt(x, y) {
    for (let index = 0; index < tileBoxes.length; index += 1) {
      const box = tileBoxes[index];
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return index;
    }
    return null;
  }

  function clampPosition() {
    if (stageSize.width === 0) return; // 아직 크기를 재지 못했다

    const half = el.character.offsetWidth / 2;
    const height = el.character.offsetHeight;
    pos.x = Math.min(Math.max(pos.x, EDGE + half), stageSize.width - EDGE - half);
    // 머리가 바닥 위로 솟지 않도록 위쪽은 캐릭터 높이만큼 띄운다
    pos.y = Math.min(Math.max(pos.y, EDGE + height), stageSize.height - EDGE);
  }

  /** 좌표를 화면에 반영하고, 밟은 칸이 바뀌었으면 불을 옮긴다 */
  function render() {
    el.character.style.transform =
      `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`;

    const zone = zoneAt(pos.x, pos.y);
    if (zone === standing) return;
    standing = zone;
    tileNodes.forEach((tile, index) => {
      tile.classList.toggle('arena-tile--lit', index === standing);
    });
  }

  /** 캐릭터를 십자 한가운데에 세운다. 아무 칸도 밟지 않은 상태가 된다 */
  function placeAtCenter() {
    measure();
    if (stageSize.width === 0) return; // 아직 크기를 얻지 못했다. placed는 false로 남는다

    pos.x = stageSize.width / 2;
    pos.y = stageSize.height / 2;
    clampPosition();
    render();
    placed = true;
  }

  // ── 이동 스틱 ──────────────────────────────────────────────────

  function releaseStick() {
    stickPointerId = null;
    stick.x = 0;
    stick.y = 0;
    el.knob.style.translate = '';
  }

  /**
   * 손잡이가 밀려날 수 있는 최대 거리. 여기까지 밀면 최고 속도가 된다.
   * 값을 박아두지 않고 크기에서 뽑는다 — 짧은 화면에서 스틱이 작아지기 때문이다.
   */
  function stickRadius() {
    return (el.stick.offsetWidth - el.knob.offsetWidth) / 2;
  }

  function updateStick(event) {
    const radius = stickRadius();
    const box = el.stick.getBoundingClientRect();
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
    el.knob.style.translate = `${kx}px ${ky}px`;

    autoTarget = null; // 손으로 미는 쪽이 우선이다
    startLoop();
  }

  el.stick.addEventListener('pointerdown', (event) => {
    if (!enabled || locked) return;
    event.preventDefault();
    stickPointerId = event.pointerId;
    el.stick.setPointerCapture(event.pointerId);
    updateStick(event);
  });

  el.stick.addEventListener('pointermove', (event) => {
    if (event.pointerId !== stickPointerId) return;
    updateStick(event);
  });

  // 손을 떼거나 통화 등으로 입력이 끊기면 제자리로 돌린다
  el.stick.addEventListener('pointerup', releaseStick);
  el.stick.addEventListener('pointercancel', releaseStick);

  // ── 움직임 ─────────────────────────────────────────────────────

  /** 스틱과 방향키를 합쳐 방향을 만든다. 대각선은 여기서 생긴다 */
  function velocity() {
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

  function loop(ts) {
    frameId = null;
    if (!enabled || locked) return;

    // 화면이 아직 보이지 않을 때 켜면 무대 크기가 0으로 잡혀 자리를 잡지 못한다.
    // 잡을 때까지 다음 프레임에 다시 시도한다.
    if (!placed) {
      placeAtCenter();
      lastTs = ts;
      frameId = requestAnimationFrame(loop);
      return;
    }

    const dt = Math.min(ts - lastTs, MAX_STEP_MS) / 1000;
    lastTs = ts;

    let [vx, vy] = velocity();
    const pressing = vx !== 0 || vy !== 0;

    if (pressing) {
      autoTarget = null; // 방향키가 우선이다
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
    el.character.classList.toggle('arena__character--walking', moving);

    if (moving) {
      pos.x += vx * SPEED * dt;
      pos.y += vy * SPEED * dt;
      clampPosition();
      render();
    }

    frameId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (frameId !== null || !enabled || locked) return;
    lastTs = performance.now();
    frameId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    el.character.classList.remove('arena__character--walking');
  }

  // ── 고르기 ─────────────────────────────────────────────────────

  function pick() {
    // 십자 틈에 서 있으면 고를 것이 없다
    if (!enabled || locked || standing === null) return;
    el.character.classList.add('arena__character--hop');
    onChoose(standing);
  }

  /** 바닥을 누르면 그 칸 한가운데로 걸어간 뒤 고른다 */
  function goAndPick(index) {
    if (!enabled || locked) return;
    const box = tileBoxes[index];
    if (!box) return;

    autoTarget = {
      x: (box.left + box.right) / 2,
      // 칸 아래쪽을 딛도록 한다. 번호·채점 표시가 있는 위쪽을 피한다
      y: box.bottom - 10,
    };
    held.clear();   // 손가락으로 눌렀으면 눌린 방향키는 무시한다
    releaseStick(); // 스틱도 놓은 것으로 본다
    startLoop();
  }

  // ── 바닥 만들기 ────────────────────────────────────────────────

  function buildTiles(nextCount) {
    el.tiles.replaceChildren();
    tileNodes.length = 0;

    for (let index = 0; index < nextCount; index += 1) {
      const tile = document.createElement('div');
      tile.className = 'arena-tile';

      const number = document.createElement('span');
      number.className = 'arena-tile__number';
      number.textContent = String(index + 1);

      const mark = document.createElement('span');
      mark.className = 'arena-tile__mark';

      tile.append(number, mark);
      // 포인터 이벤트를 쓴다. 터치에서 클릭보다 반응이 빠르다
      tile.addEventListener('pointerdown', () => goAndPick(index));

      el.tiles.append(tile);
      tileNodes.push(tile);
    }
  }

  // ── 입력 ───────────────────────────────────────────────────────

  el.help.addEventListener('click', openHelp);
  el.helpClose.addEventListener('click', closeHelp);

  // 눌린 방향키를 따라간다. 처리는 handleKey에서 하고 여기서는 상태만 둔다
  document.addEventListener('keyup', (event) => held.delete(event.key));
  window.addEventListener('blur', () => held.clear());

  // 칸 크기가 바뀌면 좌표계를 다시 잡는다. 캐릭터는 비율을 지켜 옮긴다
  window.addEventListener('resize', () => {
    if (!enabled) return;

    // 아직 자리를 잡지 못했으면 여기서 세운다. 그냥 클램프만 하면
    // (0,0)이 1번 칸 쪽으로 밀려 시작부터 한 칸을 밟은 셈이 된다
    if (!placed) {
      placeAtCenter();
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
  });

  return {
    /** 게임 모드를 켜고 끈다 */
    setEnabled(value) {
      enabled = Boolean(value);
      el.root.hidden = !enabled;
      held.clear();
      releaseStick();
      autoTarget = null;
      placed = false;

      if (!enabled) {
        stopLoop();
        closeHelp(); // 무대가 사라지면 도움말도 함께 닫는다
        return;
      }
      placeAtCenter();
      startLoop();
    },

    isEnabled() {
      return enabled;
    },

    /**
     * 새 문항을 위해 바닥을 다시 깐다.
     * 캐릭터는 **십자 한가운데**로 돌아간다. 지난 문항에서 서 있던 자리가 남아 있으면
     * 가만히 있어도 답이 나가버려, 아무것도 하지 않은 사람이 25%를 거저 얻는다.
     * @param {number} choiceCount
     */
    reset(choiceCount) {
      autoTarget = null;
      held.clear();
      releaseStick();
      standing = null;
      placed = false;
      setLocked(false);

      el.character.classList.remove('arena__character--hop', 'arena__character--sad');
      buildTiles(choiceCount);

      if (!enabled) return;
      // 바닥을 방금 붙였으므로 배치가 잡힌 다음 프레임에 좌표를 잰다
      requestAnimationFrame(() => {
        placeAtCenter();
        startLoop();
      });
    },

    /**
     * 지금 밟고 있는 칸. 아무 칸도 아니면 null.
     * 시간이 다 됐을 때 퀴즈 화면이 이 값을 답으로 넘긴다.
     */
    standingIndex() {
      return enabled ? standing : null;
    },

    /**
     * 채점 결과를 바닥에 칠한다. 무엇이 정답인지는 quiz.js가 알려준다.
     * @param {{ answerIndex: number, chosenIndex: number|null, correct: boolean }} outcome
     */
    showOutcome({ answerIndex, chosenIndex, correct }) {
      setLocked(true);
      autoTarget = null;
      releaseStick();

      tileNodes.forEach((tile, index) => {
        // 채점 뒤에는 «밟고 있는 칸» 불을 끈다. 정답·오답 표시와 섞이면
        // 아무 칸도 안 밟은 경우에 엉뚱한 칸이 골라진 것처럼 보인다.
        // 어디 서 있는지는 캐릭터가 이미 알려준다.
        tile.classList.remove('arena-tile--lit');

        if (index === answerIndex) tile.classList.add('arena-tile--correct');
        else if (index === chosenIndex) tile.classList.add('arena-tile--wrong');
        else tile.classList.add('arena-tile--muted');
      });

      // 아무 칸도 밟지 않은 채 시간이 끝났으면 캐릭터는 그대로 둔다
      if (chosenIndex === null) return;
      el.character.classList.toggle('arena__character--sad', !correct);
    },

    /** 도움말이 열려 있는가. 뒤에서 포커스를 빼앗지 않으려고 퀴즈 화면이 물어본다 */
    isDialogOpen() {
      return !el.helpDialog.hidden;
    },

    /**
     * 도움말이 열려 있는 동안의 키 입력. 처리했으면 true를 돌려주고,
     * 퀴즈 화면은 거기서 멈춘다 — 안 그러면 뒤에서 숫자키로 답이 제출된다.
     */
    handleDialogKey(event) {
      if (el.helpDialog.hidden) return false;

      if (event.key === 'Escape') closeHelp();
      else if (event.key === 'Tab') trapFocus(el.helpDialog, event);
      return true;
    },

    /**
     * 퀴즈 화면이 받은 키를 넘겨준다. 처리했으면 true.
     * 방향키는 여기서 «눌린 상태»로만 기록하고 실제 이동은 움직임 루프가 한다.
     */
    handleKey(event) {
      if (!enabled) return false;

      if (DIRECTIONS[event.key]) {
        // 잠겨 있어도 눌린 키는 기록해 둔다. 안 그러면 다음 문항에서 유령 방향이 생긴다
        held.add(event.key);
        if (locked) return false;
        startLoop();
        return true; // 화면이 스크롤되지 않게 막는다
      }

      if (locked) return false;

      if (PICK_KEYS.includes(event.key)) {
        if (document.activeElement?.closest('.choice, .arena__help')) return false;
        pick();
        return true;
      }
      return false;
    },
  };
}
