// 오늘의 퀴즈 결과 공유 글 (daily share). DOM·브라우저를 모르는 순수 함수다 — 보내는 일(Web Share·클립보드)은
// `ui/daily-share.ts` 가 맡는다.
//
// 글은 정해진 네 줄뿐이다: 서비스 이름과 레코드 날짜(연도 포함, KST 달력 날짜 — 지금 시계를 읽지 않는다) ·
// 정답 수/20 · 실제로 푼 순서의 정오 20개 · 공식 주소 하나. 정답 수와 정오는 같은 답 배열에서 센다.
// 문제·보기·정답·해설·문항 ID·닉네임·세션·소요 시간·순위는 싣지 않는다 — 공유 글에 그 칸이 없다.
// 정오 표식은 화면 아이콘이 아니라 남의 앱에 붙여 넣을 글이라 글리프(이모지)로 쓴다(«아이콘은 글리프가 아니라
// 아이콘 묶음이다»는 이 앱이 그리는 화면의 규칙이다).

import { SERVICE_NAME, SERVICE_URL } from '../constants.js';
import { DAILY_QUESTION_COUNT, isDailyComplete, type DailyRecord } from './daily.js';

/** 맞힌 문제·틀린 문제 표식 */
export const DAILY_SHARE_CORRECT_MARK = '✅';
export const DAILY_SHARE_WRONG_MARK = '❌';

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 공유 글의 날짜: «2026년 11월 24일». 레코드의 날짜 열쇠에서만 만든다 */
export function dailyShareDateLabel(dateKey: string): string {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return '';
  return `${Number(match[1])}년 ${Number(match[2])}월 ${Number(match[3])}일`;
}

/** 끝낸 오늘의 퀴즈의 공유 글. 끝내지 않은 레코드면 null 이다 — 덜 푼 판은 공유하지 않는다 */
export function dailyShareText(record: DailyRecord): string | null {
  if (!isDailyComplete(record)) return null;
  const date = dailyShareDateLabel(record.dateKey);
  if (!date) return null;
  const answers = record.answers;
  const correct = answers.filter((answer) => answer.correct).length;
  const marks = answers.map((answer) => (answer.correct ? DAILY_SHARE_CORRECT_MARK : DAILY_SHARE_WRONG_MARK)).join('');
  return [
    `${SERVICE_NAME} · ${date}`,
    `${correct}/${DAILY_QUESTION_COUNT}`,
    marks,
    SERVICE_URL,
  ].join('\n');
}
