// 혼자 푸는 온라인 판 (PRD FR-7.13 3단계) — 홈이 무엇을 여는가와 두 소유자 결정의 기본값.
//
// 소유자 방향: 혼자 하기를 없애고 혼자 하고 싶은 사람도 온라인에서 혼자 푼다. 그래서 홈의 분야 칸과
// 「전체 도전」은 대기실을 거치지 않는 혼자 온라인 판을 곧바로 연다(POST /v1/solo). 서버가 채점하고 기록한다.
// DOM도 저장소도 모르는 순수 함수다 — app.ts가 저장소의 답을 넘기고 홈·결과·설정이 여기서 말을 받는다.
//
// **두 결정은 PR에서 소유자를 기다린다** (PRD 10.2). 기본값을 바꾸려면 이 파일의 상수 둘만 고친다.
// - #1 서버에 닿지 않을 때: `OFFLINE_PRACTICE` — 기본은 «연습(기록 안 남음)»을 연다(docs/p2p-review.md가 P2P
//   대신 권한 길). false면 홈은 안내만 하고 분야 칸을 잠근다
// - #2 혼자 온라인 판의 문항 시간: `soloQuestionTime` — 기본은 설정의 20초·40초를 그대로 쓰고 «제한 없음»은 연습에만
//   쓴다(온라인 판은 20초). 온라인에 «제한 없음»을 주려면 서버의 문항 시간 목록(migration 011의 CHECK)부터 바꿔야 한다

import { ONLINE_QUESTION_TIME_CHOICES, TIME_LIMIT_MS } from '../constants.js';
import type { OnlineQuestionTime } from '../types.js';
import { ApiFailure, isNicknameRejection } from './rules.js';

/** 결정 #1의 기본값: 서버에 닿지 않으면 «연습(기록 안 남음)»을 연다 (PRD 10.2 #1) */
export const OFFLINE_PRACTICE = true;

/**
 * 결정 #2의 기본값: 혼자 온라인 판은 설정의 문항 시간을 쓰되 서버가 받는 20초·40초만이다. «제한 없음»(null)이나
 * 목록 밖의 값이면 기본 20초다 — «제한 없음»은 연습(기록 안 남음)에만 적용된다 (PRD 10.2 #2)
 */
export function soloQuestionTime(limitMs: number | null): OnlineQuestionTime {
  return ONLINE_QUESTION_TIME_CHOICES.find((choice) => choice === limitMs) ?? TIME_LIMIT_MS;
}

/**
 * 홈의 분야 칸이 여는 것.
 * - `checking`: 아직 묻는 중이다(부팅 직후). 누르면 답을 기다렸다가 고른다
 * - `online`: 혼자 푸는 온라인 판(서버가 채점·기록)
 * - `local`: 이 기능을 모르는 이전 API — 예전 그대로 혼자 하기(로컬, 이 브라우저에 기록)
 * - `practice`: 서버에 닿지 않는다·서버 없이 열었다·닉네임 때문에 세션을 열지 못했다 — 연습(기록 안 남음)
 */
export type HomePlayMode = 'checking' | 'online' | 'local' | 'practice';

/** 연습인 까닭. 홈의 안내 줄이 그 까닭을 말하고, `offline`·`nickname`만 다시 연결할 길이 있다 */
export type PracticeReason = 'offline' | 'no-server' | 'nickname';

/** 서버의 답(또는 실패)을 홈의 판 종류로 옮긴 것 */
export type PlayProbe =
  | { mode: 'online' }
  | { mode: 'local' }
  | { mode: 'practice'; reason: PracticeReason }
  /** 서버는 답했지만 지금은 거절했다(요청 한도 등). 판 종류를 바꾸지 않고 그 말만 알린다 */
  | { mode: 'unchanged'; message: string };

/**
 * 서버에 닿지 않은 것인가 (결정 #1의 «API cannot be reached»). 연결 실패·응답 시간 초과·5xx(DB가 안 되거나
 * migration을 기다리는 API 포함)·읽을 수 없는 응답이 그렇다. 서버가 4xx로 거절한 것(요청 한도·잘못된 요청)과
 * 닉네임 금칙 규칙은 닿은 것이다 — 연습으로 돌리지 않는다.
 */
export function isServerUnreachable(error: unknown): boolean {
  if (isNicknameRejection(error)) return false;
  if (error instanceof ApiFailure) return error.status >= 500;
  return true;
}

/**
 * 세션·내 최고 기록 요청의 결과를 판 종류로 옮긴다. `supported`는 그 API가 혼자 온라인 판을 아는지
 * (세션의 `soloPlay`)이고, 요청이 던졌으면 `error`다.
 */
export function probeResult(outcome: { supported: boolean } | { error: unknown }): PlayProbe {
  if ('supported' in outcome) return outcome.supported ? { mode: 'online' } : { mode: 'local' };
  const { error } = outcome;
  if (isNicknameRejection(error)) return { mode: 'practice', reason: 'nickname' };
  if (isServerUnreachable(error)) return { mode: 'practice', reason: 'offline' };
  return {
    mode: 'unchanged',
    message: error instanceof ApiFailure ? error.message : '잠시 후 다시 시도해 주세요.',
  };
}

/** 연습 안내 줄. `action`이 있으면 그 줄이 버튼이 되어 다시 연결을 시도한다(닉네임은 홈의 닉네임 카드가 고친다) */
export interface PracticeNote {
  text: string;
  action: string | null;
}

/**
 * 홈 dock 맨 위의 연습 안내 줄. 서버 없이 연 화면(개발 문서)은 줄을 두지 않고 캡션만 말한다. `allowPractice`가
 * false면(결정 #1의 다른 길) 연습을 권하지 않고 연결할 수 없다는 것만 말한다
 */
export function practiceNote(reason: PracticeReason, allowPractice: boolean = OFFLINE_PRACTICE): PracticeNote | null {
  switch (reason) {
    case 'offline':
      return allowPractice
        ? { text: '온라인에 연결할 수 없어 연습(기록 안 남음)만 할 수 있어요', action: '다시 연결' }
        : { text: '온라인에 연결할 수 없어요. 연결되면 다시 풀 수 있어요', action: '다시 연결' };
    case 'nickname':
      return allowPractice
        ? { text: '이 닉네임은 온라인에서 쓸 수 없어 연습(기록 안 남음)만 할 수 있어요', action: '다시 확인' }
        : { text: '이 닉네임은 온라인에서 쓸 수 없어요. 닉네임을 바꿔 주세요', action: '다시 확인' };
    default:
      return null;
  }
}

/** 연습을 열지 않을 때(결정 #1의 다른 길) 분야 칸을 누르면 알리는 말 */
export const OFFLINE_NO_PRACTICE_MESSAGE = '온라인에 연결할 수 없어요. 연결되면 다시 시도해 주세요.';

/** 연습 판에서 다시 연결을 묻는 간격: 30초 → 1분 → 2분에서 멈춘다(홈이 보일 때만, 로비 새로고침과 같은 물러섬) */
export const PRACTICE_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];

export function practiceRetryDelay(attempt: number): number {
  const delays = PRACTICE_RETRY_DELAYS_MS;
  return delays[Math.min(Math.max(attempt, 0), delays.length - 1)];
}

