import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 오늘의 퀴즈 (daily). 홈의 주요 게임 진입점 묶음에서 온라인 다음, 전체 도전 앞에 입구 하나를 두고, 날마다 정해진 20문제
// (분야 다섯 × 쉬움 1·보통 1·어려움 2)를 푼다.
// 기록은 이 브라우저에만 남고 개인 기록·온라인 랭킹·서버에는 가지 않는다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test('오늘의 퀴즈 입구는 하나이고 주요 게임 진입점의 둘째 자리(온라인 → 오늘의 퀴즈 → 전체 도전)다', async () => {
  const html = await source('index.html');
  const home = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const actions = between(home, '<div class="home-primary-actions">', 'class="home-quests__caption"');
  const nav = between(home, '<nav class="home-menu"', '</nav>');
  assert.equal((html.match(/id="open-daily"/g) ?? []).length, 1, '오늘의 퀴즈 입구는 하나다 — 옮기지 복제하지 않는다');
  assert.equal((html.match(/id="daily-status"/g) ?? []).length, 1, '상태 한 줄도 하나다');
  // DOM 순서가 곧 낭독·Tab·눈의 순서다 (CSS order 를 쓰지 않는다)
  const children = [...actions.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(children, ['open-online', 'open-daily', 'start-all']);
  assert.match(actions, /<button type="button" class="menu-card home-daily" id="open-daily" aria-label="오늘의 퀴즈" aria-describedby="daily-status" disabled>/);
  assert.match(between(actions, 'id="open-daily"', '</button>'), /id="daily-status"/, '상태 줄은 입구 안에 있다');
  assert.doesNotMatch(nav, /open-daily|daily-status/, '보조 메뉴(«홈 바로가기»)에는 남지 않는다');
});

// ── 순수 로직·저장소·흐름 (컴파일된 js/ 를 읽는다 — `npm run build` 뒤에 돈다) ─────────────────

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function memoryStorage({ failWrites = false } = {}) {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      writes.push(key);
      if (failWrites) throw new Error('QuotaExceededError');
      values.set(key, String(value));
    },
    removeItem: (key) => { values.delete(key); },
  };
}

// safe-storage 는 불러오는 순간 window.localStorage 를 한 번 시험한다
globalThis.window ??= { localStorage: memoryStorage() };

const daily = await import('../js/core/daily.js');
const { createDailyStore, dailyKey } = await import('../js/storage/daily-store.js');
const flowModule = await import('../js/ui/daily.js');
const { createDailyController, dailyStatusText, dailySaveNote } = flowModule;

const CATEGORY_IDS = ['history', 'science', 'geography', 'general', 'art'];
const realBanks = Object.fromEntries(await Promise.all(CATEGORY_IDS.map(async (id) =>
  [id, JSON.parse(await source(`data/${id}.json`))])));

/** KST 의 그 시각 (UTC 로 9시간 앞) */
const kst = (text) => Date.parse(`${text}+09:00`);

const build = (dateKey, banks = realBanks) => daily.buildDailyQuestions({ dateKey, banks });
const shape = (result) => result.questions.map((q) => [q.id, q.choices.join('|'), q.answerIndex]);

// 하루 20문제: 분야 다섯 × (쉬움 1·보통 1·어려움 2).
// 기대값은 제품 규칙에서 따로 적는다 — production 의 상수를 그대로 베끼지 않는다.
const DAILY20 = 20;
const DAILY20_QUOTA = { easy: 1, normal: 1, hard: 2 };
/** 은행 원본에서 읽은 난이도. 출제된 문제의 칸을 은행 쪽 값으로 따로 확인한다 */
const bankDifficulty = new Map(CATEGORY_IDS.flatMap((id) => realBanks[id].map((q) => [q.id, q.difficulty])));
const countBy = (items, key) => items.reduce((map, item) => map.set(key(item), (map.get(key(item)) ?? 0) + 1), new Map());
/** 20개의 답 번호. 함수면 순번으로 만든다 */
const twenty = (pick) => Array.from({ length: DAILY20 }, (_, i) => (typeof pick === 'function' ? pick(i) : pick));

function assertDaily20(questions, label, difficultyOf = (q) => bankDifficulty.get(q.id)) {
  assert.equal(questions.length, 20, `${label}: 정확히 20문제`);
  assert.equal(new Set(questions.map((q) => q.id)).size, 20, `${label}: 문제 ID 20개가 모두 다르다`);
  const byCategory = countBy(questions, (q) => q.category);
  assert.deepEqual([...byCategory.keys()].sort(), [...CATEGORY_IDS].sort(), `${label}: 정확히 다섯 분야`);
  for (const id of CATEGORY_IDS) assert.equal(byCategory.get(id), 4, `${label}: ${id} 는 4문제`);
  const pairs = countBy(questions, (q) => `${q.category}|${difficultyOf(q)}`);
  assert.equal(pairs.size, 15, `${label}: 분야×난이도 짝은 15종`);
  for (const [pair, count] of pairs) assert.equal(count, DAILY20_QUOTA[pair.split('|')[1]], `${label}: ${pair} 몫`);
  const byDifficulty = countBy(questions, difficultyOf);
  assert.deepEqual(Object.fromEntries(byDifficulty), { easy: 5, normal: 5, hard: 10 }, `${label}: 전체 쉬움5·보통5·어려움10`);
}

test('날짜 열쇠는 KST 자정에 바뀌고 달·해·윤일 경계를 넘는다', () => {
  assert.equal(daily.dailyDateKey(kst('2026-11-24T23:59:59.999')), '2026-11-24');
  assert.equal(daily.dailyDateKey(kst('2026-11-25T00:00:00.000')), '2026-11-25');
  // UTC 로는 같은 날 15:00 이 KST 다음 날 0시다
  assert.equal(daily.dailyDateKey(Date.parse('2026-11-24T14:59:59.999Z')), '2026-11-24');
  assert.equal(daily.dailyDateKey(Date.parse('2026-11-24T15:00:00.000Z')), '2026-11-25');
  assert.equal(daily.dailyDateKey(kst('2026-11-30T23:59:59')), '2026-11-30');
  assert.equal(daily.dailyDateKey(kst('2026-12-01T00:00:00')), '2026-12-01');
  assert.equal(daily.dailyDateKey(kst('2026-12-31T23:59:59')), '2026-12-31');
  assert.equal(daily.dailyDateKey(kst('2027-01-01T00:00:00')), '2027-01-01');
  assert.equal(daily.dailyDateKey(kst('2028-02-29T00:00:00')), '2028-02-29');
  assert.ok(daily.isDateKey('2028-02-29'));
  assert.ok(!daily.isDateKey('2027-02-29'));
  assert.ok(!daily.isDateKey('2026-13-01'));
  assert.equal(daily.dailyDateLabel('2027-01-01'), '1월 1일');
});

test('날짜와 출제는 브라우저 시간대와 무관하다 (TZ 를 바꾼 별도 프로세스)', () => {
  const script = `
    globalThis.window = { localStorage: { getItem(){return null}, setItem(){}, removeItem(){} } };
    const { readFileSync } = await import('node:fs');
    const d = await import(${JSON.stringify(new URL('../js/core/daily.js', import.meta.url).href)});
    const ids = ['history','science','geography','general','art'];
    const banks = Object.fromEntries(ids.map((id) => [id, JSON.parse(readFileSync(new URL('../data/' + id + '.json', ${JSON.stringify(import.meta.url)}), 'utf8'))]));
    const now = Date.parse('2026-11-24T15:30:00Z');
    const key = d.dailyDateKey(now);
    const b = d.buildDailyQuestions({ dateKey: key, banks });
    console.log(JSON.stringify({ key, local: new Date(now).getDate(), q: b.questions.map((q) => q.id + ':' + q.choices.join('|')) }));
  `;
  const outputs = ['UTC', 'America/Los_Angeles', 'Asia/Seoul', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'].map((tz) => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)),
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  });
  // 시간대마다 «그 지역의 날»은 다르다 — 그래도 오늘의 퀴즈의 날과 문제는 같다
  assert.ok(new Set(outputs.map((o) => o.local)).size > 1, '시험한 시간대들의 현지 날짜가 실제로 다르다');
  for (const output of outputs) {
    assert.equal(output.key, '2026-11-25');
    assert.deepEqual(output.q, outputs[0].q);
  }
});

