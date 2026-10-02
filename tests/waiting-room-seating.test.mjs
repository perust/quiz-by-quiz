import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('좌석 선택은 재선택·자리 이동을 처리하고 충돌 승자를 결정한다', async () => {
  const {
    createWaitingRoomSeatLeaseController,
    isWaitingRoomSeatId,
    nextWaitingRoomSeat,
    WAITING_ROOM_SEAT_IDS,
    waitingRoomSeatWinner,
  } = await import('../js/ui/waiting-room-seating.js');

  assert.deepEqual(WAITING_ROOM_SEAT_IDS, [
    'chair-left', 'sofa-left', 'sofa-right', 'chair-right',
  ]);
  assert.equal(isWaitingRoomSeatId('sofa-left'), true);
  assert.equal(isWaitingRoomSeatId('table'), false);
  assert.equal(nextWaitingRoomSeat(null, 'chair-left'), 'chair-left');
  assert.equal(nextWaitingRoomSeat('chair-left', 'chair-left'), null);
  assert.equal(nextWaitingRoomSeat('chair-left', 'sofa-right'), 'sofa-right');

  assert.equal(waitingRoomSeatWinner('sofa-left', [
    { playerId: 'player-z', seatId: 'sofa-left' },
    { playerId: 'player-a', seatId: 'chair-left' },
    { playerId: 'player-b', seatId: 'sofa-left' },
  ]), 'player-b');
  assert.equal(waitingRoomSeatWinner('chair-right', []), null);

  let nextTimer = 1;
  const callbacks = new Map();
  const cancelled = [];
  const expired = [];
  const leases = createWaitingRoomSeatLeaseController({
    staleMs: 70_000,
    onExpire: (playerId) => expired.push(playerId),
    schedule: (callback, delay) => {
      assert.equal(delay, 70_000);
      const timer = nextTimer++;
      callbacks.set(timer, callback);
      return timer;
    },
    cancel: (timer) => cancelled.push(timer),
  });

  leases.refresh('player-a');
  leases.refresh('player-a');
  callbacks.get(1)();
  assert.deepEqual(expired, [], 'a replaced timer cannot expire the fresh claim');
  callbacks.get(2)();
  assert.deepEqual(expired, ['player-a']);

  leases.refresh('player-b');
  leases.clear('player-b');
  callbacks.get(3)();
  assert.deepEqual(expired, ['player-a'], 'a standing frame cancels expiry');

  leases.refresh('player-c');
  leases.refresh('player-d');
  leases.retain(new Set(['player-c']));
  callbacks.get(5)();
  assert.deepEqual(expired, ['player-a'], 'a departed player cannot fire a stale timer');
  callbacks.get(4)();
  assert.deepEqual(expired, ['player-a', 'player-c']);
  assert.deepEqual(cancelled, [1, 3, 5]);
});

test('좌석 중심은 앉은 몸통이 방석 위에 오도록 높이를 보정하고 숨은 좌석은 배치하지 않는다', async () => {
  const { waitingRoomSeatPoint } = await import('../js/ui/waiting-room-seating.js');

  assert.deepEqual(
    waitingRoomSeatPoint({ left: 10, top: 20, width: 44, height: 40 }, 48),
    { x: 32, y: 46 },
  );
  assert.equal(
    waitingRoomSeatPoint({ left: 0, top: 0, width: 0, height: 40 }, 48),
    null,
  );
  assert.equal(
    waitingRoomSeatPoint({ left: 0, top: 0, width: 44, height: 40 }, 0),
    null,
  );
});

test('대기실 가구는 네 개의 접근 가능한 좌석과 장식 테이블을 제공한다', async () => {
  const html = await source('../index.html');

  for (const seat of ['chair-left', 'sofa-left', 'sofa-right', 'chair-right']) {
    assert.match(html, new RegExp(`<button[^>]+data-waiting-seat="${seat}"[^>]+aria-pressed="false"`));
  }
  assert.match(html, /class="lounge__table"[^>]+aria-hidden="true"/);
  assert.doesNotMatch(html, /lounge__furniture-hint|lounge-furniture-hint/);
});

test('착석은 워커를 좌석에 맞추고 이동·화면 이탈 때 반드시 해제한다', async () => {
  const [waiting, screenWalker, walker, css] = await Promise.all([
    source('../src/ui/waiting-room.ts'),
    source('../src/ui/screen-walker.ts'),
    source('../src/ui/walker.ts'),
    source('../css/style.css'),
  ]);

  assert.match(screenWalker, /placeAt\(point: Point, report\?: boolean\): void/);
  assert.match(walker, /placeAt\(point: Point, report\?: boolean\): void/);
  assert.match(waiting, /waitingRoomSeatPoint/);
  assert.match(waiting, /walker\.placeAt\(point/);
  assert.match(waiting, /if \(moving && seatedSeatId\) standUp\(\)/);
  assert.match(waiting, /normalizeViewportMovement\([\s\S]*?seatedSeatId \?\? undefined/);
  assert.match(waiting, /function applyRemoteSeat\([\s\S]*?movementPublisher\.clearSeat\(\)/);
  assert.match(waiting, /REMOTE_SEAT_STALE_MS = 70_000/);
  assert.match(waiting, /onExpire: \(playerId\) => \{[\s\S]*?remoteMovements\.clearSeat\(playerId\)/);
  assert.match(waiting, /remoteSeatLeases\.refresh\(playerId\)/);
  assert.match(waiting, /remoteSeatLeases\.clear\(playerId\)/);
  assert.match(waiting, /function resetSeating\(\): void \{[\s\S]*?remoteSeatLeases\.reset\(\)/);
  assert.match(waiting, /button\.disabled = occupiedByOther/);
  assert.match(waiting, /waitingRoomSeatWinner/);
  assert.match(waiting, /function resetSeating\(\): void/);
  assert.match(waiting, /async show\([\s\S]*?movementPublisher\.clearSeat\(\)[\s\S]*?visibleEntry = null/);
  assert.match(waiting, /hide\(\)[\s\S]*?movementPublisher\.clearSeat\(\)[\s\S]*?visibleEntry = null/);
  assert.match(waiting, /hide\(\)[\s\S]*?resetSeating\(\)/);
  assert.match(css, /\.walker--seated \.walker__body/);
  assert.match(css, /\.walker--remote\.walker--seated\s*\{[^}]*transition:\s*none/);
  assert.match(css, /\.lounge__seat\[aria-pressed='true'\]/);
  assert.match(css, /\.lounge__seat\.is-standing/);
});
