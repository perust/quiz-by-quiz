import test from 'node:test';
import assert from 'node:assert/strict';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    dump() {
      return [...values.values()].join('\n');
    },
  };
}

function json(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

function room(changes = {}) {
  return {
    code: 'ABC234',
    name: '온라인 퀴즈',
    categoryId: 'history',
    capacity: 12,
    gameMode: true,
    players: [{
      id: '12345678-1234-5678-9234-567812345678',
      nickname: '퀴즈왕',
      characterId: 'slime-blue',
      isReady: false,
    }],
    isPublic: false,
    hasPassword: true,
    isMine: true,
    joined: true,
    createdAt: '2026-09-17T00:00:00+00:00',
    ...changes,
  };
}

class FakeWebSocket {
  static instances = [];

  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.readyState = 3;
  }

  send(value) {
    this.sent.push(value);
  }

  emit(type, event = {}) {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

const identity = {
  id: '12345678-1234-5678-9234-567812345678',
  secret: 'browser-session-secret-with-thirty-two-chars',
};

test('네트워크 저장소는 토큰을 헤더에만 보내고 방 비밀번호를 브라우저 저장소에 남기지 않는다', async () => {
  const storage = memoryStorage();
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/join')) return json(room());
    if (url.endsWith('/v1/rooms')) return json([room(), room({ code: 'PUB234', isPublic: true, hasPassword: false, joined: false, isMine: false })]);
    throw new Error(`unexpected request: ${url}`);
  };

  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage,
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  const rooms = await store.listRooms();
  assert.equal(rooms.length, 2);
  const joined = await store.joinRoom({
    code: 'ABC234',
    password: 'room-password',
    player: { nickname: '퀴즈왕', characterId: 'slime-blue' },
  });
  assert.equal(joined.ok, true);

  assert.equal(store.isNetworked, true);
  assert.equal(store.me(), identity.id);
  assert.ok(calls.every(({ url }) => !url.includes(identity.secret)));
  assert.ok(calls.every(({ init }) => new Headers(init.headers).get('Authorization') === `Bearer ${identity.secret}`));
  assert.ok(calls.every(({ init }) => new Headers(init.headers).get('X-Player-Id') === identity.id));
  assert.equal(storage.dump().includes('room-password'), false);
  assert.equal(JSON.stringify(rooms).includes('passwordHash'), false);
});

test('네트워크 저장소는 프로필을 먼저 고정하고 캐릭터 없는 세션을 만들지 않는다', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/v1/session')) return json({ playerId: identity.id });
    if (String(input).endsWith('/v1/rooms')) return json([]);
    throw new Error(`unexpected request: ${input}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  store.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });
  await store.listRooms();

  const session = calls.find(({ url }) => url.endsWith('/v1/session'));
  assert.deepEqual(JSON.parse(session.init.body), {
    nickname: '퀴즈왕',
    characterId: 'slime-blue',
  });
});

test('네트워크 저장소는 normal-mode 방과 캐릭터 없는 참가자 snapshot을 거부한다', async () => {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  for (const invalidRoom of [
    room({ gameMode: false }),
    room({ gameMode: true, players: [{ id: identity.id, nickname: '퀴즈왕', isReady: false }] }),
  ]) {
    const fetchImpl = async (input) => {
      if (String(input).endsWith('/v1/session')) return json({ playerId: identity.id });
      if (String(input).endsWith('/v1/rooms')) return json([invalidRoom]);
      throw new Error(`unexpected request: ${input}`);
    };
    const store = createNetworkRoomStore({
      baseUrl: 'https://quiz-api.example.test',
      storage: memoryStorage(),
      fetchImpl,
      newIdentity: () => identity,
      webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
    });
    store.setPlayer({ nickname: '퀴즈왕', characterId: 'slime-blue' });
    await assert.rejects(store.listRooms(), /캐릭터|전용/);
  }
});

test('네트워크 저장소는 현재 참가자의 준비 상태만 서버에 보내고 새 방 snapshot을 받는다', async () => {
  const calls = [];
  const readyRoom = room({
    players: [{
      id: identity.id,
      nickname: '퀴즈왕',
      characterId: 'slime-blue',
      isReady: true,
    }],
  });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/ready')) return json(readyRoom);
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  const result = await store.setReady({ code: 'ABC234', isReady: true });

  assert.deepEqual(result, { ok: true, room: readyRoom });
  const readyCall = calls.find(({ url }) => url.endsWith('/v1/rooms/ABC234/ready'));
  assert.equal(readyCall.init.method, 'PUT');
  assert.deepEqual(JSON.parse(readyCall.init.body), { isReady: true });
});

test('네트워크 저장소는 server not-ready 시작 거절을 화면용 결과로 보존한다', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/start')) {
      return json({ detail: { code: 'not-ready', message: '참가자가 두 명 이상이고 모두 준비해야 시작할 수 있습니다.' } }, 409);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  assert.deepEqual(await store.startGame({ code: 'ABC234' }), { ok: false, reason: 'not-ready' });
});

function runningMatch(changes = {}) {
  return {
    matchId: '12345678-1234-5678-9234-567812345678',
    state: 'running',
    categoryId: 'history',
    gameMode: true,
    currentPosition: 1,
    totalQuestions: 10,
    deadlineAt: '2026-09-18T11:00:20+00:00',
    question: {
      id: 'history-001',
      categoryId: 'history',
      question: '서버가 고른 문제',
      choices: ['첫 번째', '두 번째', '세 번째', '네 번째'],
      position: 1,
      total: 10,
    },
    ownSubmission: null,
    reveal: null,
    scores: [],
    ...changes,
  };
}

function finishedMatch(changes = {}) {
  return {
    matchId: '12345678-1234-5678-9234-567812345678',
    state: 'finished',
    categoryId: 'history',
    gameMode: true,
    currentPosition: 10,
    totalQuestions: 10,
    deadlineAt: null,
    question: null,
    ownSubmission: null,
    reveal: null,
    scores: [{
      playerId: identity.id,
      nickname: '퀴즈왕',
      characterId: 'slime-blue',
      score: 100,
      correctCount: 10,
      answeredCount: 10,
    }],
    ...changes,
  };
}

test('온라인 매치 snapshot은 running 동안 문제·제출 acknowledgement만 받아 온다', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/match')) return json(runningMatch());
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  const match = await store.getMatch('ABC234');

  assert.equal(match.state, 'running');
  assert.equal(match.question.question, '서버가 고른 문제');
  assert.equal(match.ownSubmission, null);
  assert.deepEqual(match.scores, []);
  assert.equal(calls.at(-1).url.endsWith('/v1/rooms/ABC234/match'), true);
});

test('끝난 온라인 매치 snapshot은 deadlineAt null과 서버 점수 순서를 그대로 받는다', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/match')) return json(finishedMatch());
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  const match = await store.getMatch('ABC234');

  assert.equal(match.state, 'finished');
  assert.equal(match.deadlineAt, null);
  assert.deepEqual(match.scores.map(({ playerId }) => playerId), [identity.id]);
});

test('running snapshot에 서버가 정답이나 점수를 섞으면 fail-closed로 거절한다', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/match')) {
      return json(runningMatch({
        ownSubmission: { position: 1, choiceIndex: 0, timedOut: false, correct: true },
      }));
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  await assert.rejects(() => store.getMatch('ABC234'), /running.*정답|정답.*running/i);
});

test('답안 제출은 server position과 choice index만 보내고 받은 snapshot을 그대로 돌려준다', async () => {
  const calls = [];
  const accepted = runningMatch({ ownSubmission: { position: 1, choiceIndex: 2, timedOut: false } });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/match/answers')) {
      return json({ match: accepted, accepted: true, advanced: false });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  const result = await store.submitMatchAnswer({ code: 'ABC234', position: 1, choiceIndex: 2 });

  assert.equal(result.accepted, true);
  assert.equal(result.advanced, false);
  assert.equal(result.match.ownSubmission.choiceIndex, 2);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { position: 1, choiceIndex: 2 });
});

test('참가 오류 코드를 기존 RoomStore 실패 이유로 보존한다', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/join')) {
      return json({ detail: { code: 'wrong-password', message: '비밀번호가 맞지 않습니다.' } }, 403);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  assert.deepEqual(
    await store.joinRoom({ code: 'ABC234', password: 'wrong' }),
    { ok: false, reason: 'wrong-password' },
  );
});

test('WebSocket에는 단회 티켓만 넣고 무효화 이벤트는 내 권한으로 방을 다시 읽는다', async () => {
  FakeWebSocket.instances.length = 0;
  let roomReads = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'one-time-ws-ticket' }, 201);
    if (url.endsWith('/v1/rooms/ABC234')) {
      roomReads += 1;
      return json(room({ name: '갱신된 방' }));
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.url.includes(identity.secret), false);
    assert.equal(new URL(socket.url).search, '');
    assert.deepEqual(socket.protocols, [
      'qbb.v1',
      'qbb.ticket.one-time-ws-ticket',
    ]);

    socket.emit('open');
    socket.emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    await waitFor(
      () => events.some((event) => event.type === 'room'),
      'room invalidation was not translated',
    );

    const roomEvent = events.find((event) => event.type === 'room');
    assert.equal(roomReads, 2);
    assert.equal(roomEvent?.type, 'room');
    assert.equal(roomEvent?.room.name, '갱신된 방');
  } finally {
    unsubscribe();
  }
});

test('movement is cached until the room socket opens and never falls back to an HTTP request', async () => {
  FakeWebSocket.instances.length = 0;
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'movement-ticket' }, 201);
    if (url.endsWith('/v1/rooms/ABC234')) return json(room());
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const unsubscribe = store.subscribe('ABC234', () => undefined);
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    const socket = FakeWebSocket.instances[0];
    assert.equal(store.sendMovement({ code: 'ABC234', x: 0.25, y: 0.75, moving: true }), false);
    assert.deepEqual(socket.sent, []);

    socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: 'movement', x: 0.25, y: 0.75, moving: true,
    });
    assert.equal(store.sendMovement({ code: 'ABC234', x: 0.4, y: 0.6, moving: false }), true);
    assert.deepEqual(JSON.parse(socket.sent[1]), {
      type: 'movement', x: 0.4, y: 0.6, moving: false,
    });
    assert.equal(calls.some((url) => url.endsWith('/movement')), false);
  } finally {
    unsubscribe();
  }
  assert.equal(store.sendMovement({ code: 'ABC234', x: 0.5, y: 0.5, moving: false }), false);
});

test('movement events are validated and carry the local socket generation for stale-event rejection', async () => {
  FakeWebSocket.instances.length = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'movement-event-ticket' }, 201);
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    const socket = FakeWebSocket.instances[0];
    socket.emit('message', { data: JSON.stringify({
      type: 'movement',
      playerId: '22345678-1234-4678-9234-567812345678',
      x: 0.2,
      y: 0.8,
      moving: true,
      sequence: 9,
    }) });
    socket.emit('message', { data: JSON.stringify({
      type: 'movement',
      playerId: '22345678-1234-4678-9234-567812345678',
      x: 2,
      y: 0.8,
      moving: true,
      sequence: 10,
    }) });

    assert.deepEqual(events, [{
      type: 'movement',
      playerId: '22345678-1234-4678-9234-567812345678',
      x: 0.2,
      y: 0.8,
      moving: true,
      sequence: 9,
      connectionGeneration: 1,
    }]);
  } finally {
    unsubscribe();
  }
});

test('같은 socket의 겹친 room refresh는 가장 늦게 시작한 응답만 내보낸다', async () => {
  FakeWebSocket.instances.length = 0;
  const pending = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'refresh-order-ticket' }, 201);
    if (url.endsWith('/v1/rooms/ABC234')) {
      return new Promise((resolve) => pending.push(resolve));
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    const socket = FakeWebSocket.instances[0];
    socket.emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    socket.emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    await waitFor(() => pending.length === 2, 'room refreshes were not started');

    pending[1](json(room({ name: '최신 방' })));
    await waitFor(() => events.some((event) => event.type === 'room'), 'latest room was not emitted');
    pending[0](json(room({ name: '오래된 방' })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      events.filter((event) => event.type === 'room').map((event) => event.room.name),
      ['최신 방'],
    );
  } finally {
    unsubscribe();
  }
});

test('a successful refresh is delivered when a later overlapping refresh fails', async () => {
  FakeWebSocket.instances.length = 0;
  const pending = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'refresh-failure-ticket' }, 201);
    if (url.endsWith('/v1/rooms/ABC234')) {
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    const socket = FakeWebSocket.instances[0];
    socket.emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    socket.emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    await waitFor(() => pending.length === 2, 'room refreshes were not started');

    pending[0].resolve(json(room({ name: '먼저 도착한 최신 상태' })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[1].reject(new Error('later refresh failed'));
    await waitFor(
      () => events.some((event) => event.type === 'room'),
      'successful refresh was lost when the later refresh failed',
    );

    assert.deepEqual(
      events.filter((event) => event.type === 'room').map((event) => event.room.name),
      ['먼저 도착한 최신 상태'],
    );
  } finally {
    unsubscribe();
  }
});

test('a failed room action does not suppress an in-flight successful refresh', async () => {
  FakeWebSocket.instances.length = 0;
  let resolveRefresh;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'failed-action-ticket' }, 201);
    if (url.endsWith('/v1/rooms/ABC234/ready') && init.method === 'PUT') {
      return json({ detail: { code: 'not-member', message: 'not a member' } }, 403);
    }
    if (url.endsWith('/v1/rooms/ABC234')) {
      return new Promise((resolve) => { resolveRefresh = resolve; });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({ type: 'room-invalidated' }),
    });
    await waitFor(() => typeof resolveRefresh === 'function', 'room refresh was not started');

    const action = await store.setReady({ code: 'ABC234', isReady: true });
    assert.deepEqual(action, { ok: false, reason: 'not-member' });
    resolveRefresh(json(room({ name: '실패한 작업 뒤 서버 상태' })));
    await waitFor(
      () => events.some((event) => event.type === 'room'),
      'failed action incorrectly suppressed the room refresh',
    );
  } finally {
    unsubscribe();
  }
});

test('independent room subscriptions do not suppress each other snapshots', async () => {
  FakeWebSocket.instances.length = 0;
  const pending = new Map();
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: `ticket-${url}` }, 201);
    const match = url.match(/\/v1\/rooms\/(ABC234|XYZ789)$/);
    if (match) {
      return new Promise((resolve) => pending.set(match[1], resolve));
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const firstEvents = [];
  const secondEvents = [];
  const unsubscribeFirst = store.subscribe('ABC234', (event) => firstEvents.push(event));
  const unsubscribeSecond = store.subscribe('XYZ789', (event) => secondEvents.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 2, 'websockets were not created');
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    FakeWebSocket.instances[1].emit('message', { data: JSON.stringify({ type: 'room-invalidated' }) });
    await waitFor(() => pending.size === 2, 'both room refreshes were not started');

    pending.get('ABC234')(json(room({ code: 'ABC234', name: '첫 방' })));
    pending.get('XYZ789')(json(room({ code: 'XYZ789', name: '둘째 방' })));
    await waitFor(
      () => firstEvents.some((event) => event.type === 'room')
        && secondEvents.some((event) => event.type === 'room'),
      'one subscription suppressed the other room snapshot',
    );
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
  }
});

test('room action이 시작되면 그 전에 시작한 invalidation refresh는 폐기한다', async () => {
  FakeWebSocket.instances.length = 0;
  let resolveRefresh;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'action-order-ticket' }, 201);
    if (url.endsWith('/v1/rooms/ABC234/ready') && init.method === 'PUT') {
      return json(room({ name: '작업 뒤 방', players: [{
        id: identity.id, nickname: '퀴즈왕', characterId: 'slime-blue', isReady: true,
      }] }));
    }
    if (url.endsWith('/v1/rooms/ABC234')) {
      return new Promise((resolve) => { resolveRefresh = resolve; });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({ type: 'room-invalidated' }),
    });
    await waitFor(() => typeof resolveRefresh === 'function', 'room refresh was not started');

    const action = await store.setReady({ code: 'ABC234', isReady: true });
    assert.equal(action.ok, true);
    resolveRefresh(json(room({ name: '작업 전 오래된 방' })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(events.some((event) => event.type === 'room'), false);
  } finally {
    unsubscribe();
  }
});

test('match invalidation은 snapshot을 socket에 싣지 않고 app에 authorization-bound refetch만 요청한다', async () => {
  FakeWebSocket.instances.length = 0;
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'one-time-ws-ticket' }, 201);
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({ type: 'match-invalidated', matchId: runningMatch().matchId }),
    });
    await waitFor(
      () => events.some((event) => (
        event.type === 'match'
        && event.phase === 'invalidated'
        && event.matchId === runningMatch().matchId
      )),
      'match invalidation was not translated',
    );

    assert.deepEqual(events.find((event) => (
      event.type === 'match' && event.matchId === runningMatch().matchId
    )), {
      type: 'match', phase: 'invalidated', matchId: runningMatch().matchId,
    });
    assert.equal(calls.some(({ url }) => url.endsWith('/match')), false);
  } finally {
    unsubscribe();
  }
});

test('unsubscribe 뒤 old socket의 delayed game-started event는 전달하지 않는다', async () => {
  FakeWebSocket.instances.length = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'stale-socket-ticket' }, 201);
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
  const oldSocket = FakeWebSocket.instances[0];
  unsubscribe();

  oldSocket.emit('message', {
    data: JSON.stringify({
      type: 'game-started',
      matchId: '22345678-1234-5678-9234-567812345678',
      categoryId: 'history',
      gameMode: true,
      totalQuestions: 10,
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, []);
});

test('game-started event는 replacement match identity를 검증해 보존한다', async () => {
  FakeWebSocket.instances.length = 0;
  const matchId = '22345678-1234-5678-9234-567812345678';
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'started-event-ticket' }, 201);
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        type: 'game-started',
        matchId,
        categoryId: 'history',
        gameMode: true,
        totalQuestions: 10,
      }),
    });
    await waitFor(
      () => events.some((event) => event.type === 'match' && event.phase === 'started'),
      'game-started event was not translated',
    );
    assert.deepEqual(events.find((event) => event.type === 'match'), {
      type: 'match',
      phase: 'started',
      matchId,
      setup: { categoryId: 'history', gameMode: true },
    });
  } finally {
    unsubscribe();
  }
});

test('socket open은 room snapshot과 match invalidation을 함께 복구한다', async () => {
  FakeWebSocket.instances.length = 0;
  let roomReads = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/ws-ticket')) return json({ ticket: 'ticket-1' }, 201);
    if (url.endsWith('/v1/rooms/ABC234')) {
      roomReads += 1;
      return json(room({ name: '재연결 뒤 방' }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const events = [];
  const unsubscribe = store.subscribe('ABC234', (event) => events.push(event));
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'websocket was not created');
    FakeWebSocket.instances[0].emit('open');
    await waitFor(
      () => events.some((event) => event.type === 'match' && event.phase === 'invalidated'),
      'socket open did not request a match snapshot refresh',
    );
    await waitFor(
      () => events.some((event) => event.type === 'room'),
      'socket open did not refresh the room snapshot',
    );
    assert.equal(roomReads, 1);
    assert.deepEqual(events.find((event) => event.type === 'match'), {
      type: 'match', phase: 'invalidated', matchId: null,
    });
    assert.equal(events.find((event) => event.type === 'room')?.room.name, '재연결 뒤 방');
  } finally {
    unsubscribe();
  }
});

test('서버가 비밀번호 필드를 잘못 돌려주면 응답을 신뢰하지 않고 거절한다', async () => {
  const leaked = { ...room(), passwordHash: '$argon2id$must-not-leak' };
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms')) return json([leaked]);
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });

  await assert.rejects(() => store.listRooms(), /비밀번호 필드/);
});