test('출제는 같은 날·같은 은행이면 같고, 은행의 배열 순서와 무관하며, 분야마다 몫대로다', () => {
  const first = build('2026-11-25');
  assert.equal(first.ok, true);
  assertDaily20(first.questions, '2026-11-25');
  assert.deepEqual(shape(build('2026-11-25')), shape(first));

  // 배열을 뒤집고 섞어도(은행·분야 객체 순서 모두) 같다
  const scrambled = Object.fromEntries([...CATEGORY_IDS].reverse().map((id) => {
    const copy = [...realBanks[id]].reverse();
    copy.push(copy.shift());
    return [id, copy];
  }));
  const again = build('2026-11-25', scrambled);
  assert.deepEqual(shape(again), shape(first));
  assert.equal(again.bankVersion, first.bankVersion);

  // 보기 순서는 섞이지만 정답 글은 그대로다
  for (const question of first.questions) {
    const original = realBanks[question.category].find((q) => q.id === question.id);
    assert.deepEqual([...question.choices].sort(), [...original.choices].sort());
    assert.equal(question.choices[question.answerIndex], original.choices[original.answerIndex]);
  }
  // 날짜가 바뀌면 문제가 바뀐다 (한 달 동안 서로 다른 조합이 거의 다다)
  const month = Array.from({ length: 30 }, (_, i) => shape(build(daily.dailyDateKey(kst('2026-11-01T12:00:00') + i * 86400000))).map((x) => x[0]).join(','));
  assert.ok(new Set(month).size >= 28, `한 달 30일에 서로 다른 조합 ${new Set(month).size}개`);
  // 원본 은행은 건드리지 않는다
  assert.equal(realBanks.art[0].id, 'art-001');
});

test('은행 판이 바뀌면 bankVersion 이 바뀐다 — 문제 글 하나만 고쳐도', () => {
  const base = build('2026-11-25');
  const edited = structuredClone(realBanks);
  edited.science[3].question += ' (고침)';
  assert.notEqual(build('2026-11-25', edited).bankVersion, base.bankVersion);
  // 몫을 정하는 난이도만 바뀌어도 다른 판이다
  const relabeled = structuredClone(realBanks);
  const target = relabeled.history.find((q) => q.difficulty === 'normal');
  target.difficulty = 'hard';
  assert.notEqual(build('2026-11-25', relabeled).bankVersion, base.bankVersion);
  assert.notEqual(daily.questionFingerprint(target), daily.questionFingerprint({ ...target, difficulty: 'normal' }));
});

/** 한 분야의 한 난이도를 n개만 남긴 은행 (나머지 문제는 그대로) */
function withTier(category, difficulty, keep) {
  const banks = structuredClone(realBanks);
  let kept = 0;
  banks[category] = banks[category].filter((q) => q.difficulty !== difficulty || (kept += 1) <= keep);
  return banks;
}

test('20문제: 어려움이 하나뿐이거나 빈 난이도가 있으면 만들지 않는다 — 다른 난이도·같은 문제로 채우지 않는다', () => {
  for (const [category, difficulty, keep] of [['art', 'hard', 1], ['science', 'hard', 0], ['history', 'easy', 0], ['general', 'normal', 0]]) {
    const result = build('2026-11-25', withTier(category, difficulty, keep));
    assert.equal(result.ok, false, `${category} ${difficulty} ${keep}개`);
    assert.equal(result.reason, 'short-tier');
    assert.deepEqual(result.categories, [category]);
    assert.equal(result.questions, undefined, '문제를 내지 않는다');
  }
  // 어려움이 정확히 둘이면 그 둘을 모두 낸다 (서로 다른 문제)
  const exact = withTier('art', 'hard', 2);
  const hardIds = exact.art.filter((q) => q.difficulty === 'hard').map((q) => q.id).sort();
  for (const day of ['2026-11-24', '2026-11-25', '2026-12-31']) {
    const result = build(day, exact);
    assert.equal(result.ok, true);
    assertDaily20(result.questions, day);
    assert.deepEqual(result.questions.filter((q) => q.category === 'art' && q.difficulty === 'hard').map((q) => q.id).sort(), hardIds);
  }
});

test('20문제: 난이도를 모르는 문제는 어느 몫에도 들지 않는다 — 그것으로 모자라면 만들지 않는다', () => {
  // 모르는 난이도를 가진 새 문제를 더해도 판·출제가 그대로다
  const base = build('2026-11-25');
  const extra = structuredClone(realBanks);
  const template = extra.geography[0];
  for (const [n, difficulty] of [[1, 'extreme'], [2, undefined], [3, 'HARD'], [4, 3]]) {
    const question = { ...template, id: `geography-zz${n}`, question: `${template.question} (${n})` };
    if (difficulty === undefined) delete question.difficulty;
    else question.difficulty = difficulty;
    extra.geography.push(question);
  }
  const withUnknown = build('2026-11-25', extra);
  assert.equal(withUnknown.ok, true);
  assert.deepEqual(shape(withUnknown), shape(base));
  assert.equal(withUnknown.bankVersion, base.bankVersion);
  for (let i = 0; i < 40; i += 1) {
    const day = daily.dailyDateKey(kst('2026-11-01T12:00:00') + i * 86400000);
    assert.ok(build(day, extra).questions.every((q) => !q.id.startsWith('geography-zz')), day);
  }
  // 한 분야의 어려움이 모두 모르는 값이면 다른 난이도로 채우지 않고 만들지 않는다
  const unknownHard = structuredClone(realBanks);
  unknownHard.art = unknownHard.art.map((q) => (q.difficulty === 'hard' ? { ...q, difficulty: 'expert' } : q));
  assert.deepEqual(build('2026-11-25', unknownHard), { ok: false, dateKey: '2026-11-25', reason: 'short-tier', categories: ['art'] });
});

test('분야가 비었거나 모두 불량이거나 분야 정의가 다섯이 아니면 만들지 않는다 — 다른 문제로 채우지 않는다', () => {
  const missing = { ...realBanks, geography: [] };
  assert.deepEqual(build('2026-11-25', missing), { ok: false, dateKey: '2026-11-25', reason: 'missing-category', categories: ['geography'] });
  const invalid = { ...realBanks, art: realBanks.art.map((q) => ({ ...q, choices: q.choices.slice(0, 3) })) };
  assert.equal(build('2026-11-25', invalid).reason, 'missing-category');
  const wrongCategory = { ...realBanks, history: realBanks.science };
  assert.deepEqual(build('2026-11-25', wrongCategory).categories, ['history']);
  const four = daily.buildDailyQuestions({ dateKey: '2026-11-25', banks: realBanks, categories: CATEGORY_IDS.slice(0, 4).map((id) => ({ id })) });
  assert.equal(four.reason, 'categories');
  const dup = daily.buildDailyQuestions({ dateKey: '2026-11-25', banks: realBanks, categories: [...CATEGORY_IDS.slice(0, 4), 'art', 'art'].slice(1).map((id) => ({ id })) });
  assert.equal(dup.reason, 'categories');
  // 불량 문제 몇 개는 빼고 나머지로 고른다
  const someBad = { ...realBanks, art: [{ id: 'bad' }, ...realBanks.art] };
  assert.equal(build('2026-11-25', someBad).ok, true);
});

