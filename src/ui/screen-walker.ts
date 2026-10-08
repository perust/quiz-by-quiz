// 걸어 다니기만 하면 되는 화면의 캐릭터
//
// 홈과 내 캐릭터 화면은 «밟으면 미리보기», «처음 설 자리» 같은 저마다의 사정이 있어
// 직접 워커를 만든다. 결과·랭킹처럼 **걸어가서 버튼을 누르는 것이 전부**인 화면은
// 이걸 쓴다 — 워커의 자유 방식이 캐릭터와 겹친 버튼을 찾아 진짜로 누르므로,
// 화면 쪽에서 «어떤 버튼이 어디 있는지» 적어 둘 것이 없다.

import { createWalker, type Point } from './walker.js';
import { paintCharacter } from './sprite.js';

export interface ScreenWalkerConfig {
  /** 이 화면이 보일 때만 키를 받는다 */
  screen: HTMLElement;
  /** 움직일 요소 */
  character: HTMLElement;
  /** 곁에서 시작할 버튼 */
  startAt?: () => HTMLElement | null;
  /** 자리를 직접 정할 때 (대기실 바닥 등) */
  startPoint?: () => Point | null;
  /** 화면 좌표가 바뀌거나 걷기/정지가 전환될 때 */
  onMove?: (point: Point, moving: boolean) => void;

  // 둘 다 없으면 화면 한가운데에서 시작한다.
}

export interface ScreenWalker {
  /**
   * 이 화면에 들어올 때. 쓰고 있는 캐릭터로 갈아 끼우고 걷기를 켠다.
   * id 가 없으면 기본 캐릭터로 그린다 (`findCharacter`)
   */
  show(characterId?: string | null): void;
  /** 직접 누른 가구 등 화면 안 목표의 좌표로 자리를 맞춘다. */
  placeAt(point: Point, report?: boolean): void;
  /** 대상의 disabled/배치가 바뀌었을 때 발밑 선택 표시를 다시 잰다. */
  refresh(): void;
  hide(): void;
}

export function createScreenWalker({
  screen, character, startAt, startPoint, onMove,
}: ScreenWalkerConfig): ScreenWalker {
  const walker = createWalker({
    character,
    onMove,
    // `.walker`의 논리 좌표는 발끝이지만 일반 화면에서는 눈에 보이는 몸통과 겹친
    // 버튼이 선택되어야 한다. arena의 발밑 칸 선택은 createWalker 기본값으로 남긴다.
    hitAnchor: 'center',
    // 둘 다 없으면 시작점 함수를 아예 넘기지 않아 워커가 화면 한가운데에 세운다.
    // 함수를 넘기면 워커는 null 을 «아직 잴 수 없다»로 읽고 기다리므로, 시작점을 정하지
    // 않았던 결과 화면에서는 캐릭터가 좌상단에 박힌 채 세우려는 프레임만 끝없이 돌았다.
    startAt: startPoint || startAt ? () => {
      const point = startPoint?.();
      if (point) return point;

      const box = startAt?.()?.getBoundingClientRect();
      if (!box || box.width === 0) return null;
      // 버튼 글자를 가리지 않도록 캐릭터 몸통 전체를 바로 아래에 세운다.
      // 한 번 위로 움직이면 목표에 닿을 만큼 가깝되, 쉬는 상태에서는 겹치지 않는다.
      return {
        x: box.left + box.width / 2,
        y: box.bottom + character.offsetHeight + 6,
      };
    } : undefined,
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

    placeAt(point, report = true) {
      walker.placeAt(point, report);
    },

    refresh() {
      walker.refresh();
    },

    hide() {
      walker.setEnabled(false);
    },
  };
}
