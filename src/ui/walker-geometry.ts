// 워커의 시각 위치와 선택점 사이의 작은 기하 계약.
//
// `.walker`는 논리 좌표에 발끝을 맞춰 `translate(-50%, -100%)`로 그려진다. 무엇을 밟았는지
// 보는 자리(선택점)는 화면마다 고르지 않고 **규칙 하나**다 (U10, CLAUDE.md «걷는 캐릭터»의 표):
//
// - 기본은 **몸통 가운데**(`'center'`, 발끝에서 키의 절반 위). 눈에 보이는 몸이 덮은 버튼이 골라진다.
//   캐릭터(48px)가 44px 버튼보다 커서 발끝으로 보면 몸이 버튼을 다 덮어도 발이 그 아래면
//   아무것도 켜지지 않았다. 홈·내 캐릭터·로비·대기실·결과·랭킹·«푼 문제»가 이것을 쓴다
// - 예외는 퀴즈 무대 하나다(`'foot'`, 발끝 1px 위, `arena.ts`). 바닥 칸을 밟는 것이 답이고 칸 사이
//   틈은 «아무 칸도 아님»이라, 몸 가운데로 보면 발이 틈에 있어도 위 칸이 켜진다
//
// 두 경로가 같은 계산을 임의로 복제하지 않도록 선택점을 이 순수 함수에서 만든다.

export type WalkerHitAnchor = 'foot' | 'center';

/** 화면이 따로 넘기지 않으면 쓰는 선택점. 퀴즈 무대만 `'foot'`을 넘긴다 */
export const DEFAULT_WALKER_HIT_ANCHOR: WalkerHitAnchor = 'center';

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