// ── 저장 레코드 ──

function freshRecord(dateKey = '2026-11-25', sessionId = 'tab-a') {
  return daily.createDailyRecord(build(dateKey), { sessionId, nowMs: kst(`${dateKey}T09:00:00`) });
}

function answerAll(record, picks) {
  return picks.reduce((current, pick, index) => daily.appendDailyAnswer(current, {
    questionId: current.questions[index].id, choiceIndex: pick, elapsedMs: 1000,
  }, kst(`${record.dateKey}T09:01:00`) + index), record);
}

test('레코드는 손상·판·날짜·문제·보기 순서·답이 어긋나면 읽지 않는다', () => {
  const record = answerAll(freshRecord(), [0, 1]);
  const roundTrip = (value) => daily.parseDailyRecord(JSON.parse(JSON.stringify(value)), '2026-11-25');
  assert.deepEqual(roundTrip(record), record);
  assert.equal(daily.parseDailyRecord(null, '2026-11-25'), null);
  assert.equal(daily.parseDailyRecord('garbage', '2026-11-25'), null);
  assert.equal(roundTrip({ ...record, schema: 'quiz.daily.v0' }), null, '모르는 판');
  assert.equal(daily.parseDailyRecord(record, '2026-11-26'), null, '다른 날짜 열쇠');
  const swapped = structuredClone(record);
  swapped.questions[0].choices.reverse();
  assert.equal(roundTrip(swapped), null, '보기 순서가 바뀐 문제에 저장된 답 번호를 얹지 않는다');
  const edited = structuredClone(record);
  edited.questions[1].answerIndex = (edited.questions[1].answerIndex + 1) % 4;
  assert.equal(roundTrip(edited), null, '정답이 바뀐 문제');
  const tampered = structuredClone(record);
  tampered.answers[0].correct = !tampered.answers[0].correct;
  assert.equal(roundTrip(tampered), null, '정오를 다시 셈해 견준다');
  const outOfRange = structuredClone(record);
  outOfRange.answers[1].choiceIndex = 4;
  assert.equal(roundTrip(outOfRange), null);
  const wrongOrder = structuredClone(record);
  wrongOrder.answers[0].questionId = record.questions[1].id;
  assert.equal(roundTrip(wrongOrder), null);
  assert.equal(roundTrip({ ...record, completedAt: record.updatedAt }), null, '다 풀지 않았는데 완료');
  const done = answerAll(freshRecord(), twenty((i) => i % 4));
  assert.ok(daily.isDailyComplete(done));
  assert.deepEqual(roundTrip(done), done);
  assert.equal(roundTrip({ ...done, completedAt: null }), null, '다 풀었는데 완료가 없음');
  const nineteen = answerAll(freshRecord(), twenty(0).slice(0, 19));
  assert.ok(!daily.isDailyComplete(nineteen));
  assert.equal(roundTrip({ ...nineteen, completedAt: nineteen.updatedAt }), null, '19답에 완료');
});

/** 레코드의 i 번째 문제를 갈아 끼우고 지문을 다시 맞춘다 — 지문 말고 다른 규칙이 거르는지 본다 */
function replaceQuestion(record, index, question) {
  const copy = structuredClone(record);
  copy.questions[index] = structuredClone(question);
  copy.fingerprints[index] = daily.questionFingerprint(copy.questions[index]);
  return copy;
}

test('20문제 레코드(v2): 왕복하고, 몫·중복·길이·넘친 답·지문·판이 어긋나면 읽지 않는다', () => {
  const roundTrip = (value) => daily.parseDailyRecord(JSON.parse(JSON.stringify(value)), '2026-11-25');
  const record = answerAll(freshRecord(), [0, 1, 2]);
  assert.equal(record.schema, 'quiz.daily.v2');
  assert.equal(record.questions.length, 20);
  assertDaily20(record.questions, 'record', (q) => q.difficulty);
  assert.deepEqual(roundTrip(record), record);

  // 아래 모양 검사는 답이 없는 판에서 한다 — 답의 문제 ID 가 어긋나서가 아니라 그 규칙 때문에 걸러지는지 본다
  const blank = freshRecord();
  assert.deepEqual(roundTrip(blank), blank);
  // 몫이 깨짐: 어려움 하나를 같은 분야의 쉬움 문제로 (지문은 맞췄다)
  const hardIndex = blank.questions.findIndex((q) => q.difficulty === 'hard');
  const category = blank.questions[hardIndex].category;
  const used = new Set(blank.questions.map((q) => q.id));
  const easy = realBanks[category].find((q) => q.difficulty === 'easy' && !used.has(q.id));
  assert.equal(roundTrip(replaceQuestion(blank, hardIndex, easy)), null, '분야의 난이도 몫이 어긋난 판');
  // 같은 분야·같은 난이도의 안 쓴 문제로 바꾸면 모양은 맞다(지문을 맞췄으니 읽힌다) — 위의 null 이 몫 때문임을 보인다
  const otherHardSame = realBanks[category].find((q) => q.difficulty === 'hard' && !used.has(q.id));
  assert.notEqual(roundTrip(replaceQuestion(blank, hardIndex, otherHardSame)), null);
  // 분야가 깨짐: 다른 분야의 어려움 문제로
  const otherCategory = CATEGORY_IDS.find((id) => id !== category);
  const otherHard = realBanks[otherCategory].find((q) => q.difficulty === 'hard' && !used.has(q.id));
  assert.equal(roundTrip(replaceQuestion(blank, hardIndex, otherHard)), null, '분야마다 4문제가 아닌 판');
  // 같은 문제 두 번: 같은 분야·같은 난이도의 다른 자리에 같은 문제
  const twinIndex = blank.questions.findIndex((q, i) => i !== hardIndex && q.category === category && q.difficulty === 'hard');
  assert.equal(roundTrip(replaceQuestion(blank, twinIndex, blank.questions[hardIndex])), null, '문제 ID 가 겹친 판');
  // 모르는 난이도
  assert.equal(roundTrip(replaceQuestion(blank, hardIndex, { ...blank.questions[hardIndex], difficulty: 'expert' })), null);
  // 난이도만 바꾸고 지문을 그대로 두면 지문이 거른다
  const stale = structuredClone(blank);
  stale.questions[hardIndex].difficulty = 'easy';
  assert.equal(roundTrip(stale), null, '난이도가 바뀐 문제');
  // 길이: 5문제 판의 모양(v2 판 이름을 달아도)·21문제
  assert.equal(roundTrip({ ...blank, questions: blank.questions.slice(0, 5), fingerprints: blank.fingerprints.slice(0, 5) }), null);
  const extraQuestion = realBanks[category].find((q) => !used.has(q.id));
  assert.equal(roundTrip({ ...blank, questions: [...blank.questions, extraQuestion], fingerprints: [...blank.fingerprints, daily.questionFingerprint(extraQuestion)] }), null);
  // 넘친 답: 21번째 답
  const done = answerAll(freshRecord(), twenty(1));
  assert.equal(roundTrip({ ...done, answers: [...done.answers, done.answers[0]] }), null, '20개를 넘는 답');
  assert.throws(() => daily.appendDailyAnswer(done, { questionId: done.questions[0].id, choiceIndex: 0, elapsedMs: 0 }, 0), /차례/);
  // 예전 판(v1)은 읽지 않는다
  assert.equal(roundTrip({ ...record, schema: 'quiz.daily.v1' }), null, 'v1 레코드');
});

