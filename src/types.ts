// 여러 층이 함께 쓰는 데이터의 모양.
//
// **여기 있는 것은 «층을 넘어 다니는 값»뿐이다.** 한 파일 안에서만 쓰는 모양은
// 그 파일에 둔다 — 여기에 다 모으면 무엇이 경계를 넘는 값인지 알 수 없게 된다.
//
// 문제와 저장 레코드는 PRD 6.1·6.2 의 스키마를 그대로 옮긴 것이다.

/** 카테고리 코드. data/<코드>.json 의 파일명이자 문제의 category 값 */
export type CategoryId = 'history' | 'science' | 'geography' | 'general' | 'art';

/** 한 판의 종류. 카테고리 하나를 풀거나(category) 전부 섞어 푼다(all) */
export type RoundMode = 'category' | 'all';

export type Difficulty = 'easy' | 'normal' | 'hard';

/** 문제 하나 (PRD 6.1). data/*.json 의 원소 */
export interface Question {
  /** 전역 고유. 카테고리를 넘나들며 겹치지 않는다 (FR-1.8) */
  id: string;
  category: CategoryId;
  question: string;
  /** 언제나 넷이다. validate.js 가 그렇지 않은 것을 걸러낸다 */
  choices: string[];
  /** choices 안의 자리. **화면에 뜬 문제는 셔플된 뒤라 JSON 의 값과 다르다** */
  answerIndex: number;
  explanation: string;
  /** v1 에서는 출제에 쓰지 않는다. v2 에서 일괄 수정을 피하려고 스키마에 둔다 */
  difficulty: Difficulty;
  tags: string[];
}

/** 카테고리 정의 (constants.ts) */
export interface Category {
  id: CategoryId;
  name: string;
  icon: string;
  description: string;
}

/** 한 문항에 답한 결과. core/session.ts 가 만든다 */
export interface AnswerRecord {
  questionId: string;
  category: CategoryId;
  /** 고른 보기. **null 이면 시간 초과다** — 이 계약을 바꾸지 말 것 */
  choiceIndex: number | null;
  answerIndex: number;
  correct: boolean;
  timedOut: boolean;
  /** 시간 초과는 제한 시간을 다 쓴 것으로 본다 (FR-5.3) */
  elapsedMs: number;
}

/** 어느 랭킹인가. 카테고리 모드는 카테고리마다, 전체 모드는 하나로 쌓인다 */
export interface RankingTarget {
  mode: RoundMode;
  category: CategoryId | null;
}

/** 문항별 정오. 저장 레코드의 **선택 필드**이고 선생님 모드만 읽는다 */
export interface QuestionResult {
  id: string;
  correct: boolean;
  timedOut: boolean;
}

/** 랭킹에 저장하는 한 판의 기록 (PRD 6.2) */
export interface ScoreRecord {
  id: string;
  nickname: string;
  mode: RoundMode;
  category: CategoryId | null;
  score: number;
  correctCount: number;
  totalCount: number;
  durationMs: number;
  playedAt: string;
  /**
   * PRD 6.2 스키마에 없는 확장. 값이 없거나 깨졌으면 **키 자체를 남기지 않는다** —
   * 빈 배열이 "다 틀렸다"로 읽히면 안 된다.
   */
  questionResults?: QuestionResult[];
}

/** 등급 메시지 (core/scoring.ts). 점수 절댓값이 아니라 정답률로 정한다 */
export interface Grade {
  label: string;
  message: string;
}

/** 결과 화면이 그리는 한 판의 요약 */
export interface RoundSummary {
  mode: RoundMode;
  /** 전체 모드(all)에서는 언제나 null 이다 */
  categoryId: CategoryId | null;
  score: number;
  maxScore: number;
  correctCount: number;
  totalCount: number;
  wrongCount: number;
  accuracy: number;
  durationMs: number;
  grade: Grade;
  /** 전체 모드에서만 쓴다 (FR-5.6) */
  byCategory: CategoryScore[];
  /** 틀린 문제 다시 보기 (FR-5.4) */
  review: ReviewItem[];
  questionResults: QuestionResult[];
}

export interface CategoryScore {
  id: CategoryId;
  name: string;
  correct: number;
  total: number;
}

export interface ReviewItem {
  id: string;
  question: string;
  /** 시간 초과면 고른 보기가 없다 */
  chosenChoice: string | null;
  correctChoice: string;
  explanation: string;
  timedOut: boolean;
}

/** 사용자 설정 (localStorage) */
export interface Settings {
  soundEnabled: boolean;
  gameMode: boolean;
  characterId: string | null;
}

/** 캐릭터 정의 (characters.ts) */
export interface Character {
  /** 저장에 쓰는 값. 바꾸면 예전 선택이 풀린다 */
  id: string;
  /**
   * **화면에 그리지 않는다.** 무엇으로 보이는지는 보는 사람이 정한다.
   * 다만 스크린리더에는 aria-label 로 이 값을 알려준다.
   */
  name: string;
  kind: 'slime' | 'pixel';
  /** slime의 몸통 배경 (CSS) */
  body?: string;
  /** 도트 몬스터의 그림. 한 글자가 한 점이다 */
  grid?: string[];
  /** pixel의 글자 → 색 */
  palette?: Record<string, string>;
}
