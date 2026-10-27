// 내 캐릭터 화면
//
// 캐릭터를 걸어서 칸 위에 멈춰 서면(또는 잠깐 머물면) 그 자리에서 모습이 바뀐다.
// 고르는 순간이 곧 미리보기라 «골라 보고 되돌리는» 과정이 없다. 다만 다른 곳으로
// 가는 길에 **스쳐 지나간 칸은 바꾸지 않는다** — 「홈」까지 걸어 나가는 동안 지나간
// 카드마다 캐릭터가 바뀌어 저장되면 원래 캐릭터를 지킨 채 나갈 수 없다.
//
// 걷기는 ui/walker.js가 하고, 여기서는 «몇 번 칸 = 어떤 캐릭터»만 잇는다.

import { CHARACTERS } from '../characters.js';
import { need } from '../dom.js';
import { createWalker } from './walker.js';
import { createPreview, paintCharacter } from './sprite.js';

/**
 * 밟고 걸어가는 동안 이만큼 같은 카드 위에 머물러야 그 캐릭터가 된다(ms).
 * 멈춰 서면 기다리지 않는다. 걷는 속도로는 카드 하나를 지나는 데 이보다 짧게 걸린다.
 */
const STEP_SETTLE_MS = 250;

/**
 * onSelect는 «멈춰 섰다»에도 «골랐다»에도 불린다. 저장은 부르는 쪽이 정한다.
 */
export interface CharactersScreenDeps {
  onSelect: (id: string) => void;
  onBack: () => void;
}

export interface CharactersScreen {
  /** @param selectedId 지금 쓰고 있는 캐릭터 */
  show(selectedId: string): void;
  hide(): void;
}

