/** DOM 의존성 없이 테스트할 수 있는 arena 답 칸 선택 상태 전환. */
export function setArenaTileSelectable(
  tile: Pick<HTMLElement, 'dataset' | 'classList'>,
  value: boolean,
): void {
  tile.dataset.selectable = String(Boolean(value));
  if (!value) tile.classList.remove('is-standing');
}
