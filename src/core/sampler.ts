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

/** 칸마다의 문제 수. 문제가 없는 칸은 담지 않는다 */
function bucketSizes(bank: readonly Question[]): Map<DifficultyBucket, number> {
  const sizes = new Map<DifficultyBucket, number>();
  for (const question of bank) {
    const bucket = difficultyBucket(question);
    sizes.set(bucket, (sizes.get(bucket) ?? 0) + 1);
  }
  return sizes;
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
  const sizes = bucketSizes(bank);
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

/** 전체 도전의 몫을 나눌 때 분야 하나·난이도 하나의 칸 가운데 올림할 수 있는 칸(나머지가 0이 아닌 칸) */
interface RoundingCell {
  /** 분야(은행)의 차례 */
  row: number;
  bucket: DifficultyBucket;
  /** 정확한 몫의 나머지. 분수로는 `remainder / size` 다 */
  remainder: number;
  /** 그 분야 은행의 크기 */
  size: number;
  tie: number;
}

/** 두 정수의 최대공약수 */
function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/**
 * 전체 도전 한 판의 난이도 몫 (FR-1.10). 분야마다 `countPerCategory`(은행이 작으면 있는 만큼) 문항 수는
 * 그대로 두고 **판 전체**가 은행의 비율을 따르게 나눠, 분야마다의 몫을 돌려준다(`banks` 와 같은 순서).
 *
 * 분야마다 따로 최대 나머지로 나누면 지금 은행에서는 다섯 분야 모두 어려움의 나머지가 가장 작아
 * (5 × 29/110 = 1.32) 어려움이 늘 하나로 내림됐다 — 25문제 판에 어려움이 늘 다섯(20%)인데 은행은 26%다.
 * 전체 도전 랭킹은 한 키에 쌓이므로 그만큼 쉬워진 판의 점수가 예전 기록과 나란히 놓였다.
 *
 * 1. 분야 c·난이도 d의 정확한 몫은 `c의 문항 수 × (c의 d 문제 수) ÷ (c의 문제 수)`다. 판의 목표는 난이도마다
 *    그 합이고(분야마다 무작위로 뽑던 예전 출제의 기댓값), 그것을 최대 나머지 방식으로 정수로 나눈 것이 판의 몫이다.
 *    은행 크기가 모두 같으면 «25 × 다섯 은행을 합친 비율»과 같다. 합은 공통분모의 정수(BigInt)로만 셈한다
 * 2. 칸마다 정확한 몫을 내림해 먼저 주고, 분야마다 남은 자리는 판의 몫이 아직 모자란 난이도의 칸을 하나씩 올림해
 *    채운다 — 나머지가 큰 칸부터(같으면 무작위). 앞서 고른 올림 때문에 막히면 그 올림을 다른 분야로 옮겨 길을 낸다
 *    (증가 경로). 그래서 판의 몫을 맞출 수 있는 은행이면 언제나 맞춘다
 * 3. 맞출 길이 없는 은행 모양이면 남은 자리는 그 분야 안에서 나머지가 큰 칸부터 올림한다(분야마다 나누던 것과 같다)
 *
 * 어느 칸도 정확한 몫의 내림·올림 밖으로 나가지 않는다 — 분야마다 문항 수는 그대로이고, 분야 안의 구성도 칸마다
 * 제 은행의 비율에서 하나 넘게 벗어나지 않으며, 칸의 문제 수를 넘지 않는다.
 */
export function allRoundQuotas(
  banks: readonly (readonly Question[])[],
  countPerCategory: number,
  random: () => number = Math.random,
): Map<DifficultyBucket, number>[] {
  const quotas = banks.map(() => new Map<DifficultyBucket, number>());
  /** 분야마다 아직 올림해야 할 칸 수 */
  const need: number[] = [];
  const cells: RoundingCell[] = [];
  const sizes = banks.map(bucketSizes);
  /** 난이도마다 내림한 몫의 합 */
  const floorSums = new Map<DifficultyBucket, number>();
  // 나머지는 분모(은행 크기)가 분야마다 달라, 모든 은행 크기의 최소공배수 위의 정수로 더한다
  let denominator = 1n;
  for (const bank of banks) {
    if (bank.length > 0) denominator = (denominator / gcd(denominator, BigInt(bank.length))) * BigInt(bank.length);
  }
  /** 난이도마다 나머지(분수)의 합 × denominator */
  const remainderSums = new Map<DifficultyBucket, bigint>();

  let total = 0;
  banks.forEach((bank, row) => {
    const take = Math.min(countPerCategory, bank.length);
    total += take;
    let given = 0;
    for (const bucket of BUCKET_ORDER) {
      const count = sizes[row].get(bucket);
      if (count === undefined) continue;
      const share = take * count;
      const floor = Math.floor(share / bank.length);
      const remainder = share % bank.length;
      quotas[row].set(bucket, floor);
      given += floor;
      floorSums.set(bucket, (floorSums.get(bucket) ?? 0) + floor);
      remainderSums.set(
        bucket,
        (remainderSums.get(bucket) ?? 0n) + BigInt(remainder) * (denominator / BigInt(bank.length)),
      );
      if (remainder > 0) cells.push({ row, bucket, remainder, size: bank.length, tie: random() });
    }
    need.push(take - given);
  });

  // 1. 판의 몫: 난이도마다 «내림의 합 + 나머지 합의 정수 부분», 남은 자리는 나머지 합의 소수 부분이 큰 난이도부터
  const want = new Map<DifficultyBucket, number>();
  const ranks: { bucket: DifficultyBucket; part: bigint; tie: number }[] = [];
  let given = 0;
  for (const bucket of BUCKET_ORDER) {
    const sum = remainderSums.get(bucket);
    if (sum === undefined) continue;
    const whole = Number(sum / denominator);
    // want 는 «내림 위에 더 올림할 칸 수»다
    want.set(bucket, whole);
    given += (floorSums.get(bucket) ?? 0) + whole;
    ranks.push({ bucket, part: sum % denominator, tie: random() });
  }
  ranks.sort((a, b) => (a.part === b.part ? a.tie - b.tie : a.part > b.part ? -1 : 1));
  for (const { bucket } of ranks.slice(0, Math.max(0, total - given))) {
    // ranks 의 난이도는 모두 바로 위 반복에서 want 를 적은 난이도다
    want.set(bucket, want.get(bucket)! + 1);
  }

  // 2. 올림할 칸을 고른다. 나머지(remainder / size)가 큰 칸부터 — 분모가 달라 엇갈려 곱해 견준다
  cells.sort((a, b) => b.remainder * a.size - a.remainder * b.size || a.tie - b.tie);
  const raised = new Set<RoundingCell>();
  const raise = (cell: RoundingCell): void => {
    raised.add(cell);
    need[cell.row] -= 1;
    want.set(cell.bucket, (want.get(cell.bucket) ?? 0) - 1);
  };
  for (const cell of cells) {
    if (need[cell.row] > 0 && (want.get(cell.bucket) ?? 0) > 0) raise(cell);
  }

  /**
   * 분야 `start` 에서 판의 몫이 모자란 난이도까지 가는 증가 경로를 찾아 올림을 옮긴다. 경로는 «올림하지 않은 칸으로
   * 난이도에 닿고, 그 난이도를 올림한 다른 분야로 건너가 그 올림을 내리는» 것의 되풀이다 — 지나간 분야와 난이도의
   * 올림 수는 그대로이고 `start` 와 끝 난이도만 하나씩 채워진다.
   */
  function augment(start: number): boolean {
    const reachedBucket = new Map<DifficultyBucket, RoundingCell>();
    const reachedRow = new Map<number, RoundingCell>();
    const queue = [start];
    const seenRows = new Set([start]);
    while (queue.length > 0) {
      // 바로 위 조건이 빈 줄이 아님을 보장한다
      const row = queue.shift()!;
      for (const cell of cells) {
        if (cell.row !== row || raised.has(cell) || reachedBucket.has(cell.bucket)) continue;
        reachedBucket.set(cell.bucket, cell);
        if ((want.get(cell.bucket) ?? 0) > 0) {
          // 끝에서부터 거꾸로: 닿은 칸은 올림하고, 건너온 분야의 올림은 내린다
          let step = cell;
          for (;;) {
            raised.add(step);
            if (step.row === start) break;
            // start 가 아닌 분야는 모두 reachedRow 의 올림을 내리며 닿았고(queue 에 넣을 때 적는다),
            // 그 칸의 난이도에는 reachedBucket 의 칸으로 닿았다(그 난이도에서 건너왔다)
            const lowered = reachedRow.get(step.row)!;
            raised.delete(lowered);
            step = reachedBucket.get(lowered.bucket)!;
          }
          need[start] -= 1;
          // 바로 위 조건에서 이 난이도의 want 를 읽었다
          want.set(cell.bucket, want.get(cell.bucket)! - 1);
          return true;
        }
        for (const other of raised) {
          if (other.bucket !== cell.bucket || seenRows.has(other.row)) continue;
          seenRows.add(other.row);
          reachedRow.set(other.row, other);
          queue.push(other.row);
        }
      }
    }
    return false;
  }

  // 한 분야에서 길이 막혀도 다른 분야의 경로가 올림을 옮긴 뒤에는 열릴 수 있어, 한 바퀴 내내 옮긴 것이 없을 때까지 돈다
  let progressed: boolean;
  do {
    progressed = false;
    for (let row = 0; row < banks.length; row += 1) {
      while (need[row] > 0 && augment(row)) progressed = true;
    }
  } while (progressed);

  // 3. 판의 몫을 맞출 길이 없는 분야는 제 안에서 나머지가 큰 칸부터 올림한다. 분야의 남은 자리는 올림할 수 있는
  //    칸 수보다 적다(나머지 분수 하나하나가 1보다 작고 그 합이 남은 자리다)
  for (const cell of cells) {
    if (need[cell.row] > 0 && !raised.has(cell)) raise(cell);
  }

  // 올림할 수 있는 칸은 모두 맨 앞 반복에서 내림한 몫을 적은 칸이다
  for (const cell of raised) quotas[cell.row].set(cell.bucket, quotas[cell.row].get(cell.bucket)! + 1);
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
 * 출제 순서의 층 (FR-1.4). 안 본 문제가 한 층(무작위 순서)이고, 본 문제는 한 문제씩이 한 층이다 —
 * recentIds 는 문제마다 순서가 달라 본 문제 사이에서는 난이도보다 «오래전에 본 것부터»가 먼저다.
 */
function seenOrderTiers(bank: readonly Question[], recentIds: readonly string[], random: () => number): Question[][] {
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

  return [shuffle(fresh, random), ...stale.map((question) => [question])];
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
  const take = Math.min(count, bank.length);
  const tiers = seenOrderTiers(bank, recentIds, random);
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
 * 달라져 결과 화면의 카테고리별 정답 개수를 비교할 수 없다 (FR-5.6).
 * 난이도 몫(FR-1.10)은 판 전체가 은행의 비율을 따르게 분야마다 나눈다(`allRoundQuotas`) — 분야별 문항 수가 먼저다.
 * 분야마다의 몫은 그 분야의 출제 순서(FR-1.4) 안에서 맞춘다.
 */
export function buildAllRound({
  banks,
  countPerCategory,
  recentIds = [],
  random = Math.random,
}: AllRoundParams): Question[] {
  const quotas = allRoundQuotas(banks, countPerCategory, random);
  const picked = banks.flatMap((bank, index) =>
    pickByQuota(seenOrderTiers(bank, recentIds, random), Math.min(countPerCategory, bank.length), quotas[index])
  );

  return shuffle(picked, random).map((question) => shuffleChoices(question, random));
}
