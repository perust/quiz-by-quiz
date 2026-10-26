import test from 'node:test';
import assert from 'node:assert/strict';

// 방장의 «내보내기»(U24) 저장소 계약. 서버 구현은 DELETE /members/{id} 로 보내고 거절 이유를 화면용
// 결과로 옮긴다. 내보내진 사람이 방을 다시 읽거나 다시 붙으려 하면 «없는 방»이 아니라 그 이유를 받는다.
// 접속 중인 사람은 방장이 그렇게 보고 확인했을 때만(`connected: true` → `?connected=true`) 내보내고,
// 그 사람은 잠시 그 방에 다시 들어가지 못한다(`kicked`). 열린 소켓으로 곧바로 이유를 듣는다.
// 로컬 방은 끊김을 알 길이 없어(모두 connected) 끊긴 자리를 비우는 요청은 언제나 «접속 중»으로 거절한다.

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

function json(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

const identity = {
  id: '12345678-1234-5678-9234-567812345678',
  secret: 'browser-session-secret-with-thirty-two-chars',
};
const GHOST = '87654321-4321-4765-8321-876543218765';

function room(changes = {}) {
  return {
    code: 'ABC234',
    name: '온라인 퀴즈',
    categoryId: 'history',
    capacity: 12,
    gameMode: true,
    players: [{
      id: identity.id, nickname: '퀴즈왕', characterId: 'slime-blue', isReady: false, connected: true,
    }],
    isPublic: true,
    hasPassword: false,
    isMine: true,
    joined: true,
    createdAt: '2026-09-17T00:00:00+00:00',
    status: 'waiting',
    inMatch: false,
    ...changes,
  };
}

class FakeWebSocket {
  static instances = [];
  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
  }
  addEventListener() {}
  close() { this.readyState = 3; }
  send() {}
}

async function store(fetchImpl) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  return createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('내보내기는 그 참가자 경로로 DELETE 를 보내고 서버가 준 방을 돌려준다', async () => {
  const calls = [];
  const rooms = await store(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.includes(`/v1/rooms/ABC234/members/${GHOST}`)) return json(room());
    throw new Error(`unexpected request: ${url}`);
  });
  rooms.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });

  const result = await rooms.removeMember({ code: 'abc234', playerId: GHOST });
  assert.equal(result.ok, true);
  assert.equal(result.room.players.length, 1);
  assert.deepEqual(calls.at(-1), {
    url: `https://quiz-api.example.test/v1/rooms/ABC234/members/${GHOST}`,
    method: 'DELETE',
  });

  // 접속 중인 사람으로 보고 확인했을 때만 그 뜻을 싣는다 — 서버가 그 사람을 잠시 다시 들이지 않는다
  assert.equal((await rooms.removeMember({ code: 'ABC234', playerId: GHOST, connected: true })).ok, true);
  assert.equal(calls.at(-1).url, `https://quiz-api.example.test/v1/rooms/ABC234/members/${GHOST}?connected=true`);
  await rooms.removeMember({ code: 'ABC234', playerId: GHOST, connected: false });
  assert.equal(calls.at(-1).url, `https://quiz-api.example.test/v1/rooms/ABC234/members/${GHOST}`);

  // 형식이 틀린 값은 보내지 않는다 — 특히 «me»는 나가기 경로다
  assert.deepEqual(await rooms.removeMember({ code: 'ABC234', playerId: 'me' }), { ok: false, reason: 'not-member' });
  assert.deepEqual(await rooms.removeMember({ code: '!!', playerId: GHOST }), { ok: false, reason: 'not-found' });
  assert.equal(calls.filter(({ method }) => method === 'DELETE').length, 3);
});

test('내보내기 거절은 연결 실패가 아니라 화면이 말할 이유로 옮긴다', async () => {
  let refusal = { code: 'member-connected', status: 409 };
  const rooms = await store(async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    return json({ detail: { code: refusal.code, message: '서버의 말' } }, refusal.status);
  });
  rooms.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });

  for (const [code, status] of [
    ['member-connected', 409], ['game-in-progress', 409], ['not-host', 403], ['not-member', 404], ['not-found', 404],
  ]) {
    refusal = { code, status };
    assert.deepEqual(await rooms.removeMember({ code: 'ABC234', playerId: GHOST }), { ok: false, reason: code });
  }
  // 요청 한도는 «이유 있는 거절»이 아니라 그 말을 가진 오류로 던진다
  refusal = { code: 'rate-limited', status: 429 };
  await assert.rejects(() => rooms.removeMember({ code: 'ABC234', playerId: GHOST }), { message: '서버의 말' });
});

