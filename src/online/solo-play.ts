// 혼자 푸는 온라인 판 (PRD FR-7.13 3단계) — 홈이 무엇을 여는가와 네 소유자 결정 (PRD 10.1 #8–#11).
//
// 소유자 방향: 혼자 하기를 없애고 혼자 하고 싶은 사람도 온라인에서 혼자 푼다. 그래서 홈의 분야 칸과
// 「전체 도전」은 대기실을 거치지 않는 혼자 온라인 판을 곧바로 연다(POST /v1/solo). 서버가 채점하고 기록한다.
// DOM도 저장소도 모르는 순수 함수다 — app.ts가 저장소의 답을 넘기고 홈·결과·설정이 여기서 말을 받는다.
//
// **네 결정은 소유자가 정했다** (2026-10-28). 아래 «결정 #1–#4»는 PRD 10.1 #8–#11이다(옛 10.2 #1–#4).
// - #1 서버에 닿지 않으면 «연습(기록 안 남음)»을 연다(`probeResult`의 `practice`, docs/p2p-review.md가 P2P 대신
//   권한 길). 다시 묻는 물러섬이 서버가 돌아오면 혼자 온라인 판으로 되돌린다
// - #2 혼자 온라인 판의 문항 시간은 설정의 20초·40초·«제한 없음»이다(`soloQuestionTime`). «제한 없음»은 마감이
//   없는 판(서버의 문항 시간 null, migration 013)이고 로컬 «제한 없음»과 같은 규칙이다. 친구와 푸는 방은 그대로
//   20초·40초다. 서버가 그것을 안다고 알리지 않으면(세션의 `soloUntimed`) null을 보내지 않고 20초로 연다
// - #3 결과의 «홈으로»는 혼자 방을 지운다 — 같은 방의 지난 판으로 피하던 최근 출제 기억(N08)도 함께 사라진다
// - #4 혼자 판이 도는데 다른 판(분야·전체 도전)을 고르면 그 판을 기록 없이 끝내고 고른 판을 연다(확인창 없이,
//   `soloEndedMessage`로 알린다). 같은 판이면 잇는다. 서버가 그것을 안다고 알리지 않으면(`soloRestart`) 예전처럼
//   도는 판으로 돌아갈 줄을 보인다(`soloStillRunningMessage`)

import { ONLINE_QUESTION_TIME_CHOICES, TIME_LIMIT_MS } from '../constants.js';
import type { SoloQuestionTime } from '../types.js';
import { ApiFailure, isNicknameRejection } from './rules.js';

/**
 * 결정 #2: 혼자 온라인 판의 문항 시간은 설정의 값이다 — 20초·40초, «제한 없음»(null)이면 마감 없는 판이다.
 * `untimedSupported`는 서버가 «제한 없음» 혼자 판을 안다고 알렸는가(세션의 `soloUntimed`)다 — 모르는 API에는
 * null을 보내지 않고 기본 20초로 연다. 목록 밖의 값도 기본 20초다
 */
export function soloQuestionTime(limitMs: number | null, untimedSupported: boolean): SoloQuestionTime {
  if (limitMs === null) return untimedSupported ? null : TIME_LIMIT_MS;
  return ONLINE_QUESTION_TIME_CHOICES.find((choice) => choice === limitMs) ?? TIME_LIMIT_MS;
}

/**
 * 홈의 분야 칸이 여는 것.
 * - `checking`: 아직 묻는 중이다(부팅 직후). 누르면 답을 기다렸다가 고른다. 물음이 끝나면 늘 아래 셋 가운데 하나다
 * - `online`: 혼자 푸는 온라인 판(서버가 채점·기록)
 * - `local`: 이 기능을 모르는 이전 API — 예전 그대로 혼자 하기(로컬, 이 브라우저에 기록). 서버가 답했는데 세션을 열지
 *   못해(요청 한도·규칙 전에 지은 닉네임) **이 API가 아는지 모를 때**도 이것이다 — 모르는 API면 오늘의 혼자 하기가 맞다
 * - `practice`: 서버에 닿지 않는다·서버 없이 열었다·혼자 판 자리가 찼다·혼자 판을 아는 API가 닉네임을 거절했다 — 연습(기록 안 남음)
 */
export type HomePlayMode = 'checking' | 'online' | 'local' | 'practice';

