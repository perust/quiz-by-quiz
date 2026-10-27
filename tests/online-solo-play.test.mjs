import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 혼자 푸는 온라인 판 (PRD FR-7.13 3단계, 소유자 방향: 혼자 하기를 없애고 혼자서도 온라인에서 푼다).
// - 홈의 분야 칸·전체 도전이 대기실 없이 곧바로 혼자 온라인 판을 연다(POST /v1/solo). 이 기능은 세션 응답의
//   `soloPlay: true`로만 안다 — 모르는 이전 API에는 요청을 보내지 않고 홈은 예전 혼자 하기(로컬)를 연다.
// - 서버에 닿지 않으면(연결 실패·시간 초과·5xx) 홈은 연습(기록 안 남음)을 연다 — PRD 10.2 #1의 기본값.
// - 혼자 온라인 판의 문항 시간은 설정의 20초·40초이고 «제한 없음»은 연습에만 — PRD 10.2 #2의 기본값.
// - 별 점수·결과의 최고 기록 비교는 서버의 내 기록(주인 열쇠), 기록 내보내기도 서버 기록이다.

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const identity = {
  id: '12345678-1234-5678-9234-567812345678',
  secret: 'browser-session-secret-with-thirty-two-chars',
};
const MATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = { playerId: identity.id, minPlayers: 1, standingAnswers: true, rankings: true, soloPlay: true };

function soloRoom(changes = {}) {
  return {
    code: 'SQL234',
    name: '혼자 하기',
    categoryId: 'science',
    capacity: 2,
    gameMode: true,
    questionTimeMs: 40000,
    players: [{ id: identity.id, nickname: '퀴즈왕', characterId: 'slime-blue', isReady: false, connected: true }],
    isPublic: true,
    hasPassword: false,
    isMine: true,
    joined: true,
    createdAt: '2026-10-28T00:00:00+00:00',
    status: 'playing',
    inMatch: true,
    minPlayers: 1,
    solo: true,
    ...changes,
  };
}

function bestBoards(changes = {}) {
  return {
    boards: {
      all: null,
      history: null,
      science: { score: 80, correctCount: 8, totalCount: 10, recordedAt: '2026-10-27T01:00:00+00:00' },
      geography: null,
      general: null,
      art: null,
      ...changes,
    },
  };
}

async function storeWith(handler) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const requests = [];
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    newIdentity: () => identity,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({
        method: init.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init.body ? JSON.parse(init.body) : null,
      });
      return handler(url, init);
    },
    webSocketFactory: () => { throw new Error('no socket in this test'); },
  });
  return { store, requests };
}

// ── 저장소 ─────────────────────────────────────────────────────────────

test('이 기능을 모르는 API에는 혼자 판·내 기록 요청을 보내지 않는다 — 세션이 soloPlay를 알리지 않으면 unsupported', async () => {
  const { store, requests } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json({ playerId: identity.id, minPlayers: 1, standingAnswers: true, rankings: true });
    throw new Error(`unexpected request: ${url}`);
  });

  assert.deepEqual(await store.startSolo({ categoryId: 'history', questionTimeMs: 20000 }), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await store.getMyBestScores(), { supported: false });
  assert.deepEqual(await store.getMyOnlineRecords(), { supported: false });
  assert.equal(store.onlineRules().soloPlay, false);
  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), ['PUT /v1/session']);
});

test('혼자 판: 분야와 문항 시간만 보내고, 내 혼자 방(solo)을 받아 그 판을 연다', async () => {
  const { store, requests } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json(SESSION);
    if (url.pathname === '/v1/solo') return json({ room: soloRoom(), match: null, resumed: true }, 201);
    throw new Error(`unexpected request: ${url}`);
  });

  const started = await store.startSolo({ categoryId: 'science', questionTimeMs: 40000 });
  assert.equal(started.ok, true);
  assert.equal(started.resumed, true);
  assert.equal(started.room.code, 'SQL234');
  assert.equal(started.room.solo, true);
  const post = requests.find(({ path }) => path === '/v1/solo');
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { categoryId: 'science', questionTimeMs: 40000 }, '정원·비밀번호·점수 같은 다른 칸은 없다');

  await assert.rejects(store.startSolo({ categoryId: 'science', questionTimeMs: null }), /문항 시간/, '«제한 없음»은 온라인 판에 보내지 않는다');
  await assert.rejects(store.startSolo({ categoryId: 'music', questionTimeMs: 20000 }), /분야/);
});