test('쓰기 충돌: 끝낸 기록은 덮지 않고, 앞선 탭을 되돌리지 않고, 날짜가 다르면 견주지 않는다', () => {
  const base = freshRecord();
  const two = answerAll(base, [0, 1]);
  const one = answerAll(base, [0]);
  const oneOther = answerAll(base, [2]);
  const done = answerAll(base, twenty((i) => i % 4));
  assert.deepEqual(daily.planDailyWrite(null, one), { action: 'write' });
  assert.deepEqual(daily.planDailyWrite(one, two), { action: 'write' });
  assert.deepEqual(daily.planDailyWrite(two, one), { action: 'adopt', record: two }, '앞선 탭이 이긴다');
  assert.deepEqual(daily.planDailyWrite(one, oneOther), { action: 'adopt', record: one }, '먼저 확정한 답이 이긴다');
  assert.deepEqual(daily.planDailyWrite(done, two), { action: 'adopt', record: done }, '끝난 기록을 덮지 않는다');
  const doneOther = answerAll(daily.createDailyRecord(build('2026-11-25'), { sessionId: 'tab-b', nowMs: 0 }), twenty(1));
  // 19답의 판도 끝낸 기록을 덮지 않는다
  assert.deepEqual(daily.planDailyWrite(done, answerAll(base, twenty(2).slice(0, 19))), { action: 'adopt', record: done });
  assert.deepEqual(daily.planDailyWrite(done, doneOther), { action: 'adopt', record: done }, '다른 탭의 완료도 덮지 않는다');
  assert.deepEqual(daily.planDailyWrite(done, done), { action: 'write' }, '같은 완료를 다시 쓰는 것은 된다');
  assert.throws(() => daily.planDailyWrite(freshRecord('2026-11-24'), one), /다른 날짜/);
  // 은행이 바뀌기 전에 연 끝나지 않은 판은 지금 은행의 판이 덮는다
  const edited = structuredClone(realBanks);
  edited.art = edited.art.map((q) => ({ ...q, explanation: `${q.explanation}!` }));
  const drifted = answerAll(daily.createDailyRecord(build('2026-11-25', edited), { sessionId: 'old', nowMs: 0 }), [0, 0, 0]);
  assert.deepEqual(daily.planDailyWrite(drifted, one), { action: 'write' });
});

test('세션: 시간 제한이 없고, 같은 문항의 두 번째 확정은 저장·채점하지 않는다', () => {
  const confirms = [];
  const session = daily.createDailySession(freshRecord(), {
    onConfirm: (record, answer) => {
      const next = daily.appendDailyAnswer(record, answer, 0);
      confirms.push(next);
      return { status: 'saved', record: next };
    },
  });
  assert.equal(session.timeLimitMs, null);
  assert.equal(session.total, 20);
  assert.equal(session.position, 1);
  const first = session.submit({ choiceIndex: 2, elapsedMs: 3000 });
  const again = session.submit({ choiceIndex: 0, elapsedMs: 4000 });
  assert.equal(again, first);
  assert.equal(confirms.length, 1);
  assert.equal(session.record().answers.length, 1);
  assert.throws(() => { session.goNext(); session.submit({ choiceIndex: null, elapsedMs: 0 }); }, /시간 초과/);
  assert.throws(() => daily.createDailySession(answerAll(freshRecord(), twenty(0)), { onConfirm: () => {} }), /다시 풀 수 없습니다/);
  // 19답의 판은 다시 열어 20번째부터 잇는다
  const resumed = daily.createDailySession(answerAll(freshRecord(), twenty(0).slice(0, 19)), { onConfirm: () => {} });
  assert.equal(resumed.position, 20);
  assert.equal(resumed.isAnswered(), false);
});

// ── 저장소 ──

test('저장소: 날짜마다 열쇠가 따로이고, 쓴 뒤 다시 읽어 확인하며, 못 쓰면 저장했다고 말하지 않는다', () => {
  const storage = memoryStorage();
  const store = createDailyStore(storage, { persistent: true });
  const one = answerAll(freshRecord(), [0]);
  assert.deepEqual(store.save(one), { status: 'saved', record: one });
  assert.deepEqual(store.load('2026-11-25'), { kind: 'record', record: one });
  assert.deepEqual(store.load('2026-11-24'), { kind: 'empty' });
  const yesterday = answerAll(freshRecord('2026-11-24'), twenty(1));
  store.save(yesterday);
  assert.deepEqual(store.load('2026-11-25').record, one, '다른 날짜의 쓰기가 오늘을 덮지 않는다');
  assert.equal(dailyKey('2026-11-25'), 'quiz.daily.v2.2026-11-25', '20문제 판은 v2 열쇠에 쓴다');
  assert.deepEqual([...new Set(storage.writes)].sort(), [dailyKey('2026-11-24'), dailyKey('2026-11-25'), 'quiz.daily.v2.index']);

  storage.values.set(dailyKey('2026-11-25'), '{not json');
  assert.deepEqual(store.load('2026-11-25'), { kind: 'corrupt' });

  const failing = createDailyStore(memoryStorage({ failWrites: true }), { persistent: true });
  assert.equal(failing.save(one).status, 'memory');
  const memoryOnly = createDailyStore(memoryStorage(), { persistent: false });
  assert.equal(memoryOnly.save(one).status, 'memory');
  assert.equal(memoryOnly.durable, false);

  // 읽어 보니 다르면(다른 탭이 그 사이에 썼거나 저장소가 말없이 버렸다) 저장했다고 하지 않는다
  const lossy = memoryStorage();
  lossy.getItem = () => null;
  assert.equal(createDailyStore(lossy, { persistent: true }).save(one).status, 'memory');
});

test('저장소: 최근 14일만 남기고 오래된 날짜를 지운다', () => {
  const storage = memoryStorage();
  const store = createDailyStore(storage, { persistent: true });
  const days = Array.from({ length: 16 }, (_, i) => daily.dailyDateKey(kst('2026-11-01T12:00:00') + i * 86400000));
  for (const day of days) store.save(answerAll(freshRecord(day), [0]));
  assert.equal(storage.getItem(dailyKey(days[0])), null);
  assert.equal(storage.getItem(dailyKey(days[1])), null);
  assert.notEqual(storage.getItem(dailyKey(days[2])), null);
  assert.equal(JSON.parse(storage.getItem('quiz.daily.v2.index')).length, 14);
});

/** 5문제 시절(v1)의 실제 모양의 레코드 글. v2 코드가 읽거나 고치면 안 된다 */
function legacyV1Text(dateKey, { answered = 5 } = {}) {
  const questions = CATEGORY_IDS.map((id) => realBanks[id][0]);
  const at = `${dateKey}T00:00:00.000Z`;
  return JSON.stringify({
    schema: 'quiz.daily.v1', dateKey, bankVersion: 'legacy', sessionId: 'old-tab', startedAt: at, updatedAt: at,
    completedAt: answered === 5 ? at : null,
    questions,
    fingerprints: questions.map(() => 'legacy-fp'),
    answers: questions.slice(0, answered).map((q) => ({ questionId: q.id, choiceIndex: q.answerIndex, correct: true, elapsedMs: 1 })),
  });
}

