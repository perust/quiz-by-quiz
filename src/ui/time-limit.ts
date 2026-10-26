// 문항 시간을 말로 옮긴다 (FR-3.7, PRD v1.2).
//
// 질문 제목의 설명(aria-describedby)·조작법·설정이 같은 말을 쓰도록 한 곳에 둔다.
// DOM 을 만지지 않는다 — 브라우저 없이 테스트한다 (tests/settings-time-limit.test.mjs).

/** «문항당 40초» · 제한이 없으면 «시간 제한 없음» */
export function timeLimitLabel(limitMs: number | null): string {
  return limitMs === null ? '시간 제한 없음' : `문항당 ${Math.round(limitMs / 1000)}초`;
}