test('혼자 판 응답이 혼자 방이 아니거나 내가 들어간 방이 아니면 믿지 않는다', async () => {
  for (const room of [soloRoom({ solo: undefined }), soloRoom({ solo: false }), soloRoom({ joined: false, isMine: false })]) {
    const { store } = await storeWith((url) => {
      if (url.pathname === '/v1/session') return json(SESSION);
      return json({ room, match: null, resumed: false }, 201);
    });
    await assert.rejects(store.startSolo({ categoryId: 'science', questionTimeMs: 20000 }), /혼자 판 방/);
  }
});

test('방 snapshot의 solo는 true만 믿는다 — 친구와 푸는 방·이전 API의 방에는 없다', async () => {
  const { store } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json(SESSION);
    if (url.pathname === '/v1/rooms') {
      const { solo, ...regular } = soloRoom({ code: 'ABC234', name: '친구 방', status: 'waiting', inMatch: false });
      return json([soloRoom(), { ...regular, solo: 'yes' }]);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const rooms = await store.listRooms();
  assert.equal(rooms[0].solo, true);
  assert.equal(rooms[1].solo, undefined);
  // 홈의 «풀던 혼자 판» 줄은 내 방 목록으로 찾는다
  assert.deepEqual((await store.myRooms()).map(({ code }) => code), ['SQL234', 'ABC234']);
});

test('내 최고 기록: 판마다 받고, 결과 화면은 방금 닫힌 판을 빼고 묻는다 — 판이 빠진 응답은 믿지 않는다', async () => {
  const { store, requests } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json(SESSION);
    if (url.pathname === '/v1/rankings/mine') return json(bestBoards());
    throw new Error(`unexpected request: ${url}`);
  });

  const best = await store.getMyBestScores();
  assert.equal(best.supported, true);
  assert.deepEqual(best.best.science, { score: 80, correctCount: 8, totalCount: 10, recordedAt: '2026-10-27T01:00:00+00:00' });
  assert.equal(best.best.history, null);
  await store.getMyBestScores({ excludeMatchId: MATCH_ID });
  const reads = requests.filter(({ path }) => path === '/v1/rankings/mine');
  assert.deepEqual(reads.map(({ query }) => query), [{}, { excludeMatch: MATCH_ID }]);
  assert.ok(reads.every(({ method }) => method === 'GET'), '읽기만 한다');
  await assert.rejects(store.getMyBestScores({ excludeMatchId: 'not-a-uuid' }), /식별자/);

  const { store: broken } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json(SESSION);
    const { boards } = bestBoards();
    delete boards.art;
    return json({ boards });
  });
  await assert.rejects(broken.getMyBestScores(), /판이 빠졌/);
});

test('내 기록 내보내기: 공개 칸만 받고 신분 같은 다른 칸이 섞이면 믿지 않는다', async () => {
  const record = {
    mode: 'category', categoryId: 'science', score: 80, correctCount: 8, totalCount: 10,
    questionTimeMs: 40000, nickname: '퀴즈왕', recordedAt: '2026-10-27T01:00:00+00:00',
  };
  const { store } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json(SESSION);
    if (url.pathname === '/v1/rankings/mine/records') {
      return json({ records: [record, { ...record, mode: 'all', categoryId: null, totalCount: 25, score: 200, correctCount: 20 }], limit: 500, truncated: true });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const result = await store.getMyOnlineRecords();
  assert.equal(result.supported, true);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, 500);
  assert.deepEqual(result.records[0].target, { mode: 'category', category: 'science' });
  assert.deepEqual(result.records[1].target, { mode: 'all', category: null });

  const { store: leaky } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json(SESSION);
    return json({ records: [{ ...record, playerId: identity.id }], limit: 500, truncated: false });
  });
  await assert.rejects(leaky.getMyOnlineRecords(), /모르는 필드/);
});

