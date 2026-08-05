// 문제 데이터 형식 검증 (FR-1.9)
// DOM도 네트워크도 건드리지 않는 순수 함수. 입력을 받아 검증 결과를 반환한다.

import { CHOICE_COUNT } from '../constants.js';
import type { Question } from '../types.js';

/** 반드시 있어야 하는 문자열 필드 (FR-1.5) */
const REQUIRED_TEXT_FIELDS = ['id', 'category', 'question', 'explanation'];

const isFilledText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** 정수인가. `Number.isInteger`와 같은 판정이면서 타입까지 좁혀 준다 */
const isInteger = (value: unknown): value is number => Number.isInteger(value);

/** 제외된 문제. id는 없거나 문자열이 아닐 수도 있어 무엇이든 받는다 */
export interface RejectedQuestion {
  id: unknown;
  errors: string[];
}

/**
 * 문제 하나를 검사해 오류 메시지 배열을 반환한다.
 * 빈 배열이면 정상 문제다.
 *
 * @param question 아직 문제라고 볼 수 없는 값. 그래서 unknown으로 받는다
 * @param expectedCategory 파일이 속한 카테고리 코드
 */
export function validateQuestion(question: unknown, expectedCategory?: string): string[] {
  if (question === null || typeof question !== 'object' || Array.isArray(question)) {
    return ['문제가 객체 형태가 아닙니다'];
  }

  // 객체인 것까지만 안다. 필드 하나하나는 아래에서 본다
  const candidate = question as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!isFilledText(candidate[field])) {
      errors.push(`필수 필드가 비어 있거나 문자열이 아닙니다: ${field}`);
    }
  }

  if (expectedCategory && candidate.category !== expectedCategory) {
    errors.push(`category 값이 파일과 다릅니다 (기대: ${expectedCategory}, 실제: ${candidate.category})`);
  }

  if (!Array.isArray(candidate.choices)) {
    errors.push('choices가 배열이 아닙니다');
  } else {
    if (candidate.choices.length !== CHOICE_COUNT) {
      errors.push(`보기는 ${CHOICE_COUNT}개여야 합니다 (실제: ${candidate.choices.length}개)`);
    }
    if (!candidate.choices.every(isFilledText)) {
      errors.push('비어 있거나 문자열이 아닌 보기가 있습니다');
    }
  }

  if (!isInteger(candidate.answerIndex)) {
    errors.push('answerIndex가 정수가 아닙니다');
  } else if (
    !Array.isArray(candidate.choices) ||
    candidate.answerIndex < 0 ||
    candidate.answerIndex >= candidate.choices.length
  ) {
    errors.push(`answerIndex가 보기 범위를 벗어났습니다 (값: ${candidate.answerIndex})`);
  }

  return errors;
}

/**
 * 문제 목록을 검사해 정상 문제와 제외된 문제를 나눠 반환한다.
 * 불량 문제는 출제 대상에서 빠진다 (FR-1.9).
 *
 * @param questions JSON에서 읽은 그대로의 값
 * @param categoryId
 * @param seenIds 이미 등록된 문제 ID. 카테고리를 넘나드는 중복까지 잡는다 (FR-1.8)
 */
export function validateQuestionBank(
  questions: unknown[],
  categoryId: string,
  seenIds: Set<string> = new Set()
): { accepted: Question[]; rejected: RejectedQuestion[] } {
  const accepted: Question[] = [];
  const rejected: RejectedQuestion[] = [];

  questions.forEach((question, position) => {
    const errors = validateQuestion(question, categoryId);
    const id = (question as Partial<Question> | null | undefined)?.id;

    // 검사를 통과했다면 id는 비어 있지 않은 문자열이다 — validateQuestion이 그것부터 본다.
    // 그래서 아래 세 자리는 통과한 값에만 문자열로 다룬다
    if (errors.length === 0 && seenIds.has(id as string)) {
      errors.push(`문제 ID가 중복됩니다: ${id}`);
    }

    if (errors.length > 0) {
      rejected.push({ id: id ?? `(${position + 1}번째 항목)`, errors });
      return;
    }

    seenIds.add(id as string);
    accepted.push(question as Question);
  });

  return { accepted, rejected };
}