/**
 * 연습인 까닭. 홈의 안내 줄이 그 까닭을 말한다. `offline`·`full`은 홈이 보이는 동안 물러서며 다시 묻고,
 * `nickname`은 닉네임을 바꾸면 다시 묻는다. `no-server`(서버 없이 연 화면)는 줄 없이 캡션만 말한다
 */
export type PracticeReason = 'offline' | 'full' | 'no-server' | 'nickname';

/**
 * 서버의 답(또는 실패)을 홈의 판 종류로 옮긴 것. 언제나 판 종류가 정해진다 — 물음이 끝났는데 `checking`에 남아
 * 분야 칸이 아무 일도 하지 않는 일이 없다. `refused`는 서버가 답했지만 지금은 거절했다는 말(요청 한도 등)이다
 */
export type PlayProbe =
  | { mode: 'online' | 'local'; refused?: string }
  | { mode: 'practice'; reason: PracticeReason };

/** 이미 아는 이 API의 규칙(세션 응답). 아직 세션을 열지 못했으면 null — 혼자 판을 아는지 모른다 */
export interface KnownSoloRules {
  soloPlay: boolean;
}

/** 서버가 혼자 판 자리가 모두 찼다고 거절한 코드 (503, `POST /v1/solo`) */
export const SOLO_FULL_CODE = 'solo-busy';

/**
 * 서버에 닿지 않은 것인가 (결정 #1의 «API cannot be reached»). 연결 실패·응답 시간 초과·5xx(DB가 안 되거나
 * migration을 기다리는 API, 혼자 판 자리가 찬 API 포함)·읽을 수 없는 응답이 그렇다. 서버가 4xx로 거절한 것(요청
 * 한도·잘못된 요청)과 닉네임 금칙 규칙은 닿은 것이다 — 결정 #1의 연습이 아니다(`probeResult`가 따로 정한다).
 */
export function isServerUnreachable(error: unknown): boolean {
  if (isNicknameRejection(error)) return false;
  if (error instanceof ApiFailure) return error.status >= 500;
  return true;
}

/**
 * 세션·내 최고 기록·혼자 판 요청의 결과를 판 종류로 옮긴다. `supported`는 그 API가 혼자 온라인 판을 아는지
 * (세션의 `soloPlay`)이고, 요청이 던졌으면 `error`다. `known`은 앞서 세션을 열며 배운 규칙이다(없으면 null).
 *
 * 호환이 먼저다 — 이 API가 혼자 판을 모른다고 이미 알면 서버가 닿든 말든 오늘의 혼자 하기(`local`)다(로컬 판은 서버가
 * 필요 없다). 서버에 닿지 않으면 결정 #1의 연습이다. 닿았는데 거절했으면(요청 한도·닉네임) 이 API가 아는지에 따라
 * 정한다: 모르면 오늘의 혼자 하기, 혼자 판을 아는 API면 그 판(거절한 말을 함께 넘긴다)이나 닉네임 연습이다.
 */
export function probeResult(
  outcome: { supported: boolean } | { error: unknown },
  known: KnownSoloRules | null = null,
): PlayProbe {
  if ('supported' in outcome) return outcome.supported ? { mode: 'online' } : { mode: 'local' };
  const { error } = outcome;
  if (known !== null && !known.soloPlay) return { mode: 'local' };
  if (isServerUnreachable(error)) {
    const full = error instanceof ApiFailure && error.code === SOLO_FULL_CODE;
    return { mode: 'practice', reason: full ? 'full' : 'offline' };
  }
  if (isNicknameRejection(error)) return known === null ? { mode: 'local' } : { mode: 'practice', reason: 'nickname' };
  return {
    mode: known === null ? 'local' : 'online',
    refused: error instanceof ApiFailure ? error.message : '잠시 후 다시 시도해 주세요.',
  };
}

/**
 * 다시 물었는데 아직 연습일 때 알리는 말 (홈의 «다시 연결»·«다시 확인»·«다시 시도»). 눈으로 보는 줄은 그대로라
 * 누른 사람이 아무 일도 없었다고 여기지 않게 한다
 */
export function practiceStillMessage(reason: PracticeReason): string {
  switch (reason) {
    case 'nickname':
      return '이 닉네임은 아직 온라인에서 쓸 수 없어요. 닉네임을 바꿔 주세요.';
    case 'full':
      return '아직 혼자 판 자리가 모두 찼어요. 연습(기록 안 남음)은 할 수 있어요.';
    default:
      return '아직 온라인에 연결할 수 없어요. 연습(기록 안 남음)은 할 수 있어요.';
  }
}

