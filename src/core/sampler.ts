// 출제 로직 (FR-1.2 ~ FR-1.4, FR-1.7, FR-1.10)
// 전부 순수 함수다. 난수 생성기를 인자로 받아 테스트할 때 결과를 고정할 수 있다.
// 서버의 온라인 출제(`server/app/question_catalog.py`의 `select_round`)도 같은 규칙을 쓴다 —
// 한쪽을 고치면 다른 쪽도 고친다.

import type { Difficulty, Question } from '../types.js';

/**
 * Fisher-Yates 셔플. 원본 배열은 그대로 두고 새 배열을 반환한다.
 */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 은행에 쓰는 난이도 셋 (PRD 6.1) */
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

/** 난이도를 모르는 문제(값이 없거나 셋 밖)가 함께 드는 칸 */
const UNKNOWN_DIFFICULTY = 'unknown';

/** 몫을 나누는 칸. 셋 가운데 하나이거나 «모름» 하나다 */
export type DifficultyBucket = Difficulty | typeof UNKNOWN_DIFFICULTY;

/** 몫을 나누는 칸의 순서. 나머지가 같을 때의 무작위 말고는 이 순서가 결과를 바꾸지 않는다 */
const BUCKET_ORDER: readonly DifficultyBucket[] = [...DIFFICULTIES, UNKNOWN_DIFFICULTY];

/**
 * 문제가 드는 난이도 칸. `data/validate.ts` 는 난이도를 보지 않으므로 JSON 에 무엇이 오든
 * 여기서 좁힌다 — 셋 밖의 값은 모두 한 칸이다. 은행 전체가 그러면 칸이 하나뿐이라
 * 난이도를 보지 않던 예전 출제와 같아진다.
 */
export function difficultyBucket(question: Question): DifficultyBucket {
  // 타입은 Difficulty 지만 실제 값은 검증하지 않은 JSON 이라 unknown 으로 다시 본다
  const value: unknown = question.difficulty;
  return DIFFICULTIES.find((level) => level === value) ?? UNKNOWN_DIFFICULTY;
}

/**
 * 한 판의 난이도별 몫 (FR-1.10). 은행의 난이도 비율 × 낼 문항 수를 **최대 나머지 방식**으로
 * 정수로 나눈다 — 내림한 몫을 먼저 주고, 남은 자리를 나머지가 큰 칸부터 하나씩 더 준다.
 * 나머지가 같은 칸끼리는 무작위로 고른다(늘 같은 칸이 이기면 그 난이도가 판마다 덜 나온다).
 *
 * 몫과 나머지는 정수로만 셈한다(`take × 칸 크기`를 은행 크기로 나눈 몫과 나머지). 소수로 셈하면
 * 같은 나머지가 부동소수 오차로 갈려 무작위여야 할 자리가 한쪽으로 기운다.
 * `take` 가 은행 크기를 넘지 않으면 어느 칸의 몫도 그 칸의 문제 수를 넘지 않는다.
 */
export function difficultyQuotas(
  bank: readonly Question[],
  take: number,
  random: () => number = Math.random,
): Map<DifficultyBucket, number> {
  const sizes = new Map<DifficultyBucket, number>();
  for (const question of bank) {
    const bucket = difficultyBucket(question);
    sizes.set(bucket, (sizes.get(bucket) ?? 0) + 1);
  }

  const quotas = new Map<DifficultyBucket, number>();
  if (bank.length === 0) return quotas;

  const buckets = BUCKET_ORDER.filter((bucket) => sizes.has(bucket));
  const ranked: { bucket: DifficultyBucket; remainder: number; tie: number }[] = [];
  let given = 0;
  for (const bucket of buckets) {
    // 바로 위 filter 가 has 로 걸러 두어 get 은 반드시 값을 준다
    const share = take * sizes.get(bucket)!;
    const floor = Math.floor(share / bank.length);
    quotas.set(bucket, floor);
    given += floor;
    ranked.push({ bucket, remainder: share % bank.length, tie: random() });
  }
  ranked.sort((a, b) => b.remainder - a.remainder || a.tie - b.tie);
  // 남은 자리는 칸 수보다 적다(나머지의 합이 은행 크기 × 칸 수보다 작다)
  for (const { bucket } of ranked.slice(0, Math.max(0, take - given))) {
    // ranked 의 칸은 모두 바로 위 반복에서 몫을 적은 칸이다
    quotas.set(bucket, quotas.get(bucket)! + 1);
  }
  return quotas;
}

/**
 * 출제 순서의 층을 앞에서부터 돌며 몫대로 고른다 (FR-1.4 안의 FR-1.10).
 *
 * 한 층 안에서는 **몫이 남은 난이도부터** 고르고, 그 층에서 몫을 다 채우지 못하면(그 난이도의
 * 문제가 이 층에 모자라면) 같은 층의 나머지를 층의 순서대로 채운 뒤에야 다음 층으로 간다.
 * 그래서 난이도를 맞추려고 안 본 문제를 두고 본 문제를 내는 일이 없다 — 난이도는 «안 본 것부터»
 * 안에서만 맞춘다. 다음 층에서는 아직 모자란 난이도부터 다시 채운다.
 */
