// 한 판의 진행 상태와 채점 (FR-3.1 ~ FR-3.4)
// DOM을 모르는 순수 로직이다. 화면은 이 객체가 돌려주는 값만 보고 그린다.

import { TIME_LIMIT_MS } from '../constants.js';

/**
 * 선택한 보기가 정답인지 판정한다.
 * @param {object} question 보기 순서가 이미 섞인 문제
 * @param {number} choiceIndex
 */
export function isCorrect(question, choiceIndex) {
  return choiceIndex === question.answerIndex;
}

/**
 * 퀴즈 세션을 만든다.
 *
 * @param {{ questions: object[], mode?: 'category'|'all', categoryId?: string|null }} params
 */
export function createSession({ questions, mode = 'category', categoryId = null }) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('출제할 문제가 없습니다');
  }

  /** @type {object[]} 문항별 응답 기록. 점수 계산은 2단계에서 이 기록을 쓴다 */
  const answers = [];
  let index = 0;

  return {
    mode,
    categoryId,

    /** 총 문항 수 */
    get total() {
      return questions.length;
    },

    /** 현재 문항 번호 (1부터) */
    get position() {
      return index + 1;
    },

    /** 진행 바에 쓸 비율 0~1. 답을 낼 때마다 올라간다 */
    get progressRatio() {
      return answers.length / questions.length;
    },

    /** 지금 화면에 띄울 문제 */
    currentQuestion() {
      return questions[index];
    },

    /** 현재 문항에 이미 답했는가 (FR-3.3) */
    isAnswered() {
      return answers.length > index;
    },

    /**
     * 답을 확정한다. 같은 문항에 두 번째로 들어온 호출은 무시하고
     * 처음 기록을 그대로 돌려준다 (FR-3.3).
     *
     * @param {{ choiceIndex: number|null, elapsedMs: number }} input
     *   choiceIndex가 null이면 시간 초과다 (FR-3.10).
     * @returns {{questionId: string, category: string, choiceIndex: number|null,
     *            answerIndex: number, correct: boolean, timedOut: boolean, elapsedMs: number}}
     */
    submit({ choiceIndex, elapsedMs }) {
      if (answers.length > index) {
        return answers[index];
      }

      const question = questions[index];
      const timedOut = choiceIndex === null;

      const record = {
        questionId: question.id,
        category: question.category,
        choiceIndex,
        answerIndex: question.answerIndex,
        correct: !timedOut && isCorrect(question, choiceIndex),
        timedOut,
        // 시간 초과는 제한 시간을 다 쓴 것으로 본다 (FR-5.3)
        elapsedMs: Math.min(timedOut ? TIME_LIMIT_MS : elapsedMs, TIME_LIMIT_MS),
      };

      answers.push(record);
      return record;
    },

    /** 다음 문제가 남아 있는가 */
    hasNext() {
      return index < questions.length - 1;
    },

    /** 다음 문제로 넘어간다. 이전 문제로는 돌아갈 수 없다 (FR-3.4) */
    goNext() {
      if (this.hasNext()) index += 1;
      return questions[index];
    },

    /** 모든 문항에 답했는가 */
    isFinished() {
      return answers.length === questions.length;
    },

    /** 응답 기록 사본 */
    getAnswers() {
      return [...answers];
    },

    /**
     * 이번 판에 출제된 문제 사본. getAnswers()와 같은 순서로 짝지어진다.
     * 결과 화면의 오답 리뷰가 문제 원문과 해설을 필요로 한다 (FR-5.4).
     */
    getQuestions() {
      return [...questions];
    },

    /** 이번 판에 출제된 문제 ID (다음 판 후순위 판정에 쓴다, FR-1.4) */
    getQuestionIds() {
      return questions.map((question) => question.id);
    },
  };
}
