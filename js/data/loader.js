// 카테고리별 문제 JSON을 불러와 검증까지 마친 문제 은행을 만든다 (FR-1.6, FR-1.9)

import { CATEGORIES, DATA_DIR } from '../constants.js';
import { validateQuestionBank } from './validate.js';

/**
 * 카테고리 JSON 하나를 읽어 배열로 반환한다.
 * 실패하면 예외를 던진다.
 */
async function fetchCategoryFile(categoryId) {
  const response = await fetch(`${DATA_DIR}/${categoryId}.json`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const parsed = await response.json();
  if (!Array.isArray(parsed)) {
    throw new Error('최상위가 배열이 아닙니다');
  }
  return parsed;
}

/**
 * 앱 시작 시 한 번 호출한다. 네 개 파일을 동시에 요청하고,
 * 검증은 ID 중복 판정이 일정하도록 카테고리 정의 순서대로 처리한다.
 *
 * @returns {Promise<{ banks: Record<string, object[]>, failedCategories: {id: string, message: string}[] }>}
 */
export async function loadQuestionBanks() {
  const settled = await Promise.all(
    CATEGORIES.map(async (category) => {
      try {
        return { category, questions: await fetchCategoryFile(category.id), error: null };
      } catch (error) {
        return { category, questions: [], error };
      }
    })
  );

  const seenIds = new Set();
  const banks = {};
  const failedCategories = [];

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

  return { banks, failedCategories };
}
