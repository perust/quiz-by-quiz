import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 한 판의 난이도 비율 (FR-1.10, N05).
// 출제가 난이도를 보지 않아 10문제 판에 어려운 문제가 넷 이상 나오는 일이 네 판에 한 번꼴이었다.
// 이제 한 판은 은행의 난이도 비율을 최대 나머지 방식으로 나눈 몫을 따르되, 그 몫은 «안 본 문제부터,
// 다음은 오래전에 본 것부터»(FR-1.4) 안에서만 맞춘다. 서버(`server/app/question_catalog.py`)도 같은 규칙이고
// `server/tests/test_question_catalog.py`가 같은 경우를 본다. 난수는 씨앗을 고정해 결과를 되풀이한다.

const { allRoundQuotas, buildAllRound, buildRound, difficultyBucket, difficultyQuotas, sampleQuestions } = await import('../js/core/sampler.js');
const { CATEGORIES, QUESTIONS_PER_CATEGORY_IN_ALL, QUESTIONS_PER_ROUND } = await import('../js/constants.js');

/** 씨앗이 같으면 같은 수열을 주는 작은 난수 생성기 (mulberry32) */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function question(id, difficulty, category = 'science') {
  return {
    id, category, question: `${id}?`, choices: ['가', '나', '다', '라'],
    answerIndex: 0, explanation: '', difficulty, tags: [],
  };
}

/** easy·normal·hard 를 그만큼씩. 번호는 «e3»처럼 난이도 첫 글자 + 차례다 */
function bank({ easy = 0, normal = 0, hard = 0 }, category = 'science') {
  const make = (level, count) => Array.from({ length: count }, (_, index) => question(`${category}-${level[0]}${index}`, level, category));
  return [...make('easy', easy), ...make('normal', normal), ...make('hard', hard)];
}

function tally(questions) {
  const counts = { easy: 0, normal: 0, hard: 0, unknown: 0 };
  for (const item of questions) counts[difficultyBucket(item)] += 1;
  return counts;
}

const ids = (questions) => questions.map((item) => item.id);

test('몫: 은행 비율 × 문항 수의 최대 나머지 — 내림한 몫 뒤에 나머지가 큰 칸부터 하나씩', () => {
  // 40/42/28 (한국사·과학): 3.64 · 3.82 · 2.55 → 3·3·2 + 보통·쉬움 → 4·4·2
  for (let seed = 0; seed < 20; seed += 1) {
    assert.deepEqual(
      Object.fromEntries(difficultyQuotas(bank({ easy: 40, normal: 42, hard: 28 }), 10, seeded(seed))),
      { easy: 4, normal: 4, hard: 2 },
    );
  }
  // 몫의 합은 언제나 낼 문항 수이고, 은행 크기를 넘는 몫은 없다
  for (const sizes of [{ easy: 1, normal: 1, hard: 1 }, { easy: 7, normal: 0, hard: 3 }, { easy: 2, normal: 9, hard: 0 }, { easy: 5, normal: 5, hard: 5 }]) {
    const pool = bank(sizes);
    for (let take = 0; take <= pool.length; take += 1) {
      const quotas = difficultyQuotas(pool, take, seeded(take));
      assert.equal([...quotas.values()].reduce((sum, value) => sum + value, 0), take, `${JSON.stringify(sizes)} · ${take}`);
      for (const [level, value] of quotas) assert.ok(value <= sizes[level], `${level} 몫 ${value} ≤ ${sizes[level]}`);
    }
  }
  assert.equal(difficultyQuotas([], 10).size, 0, '빈 은행은 몫이 없다');
});

test('몫: 나머지가 같은 칸은 무작위로 고른다 — 정수로 셈해 부동소수 오차로 갈리지 않는다', () => {
  // 40/41/29 (지리·일반상식·예술): 나머지가 쉬움 70 · 보통 80 · 어려움 70 (÷110). 보통은 늘 넷이고
  // 남은 한 자리를 쉬움과 어려움이 판마다 나눠 갖는다. 소수로 셈하면 3.6363…·2.6363…이 갈려 늘 한쪽이 이겼다
  const seen = new Set();
  for (let seed = 0; seed < 60; seed += 1) {
    const quotas = Object.fromEntries(difficultyQuotas(bank({ easy: 40, normal: 41, hard: 29 }), 10, seeded(seed)));
    assert.equal(quotas.normal, 4);
    assert.equal(quotas.easy + quotas.hard, 6);
    seen.add(`${quotas.easy}/${quotas.hard}`);
  }
  assert.deepEqual([...seen].sort(), ['3/3', '4/2'], '두 갈래가 모두 나온다');
});

