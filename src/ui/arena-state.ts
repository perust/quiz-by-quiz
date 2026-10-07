/** DOM 의존성 없이 테스트할 수 있는 arena 답 칸 선택 상태 전환. */
export function setArenaTileSelectable(
  tile: Pick<HTMLElement, 'dataset' | 'classList'>,
  value: boolean,
): void {
  tile.dataset.selectable = String(Boolean(value));
  if (!value) tile.classList.remove('is-standing');
}

/**
 * 캐릭터가 선 바닥 칸과 같은 번호의 위 보기에 표시를 단다.
 *
 * 바닥 칸에는 번호만 있어 «무슨 답 위에 서 있는지»는 위 보기를 봐야 안다. 같은 번호의
 * 보기에 칸과 같은 «불»을 켜 두 자리를 잇는다. 눈으로 보는 표시일 뿐이라 aria 는 건드리지
 * 않는다 — 스크린리더와 키보드는 보기 버튼을 직접 쓴다.
 *
 * 클래스가 아니라 속성으로 단다. 온라인 화면은 상태가 바뀔 때마다 보기의 className 을
 * 통째로 다시 쓰는데, 클래스로 달면 그때마다 표시가 지워진다.
 *
 * @param index 서 있는 칸 번호. 칸 위가 아니면 null 이고 모든 표시를 거둔다
 */
export function markArenaTarget(
  choices: Iterable<Pick<Element, 'toggleAttribute'>>,
  index: number | null,
): void {
  let position = 0;
  for (const choice of choices) {
    choice.toggleAttribute('data-arena-target', position === index);
    position += 1;
  }
}
