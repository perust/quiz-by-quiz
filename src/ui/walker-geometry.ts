// 워커의 시각 위치와 선택 좌표 사이의 작은 기하 계약.
//
// `.walker`는 논리 좌표에 발끝을 맞춰 `translate(-50%, -100%)`로 그려진다.
// 퀴즈 무대는 발밑 칸을 고르는 기존 규칙을 유지하지만, 일반 화면의 버튼은 눈에
// 보이는 몸통과 겹친 곳을 골라야 한다. 두 경로가 같은 계산을 임의로 복제하지 않도록
// 선택점을 이 순수 함수에서 만든다.

export type WalkerHitAnchor = 'foot' | 'center';

export function walkerHitPoint(
  position: Readonly<{ x: number; y: number }>,
  characterSize: Readonly<{ height: number }>,
  anchor: WalkerHitAnchor,
): Readonly<{ x: number; y: number }> {
  const height = Number.isFinite(characterSize.height) && characterSize.height > 0
    ? characterSize.height
    : 0;
  return {
    x: position.x,
    y: position.y - (anchor === 'center' ? height / 2 : 1),
  };
}
