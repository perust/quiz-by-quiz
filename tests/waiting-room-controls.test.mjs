import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function player(id, isReady, connected = true) {
  return {
    id,
    nickname: id,
    characterId: 'slime-blue',
    isReady,
    connected,
  };
}

function room(changes = {}) {
  return {
    code: 'ABC234',
    name: '역할 검증방',
    categoryId: null,
    capacity: 4,
    gameMode: true,
    players: [player('host', false), player('guest', false)],
    isPublic: true,
    hasPassword: false,
    isMine: false,
    joined: true,
    createdAt: '2026-09-25T00:00:00.000Z',
    ...changes,
  };
}

async function controls(roomSnapshot, playerId) {
  const module = await import('../js/ui/waiting-room-action.js');
  assert.equal(
    typeof module.waitingRoomControls,
    'function',
    'waiting-room must expose its role/start control policy',
  );
  return module.waitingRoomControls(roomSnapshot, playerId);
}

test('participant keeps ready available and never sees the host start control', async () => {
  assert.deepEqual(
    await controls(room({ players: [player('host', true), player('guest', true)] }), 'guest'),
    {
      readyHidden: false,
      readyDisabled: false,
      startHidden: true,
      startDisabled: true,
    },
  );
});

// U28: 방장의 시작 요청이 곧 방장의 준비다. 예전 테스트는 방장도 「준비 완료」를 눌러야
// 시작이 켜지는 동작을 잠갔다 — 서버(start_game)와 함께 규칙을 바꿨다.
test('host is implicitly ready: start needs one more connected member and every non-host ready', async () => {
  assert.deepEqual(
    await controls(room({ isMine: true, players: [player('host', true)] }), 'host'),
    {
      readyHidden: true,
      readyDisabled: false,
      startHidden: false,
      startDisabled: true,
    },
  );
  assert.deepEqual(
    await controls(room({ isMine: true, players: [player('host', false), player('guest', true)] }), 'host'),
    {
      readyHidden: true,
      readyDisabled: false,
      startHidden: false,
      startDisabled: false,
    },
  );
  assert.deepEqual(
    await controls(room({ isMine: true, players: [player('host', true), player('guest', false)] }), 'host'),
    {
      readyHidden: true,
      readyDisabled: false,
      startHidden: false,
      startDisabled: true,
    },
  );
});

test('members disconnected past the grace are neither awaited nor counted, like the server', async () => {
  // 준비 안 한 사람이 오래 끊겼으면 기다리지 않는다
  assert.equal((await controls(room({
    isMine: true,
    players: [player('host', false), player('guest', true), player('ghost', false, false)],
  }), 'host')).startDisabled, false);
  // 끊긴 사람만 남았으면 최소 인원이 안 된다
  assert.equal((await controls(room({
    isMine: true,
    players: [player('host', false), player('ghost', true, false)],
  }), 'host')).startDisabled, true);
  // 내 소켓이 끊겨 있어도 시작을 누르는 방장 자신은 센다
  assert.equal((await controls(room({
    isMine: true,
    players: [player('host', false, false), player('guest', true)],
  }), 'host')).startDisabled, false);
});

test('missing local membership keeps both room actions fail-closed', async () => {
  assert.deepEqual(
    await controls(room({ isMine: true, joined: false }), 'missing'),
    {
      readyHidden: true,
      readyDisabled: true,
      startHidden: false,
      startDisabled: true,
    },
  );
});

test('local rooms mirror the host-ready rule: the host never needs ready, others still do', async () => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };
  values.set('quiz.playerId', 'host');
  const now = Date.now();
  const stored = (guestReady) => JSON.stringify([{
    code: 'READY2',
    name: '로컬 준비',
    categoryId: null,
    capacity: 4,
    isPublic: true,
    gameMode: true,
    password: '',
    hostId: 'host',
    players: [
      { id: 'host', nickname: '방장', characterId: 'slime-blue', isReady: false, seenAt: now },
      { id: 'guest', nickname: '친구', characterId: 'slime-blue', isReady: guestReady, seenAt: now },
    ],
    createdAt: new Date(0).toISOString(),
  }]);
  const { localRooms } = await import('../js/online/local-rooms.js?host-implicit-ready');

  values.set('quiz.rooms', stored(false));
  assert.deepEqual(await localRooms.startGame({ code: 'READY2' }), { ok: false, reason: 'not-ready' });
  values.set('quiz.rooms', stored(true));
  assert.equal((await localRooms.startGame({ code: 'READY2' })).ok, true);
  const loaded = await localRooms.getRoom('READY2');
  assert.deepEqual(loaded?.players.map(({ connected }) => connected), [true, true]);
});

test('waiting-room render applies the policy and start is hidden before the first snapshot', async () => {
  const [html, waiting] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/waiting-room.ts', import.meta.url), 'utf8'),
  ]);
  const startTag = html.match(/<button[^>]*id="waiting-start"[^>]*>/)?.[0] ?? '';

  assert.match(startTag, /\shidden(?:\s|>)/);
  assert.match(startTag, /aria-describedby="waiting-start-status"/);
  assert.match(html, /<p class="waiting-start-status" id="waiting-start-status" role="status"><\/p>/);
  assert.match(waiting, /const controls = waitingRoomControls\(room, roomStore\.me\(\)\);/);
  assert.match(waiting, /el\.ready\.hidden = controls\.readyHidden;/);
  assert.match(waiting, /el\.ready\.disabled = controls\.readyDisabled;/);
  assert.match(waiting, /el\.start\.hidden = controls\.startHidden;/);
  assert.match(waiting, /el\.start\.disabled = controls\.startDisabled;/);
  assert.match(waiting, /setStartStatus\(waitingRoomStartStatus\(room, roomStore\.me\(\), \{\s*canInvite: roomStore\.isNetworked,\s*\}\)\);/);
  // 꺼진 버튼의 click에만 있던 «왜 시작할 수 없는지» 문구는 상태 줄로 옮겼다
  assert.doesNotMatch(waiting, /참가자가 두 명 이상이고 모두 준비해야/);
});