test('v1 격리: 5문제 시절의 열쇠·날짜 목록·레코드는 그대로이고, 그 완료·답을 20문제 판에 쓰지 않는다', () => {
  const storage = memoryStorage();
  const legacy = new Map([
    ['quiz.daily.v1.2026-11-25', legacyV1Text('2026-11-25')],
    ['quiz.daily.v1.2026-11-24', legacyV1Text('2026-11-24', { answered: 2 })],
    ['quiz.daily.v1.2026-10-01', legacyV1Text('2026-10-01')],
    ['quiz.daily.v1.index', JSON.stringify(['2026-11-25', '2026-11-24', '2026-10-01'])],
  ]);
  for (const [key, value] of legacy) storage.values.set(key, value);

  // 오늘 v1 을 끝냈어도 20문제 판은 «시작 전»이다 — v1 완료를 20문제 완료로 읽지 않는다
  const h = harness({ storage });
  assert.deepEqual(h.controller.refreshHome(), { kind: 'new', dateKey: '2026-11-25' });
  h.controller.open();
  assert.equal(h.calls.review.length, 0);
  assert.equal(h.session().total, 20);
  assert.equal(h.session().position, 1, 'v1 의 답을 20문제 판에 얹지 않는다');
  assert.deepEqual(h.calls.announce, [], 'v1 을 깨진 기록이라고 하지도 않는다');
  for (let n = 1; n <= 20; n += 1) {
    answer(h, n % 4);
    if (n < 20) h.session().goNext();
  }
  assert.ok(JSON.parse(storage.getItem(dailyKey('2026-11-25'))).completedAt);
  // 다른 날들도 v2 에만 쓰고 14일을 넘겨 정리해도 v1 은 손대지 않는다
  const store = createDailyStore(storage, { persistent: true });
  for (let i = 0; i < 16; i += 1) store.save(answerAll(freshRecord(daily.dailyDateKey(kst('2026-11-01T12:00:00') + i * 86400000)), [0]));
  for (const [key, value] of legacy) assert.equal(storage.values.get(key), value, `${key} 가 그대로다`);
  assert.ok(storage.writes.every((key) => key.startsWith('quiz.daily.v2.')), 'v1 열쇠에 쓰지 않는다');
  assert.deepEqual(store.load('2026-10-01'), { kind: 'empty' }, 'v2 저장소는 v1 레코드를 읽지 않는다');
});

// ── 흐름 (화면 없이 컨트롤러만) ──

function harness({ storage = memoryStorage(), persistent = true, banks = realBanks, clock } = {}) {
  const time = clock ?? { now: kst('2026-11-25T08:00:00') };
  const calls = { play: [], review: [], unavailable: [], status: [], announce: [] };
  const controller = createDailyController({
    store: createDailyStore(storage, { persistent }),
    banks,
    now: () => time.now,
    newSessionId: (() => { let n = 0; return () => `s${(n += 1)}`; })(),
    play: (session, view) => calls.play.push({ session, view }),
    showReview: (view) => calls.review.push(view),
    showUnavailable: (message) => calls.unavailable.push(message),
    setHomeStatus: (status) => calls.status.push(status),
    announce: (message) => calls.announce.push(message),
    schedule: () => () => {},
  });
  const session = () => calls.play.at(-1).session;
  return { controller, calls, storage, time, session };
}

/**
 * 나가기 확인의 본문. 퀴즈 화면은 확인창을 **열 때마다** 이 값을 다시 읽는다 — 판을 연 뒤 저장이 실패하거나
 * 회복하면 그 순간의 말이어야 한다. (예전에는 판을 열 때 정한 글 하나였다)
 */
const exitNoteOf = (view) => (typeof view.exitNote === 'function' ? view.exitNote() : view.exitNote);

/** 퀴즈 화면이 하는 그대로: 답하고(확정), 피드백의 저장 줄을 읽고, 「다음」 */
function answer(h, choice) {
  const s = h.session();
  s.submit({ choiceIndex: choice, elapsedMs: 1200 });
  const note = h.calls.play.at(-1).view.saveNote();
  return note;
}

test('흐름: 시작 전 → 답마다 저장 → 새로고침·홈으로 와도 첫 안 푼 문제부터 → 끝나면 결과만 다시 연다', () => {
  const storage = memoryStorage();
  const tab = harness({ storage });
  assert.deepEqual(tab.controller.refreshHome(), { kind: 'new', dateKey: '2026-11-25' });
  tab.controller.open();
  const view = tab.calls.play[0].view;
  assert.equal(view.categoryLabel, '오늘의 퀴즈 · 11월 25일');
  assert.match(exitNoteOf(view), /이 기기에 저장돼요/);
  assert.equal(tab.session().timeLimitMs, null);
  assert.equal(answer(tab, 1), '이 기기에 저장했어요');
  // 확정 즉시 저장됐다 — 「다음」을 누르기 전에 새로고침해도 남는다
  const stored = JSON.parse(storage.getItem(dailyKey('2026-11-25')));
  assert.equal(stored.answers.length, 1);

  // 새로고침: 새 컨트롤러가 같은 저장소를 읽는다
  const reloaded = harness({ storage });
  assert.deepEqual(reloaded.controller.refreshHome(), { kind: 'resume', dateKey: '2026-11-25', answered: 1 });
  assert.equal(dailyStatusText(reloaded.controller.refreshHome()), '이어 풀기 1/20');
  reloaded.controller.open();
  assert.equal(reloaded.session().position, 2);
  assert.equal(reloaded.session().currentQuestion().id, stored.questions[1].id);
  answer(reloaded, 0);
  reloaded.session().goNext();
  answer(reloaded, 0);
  // 홈으로 (나가기): 판을 놓고 다시 연다
  reloaded.controller.release();
  assert.equal(reloaded.controller.refreshHome().answered, 3);
  reloaded.controller.open();
  assert.equal(reloaded.session().position, 4);
  for (let n = 4; n < 20; n += 1) {
    assert.equal(answer(reloaded, n % 4), '이 기기에 저장했어요', `${n}번째 답은 아직 끝이 아니다`);
    reloaded.session().goNext();
  }
  assert.equal(answer(reloaded, 2), '오늘의 퀴즈를 마쳤어요 · 이 기기에 저장했어요');
  assert.equal(reloaded.session().hasNext(), false);

  // 마지막 답 직후 새로고침 — 결과 화면에 가기 전이어도 완료다
  const afterFinal = harness({ storage });
  const done = afterFinal.controller.refreshHome();
  assert.equal(done.kind, 'done');
  assert.equal(dailyStatusText(done), '완료 · 결과 보기');
  const before = storage.getItem(dailyKey('2026-11-25'));
  afterFinal.controller.open();
  assert.equal(afterFinal.calls.play.length, 0, '끝낸 날은 다시 풀지 않는다');
  const review = afterFinal.calls.review[0];
  assert.equal(review.title, '오늘의 퀴즈 결과');
  assert.equal(review.scope, '이 기기에만 저장되고 랭킹·기록에는 남지 않아요.');
  assert.equal(review.review.items.length, 20);
  assert.equal(review.review.totalCount, 20);
  assert.ok(review.review.items.every((item) => item.explanation && item.correctChoice));
  // 해설·정오는 저장된 20문항 그대로, 실제로 푼 순서다
  const finalRecord = JSON.parse(before);
  assert.deepEqual(review.review.items.map((item) => item.id), finalRecord.questions.map((q) => q.id));
  assert.deepEqual(review.review.items.map((item) => item.correct), finalRecord.answers.map((ans) => ans.correct));
  assert.equal(review.summary, `11월 25일 · 20문제 중 ${review.review.correctCount}개 정답`);
  assert.equal(review.review.correctCount, finalRecord.answers.filter((ans) => ans.correct).length);
  afterFinal.controller.open();
  assert.equal(storage.getItem(dailyKey('2026-11-25')), before, '다시 열어도 기록이 바뀌지 않는다');

  // 결과 보기로 끝낸 탭은 결과로 간다
  reloaded.controller.complete(reloaded.session());
  assert.equal(reloaded.calls.review.at(-1).title, '오늘의 퀴즈 결과');
  assert.equal(reloaded.controller.isPlaying(), false);
});

