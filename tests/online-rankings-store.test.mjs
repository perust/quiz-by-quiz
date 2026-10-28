import test from 'node:test';
import assert from 'node:assert/strict';

// 온라인 랭킹 (FR-7.13 2단계)의 저장소 쪽. 서버가 채점한 온라인 판의 기록을 읽기만 한다.
// - 이 API가 랭킹을 아는지는 세션 응답의 `rankings: true`로 안다(OnlineRules처럼 더하기만 한 필드).
//   모르는 이전 API(#106·#107)에는 랭킹 요청을 한 번도 보내지 않고 {supported:false}다 — 화면이 숨긴다.
// - 읽을 때 브라우저 신분을 실어 보내 서버가 내 기록(isMine)을 가린다. 공개 필드 밖의 것은 믿지 않는다.
// - 끝난 판의 `rankingRecorded`는 참·거짓만 믿는다. 없으면 결과 화면이 랭킹 이야기를 하지 않는다.
// - 금칙 규칙에 걸리는 닉네임(규칙 전에 저장한 이름)은 보내지 않고, 서버의 거절도 같은 말로 옮긴다.

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

const WEEK = { start: '2026-10-25T15:00:00+00:00', end: '2026-11-01T15:00:00+00:00', timeZone: 'Asia/Seoul' };

function entry(rank, changes = {}) {
  return {
    rank,
    nickname: `참가자${rank}`,
    characterId: 'slime-blue',
    score: 100 - rank * 10,
    correctCount: 10 - rank,
    totalCount: 10,
    recordedAt: '2026-10-27T03:10:52+00:00',
    isMine: false,
    ...changes,
  };
}

function board(changes = {}) {
  return {
    mode: 'category',
    categoryId: 'history',
    period: 'week',
    window: WEEK,
    limit: 10,
    entries: [entry(1), entry(2, { isMine: true })],
    ...changes,
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
      const headers = new Headers(init.headers);
      requests.push({
        method: init.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init.body ? JSON.parse(init.body) : null,
        authorization: headers.get('Authorization'),
        playerId: headers.get('X-Player-Id'),
      });
      return handler(url, init);
    },
    webSocketFactory: () => { throw new Error('no socket in this test'); },
  });
  return { store, requests };
}

const TARGET = { mode: 'category', category: 'history' };

test('랭킹을 모르는 API에는 랭킹 요청을 보내지 않는다 — 세션이 rankings를 알리지 않으면 supported:false', async () => {
  const { store, requests } = await storeWith((url) => {
    if (url.pathname === '/v1/session') return json({ playerId: identity.id, minPlayers: 1, standingAnswers: true });
    throw new Error(`unexpected request: ${url}`);
  });

  assert.equal(store.onlineRules(), null, '세션을 열기 전에는 모른다');
  assert.deepEqual(await store.getOnlineRankings({ target: TARGET, period: 'week' }), { supported: false });
  assert.equal(store.onlineRules().rankings, false);
  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), ['PUT /v1/session']);

  // 두 번째부터는 세션도 다시 열지 않는다
  assert.deepEqual(await store.getOnlineRankings({ target: TARGET, period: 'all' }), { supported: false });
  assert.equal(requests.length, 1);
});