test('N05: 실제 은행의 10문제 판에 어려운 문제가 넷 이상 나오지 않는다', async () => {
  for (const { id } of CATEGORIES) {
    const pool = JSON.parse(await readFile(new URL(`../data/${id}.json`, import.meta.url), 'utf8'));
    const share = tally(pool);
    for (let seed = 0; seed < 200; seed += 1) {
      const round = buildRound({ bank: pool, count: QUESTIONS_PER_ROUND, random: seeded(seed) });
      assert.equal(round.length, QUESTIONS_PER_ROUND);
      const counts = tally(round);
      for (const level of ['easy', 'normal', 'hard']) {
        const ideal = (QUESTIONS_PER_ROUND * share[level]) / pool.length;
        assert.ok(Math.abs(counts[level] - ideal) < 1, `${id} ${level}: ${counts[level]}개 (비율로는 ${ideal.toFixed(2)})`);
      }
      assert.ok(counts.hard <= 3, `${id}: 어려운 문제 ${counts.hard}개`);
    }
  }
});

test('안 본 문제가 먼저다 — 난이도를 맞추려고 본 문제를 꺼내지 않는다 (FR-1.4)', () => {
  // 안 본 열 문제가 모두 보통이다. 몫은 쉬움 넷·보통 넷·어려움 둘이지만 본 문제는 하나도 나오지 않는다
  const fresh = bank({ normal: 10 }, 'history');
  const old = bank({ easy: 10, hard: 10 });
  const recent = ids(old);
  for (let seed = 0; seed < 20; seed += 1) {
    const round = sampleQuestions([...old, ...fresh], 10, recent, seeded(seed));
    assert.deepEqual(ids(round).sort(), ids(fresh).sort());
  }
});

test('한 난이도의 안 본 문제가 모자라면 다른 난이도의 안 본 문제로 채운다', () => {
  // 어려운 몫은 둘인데 안 본 어려운 문제는 하나뿐이다. 본 어려운 문제(오래된 것)를 꺼내지 않고 안 본 쉬움·보통이 채운다
  const pool = bank({ easy: 8, normal: 8, hard: 4 });
  const seenHard = ['science-h0', 'science-h1', 'science-h2'];
  for (let seed = 0; seed < 30; seed += 1) {
    const round = sampleQuestions(pool, 10, seenHard, seeded(seed));
    const counts = tally(round);
    assert.equal(round.length, 10);
    assert.deepEqual(ids(round).filter((id) => seenHard.includes(id)), [], '본 문제는 나오지 않는다');
    assert.equal(counts.hard, 1, '안 본 어려운 문제 하나');
    assert.equal(counts.easy + counts.normal, 9);
    assert.ok(counts.easy >= 4 && counts.normal >= 4, `채운 자리도 몫을 넘는 칸에서 왔다: ${JSON.stringify(counts)}`);
  }
});

test('안 본 문제가 다 떨어지면 본 문제는 난이도와 상관없이 오래전에 본 것부터다', () => {
  // 열두 문제를 모두 봤다. recentIds 는 최신순이라 맨 앞 둘이 가장 최근에 본 문제다
  const pool = bank({ easy: 4, normal: 4, hard: 4 });
  const recent = ['science-h3', 'science-h2', ...ids(pool).filter((id) => !['science-h3', 'science-h2'].includes(id))];
  for (let seed = 0; seed < 20; seed += 1) {
    const round = sampleQuestions(pool, 10, recent, seeded(seed));
    assert.deepEqual(ids(round).sort(), recent.slice(2).sort(), '가장 최근에 본 둘(어려움 둘)만 빠진다');
  }

  // 안 본 셋을 다 내고, 모자란 일곱은 오래전에 본 것부터 — 그 사이에 난이도는 따지지 않는다
  const fresh = ['science-e0', 'science-n0', 'science-h0'];
  const order = ids(pool).filter((id) => !fresh.includes(id));
  const round = sampleQuestions(pool, 10, order, seeded(3));
  assert.deepEqual(ids(round).sort(), [...fresh, ...order.slice(-7)].sort());
});

