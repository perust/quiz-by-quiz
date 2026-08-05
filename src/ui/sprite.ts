// 캐릭터 그리기
//
// 이미지 파일 없이 CSS만으로 그린다. 슬라임은 그라디언트 덩어리, 도트 몬스터는
// 1px 요소 하나에 box-shadow를 잔뜩 얹어 픽셀을 찍는다.
//
// box-shadow 방식을 쓰는 이유: 픽셀 수만큼 DOM을 만들지 않아도 되고,
// 스프라이트 전체가 요소 하나라 scale·translate가 통째로 먹는다
// (제자리 뛰기와 걷기 동작이 도트에도 그대로 적용된다).

import { PIXEL_UNIT, findCharacter } from '../characters.js';

/**
 * 도트 그림 한 벌. `Character`의 `grid`·`palette`는 pixel 캐릭터에만 있는
 * 선택 필드라, 둘이 갖춰졌다는 것을 이 모양으로 한 번만 못박아 둔다.
 */
interface PixelArt {
  grid: string[];
  palette: Record<string, string>;
}

/** 도트 그림을 box-shadow 문자열로 편다 */
function toBoxShadow({ grid, palette }: PixelArt): string {
  const parts: string[] = [];
  grid.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const color = palette[cell];
      if (!color) return; // 공백과 '.' 은 비운다
      parts.push(`${x * PIXEL_UNIT}px ${y * PIXEL_UNIT}px 0 0 ${color}`);
    });
  });
  return parts.join(', ');
}

function gridSize(grid: string[]): { width: number; height: number } {
  const width = Math.max(...grid.map((row) => row.length));
  return { width: width * PIXEL_UNIT, height: grid.length * PIXEL_UNIT };
}

/**
 * 캐릭터의 «몸통»을 그린다. 부르는 쪽은 이 요소를 껍데기에 넣기만 하면 된다.
 * 껍데기(.walker)가 위치를, 몸통이 뛰고 눌리는 동작을 맡는다.
 *
 * id 는 없어도 된다 — `findCharacter` 가 못 찾으면 기본 캐릭터로 되돌린다.
 * 캐릭터를 빼도 앱이 죽지 않아야 한다는 그 규칙이 여기까지 이어진다.
 */
export function createBody(id?: string | null): HTMLElement {
  const character = findCharacter(id);
  const body = document.createElement('span');
  body.className = 'walker__body';

  if (character.kind === 'pixel') {
    body.classList.add('walker__body--pixel');
    const dot = document.createElement('span');
    dot.className = 'walker__dot';
    // kind 가 'pixel' 이면 grid·palette 는 반드시 있다. 타입 위에서는 선택 필드라
    // 여기서 한 번 좁혀 두고, 아래는 지금까지처럼 그대로 쓴다
    const art: PixelArt = { grid: character.grid ?? [], palette: character.palette ?? {} };
    dot.style.boxShadow = toBoxShadow(art);

    const { width, height } = gridSize(art.grid);
    // 점 하나의 크기. 간격과 같아야 픽셀이 빈틈없이 붙는다
    body.style.setProperty('--pixel-unit', `${PIXEL_UNIT}px`);
    // 도트는 왼쪽 위에서 자라므로 껍데기 가운데에 오도록 밀어준다.
    // 점 하나만큼은 이미 가운데 놓여 있으므로 빼고 계산한다
    body.style.setProperty('--sprite-shift-x', `${-(width - PIXEL_UNIT) / 2}px`);
    body.style.setProperty('--sprite-shift-y', `${-(height - PIXEL_UNIT) / 2}px`);
    body.append(dot);
    return body;
  }

  // slime 의 body 도 선택 필드다. 빈 문자열은 «배경을 지정하지 않음»이라
  // 값이 없을 때 지금까지 그려지던 것과 같다
  body.style.background = character.body ?? '';

  const face = document.createElement('span');
  face.className = 'walker__face';
  body.append(face);
  return body;
}

/**
 * 껍데기 안의 몸통을 갈아 끼운다. 껍데기의 위치와 클래스는 건드리지 않는다 —
 * 워커가 그 요소를 붙잡고 움직이는 중일 수 있다.
 *
 * @param shell .walker 요소
 */
export function paintCharacter(shell: HTMLElement, id?: string | null): void {
  shell.querySelector('.walker__body')?.remove();
  // 그림자는 그대로 두고 몸통만 바꾼다
  shell.append(createBody(id));
}

/** 목록에 보여줄 미리보기. 움직이지 않는 정지 그림이다 */
export function createPreview(id?: string | null): HTMLElement {
  const preview = document.createElement('span');
  preview.className = 'character-card__figure';
  preview.append(createBody(id));
  return preview;
}
