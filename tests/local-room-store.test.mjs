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
    player: { nickname: '공개방장' },
  });
  assert.equal(publicResult.ok, true);

  const privateResult = await localRooms.createRoom({
    name: '비공개 연습방',
    categoryId: 'science',
    capacity: 12,
    isPublic: false,
    password: 'secret-room',
    player: { nickname: '비공개방장' },
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