test('은행이 출제 수보다 적어도 지금처럼 있는 만큼 다 낸다', () => {
  const pool = bank({ easy: 3, normal: 2, hard: 1 });
  for (let seed = 0; seed < 10; seed += 1) {
    assert.deepEqual(ids(sampleQuestions(pool, 10, [], seeded(seed))).sort(), ids(pool).sort());
    assert.deepEqual(ids(sampleQuestions(pool, 10, ids(pool), seeded(seed))).sort(), ids(pool).sort(), '모두 본 문제여도');
  }
  assert.deepEqual(sampleQuestions([], 10), []);
});

test('난이도가 없거나 셋 밖이면 «모름» 한 칸이다 — 은행 전체가 그러면 난이도를 보지 않던 출제와 같다', () => {
  const unknown = [
    ...Array.from({ length: 6 }, (_, index) => question(`u${index}`, undefined)),
    ...Array.from({ length: 6 }, (_, index) => question(`x${index}`, 'expert')),
    ...Array.from({ length: 4 }, (_, index) => question(`n${index}`, null)),
  ];
  assert.deepEqual([...difficultyQuotas(unknown, 10)], [['unknown', 10]]);
  for (let seed = 0; seed < 10; seed += 1) {
    const round = sampleQuestions(unknown, 10, ['u0', 'x0'], seeded(seed));
    assert.equal(round.length, 10);
    assert.deepEqual(ids(round).filter((id) => ['u0', 'x0'].includes(id)), [], '안 본 문제가 열넷이라 본 둘은 나오지 않는다');
  }

  // 일부만 모르면 그 칸도 제 비율의 몫을 받는다
  const mixed = [...bank({ easy: 10 }), ...unknown.slice(0, 10)];
  for (let seed = 0; seed < 10; seed += 1) {
    assert.deepEqual(tally(sampleQuestions(mixed, 10, [], seeded(seed))), { easy: 5, normal: 0, hard: 0, unknown: 5 });
  }
});

test('고른 문제는 섞어서 낸다 — 난이도끼리 몰려 나오지 않는다', () => {
  const pool = bank({ easy: 40, normal: 42, hard: 28 });
  const firstPlaces = new Set();
  const lastPlaces = new Set();
  for (let seed = 0; seed < 40; seed += 1) {
    const round = sampleQuestions(pool, 10, [], seeded(seed));
    firstPlaces.add(difficultyBucket(round[0]));
    lastPlaces.add(difficultyBucket(round.at(-1)));
  }
  assert.deepEqual([...firstPlaces].sort(), ['easy', 'hard', 'normal'], '첫 문제가 늘 같은 난이도가 아니다');
  assert.deepEqual([...lastPlaces].sort(), ['easy', 'hard', 'normal'], '마지막 문제도');
});

// ── 전체 도전: 분야마다 다섯 문제를 지키고 판 전체가 은행의 비율을 따른다 ─────────────
// 분야마다 따로 최대 나머지로 나누던 때는 지금 은행에서 다섯 분야 모두 어려움이 늘 하나로 내림돼(5 × 29/110 = 1.32,
// 나머지가 가장 작다) 25문제 판에 어려움이 늘 다섯(20%)이었다 — 은행은 26%이고 예전 무작위 출제는 평균 6.5였다.

/** 분야마다 문항 수를 지키고, 칸마다 제 은행의 정확한 몫(take × 칸 ÷ 은행)의 내림이나 올림인지 본다 */
function assertEachCategoryWithinItsShare(round, banks, count) {
  for (const pool of banks) {
    const category = pool[0].category;
    const take = Math.min(count, pool.length);
    const mine = tally(round.filter((item) => item.category === category));
    const sizes = tally(pool);
    assert.equal(Object.values(mine).reduce((sum, value) => sum + value, 0), take, `${category}: ${take}문제`);
    for (const level of ['easy', 'normal', 'hard', 'unknown']) {
      const share = (take * sizes[level]) / pool.length;
      assert.ok(mine[level] === Math.floor(share) || mine[level] === Math.ceil(share), `${category} ${level}: ${mine[level]}개 (몫 ${share.toFixed(2)})`);
    }
  }
}