test('로컬 방(서버 없이 연 화면)에는 혼자 온라인 판도 서버 기록도 없다', async () => {
  globalThis.window = { localStorage: memoryStorage() };
  const { localRooms } = await import('../js/online/local-rooms.js?solo-play');
  assert.deepEqual(await localRooms.startSolo({ categoryId: null, questionTimeMs: 20000 }), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await localRooms.getMyBestScores(), { supported: false });
  assert.deepEqual(await localRooms.getMyOnlineRecords(), { supported: false });
  assert.equal(localRooms.onlineRules().soloPlay, false);
});

// ── 두 소유자 결정의 기본값 (PRD 10.2) ─────────────────────────────────

test('결정 #2: 혼자 온라인 판은 설정의 20초·40초, «제한 없음»(과 목록 밖의 값)은 20초다', async () => {
  const { soloQuestionTime } = await import('../js/online/solo-play.js');
  assert.equal(soloQuestionTime(20000), 20000);
  assert.equal(soloQuestionTime(40000), 40000);
  assert.equal(soloQuestionTime(null), 20000);
  assert.equal(soloQuestionTime(30000), 20000);
});

test('결정 #1: 서버에 닿지 않으면 연습이고, 서버가 거절한 것·닉네임은 닿은 것이다', async () => {
  const { probeResult, isServerUnreachable, OFFLINE_PRACTICE } = await import('../js/online/solo-play.js');
  const { ApiFailure, NicknameRejected, OnlinePlayerError } = await import('../js/online/rules.js');
  assert.equal(OFFLINE_PRACTICE, true, '기본값은 연습(기록 안 남음)을 연다');

  assert.deepEqual(probeResult({ supported: true }), { mode: 'online' });
  assert.deepEqual(probeResult({ supported: false }), { mode: 'local' }, '모르는 이전 API는 예전 혼자 하기다');
  // 연결 실패(fetch의 TypeError)·시간 초과·5xx(DB·migration을 기다리는 API 포함)·읽을 수 없는 응답
  for (const error of [
    new TypeError('Failed to fetch'),
    new OnlinePlayerError('응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.'),
    new ApiFailure(503, 'migration-required', '잠시 후'),
    new ApiFailure(500, 'request-failed', '잠시 후'),
    new Error('온라인 서버가 JSON이 아닌 응답을 보냈습니다. (502)'),
  ]) {
    assert.equal(isServerUnreachable(error), true, String(error));
    assert.deepEqual(probeResult({ error }), { mode: 'practice', reason: 'offline' });
  }
  assert.deepEqual(probeResult({ error: new NicknameRejected('nickname-profanity') }), { mode: 'practice', reason: 'nickname' });
  const limited = probeResult({ error: new ApiFailure(429, 'rate-limited', '판은 잠시 뒤 다시 열 수 있어요.') });
  assert.deepEqual(limited, { mode: 'unchanged', message: '판은 잠시 뒤 다시 열 수 있어요.' }, '요청 한도는 연습으로 돌리지 않는다');
});

test('연습 안내 줄은 까닭을 말하고 다시 연결할 길을 준다 — 물러서며 다시 묻는다(30초 → 1분 → 2분)', async () => {
  const { practiceNote, practiceRetryDelay } = await import('../js/online/solo-play.js');
  assert.deepEqual(practiceNote('offline'), { text: '온라인에 연결할 수 없어 연습(기록 안 남음)만 할 수 있어요', action: '다시 연결' });
  assert.equal(practiceNote('nickname').action, '다시 확인');
  assert.equal(practiceNote('no-server'), null, '서버 없이 연 화면은 줄 없이 캡션만 말한다');
  assert.match(practiceNote('offline', false).text, /^온라인에 연결할 수 없어요/, '연습을 열지 않는 다른 길이면 연습을 권하지 않는다');
  assert.deepEqual([0, 1, 2, 3, 9].map(practiceRetryDelay), [30000, 60000, 120000, 120000, 120000]);
});

// ── 화면의 말 ───────────────────────────────────────────────────────────