test('랭킹을 아는 API: 판·기간을 묻고 신분을 실어 보내며, 서버가 가린 내 기록을 그대로 받는다', async () => {
  const { store, requests } = await storeWith((url) => {
    if (url.pathname === '/v1/session') {
      return json({ playerId: identity.id, minPlayers: 1, standingAnswers: true, rankings: true });
    }
    if (url.pathname === '/v1/rankings') {
      const all = url.searchParams.get('mode') === 'all';
      return json(board(all
        ? { mode: 'all', categoryId: null, period: 'all', window: null, entries: [entry(1)] }
        : {}));
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const week = await store.getOnlineRankings({ target: TARGET, period: 'week' });
  assert.equal(week.supported, true);
  assert.deepEqual(week.board, {
    target: TARGET,
    period: 'week',
    window: { start: WEEK.start, end: WEEK.end },
    entries: [entry(1), entry(2, { isMine: true })],
  });
  const overall = await store.getOnlineRankings({ target: { mode: 'all', category: null }, period: 'all' });
  assert.equal(overall.board.window, null);
  assert.deepEqual(overall.board.target, { mode: 'all', category: null });

  const reads = requests.filter(({ path }) => path === '/v1/rankings');
  assert.deepEqual(reads.map(({ query }) => query), [
    { mode: 'category', category: 'history', period: 'week' },
    { mode: 'all', period: 'all' },
  ]);
  for (const read of reads) {
    assert.equal(read.method, 'GET', '읽기만 한다 — 점수를 보고하지 않는다');
    assert.equal(read.playerId, identity.id);
    assert.equal(read.authorization, `Bearer ${identity.secret}`);
  }
});

test('공개 필드 밖의 것·순서가 맞지 않는 순위·물어본 것과 다른 판은 믿지 않는다', async () => {
  const cases = [
    ['신분이 섞인 줄', board({ entries: [entry(1, { playerId: identity.id })] }), /모르는 필드/],
    ['순서와 다른 순위', board({ entries: [entry(2)] }), /순위/],
    ['열한 줄', board({ entries: Array.from({ length: 11 }, (_, index) => entry(index + 1)) }), /목록/],
    ['다른 분야', board({ categoryId: 'science' }), /물어본 판/],
    ['주 없는 이번 주', board({ window: null }), /기간/],
    ['문제 수보다 많은 정답', board({ entries: [entry(1, { correctCount: 11 })] }), /정답 수/],
  ];
  for (const [name, body, pattern] of cases) {
    const { store } = await storeWith((url) => (url.pathname === '/v1/session'
      ? json({ playerId: identity.id, rankings: true })
      : json(body)));
    await assert.rejects(store.getOnlineRankings({ target: TARGET, period: 'week' }), pattern, name);
  }
});

test('끝난 판의 rankingRecorded는 참·거짓만 믿고, 없으면(이전 API) 싣지 않는다', async () => {
  const finished = (changes) => ({
    matchId: '32345678-1234-5678-9234-567812345678',
    state: 'finished',
    categoryId: 'history',
    gameMode: true,
    currentPosition: 10,
    totalQuestions: 10,
    deadlineAt: null,
    question: null,
    ownSubmission: null,
    reveal: null,
    scores: [],
    ...changes,
  });
  for (const [wire, expected] of [
    [{ rankingRecorded: true }, true],
    [{ rankingRecorded: false }, false],
    [{}, undefined],
    [{ rankingRecorded: 'yes' }, undefined],
  ]) {
    const { store } = await storeWith((url) => (url.pathname === '/v1/session'
      ? json({ playerId: identity.id, rankings: true })
      : json(finished(wire))));
    const snapshot = await store.getMatch('ABC234');
    assert.equal(snapshot.rankingRecorded, expected, JSON.stringify(wire));
    assert.equal(Object.hasOwn(snapshot, 'rankingRecorded'), expected !== undefined);
  }
});

test('금칙 규칙에 걸리는 닉네임은 보내지 않고 고칠 곳을 말한다 — 서버의 거절도 같은 말로 옮긴다', async () => {
  const { OnlinePlayerError, isNicknameRejection } = await import('../js/online/rules.js');
  const blocked = await storeWith(() => { throw new Error('nothing may be sent'); });
  blocked.store.setPlayer({ nickname: 'kim@mail', characterId: 'slime-blue' });
  await assert.rejects(blocked.store.listRooms(), (error) => {
    assert.ok(error instanceof OnlinePlayerError);
    // 다시 시도해도 같은 실패라 화면이 알아본다(랭킹의 빈 칸이 「다시 시도」 대신 「홈으로」)
    assert.equal(isNicknameRejection(error), true);
    assert.equal(
      error.message,
      '전화번호·이메일·인터넷 주소처럼 보이는 닉네임은 쓸 수 없어요. 홈에서 닉네임을 바꿔 주세요.',
    );
    return true;
  });
  assert.equal(blocked.requests.length, 0);

  // 화면의 규칙보다 서버가 먼저 바뀌었더라도 서버의 400을 같은 말로 옮긴다
  const refused = await storeWith((url) => (url.pathname === '/v1/session'
    ? json({ detail: { code: 'nickname-profanity', message: '서버의 말' } }, 400)
    : json([])));
  refused.store.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });
  await assert.rejects(refused.store.listRooms(), (error) => {
    assert.equal(error.message, '닉네임에 쓸 수 없는 말이 들어 있어요. 홈에서 닉네임을 바꿔 주세요.');
    assert.equal(isNicknameRejection(error), true);
    return true;
  });
  // 랭킹 읽기도 같은 길이다 — 세션을 열지 않고 고칠 곳을 말한다
  const ranking = await storeWith(() => { throw new Error('nothing may be sent'); });
  ranking.store.setPlayer({ nickname: '010ㅡ1234ㅡ5', characterId: 'slime-blue' });
  await assert.rejects(
    ranking.store.getOnlineRankings({ target: TARGET, period: 'week' }),
    (error) => isNicknameRejection(error),
  );
  assert.equal(ranking.requests.length, 0);
  // 연결 실패나 다른 거절은 닉네임 탓이 아니다
  assert.equal(isNicknameRejection(new Error('Failed to fetch')), false);
  assert.equal(isNicknameRejection(new OnlinePlayerError('응답이 늦어요.')), false);
});

test('로컬 방에는 서버 랭킹이 없다', async () => {
  globalThis.window = { localStorage: memoryStorage() };
  const { localRooms } = await import('../js/online/local-rooms.js?online-rankings');
  assert.deepEqual(await localRooms.getOnlineRankings({ target: TARGET, period: 'week' }), { supported: false });
  assert.equal(localRooms.onlineRules().rankings, false);
});