test('전체 도전: 분야마다 다섯 문제이고, 판 전체의 난이도가 은행의 비율을 따른다', () => {
  // 40/41/29 다섯 은행: 25 × 200/205/145 ÷ 550 = 9.09 · 9.32 · 6.59 → 9·9·6 + 어려움 → 9·9·7
  const banks = CATEGORIES.map(({ id }) => bank({ easy: 40, normal: 41, hard: 29 }, id));
  const hardInCategory = new Map(CATEGORIES.map(({ id }) => [id, new Set()]));
  for (let seed = 0; seed < 40; seed += 1) {
    const round = buildAllRound({ banks, countPerCategory: QUESTIONS_PER_CATEGORY_IN_ALL, random: seeded(seed) });
    assert.equal(round.length, QUESTIONS_PER_CATEGORY_IN_ALL * CATEGORIES.length);
    assert.deepEqual(tally(round), { easy: 9, normal: 9, hard: 7, unknown: 0 }, '어려움 일곱 — 분야마다 나누면 늘 다섯이었다');
    assertEachCategoryWithinItsShare(round, banks, QUESTIONS_PER_CATEGORY_IN_ALL);
    for (const { id } of CATEGORIES) hardInCategory.get(id).add(tally(round.filter((item) => item.category === id)).hard);
    assert.equal(new Set(ids(round)).size, round.length, '같은 문제가 두 번 나오지 않는다');
  }
  for (const [id, seen] of hardInCategory) {
    assert.deepEqual([...seen].sort(), [1, 2], `${id}: 어려움 둘을 받는 분야가 판마다 바뀐다`);
  }

  // 분야마다 기억을 그대로 따른다 — 본 문제가 섞여 있어도 안 본 것부터
  const recent = ids(banks[0]).slice(0, 100);
  const round = buildAllRound({ banks, countPerCategory: QUESTIONS_PER_CATEGORY_IN_ALL, recentIds: recent, random: seeded(7) });
  const first = round.filter((item) => item.category === CATEGORIES[0].id);
  assert.equal(first.length, QUESTIONS_PER_CATEGORY_IN_ALL);
  assert.deepEqual(ids(first).filter((id) => recent.includes(id)), [], '그 분야의 안 본 열 문제 가운데서 낸다');
});

test('N05: 실제 은행의 전체 도전 25문제에 어려운 문제가 6~7개다 (은행 26%)', async () => {
  const banks = await Promise.all(CATEGORIES.map(async ({ id }) => JSON.parse(await readFile(new URL(`../data/${id}.json`, import.meta.url), 'utf8'))));
  const all = banks.flat();
  const share = tally(all);
  const count = QUESTIONS_PER_CATEGORY_IN_ALL * CATEGORIES.length;
  for (let seed = 0; seed < 200; seed += 1) {
    const round = buildAllRound({ banks, countPerCategory: QUESTIONS_PER_CATEGORY_IN_ALL, random: seeded(seed) });
    assert.equal(round.length, count);
    const counts = tally(round);
    assert.ok(counts.hard >= 6 && counts.hard <= 7, `어려움 ${counts.hard}개`);
    for (const level of ['easy', 'normal', 'hard']) {
      const ideal = (count * share[level]) / all.length;
      assert.ok(Math.abs(counts[level] - ideal) < 1, `${level}: ${counts[level]}개 (비율로는 ${ideal.toFixed(2)})`);
    }
    assertEachCategoryWithinItsShare(round, banks, QUESTIONS_PER_CATEGORY_IN_ALL);
  }
});

