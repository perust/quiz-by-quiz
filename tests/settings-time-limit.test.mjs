import test from 'node:test';
import assert from 'node:assert/strict';

// 문항 시간 설정 (FR-3.7, PRD v1.2 / U42).
// 로컬 판은 20초(기본)·40초·제한 없음 가운데 고른다. 제한 없음은 «아주 긴 시간»이 아니라
// 시간 초과로 가는 길이 아예 없는 것이다. 저장된 설정이 목록 밖이면 기본값으로 돌아가고,
// 기록에는 기본이 아닌 판만 문항 시간을 남기되 랭킹은 나누지 않는다 (점수에 속도가 없다).

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

// safe-storage.js 는 불러오는 순간 저장소를 한 번 고른다. 그 전에 메모리 저장소를 깐다
const storage = memoryStorage();
globalThis.window = { localStorage: storage };

const { TIME_LIMIT_CHOICES, TIME_LIMIT_MS } = await import('../js/constants.js');
const { createQuestionTimer } = await import('../js/core/timer.js');
const { createSession } = await import('../js/core/session.js');
const { createLocalPreferences, createLocalRankingStore } = await import('../js/storage/local-store.js');
const { timeLimitLabel } = await import('../js/ui/time-limit.js');

function question(id, answerIndex = 0) {
  return {
    id, category: 'science', question: `${id}?`, choices: ['가', '나', '다', '라'],
    answerIndex, explanation: '해설', difficulty: 'easy', tags: [],
  };
}

test('고를 수 있는 문항 시간은 20초(기본)·40초·제한 없음 셋이다', () => {
  assert.equal(TIME_LIMIT_MS, 20_000);
  assert.deepEqual([...TIME_LIMIT_CHOICES], [20_000, 40_000, null]);
  assert.equal(timeLimitLabel(20_000), '문항당 20초');
  assert.equal(timeLimitLabel(40_000), '문항당 40초');
  assert.equal(timeLimitLabel(null), '시간 제한 없음');
});

test('타이머: 시작 시각 기준 계산은 그대로이고, 제한 없음이면 끝나는 때만 없다 (FR-3.11)', () => {
  let clock = 0;
  const now = () => clock;

  const forty = createQuestionTimer({ limitMs: 40_000, now });
  forty.start();
  clock = 25_000;
  assert.equal(forty.remainingMs(), 15_000);
  assert.equal(forty.isExpired(), false);
  clock = 45_000;
  assert.equal(forty.elapsedMs(), 40_000, '제한 시간을 넘기지 않게 자른다 (FR-5.3)');
  assert.equal(forty.isExpired(), true);

  clock = 0;
  const unlimited = createQuestionTimer({ limitMs: null, now });
  assert.equal(unlimited.limitMs, null);
  unlimited.start();
  clock = 25_000;
  assert.equal(unlimited.remainingMs(), Number.POSITIVE_INFINITY);
  assert.equal(unlimited.isExpired(), false);
  clock = 3_600_000;
  assert.equal(unlimited.isExpired(), false, '한 시간이 지나도 끝나지 않는다');
  assert.equal(unlimited.elapsedMs(), 3_600_000, '소요 시간은 자르지 않고 그대로 잰다');
  unlimited.stop();
  clock = 3_700_000;
  assert.equal(unlimited.elapsedMs(), 3_600_000, '멈춘 뒤에는 흐르지 않는다 (FR-3.8)');

  // 생략하면 기본 20초다. undefined 와 null 은 다르다
  assert.equal(createQuestionTimer({ now }).limitMs, 20_000);
  assert.equal(createQuestionTimer({ limitMs: undefined, now }).limitMs, 20_000);
});

test('세션: 문항 시간은 판을 여는 값이고, 시간 초과는 그 판의 제한 시간으로 센다 (FR-3.7, FR-5.3)', () => {
  const standard = createSession({ questions: [question('q1')] });
  assert.equal(standard.timeLimitMs, 20_000, '생략하면 기본 20초');
  assert.equal(standard.submit({ choiceIndex: null, elapsedMs: 21_500 }).elapsedMs, 20_000);

  const forty = createSession({ questions: [question('q1'), question('q2')], timeLimitMs: 40_000 });
  assert.equal(forty.timeLimitMs, 40_000);
  const late = forty.submit({ choiceIndex: 0, elapsedMs: 35_000 });
  assert.equal(late.elapsedMs, 35_000, '20초를 넘긴 답도 40초 판에서는 그대로다');
  assert.equal(late.timedOut, false);
  forty.goNext();
  const timedOut = forty.submit({ choiceIndex: null, elapsedMs: 41_000 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.elapsedMs, 40_000, '시간 초과는 40초를 다 쓴 것이다');

  const unlimited = createSession({ questions: [question('q1')], timeLimitMs: null });
  assert.equal(unlimited.timeLimitMs, null);
  const slow = unlimited.submit({ choiceIndex: 0, elapsedMs: 95_000 });
  assert.equal(slow.elapsedMs, 95_000, '제한 없음이면 쓴 시간을 자르지 않는다');
  assert.equal(slow.correct, true);
  assert.equal(slow.timedOut, false);

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createSession({ questions: [question('q1')], timeLimitMs: bad }), /문항 시간/);
  }
});

