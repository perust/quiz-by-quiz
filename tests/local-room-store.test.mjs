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
