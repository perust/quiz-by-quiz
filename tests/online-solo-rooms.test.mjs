import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 혼자 여는 온라인 방. 혼자 하고 싶은 사람도 온라인 방을 만들어 푼다(소유자 방향: 언젠가 혼자 하기를
// 온라인 방 하나로 모은다). 서버 `start_game`·로컬 `startGame`·화면 `waitingRoomControls`가 같은 규칙이다 —
// 세는 사람(방장 + 연결된 참가자)이 `minPlayers` 이상이고 방장 말고 모두 준비. 화면(Pages)이 API보다 먼저
// 나갈 수 있어 `minPlayers`를 보내지 않는 이전 API는 예전처럼 둘부터로 읽는다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

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

function wireRoom(changes = {}) {
  return {
    code: 'ABC234',
    name: '혼자 하는 방',
    categoryId: 'history',
    capacity: 4,
    gameMode: true,
    players: [{
      id: identity.id, nickname: '퀴즈왕', characterId: 'slime-blue', isReady: false, connected: true,
    }],
    isPublic: true,
    hasPassword: false,
    isMine: true,
    joined: true,
    createdAt: '2026-10-27T00:00:00+00:00',
    status: 'waiting',
    ...changes,
  };
}

async function storeWith({ session, rooms }) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  return createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    newIdentity: () => identity,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/session')) return json(session);
      if (url.endsWith('/v1/rooms')) return json(rooms);
      throw new Error(`unexpected request: ${url}`);
    },
    webSocketFactory: () => { throw new Error('no socket in this test'); },
  });
}

function player(id, { isReady = false, connected = true } = {}) {
  return { id, nickname: id === 'host' ? '방장' : id, characterId: 'slime-blue', isReady, connected };
}

function room(players, changes = {}) {
  return {
    code: 'ABC234',
    name: '혼자 하는 방',
    categoryId: null,
    capacity: 4,
    gameMode: true,
    players,
    isPublic: true,
    hasPassword: false,
    isMine: true,
    joined: true,
    createdAt: '2026-10-27T00:00:00.000Z',
    ...changes,
  };
}

test('방 snapshot의 minPlayers: 새 API는 1, 보내지 않는 이전 API는 2, 정원 밖이면 믿지 않는다', async () => {
  const fresh = await storeWith({
    session: { playerId: identity.id, minPlayers: 1, standingAnswers: true },
    rooms: [wireRoom({ minPlayers: 1 })],
  });
  assert.equal((await fresh.listRooms())[0].minPlayers, 1);

  const legacy = await storeWith({ session: { playerId: identity.id }, rooms: [wireRoom()] });
  assert.equal((await legacy.listRooms())[0].minPlayers, 2, '필드가 없으면 이전 API의 둘부터');

  for (const minPlayers of [0, 5, 1.5, '1', null]) {
    const broken = await storeWith({ session: { playerId: identity.id }, rooms: [wireRoom({ minPlayers })] });
    await assert.rejects(broken.listRooms(), /시작 인원/, String(minPlayers));
  }
});

test('세션 응답이 방 snapshot 없는 화면의 규칙을 알려 준다 — 묻기 전에는 null, 이전 API는 둘부터·직접 낸 답만', async () => {
  const fresh = await storeWith({
    session: { playerId: identity.id, minPlayers: 1, standingAnswers: true },
    rooms: [],
  });
  assert.equal(fresh.onlineRules(), null, '세션을 열기 전에는 모른다');
  await fresh.listRooms();
  // 세션이 `rankings`를 알리지 않는 API(#106·#107)는 서버 랭킹이 없다 — 화면이 온라인 랭킹을 숨긴다 (FR-7.13 2단계)
  // `soloPlay`(혼자 푸는 온라인 판, FR-7.13 3단계)도 알리지 않는다 — 홈은 예전 혼자 하기를 연다
  assert.deepEqual(fresh.onlineRules(), { minPlayers: 1, standingAnswers: true, rankings: false, soloPlay: false });

  const legacy = await storeWith({ session: { playerId: identity.id }, rooms: [] });
  await legacy.listRooms();
  assert.deepEqual(legacy.onlineRules(), { minPlayers: 2, standingAnswers: false, rankings: false, soloPlay: false });

  const odd = await storeWith({ session: { playerId: identity.id, minPlayers: 'x', standingAnswers: 'yes' }, rooms: [] });
  await odd.listRooms();
  assert.deepEqual(odd.onlineRules(), { minPlayers: 2, standingAnswers: false, rankings: false, soloPlay: false }, '깨진 값은 이전 규칙으로 읽는다');
});

