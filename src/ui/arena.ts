// 게임 모드 무대
//
// 바닥을 십자로 나눈 2×2 칸 위를 캐릭터가 자유롭게 돌아다닌다.
// 밟고 있는 칸에 불이 들어오고, 시간이 다 되면 **그때 서 있는 칸이 답**이다.
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
// 걷는 일은 ui/walker.js가 한다. 여기서는 «몇 번 칸 = 몇 번 보기»만 잇는다.
//
// **게임 규칙은 갖지 않는다.** 몇 번이 정답인지 판단하지 않고, 밟고 있는 칸 번호를
// 넘길 뿐이다. 채점은 core/session.js가 한다.
//
// 진짜 조작 대상은 위 패널의 보기 버튼이다. 무대는 aria-hidden이라 같은 보기를
// 두 번 낭독하지 않는다. 그래서 이 무대를 꺼도 게임을 온전히 할 수 있다.

import { need } from '../dom.js';
import { createWalker } from './walker.js';
import { paintCharacter } from './sprite.js';

export interface ArenaDeps {
  onChoose: (index: number) => void;
  /**
   * 위 패널의 보기 버튼들. 캐릭터가 그 위에 서도 같은 번호로 본다.
   *
   * 배열이 아니라 «훑을 수 있는 것»으로 받는다 — 퀴즈 화면은 `querySelectorAll`의
   * 결과(`NodeListOf`)를 그대로 넘기고, 여기서는 펼쳐 자리만 찾으므로 굳이 배열로
   * 만들 이유가 없다. 배열로 좁히면 넘기는 쪽이 없던 `Array.from`을 불러야 한다
   */
  getChoiceNodes: () => Iterable<Element>;
  trapFocus: (container: HTMLElement, event: KeyboardEvent) => void;
}

/** 채점 결과. 무엇이 정답인지는 quiz.js가 알려준다 */
export interface ArenaOutcome {
  answerIndex: number;
  /** null 이면 아무 칸도 밟지 않은 채 시간이 끝난 것이다 */
  chosenIndex: number | null;
  correct: boolean;
}

export interface Arena {
  /** 게임 모드를 켜고 끈다 */
  setEnabled(value: boolean): void;
  isEnabled(): boolean;
  /** 쓰고 있는 캐릭터를 갈아 끼운다. id 가 없으면 기본 캐릭터가 된다 */
  setCharacter(id?: string | null): void;
  /** 새 문항을 위해 바닥을 다시 깐다 */
  reset(choiceCount: number): void;
  /** 더 움직이지도 고르지도 못하게 잠근다 */
  lock(): void;
  /** 지금 밟고 있는 칸. 아무 칸도 아니면 null */
  standingIndex(): number | null;
  /** 채점 결과를 바닥에 칠한다 */
  showOutcome(outcome: ArenaOutcome): void;
  /** 도움말이 열려 있는가 */
  isDialogOpen(): boolean;
  /** 도움말을 닫는다. 퀴즈 화면을 떠날 때 부른다 */
  closeDialog(): void;
  /** 도움말이 열려 있는 동안의 키 입력. 처리했으면 true */
  handleDialogKey(event: KeyboardEvent): boolean;
  /** 퀴즈 화면이 받은 키를 넘겨준다. 처리했으면 true */
  handleKey(event: KeyboardEvent): boolean;
}

