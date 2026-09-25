import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function player(id, isReady) {
  return {
    id,
    nickname: id,
    characterId: 'slime-blue',
    isReady,
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
      readyDisabled: false,
      startHidden: true,
      startDisabled: true,
    },
  );
});

test('host start control enables only with at least two fully ready members, including the host', async () => {
  assert.deepEqual(
    await controls(room({ isMine: true, players: [player('host', true)] }), 'host'),
    {
      readyDisabled: false,
      startHidden: false,
      startDisabled: true,
    },
  );
  assert.deepEqual(
    await controls(room({ isMine: true, players: [player('host', false), player('guest', true)] }), 'host'),
    {
      readyDisabled: false,
      startHidden: false,
      startDisabled: true,
    },
  );
  assert.deepEqual(
    await controls(room({ isMine: true, players: [player('host', true), player('guest', false)] }), 'host'),
    {
      readyDisabled: false,
      startHidden: false,
      startDisabled: true,
    },
  );
  assert.deepEqual(
    await controls(room({ isMine: true, players: [player('host', true), player('guest', true)] }), 'host'),
    {
      readyDisabled: false,
      startHidden: false,
      startDisabled: false,
    },
  );
});

test('missing local membership keeps both room actions fail-closed', async () => {
  assert.deepEqual(
    await controls(room({ isMine: true, joined: false }), 'missing'),
    {
      readyDisabled: true,
      startHidden: false,
      startDisabled: true,
    },
  );
});

test('waiting-room render applies the policy and start is hidden before the first snapshot', async () => {
  const [html, waiting] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/waiting-room.ts', import.meta.url), 'utf8'),
  ]);
  const startTag = html.match(/<button[^>]*id="waiting-start"[^>]*>/)?.[0] ?? '';

  assert.match(startTag, /\shidden(?:\s|>)/);
  assert.match(waiting, /const controls = waitingRoomControls\(room, roomStore\.me\(\)\);/);
  assert.match(waiting, /el\.ready\.disabled = controls\.readyDisabled;/);
  assert.match(waiting, /el\.start\.hidden = controls\.startHidden;/);
  assert.match(waiting, /el\.start\.disabled = controls\.startDisabled;/);
});
