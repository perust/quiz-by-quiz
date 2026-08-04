// 게임 모드 무대
//
// 캐릭터를 좌우로 움직여 1~4번 바닥을 밟아 보기를 고른다.
//
// **게임 규칙은 갖지 않는다.** 몇 번이 정답인지 판단하지 않고, 고른 번호를
// onChoose로 넘길 뿐이다. 채점은 core/session.js가 한다. 정답 표시도 스스로
// 정하지 않고 quiz.js가 알려준 인덱스를 그대로 칠한다.
//
// 진짜 조작 대상은 위 패널의 보기 버튼이다. 스크린리더와 Tab 사용자는 그쪽을
// 쓰고, 여기 타일은 aria-hidden이라 같은 보기를 두 번 낭독하지 않는다.
// 그래서 이 무대를 꺼도 게임을 온전히 할 수 있다.

/** 캐릭터가 한 칸 옮겨가는 데 걸리는 시간. CSS transition과 같아야 한다 */
const WALK_MS = 220;

const LEFT_KEYS = ['ArrowLeft', 'a', 'A'];
const RIGHT_KEYS = ['ArrowRight', 'd', 'D'];
const PICK_KEYS = ['Enter', ' ', 'ArrowUp', 'w', 'W'];

/**
 * @param {{ onChoose: (index: number) => void }} callbacks
 */
export function createArena({ onChoose }) {
  const el = {
    root: document.getElementById('arena'),
    character: document.getElementById('arena-character'),
    tiles: document.getElementById('arena-tiles'),
    left: document.getElementById('arena-left'),
    right: document.getElementById('arena-right'),
    pick: document.getElementById('arena-pick'),
  };

  /** 켜져 있는가. 꺼져 있으면 키 입력도 받지 않는다 */
  let enabled = false;
  /** 지금 서 있는 바닥. 문제가 바뀌어도 그 자리에 남는다 */
  let position = 0;
  /** 이번 문항의 바닥 개수 */
  let count = 0;
  /** 답을 낸 뒤에는 더 고를 수 없다 (FR-3.3을 화면에서도 지킨다) */
  let locked = true;
  /** 걷는 표시를 끄는 타이머 */
  let walkTimer = null;
  /** 바닥을 눌러 이동한 뒤 자동으로 고르기 위한 타이머 */
  let pickTimer = null;

  const tileNodes = [];

  /** 답을 낸 뒤에는 조작부가 눌리지 않는다는 것을 눈으로도 알린다 */
  function setLocked(value) {
    locked = value;
    el.root.classList.toggle('arena--locked', value);
    [el.left, el.right, el.pick].forEach((button) => {
      button.disabled = value;
    });
  }

  // ── 캐릭터 위치 ────────────────────────────────────────────────

  /**
   * 캐릭터를 지금 서 있는 바닥의 한가운데로 옮긴다.
   * 타일 폭은 화면 크기에 따라 달라지므로 값을 저장하지 않고 매번 잰다.
   * 여백 설정에 기대지 않도록 무대 기준 좌표를 직접 잰다.
   */
  function placeCharacter() {
    const tile = tileNodes[position];
    const stage = el.character.parentElement;
    if (!tile || !stage) return;

    const base = stage.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    if (box.width === 0) return; // 아직 배치되지 않았다

    const center = box.left - base.left + box.width / 2;
    el.character.style.transform = `translateX(${center}px) translateX(-50%)`;
  }

  function markActive() {
    tileNodes.forEach((tile, index) => {
      tile.classList.toggle('arena-tile--active', index === position);
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
    markActive();
    placeCharacter();
  }

  function step(delta) {
    if (!enabled || locked) return;
    moveTo(position + delta);
  }

  // ── 고르기 ─────────────────────────────────────────────────────

  function pick() {
    if (!enabled || locked || count === 0) return;
    el.character.classList.add('arena__character--hop');
    onChoose(position);
  }

  /** 바닥을 직접 누르면 그 자리까지 걸어가서 고른다. 한 번 누르면 끝난다 */
  function goAndPick(index) {
    if (!enabled || locked) return;
    const walking = index !== position;
    moveTo(index);

    clearTimeout(pickTimer);
    if (!walking) {
      pick();
      return;
    }
    // 걸어가는 모습을 보여준 뒤에 고른다. 그동안에도 시간은 계속 흐른다
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

  el.left.addEventListener('click', () => step(-1));
  el.right.addEventListener('click', () => step(1));
  el.pick.addEventListener('click', () => pick());

  // 타일 폭이 바뀌면 캐릭터도 따라가야 한다
  window.addEventListener('resize', placeCharacter);

  return {
    /** 게임 모드를 켜고 끈다 */
    setEnabled(value) {
      enabled = Boolean(value);
      el.root.hidden = !enabled;
      if (enabled) placeCharacter();
    },

    isEnabled() {
      return enabled;
    },

    /**
     * 새 문항을 위해 바닥을 다시 깐다.
     * 캐릭터는 서 있던 자리에 남는다 — 그 자리에서 다음 답까지 걸어가는 것이 이 모드의 재미다.
     * @param {number} choiceCount
     */
    reset(choiceCount) {
      clearTimeout(pickTimer);
      count = choiceCount;
      setLocked(false);

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
        // 채점 뒤에는 «서 있는 자리» 강조를 뺀다. 정답·오답 표시와 섞이면
        // 시간 초과처럼 아무것도 안 고른 경우에 엉뚱한 바닥이 골라진 것처럼 보인다.
        // 어디 서 있는지는 캐릭터가 이미 알려준다.
        tile.classList.remove('arena-tile--active');

        if (index === answerIndex) tile.classList.add('arena-tile--correct');
        else if (index === chosenIndex) tile.classList.add('arena-tile--wrong');
        else tile.classList.add('arena-tile--muted');
      });

      // 시간 초과면 캐릭터가 아무 바닥에도 서 있지 않은 셈이라 그대로 둔다
      if (chosenIndex === null) return;
      el.character.classList.toggle('arena__character--sad', !correct);
    },

    /**
     * 퀴즈 화면이 받은 키를 넘겨준다. 처리했으면 true.
     * 보기 버튼에 포커스가 있을 때는 확정 키를 가로채지 않는다 —
     * 그건 버튼 자체가 처리해야 할 입력이다.
     */
    handleKey(event) {
      if (!enabled || locked) return false;

      if (LEFT_KEYS.includes(event.key)) {
        step(-1);
        return true;
      }
      if (RIGHT_KEYS.includes(event.key)) {
        step(1);
        return true;
      }
      if (PICK_KEYS.includes(event.key)) {
        if (document.activeElement?.closest('.choice, .pad-button')) return false;
        pick();
        return true;
      }
      return false;
    },
  };
}