test('전체 도전의 판 몫은 분야마다의 몫을 더한 것이다 — 은행 크기가 달라도 분야마다 다섯 문제가 먼저다', () => {
  // 합친 은행의 비율(어려움 10/110)로 나누면 어려움은 하나뿐이어야 하지만, 한국사 다섯은 모두 어려움이다.
  // 분야마다의 정확한 몫(한국사 어려움 5, 과학 쉬움 5)의 합이 판의 목표다
  const banks = [bank({ hard: 10 }, 'history'), bank({ easy: 100 }, 'science')];
  for (let seed = 0; seed < 10; seed += 1) {
    const round = buildAllRound({ banks, countPerCategory: 5, random: seeded(seed) });
    assert.deepEqual(tally(round), { easy: 5, normal: 0, hard: 5, unknown: 0 });
    assertEachCategoryWithinItsShare(round, banks, 5);
  }

  // 분야 은행이 다섯 문제보다 작으면 지금처럼 있는 만큼이다
  const small = [bank({ easy: 2, hard: 1 }, 'history'), bank({ easy: 4, normal: 4, hard: 2 }, 'science')];
  for (let seed = 0; seed < 10; seed += 1) {
    const round = buildAllRound({ banks: small, countPerCategory: 5, random: seeded(seed) });
    assert.equal(round.length, 8);
    assertEachCategoryWithinItsShare(round, small, 5);
  }
});

test('판 몫이 앞서 고른 올림에 막히면 올림을 다른 분야로 옮겨 맞춘다 (증가 경로)', () => {
  // 분야마다 한 문제. 한국사는 쉬움 3·보통 2, 과학은 쉬움 3·어려움 2 → 판의 목표는 쉬움 1.2 · 보통 0.4 · 어려움 0.4,
  // 몫은 쉬움 하나에 보통이나 어려움 하나(나머지가 같아 무작위)다. 나머지가 가장 큰 쉬움(0.6)부터 고르면 두 분야가
  // 다 쉬움을 원하고, 먼저 고른 분야가 쉬움을 가져가면 남은 분야의 다른 칸이 판의 몫과 어긋날 수 있다
  const banks = [bank({ easy: 3, normal: 2 }, 'history'), bank({ easy: 3, hard: 2 }, 'science')];
  const outcomes = new Set();
  for (let seed = 0; seed < 60; seed += 1) {
    const quotas = allRoundQuotas(banks, 1, seeded(seed));
    const total = { easy: 0, normal: 0, hard: 0 };
    for (const map of quotas) for (const [level, value] of map) total[level] += value;
    assert.equal(total.easy, 1, `쉬움은 언제나 하나다: ${JSON.stringify(total)}`);
    assert.equal(total.normal + total.hard, 1);
    assert.deepEqual(quotas.map((map) => [...map.values()].reduce((sum, value) => sum + value, 0)), [1, 1], '분야마다 한 문제');
    outcomes.add(total.normal === 1 ? 'normal' : 'hard');
  }
  assert.deepEqual([...outcomes].sort(), ['hard', 'normal'], '나머지가 같은 보통·어려움이 판마다 갈린다');
});

