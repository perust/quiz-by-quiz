// room-invalidated fan-out 줄이기 (CLAUDE.md «room-invalidated 재조회는 합친다»).
//
// 방이 바뀔 때마다 방 전원이 GET /v1/rooms/{code}를 다시 읽던 것이 가장 바쁜 1분 요청의 40%쯤이었다
// (PR #106 부하 측정). 서버가 방송과 snapshot에 판 번호를 붙이면, 이미 그 번호를 담은 방을 가진 화면은
// 다시 읽지 않고 준비 토글은 바로 앞 번호의 방에 덧대어 GET 없이 고친다. 번호를 모르는 이전 API(#106)와는
// 오늘과 똑같이 늘 다시 읽는다. 아래 가짜 서버는 두 API를 같은 순서로 흉내 내고 GET 수를 센다.
import test from 'node:test';
import assert from 'node:assert/strict';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeWebSocket {
  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(predicate, message) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

function playerId(index) {
  return `12345678-1234-4678-9234-5678123456${String(index).padStart(2, '0')}`;
}

/**
 * 방 하나를 가진 가짜 API. `versioned`이면 이 브랜치의 API다 — snapshot에 «DB를 읽기 전에 읽은» 번호를,
 * 방송에 새 번호를, 준비 토글에 고칠 거리를 싣는다. 아니면 #106의 API다(`{"type":"room-invalidated"}`뿐).
 * 방 GET은 한 틱 기다렸다 읽는다 — 그사이 다른 요청이 commit할 수 있다(진짜 DB 읽기처럼).
 */
function createFakeApi({ members, versioned, epoch = 'fanout-epoch-a1' }) {
  const room = members.map((id, index) => ({ id, nickname: `학생${index + 1}`, isReady: false }));
  const sockets = [];
  let counter = 0;
  let roomVersion = 0;
  let currentEpoch = epoch;
  const counts = { roomGets: 0, readyPuts: 0 };
  /** `pauseGets`이면 방 GET이 번호를 읽은 뒤 여기서 기다린다 — 테스트가 하나씩 풀어 준다 */
  const paused = [];
  const control = { pauseGets: false };

  function snapshot(viewerId, label) {
    return {
      code: 'ABC234',
      name: '교실',
      categoryId: null,
      capacity: 12,
      gameMode: true,
      questionTimeMs: 20_000,
      players: room.map((player) => ({
        id: player.id,
        nickname: player.nickname,
        characterId: 'slime-blue',
        isReady: player.isReady,
        connected: true,
      })),
      isPublic: true,
      hasPassword: false,
      isMine: viewerId === room[0].id,
      joined: true,
      createdAt: '2026-10-27T00:00:00+00:00',
      status: 'waiting',
      inMatch: false,
      minPlayers: 1,
      ...(versioned ? { roomEpoch: currentEpoch, roomVersion: label } : {}),
    };
  }

  function broadcast(event) {
    const data = JSON.stringify(event);
    for (const socket of sockets) {
      // 소켓 방송은 HTTP 응답과 다른 길로 간다 — 다음 틱에 닿는다
      setTimeout(() => {
        if (socket.readyState === 1) socket.emit('message', { data });
      }, 0);
    }
  }

  function bump() {
    counter += 1;
    const previous = roomVersion;
    roomVersion = counter;
    return { version: counter, previous };
  }

  return {
    counts,
    room,
    sockets,
    paused,
    control,
    get version() { return counter; },
    /** API를 다시 띄웠다: 번호가 처음부터이고 묶음 이름이 바뀐다 */
    restart(nextEpoch) {
      counter = 0;
      roomVersion = 0;
      currentEpoch = nextEpoch;
    },
    broadcast,
    bump,
    fetchFor(actorId) {
      return async (input, init = {}) => {
        const url = String(input);
        const method = init.method ?? 'GET';
        if (url.endsWith('/v1/session')) {
          return json({ playerId: actorId, minPlayers: 1, standingAnswers: true });
        }
        if (url.endsWith('/ws-ticket')) return json({ ticket: `ticket-${actorId}` }, 201);
        if (url.endsWith('/v1/rooms/ABC234') && method === 'GET') {
          counts.roomGets += 1;
          const label = counter;
          if (control.pauseGets) await new Promise((resolve) => paused.push(resolve));
          else await tick();
          return json(snapshot(actorId, label));
        }
        if (url.endsWith('/v1/rooms/ABC234/ready') && method === 'PUT') {
          counts.readyPuts += 1;
          const { isReady } = JSON.parse(String(init.body));
          const label = counter;
          room.find((player) => player.id === actorId).isReady = isReady;
          const { version, previous } = bump();
          broadcast(versioned
            ? {
              type: 'room-invalidated',
              roomEpoch: currentEpoch,
              roomVersion: version,
              readyChange: { previousVersion: previous, playerId: actorId, isReady },
            }
            : { type: 'room-invalidated' });
          return json(snapshot(actorId, label));
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      };
    },
  };
}

/** 방 전원의 대기실 구독. 각자의 저장소·소켓·마지막으로 받은 방을 든다 */
async function joinClassroom(api, members) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const seats = members.map((id) => {
    const seat = { id, rooms: [], socket: null };
    seat.store = createNetworkRoomStore({
      baseUrl: 'https://quiz-api.example.test',
      storage: memoryStorage(),
      fetchImpl: api.fetchFor(id),
      newIdentity: () => ({ id, secret: `secret-${id}-with-enough-length` }),
      webSocketFactory: (url, protocols) => {
        const socket = new FakeWebSocket(url, protocols);
        seat.socket = socket;
        api.sockets.push(socket);
        return socket;
      },
    });
    seat.unsubscribe = seat.store.subscribe('ABC234', (event) => {
      if (event.type === 'room') seat.rooms.push(event.room);
    });
    return seat;
  });
  await settle(() => seats.every((seat) => seat.socket !== null), 'sockets were not created');
  for (const seat of seats) seat.socket.emit('open');
  // 소켓이 열리면 모두 한 번 읽는다(놓친 방송을 메운다) — 이것은 측정에서 뺀다
  await settle(() => seats.every((seat) => seat.rooms.length > 0), 'first snapshots were not delivered');
  return seats;
}

function readyOf(room) {
  return room.players.map((player) => player.isReady);
}

function everyoneSees(seats, expected) {
  return seats.every((seat) => {
    const latest = seat.rooms.at(-1);
    return latest && JSON.stringify(readyOf(latest)) === JSON.stringify(expected);
  });
}

/**
 * N명이 한 사람씩(앞 사람의 변화가 모두에게 닿은 뒤) 준비를 켜고, 다시 모두 한꺼번에 끈다.
 * 화면이 실제로 보내는 것과 같은 저장소 호출(`setReady`)을 쓰고, 방 GET 수를 센다.
 */
async function readyBurst({ versioned, players }) {
  const members = Array.from({ length: players }, (_, index) => playerId(index));
  const api = createFakeApi({ members, versioned });
  const seats = await joinClassroom(api, members);
  const opened = api.counts.roomGets;
  try {
    const expected = members.map(() => false);
    for (const [index, seat] of seats.entries()) {
      const result = await seat.store.setReady({ code: 'ABC234', isReady: true });
      assert.equal(result.ok, true);
      expected[index] = true;
      await settle(() => everyoneSees(seats, expected), `toggle ${index} did not reach everyone`);
    }
    const oneByOne = api.counts.roomGets - opened;

    await Promise.all(seats.map((seat) => seat.store.setReady({ code: 'ABC234', isReady: false })));
    await settle(() => everyoneSees(seats, members.map(() => false)), 'the concurrent burst did not settle');
    const together = api.counts.roomGets - opened - oneByOne;
    // 어느 쪽이든 모두가 서버와 같은 방을 본다
    for (const seat of seats) assert.deepEqual(readyOf(seat.rooms.at(-1)), readyOf({ players: api.room }));
    return { oneByOne, together, puts: api.counts.readyPuts };
  } finally {
    for (const seat of seats) seat.unsubscribe();
  }
}

test('측정: 8명 방의 준비 토글 16번에서 방 GET이 #106 API의 N²에서 0으로 준다', async () => {
  const players = 8;
  const before = await readyBurst({ versioned: false, players });
  const after = await readyBurst({ versioned: true, players });

  // 한 사람씩: #106 API에서는 토글마다 방 전원이 다시 읽는다 — 8 × 8 = 64
  assert.equal(before.oneByOne, players * players);
  // 한꺼번에: 구독마다 하나만 띄우고 합쳐도 사람마다 적어도 한 번은 읽는다
  assert.ok(before.together >= players, `${before.together}`);
  // 판 번호가 있으면 모두 바로 앞 번호의 방에 덧대어 고친다
  assert.equal(after.oneByOne, 0);
  assert.equal(after.together, 0);
  assert.equal(before.puts, after.puts);
  console.log(
    `[fan-out] ${players}명·준비 토글 ${after.puts}번 — 방 GET: #106 API ${before.oneByOne + before.together}`
    + ` (한 사람씩 ${before.oneByOne}, 한꺼번에 ${before.together}) → 이 API ${after.oneByOne + after.together}`,
  );
});

/** 한 사람의 구독 하나와 그 소켓. 방송을 손으로 넣어 본다 */
async function soloSubscription({ versioned = true } = {}) {
  const members = [playerId(0), playerId(1)];
  const api = createFakeApi({ members, versioned });
  const [seat] = await joinClassroom(api, [members[0]]);
  return {
    api,
    seat,
    emit(event) {
      seat.socket.emit('message', { data: JSON.stringify(event) });
    },
    gets: () => api.counts.roomGets,
  };
}

test('이미 담은 번호의 무효화는 다시 읽지 않고, 번호가 없거나 모르는 묶음·건너뛴 번호면 다시 읽는다', async () => {
  const { api, seat, emit, gets } = await soloSubscription();
  try {
    const start = gets();
    const label = seat.rooms.length;
    // 처음 읽은 방(번호 0) 뒤로 서버에서 두 번 바뀌었다 — 그 방송이 늦게 온다
    api.bump();
    api.bump();
    // 담은 번호(0) 이하는 건너뛴다
    emit({ type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 0 });
    await tick();
    assert.equal(gets(), start);

    // 고칠 거리가 없는 변화는 다시 읽는다
    emit({ type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 1 });
    await settle(() => seat.rooms.length === label + 1, 'unversioned change was not read');
    assert.equal(gets(), start + 1);
    // 다시 읽은 방은 번호 2를 담았다 — 늦게 온 1·2는 건너뛴다
    emit({ type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 2 });
    emit({ type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 1 });
    await tick();
    await tick();
    assert.equal(gets(), start + 1);

    // 번호가 없는 방송(#106)은 늘 다시 읽는다
    emit({ type: 'room-invalidated' });
    await settle(() => gets() === start + 2, 'a legacy invalidation was skipped');

    // 다른 묶음(서버를 다시 띄웠다)의 번호는 견주지 않는다 — 작아 보여도 다시 읽는다
    await settle(() => seat.rooms.length === label + 2, 'legacy refresh was not delivered');
    api.restart('fanout-epoch-b2');
    emit({ type: 'room-invalidated', roomEpoch: 'fanout-epoch-b2', roomVersion: 0 });
    await settle(() => gets() === start + 3, 'a new epoch was compared with the old one');

    // 바로 앞 번호가 가진 방과 맞지 않으면(그 사이 놓친 변화가 있다) 고치지 않고 다시 읽는다
    await settle(() => seat.rooms.length === label + 3, 'restart refresh was not delivered');
    api.bump();
    api.bump();
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-b2', roomVersion: 2,
      readyChange: { previousVersion: 1, playerId: playerId(1), isReady: true },
    });
    await settle(() => gets() === start + 4, 'a ready change was applied across a gap');
  } finally {
    seat.unsubscribe();
  }
});

