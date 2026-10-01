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

function storedRoom(code, hostId, players) {
  return {
    code,
    name: `${code} 방`,
    categoryId: 'history',
    capacity: 4,
    isPublic: true,
    gameMode: true,
    password: '',
    hostId,
    players,
    createdAt: new Date(0).toISOString(),
  };
}

function player(id, seenAt) {
  return {
    id,
    nickname: id,
    characterId: 'slime-blue',
    isReady: false,
    seenAt,
  };
}

test('local room은 나간 방장과 만료된 방장을 첫 생존 참가자에게 승계한다', async () => {
  const localStorage = memoryStorage();
  globalThis.window = { localStorage };
  const now = Date.now();

  localStorage.setItem('quiz.playerId', 'host');
  localStorage.setItem('quiz.rooms', JSON.stringify([
    storedRoom('LEAVE1', 'host', [player('host', now), player('guest', now)]),
  ]));

  const { localRooms: hostRooms } = await import('../js/online/local-rooms.js?host-leave-transfer');
  await hostRooms.leaveRoom({ code: 'LEAVE1' });

  let stored = JSON.parse(localStorage.getItem('quiz.rooms'));
  assert.equal(stored[0].hostId, 'guest');
  assert.equal(stored[0].players[0].id, 'guest');

  localStorage.setItem('quiz.playerId', 'guest');
  const { localRooms: guestRooms } = await import('../js/online/local-rooms.js?host-leave-successor');
  const transferred = await guestRooms.getRoom('LEAVE1');
  assert.equal(transferred?.isMine, true);
  assert.equal(transferred?.players[0].id, 'guest');
  assert.deepEqual(await guestRooms.startGame({ code: 'LEAVE1' }), {
    ok: true,
    setup: { categoryId: 'history', gameMode: true },
  });

  localStorage.setItem('quiz.rooms', JSON.stringify([
    storedRoom('PRUNE1', 'expired-host', [
      player('expired-host', now - (7 * 60 * 60 * 1000)),
      player('guest', now),
    ]),
  ]));
  const { localRooms: prunedRooms } = await import('../js/online/local-rooms.js?host-prune-transfer');
  const pruned = await prunedRooms.getRoom('PRUNE1');

  assert.equal(pruned?.isMine, true);
  assert.equal(pruned?.players[0].id, 'guest');
  stored = JSON.parse(localStorage.getItem('quiz.rooms'));
  assert.equal(stored[0].hostId, 'guest');
  assert.equal(stored[0].players[0].id, 'guest');

  localStorage.setItem('quiz.playerId', 'host');
  localStorage.setItem('quiz.rooms', JSON.stringify([
    storedRoom('ORDER1', 'host', [player('guest', now), player('host', now)]),
  ]));
  const { localRooms: reorderedRooms } = await import('../js/online/local-rooms.js?host-order-repair');
  const reordered = await reorderedRooms.getRoom('ORDER1');

  assert.equal(reordered?.isMine, true);
  assert.equal(reordered?.players[0].id, 'host');
  stored = JSON.parse(localStorage.getItem('quiz.rooms'));
  assert.equal(stored[0].players[0].id, 'host');
});