test('흐름: 여러 탭 — 앞선 탭의 답을 이어받고, 다른 탭이 끝낸 기록은 남은 탭의 오래된 판이 덮지 않는다', () => {
  const storage = memoryStorage();
  const a = harness({ storage });
  const b = harness({ storage });
  a.controller.open();
  b.controller.open();
  answer(a, 0); a.session().goNext();
  answer(a, 1); a.session().goNext();
  // b 는 아직 1번이다. b 의 답은 저장되지 않고 a 의 기록으로 갈아탄다
  assert.equal(answer(b, 3), '다른 창에서 먼저 저장한 기록으로 이어 가요');
  assert.equal(JSON.parse(storage.getItem(dailyKey('2026-11-25'))).answers[0].choiceIndex, 0);
  assert.equal(b.session().hasNext(), true);
  b.session().goNext();
  assert.equal(b.session().position, 3);
  assert.equal(b.session().isAnswered(), false);

  // a 가 끝낸다 (3번부터 20번까지)
  for (let n = 3; n < 20; n += 1) { answer(a, n % 4); a.session().goNext(); }
  answer(a, 0);
  const completed = storage.getItem(dailyKey('2026-11-25'));
  assert.ok(JSON.parse(completed).completedAt);
  // b 는 3번에서 답한다 — 오래된 판이라 끝난 기록을 덮지 않고 a 의 결과로 끝난다
  assert.equal(answer(b, 1), '다른 창에서 먼저 저장한 기록으로 이어 가요');
  assert.equal(storage.getItem(dailyKey('2026-11-25')), completed);
  assert.equal(b.session().hasNext(), false);
  b.controller.complete(b.session());
  const review = b.calls.review.at(-1);
  assert.equal(review.title, '오늘의 퀴즈 결과');
  assert.deepEqual(review.review.items.map((item) => item.chosenChoice),
    JSON.parse(completed).answers.map((ans, i) => JSON.parse(completed).questions[i].choices[ans.choiceIndex]));
});

test('흐름: 자정을 넘겨도 판은 연 날짜의 것이고, 홈은 새 날짜를 따로 보인다', () => {
  const storage = memoryStorage();
  const clock = { now: kst('2026-11-24T23:59:30') };
  const h = harness({ storage, clock });
  assert.equal(h.controller.refreshHome().dateKey, '2026-11-24');
  h.controller.open();
  answer(h, 0); h.session().goNext();
  clock.now = kst('2026-11-25T00:00:30');
  for (let n = 2; n < 20; n += 1) { answer(h, n % 4); h.session().goNext(); }
  answer(h, 0);
  h.controller.complete(h.session());
  assert.match(h.calls.review.at(-1).summary, /^11월 24일 · 20문제 중 /);
  assert.ok(JSON.parse(storage.getItem(dailyKey('2026-11-24'))).completedAt, '연 날짜에 완료로 남는다');
  assert.equal(storage.getItem(dailyKey('2026-11-25')), null, '새 날짜에는 아무것도 쓰지 않는다');
  assert.deepEqual(h.controller.refreshHome(), { kind: 'new', dateKey: '2026-11-25' });
  h.controller.open();
  assert.equal(h.calls.play.length, 2, '새 날은 새로 푼다');
  assert.notDeepEqual(h.session().getQuestionIds(), JSON.parse(storage.getItem(dailyKey('2026-11-24'))).questions.map((q) => q.id));
});

test('흐름: 깨진 기록·바뀐 은행은 새로 시작하고 알린다 — 끝낸 기록은 은행이 바뀌어도 결과로 남는다', () => {
  const storage = memoryStorage();
  storage.values.set(dailyKey('2026-11-25'), '{"schema":"quiz.daily.v2","broken":');
  const corrupt = harness({ storage });
  assert.equal(corrupt.controller.refreshHome().kind, 'new');
  corrupt.controller.open();
  assert.deepEqual(corrupt.calls.announce, ['저장된 오늘의 퀴즈를 읽지 못해 처음부터 풀어요.']);
  answer(corrupt, 0);
  assert.equal(JSON.parse(storage.getItem(dailyKey('2026-11-25'))).answers.length, 1, '첫 확정이 깨진 기록을 갈아 쓴다');

  // 은행이 바뀌었다 (보기 하나의 글) — 끝나지 않은 판의 답을 바뀐 문제에 얹지 않는다
  const edited = structuredClone(realBanks);
  for (const id of CATEGORY_IDS) edited[id] = edited[id].map((q) => ({ ...q, choices: [`${q.choices[0]} `.trim() + '·', ...q.choices.slice(1)] }));
  const drift = harness({ storage, banks: edited });
  assert.equal(drift.controller.refreshHome().kind, 'new');
  drift.controller.open();
  assert.deepEqual(drift.calls.announce, ['문제가 바뀌어 오늘의 퀴즈를 처음부터 풀어요.']);
  assert.equal(drift.session().position, 1);
  for (let n = 1; n < 20; n += 1) { answer(drift, n % 4); drift.session().goNext(); }
  answer(drift, 0);
  const completed = storage.getItem(dailyKey('2026-11-25'));
  // 원래 은행으로 돌아가도(배포를 되돌림) 끝낸 기록은 그대로 결과다
  const back = harness({ storage });
  assert.equal(back.controller.refreshHome().kind, 'done');
  back.controller.open();
  assert.equal(back.calls.review.length, 1);
  assert.equal(storage.getItem(dailyKey('2026-11-25')), completed);
});

test('흐름: 저장소를 못 쓰면 이 창에서는 이어 가지만 저장했다고 말하지 않는다', () => {
  const broken = harness({ storage: memoryStorage({ failWrites: true }) });
  broken.controller.open();
  assert.equal(answer(broken, 0), '저장하지 못했어요 · 이 창을 닫으면 사라져요');
  broken.controller.release();
  // 같은 창의 홈은 메모리의 진행을 안다
  assert.deepEqual(broken.controller.refreshHome(), { kind: 'resume', dateKey: '2026-11-25', answered: 1 });
  broken.controller.open();
  assert.equal(broken.session().position, 2);
  for (let n = 2; n < 20; n += 1) { answer(broken, n % 4); broken.session().goNext(); }
  assert.equal(answer(broken, 0), dailySaveNote('memory', true));
  broken.controller.complete(broken.session());
  assert.equal(broken.calls.review.at(-1).scope, '저장하지 못했어요. 이 창을 닫으면 사라져요.');
  assert.equal(broken.controller.refreshHome().kind, 'done');

  const memoryOnly = harness({ persistent: false });
  memoryOnly.controller.open();
  assert.match(exitNoteOf(memoryOnly.calls.play[0].view), /저장하지 못하고 있어요/);
  assert.equal(answer(memoryOnly, 0), '저장하지 못했어요 · 이 창을 닫으면 사라져요');
});

/**
 * 처음에는 쓸 수 있는 저장소(부팅 시험을 지났다 — persistent). 부팅 뒤에 쓰기가 던지거나(`throw`),
 * 쓰기는 통한 듯하지만 다시 읽으면 다른 값(`drop` — 말없이 버린다)이 되도록 바꿀 수 있다
 */
function flakyStorage() {
  const storage = memoryStorage();
  const mode = { fail: null };
  const set = storage.setItem;
  storage.setItem = (key, value) => {
    if (mode.fail === 'throw') { storage.writes.push(key); throw new Error('QuotaExceededError'); }
    if (mode.fail === 'drop') { storage.writes.push(key); return; }
    set(key, value);
  };
  return { storage, mode };
}

