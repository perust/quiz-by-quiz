// 최고 기록 비교 한 줄 (FR-5.7). DOM도 저장소도 모르는 순수 함수다 — 브라우저 없이 테스트한다.
//
// 로컬 결과(`result.ts`, 이 브라우저의 기록)와 혼자 푼 온라인 판의 결과(`online-result.ts`, 서버가 그 판의 기록을 빼고
// 센 내 최고 점수, FR-7.13 3단계)가 같은 말을 쓴다. 신기록·첫 기록이면 골드 별 칩(`result-best--new`)이다.

/** `previous`는 이 판 «전의» 최고 점수이고 기록이 없으면 null이다 */
export function bestComparisonText(score: number, previous: number | null): { text: string; isNew: boolean } {
  if (previous === null) return { text: '첫 기록이에요.', isNew: true };
  if (score > previous) return { text: `신기록 · 이전 최고 ${previous}점`, isNew: true };
  if (score === previous) return { text: `최고 기록과 같은 ${previous}점`, isNew: false };
  return { text: `최고 기록 ${previous}점`, isNew: false };
}
