// 점수와 결과 집계 (FR-5.1 ~ FR-5.6)
// DOM을 모르는 순수 계산이다. 화면은 여기서 나온 값을 그리기만 한다.

import { CATEGORIES, POINTS_PER_CORRECT } from '../constants.js';
import type {
  AnswerRecord,
  CategoryId,
  CategoryScore,
  Grade,
  Question,
  QuestionResult,
  ReviewItem,
  RoundMode,
  RoundSummary,
} from '../types.js';

/** 등급 하나. min은 이 등급이 시작되는 정답률이다 */
interface GradeBand extends Grade {
  min: number;
}

/**
 * 정답률 구간별 등급 (FR-5.5).
 *
 * PRD 예시는 "90점↑ 상식왕"이지만 그건 100점 만점인 카테고리 모드 기준이다.
 * 전체 모드는 400점 만점이라 점수 절댓값으로 나누면 등급이 아예 뜨지 않는다.
 * 그래서 정답률로 구간을 잡는다. 카테고리 모드에서는 결과가 PRD 예시와 같다.
 */
const GRADES: GradeBand[] = [
  { min: 1, label: '완벽합니다', message: '한 문제도 놓치지 않았어요.' },
  { min: 0.9, label: '상식왕', message: '웬만한 건 다 알고 계시네요.' },
  { min: 0.7, label: '훌륭해요', message: '탄탄한 상식입니다.' },
  { min: 0.5, label: '무난합니다', message: '절반은 넘겼어요. 한 판 더 어떠세요?' },
  { min: 0.3, label: '조금만 더', message: '해설을 읽고 다시 도전해 보세요.' },
  { min: 0, label: '다시 도전', message: '틀린 문제부터 살펴보면 금방 올라갑니다.' },
];

function gradeFor(accuracy: number): Grade {
  return GRADES.find((grade) => accuracy >= grade.min) ?? GRADES[GRADES.length - 1];
}

/**
 * 카테고리별 정답 개수 (FR-5.6).
 * 순서는 카테고리 정의 순서를 따르고, 이번 판에 나오지 않은 카테고리는 뺀다.
 */
function tallyByCategory(questions: Question[], answers: AnswerRecord[]): CategoryScore[] {
  const tally = new Map<CategoryId, { correct: number; total: number }>();

  questions.forEach((question, index) => {
    const current = tally.get(question.category) ?? { correct: 0, total: 0 };
    current.total += 1;
    if (answers[index]?.correct) current.correct += 1;
    tally.set(question.category, current);
  });

  return CATEGORIES.filter((category) => tally.has(category.id)).map((category) => ({
    id: category.id,
    name: category.name,
    // 바로 위 filter가 has로 걸러 두어 get은 반드시 값을 준다
    ...tally.get(category.id)!,
  }));
}

/**
 * 틀린 문제 목록 (FR-5.4). 시간 초과도 오답으로 함께 담는다.
 * answers[i]는 questions[i]에 대한 응답이다.
 */
function collectReview(questions: Question[], answers: AnswerRecord[]): ReviewItem[] {
  return answers
    .map((answer, index) => ({ answer, question: questions[index] }))
    .filter(({ answer, question }) => question && !answer.correct)
    .map(({ answer, question }) => ({
      id: question.id,
      question: question.question,
      explanation: question.explanation,
      correctChoice: question.choices[question.answerIndex],
      // 시간 초과면 고른 보기가 없다.
      // 뒤집으면 timedOut이 false일 때 choiceIndex는 반드시 number인데(session이 그렇게
      // 만든다) 그 계약이 AnswerRecord의 두 필드에 나뉘어 있어 TS는 잇지 못한다
      chosenChoice: answer.timedOut ? null : question.choices[answer.choiceIndex!],
      timedOut: answer.timedOut,
    }));
}

/**
 * 문항별 정오를 압축해 담는다. 저장 레코드에 실려 선생님 모드가 문항 단위로 분석한다.
 *
 * `correct`와 `timedOut`을 나눠 두는 이유는 처방이 다르기 때문이다.
 * 몰라서 틀린 것과 시간이 모자라 못 푼 것은 지도 방법이 다르다.
 */
function collectQuestionResults(questions: Question[], answers: AnswerRecord[]): QuestionResult[] {
  return answers
    .map((answer, index) => ({ answer, question: questions[index] }))
    .filter(({ question }) => question?.id)
    .map(({ answer, question }) => ({
      id: question.id,
      correct: answer.correct,
      timedOut: answer.timedOut,
    }));
}

/** questions와 answers는 같은 순서로 짝지어진다 */
export interface SummarizeParams {
  questions: Question[];
  answers: AnswerRecord[];
  mode: RoundMode;
  categoryId?: CategoryId | null;
}

/**
 * 한 판의 결과를 계산한다.
 */
export function summarizeRound({ questions, answers, mode, categoryId = null }: SummarizeParams): RoundSummary {
  const totalCount = questions.length;
  const correctCount = answers.filter((answer) => answer.correct).length;
  const accuracy = totalCount > 0 ? correctCount / totalCount : 0;

  return {
    mode,
    categoryId: mode === 'all' ? null : categoryId,
    totalCount,
    correctCount,
    wrongCount: totalCount - correctCount,

    // 정답당 10점 고정. 속도 보너스도 난이도 배점도 없다 (FR-5.1)
    score: correctCount * POINTS_PER_CORRECT,
    maxScore: totalCount * POINTS_PER_CORRECT,
    accuracy,

    // 문항별 응답 시간의 합. 해설을 읽은 시간은 타이머가 멈춰 있어 빠져 있고,
    // 시간 초과 문항은 session이 이미 20초로 맞춰 넣었다 (FR-5.3).
    // performance.now()가 소수를 주므로 저장 전에 밀리초로 떨군다
    durationMs: Math.round(answers.reduce((sum, answer) => sum + answer.elapsedMs, 0)),

    grade: gradeFor(accuracy),
    byCategory: tallyByCategory(questions, answers),
    review: collectReview(questions, answers),

    // 문항별 정오. 화면에는 쓰지 않고 저장 레코드에 함께 남긴다.
    // 문제 텍스트는 넣지 않는다 — data/*.json 과 중복되고 용량만 늘어난다.
    // 선생님 모드가 id로 문제 은행과 이어 붙여 문항 단위 정답률을 낸다.
    questionResults: collectQuestionResults(questions, answers),
  };
}