function pickByQuota(
  tiers: readonly (readonly Question[])[],
  take: number,
  quotas: ReadonlyMap<DifficultyBucket, number>,
): Question[] {
  const room = new Map(quotas);
  const picked: Question[] = [];
  for (const tier of tiers) {
    const passed: Question[] = [];
    for (const question of tier) {
      if (picked.length >= take) return picked;
      const bucket = difficultyBucket(question);
      const left = room.get(bucket) ?? 0;
      if (left > 0) {
        picked.push(question);
        room.set(bucket, left - 1);
      } else {
        passed.push(question);
      }
    }
    // 몫을 채운 난이도의 남은 문제다. 이 층에서 자리가 남았으면 다른 난이도가 모자랐다는 뜻이다
    for (const question of passed) {
      if (picked.length >= take) return picked;
      picked.push(question);
    }
  }
  return picked;
}

/**
 * 문제 은행에서 출제할 문제를 뽑는다.
 * 직전 판에 나온 문제는 뒤로 밀어 중복 체감을 줄이고 (FR-1.4), 한 판의 난이도는 은행의 난이도
 * 비율을 따른다 (FR-1.10). 은행이 출제 수보다 적으면 있는 만큼만 낸다.
 * 고른 문제의 순서는 마지막에 섞는다 — 고르는 순서(난이도·본 순서)대로 몰려 나오지 않게 한다.
 *
 * count는 출제할 문항 수, recentIds는 직전 판에 출제된 문제 ID다.
 */
export function sampleQuestions(
  bank: Question[],
  count: number,
  recentIds: string[] = [],
  random: () => number = Math.random
): Question[] {
  // recentIds는 최신순이다. 인덱스가 클수록 오래전에 본 문제다
  const seenAt = new Map(recentIds.map((id, index) => [id, index]));

  const fresh = bank.filter((question) => !seenAt.has(question.id));

  // 본 문제끼리는 섞지 않고 «오래전에 본 것»부터 앞에 둔다.
  // 은행이 출제 수보다 작으면 fresh만으로 채울 수 없는데, 그때 무작위로 섞으면
  // 방금 본 문제가 바로 다음 판에 되돌아온다. filter가 새 배열을 주므로
  // sort가 bank를 건드리지는 않는다.
  const stale = bank
    .filter((question) => seenAt.has(question.id))
    // 바로 위 filter가 has로 걸러 두어 get은 반드시 값을 준다
    .sort((a, b) => seenAt.get(b.id)! - seenAt.get(a.id)!);

  const take = Math.min(count, bank.length);
  // 신규 문제가 한 층(무작위 순서)이고, 본 문제는 한 문제씩이 한 층이다 — recentIds 는 문제마다
  // 순서가 달라 본 문제 사이에서는 난이도보다 «오래전에 본 것부터»가 먼저다
  const tiers = [shuffle(fresh, random), ...stale.map((question) => [question])];
  const picked = pickByQuota(tiers, take, difficultyQuotas(bank, take, random));
  return shuffle(picked, random);
}

/**
 * 보기 순서를 섞고 정답 인덱스를 새 위치로 옮긴다 (FR-1.7).
 * 원본 문제 객체는 건드리지 않는다.
 *
 * 돌려주는 것은 보기 순서가 섞인 새 문제 객체다.
 */
export function shuffleChoices(question: Question, random: () => number = Math.random): Question {
  const entries = question.choices.map((text, index) => ({ text, index }));
  const shuffled = shuffle(entries, random);

  return {
    ...question,
    choices: shuffled.map((entry) => entry.text),
    answerIndex: shuffled.findIndex((entry) => entry.index === question.answerIndex),
  };
}

export interface RoundParams {
  bank: Question[];
  count: number;
  recentIds?: string[];
  random?: () => number;
}

/**
 * 한 판에 낼 문제 목록을 완성한다. 문제 순서와 보기 순서가 모두 섞인다.
 */
export function buildRound({ bank, count, recentIds = [], random = Math.random }: RoundParams): Question[] {
  return sampleQuestions(bank, count, recentIds, random).map((question) =>
    shuffleChoices(question, random)
  );
}

export interface AllRoundParams {
  /** 카테고리별 문제 배열의 배열이다 */
  banks: Question[][];
  countPerCategory: number;
  recentIds?: string[];
  random?: () => number;
}

/**
 * 전체 모드 한 판 (FR-2.2).
 *
 * 카테고리마다 같은 수만큼 뽑은 뒤 전체 순서를 다시 섞는다.
 * 전체 은행을 한 통에 넣고 무작위로 뽑으면 판마다 카테고리별 문항 수가
 * 달라져 결과 화면의 카테고리별 정답 개수를 서로 비교할 수 없다 (FR-5.6).
 * 난이도 몫(FR-1.10)도 카테고리마다 그 은행의 비율로 나눈다 — 분야별 문항 수가 먼저다.
 */
export function buildAllRound({
  banks,
  countPerCategory,
  recentIds = [],
  random = Math.random,
}: AllRoundParams): Question[] {
  const picked = banks.flatMap((bank) =>
    sampleQuestions(bank, countPerCategory, recentIds, random)
  );

  return shuffle(picked, random).map((question) => shuffleChoices(question, random));
}