export function createArena({ onChoose, getChoiceNodes, trapFocus }: ArenaDeps): Arena {
  const el = {
    root: need('arena'),
    character: need('arena-character'),
    tiles: need('arena-tiles'),
    help: need('arena-help'),
    helpDialog: need('help-dialog'),
    helpClose: need('help-close'),
  };

  let enabled = false;
  const tileNodes: HTMLElement[] = [];
  /** 도움말을 연 버튼. 닫을 때 포커스를 되돌려 준다 */
  let helpOpener: HTMLElement | null = null;

  const walker = createWalker({
    character: el.character,
    // 무대 밖으로도 걸어 나가 화면의 아무 버튼이나 밟고 누를 수 있다.
    // 답으로 세는 것은 바닥 칸과 위 보기뿐이므로(indexOfNode), 나가기나 ? 위에
    // 서 있다가 시간이 끝나면 아무 칸도 밟지 않은 것이 된다 —
    // 시간 초과의 뜻이 그대로 유지된다
    pickable: '.arena-tile, button, a[href], [role="button"]',
    startAt: () => {
      const box = el.tiles.getBoundingClientRect();
      if (box.width === 0) return null;
      // 십자 한가운데(중립). 칸 사이 틈이라 아무 칸도 밟지 않은 자리다
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    },
  });

  /** 발밑에 있는 것이 몇 번 보기인가. 바닥 칸이든 위 보기든 같은 번호로 본다 */
  function indexOfNode(node: HTMLElement | null): number | null {
    if (!node) return null;
    const tile = tileNodes.indexOf(node);
    if (tile !== -1) return tile;
    const choice = [...getChoiceNodes()].indexOf(node);
    return choice === -1 ? null : choice;
  }

  // ── 도움말 ─────────────────────────────────────────────────────
  // 조작법을 무대에 늘 펼쳐두면 세로를 너무 먹어 대화상자로 옮겼다.
  // 나가기 확인과 같은 인페이지 방식이다 — window.alert는 쓰지 않는다.

  function openHelp(): void {
    if (!enabled) return;
    // 포커스가 있는 것은 곧 눌린 버튼이라 focus() 를 가진 요소다
    helpOpener = document.activeElement as HTMLElement | null;
    el.helpDialog.hidden = false;
    el.helpClose.focus();
  }

  function closeHelp(): void {
    if (el.helpDialog.hidden) return;
    el.helpDialog.hidden = true;
    // 열기 전에 있던 자리로 포커스를 돌려준다
    if (helpOpener && document.contains(helpOpener)) helpOpener.focus();
    helpOpener = null;
  }

  el.help.addEventListener('click', openHelp);
  el.helpClose.addEventListener('click', closeHelp);

  // ── 바닥 만들기 ────────────────────────────────────────────────

  function buildTiles(count: number): void {
    el.tiles.replaceChildren();
    tileNodes.length = 0;

    for (let index = 0; index < count; index += 1) {
      const tile = document.createElement('div');
      tile.className = 'arena-tile';

      const number = document.createElement('span');
      number.className = 'arena-tile__number';
      number.textContent = String(index + 1);

      const mark = document.createElement('span');
      mark.className = 'arena-tile__mark';

      tile.append(number, mark);
      // 걸어가서 Enter로 고르든 손가락으로 바로 누르든 이 한 곳으로 모인다 —
      // 워커의 «고르기»도 결국 발밑 요소의 click 을 부른다
      tile.addEventListener('click', () => onChoose(index));

      el.tiles.append(tile);
      tileNodes.push(tile);
    }
  }

  return {
    /** 게임 모드를 켜고 끈다 */
    setEnabled(value) {
      enabled = Boolean(value);
      el.root.hidden = !enabled;
      if (!enabled) {
        walker.setEnabled(false);
        closeHelp(); // 무대가 사라지면 도움말도 함께 닫는다
        return;
      }
      walker.setEnabled(true);
    },

    isEnabled() {
      return enabled;
    },

    /** 쓰고 있는 캐릭터를 갈아 끼운다 */
    setCharacter(id) {
      paintCharacter(el.character, id);
    },

    /**
     * 새 문항을 위해 바닥을 다시 깐다.
     * 캐릭터는 **십자 한가운데**로 돌아간다. 지난 문항에서 서 있던 자리가 남아 있으면
     * 가만히 있어도 답이 나가버려, 아무것도 하지 않은 사람이 25%를 거저 얻는다.
     */
    reset(choiceCount) {
      buildTiles(choiceCount);
      el.character.classList.remove('walker--sad');
      if (!enabled) return;

      // reset이 아니라 setEnabled를 부른다. 워커는 한 번에 하나만 켜지므로
      // 홈 워커가 켜지는 순간 이 워커는 꺼져 있다. 문항마다 다시 켜야
      // 캐릭터가 자리를 잡고 스틱도 나타난다.
      walker.setEnabled(true);
    },

    /**
     * 더 움직이지도 고르지도 못하게 잠근다. 조작부도 함께 사라진다.
     *
     * 채점은 showOutcome이 알아서 잠그므로 보통은 부를 일이 없다.
     * 이미 답을 낸 문항에서 게임 모드를 켜는 경우에만 필요하다 —
     * setEnabled가 잠금을 풀어 놓기 때문이다.
     */
    lock() {
      walker.setLocked(true);
    },

    /**
     * 지금 밟고 있는 칸. 아무 칸도 아니면 null.
     * 시간이 다 됐을 때 퀴즈 화면이 이 값을 답으로 넘긴다.
     */
    standingIndex() {
      return enabled ? indexOfNode(walker.standingElement()) : null;
    },

    /** 채점 결과를 바닥에 칠한다. 무엇이 정답인지는 quiz.js가 알려준다 */
    showOutcome({ answerIndex, chosenIndex, correct }) {
      walker.setLocked(true);

      tileNodes.forEach((tile, index) => {
        // 채점 뒤에는 «밟고 있는 칸» 불을 끈다. 정답·오답 표시와 섞이면
        // 아무 칸도 안 밟은 경우에 엉뚱한 칸이 골라진 것처럼 보인다.
        tile.classList.remove('is-standing');

        if (index === answerIndex) tile.classList.add('arena-tile--correct');
        else if (index === chosenIndex) tile.classList.add('arena-tile--wrong');
        else tile.classList.add('arena-tile--muted');
      });

      // 아무 칸도 밟지 않은 채 시간이 끝났으면 캐릭터는 그대로 둔다
      if (chosenIndex === null) return;
      el.character.classList.toggle('walker--sad', !correct);
    },

    /** 도움말이 열려 있는가. 뒤에서 포커스를 빼앗지 않으려고 퀴즈 화면이 물어본다 */
    isDialogOpen() {
      return !el.helpDialog.hidden;
    },

    /**
     * 도움말을 닫는다. 퀴즈 화면을 떠날 때 퀴즈 화면이 부른다 —
     * 열어 둔 채 나가면 홈 화면 위에 그대로 남아 화면을 덮고 포커스를 가둔다.
     */
    closeDialog() {
      closeHelp();
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

    /** 퀴즈 화면이 받은 키를 넘겨준다. 처리했으면 true */
    handleKey(event) {
      return walker.handleKey(event);
    },
  };
}