/** 연습 안내 줄. `action`이 있으면 그 줄이 버튼이 되어 다시 연결을 시도한다(닉네임은 홈의 닉네임 카드가 고친다) */
export interface PracticeNote {
  text: string;
  action: string | null;
}

/**
 * 홈 dock 맨 위의 연습 안내 줄 (결정 #1). 서버 없이 연 화면(개발 문서)은 줄을 두지 않고 캡션만 말한다
 */
export function practiceNote(reason: PracticeReason): PracticeNote | null {
  switch (reason) {
    case 'offline':
      return { text: '온라인에 연결할 수 없어 연습(기록 안 남음)만 할 수 있어요', action: '다시 연결' };
    case 'full':
      return { text: '지금은 혼자 판 자리가 모두 차 연습(기록 안 남음)만 할 수 있어요', action: '다시 시도' };
    case 'nickname':
      return { text: '이 닉네임은 온라인에서 쓸 수 없어 연습(기록 안 남음)만 할 수 있어요', action: '다시 확인' };
    default:
      return null;
  }
}

/**
 * 홈 dock 줄에 잠시 띄우는 알림 (연습 안내가 없을 때 같은 자리). 눈으로 보는 사람에게도 왜 판이 열리지 않았는지 말한다 —
 * 낭독용 `announce`만으로는 분야 칸을 눌러도 아무 일이 없어 보였다.
 * - `limited`: 혼자 판을 아는 API가 지금은 거절했다(요청 한도). «다시 시도»가 같은 판을 다시 연다
 * - `missing`: 풀던 혼자 판이 서버에 없다(오래 비워 정리됐다). «확인»이 줄을 거둔다
 */
export type DockNoticeKind = 'limited' | 'missing';

export function dockNoticeNote(kind: DockNoticeKind): { text: string; action: string } {
  return kind === 'limited'
    ? { text: '요청이 많아 판을 바로 열지 못했어요', action: '다시 시도' }
    : { text: '풀던 혼자 판을 찾지 못했어요. 분야를 골라 새로 시작해요', action: '확인' };
}

/**
 * 결정 #4: 다른 판을 골라 풀던 혼자 판을 끝냈다 (`POST /v1/solo`의 `ended`). 확인창 없이 새 판의 화면에 보이고
 * 낭독한다. 끝까지 풀지 않은 판은 기록되지 않는다(FR-6, 로컬 N04) — 마지막 공개만 남았던 판은 끝까지 푼 판이라
 * 기록됐다고 말한다
 */
export function soloEndedMessage(label: string, recorded: boolean): string {
  return recorded
    ? `다 푼 «${label}» 판은 점수를 기록하고 끝냈어요.`
    : `풀던 «${label}» 판은 끝까지 풀지 않아 기록 없이 끝냈어요.`;
}

/**
 * 풀던 혼자 판이 아직 돌고 있어 고른 판을 열지 못했다 (`POST /v1/solo`의 `resumed`인데 분야가 다르다). 결정 #4의
 * 끝내고 새로 열기를 모르는 API(세션에 `soloRestart`가 없다)에서만이다 — 홈이 그 판으로 돌아갈 길을 보인다
 */
export function soloStillRunningMessage(label: string): string {
  return `풀던 «${label}» 판이 아직 진행 중이라 새 판을 열 수 없어요. 「이어 풀기」로 돌아가거나 그 판이 끝난 뒤에 시작해 주세요.`;
}

/** 홈 복귀 줄의 혼자 판 글. 판 이름(분야·전체 도전)을 함께 말한다 — 고른 칸과 다른 판이 도는 까닭이 보인다 */
export function soloRoomNoteText(label: string | undefined): string {
  return label ? `풀던 «${label}» 판이 아직 진행 중이에요` : '풀던 혼자 판이 있어요';
}

/** 연습 판에서 다시 연결을 묻는 간격: 30초 → 1분 → 2분에서 멈춘다(홈이 보일 때만, 로비 새로고침과 같은 물러섬) */
export const PRACTICE_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];

export function practiceRetryDelay(attempt: number): number {
  const delays = PRACTICE_RETRY_DELAYS_MS;
  return delays[Math.min(Math.max(attempt, 0), delays.length - 1)];
}