export function createCharactersScreen(
  { onSelect, onBack }: CharactersScreenDeps,
): CharactersScreen {
  const el = {
    stage: need('character-stage'),
    grid: need('character-grid'),
    walker: need('character-walker'),
    back: need<HTMLButtonElement>('characters-back'),
  };

  const cards: HTMLButtonElement[] = [];
  /** 화면에 들어올 때의 선택. 처음 설 자리를 여기서 정한다 */
  let currentId = CHARACTERS[0].id;
  /** 밟은 카드를 입히기까지 남은 시간. 다른 칸으로 옮기거나 화면을 떠나면 거둔다 */
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 들어온 뒤 방향키·스틱으로 실제로 걸었는가. 걷기 전의 «멈춤»은 고른 것이 아니다 — 워커는 처음 세울 때
   * (`place`)와 화면 크기가 바뀔 때(`relayout`)도 `onMove(…, false)`를 부른다. 짧은 화면에서 지금 입은 카드가
   * 접힘 아래면 처음 자리가 화면 아래 끝으로 clamp되어 선택점이 위의 다른 카드에 드는데, 한때 그 «멈춤»이
   * 그 카드를 입혀 저장했다 — 화면을 열기만 해도 캐릭터가 바뀌었다. 퀴즈 무대의 `movedSinceReset`과 같은 생각이다
   */
  let walked = false;

  function cancelSettle(): void {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }

  function markSelected(id: string): void {
    cards.forEach((card) => {
      const on = card.dataset.characterId === id;
      card.classList.toggle('character-card--on', on);
      // 이름이 없으므로 «지금 쓰는 것»을 눌린 상태로 알린다
      card.setAttribute('aria-pressed', String(on));
    });
  }

  /** 밟거나 누른 캐릭터를 그 자리에서 적용한다. 미리보기가 곧 선택이다 */
  function apply(id: string | undefined): void {
    if (!id || id === currentId) return;
    currentId = id;
    paintCharacter(el.walker, id);
    markSelected(id);
    onSelect(id);
  }

  const walker = createWalker({
    character: el.walker,
    // 밟은 칸에 잠깐 머물면 그 캐릭터가 된다. 걸어 다니는 캐릭터도 함께 바뀌어 바로 보인다.
    // 스쳐 지나가면 다음 칸이 타이머를 거둬 아무 일도 없다. 「홈으로」처럼 캐릭터 칸이
    // 아닌 것을 밟으면 dataset이 비어 기다릴 것도 없다
    onStep: (node) => {
      cancelSettle();
      const id = node?.dataset.characterId;
      if (!id) return;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        // 그사이 다른 화면의 워커가 켜져 이쪽이 꺼졌으면 떠난 화면의 칸을 입히지 않는다
        if (walker.isEnabled()) apply(id);
      }, STEP_SETTLE_MS);
    },
    // 걷다가 멈춰 섰으면 기다리지 않고 지금 발밑의 카드를 입힌다. 화면을 떠나며 멈춘 것
    // (setEnabled(false))과 아직 걷지 않은 «멈춤»(처음 세운 자리·화면 크기 변화, 위 `walked`)은
    // 고른 것이 아니므로 그냥 둔다. 그때 밟은 카드에 걸린 머물기 타이머도 거둔다
    onMove: (_point, moving) => {
      if (!walker.isEnabled()) return;
      if (moving) {
        walked = true;
        return;
      }
      cancelSettle();
      if (walked) apply(walker.standingElement()?.dataset.characterId);
    },
    startAt: () => {
      const index = CHARACTERS.findIndex((character) => character.id === currentId);
      const box = cards[index]?.getBoundingClientRect();
      if (!box || box.width === 0) return null;
      // 카드 아래에는 이름이 있다. 그 위에 서야 가리지 않는다.
      // 카드가 화면 안이면 선택점(몸통 가운데, U10)은 이 발끝에서 키의 절반 위라 카드(96px 이상) 안이다.
      // **늘 그렇지는 않다** — 짧은 화면에서 이 카드가 접힘 아래면 워커가 화면 아래 끝으로 clamp되어
      // 선택점이 위의 다른 카드에 든다. 그 카드에 불은 켜지지만 걷기 전에는 입히지 않는다(`walked`).
      // 카드 쪽으로 스크롤하지도 않는다 — 들어올 때 스크롤을 끌어가면 위의 「홈」과 제목이 밀려난다
      return { x: box.left + box.width / 2, y: box.bottom - 26 };
    },
  });

  function build(): void {
    el.grid.replaceChildren();
    cards.length = 0;

    CHARACTERS.forEach((character) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'character-card';
      card.dataset.characterId = character.id;
      // 이름은 화면에 그리지 않는다 — 무엇으로 보이는지는 보는 사람이 정한다.
      // 다만 그림만 있는 버튼은 눈으로 볼 수 없는 사람에게 아무것도 아니라
      // 스크린리더에는 이름을 알려준다
      card.setAttribute('aria-label', character.name);

      card.append(createPreview(character.id));
      // 걸어가서 Enter로 고르든 손가락으로 바로 누르든 같은 길로 들어온다.
      // 워커의 «고르기»도 결국 이 click을 부르므로 여기 한 곳만 있으면 된다
      card.addEventListener('click', () => {
        cancelSettle();
        apply(character.id);
        onBack();
      });

      el.grid.append(card);
      cards.push(card);
    });
  }

  el.back.addEventListener('click', () => onBack());

  document.addEventListener('keydown', (event) => {
    const screen = el.stage.closest<HTMLElement>('[data-screen]');
    // closest는 «없을 수도 있다»고 답한다. 무대는 언제나 화면 안에 있으므로
    // 없으면 HTML을 잘못 고친 것이고, 그때는 키를 받지 않는 편이 안전하다.
    if (!screen || screen.hidden) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      onBack();
      return;
    }
    if (walker.handleKey(event)) event.preventDefault();
  });

  return {
    show(selectedId) {
      cancelSettle();
      walked = false;
      currentId = selectedId;
      build();
      markSelected(selectedId);
      paintCharacter(el.walker, selectedId);
      walker.setEnabled(true);
    },

    hide() {
      cancelSettle();
      walker.setEnabled(false);
    },
  };
}
