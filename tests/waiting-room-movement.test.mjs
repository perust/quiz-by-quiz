import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('waiting room publishes normalized own movement and projects authenticated remote movement', async () => {
  const [waiting, adapter, html] = await Promise.all([
    source('../src/ui/waiting-room.ts'),
    source('../src/online/adapter.ts'),
    source('../index.html'),
  ]);

  assert.match(waiting, /createMovementPublisher/);
  assert.match(waiting, /createPlayerMovementController/);
  assert.match(waiting, /onMove:\s*\(point, moving\)/);
  assert.match(waiting, /roomStore\.sendMovement/);
  assert.match(waiting, /event\.type === 'movement'/);
  assert.match(waiting, /event\.playerId !== roomStore\.me\(\)/);
  assert.match(waiting, /remoteMovements\.reconcile/);
  assert.match(waiting, /remoteMovements\.reset\(\)/);
  assert.match(waiting, /remoteBubbles\.bind\(player\.id, bubble\)/);
  assert.match(adapter, /sendMovement\(spec:/);
  assert.match(html, /id="waiting-remote-characters"/);
});

test('walker reports placement, walking frames, and the final stopped position', async () => {
  const walker = await source('../src/ui/walker.ts');

  assert.match(walker, /onMove\?:\s*\(point: Point, moving: boolean\)/);
  assert.match(walker, /onMove\?\.\(\{ \.\.\.pos \}, false\)/);
  assert.match(walker, /onMove\?\.\(\{ \.\.\.pos \}, true\)/);
  assert.match(walker, /wasMoving/);
});