test('방장 혼자: 새 API(minPlayers 1)면 「게임 시작」이 켜지고, 이전 API의 방은 예전처럼 잠근다', async () => {
  const { waitingRoomControls } = await import('../js/ui/waiting-room-action.js');
  const host = player('host');

  assert.equal(waitingRoomControls(room([host], { minPlayers: 1 }), 'host').startDisabled, false);
  assert.equal(waitingRoomControls(room([host]), 'host').startDisabled, true, '필드가 없으면 둘부터');
  assert.equal(waitingRoomControls(room([host], { minPlayers: 2 }), 'host').startDisabled, true);
  // 혼자서도 연다고 해서 연결된 참가자의 준비를 건너뛰지 않는다
  assert.equal(
    waitingRoomControls(room([host, player('guest')], { minPlayers: 1 }), 'host').startDisabled,
    true,
  );
  assert.equal(
    waitingRoomControls(room([host, player('guest', { isReady: true })], { minPlayers: 1 }), 'host').startDisabled,
    false,
  );
  // 끊긴 참가자는 기다리지 않는다 — 방장만 남아도 연다
  assert.equal(
    waitingRoomControls(room([host, player('gone', { connected: false })], { minPlayers: 1 }), 'host').startDisabled,
    false,
  );
  // 판이 도는 동안은 여전히 시작하지 않는다
  assert.equal(
    waitingRoomControls(room([host], { minPlayers: 1, status: 'playing', inMatch: false }), 'host').startDisabled,
    true,
  );
});

test('방장 혼자인 상태 줄은 혼자서도 시작할 수 있다고 말한다 — 이전 API의 방은 «최소 2명»이다', async () => {
  const { waitingRoomStartStatus } = await import('../js/ui/waiting-room-action.js');
  const host = player('host');

  assert.equal(
    waitingRoomStartStatus(room([host], { minPlayers: 1 }), 'host'),
    '혼자서도 시작할 수 있어요. 초대 링크로 친구를 불러도 돼요.',
  );
  assert.equal(
    waitingRoomStartStatus(room([host], { minPlayers: 1 }), 'host', { canInvite: false }),
    '혼자서도 시작할 수 있어요.',
  );
  assert.equal(
    waitingRoomStartStatus(room([host, { ...player('gone', { connected: false }), nickname: '민수' }], { minPlayers: 1 }), 'host'),
    '민수 님은 연결이 끊겨 이번 판에서 빠져요. 혼자서도 시작할 수 있어요.',
  );
  // 둘 이상이면 예전처럼 준비를 센다
  assert.equal(
    waitingRoomStartStatus(room([host, { ...player('a'), nickname: '지아' }], { minPlayers: 1 }), 'host'),
    '준비 1/2명 · 지아 님 기다리는 중',
  );
  assert.equal(waitingRoomStartStatus(room([host]), 'host'), '최소 2명이 필요해요. 초대 링크로 친구를 불러 보세요.');
});

test('로컬 방도 같은 규칙이다 — 방장 혼자서도 열고, 초안을 보낼 서버가 없다', async () => {
  globalThis.window = { localStorage: memoryStorage() };
  const { localRooms } = await import('../js/online/local-rooms.js?solo-rooms');
  // 이 브라우저 안의 방에는 서버 랭킹이 없다
  assert.deepEqual(localRooms.onlineRules(), { minPlayers: 1, standingAnswers: true, rankings: false, soloPlay: false });
  const created = await localRooms.createRoom({
    name: '혼자 연습방',
    categoryId: 'history',
    capacity: 4,
    questionTimeMs: 20_000,
    isPublic: true,
    player: { nickname: '방장', characterId: 'slime-blue' },
  });
  assert.equal(created.ok, true);
  assert.equal(created.room.minPlayers, 1);
  const { waitingRoomControls } = await import('../js/ui/waiting-room-action.js');
  assert.equal(waitingRoomControls(created.room, localRooms.me()).startDisabled, false, '이 브라우저의 방에서도 연다');
  assert.equal((await localRooms.startGame({ code: created.room.code })).ok, true);
  assert.equal(
    localRooms.sendStandingAnswer({
      code: 'ABC234', matchId: '12345678-1234-5678-9234-567812345678', position: 1, choiceIndex: 0,
    }),
    false,
  );
  const local = await source('src/online/local-rooms.ts');
  assert.match(local, /minPlayers: LOCAL_ONLINE_RULES\.minPlayers,/);
});

