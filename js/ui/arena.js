// 게임 모드 무대
//
// 바닥을 십자로 나눈 2×2 칸 위에서 캐릭터를 8방향으로 움직여 보기를 고른다.
// 서 있는 칸에는 불이 들어온다.
//
//   ┌─────┬─────┐
//   │  1  │  2  │
//   ├─────┼─────┤
//   │  3  │  4  │
//   └─────┴─────┘
//
// **게임 규칙은 갖지 않는다.** 몇 번이 정답인지 판단하지 않고, 고른 번호를
// onChoose로 넘길 뿐이다. 채점은 core/session.js가 한다. 정답 표시도 스스로
// 정하지 않고 quiz.js가 알려준 인덱스를 그대로 칠한다.
//
// 진짜 조작 대상은 위 패널의 보기 버튼이다. 스크린리더와 Tab 사용자는 그쪽을
// 쓰고, 여기 무대는 aria-hidden이라 같은 보기를 두 번 낭독하지 않는다.
// 그래서 이 무대를 꺼도 게임을 온전히 할 수 있다.

/** 캐릭터가 옮겨가는 데 걸리는 시간. CSS transition과 같아야 한다 */
const WALK_MS = 220;

/** 바닥을 몇 줄로 나눌지. 보기가 4개라 2×2가 된다 */
const COLUMNS = 2;

