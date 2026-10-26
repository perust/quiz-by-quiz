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

/** 높이 700px 이하 홈의 시작 자리를 정하는 데 쓰는 실측값. 모두 화면(viewport) 기준이다 */
export interface ShortHomeStartInput {
  viewportWidth: number;
  /** 캐릭터 높이. 좌표는 발끝이라 머리가 화면 위로 솟지 않게 이만큼은 내려선다 */
  walkerHeight: number;
  /** dock 위 양쪽으로 내려온 보조 입구의 위 끝. 캐릭터는 늘 이 줄보다 위에 선다 */
  entryTop: number;
  /** 위 가운데에 보이는 브랜드의 아래 끝. 브랜드가 접혀 있으면 null */
  brandBottom: number | null;
}

/**
 * 높이 700px 이하 홈의 시작 발끝 (CLAUDE.md «홈에서도 늘 걸어 다닌다»).
 *
 * 두 보조 입구가 dock 위 양쪽으로 내려오므로 그 사이 가운데의 빈 하늘에 선다. 짧은 가로
 * 화면(높이 420px 이하 · 폭 640px 이상, U07)은 접었던 브랜드를 위 가운데에 되살리므로 그 아래에
 * 서서 글을 덮지 않는다. 어느 경우든 입구 줄(`entryTop − 8`)보다 아래로 내려가지 않는다 —
 * 시작부터 입구를 밟으면 Enter 한 번에 그 화면으로 넘어간다.
 */
export function shortHomeStartPoint({
  viewportWidth, walkerHeight, entryTop, brandBottom,
}: ShortHomeStartInput): Readonly<{ x: number; y: number }> {
  const sky = walkerHeight + 48;
  const belowBrand = brandBottom === null ? sky : Math.max(sky, brandBottom + 8 + walkerHeight);
  return {
    x: viewportWidth / 2,
    y: Math.max(walkerHeight, Math.min(belowBrand, entryTop - 8)),
  };
}