test('홈 입구·빈 로비·만들기 도움말은 시작 인원을 모를 때 어느 API든 맞는 말을 한다', async () => {
  const rules = await import('../js/online/rules.js');
  assert.deepEqual(rules.onlineEntryCopy(null), { desc: '방을 만들거나 참가해요', label: '온라인, 방을 만들거나 참가해요' });
  assert.deepEqual(rules.onlineEntryCopy(1), { desc: '혼자서도 · 친구와 함께', label: '온라인, 혼자서도 친구와 함께' });
  assert.deepEqual(rules.onlineEntryCopy(2), { desc: '친구와 함께 · 2명부터', label: '온라인, 친구와 함께 2명부터' });

  const solo = rules.lobbyEmptyCopy(1);
  assert.equal(solo.title, '방을 만들면 혼자서도 바로 시작할 수 있어요');
  assert.equal(solo.label, '방 만들기');
  assert.equal(solo.practice, false, '혼자 온 사람을 홈으로 돌려보낼 까닭이 없다');
  for (const unknown of [null, 2]) {
    const legacy = rules.lobbyEmptyCopy(unknown);
    assert.equal(legacy.title, '친구를 불러야 시작할 수 있어요 (2명부터)');
    assert.equal(legacy.practice, true, '둘부터인 API에서는 홈의 «혼자 연습하기»로 막다른 길을 피한다');
  }
  assert.equal(rules.capacityHelpText(1), '혼자서도 바로 시작할 수 있어요');
  assert.equal(rules.capacityHelpText(2), '2명부터 시작할 수 있어요');
  // 모르면(목록을 읽지 못해 세션을 열지 못했다 — 그래도 만들기 폼은 열린다) 시작 인원을 말하지 않는다
  assert.equal(rules.capacityHelpText(null), '최대 인원까지 들어올 수 있어요');
  assert.equal(rules.capacityHelpText(null), rules.CAPACITY_HELP_UNKNOWN);
  assert.equal(rules.roomMinPlayers({}), 2);
  assert.equal(rules.roomMinPlayers({ minPlayers: 1 }), 1);

  // 정적 HTML 은 묻기 전의 말이다 (home.ts·online.ts 가 같은 함수로 되돌린다)
  const html = await source('index.html');
  assert.match(html, /id="open-online"\s+aria-label="온라인, 방을 만들거나 참가해요"/);
  assert.match(html, /id="open-online-desc">방을 만들거나 참가해요</);
  assert.match(html, new RegExp(`id="create-capacity-help">${rules.capacityHelpText(null)}<`));
});

test('「게임 방법」의 온라인 한 줄: 새 규칙·이전 규칙·아직 모름', async () => {
  const roundRules = await import('../js/ui/round-rules.js');
  const fresh = roundRules.onlineRule({ minPlayers: 1, standingAnswers: true });
  assert.equal(
    fresh,
    '답하기는 혼자 하기와 같아요 — 시간이 끝나면 캐릭터가 서 있는 칸이 답이에요. 문항 시간은 방장이 20초나 40초로 정해요. 방을 만들면 혼자서도 시작할 수 있어요.',
  );
  assert.equal(
    roundRules.onlineRule({ minPlayers: 2, standingAnswers: false }),
    roundRules.onlineRule(),
    '이전 API의 말은 그대로다',
  );
  const unknown = roundRules.onlineRule(null);
  // 묻기 전에는 두 규칙 모두에 맞는 말만: 누르면 바로 제출된다는 것과 문항 시간
  assert.doesNotMatch(unknown, /서 있기만|시간이 끝나면|혼자서도/);
  assert.match(unknown, /바로 제출돼요/);
  assert.match(unknown, /20초나 40초/);
});

test('혼자 푼 판의 최종 결과는 순위가 아니라 푼 결과를 말하고, 금색 한 줄과 축하는 그대로다', async () => {
  const { onlineFinalResultView, onlineFinalSummary, onlineFinalCelebrates } = await import('../js/ui/online-result.js');
  const solo = (points) => ({
    matchId: '12345678-1234-5678-9234-567812345678', state: 'finished', categoryId: null, gameMode: true,
    currentPosition: 10, totalQuestions: 10, deadlineAt: null, question: null, ownSubmission: null, reveal: null,
    scores: [{
      playerId: identity.id, nickname: '퀴즈왕', characterId: 'slime-blue',
      score: points, correctCount: points / 10, answeredCount: 10,
    }],
  });
  const view = onlineFinalResultView(solo(50), identity.id);
  assert.deepEqual(view.entries.map(({ place, tied }) => [place, tied]), [[1, false]]);
  assert.equal(onlineFinalSummary(view, 10), '혼자 푼 판 · 50점 · 5/10 정답');
  assert.equal(onlineFinalCelebrates(view), true, '한 문제라도 맞혔으면 축하한다');
  assert.equal(onlineFinalCelebrates(onlineFinalResultView(solo(0), identity.id)), false);
});