test('홈: 연습이면 분야 칸·캡션·전체 도전이 그렇다고 말하고 별 점수를 두지 않는다', async () => {
  const home = await source('../src/ui/home.ts');
  assert.match(home, /if \(practice\) return `\$\{category\.name\} 연습하기, 기록 안 남음`;/);
  assert.match(home, /return practice \? `연습 · \$\{categoryDockCaption\(\)\} · 기록 안 남음` : categoryDockCaption\(\);/);
  assert.match(home, /el\.startAllMeta\.textContent = '연습';/);
  assert.match(home, /if \(bestScore === null \|\| bestScore === undefined \|\| play\.practice\) return;/, '연습이면 별 점수가 없다');
  // 서버의 내 최고 기록은 홈을 그린 뒤에 온다 — 칸을 다시 만들지 않고 제자리에서 고친다
  assert.match(home, /setBestScores\(scores\) \{\s*bestScores = scores;\s*refreshCards\(\);/);
  // 분야 칸이 혼자 판을 열면 온라인 입구는 친구와 함께 푸는 곳이다
  const rules = await source('../src/online/rules.ts');
  assert.match(rules, /SOLO_ONLINE_ENTRY = \{ desc: '친구와 함께 풀기', label: '온라인, 친구와 함께 풀기' \}/);
});

test('홈의 dock 줄 하나가 복귀 줄·풀던 혼자 판·연습 안내를 나눠 쓴다 — 연습 안내가 먼저다', async () => {
  const home = await source('../src/ui/home.ts');
  const html = await source('../index.html');
  assert.match(html, /<span class="home-room-note__action" id="home-room-note-action">돌아가기<\/span>/);
  assert.match(home, /el\.roomNote\.dataset\.kind = note \? 'practice' : 'room';/);
  assert.match(home, /el\.roomNoteAction\.textContent = roomNote\?\.solo \? '이어 풀기' : '돌아가기';/);
  assert.match(home, /if \(play\.note\) \{\s*onRetryOnline\(\);\s*return;\s*\}\s*if \(roomNote\) onReturnToRoom\(roomNote\.code, roomNote\.solo === true\);/);
});

test('결과: 연습 판은 기록하지 않는다 — 등록 칸·랭킹으로 가는 길·자동 저장이 없고 최고 기록과 견주지 않는다', async () => {
  const result = await source('../src/ui/result.ts');
  const html = await source('../index.html');
  assert.match(html, /<div class="result-block" id="result-register-block">/);
  assert.match(result, /el\.registerBlock\.hidden = practice;\s*el\.rankingButton\.hidden = practice;/);
  assert.match(result, /registered = practice;/, '떠나는 길·pagehide의 flush가 저장을 부르지 않는다');
  assert.match(result, /PRACTICE_RESULT_NOTE = '연습 판이라 점수가 기록되지 않아요\.'/);

  const app = await source('../src/app.ts');
  const practiceBranch = app.slice(app.indexOf('    if (lastRoundPractice) {'), app.indexOf('    // 최고 점수는 이번 기록을 저장하기 전에'));
  assert.ok(practiceBranch.length > 0);
  assert.doesNotMatch(practiceBranch, /rankingStore|getBestScore|registerRecord/);
  assert.match(practiceBranch, /pending = null;/);
  assert.match(practiceBranch, /practice: true,/);
});

test('최고 기록 비교는 로컬 결과와 혼자 푼 온라인 판이 같은 말이다 (FR-5.7)', async () => {
  const { bestComparisonText } = await import('../js/ui/best-score.js');
  assert.deepEqual(bestComparisonText(50, null), { text: '첫 기록이에요.', isNew: true });
  assert.deepEqual(bestComparisonText(90, 80), { text: '신기록 · 이전 최고 80점', isNew: true });
  assert.deepEqual(bestComparisonText(80, 80), { text: '최고 기록과 같은 80점', isNew: false });
  assert.deepEqual(bestComparisonText(70, 80), { text: '최고 기록 80점', isNew: false });

  const online = await source('../src/ui/online-result.ts');
  assert.match(online, /setBest\(matchId, previous\) \{\s*if \(matchId !== shownMatchId \|\| shownScore === null \|\| previous === undefined\) return;/, '늦게 온 값이 다음 판을 고치지 않고, 못 읽었으면 줄을 두지 않는다');
  assert.match(online, /el\.room\.hidden = solo;/, '혼자 판은 돌아갈 대기실이 없다');
  const html = await source('../index.html');
  assert.match(html, /<p class="result-best online-final__best" id="online-final-best" hidden><\/p>/);
});

test('온라인 퀴즈: 혼자 판은 채팅과 혼자인 점수판을 거두고, 채팅이 맡던 아래 비움을 화면이 이어 받는다', async () => {
  const quiz = await source('../src/ui/online-quiz.ts');
  const html = await source('../index.html');
  const css = await source('../css/style.css');
  assert.match(html, /<section class="online-quiz-chat" id="online-quiz-chat" aria-labelledby="online-chat-title">/);
  assert.match(quiz, /setSolo\(next\) \{\s*solo = next;[\s\S]*?el\.chatSection\.hidden = next;\s*el\.screen\.dataset\.solo = String\(next\);/);
  assert.match(quiz, /if \(solo\) \{\s*standingsKey = null;\s*el\.standings\.hidden = true;/);
  assert.match(quiz, /if \(el\.chatSection\.hidden\) return;/, '`/`는 거둔 채팅칸으로 가지 않는다');
  assert.match(quiz, /SOLO_EXIT_BODY =\s*'나가도 판은 계속 진행돼요\. 홈의 「이어 풀기」로 돌아올 수 있고, 판이 끝나면 그 점수가 온라인 랭킹에 남아요\.'/);
  assert.match(
    css,
    /@media \(pointer: coarse\) \{[\s\S]*?\[data-screen='online-quiz'\]\[data-solo='true'\] \{\s*padding-bottom: calc\(var\(--walk-stick-size\) \+ var\(--space-4\) \+ var\(--space-2\) \+ env\(safe-area-inset-bottom, 0px\)\);/,
  );
});

test('설정·게임 방법: 혼자 온라인 판의 문항 시간과 기록이 어디에 남는지 말한다 (PRD 10.2 #2)', async () => {
  const settings = await source('../src/ui/settings-dialog.ts');
  assert.match(settings, /«제한 없음»은 연습\(기록 안 남음\)에만 적용되고 온라인 판은 20초예요/);
  const { soloTimeRule, ONLINE_RECORD_RULE, PRACTICE_RECORD_RULE, RECORD_RULE } = await import('../js/ui/round-rules.js');
  assert.equal(soloTimeRule(40000), '문항당 40초 · 설정에서 바꿀 수 있어요');
  assert.equal(soloTimeRule(null), '문항당 20초 · 설정의 «제한 없음»은 연습에만 적용돼요');
  assert.equal(ONLINE_RECORD_RULE, '끝까지 푼 판은 온라인 랭킹에 남아요');
  assert.equal(PRACTICE_RECORD_RULE, '연습 판은 기록이 남지 않아요');
  assert.equal(RECORD_RULE, '이 브라우저에만 저장돼요', '모르는 API의 예전 말은 그대로다');
});

test('랭킹: 혼자 하기가 온라인으로 옮기면 이 브라우저의 기록은 «예전 기록»(읽기만)이고 내보내기는 서버 기록이다', async () => {
  const ranking = await source('../src/ui/ranking.ts');
  assert.match(ranking, /LEGACY_LOCAL_SCOPE_LABEL = '이 브라우저의 예전 기록'/);
  assert.match(ranking, /el\.scopeLocal\.textContent = legacy \? LEGACY_LOCAL_SCOPE_LABEL : LOCAL_SCOPE_LABEL;/);
  // 예전 기록은 새 판을 권하지 않는다(읽기만) — 기록이 남는 온라인 랭킹으로 잇는다. 지우기·내보내기는 그대로다
  assert.match(ranking, /emptyAction = 'scope-online';\s*el\.emptyMessage\.textContent = `이 브라우저에 남은 예전 \$\{tab\.label\} 기록이 없어요\.`;/);
  // 빈 온라인 랭킹은 그 탭의 혼자 판을 곧바로 연다 (FR-6.12)
  assert.match(ranking, /board\.entries\.length === 0 && onlineOnly\(\)[\s\S]*?el\.emptyStartButton\.textContent = emptyAction === 'start' \? `\$\{tab\.label\} 시작하기` : '홈으로';/);
  assert.match(ranking, /el\.exportBlock\.hidden = !\(onlineOnly\(\) && online\.exportRecords\);/);
  assert.match(ranking, /const fromServer = activeScope\(\) === 'online' && online\?\.exportRecords;/);
});

test('온라인 기록 파일은 이 브라우저의 기록 파일과 같은 모양이다 — 서버에 없는 소요 시간·문항별 정오를 지어내지 않는다', async () => {
  const { buildOnlineRecordsExport, RECORDS_EXPORT_VERSION } = await import('../js/core/records-export.js');
  const now = new Date('2026-10-28T01:02:03.000Z');
  const file = buildOnlineRecordsExport({
    records: [
      { mode: 'all', category: null, score: 200, correctCount: 20, totalCount: 25, questionTimeMs: 20000, nickname: '익명', recordedAt: '2026-10-27T09:00:00+00:00' },
      { mode: 'category', category: 'science', score: 80, correctCount: 8, totalCount: 10, questionTimeMs: 40000, nickname: '김민준', recordedAt: '2026-10-26T09:00:00+00:00' },
    ],
    nickname: '김민준',
    now,
    limit: 500,
    truncated: true,
  });
  const fixture = JSON.parse(await source('./fixtures/records-export-online.json'));
  assert.deepEqual(file, fixture, 'tests/fixtures/records-export-online.json 과 같다 (test_guidance.py가 로더로 읽는다)');
  assert.equal(file.schemaVersion, RECORDS_EXPORT_VERSION);
  assert.deepEqual(Object.keys(file), ['app', 'kind', 'schemaVersion', 'exportedAt', 'nickname', 'scope', 'records']);
  assert.ok(file.records.every((record) => !('durationMs' in record) && !('questionResults' in record) && record.source === 'online'));
  assert.equal(file.records[0].category, 'science', '오래된 판부터');
  assert.equal(file.records[0].timeLimitMs, 40000);
  assert.ok(!('timeLimitMs' in file.records[1]), '기본(20초) 판에는 남기지 않는다');
  assert.match(file.scope, /최근 500개만 담았어요\.$/);
});

// ── app.ts: 흐름 ────────────────────────────────────────────────────────

test('app: 홈의 분야 칸은 지금의 판 종류로 연다 — 묻는 중이면 기다리고, 혼자 온라인 판·연습·예전 혼자 하기', async () => {
  const app = await source('../src/app.ts');
  assert.match(app, /onSelectCategory: \(categoryId\) => playRound\(\{ mode: 'category', categoryId \}\),/);
  assert.match(app, /onStartAll: \(\) => playRound\(\{ mode: 'all', categoryId: null \}\),/);
  const play = app.slice(app.indexOf('  async function playRound('), app.indexOf('  async function startSoloOnline('));
  assert.match(play, /if \(playMode === 'checking'\) await probePlayMode\(\{ busy: true \}\);/);
  assert.match(play, /if \(playMode === 'online'\) \{\s*await startSoloOnline\(round\);/);
  assert.match(play, /await startRound\(round, undefined, \{ practice: true \}\);/);
  assert.match(play, /if \(playMode === 'local'\) \{\s*await startRound\(round\);/);

  const solo = app.slice(app.indexOf('  async function startSoloOnline('), app.indexOf('  async function resumeSolo('));
  assert.match(solo, /questionTimeMs: soloQuestionTime\(timeLimitMs\),/, '설정의 문항 시간 — «제한 없음»이면 20초 (PRD 10.2 #2)');
  assert.match(solo, /if \(probe\.mode === 'practice'\) \{\s*setPlayMode\('practice', probe\.reason\);/, '서버에 닿지 않으면 홈이 연습을 연다 (PRD 10.2 #1)');
  assert.match(solo, /homeRoomNote\.enter\(code\);/, '새로고침한 뒤의 홈이 «이어 풀기»를 묻는다');
  assert.doesNotMatch(solo, /openWaitingRoom|activeRoomCode = /, '대기실을 거치지 않는다');
  assert.match(solo, /await openOnlineMatch\(code, \{/);
});

test('app: 혼자 판의 나가기·결과·«뒤로»는 오늘의 온라인 규칙을 따르고 홈으로 돌아간다', async () => {
  const app = await source('../src/app.ts');
  // 매치는 서버에서 계속된다 — 나가면 홈, 홈의 «이어 풀기»로 돌아온다
  assert.match(app, /if \(code !== null && code === soloRoomCode\) \{\s*void goHome\(\);\s*return;\s*\}/);
  // 결과: «다시 하기»는 같은 혼자 방의 새 판, «홈으로»는 방을 나가 지운다. 방 소켓을 붙들지 않는다
  const final = app.slice(app.indexOf('  function showOnlineFinal('), app.indexOf('  async function showSoloBest('));
  assert.match(final, /onlineResultScreen\.show\(snapshot, \{ inRoom: true, solo: true \}\);\s*goTo\('online-result'\);\s*if \(snapshot\.rankingRecorded === true\) void showSoloBest\(snapshot\);\s*return;/);
  assert.ok(final.indexOf('return;') < final.indexOf('resultKeepalive.hold'), '혼자 판은 keepalive 앞에서 돌아간다');
  assert.match(app, /onHome: \(\) => \{\s*const solo = soloResult;\s*soloResult = null;\s*if \(solo\) void leaveSoloRoom\(solo\.code\);\s*void goHome\(\);/);
  assert.match(app, /getMyBestScores\(\{ excludeMatchId: snapshot\.matchId \}\)/, '이 판 «전의» 최고 기록과 견준다');
  // 판이 끝난 혼자 방은 홈이 조용히 나간다 — 판이 도는 혼자 방만 «풀던 혼자 판»이다
  assert.match(app, /\} else if \(room\.status === 'playing' && room\.inMatch\) \{\s*kept\.push\(\{ code: room\.code, name: room\.name, solo: true \}\);\s*\} else if \(room\.code !== onlineMatchRoomCode && soloResult\?\.code !== room\.code\) \{\s*void leaveSoloRoom\(room\.code\);/);
  // 판이 없어졌으면 홈에서 그렇다고 말한다
  assert.match(app, /announce\('풀던 혼자 판을 찾지 못했어요\. 다시 골라 시작해 주세요\.'\)/);
  const guard = await source('../src/ui/back-guard.ts');
  assert.match(guard, /'online-result': 'online-final-home',/);
});

test('app: 서버 없이 연 화면은 늘 연습이고 묻지 않는다. 그 밖에는 부팅·홈마다 한 번 묻는다', async () => {
  const app = await source('../src/app.ts');
  assert.match(app, /let playMode: HomePlayMode = roomStore\.isNetworked \? 'checking' : 'practice';/);
  assert.match(app, /let practiceReason: PracticeReason \| null = roomStore\.isNetworked \? null : 'no-server';/);
  assert.match(app, /async function probePlayMode\(\{ busy = false \}: \{ busy\?: boolean \} = \{\}\): Promise<void> \{\s*if \(!roomStore\.isNetworked\) return;/);
  assert.match(app, /setPlayMode\(playMode, practiceReason\);\s*void probePlayMode\(\);\s*\/\/ 문제를 받았고/);
  assert.match(app, /void homeRoomNote\.refresh\(\);[\s\S]{0,200}void probePlayMode\(\);\s*\}/);
  // 혼자 하기가 온라인으로 옮긴 뒤 랭킹의 이 브라우저 기록은 «예전 기록», 내보내기는 서버 기록이다
  assert.match(app, /onlineOnly: \(\) => roomStore\.onlineRules\(\)\?\.soloPlay === true,/);
  assert.match(app, /const result = await roomStore\.getMyOnlineRecords\(\);\s*if \(!result\.supported \|\| result\.records\.length === 0\) return null;/);
});

test('로비: 내 혼자 방은 목록에 그리지 않는다 — 친구와 함께 푸는 곳이다', async () => {
  const online = await source('../src/ui/online.ts');
  assert.match(online, /return \(await roomStore\.listRooms\(\)\)\.filter\(\(room\) => room\.solo !== true\);/);
});