for (const failure of ['throw', 'drop']) {
  test(`흐름: 부팅 뒤 저장이 실패(${failure})한 판을 다시 열어 답하지 않고 푼 문제를 보면 저장했다고 말하지 않는다`, () => {
    const { DAILY_UNSAVED_SCOPE, DAILY_PARTIAL_SCOPE } = flowModule;
    const { storage, mode } = flakyStorage();
    const h = harness({ storage, persistent: true });
    h.controller.open();
    // 첫 답은 저장된다 — 저장소는 처음에 정말로 쓸 수 있었다
    assert.equal(answer(h, 0), '이 기기에 저장했어요');
    h.session().goNext();
    mode.fail = failure;
    assert.equal(answer(h, 1), '저장하지 못했어요 · 이 창을 닫으면 사라져요');
    assert.equal(JSON.parse(storage.values.get(dailyKey('2026-11-25'))).answers.length, 1, '저장소에는 앞 답 하나뿐이다');
    // 홈으로 → 같은 진행을 다시 연다 → 답하지 않고 «나가고 푼 문제 해설 보기»
    h.controller.release();
    assert.deepEqual(h.controller.refreshHome(), { kind: 'resume', dateKey: '2026-11-25', answered: 2 });
    h.controller.open();
    assert.equal(h.session().position, 3);
    assert.match(exitNoteOf(h.calls.play.at(-1).view), /저장하지 못하고 있어요/);
    h.controller.reviewAnswered(h.session());
    const partial = h.calls.review.at(-1);
    assert.equal(partial.review.answeredCount, 2);
    assert.equal(partial.scope, DAILY_UNSAVED_SCOPE, '메모리에만 있는 진행을 «이 기기에 저장돼 있어요»라고 하지 않는다');
    assert.notEqual(partial.scope, DAILY_PARTIAL_SCOPE);

    // 회복: 같은 메모리 레코드의 다음 저장이 정말로 쓰이고 확인되면 저장 범위로 돌아와도 된다
    mode.fail = null;
    h.controller.open();
    assert.equal(h.session().position, 3);
    assert.equal(answer(h, 2), '이 기기에 저장했어요');
    assert.equal(JSON.parse(storage.values.get(dailyKey('2026-11-25'))).answers.length, 3, '메모리의 답까지 함께 썼다');
    h.controller.reviewAnswered(h.session());
    assert.equal(h.calls.review.at(-1).scope, DAILY_PARTIAL_SCOPE);
    // 회복한 뒤 다시 열어 답하지 않고 보아도 저장 범위다
    h.controller.open();
    assert.match(exitNoteOf(h.calls.play.at(-1).view), /이 기기에 저장돼요/);
    h.controller.reviewAnswered(h.session());
    assert.equal(h.calls.review.at(-1).scope, DAILY_PARTIAL_SCOPE);
  });

  test(`흐름: 판 도중 저장이 실패(${failure})하면 홈·다시 열기 없이 곧바로 연 나가기 확인도 저장했다고 말하지 않고, 같은 판에서 회복하면 돌아온다`, () => {
    const { storage, mode } = flakyStorage();
    const h = harness({ storage, persistent: true });
    h.controller.open();
    const view = h.calls.play.at(-1).view;
    const stored = () => JSON.parse(storage.values.get(dailyKey('2026-11-25'))).answers.length;
    // 판을 연 순간에는 저장소가 정말로 쓸 수 있다
    assert.match(exitNoteOf(view), /이 기기에 저장돼요/);
    assert.equal(answer(h, 0), '이 기기에 저장했어요');
    assert.match(exitNoteOf(view), /이 기기에 저장돼요/);
    h.session().goNext();

    // 두 번째 답의 저장이 실패한다 — 메모리 2답 / 저장소 1답
    mode.fail = failure;
    assert.equal(answer(h, 1), '저장하지 못했어요 · 이 창을 닫으면 사라져요');
    assert.equal(h.session().record().answers.length, 2, '이 창의 판은 두 답을 들고 있다');
    assert.equal(stored(), 1, '저장소에는 앞 답 하나뿐이다');
    assert.equal(h.calls.play.length, 1, '홈으로 가거나 다시 열지 않았다 — 같은 판이다');
    // 곧바로 「나가기」를 누른다: 확인창이 그 순간의 저장 상태를 말한다
    const unsavedNote = exitNoteOf(view);
    assert.match(unsavedNote, /저장하지 못하고 있어요/, '메모리에만 있는 답을 저장됐다고 하지 않는다');
    assert.doesNotMatch(unsavedNote, /이 기기에 저장돼요/);
    assert.equal(exitNoteOf(view), unsavedNote, '다시 열어도 같은 말이다 (실패가 이어지는 동안)');

    // 확인창을 닫고(계속 풀기) 저장소가 돌아온 뒤 같은 판에서 다음 답을 낸다 — 메모리의 앞 답까지 함께 쓰인다
    mode.fail = null;
    h.session().goNext();
    assert.equal(answer(h, 2), '이 기기에 저장했어요');
    assert.equal(stored(), 3, '메모리의 답까지 함께 쓰고 다시 읽어 확인했다');
    assert.equal(h.calls.play.length, 1, '여전히 같은 판이다');
    const recoveredNote = exitNoteOf(view);
    assert.match(recoveredNote, /이 기기에 저장돼요/, '회복했으면 저장 범위로 돌아온다');
    assert.doesNotMatch(recoveredNote, /저장하지 못하고 있어요/, '지난 실패의 경고가 남지 않는다');
  });
}

test('흐름: 다른 판으로 넘어간 뒤 예전 판의 나가기 확인 말은 그 판의 것이다 — 새 판의 저장 상태를 빌리지 않는다', () => {
  const { storage, mode } = flakyStorage();
  const h = harness({ storage, persistent: true });
  h.controller.open();
  const first = h.calls.play.at(-1).view;
  mode.fail = 'throw';
  assert.equal(answer(h, 0), '저장하지 못했어요 · 이 창을 닫으면 사라져요');
  assert.match(exitNoteOf(first), /저장하지 못하고 있어요/);
  // 홈으로 → 다시 연다(메모리 진행) → 저장소가 돌아와 다음 답이 저장된다
  h.controller.release();
  mode.fail = null;
  h.controller.open();
  const second = h.calls.play.at(-1).view;
  assert.match(exitNoteOf(second), /저장하지 못하고 있어요/, '아직 답하지 않았으면 연 레코드(메모리)를 따른다');
  assert.equal(answer(h, 1), '이 기기에 저장했어요');
  assert.match(exitNoteOf(second), /이 기기에 저장돼요/);
  assert.match(exitNoteOf(first), /저장하지 못하고 있어요/, '예전 판은 제 마지막 저장을 말한다');
});

test('흐름: 오늘의 퀴즈를 만들 수 없으면 입구가 그렇다고 말하고 다시 불러오기를 권한다', () => {
  const h = harness({ banks: { ...realBanks, art: [] } });
  assert.equal(h.controller.refreshHome().kind, 'unavailable');
  h.controller.open();
  assert.equal(h.calls.play.length, 0);
  assert.match(h.calls.unavailable[0], /다시 불러오면 다시 시도해요/);
  assert.equal(dailyStatusText({ kind: 'unavailable', dateKey: '2026-11-25' }), '지금은 열 수 없어요');
});

// ── 20문제: 분야 다섯 × (쉬움 1·보통 1·어려움 2) ──────────────────────

test('20문제: 날마다 분야 다섯 × (쉬움 1·보통 1·어려움 2) = 정확히 20문제이고 문제 ID 20개가 모두 다르다', () => {
  for (const day of ['2026-11-24', '2026-11-25', '2027-01-01', '2028-02-29']) {
    const result = build(day);
    assert.equal(result.ok, true, day);
    assertDaily20(result.questions, day);
  }
});

