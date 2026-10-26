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
  };
}

test('방 목록은 공개방과 비공개방을 모두 내보내되 비밀번호 원문은 노출하지 않는다', async () => {
  const localStorage = memoryStorage();
  globalThis.window = { localStorage };

  const { localRooms } = await import('../js/online/local-rooms.js?room-list-contract');

  const publicResult = await localRooms.createRoom({
    name: '공개 연습방',
    categoryId: 'history',
    capacity: 12,
    isPublic: true,
    player: { nickname: '공개방장', characterId: 'slime-blue' },
  });
  assert.equal(publicResult.ok, true);

  const privateResult = await localRooms.createRoom({
    name: '비공개 연습방',
    categoryId: 'science',
    capacity: 12,
    isPublic: false,
    password: 'secret-room',
    player: { nickname: '비공개방장', characterId: 'slime-blue' },
  });
  assert.equal(privateResult.ok, true);

  const rooms = await localRooms.listRooms();
  assert.equal(rooms.length, 2);
  assert.deepEqual(new Set(rooms.map(({ isPublic }) => isPublic)), new Set([true, false]));

  const privateRoom = rooms.find(({ isPublic }) => !isPublic);
  assert.equal(privateRoom?.hasPassword, true);
  assert.equal(Object.hasOwn(privateRoom ?? {}, 'password'), false);
  assert.equal(JSON.stringify(privateRoom).includes('secret-room'), false);
});

test('local started 이벤트는 다음 task에 오고 나간 방에는 전달되지 않는다', async () => {
  const localStorage = memoryStorage();
  globalThis.window = { localStorage };
  const { localRooms } = await import('../js/online/local-rooms.js?deferred-start-contract');

  const first = await localRooms.createRoom({
    name: '바로 나갈 방',
    categoryId: 'history',
    capacity: 2,
    isPublic: true,
    player: { nickname: '방장', characterId: 'slime-blue' },
  });
  assert.equal(first.ok, true);
  const staleEvents = [];
  const unsubscribe = localRooms.subscribe(first.room.code, (event) => staleEvents.push(event));

  const started = await localRooms.startGame({ code: first.room.code });
  assert.equal(started.ok, true);
  assert.equal(staleEvents.some((event) => event.type === 'match'), false);
  await localRooms.leaveRoom({ code: first.room.code });
  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(staleEvents.some((event) => event.type === 'match'), false);

  const second = await localRooms.createRoom({
    name: '시작할 방',
    categoryId: 'science',
    capacity: 2,
    isPublic: true,
    player: { nickname: '방장', characterId: 'slime-blue' },
  });
  assert.equal(second.ok, true);
  const liveEvents = [];
  const stop = localRooms.subscribe(second.room.code, (event) => liveEvents.push(event));
  await localRooms.startGame({ code: second.room.code });
  assert.equal(liveEvents.some((event) => event.type === 'match'), false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(liveEvents.filter((event) => event.type === 'match').length, 1);
  stop();
  await localRooms.leaveRoom({ code: second.room.code });
});

test('로컬 방도 방장이 고른 문항 시간(20초·40초)을 서버와 같은 규칙으로 담는다', async () => {
  const localStorage = memoryStorage();
  globalThis.window = { localStorage };
  const { localRooms } = await import('../js/online/local-rooms.js?question-time-contract');
  // 저장소는 이 파일의 첫 테스트가 고른 것이다(safe-storage는 처음 불릴 때 한 번 고른다). 같은 것을 만진다
  const { safeStorage } = await import('../js/storage/safe-storage.js');
  const player = { nickname: '시간방장', characterId: 'slime-blue' };

  const chosen = await localRooms.createRoom({
    name: '긴 시간 방', categoryId: null, capacity: 4, questionTimeMs: 40_000, isPublic: true, player,
  });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.room.questionTimeMs, 40_000);
  const code = chosen.room.code;

  // 문항 시간을 넘기지 않거나 모르는 값(제한 없음 포함)이면 기본 20초 방이다 — 인원과 같은 길이다
  for (const questionTimeMs of [undefined, null, 30_000, '40000']) {
    const created = await localRooms.createRoom({
      name: '기본 방', categoryId: null, capacity: 4, questionTimeMs, isPublic: true, player,
    });
    assert.equal(created.room.questionTimeMs, 20_000, String(questionTimeMs));
    await localRooms.leaveRoom({ code: created.room.code });
  }

  const events = [];
  const unsubscribe = localRooms.subscribe(code, (event) => events.push(event));
  const shorter = await localRooms.updateRoom({ code, patch: { questionTimeMs: 20_000 } });
  assert.equal(shorter.ok, true);
  assert.equal(shorter.room.questionTimeMs, 20_000);
  assert.equal(events.at(-1).room.questionTimeMs, 20_000, '모두에게 같은 방 모습이 간다');
  // 모르는 값은 무시하고 그대로 둔다. 다른 설정만 바꿔도 문항 시간은 그대로다
  assert.equal((await localRooms.updateRoom({ code, patch: { questionTimeMs: null } })).room.questionTimeMs, 20_000);
  assert.equal((await localRooms.updateRoom({ code, patch: { capacity: 6 } })).room.questionTimeMs, 20_000);
  assert.equal((await localRooms.updateRoom({ code, patch: { questionTimeMs: 40_000 } })).room.questionTimeMs, 40_000);
  unsubscribe();
  assert.equal((await localRooms.getRoom(code)).questionTimeMs, 40_000, '새로 읽어도 남는다');

  // 문항 시간이 생기기 전에 저장된 방은 20초로 읽는다
  const stored = JSON.parse(safeStorage.getItem('quiz.rooms'));
  const saved = stored.find((room) => room.code === code);
  delete saved.questionTimeMs;
  safeStorage.setItem('quiz.rooms', JSON.stringify(stored));
  assert.equal((await localRooms.getRoom(code)).questionTimeMs, 20_000);
  saved.questionTimeMs = 99_999;
  safeStorage.setItem('quiz.rooms', JSON.stringify(stored));
  assert.equal((await localRooms.getRoom(code)).questionTimeMs, 20_000);

  await localRooms.leaveRoom({ code });
});
