// 문제 데이터 형식 검증 (FR-1.9)
// DOM도 네트워크도 건드리지 않는 순수 함수. 입력을 받아 검증 결과를 반환한다.

import { CHOICE_COUNT } from '../constants.js';

/** 반드시 있어야 하는 문자열 필드 (FR-1.5) */
const REQUIRED_TEXT_FIELDS = ['id', 'category', 'question', 'explanation'];

const isFilledText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * 문제 하나를 검사해 오류 메시지 배열을 반환한다.
 * 빈 배열이면 정상 문제다.
 * @param {unknown} question
 * @param {string} [expectedCategory] 파일이 속한 카테고리 코드
 * @returns {string[]}
 */
export function validateQuestion(question, expectedCategory) {
  if (question === null || typeof question !== 'object' || Array.isArray(question)) {
    return ['문제가 객체 형태가 아닙니다'];
  }

  const errors = [];

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!isFilledText(question[field])) {
      errors.push(`필수 필드가 비어 있거나 문자열이 아닙니다: ${field}`);
    }
  }

  if (expectedCategory && question.category !== expectedCategory) {
    errors.push(`category 값이 파일과 다릅니다 (기대: ${expectedCategory}, 실제: ${question.category})`);
  }

  if (!Array.isArray(question.choices)) {
    errors.push('choices가 배열이 아닙니다');
  } else {
    if (question.choices.length !== CHOICE_COUNT) {
      errors.push(`보기는 ${CHOICE_COUNT}개여야 합니다 (실제: ${question.choices.length}개)`);
    }
    if (!question.choices.every(isFilledText)) {
      errors.push('비어 있거나 문자열이 아닌 보기가 있습니다');
    }
  }

  if (!Number.isInteger(question.answerIndex)) {
    errors.push('answerIndex가 정수가 아닙니다');
  } else if (
    !Array.isArray(question.choices) ||
    question.answerIndex < 0 ||
    question.answerIndex >= question.choices.length
  ) {
    errors.push(`answerIndex가 보기 범위를 벗어났습니다 (값: ${question.answerIndex})`);
  }

  return errors;
}

/**
 * 문제 목록을 검사해 정상 문제와 제외된 문제를 나눠 반환한다.
 * 불량 문제는 출제 대상에서 빠진다 (FR-1.9).
 *
 * @param {unknown[]} questions
 * @param {string} categoryId
 * @param {Set<string>} seenIds 이미 등록된 문제 ID. 카테고리를 넘나드는 중복까지 잡는다 (FR-1.8)
 * @returns {{ accepted: object[], rejected: {id: unknown, errors: string[]}[] }}
 */
export function validateQuestionBank(questions, categoryId, seenIds = new Set()) {
  const accepted = [];
  const rejected = [];

  questions.forEach((question, position) => {
    const errors = validateQuestion(question, categoryId);
    const id = question?.id;

    if (errors.length === 0 && seenIds.has(id)) {
      errors.push(`문제 ID가 중복됩니다: ${id}`);
    }

    if (errors.length > 0) {
      rejected.push({ id: id ?? `(${position + 1}번째 항목)`, errors });
      return;
    }

    seenIds.add(id);
    accepted.push(question);
  });

  return { accepted, rejected };
}
