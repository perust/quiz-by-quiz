// 화면에 숫자를 표시하는 형식. 계산이 아니라 표기 담당이라 ui/ 에 둔다.

/**
 * 소요 시간을 사람이 읽는 형태로 (FR-5.2).
 * 1분 미만이면 초만 쓴다.
 *
 * @returns "1분 36초" / "42초"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(ms, 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

/** 정답률을 정수 퍼센트로 */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * 기록 시각. 동점은 먼저 달성한 순으로 정렬되므로(FR-6.3)
 * 목록에서 순서를 납득할 수 있도록 시각까지 보여준다.
 *
 * @returns "2026.08.04 14:32"
 */
export function formatPlayedAt(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '-';

  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
