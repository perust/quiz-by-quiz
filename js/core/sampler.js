// 출제 로직 (FR-1.2 ~ FR-1.4, FR-1.7)
// 전부 순수 함수다. 난수 생성기를 인자로 받아 테스트할 때 결과를 고정할 수 있다.

/**
 * Fisher-Yates 셔플. 원본 배열은 그대로 두고 새 배열을 반환한다.
 * @template T
 * @param {T[]} items
 * @param {() => number} random
 * @returns {T[]}
 */
export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 문제 은행에서 출제할 문제를 뽑는다.
 * 직전 판에 나온 문제는 뒤로 밀어 중복 체감을 줄인다 (FR-1.4).
 * 은행이 출제 수보다 적으면 있는 만큼만 낸다.
 *
 * @param {object[]} bank
 * @param {number} count 출제할 문항 수
 * @param {string[]} recentIds 직전 판에 출제된 문제 ID
 * @param {() => number} random
 * @returns {object[]}
 */
export function sampleQuestions(bank, count, recentIds = [], random = Math.random) {
  // recentIds는 최신순이다. 인덱스가 클수록 오래전에 본 문제다
  const seenAt = new Map(recentIds.map((id, index) => [id, index]));

  const fresh = bank.filter((question) => !seenAt.has(question.id));

  // 본 문제끼리는 섞지 않고 «오래전에 본 것»부터 앞에 둔다.
  // 은행이 출제 수보다 작으면 fresh만으로 채울 수 없는데, 그때 무작위로 섞으면
  // 방금 본 문제가 바로 다음 판에 되돌아온다. filter가 새 배열을 주므로
  // sort가 bank를 건드리지는 않는다.
  const stale = bank
    .filter((question) => seenAt.has(question.id))
    .sort((a, b) => seenAt.get(b.id) - seenAt.get(a.id));

  // 신규 문제를 먼저 소진하고, 모자랄 때만 본 문제를 채운다
  const ordered = [...shuffle(fresh, random), ...stale];
  return ordered.slice(0, Math.min(count, ordered.length));
}

/**
 * 보기 순서를 섞고 정답 인덱스를 새 위치로 옮긴다 (FR-1.7).
 * 원본 문제 객체는 건드리지 않는다.
 *
 * @param {object} question
 * @param {() => number} random
 * @returns {object} 보기 순서가 섞인 새 문제 객체
 */
export function shuffleChoices(question, random = Math.random) {
  const entries = question.choices.map((text, index) => ({ text, index }));
  const shuffled = shuffle(entries, random);

  return {
    ...question,
    choices: shuffled.map((entry) => entry.text),
    answerIndex: shuffled.findIndex((entry) => entry.index === question.answerIndex),
  };
}

/**
 * 한 판에 낼 문제 목록을 완성한다. 문제 순서와 보기 순서가 모두 섞인다.
 *
 * @param {{ bank: object[], count: number, recentIds?: string[], random?: () => number }} params
 * @returns {object[]}
 */
export function buildRound({ bank, count, recentIds = [], random = Math.random }) {
  return sampleQuestions(bank, count, recentIds, random).map((question) =>
    shuffleChoices(question, random)
  );
}

/**
 * 전체 모드 한 판 (FR-2.2).
 *
 * 카테고리마다 같은 수만큼 뽑은 뒤 전체 순서를 다시 섞는다.
 * 전체 은행을 한 통에 넣고 무작위로 뽑으면 판마다 카테고리별 문항 수가
 * 달라져 결과 화면의 카테고리별 정답 개수를 서로 비교할 수 없다 (FR-5.6).
 *
 * @param {{
 *   banks: object[][], countPerCategory: number,
 *   recentIds?: string[], random?: () => number
 * }} params banks는 카테고리별 문제 배열의 배열이다
 * @returns {object[]}
 */
export function buildAllRound({ banks, countPerCategory, recentIds = [], random = Math.random }) {
  const picked = banks.flatMap((bank) =>
    sampleQuestions(bank, countPerCategory, recentIds, random)
  );

  return shuffle(picked, random).map((question) => shuffleChoices(question, random));
}