test('내보내진 사람이 방을 다시 읽으면 RemovedFromRoom 을, 그냥 없는 방이면 null 을 받는다', async () => {
  let code = 'removed';
  const rooms = await store(async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    return json({ detail: { code, message: '방장이 방에서 내보냈습니다.' } }, 404);
  });
  rooms.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });
  const { RemovedFromRoom, REMOVED_BY_HOST_MESSAGE } = await import('../js/online/rules.js');

  const error = await rooms.getRoom('ABC234').then(() => null, (failure) => failure);
  assert.ok(error instanceof RemovedFromRoom);
  assert.equal(error.kind, 'removed');
  assert.equal(error.message, REMOVED_BY_HOST_MESSAGE);

  // 접속 중에 내보내졌으면 잠시 다시 들어올 수 없다는 것까지 말한다
  code = 'kicked';
  const kicked = await rooms.getRoom('ABC234').then(() => null, (failure) => failure);
  assert.ok(kicked instanceof RemovedFromRoom);
  assert.equal(kicked.kind, 'kicked');
  assert.equal(kicked.message, '방장이 방에서 내보냈어요. 잠시 뒤에 다시 들어올 수 있어요.');

  code = 'not-found';
  assert.equal(await rooms.getRoom('ABC234'), null);
});

test('접속 중에 내보내진 사람의 참가는 연결 실패가 아니라 «잠시 뒤에» 이유로 돌아온다', async () => {
  const rooms = await store(async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    return json({ detail: { code: 'kicked', message: '서버의 말' } }, 403);
  });
  rooms.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });
  const { JOIN_MESSAGES } = await import('../js/online/rules.js');

  assert.deepEqual(await rooms.joinRoom({ code: 'ABC234', password: '' }), { ok: false, reason: 'kicked' });
  assert.equal(JOIN_MESSAGES.kicked, '방장이 내보낸 방이에요. 잠시 뒤에 다시 들어올 수 있어요.');
  assert.doesNotMatch(JOIN_MESSAGES.kicked, /네트워크|연결/);
});

test('다시 붙으려다 «내보냈다»를 들으면 화면에 알리고 같은 티켓 요청을 되풀이하지 않는다', async () => {
  FakeWebSocket.instances.length = 0;
  let tickets = 0;
  const rooms = await store(async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) {
      tickets += 1;
      return json({ detail: { code: 'removed', message: '방장이 방에서 내보냈습니다.' } }, 403);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  rooms.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });

  const events = [];
  const unsubscribe = rooms.subscribe('ABC234', (event) => events.push(event));
  try {
    for (let i = 0; i < 20 && events.length === 0; i += 1) await tick();
    assert.deepEqual(events, [{ type: 'removed', kind: 'removed' }]);
    // 재접속 간격(1초)을 기다려도 다시 묻지 않는다
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(tickets, 1);
    assert.equal(FakeWebSocket.instances.length, 0, '소켓을 열지 않는다');
  } finally {
    unsubscribe();
  }
});

/** 붙인 리스너를 부를 수 있는 가짜 소켓. 서버가 보낸 글과 닫힘을 흉내 낸다 */
class ListeningWebSocket {
  static instances = [];
  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.listeners = new Map();
    ListeningWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  send() {}
}

async function listeningStore(fetchImpl) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const rooms = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new ListeningWebSocket(url, protocols),
  });
  rooms.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });
  return rooms;
}

test('열린 소켓으로 «내보냈다»를 들으면 한 번만 알리고, 소켓이 닫혀도 다시 붙지 않는다', async () => {
  ListeningWebSocket.instances.length = 0;
  let tickets = 0;
  const rooms = await listeningStore(async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) {
      tickets += 1;
      return json({ ticket: 't'.repeat(40) }, 201);
    }
    return json({ detail: { code: 'kicked', message: '서버의 말' } }, 404);
  });

  const events = [];
  const unsubscribe = rooms.subscribe('ABC234', (event) => events.push(event));
  try {
    for (let i = 0; i < 20 && ListeningWebSocket.instances.length === 0; i += 1) await tick();
    const [socket] = ListeningWebSocket.instances;
    assert.ok(socket, '소켓을 열었다');

    socket.emit('message', { data: JSON.stringify({ type: 'removed', reason: 'kicked' }) });
    assert.deepEqual(events, [{ type: 'removed', kind: 'kicked' }]);
    assert.equal(socket.readyState, 3, '들은 쪽도 소켓을 놓는다');
    // 늦게 온 같은 이벤트·재조회 무효화도 같은 말을 되풀이하지 않는다
    socket.emit('message', { data: JSON.stringify({ type: 'removed', reason: 'kicked' }) });
    socket.emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.deepEqual(events, [{ type: 'removed', kind: 'kicked' }]);
    assert.equal(tickets, 1, '재접속 간격이 지나도 티켓을 다시 묻지 않는다');
    assert.equal(ListeningWebSocket.instances.length, 1);
  } finally {
    unsubscribe();
  }
});

