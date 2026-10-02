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

test('대기실은 숨은 화면의 0px 라운지를 좌상단 시작점으로 확정하지 않는다', async () => {
  const waiting = await source('../src/ui/waiting-room.ts');

  assert.match(
    waiting,
    /if \(el\.screen\.hidden \|\| box\.width === 0 \|\| box\.height === 0\) return null;/,
  );
});

test('대기실 워커는 중앙 가구가 아니라 왼쪽 빈 바닥에서 시작한다', async () => {
  const waiting = await source('../src/ui/waiting-room.ts');

  assert.match(
    waiting,
    /return \{ x: box\.left \+ 40, y: box\.bottom - 90 \};/,
  );
});

test('대기실 화면을 실제로 연 뒤 walker와 좌석을 다시 배치한다', async () => {
  const [app, waiting] = await Promise.all([
    source('../src/app.ts'),
    source('../src/ui/waiting-room.ts'),
  ]);

  assert.match(waiting, /export interface WaitingRoom \{[\s\S]*?activate\(\): void;/);
  assert.match(
    waiting,
    /activate\(\) \{\s*if \(el\.screen\.hidden\) return;\s*const point = waitingRoomStartPoint\(\);\s*if \(point\) walker\.placeAt\(point\);\s*alignSeatedWalkers\(\);\s*\}/,
  );
  assert.match(
    app,
    /goTo\('waiting'\);[\s\S]{0,260}?waitingRoom\.activate\(\);/,
  );
});
