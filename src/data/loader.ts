// 카테고리별 문제 JSON을 불러와 검증까지 마친 문제 은행을 만든다 (FR-1.6, FR-1.9)

import { CATEGORIES, DATA_DIR } from '../constants.js';
import { validateQuestionBank } from './validate.js';
import type { Category, CategoryId, Question } from '../types.js';

/** 카테고리 코드로 문제 목록을 찾는다. 불러오지 못한 카테고리는 빈 배열이 된다 */
export type QuestionBanks = Record<CategoryId, Question[]>;

/** 불러오지 못한 카테고리. 화면이 어느 분야가 빠졌는지 알릴 때 쓴다 */
export interface FailedCategory {
  id: CategoryId;
  message: string;
}

/**
 * 카테고리 JSON 하나를 읽어 배열로 반환한다.
 * 실패하면 예외를 던진다.
 *
 * 원소는 아직 `Question`이 아니다 — 검증은 validateQuestionBank가 한다.
 */
async function fetchCategoryFile(categoryId: CategoryId): Promise<unknown[]> {
  const response = await fetch(`${DATA_DIR}/${categoryId}.json`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed)) {
    throw new Error('최상위가 배열이 아닙니다');
  }
  return parsed;
}

/** 한 카테고리를 불러온 결과. 실패해도 나머지는 계속 간다 */
interface LoadedCategory {
  category: Category;
  questions: unknown[];
  error: Error | null;
}

/**
 * 앱 시작 시 한 번 호출한다. 네 개 파일을 동시에 요청하고,
 * 검증은 ID 중복 판정이 일정하도록 카테고리 정의 순서대로 처리한다.
 */
export async function loadQuestionBanks(): Promise<{ banks: QuestionBanks; failedCategories: FailedCategory[] }> {
  const settled: LoadedCategory[] = await Promise.all(
    CATEGORIES.map(async (category) => {
      try {
        return { category, questions: await fetchCategoryFile(category.id), error: null };
      } catch (error) {
        // fetch도 JSON 파싱도 Error를 던진다. 아래에서 message만 읽는다
        return { category, questions: [], error: error as Error };
      }
    })
  );

  const seenIds = new Set<string>();
  // CATEGORIES를 빠짐없이 도므로 돌려줄 때는 모든 카테고리가 채워져 있다
  const banks: Partial<QuestionBanks> = {};
  const failedCategories: FailedCategory[] = [];

  for (const { category, questions, error } of settled) {
    if (error) {
      failedCategories.push({ id: category.id, message: error.message });
      console.error(`[문제 로딩 실패] ${category.name}(${category.id}): ${error.message}`);
      banks[category.id] = [];
      continue;
    }

    const { accepted, rejected } = validateQuestionBank(questions, category.id, seenIds);

    for (const item of rejected) {
      console.warn(`[문제 제외] ${category.name} / ${item.id}: ${item.errors.join(' · ')}`);
    }

    banks[category.id] = accepted;
  }

  return { banks: banks as QuestionBanks, failedCategories };
}
