import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 오늘의 퀴즈 (daily). 홈의 중앙 메뉴(«홈 바로가기»)에 입구 하나를 더하고, 날마다 정해진 다섯 문제를 푼다.
// 기록은 이 브라우저에만 남고 개인 기록·온라인 랭킹·서버에는 가지 않는다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test('홈의 중앙 메뉴에 오늘의 퀴즈 입구가 하나 있고 기존 입구는 그대로다', async () => {
  const html = await source('index.html');
  const home = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const nav = between(home, '<nav class="home-menu"', '</nav>');
  // 입구는 중앙 메뉴 안에 딱 하나다. 모서리 바로가기나 새 카드 묶음이 아니다
  assert.equal((html.match(/id="open-daily"/g) ?? []).length, 1, '오늘의 퀴즈 입구는 하나다');
  assert.match(nav, /<button type="button" class="menu-card home-daily" id="open-daily"[^>]*aria-describedby="daily-status"/);
  assert.match(nav, /menu-card__name">오늘의 퀴즈<\/span>/);
  assert.match(nav, /id="daily-status"/);
  // 기존 입구·이름·순서는 그대로다
  const order = ['open-daily', 'open-characters', 'open-ranking', 'open-rules'];
  order.reduce((previous, id) => { const at = nav.indexOf(`id="${id}"`); assert.ok(at > previous, id); return at; }, -1);
  assert.doesNotMatch(between(home, 'class="home-quests"', 'class="home-secondary"'), /open-daily/);
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
const { createDailyController, dailyStatusText, dailySaveNote } = await import('../js/ui/daily.js');

const CATEGORY_IDS = ['history', 'science', 'geography', 'general', 'art'];
const realBanks = Object.fromEntries(await Promise.all(CATEGORY_IDS.map(async (id) =>
  [id, JSON.parse(await source(`data/${id}.json`))])));

/** KST 의 그 시각 (UTC 로 9시간 앞) */
const kst = (text) => Date.parse(`${text}+09:00`);

const build = (dateKey, banks = realBanks) => daily.buildDailyQuestions({ dateKey, banks });
const shape = (result) => result.questions.map((q) => [q.id, q.choices.join('|'), q.answerIndex]);

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

test('출제는 같은 날·같은 은행이면 같고, 은행의 배열 순서와 무관하며, 분야마다 하나다', () => {
  const first = build('2026-11-25');
  assert.equal(first.ok, true);
  assert.equal(first.questions.length, 5);
  assert.deepEqual(new Set(first.questions.map((q) => q.category)), new Set(CATEGORY_IDS));
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
  const done = answerAll(freshRecord(), [0, 1, 2, 3, 0]);
  assert.ok(daily.isDailyComplete(done));
  assert.equal(roundTrip({ ...done, completedAt: null }), null, '다 풀었는데 완료가 없음');
});

test('쓰기 충돌: 끝낸 기록은 덮지 않고, 앞선 탭을 되돌리지 않고, 날짜가 다르면 견주지 않는다', () => {
  const base = freshRecord();
  const two = answerAll(base, [0, 1]);
  const one = answerAll(base, [0]);
  const oneOther = answerAll(base, [2]);
  const done = answerAll(base, [0, 1, 2, 3, 0]);
  assert.deepEqual(daily.planDailyWrite(null, one), { action: 'write' });
  assert.deepEqual(daily.planDailyWrite(one, two), { action: 'write' });
  assert.deepEqual(daily.planDailyWrite(two, one), { action: 'adopt', record: two }, '앞선 탭이 이긴다');
  assert.deepEqual(daily.planDailyWrite(one, oneOther), { action: 'adopt', record: one }, '먼저 확정한 답이 이긴다');
  assert.deepEqual(daily.planDailyWrite(done, two), { action: 'adopt', record: done }, '끝난 기록을 덮지 않는다');
  const doneOther = answerAll(daily.createDailyRecord(build('2026-11-25'), { sessionId: 'tab-b', nowMs: 0 }), [1, 1, 1, 1, 1]);
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
  assert.equal(session.total, 5);
  assert.equal(session.position, 1);
  const first = session.submit({ choiceIndex: 2, elapsedMs: 3000 });
  const again = session.submit({ choiceIndex: 0, elapsedMs: 4000 });
  assert.equal(again, first);
  assert.equal(confirms.length, 1);
  assert.equal(session.record().answers.length, 1);
  assert.throws(() => { session.goNext(); session.submit({ choiceIndex: null, elapsedMs: 0 }); }, /시간 초과/);
  assert.throws(() => daily.createDailySession(answerAll(freshRecord(), [0, 0, 0, 0, 0]), { onConfirm: () => {} }), /다시 풀 수 없습니다/);
});

// ── 저장소 ──

test('저장소: 날짜마다 열쇠가 따로이고, 쓴 뒤 다시 읽어 확인하며, 못 쓰면 저장했다고 말하지 않는다', () => {
  const storage = memoryStorage();
  const store = createDailyStore(storage, { persistent: true });
  const one = answerAll(freshRecord(), [0]);
  assert.deepEqual(store.save(one), { status: 'saved', record: one });
  assert.deepEqual(store.load('2026-11-25'), { kind: 'record', record: one });
  assert.deepEqual(store.load('2026-11-24'), { kind: 'empty' });
  const yesterday = answerAll(freshRecord('2026-11-24'), [1, 1, 1, 1, 1]);
  store.save(yesterday);
  assert.deepEqual(store.load('2026-11-25').record, one, '다른 날짜의 쓰기가 오늘을 덮지 않는다');
  assert.deepEqual([...new Set(storage.writes)].sort(), [dailyKey('2026-11-24'), dailyKey('2026-11-25'), 'quiz.daily.v1.index']);

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
  assert.equal(JSON.parse(storage.getItem('quiz.daily.v1.index')).length, 14);
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
  assert.match(view.exitNote, /이 기기에 저장돼요/);
  assert.equal(tab.session().timeLimitMs, null);
  assert.equal(answer(tab, 1), '이 기기에 저장했어요');
  // 확정 즉시 저장됐다 — 「다음」을 누르기 전에 새로고침해도 남는다
  const stored = JSON.parse(storage.getItem(dailyKey('2026-11-25')));
  assert.equal(stored.answers.length, 1);

  // 새로고침: 새 컨트롤러가 같은 저장소를 읽는다
  const reloaded = harness({ storage });
  assert.deepEqual(reloaded.controller.refreshHome(), { kind: 'resume', dateKey: '2026-11-25', answered: 1 });
  assert.equal(dailyStatusText(reloaded.controller.refreshHome()), '이어 풀기 1/5');
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
  answer(reloaded, 3);
  reloaded.session().goNext();
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
  assert.equal(review.review.items.length, 5);
  assert.ok(review.review.items.every((item) => item.explanation && item.correctChoice));
  assert.equal(review.summary, `11월 25일 · 5문제 중 ${review.review.correctCount}개 정답`);
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

  // a 가 끝낸다
  for (const pick of [2, 3]) { answer(a, pick); a.session().goNext(); }
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
  for (const pick of [1, 2, 3]) { answer(h, pick); h.session().goNext(); }
  answer(h, 0);
  h.controller.complete(h.session());
  assert.match(h.calls.review.at(-1).summary, /^11월 24일 · 5문제 중 /);
  assert.ok(JSON.parse(storage.getItem(dailyKey('2026-11-24'))).completedAt, '연 날짜에 완료로 남는다');
  assert.equal(storage.getItem(dailyKey('2026-11-25')), null, '새 날짜에는 아무것도 쓰지 않는다');
  assert.deepEqual(h.controller.refreshHome(), { kind: 'new', dateKey: '2026-11-25' });
  h.controller.open();
  assert.equal(h.calls.play.length, 2, '새 날은 새로 푼다');
  assert.notDeepEqual(h.session().getQuestionIds(), JSON.parse(storage.getItem(dailyKey('2026-11-24'))).questions.map((q) => q.id));
});

test('흐름: 깨진 기록·바뀐 은행은 새로 시작하고 알린다 — 끝낸 기록은 은행이 바뀌어도 결과로 남는다', () => {
  const storage = memoryStorage();
  storage.values.set(dailyKey('2026-11-25'), '{"schema":"quiz.daily.v1","broken":');
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
  for (const pick of [0, 1, 2, 3]) { answer(drift, pick); drift.session().goNext(); }
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
  for (const pick of [1, 2, 3]) { answer(broken, pick); broken.session().goNext(); }
  assert.equal(answer(broken, 0), dailySaveNote('memory', true));
  broken.controller.complete(broken.session());
  assert.equal(broken.calls.review.at(-1).scope, '저장하지 못했어요. 이 창을 닫으면 사라져요.');
  assert.equal(broken.controller.refreshHome().kind, 'done');

  const memoryOnly = harness({ persistent: false });
  memoryOnly.controller.open();
  assert.match(memoryOnly.calls.play[0].view.exitNote, /저장하지 못하고 있어요/);
  assert.equal(answer(memoryOnly, 0), '저장하지 못했어요 · 이 창을 닫으면 사라져요');
});

test('흐름: 오늘의 퀴즈를 만들 수 없으면 입구가 그렇다고 말하고 다시 불러오기를 권한다', () => {
  const h = harness({ banks: { ...realBanks, art: [] } });
  assert.equal(h.controller.refreshHome().kind, 'unavailable');
  h.controller.open();
  assert.equal(h.calls.play.length, 0);
  assert.match(h.calls.unavailable[0], /다시 불러오면 다시 시도해요/);
  assert.equal(dailyStatusText({ kind: 'unavailable', dateKey: '2026-11-25' }), '지금은 열 수 없어요');
});

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
