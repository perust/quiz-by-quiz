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
 *   startAt?: () => HTMLElement|null  곁에서 시작할 버튼
 *   startPoint?: () => {x, y}|null    자리를 직접 정할 때 (대기실 바닥 등)
 *
 *   둘 다 없으면 화면 한가운데에서 시작한다.
 * }} config
 */
export function createScreenWalker({ screen, character, startAt, startPoint }) {
  const walker = createWalker({
    character,
    startAt: () => {
      const point = startPoint?.();
      if (point) return point;

      const box = startAt?.()?.getBoundingClientRect();
      if (!box || box.width === 0) return null;
      // 버튼 «위»가 아니라 바로 아래에 선다. 위에 세우면 글자를 가린다 —
      // 홈의 메뉴 카드는 오른쪽을 비워 두었지만 일반 버튼에는 그런 여백이 없다.
      // 한 걸음이면 올라설 수 있으니 «여기서 시작하라»는 뜻은 그대로 전해진다.
      return { x: box.left + box.width / 2, y: box.bottom + 30 };
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
