// 내 캐릭터 화면
//
// 캐릭터를 걸어서 칸 위에 올라가면 그 자리에서 모습이 바뀐다.
// 고르는 순간이 곧 미리보기라 «골라 보고 되돌리는» 과정이 없다.
//
// 걷기는 ui/walker.js가 하고, 여기서는 «몇 번 칸 = 어떤 캐릭터»만 잇는다.

import { CHARACTERS } from '../characters.js';
import { createWalker } from './walker.js';
import { createPreview, paintCharacter } from './sprite.js';

/**
 * @param {{ onSelect: (id: string) => void, onBack: () => void }} callbacks
 *   onSelect는 «올라섰다»에도 «골랐다»에도 불린다. 저장은 부르는 쪽이 정한다.
 */
export function createCharactersScreen({ onSelect, onBack }) {
  const el = {
    stage: document.getElementById('character-stage'),
    grid: document.getElementById('character-grid'),
    walker: document.getElementById('character-walker'),
    back: document.getElementById('characters-back'),
  };

  const cards = [];
  /** 화면에 들어올 때의 선택. 처음 설 자리를 여기서 정한다 */
  let currentId = CHARACTERS[0].id;

  function markSelected(id) {
    cards.forEach((card) => {
      const on = card.dataset.characterId === id;
      card.classList.toggle('character-card--on', on);
      // 이름이 없으므로 «지금 쓰는 것»을 눌린 상태로 알린다
      card.setAttribute('aria-pressed', String(on));
    });
  }

  /** 밟거나 누른 캐릭터를 그 자리에서 적용한다. 미리보기가 곧 선택이다 */
  function apply(id) {
    if (!id || id === currentId) return;
    currentId = id;
    paintCharacter(el.walker, id);
    markSelected(id);
    onSelect(id);
  }

  const walker = createWalker({
    stage: el.stage,
    character: el.walker,
    roam: true,
    // 밟는 순간 그 캐릭터가 된다. 걸어 다니는 캐릭터도 함께 바뀌어 바로 보인다.
    // 「홈으로」처럼 캐릭터 칸이 아닌 것을 밟으면 dataset이 비어 아무 일도 없다
    onStep: (node) => apply(node?.dataset.characterId),
    startAt: () => {
      const index = CHARACTERS.findIndex((character) => character.id === currentId);
      const box = cards[index]?.getBoundingClientRect();
      if (!box || box.width === 0) return null;
      // 카드 아래에는 이름이 있다. 그 위에 서야 가리지 않는다
      return { x: box.left + box.width / 2, y: box.bottom - 26 };
    },
  });

  function build() {
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
        apply(character.id);
        onBack();
      });

      el.grid.append(card);
      cards.push(card);
    });
  }

  el.back.addEventListener('click', () => onBack());

  document.addEventListener('keydown', (event) => {
    const screen = el.stage.closest('[data-screen]');
    if (screen.hidden) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      onBack();
      return;
    }
    if (walker.handleKey(event)) event.preventDefault();
  });

  return {
    /** @param {string} selectedId 지금 쓰고 있는 캐릭터 */
    show(selectedId) {
      currentId = selectedId;
      build();
      markSelected(selectedId);
      paintCharacter(el.walker, selectedId);
      walker.setEnabled(true);
    },

    hide() {
      walker.setEnabled(false);
    },
  };
}