test('20문제: 5·15·19번째 답 뒤에는 이어 풀기이고 20번째 답에서만 끝난다', () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  h.controller.open();
  assert.equal(h.session().total, 20);
  for (let n = 1; n <= 20; n += 1) {
    answer(h, (n + 1) % 4);
    const stored = JSON.parse(storage.getItem(dailyKey('2026-11-25')));
    assert.equal(stored.answers.length, n);
    if ([5, 15, 19].includes(n)) {
      assert.equal(stored.completedAt, null, `${n}답 뒤에는 끝나지 않았다`);
      assert.equal(h.session().hasNext(), true, `${n}답 뒤에도 다음 문제가 있다`);
      const reopened = harness({ storage });
      assert.deepEqual(reopened.controller.refreshHome(), { kind: 'resume', dateKey: '2026-11-25', answered: n });
      assert.equal(dailyStatusText(reopened.controller.refreshHome()), `이어 풀기 ${n}/20`);
      assert.equal(flowModule.dailyStatusDescription(reopened.controller.refreshHome()),
        `11월 25일, 20문제 중 ${n}문제 풀었어요, 이어 풀기`);
      reopened.controller.open();
      assert.equal(reopened.calls.review.length, 0, `${n}답 뒤 다시 열면 결과가 아니라 이어 푼다`);
      assert.equal(reopened.session().position, n + 1);
      // 나가고 푼 문제 보기: 덜 푼 판이고 공유 글이 없다
      reopened.controller.reviewAnswered(reopened.session());
      const partial = reopened.calls.review.at(-1);
      assert.equal(partial.title, '오늘의 퀴즈 · 푼 문제');
      assert.equal(partial.share, null);
      assert.equal(partial.review.items.length, n);
      assert.match(partial.summary, new RegExp(`^11월 25일 · 20문제 중 ${n}문제를 풀었어요 · 맞힌 문제 \\d+개$`));
    }
    if (n < 20) h.session().goNext();
  }
  assert.equal(h.session().hasNext(), false);
  assert.ok(JSON.parse(storage.getItem(dailyKey('2026-11-25'))).completedAt, '20번째 답에서 끝난다');
  const after = harness({ storage });
  assert.equal(after.controller.refreshHome().kind, 'done');
  after.controller.open();
  const review = after.calls.review[0];
  assert.equal(review.review.items.length, 20);
  assert.match(review.summary, /^11월 25일 · 20문제 중 \d+개 정답$/);
  const done = after.controller.refreshHome();
  assert.equal(flowModule.dailyStatusDescription(done), `11월 25일, 완료, 20문제 중 ${done.correct}개 정답, 결과 보기`);
  assert.equal(dailyStatusText({ kind: 'new', dateKey: '2026-11-25' }), '20문제 · 시작 전');
});

test('20문제: 두 탭이 19→20 을 다투면 먼저 끝낸 탭의 기록이 이기고, 늦은 탭은 그 결과로 끝난다', () => {
  const storage = memoryStorage();
  const a = harness({ storage });
  const b = harness({ storage });
  a.controller.open();
  b.controller.open();
  for (let n = 1; n < 20; n += 1) { answer(a, n % 4); a.session().goNext(); }
  assert.equal(JSON.parse(storage.getItem(dailyKey('2026-11-25'))).answers.length, 19);
  // b 는 1번에 서 있다 — 오래된 판이라 a 의 19답으로 갈아타 20번으로 간다
  assert.equal(answer(b, 0), '다른 창에서 먼저 저장한 기록으로 이어 가요');
  b.session().goNext();
  assert.equal(b.session().position, 20);
  assert.equal(answer(b, 1), '오늘의 퀴즈를 마쳤어요 · 이 기기에 저장했어요');
  const completed = storage.getItem(dailyKey('2026-11-25'));
  assert.equal(JSON.parse(completed).answers.length, 20);
  // a 가 20번째를 다른 답으로 낸다 — 끝난 기록을 덮지 않고 b 의 결과로 끝난다
  assert.equal(answer(a, 3), '다른 창에서 먼저 저장한 기록으로 이어 가요');
  assert.equal(storage.getItem(dailyKey('2026-11-25')), completed);
  assert.equal(a.session().hasNext(), false);
  a.controller.complete(a.session());
  const review = a.calls.review.at(-1);
  assert.equal(review.title, '오늘의 퀴즈 결과');
  assert.equal(review.review.items.length, 20);
  assert.equal(review.review.items[19].chosenChoice, JSON.parse(completed).questions[19].choices[1]);
});

for (const failure of ['throw', 'drop']) {
  test(`20문제: 20번째 답의 저장이 실패(${failure})하면 이 창은 결과를 보이되 저장했다고 하지 않고, 새로고침한 탭은 19답에서 잇는다`, () => {
    const { storage, mode } = flakyStorage();
    const h = harness({ storage });
    h.controller.open();
    for (let n = 1; n < 20; n += 1) { answer(h, n % 4); h.session().goNext(); }
    mode.fail = failure;
    assert.equal(answer(h, 0), dailySaveNote('memory', true));
    assert.equal(JSON.parse(storage.values.get(dailyKey('2026-11-25'))).answers.length, 19, '저장소에는 19답뿐이다');
    h.controller.complete(h.session());
    assert.equal(h.calls.review.at(-1).scope, flowModule.DAILY_UNSAVED_SCOPE);
    assert.equal(h.calls.review.at(-1).review.items.length, 20);
    const reloaded = harness({ storage });
    assert.deepEqual(reloaded.controller.refreshHome(), { kind: 'resume', dateKey: '2026-11-25', answered: 19 });
    // 회복: 저장소가 돌아오면 새로고침한 탭이 20번째를 내 끝내고 그것이 저장된다
    mode.fail = null;
    reloaded.controller.open();
    assert.equal(reloaded.session().position, 20);
    assert.equal(answer(reloaded, 2), '오늘의 퀴즈를 마쳤어요 · 이 기기에 저장했어요');
    assert.ok(JSON.parse(storage.values.get(dailyKey('2026-11-25'))).completedAt);
  });
}

test('경계: 오늘의 퀴즈는 랭킹·개인 기록·온라인·출제 기록·문항 시간 설정에 닿지 않는다', async () => {
  const [core, store, flow, app] = await Promise.all([
    source('src/core/daily.ts'), source('src/storage/daily-store.ts'), source('src/ui/daily.ts'), source('src/app.ts'),
  ]);
  for (const [name, text] of [['core', core], ['store', store], ['flow', flow]]) {
    assert.doesNotMatch(text, /rankingStore|preferences|roomStore|fetch\(|online\/|records-export|setRecentQuestionIds|timeLimitMs\s*=/, name);
  }
  assert.doesNotMatch(store, /window\.localStorage|localStorage\./, '저장소는 safe-storage 만 거친다');
  // 결과 화면(랭킹 자동 저장)·출제 기록·혼자 온라인 판을 거치기 전에 오늘의 퀴즈가 먼저 갈라진다
  const showResult = app.slice(app.indexOf('async function showResult('));
  assert.ok(showResult.indexOf('daily.owns(session)') < showResult.indexOf('rankingStore.getBestScore'));
  assert.ok(showResult.indexOf('daily.complete(session)') < showResult.indexOf('resultScreen.show'));
  const startRound = app.slice(app.indexOf('async function startRound('), app.indexOf('function practiceLabel('));
  assert.match(startRound, /timeLimitMs,\n/, '일반 판의 문항 시간은 그대로 설정에서 온다');
  // 답마다 저장돼 오늘의 퀴즈에서는 새로고침 확인을 끈다. 일반 판의 규칙(goTo 의 한 줄)은 그대로다
  assert.match(app, /setUnloadWarning\(name === 'quiz'\);/);
  assert.match(app, /goTo\('quiz'\);\n\s*\/\/[^\n]*\n\s*setUnloadWarning\(false\);\n\s*quizScreen\.start\(session/);
});