test('설정: 처음에는 20초·움직임 그대로이고, 고른 값은 새로고침 뒤에도 남는다', async () => {
  storage.values.delete('quiz.settings');
  const preferences = createLocalPreferences();
  assert.deepEqual(await preferences.getSettings(), {
    soundEnabled: true, characterId: null, timeLimitMs: 20_000, reduceMotion: false,
  });

  await preferences.setSettings({ timeLimitMs: null });
  await preferences.setSettings({ reduceMotion: true });
  await preferences.setSettings({ soundEnabled: false });
  const saved = JSON.parse(storage.values.get('quiz.settings'));
  assert.equal(saved.timeLimitMs, null, '제한 없음은 null 로 남는다 — 키가 없는 것과 다르다');
  assert.equal('timeLimitMs' in saved, true);

  // 다시 띄운 앱이 같은 저장소를 읽는다
  const reloaded = createLocalPreferences();
  assert.deepEqual(await reloaded.getSettings(), {
    soundEnabled: false, characterId: null, timeLimitMs: null, reduceMotion: true,
  });
  await reloaded.setSettings({ timeLimitMs: 40_000 });
  assert.equal((await reloaded.getSettings()).timeLimitMs, 40_000);
  assert.equal((await reloaded.getSettings()).reduceMotion, true, '하나를 바꿔도 나머지는 그대로다');
});

test('설정: 목록에 없는 문항 시간·잘못된 움직임 값은 기본값으로 돌리고 나머지는 살린다', async () => {
  const preferences = createLocalPreferences();
  const cases = [30_000, '40000', 'none', 0, -20_000, true, {}, []];
  for (const timeLimitMs of cases) {
    storage.values.set('quiz.settings', JSON.stringify({ soundEnabled: false, timeLimitMs, reduceMotion: 'yes' }));
    const settings = await preferences.getSettings();
    assert.equal(settings.timeLimitMs, 20_000, `${JSON.stringify(timeLimitMs)} → 기본 20초`);
    assert.equal(settings.reduceMotion, false, '불리언이 아니면 꺼진 것으로 본다');
    assert.equal(settings.soundEnabled, false, '깨진 값 하나 때문에 다른 설정을 잃지 않는다');
  }
  storage.values.set('quiz.settings', JSON.stringify({ soundEnabled: true }));
  assert.equal((await preferences.getSettings()).timeLimitMs, 20_000, '예전 설정(키 없음)은 20초 판이다');
  storage.values.set('quiz.settings', '{깨짐');
  assert.equal((await preferences.getSettings()).timeLimitMs, 20_000);
  // 스키마 버전은 그대로다 — 올리면 ensureSchemaVersion 이 랭킹을 통째로 비운다
  assert.equal(storage.values.get('quiz.schemaVersion'), '1');
});

test('기록: 기본이 아닌 판만 문항 시간을 남기고, 랭킹은 나누지 않는다', async () => {
  storage.values.clear();
  storage.values.set('quiz.schemaVersion', '1');
  const store = createLocalRankingStore();
  const base = {
    nickname: '퀴즈왕', mode: 'category', category: 'science', correctCount: 5, totalCount: 10, durationMs: 1000,
  };
  const forty = await store.saveRecord({ ...base, score: 80, playedAt: '2026-10-27T01:00:00.000Z', timeLimitMs: 40_000 });
  const unlimited = await store.saveRecord({ ...base, score: 70, playedAt: '2026-10-27T02:00:00.000Z', timeLimitMs: null });
  const standard = await store.saveRecord({ ...base, score: 90, playedAt: '2026-10-27T03:00:00.000Z', timeLimitMs: 20_000 });
  const unknown = await store.saveRecord({ ...base, score: 60, playedAt: '2026-10-27T04:00:00.000Z', timeLimitMs: 30_000 });
  const legacy = await store.saveRecord({ ...base, score: 50, playedAt: '2026-10-27T05:00:00.000Z' });

  assert.equal(forty.record.timeLimitMs, 40_000);
  assert.equal(unlimited.record.timeLimitMs, null);
  assert.equal('timeLimitMs' in standard.record, false, '기본 20초는 키를 남기지 않는다');
  assert.equal('timeLimitMs' in unknown.record, false, '목록 밖의 값은 남기지 않는다');
  assert.equal('timeLimitMs' in legacy.record, false);

  const stored = JSON.parse(storage.values.get('quiz.rankings'));
  assert.equal(stored.find((record) => record.score === 70).timeLimitMs, null, '제한 없음은 null 로 저장된다');

  // 한 랭킹에 함께 쌓이고 점수로만 줄을 세운다 (FR-6.3)
  const ranking = await store.getRankings({ mode: 'category', category: 'science' });
  assert.deepEqual(ranking.map((record) => record.score), [90, 80, 70, 60, 50]);
  assert.equal(await store.getBestScore({ mode: 'category', category: 'science' }), 90);
});