test('allRoundQuotas: 분야마다 문항 수와 칸마다 내림·올림을 지키고, 맞출 수 있으면 언제나 판의 몫을 맞춘다', () => {
  const levels = ['easy', 'normal', 'hard', 'unknown'];
  const combos = (items, size) => (size === 0 ? [[]] : items.flatMap((item, index) => combos(items.slice(index + 1), size - 1).map((rest) => [item, ...rest])));
  for (let seed = 0; seed < 400; seed += 1) {
    const random = seeded(seed);
    const banks = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, row) => {
      const sizes = Object.fromEntries(levels.map((level) => [level, random() < 0.3 ? 0 : Math.floor(random() * 9)]));
      return [
        ...bank({ easy: sizes.easy, normal: sizes.normal, hard: sizes.hard }, `c${row}`),
        ...Array.from({ length: sizes.unknown }, (_, index) => question(`c${row}-u${index}`, undefined, `c${row}`)),
      ];
    });
    const count = 1 + Math.floor(random() * 6);
    const quotas = allRoundQuotas(banks, count, random);

    // 분야마다: 칸마다 정확한 몫의 내림이나 올림, 합은 문항 수
    const rows = banks.map((pool, row) => {
      const take = Math.min(count, pool.length);
      const sizes = tally(pool);
      const cells = levels.filter((level) => sizes[level] > 0).map((level) => ({
        level, floor: Math.floor((take * sizes[level]) / pool.length), raisable: (take * sizes[level]) % pool.length > 0,
        numerator: take * sizes[level], size: pool.length,
      }));
      let sum = 0;
      for (const level of levels) {
        const value = quotas[row].get(level) ?? 0;
        const cell = cells.find((item) => item.level === level);
        sum += value;
        assert.ok(cell ? value === cell.floor || (cell.raisable && value === cell.floor + 1) : value === 0, `seed ${seed} 분야 ${row} ${level}: ${value}`);
      }
      assert.equal(sum, take, `seed ${seed} 분야 ${row}`);
      return { take, cells };
    });

    // 판의 목표(정확한 몫의 합)를 공통분모 정수로 셈하고, 나머지가 같은 난이도까지 고려한 최대 나머지 후보를 모두 만든다
    const denominator = banks.reduce((lcm, pool) => {
      if (pool.length === 0) return lcm;
      const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
      return (lcm / gcd(lcm, BigInt(pool.length))) * BigInt(pool.length);
    }, 1n);
    const target = new Map();
    for (const { cells } of rows) {
      for (const cell of cells) target.set(cell.level, (target.get(cell.level) ?? 0n) + BigInt(cell.numerator) * (denominator / BigInt(cell.size)));
    }
    const present = levels.filter((level) => target.has(level));
    const base = Object.fromEntries(present.map((level) => [level, Number(target.get(level) / denominator)]));
    const extra = rows.reduce((sum, { take }) => sum + take, 0) - present.reduce((sum, level) => sum + base[level], 0);
    const parts = present.map((level) => ({ level, part: target.get(level) % denominator })).sort((a, b) => (a.part === b.part ? 0 : a.part > b.part ? -1 : 1));
    const options = [];
    if (extra === 0) options.push(base);
    else {
      const cutoff = parts[extra - 1].part;
      const sure = parts.filter(({ part }) => part > cutoff).map(({ level }) => level);
      const tied = parts.filter(({ part }) => part === cutoff).map(({ level }) => level);
      for (const chosen of combos(tied, extra - sure.length)) {
        options.push(Object.fromEntries(present.map((level) => [level, base[level] + ([...sure, ...chosen].includes(level) ? 1 : 0)])));
      }
    }

    // 분야마다 내림·올림을 고르는 모든 경우를 훑어, 판의 몫 후보가 모두 이룰 수 있는 것이면 결과가 그 가운데 하나다
    const key = (totals) => present.map((level) => totals[level] ?? 0).join('/');
    const reachable = new Set();
    const walk = (row, totals) => {
      if (row === rows.length) { reachable.add(key(totals)); return; }
      const { take, cells } = rows[row];
      const need = take - cells.reduce((sum, cell) => sum + cell.floor, 0);
      for (const chosen of combos(cells.filter((cell) => cell.raisable), need)) {
        const next = { ...totals };
        for (const cell of cells) next[cell.level] = (next[cell.level] ?? 0) + cell.floor + (chosen.includes(cell) ? 1 : 0);
        walk(row + 1, next);
      }
    };
    walk(0, {});
    if (options.every((option) => reachable.has(key(option)))) {
      const got = Object.fromEntries(present.map((level) => [level, quotas.reduce((sum, map) => sum + (map.get(level) ?? 0), 0)]));
      assert.ok(options.some((option) => key(option) === key(got)), `seed ${seed}: ${key(got)} — 후보 ${options.map(key).join(' | ')}`);
    }
  }
});

test('전체 도전도 난이도를 모르면 «모름» 한 칸이다 — 분야마다 다섯 문제, 예전 출제와 같다', () => {
  const banks = CATEGORIES.map(({ id }) => Array.from({ length: 12 }, (_, index) => question(`${id}-u${index}`, undefined, id)));
  for (let seed = 0; seed < 10; seed += 1) {
    const round = buildAllRound({ banks, countPerCategory: QUESTIONS_PER_CATEGORY_IN_ALL, random: seeded(seed) });
    assert.deepEqual(tally(round), { easy: 0, normal: 0, hard: 0, unknown: 25 });
    assertEachCategoryWithinItsShare(round, banks, QUESTIONS_PER_CATEGORY_IN_ALL);
  }
});
