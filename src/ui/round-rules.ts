// 한 판의 규칙을 말로 옮긴다 (U01·U04).
//
// 홈 dock 의 캡션, 전체 도전 표식, 「게임 방법」 대화상자, 무대 아래 규칙 한 줄이 모두 여기서
// 글을 받는다. 숫자를 화면마다 따로 적으면 상수를 바꿨을 때 말이 어긋난다.
//
// **은행 크기는 쓰지 않는다.** 한 판의 길이는 은행과 분리된 상수다 (FR-1.2) — «과학 120문제»처럼
// 은행 크기를 보이면 판마다 그만큼 푸는 줄 안다(#94). DOM 을 만지지 않는다 — 브라우저 없이 테스트한다
// (tests/first-visit-rules.test.mjs).

import {
  CATEGORIES,
  ONLINE_QUESTION_TIME_CHOICES,
  POINTS_PER_CORRECT,
  QUESTIONS_PER_CATEGORY_IN_ALL,
  QUESTIONS_PER_ROUND,
} from '../constants.js';
import { timeLimitLabel } from './time-limit.js';

/** 전체 도전 한 판의 문항 수. 분야마다 같은 수를 뽑아 합친다 (FR-2.2) */
export const ALL_ROUND_QUESTIONS = QUESTIONS_PER_CATEGORY_IN_ALL * CATEGORIES.length;

/** 홈 분야 dock 위의 캡션. «분야 골라 10문제» */
export function categoryDockCaption(): string {
  return `분야 골라 ${QUESTIONS_PER_ROUND}문제`;
}

/**
 * 전체 도전 CTA 의 판 길이 표식. 기록이 없을 때 «25문제»를 보인다 (기록이 있으면 «최고 N점»).
 * count 는 실제로 나갈 문항 수다 — 은행이 모자라면 있는 만큼만 나간다.
 */
export function allRoundLength(count: number = ALL_ROUND_QUESTIONS): string {
  return `${count}문제`;
}

/** 「게임 방법」의 «한 판» 줄 */
export function roundLengthRule(): string {
  return `분야 ${QUESTIONS_PER_ROUND}문제 · 전체 도전 ${ALL_ROUND_QUESTIONS}문제`;
}

/** 「게임 방법」의 «문항 시간» 줄. 설정에서 고른 값을 그대로 말한다 (FR-3.7) */
export function timeRule(limitMs: number | null): string {
  return `${timeLimitLabel(limitMs)} · 설정에서 바꿀 수 있어요`;
}

/** 「게임 방법」의 «점수» 줄. 속도 점수가 없다는 것을 시작 전에 말한다 (FR-5.1, PRD 2.1) */
export function scoreRule(): string {
  return `정답당 ${POINTS_PER_CORRECT}점 · 빨리 답해도 점수는 같아요`;
}

/**
 * 「게임 방법」의 «답하기» 줄. 제한 없음이면 «시간이 끝나면»이 없다 — 칸에 서 있기만 해서는
 * 답이 나가지 않는다 (CLAUDE.md «제한 시간은 판마다 정한다»).
 */
export function answerRule(limitMs: number | null): string {
  const direct = '보기나 바닥 칸을 누르면 바로 답이 나가요.';
  return limitMs === null
    ? `${direct} 캐릭터로 고를 때는 칸 위에서 선택 버튼이나 Enter · Space를 눌러요.`
    : `${direct} 시간이 끝나면 캐릭터가 서 있는 칸이 답이에요. 십자 틈에 서 있으면 답하지 않은 것이 돼요.`;
}

/** 「게임 방법」의 «기록» 줄. 랭킹 화면·결과 등록 칸과 같은 범위다 (FR-6.10) */
export const RECORD_RULE = '이 브라우저에만 저장돼요';

/**
 * 「게임 방법」의 «온라인» 한 줄 (local-ux-1). 위 줄들은 **혼자 하기** 규칙이고 온라인은 둘이 다르다 —
 * 칸에 서 있기만 해서는 제출되지 않고(시간이 끝나도 선 칸을 내지 않는다), 문항 시간은 설정이 아니라
 * 방장이 방마다 고른다. 온라인 조작법(`#online-help-dialog`)·설정의 문항 시간 도움말과 같은 말이다.
 */
export function onlineRule(): string {
  const times = ONLINE_QUESTION_TIME_CHOICES.map((ms) => `${Math.round(ms / 1000)}초`).join('나 ');
  return `칸에 서 있기만 해서는 제출되지 않아요. 선택 버튼이나 Enter · Space를 눌러요. 문항 시간은 방장이 ${times}로 정해요.`;
}

/** 무대 아래 규칙 한 줄 (U01). 조작이 아니라 «무엇이 답이 되는가»를 말한다 */
export function arenaRuleHint(limitMs: number | null): string {
  return limitMs === null
    ? '보기를 누르면 바로 답 · 칸 위에서 선택하면 답'
    : '보기를 누르면 바로 답 · 시간이 끝나면 선 칸이 답';
}