/** 방향키 → (dx, dy). 두 개를 함께 누르면 대각선이 된다 */
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
    help: document.getElementById('arena-help'),
    helpDialog: document.getElementById('help-dialog'),
    helpClose: document.getElementById('help-close'),
  };

  /** 켜져 있는가. 꺼져 있으면 키 입력도 받지 않는다 */
  let enabled = false;
  /** 지금 서 있는 칸. 문제가 바뀌어도 그 자리에 남는다 */
  let position = 0;
  /** 이번 문항의 칸 개수 */
  let count = 0;
  /** 답을 낸 뒤에는 더 고를 수 없다 (FR-3.3을 화면에서도 지킨다) */
  let locked = true;
  /** 걷는 표시를 끄는 타이머 */
  let walkTimer = null;
  /** 바닥을 눌러 이동한 뒤 자동으로 고르기 위한 타이머 */
  let pickTimer = null;

  const tileNodes = [];

  /**
   * 지금 눌려 있는 방향키. 대각선은 «두 방향을 같이 누른 상태»로 판정한다.
   * 창을 벗어나면 keyup을 놓칠 수 있어 blur에서 비운다.
   */
  const held = new Set();

  /** 도움말을 연 버튼. 닫을 때 포커스를 되돌려 준다 */
  let helpOpener = null;

  // ── 도움말 ─────────────────────────────────────────────────────
  // 조작법을 무대에 늘 펼쳐두면 세로를 너무 먹어 대화상자로 옮겼다.
  // 나가기 확인과 같은 인페이지 방식이다 — window.alert는 쓰지 않는다.

  function openHelp() {
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
  }

  // ── 캐릭터 위치 ────────────────────────────────────────────────

  /**
   * 캐릭터를 지금 서 있는 칸의 한가운데로 옮긴다.
   * 칸 크기는 화면 폭에 따라 달라지므로 값을 저장하지 않고 매번 잰다.
   * 여백 설정에 기대지 않도록 무대 기준 좌표를 직접 잰다.
   */
  function placeCharacter() {
    const tile = tileNodes[position];
    const stage = el.character.parentElement;
    if (!tile || !stage) return;

    const base = stage.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    if (box.width === 0) return; // 아직 배치되지 않았다

    // 발을 칸 아래쪽에 붙인다. 번호와 채점 표시는 칸 위쪽에 있으므로
    // 칸이 좁아져도 서로 겹치지 않는다. 칸 높이가 바뀌어도 그대로 맞는다.
    const x = box.left - base.left + box.width / 2;
    const y = box.bottom - base.top - 10;
    el.character.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }

  /** 서 있는 칸에 불을 켠다 */
  function lightCurrent() {
    tileNodes.forEach((tile, index) => {
      tile.classList.toggle('arena-tile--lit', index === position);
    });
  }

  function startWalkEffect() {
    el.character.classList.add('arena__character--walking');
    clearTimeout(walkTimer);
    walkTimer = setTimeout(() => {
      el.character.classList.remove('arena__character--walking');
    }, WALK_MS);
  }

  /**
   * @param {number} index
   * @param {boolean} [animate] 문항이 바뀌어 자리를 다시 잡을 때는 걷지 않는다
   */
  function moveTo(index, animate = true) {
    if (count === 0) return;
    const next = Math.max(0, Math.min(index, count - 1));
    const moved = next !== position;
    position = next;

    if (animate && moved) startWalkEffect();
    lightCurrent();
    placeCharacter();
  }

  /**
   * 8방향 이동. 가로와 세로를 따로 잘라내면 대각선이 저절로 나온다.
   * 칸 밖으로는 나가지 않고, 없는 칸(보기가 4개보다 적을 때)은 벽처럼 막는다.
   *
   * @param {number} dx -1 · 0 · 1
   * @param {number} dy -1 · 0 · 1
   */
  function step(dx, dy) {
    if (!enabled || locked || count === 0) return;

    const rows = Math.ceil(count / COLUMNS);
    const col = Math.min(Math.max((position % COLUMNS) + dx, 0), COLUMNS - 1);
    const row = Math.min(Math.max(Math.floor(position / COLUMNS) + dy, 0), rows - 1);

    const target = row * COLUMNS + col;
    if (target >= count) return; // 비어 있는 자리에는 들어가지 않는다
    moveTo(target);
  }

  /** 지금 눌려 있는 키들을 합쳐 방향을 만든다. 대각선은 여기서 생긴다 */
  function directionFromHeld(key) {
    let [dx, dy] = DIRECTIONS[key];
    for (const other of held) {
      const paired = DIRECTIONS[other];
      if (!paired || other === key) continue;
      if (paired[0] !== 0 && dx === 0) [dx] = paired;
      if (paired[1] !== 0 && dy === 0) [, dy] = paired;
    }
    return [dx, dy];
  }

  // ── 고르기 ─────────────────────────────────────────────────────

  function pick() {
    if (!enabled || locked || count === 0) return;
    el.character.classList.add('arena__character--hop');
    onChoose(position);
  }

  /** 바닥을 직접 누르면 그 칸까지 건너간 뒤 고른다. 한 번 누르면 끝난다 */
  function goAndPick(index) {
    if (!enabled || locked) return;
    const walking = index !== position;
    moveTo(index);

    clearTimeout(pickTimer);
    if (!walking) {
      pick();
      return;
    }
    // 옮겨가는 모습을 보여준 뒤에 고른다. 그동안에도 시간은 계속 흐른다
    pickTimer = setTimeout(pick, WALK_MS);
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

  // 칸 크기가 바뀌면 캐릭터도 따라가야 한다
  window.addEventListener('resize', placeCharacter);

  return {
    /** 게임 모드를 켜고 끈다 */
    setEnabled(value) {
      enabled = Boolean(value);
      el.root.hidden = !enabled;
      held.clear();
      if (!enabled) closeHelp(); // 무대가 사라지면 도움말도 함께 닫는다
      if (enabled) placeCharacter();
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

    isEnabled() {
      return enabled;
    },

    /**
     * 새 문항을 위해 바닥을 다시 깐다.
     * 캐릭터는 서 있던 자리에 남는다 — 그 자리에서 다음 답까지 건너가는 것이 이 모드의 재미다.
     * @param {number} choiceCount
     */
    reset(choiceCount) {
      clearTimeout(pickTimer);
      count = choiceCount;
      setLocked(false);
      held.clear();

      el.character.classList.remove('arena__character--hop', 'arena__character--sad');
      buildTiles(choiceCount);
      moveTo(Math.min(position, choiceCount - 1), false);

      if (!enabled) return;
      // 바닥을 방금 붙였으므로 배치가 잡힌 다음 프레임에 위치를 다시 잰다
      requestAnimationFrame(placeCharacter);
    },

    /**
     * 채점 결과를 바닥에 칠한다. 무엇이 정답인지는 quiz.js가 알려준다.
     * @param {{ answerIndex: number, chosenIndex: number|null, correct: boolean }} outcome
     */
    showOutcome({ answerIndex, chosenIndex, correct }) {
      setLocked(true);
      clearTimeout(pickTimer);

      tileNodes.forEach((tile, index) => {
        // 채점 뒤에는 «서 있는 칸» 불을 끈다. 정답·오답 표시와 섞이면
        // 시간 초과처럼 아무것도 안 고른 경우에 엉뚱한 칸이 골라진 것처럼 보인다.
        // 어디 서 있는지는 캐릭터가 이미 알려준다.
        tile.classList.remove('arena-tile--lit');

        if (index === answerIndex) tile.classList.add('arena-tile--correct');
        else if (index === chosenIndex) tile.classList.add('arena-tile--wrong');
        else tile.classList.add('arena-tile--muted');
      });

      // 시간 초과면 캐릭터가 아무 칸도 고르지 않은 셈이라 그대로 둔다
      if (chosenIndex === null) return;
      el.character.classList.toggle('arena__character--sad', !correct);
    },

    /**
     * 퀴즈 화면이 받은 키를 넘겨준다. 처리했으면 true.
     * 보기 버튼이나 조작부에 포커스가 있을 때는 확정 키를 가로채지 않는다 —
     * 그건 버튼 자체가 처리해야 할 입력이다.
     */
    handleKey(event) {
      if (!enabled) return false;

      if (DIRECTIONS[event.key]) {
        // 잠겨 있어도 눌린 키는 기록해 둔다. 안 그러면 다음 문항에서 유령 대각선이 생긴다
        const [dx, dy] = directionFromHeld(event.key);
        held.add(event.key);
        if (locked) return false;
        step(dx, dy);
        return true;
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
