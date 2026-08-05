// 걸어 다니기만 하면 되는 화면의 캐릭터
//
// 홈과 내 캐릭터 화면은 «밟으면 미리보기», «처음 설 자리» 같은 저마다의 사정이 있어
// 직접 워커를 만든다. 결과·랭킹처럼 **걸어가서 버튼을 누르는 것이 전부**인 화면은
// 이걸 쓴다 — 워커의 자유 방식이 발밑을 알아서 찾고 그 자리를 진짜로 누르므로,
// 화면 쪽에서 «어떤 버튼이 어디 있는지» 적어 둘 것이 없다.

import { createWalker } from './walker.js';
import { paintCharacter } from './sprite.js';

/**
 * @param {{
 *   screen: HTMLElement,          이 화면이 보일 때만 키를 받는다
 *   character: HTMLElement,       움직일 요소
 *   startAt?: () => HTMLElement|null  처음 설 버튼. 없으면 화면 한가운데
 * }} config
 */
export function createScreenWalker({ screen, character, startAt }) {
  const walker = createWalker({
    stage: screen,
    character,
    roam: true,
    startAt: () => {
      const box = startAt?.()?.getBoundingClientRect();
      if (!box || box.width === 0) return null;
      // 버튼 오른쪽 끝에 선다. 가운데면 글자를 가린다
      return { x: box.right - 26, y: box.bottom - 8 };
    },
  });

  document.addEventListener('keydown', (event) => {
    if (screen.hidden) return;
    if (walker.handleKey(event)) event.preventDefault();
  });

  return {
    show(characterId) {
      paintCharacter(character, characterId);
      walker.setEnabled(true);
    },

    hide() {
      walker.setEnabled(false);
    },
  };
}
