import test from 'node:test';
import assert from 'node:assert/strict';

// 방장의 «내보내기»(U24) 저장소 계약. 서버 구현은 DELETE /members/{id} 로 보내고 거절 이유를 화면용
// 결과로 옮긴다. 내보내진 사람이 방을 다시 읽거나 다시 붙으려 하면 «없는 방»이 아니라 그 이유를 받는다.
// 로컬 방은 끊김을 알 길이 없어(모두 connected) 같은 규칙에서 언제나 «접속 중»으로 거절한다.

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
    if (url.endsWith(`/v1/rooms/ABC234/members/${GHOST}`)) return json(room());
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

  // 형식이 틀린 값은 보내지 않는다 — 특히 «me»는 나가기 경로다
  assert.deepEqual(await rooms.removeMember({ code: 'ABC234', playerId: 'me' }), { ok: false, reason: 'not-member' });
  assert.deepEqual(await rooms.removeMember({ code: '!!', playerId: GHOST }), { ok: false, reason: 'not-found' });
  assert.equal(calls.filter(({ method }) => method === 'DELETE').length, 1);
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
  assert.equal(error.message, REMOVED_BY_HOST_MESSAGE);

  code = 'not-found';
  assert.equal(await rooms.getRoom('ABC234'), null);
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
    assert.deepEqual(events, [{ type: 'removed' }]);
    // 재접속 간격(1초)을 기다려도 다시 묻지 않는다
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(tickets, 1);
    assert.equal(FakeWebSocket.instances.length, 0, '소켓을 열지 않는다');
  } finally {
    unsubscribe();
  }
});

test('로컬 방도 같은 규칙을 쓴다 — 방장만, 남만, 끊긴 사람만. 끊김을 알 길이 없어 언제나 «접속 중»이다', async () => {
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
  assert.deepEqual(await localRooms.removeMember({ code, playerId: 'nobody' }), { ok: false, reason: 'not-member' });
  assert.deepEqual(await localRooms.removeMember({ code: 'ZZZZZZ', playerId: 'nobody' }), { ok: false, reason: 'not-found' });
  await localRooms.leaveRoom({ code });
});