test('준비 고칠 거리는 바로 앞 번호의 방에만 덧대고, 그 사람이 없거나 모양이 깨졌으면 다시 읽는다', async () => {
  const { api, seat, emit, gets } = await soloSubscription();
  try {
    const start = gets();
    const before = seat.rooms.length;
    api.bump();
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 1,
      readyChange: { previousVersion: 0, playerId: playerId(1), isReady: true },
    });
    await settle(() => seat.rooms.length === before + 1, 'ready change was not delivered');
    assert.equal(gets(), start);
    assert.deepEqual(readyOf(seat.rooms.at(-1)), [false, true]);
    // 고친 방은 새 객체다 — 앞의 방을 고쳐 쓰지 않는다(화면이 앞뒤를 견준다)
    assert.deepEqual(readyOf(seat.rooms.at(-2)), [false, false]);

    // 방에 없는 사람(나간 것을 먼저 들었다)
    api.bump();
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 2,
      readyChange: { previousVersion: 1, playerId: playerId(7), isReady: true },
    });
    await settle(() => gets() === start + 1, 'a change for an unknown player was applied');
    await settle(() => seat.rooms.length === before + 2, 'refresh was not delivered');

    // 깨진 고칠 거리(앞 번호가 이번 번호 이상, 준비가 글자)
    api.bump();
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 3,
      readyChange: { previousVersion: 3, playerId: playerId(1), isReady: false },
    });
    await settle(() => gets() === start + 2, 'a malformed change was applied');
    await settle(() => seat.rooms.length === before + 3, 'refresh was not delivered');
    api.bump();
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 4,
      readyChange: { previousVersion: 3, playerId: playerId(1), isReady: 'yes' },
    });
    await settle(() => gets() === start + 3, 'a malformed change was applied');
  } finally {
    seat.unsubscribe();
  }
});