test('이유를 모르는 «내보냈다» 이벤트는 끊긴 자리를 비운 쪽으로 읽는다', async () => {
  ListeningWebSocket.instances.length = 0;
  const rooms = await listeningStore(async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 't'.repeat(40) }, 201);
    throw new Error(`unexpected request: ${url}`);
  });
  const events = [];
  const unsubscribe = rooms.subscribe('ABC234', (event) => events.push(event));
  try {
    for (let i = 0; i < 20 && ListeningWebSocket.instances.length === 0; i += 1) await tick();
    ListeningWebSocket.instances[0].emit('message', { data: JSON.stringify({ type: 'removed', reason: 42 }) });
    assert.deepEqual(events, [{ type: 'removed', kind: 'removed' }]);
  } finally {
    unsubscribe();
  }
});

test('다시 붙으려다 «잠시 들어올 수 없다»를 들어도 그 이유로 한 번만 알린다', async () => {
  FakeWebSocket.instances.length = 0;
  let tickets = 0;
  const rooms = await store(async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) {
      tickets += 1;
      return json({ detail: { code: 'kicked', message: '서버의 말' } }, 403);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  rooms.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });
  const events = [];
  const unsubscribe = rooms.subscribe('ABC234', (event) => events.push(event));
  try {
    for (let i = 0; i < 20 && events.length === 0; i += 1) await tick();
    assert.deepEqual(events, [{ type: 'removed', kind: 'kicked' }]);
    assert.equal(tickets, 1);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    unsubscribe();
  }
});

test('로컬 방도 같은 규칙을 쓴다 — 방장만, 남만. 끊긴 자리를 비우는 요청은 언제나 «접속 중»이다', async () => {
  globalThis.window = { localStorage: memoryStorage() };
  const { localRooms } = await import('../js/online/local-rooms.js?member-removal');
  const created = await localRooms.createRoom({
    name: '로컬 방', categoryId: null, capacity: 4, isPublic: true,
    player: { nickname: '퀴즈왕', characterId: 'slime-blue' },
  });
  assert.equal(created.ok, true);
  const { code } = created.room;
  const me = localRooms.me();

  assert.ok(created.room.players.every((player) => player.connected), '로컬 방은 모두 connected 다');
  assert.deepEqual(await localRooms.removeMember({ code, playerId: me }), { ok: false, reason: 'member-connected' });
  assert.deepEqual(
    await localRooms.removeMember({ code, playerId: me, connected: true }),
    { ok: false, reason: 'member-connected' },
    '방장 자신은 내보내지 않는다',
  );
  assert.deepEqual(await localRooms.removeMember({ code, playerId: 'nobody' }), { ok: false, reason: 'not-member' });
  assert.deepEqual(await localRooms.removeMember({ code: 'ZZZZZZ', playerId: 'nobody' }), { ok: false, reason: 'not-found' });
  await localRooms.leaveRoom({ code });
});

test('로컬 방장도 접속 중인 사람으로 보고 확인한 내보내기는 받아 준다', async () => {
  // safe-storage 는 처음 불러올 때의 저장소를 붙든다 — 앞 시험이 만든 것을 그대로 쓴다
  globalThis.window ??= { localStorage: memoryStorage() };
  const { localStorage } = globalThis.window;
  const now = Date.now();
  const member = (id) => ({ id, nickname: id, characterId: 'slime-blue', isReady: false, seenAt: now });
  localStorage.setItem('quiz.playerId', 'host');
  localStorage.setItem('quiz.rooms', JSON.stringify([{
    code: 'KICK23', name: '로컬 방', categoryId: null, capacity: 4, isPublic: true, gameMode: true,
    password: '', hostId: 'host', players: [member('host'), member('guest')], createdAt: new Date(0).toISOString(),
  }]));
  const { localRooms } = await import('../js/online/local-rooms.js?member-kick');
  const events = [];
  const unsubscribe = localRooms.subscribe('KICK23', (event) => events.push(event));
  try {
    assert.deepEqual(
      await localRooms.removeMember({ code: 'KICK23', playerId: 'guest' }),
      { ok: false, reason: 'member-connected' },
      '끊긴 자리를 비우는 요청은 접속 중인 사람을 빼지 않는다',
    );
    const kicked = await localRooms.removeMember({ code: 'KICK23', playerId: 'guest', connected: true });
    assert.equal(kicked.ok, true);
    assert.deepEqual(kicked.room.players.map((player) => player.id), ['host']);
    assert.deepEqual(JSON.parse(localStorage.getItem('quiz.rooms'))[0].players.map((player) => player.id), ['host']);
    assert.deepEqual(events.map((event) => event.type), ['room'], '열린 대기실도 같은 방으로 다시 그린다');
  } finally {
    unsubscribe();
  }
});