test('날아가는 재조회가 있으면 고치지 않고 기다린다 — 그 응답이 이미 담았으면 후속 조회도 건너뛴다', async () => {
  const { api, seat, emit, gets } = await soloSubscription();
  try {
    const start = gets();
    const before = seat.rooms.length;
    api.control.pauseGets = true;
    // 서버가 준비 토글을 commit하고 번호(1)를 올렸다. 그 방송보다 번호 없는 방송이 먼저 와 재조회가 뜬다 —
    // 재조회는 번호 1 뒤에 읽는다(번호 1을 담았다)
    api.room[1].isReady = true;
    api.bump();
    emit({ type: 'room-invalidated' });
    await settle(() => api.paused.length === 1, 'refresh did not start');
    // 재조회 중에 온 고칠 거리는 덧대지 않는다 — 날아가는 응답이 무엇을 담았는지 아직 모른다
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 1,
      readyChange: { previousVersion: 0, playerId: playerId(1), isReady: true },
    });
    await tick();
    assert.equal(seat.rooms.length, before);
    api.paused.shift()();
    await settle(() => seat.rooms.length === before + 1, 'refresh was not delivered');
    await tick();
    await tick();
    // 응답이 번호 1을 담았다 — 합친 후속 조회가 할 일이 없다
    assert.equal(gets(), start + 1);
    assert.equal(api.paused.length, 0);
    assert.deepEqual(readyOf(seat.rooms.at(-1)), [false, true]);
  } finally {
    api.control.pauseGets = false;
    seat.unsubscribe();
  }
});

test('날아가던 재조회가 고칠 거리보다 앞선 번호면 한 번 더 읽는다 (애매하면 GET)', async () => {
  const { api, seat, emit, gets } = await soloSubscription();
  try {
    const start = gets();
    const before = seat.rooms.length;
    api.control.pauseGets = true;
    emit({ type: 'room-invalidated' });
    await settle(() => api.paused.length === 1, 'refresh did not start');
    // 재조회가 번호(0)를 읽은 뒤에 준비 토글이 commit되고 번호 1이 났다
    api.room[1].isReady = true;
    api.bump();
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 1,
      readyChange: { previousVersion: 0, playerId: playerId(1), isReady: true },
    });
    await tick();
    api.paused.shift()();
    await settle(() => api.paused.length === 1, 'the queued follow-up did not start');
    assert.equal(gets(), start + 2);
    api.paused.shift()();
    await settle(() => seat.rooms.length === before + 2, 'follow-up was not delivered');
    assert.deepEqual(readyOf(seat.rooms.at(-1)), [false, true]);
  } finally {
    api.control.pauseGets = false;
    seat.unsubscribe();
  }
});

test('번호를 모르는 #106 API와는 오늘과 똑같이 무효화마다 다시 읽는다', async () => {
  const { seat, emit, gets } = await soloSubscription({ versioned: false });
  try {
    const start = gets();
    const before = seat.rooms.length;
    // 번호를 흉내 낸 방송이 와도, 가진 방에 번호가 없으면 건너뛸 근거가 없다
    emit({
      type: 'room-invalidated', roomEpoch: 'fanout-epoch-a1', roomVersion: 1,
      readyChange: { previousVersion: 0, playerId: playerId(0), isReady: true },
    });
    await settle(() => seat.rooms.length === before + 1, 'refresh was not delivered');
    assert.equal(gets(), start + 1);
    emit({ type: 'room-invalidated' });
    await settle(() => seat.rooms.length === before + 2, 'refresh was not delivered');
    assert.equal(gets(), start + 2);
  } finally {
    seat.unsubscribe();
  }
});
