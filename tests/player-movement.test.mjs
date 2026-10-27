import test from 'node:test';
import assert from 'node:assert/strict';

function createNode(viewport) {
  const classes = new Set();
  return {
    hidden: true,
    style: { transform: '' },
    ...(viewport ? {
      ownerDocument: {
        defaultView: { innerWidth: viewport.width, innerHeight: viewport.height },
      },
    } : {}),
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
  };
}

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const ready = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!ready) break;
        const [id, timer] = ready;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

test('viewport movement uses the same bounded normalized coordinates on every screen', async () => {
  const { normalizeViewportMovement } = await import('../js/ui/player-movement.js');

  assert.deepEqual(
    normalizeViewportMovement({ x: 390, y: 422 }, false, { width: 390, height: 844 }),
    {
      x: 1, y: 0.5, moving: false, viewportWidth: 390, viewportHeight: 844,
    },
  );
  assert.deepEqual(
    normalizeViewportMovement({ x: -5, y: 1000 }, true, { width: 390, height: 844 }),
    {
      x: 0, y: 1, moving: true, viewportWidth: 390, viewportHeight: 844,
    },
  );
  assert.equal(
    normalizeViewportMovement({ x: 10, y: 10 }, true, { width: 0, height: 844 }),
    null,
  );
  assert.equal(
    normalizeViewportMovement({ x: 10, y: 10 }, true, { width: 8193, height: 844 }),
    null,
  );
});

test('seat movement carries only known seat ids and remote walkers re-anchor in the receiver lounge', async () => {
  const {
    createPlayerMovementController,
    normalizeViewportMovement,
  } = await import('../js/ui/player-movement.js');

  assert.deepEqual(
    normalizeViewportMovement(
      { x: 195, y: 422 }, false, { width: 390, height: 844 }, 'sofa-left',
    ),
    {
      x: 0.5, y: 0.5, moving: false,
      viewportWidth: 390, viewportHeight: 844,
      seatId: 'sofa-left',
    },
  );
  assert.equal(
    normalizeViewportMovement(
      { x: 195, y: 422 }, false, { width: 390, height: 844 }, 'table',
    ),
    null,
  );
  assert.equal(
    normalizeViewportMovement(
      { x: 195, y: 422 }, true, { width: 390, height: 844 }, 'sofa-left',
    ),
    null,
  );

  let anchor = { x: 120, y: 300 };
  const movement = createPlayerMovementController({
    seatPoint: (seatId) => (seatId === 'sofa-left' ? anchor : null),
  });
  const node = createNode({ width: 390, height: 844 });
  movement.reconcile(['remote-1']);
  movement.bind('remote-1', node);
  movement.update({
    playerId: 'remote-1', x: 0.4, y: 0.7, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    seatId: 'sofa-left', sequence: 1, connectionGeneration: 1,
  });
  assert.equal(node.style.transform, 'translate(120px, 300px) translate(-50%, -100%)');
  assert.equal(node.classList.contains('walker--seated'), true);
  assert.equal(node.classList.contains('walker--idle'), false);

  assert.equal(movement.update({
    playerId: 'remote-1', x: 0.41, y: 0.7, moving: true,
    viewportWidth: 390, viewportHeight: 844,
    seatId: 'sofa-left', sequence: 2, connectionGeneration: 1,
  }), false);
  assert.equal(node.style.transform, 'translate(120px, 300px) translate(-50%, -100%)');
  assert.equal(node.classList.contains('walker--seated'), true);

  anchor = { x: 130, y: 260 };
  movement.refresh();
  assert.equal(node.style.transform, 'translate(130px, 260px) translate(-50%, -100%)');

  anchor = { x: -40, y: 900 };
  movement.refresh();
  assert.equal(node.style.transform, 'translate(0px, 844px) translate(-50%, -100%)');

  movement.update({
    playerId: 'remote-1', x: 0.42, y: 0.7, moving: true,
    viewportWidth: 390, viewportHeight: 844,
    sequence: 2, connectionGeneration: 1,
  });
  assert.equal(node.classList.contains('walker--seated'), false);
  assert.equal(node.classList.contains('walker--walking'), true);
});

test('remote seated walkers are visible before seat measurement on first frame and rebind', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const anchor = { x: 120, y: 300 };
  const movement = createPlayerMovementController({
    seatPoint: (_seatId, node) => (node.hidden ? null : anchor),
  });
  movement.reconcile(['remote-1']);

  const first = createNode({ width: 390, height: 844 });
  movement.bind('remote-1', first);
  movement.update({
    playerId: 'remote-1', x: 0.4, y: 0.7, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    seatId: 'sofa-left', sequence: 1, connectionGeneration: 1,
  });
  assert.equal(first.hidden, false);
  assert.equal(first.style.transform, 'translate(120px, 300px) translate(-50%, -100%)');

  movement.unbindAll();
  const rebound = createNode({ width: 390, height: 844 });
  movement.bind('remote-1', rebound);
  assert.equal(rebound.hidden, false);
  assert.equal(rebound.style.transform, 'translate(120px, 300px) translate(-50%, -100%)');
});

test('remote walkers do not use a seated pose when the local seat cannot be measured', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const movement = createPlayerMovementController({ seatPoint: () => null });
  const node = createNode({ width: 390, height: 844 });
  movement.reconcile(['remote-1']);
  movement.bind('remote-1', node);
  movement.update({
    playerId: 'remote-1', x: 0.4, y: 0.7, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    seatId: 'sofa-left', sequence: 1, connectionGeneration: 1,
  });

  assert.equal(node.classList.contains('walker--seated'), false);
  assert.equal(node.classList.contains('walker--idle'), true);
});

test('remote seat expiry clears the seated pose without accepting a new sequence', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const node = createNode({ width: 390, height: 844 });
  const movement = createPlayerMovementController({
    seatPoint: () => ({ x: 240, y: 360 }),
  });
  movement.reconcile(['remote-1']);
  movement.bind('remote-1', node);

  assert.equal(movement.update({
    playerId: 'remote-1', x: 0.2, y: 0.3, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    seatId: 'sofa-right', sequence: 9, connectionGeneration: 1,
  }), true);
  assert.equal(node.classList.contains('walker--seated'), true);

  movement.clearSeat('remote-1');
  assert.equal(node.classList.contains('walker--seated'), false);
  assert.equal(node.classList.contains('walker--idle'), true);
  assert.equal(
    node.style.transform,
    'translate(clamp(0px, calc(50vw - 117px), 100vw), clamp(0px, calc(50vh - 168.8px), 100vh)) translate(-50%, -100%)',
  );

  // Lease expiry is local projection state, not a network frame, so sequence 10 remains valid.
  assert.equal(movement.update({
    playerId: 'remote-1', x: 0.4, y: 0.5, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    seatId: 'sofa-right', sequence: 10, connectionGeneration: 1,
  }), true);
  assert.equal(node.classList.contains('walker--seated'), true);
});

test('sender viewport metadata preserves CSS-pixel speed across different receiver widths', async () => {
  const {
    normalizeViewportMovement,
    remoteMovementOffset,
  } = await import('../js/ui/player-movement.js');

  const mobileStart = normalizeViewportMovement(
    { x: 100, y: 400 }, true, { width: 390, height: 844 },
  );
  const mobileEnd = normalizeViewportMovement(
    { x: 180, y: 400 }, true, { width: 390, height: 844 },
  );
  const desktopStart = normalizeViewportMovement(
    { x: 500, y: 400 }, true, { width: 1440, height: 900 },
  );
  const desktopEnd = normalizeViewportMovement(
    { x: 580, y: 400 }, true, { width: 1440, height: 900 },
  );

  assert.ok(mobileStart && mobileEnd && desktopStart && desktopEnd);
  const mobileDistance = remoteMovementOffset(mobileEnd).x - remoteMovementOffset(mobileStart).x;
  const desktopDistance = remoteMovementOffset(desktopEnd).x - remoteMovementOffset(desktopStart).x;
  assert.ok(Math.abs(mobileDistance - 80) < 0.1);
  assert.ok(Math.abs(desktopDistance - 80) < 0.1);
  assert.ok(Math.abs(mobileDistance - desktopDistance) < 0.1);
});

test('remote movement projects only current players and survives room rerenders', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const movement = createPlayerMovementController();
  const first = createNode();

  movement.update({
    playerId: 'remote-1', x: 0.25, y: 0.75, moving: true,
    sequence: 7, connectionGeneration: 1,
  });
  movement.reconcile(['remote-1']);
  movement.bind('remote-1', first);

  assert.equal(first.hidden, false);
  assert.equal(first.style.transform, 'translate(25vw, 75vh) translate(-50%, -100%)');
  assert.equal(first.classList.contains('walker--walking'), true);
  assert.equal(first.classList.contains('walker--idle'), false);

  movement.unbindAll();
  const rebound = createNode();
  movement.bind('remote-1', rebound);
  assert.equal(rebound.hidden, false);
  assert.equal(rebound.style.transform, first.style.transform);

  movement.reconcile([]);
  assert.equal(rebound.hidden, true);
  const stale = createNode();
  movement.bind('remote-1', stale);
  assert.equal(stale.hidden, true);
});

test('remote movement uses sender pixel offsets while legacy events retain viewport projection', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const movement = createPlayerMovementController();
  const node = createNode();
  movement.reconcile(['remote-1']);
  movement.bind('remote-1', node);

  movement.update({
    playerId: 'remote-1',
    x: 0.75,
    y: 0.25,
    moving: true,
    viewportWidth: 390,
    viewportHeight: 844,
    sequence: 1,
    connectionGeneration: 1,
  });
  assert.equal(
    node.style.transform,
    'translate(clamp(0px, calc(50vw + 97.5px), 100vw), clamp(0px, calc(50vh - 211px), 100vh)) translate(-50%, -100%)',
  );

  movement.update({
    playerId: 'remote-1', x: 0.2, y: 0.3, moving: false,
    sequence: 2, connectionGeneration: 1,
  });
  assert.equal(node.style.transform, 'translate(20vw, 30vh) translate(-50%, -100%)');
});

test('remote name edge placement follows the projected receiver position', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const desktopNode = createNode({ width: 1440, height: 900 });
  const desktopMovement = createPlayerMovementController();
  desktopMovement.reconcile(['mobile']);
  desktopMovement.bind('mobile', desktopNode);
  desktopMovement.update({
    playerId: 'mobile', x: 0, y: 0.9, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    sequence: 1, connectionGeneration: 1,
  });
  assert.equal(desktopNode.classList.contains('walker--name-left'), false);
  assert.equal(desktopNode.classList.contains('walker--name-above'), false);

  const mobileNode = createNode({ width: 390, height: 844 });
  const mobileMovement = createPlayerMovementController();
  mobileMovement.reconcile(['desktop']);
  mobileMovement.bind('desktop', mobileNode);
  mobileMovement.update({
    playerId: 'desktop', x: 0.3, y: 0.5, moving: false,
    viewportWidth: 1440, viewportHeight: 900,
    sequence: 1, connectionGeneration: 1,
  });
  assert.equal(mobileNode.classList.contains('walker--name-left'), true);
});

test('remote movement rejects stale sequence but accepts a new socket generation', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const movement = createPlayerMovementController();
  const node = createNode();
  movement.reconcile(['remote-1']);
  movement.bind('remote-1', node);

  assert.equal(movement.update({
    playerId: 'remote-1', x: 0.8, y: 0.4, moving: true,
    sequence: 8, connectionGeneration: 3,
  }), true);
  assert.equal(movement.update({
    playerId: 'remote-1', x: 0.1, y: 0.1, moving: false,
    sequence: 7, connectionGeneration: 3,
  }), false);
  assert.equal(node.style.transform, 'translate(80vw, 40vh) translate(-50%, -100%)');
  assert.equal(node.classList.contains('walker--walking'), true);

  movement.update({
    playerId: 'remote-1', x: 0.2, y: 0.3, moving: false,
    sequence: 1, connectionGeneration: 4,
  });
  assert.equal(node.style.transform, 'translate(20vw, 30vh) translate(-50%, -100%)');
  assert.equal(node.classList.contains('walker--walking'), false);
  assert.equal(node.classList.contains('walker--idle'), true);

  movement.update({
    playerId: 'remote-1', x: 0.2, y: 0.98, moving: false,
    sequence: 2, connectionGeneration: 4,
  });
  assert.equal(node.classList.contains('walker--name-above'), true);
  assert.equal(node.classList.contains('walker--name-left'), true);
  movement.update({
    playerId: 'remote-1', x: 0.9, y: 0.5, moving: false,
    sequence: 3, connectionGeneration: 4,
  });
  assert.equal(node.classList.contains('walker--name-above'), false);
  assert.equal(node.classList.contains('walker--name-left'), false);
  assert.equal(node.classList.contains('walker--name-right'), true);
});

test('movement reset prevents a previous room position from projecting into a new room', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const movement = createPlayerMovementController();
  movement.update({
    playerId: 'same-player', x: 0.4, y: 0.6, moving: true,
    sequence: 1, connectionGeneration: 1,
  });
  movement.reconcile(['same-player']);
  const oldNode = createNode();
  movement.bind('same-player', oldNode);
  assert.equal(oldNode.hidden, false);

  movement.reset();
  const newNode = createNode();
  movement.reconcile(['same-player']);
  movement.bind('same-player', newNode);
  assert.equal(oldNode.hidden, true);
  assert.equal(newNode.hidden, true);
});

test('movement publisher throttles walking frames, keeps the latest sample, and sends stop immediately', async () => {
  const clock = createClock();
  const sent = [];
  const { createMovementPublisher } = await import('../js/ui/player-movement.js');
  const publisher = createMovementPublisher({
    intervalMs: 100,
    send: (sample) => sent.push({ ...sample }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const viewport = { viewportWidth: 390, viewportHeight: 844 };
  publisher.update({ x: 0.5, y: 0.5, moving: false, ...viewport });
  publisher.update({ x: 0.55, y: 0.5, moving: true, ...viewport });
  clock.advance(30);
  publisher.update({ x: 0.65, y: 0.5, moving: true, ...viewport });
  assert.deepEqual(sent, [{ x: 0.5, y: 0.5, moving: false, ...viewport }]);

  clock.advance(70);
  assert.deepEqual(sent.at(-1), { x: 0.65, y: 0.5, moving: true, ...viewport });
  assert.equal(sent.length, 2);

  clock.advance(20);
  publisher.update({ x: 0.66, y: 0.5, moving: false, ...viewport });
  assert.deepEqual(sent.at(-1), { x: 0.66, y: 0.5, moving: false, ...viewport });
  assert.equal(sent.length, 3);
  assert.equal(clock.pending(), 0);
});

test('movement publisher clears a seated claim immediately and never resends it', async () => {
  const sent = [];
  const { createMovementPublisher } = await import('../js/ui/player-movement.js');
  const publisher = createMovementPublisher({
    send: (sample) => sent.push({ ...sample }),
    now: () => 0,
  });
  const seated = {
    x: 0.5, y: 0.5, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    seatId: 'sofa-left',
  };

  publisher.update(seated);
  publisher.clearSeat();
  publisher.resend();

  assert.deepEqual(sent, [
    seated,
    {
      x: 0.5, y: 0.5, moving: false,
      viewportWidth: 390, viewportHeight: 844,
    },
    {
      x: 0.5, y: 0.5, moving: false,
      viewportWidth: 390, viewportHeight: 844,
    },
  ]);
});

test('movement publisher resend and reset do not leak a prior room timer', async () => {
  const clock = createClock();
  const sent = [];
  const { createMovementPublisher } = await import('../js/ui/player-movement.js');
  const publisher = createMovementPublisher({
    intervalMs: 100,
    send: (sample) => sent.push({ ...sample }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const viewport = { viewportWidth: 1440, viewportHeight: 900 };
  publisher.update({ x: 0.1, y: 0.2, moving: false, ...viewport });
  publisher.update({ x: 0.2, y: 0.2, moving: true, ...viewport });
  assert.equal(clock.pending(), 1);
  publisher.resend();
  assert.equal(clock.pending(), 0);
  assert.deepEqual(sent.at(-1), { x: 0.2, y: 0.2, moving: true, ...viewport });

  publisher.update({ x: 0.3, y: 0.2, moving: true, ...viewport });
  assert.equal(clock.pending(), 1);
  publisher.reset();
  clock.advance(200);
  assert.equal(sent.length, 2);
  assert.equal(clock.pending(), 0);
});

// ── 공유 무대 좌표 (U31) ─────────────────────────────────────────────
// 화면 중심의 px만으로는 휴대폰에서 3번 칸에 선 사람이 데스크톱에서는 질문 위나 다른 칸 위에 보였다.
// 발이 무대 안이면 무대에 맞춘 0~1 좌표를 함께 보내고, 같은 무대를 보이는 화면은 제 무대에 세운다.

/** 휴대폰 세로: 질문·보기 아래 화면 끝 쪽의 바닥 */
const PHONE_ARENA = { left: 16, top: 560, width: 358, height: 172 };
/** 데스크톱: 가운데 열의 바닥이 화면 중심보다 위에 있다 */
const DESKTOP_ARENA = { left: 480, top: 380, width: 480, height: 172 };

test('U31: 무대 좌표는 무대 안에서만 0~1이고, 다른 화면의 같은 무대에 같은 칸으로 돌아온다', async () => {
  const { movementStageUnit, movementStagePoint } = await import('../js/ui/player-movement.js');

  // 휴대폰에서 3번 칸(왼쪽 아래)의 아래쪽에 섰다
  const phoneFoot = { x: 16 + 358 * 0.25, y: 560 + 172 * 0.8 };
  const unit = movementStageUnit(PHONE_ARENA, phoneFoot);
  assert.deepEqual(unit, { x: 0.25, y: 0.8 });
  const onDesktop = movementStagePoint(DESKTOP_ARENA, unit);
  assert.deepEqual(onDesktop, { x: 480 + 480 * 0.25, y: 380 + 172 * 0.8 });
  // 데스크톱의 3번 칸 안이다 — 왼쪽 절반, 아래 절반
  assert.ok(onDesktop.x < DESKTOP_ARENA.left + DESKTOP_ARENA.width / 2);
  assert.ok(onDesktop.y > DESKTOP_ARENA.top + DESKTOP_ARENA.height / 2);

  // 십자 한가운데는 어느 화면이든 한가운데다
  assert.deepEqual(movementStageUnit(PHONE_ARENA, { x: 16 + 179, y: 560 + 86 }), { x: 0.5, y: 0.5 });

  // 무대 밖(보기 버튼·질문 위)은 무대 좌표가 없다 — 예전 길(화면 중심의 px)로 간다
  assert.equal(movementStageUnit(PHONE_ARENA, { x: 100, y: 300 }), null);
  assert.equal(movementStageUnit(PHONE_ARENA, { x: 400, y: 600 }), null);
  // 잴 수 없는 무대(숨은 화면의 0px)는 쓰지 않는다
  assert.equal(movementStageUnit({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 }), null);
  assert.equal(movementStageUnit(null, { x: 0, y: 0 }), null);
  assert.equal(movementStagePoint(DESKTOP_ARENA, { x: 1.2, y: 0.5 }), null);
  assert.equal(movementStagePoint(DESKTOP_ARENA, { x: Number.NaN, y: 0.5 }), null);
});

test('U31: 라운지는 벽과 바닥 두 띠다 — 바닥은 어느 화면이든 같은 px라 가구 앞의 자리가 그대로 맞는다', async () => {
  const { movementStageUnit, movementStagePoint, MOVEMENT_STAGE_FLOOR_UNIT } = await import('../js/ui/player-movement.js');
  assert.equal(MOVEMENT_STAGE_FLOOR_UNIT, 0.5);

  // 휴대폰: 액자 한 줄이라 라운지 360px, 바닥 176px. 데스크톱: 액자 두 줄과 58svh로 라운지 640px
  const phone = { left: 16, top: 400, width: 358, height: 360, floorTop: 360 - 176 };
  const desktop = { left: 300, top: 200, width: 840, height: 640, floorTop: 640 - 176 };

  // 바닥 아래 끝에서 30px 위(탁자 앞)에 섰다
  const unit = movementStageUnit(phone, { x: 16 + 179, y: 400 + 360 - 30 });
  assert.ok(unit.y > 0.5);
  const onDesktop = movementStagePoint(desktop, unit);
  // 한 줄로 늘였다면 640 × (330/360) = 587 → 53px 위였다. 바닥 띠로 맞추면 30px 위 그대로다
  assert.ok(Math.abs((desktop.top + desktop.height - onDesktop.y) - 30) < 0.5, `${onDesktop.y}`);
  assert.ok(Math.abs(onDesktop.x - (300 + 420)) < 0.5);

  // 벽 띠(액자 앞)는 벽의 비율로 맞춘다
  const wall = movementStageUnit(phone, { x: 100, y: 400 + 92 });
  assert.ok(wall.y < 0.5);
  const wallOnDesktop = movementStagePoint(desktop, wall);
  assert.ok(Math.abs((wallOnDesktop.y - desktop.top) / desktop.floorTop - 92 / phone.floorTop) < 0.001);

  // 경계는 0.5이고 바닥 높이를 잴 수 없는 무대는 쓰지 않는다
  assert.equal(movementStageUnit(phone, { x: 100, y: 400 + 184 }).y, 0.5);
  assert.equal(movementStageUnit({ ...phone, floorTop: 0 }, { x: 100, y: 500 }), null);
  assert.equal(movementStageUnit({ ...phone, floorTop: 360 }, { x: 100, y: 500 }), null);
});

test('U31: 보낼 표본은 지금 배치로 무대 좌표를 다시 잰다 — 무대 밖이면 셋 다 뗀다', async () => {
  const { normalizeViewportMovement, withMovementStage } = await import('../js/ui/player-movement.js');
  const sample = normalizeViewportMovement(
    { x: 16 + 358 * 0.25, y: 560 + 172 * 0.8 }, false, { width: 390, height: 844 },
  );

  const staged = withMovementStage(sample, { id: 'arena', frame: PHONE_ARENA });
  assert.equal(staged.stage, 'arena');
  assert.ok(Math.abs(staged.stageX - 0.25) <= 0.0005);
  assert.ok(Math.abs(staged.stageY - 0.8) <= 0.0005);
  // 예전 필드는 그대로 남는다 — 무대 좌표를 모르는 화면이 그것으로 그린다
  assert.equal(staged.x, sample.x);
  assert.equal(staged.viewportWidth, 390);

  // 스크롤로 무대가 올라가 발이 무대 밖이 됐다
  const scrolled = withMovementStage(staged, { id: 'arena', frame: { ...PHONE_ARENA, top: 100 } });
  assert.equal('stage' in scrolled, false);
  assert.equal('stageX' in scrolled, false);
  assert.equal('stageY' in scrolled, false);
  assert.equal(withMovementStage(staged, null).stage, undefined);
  assert.equal(withMovementStage(staged, { id: 'arena', frame: null }).stage, undefined);
});

test('U31: 수신 화면은 같은 무대면 제 무대의 자리에, 다른 무대·잴 수 없는 무대면 예전처럼 그린다', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  let arena = DESKTOP_ARENA;
  const movement = createPlayerMovementController({
    stageFrame: (stage) => (stage === 'arena' ? arena : null),
  });
  const node = createNode({ width: 1440, height: 900 });
  movement.reconcile(['phone']);
  movement.bind('phone', node);

  assert.equal(movement.update({
    playerId: 'phone', x: 0.25, y: 0.8, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    stage: 'arena', stageX: 0.25, stageY: 0.8,
    sequence: 1, connectionGeneration: 1,
  }), true);
  assert.equal(node.style.transform, 'translate(600px, 517.6px) translate(-50%, -100%)');

  // 스크롤로 무대가 움직이면 refresh가 다시 맞춘다
  arena = { ...DESKTOP_ARENA, top: 280 };
  movement.refresh();
  assert.equal(node.style.transform, 'translate(600px, 417.6px) translate(-50%, -100%)');
  // 무대가 화면 밖으로 밀려나면 캐릭터도 화면 밖이다 — 가장자리로 당겨 질문 위에 세우지 않는다
  arena = { ...DESKTOP_ARENA, top: -400 };
  movement.refresh();
  assert.equal(node.style.transform, 'translate(600px, -262.4px) translate(-50%, -100%)');

  // 이 화면이 그 무대를 보이지 않으면(다른 무대, 숨은 화면) 화면 중심의 px다
  arena = null;
  movement.refresh();
  assert.equal(
    node.style.transform,
    'translate(clamp(0px, calc(50vw - 97.5px), 100vw), clamp(0px, calc(50vh + 253.2px), 100vh)) translate(-50%, -100%)',
  );
  arena = DESKTOP_ARENA;
  movement.update({
    playerId: 'phone', x: 0.25, y: 0.8, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    stage: 'lounge', stageX: 0.25, stageY: 0.8,
    sequence: 2, connectionGeneration: 1,
  });
  assert.match(node.style.transform, /^translate\(clamp\(/);

  // 무대 좌표 없는 이전 화면의 이동은 오늘과 똑같다
  movement.update({
    playerId: 'phone', x: 0.75, y: 0.25, moving: true,
    viewportWidth: 390, viewportHeight: 844,
    sequence: 3, connectionGeneration: 1,
  });
  assert.equal(
    node.style.transform,
    'translate(clamp(0px, calc(50vw + 97.5px), 100vw), clamp(0px, calc(50vh - 211px), 100vh)) translate(-50%, -100%)',
  );
  movement.update({ playerId: 'phone', x: 0.2, y: 0.3, moving: false, sequence: 4, connectionGeneration: 1 });
  assert.equal(node.style.transform, 'translate(20vw, 30vh) translate(-50%, -100%)');

  // 셋 가운데 하나라도 어긋난 무대는 버리고 이동은 받는다
  assert.equal(movement.update({
    playerId: 'phone', x: 0.75, y: 0.25, moving: false,
    viewportWidth: 390, viewportHeight: 844,
    stage: 'arena', stageX: 1.5, stageY: 0.5,
    sequence: 5, connectionGeneration: 1,
  }), true);
  assert.match(node.style.transform, /^translate\(clamp\(/);
});

test('U31: 앉은 자리는 좌석이 먼저다 — 무대 좌표가 함께 와도 이 화면의 좌석에 앉힌다', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const movement = createPlayerMovementController({
    seatPoint: () => ({ x: 120, y: 300 }),
    stageFrame: () => ({ left: 0, top: 0, width: 1000, height: 600, floorTop: 424 }),
  });
  const node = createNode({ width: 1440, height: 900 });
  movement.reconcile(['remote']);
  movement.bind('remote', node);
  movement.update({
    playerId: 'remote', x: 0.4, y: 0.7, moving: false,
    viewportWidth: 390, viewportHeight: 844, seatId: 'sofa-left',
    stage: 'lounge', stageX: 0.5, stageY: 0.75,
    sequence: 1, connectionGeneration: 1,
  });
  assert.equal(node.style.transform, 'translate(120px, 300px) translate(-50%, -100%)');
  movement.clearSeat('remote');
  // 좌석을 비우면 라운지의 같은 자리에 선다
  assert.equal(node.style.transform, 'translate(500px, 512px) translate(-50%, -100%)');
});

test('U31: 무대가 움직이면 다시 잰 좌표가 달라졌을 때만, 걷는 frame과 같은 간격으로 묶어 보낸다', async () => {
  const clock = createClock();
  const sent = [];
  const { createMovementPublisher, withMovementStage } = await import('../js/ui/player-movement.js');
  let frame = { left: 0, top: 400, width: 390, height: 200 };
  const publisher = createMovementPublisher({
    intervalMs: 100,
    send: (sample) => sent.push({ ...sample }),
    restage: (sample) => withMovementStage(sample, { id: 'arena', frame }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const viewport = { viewportWidth: 390, viewportHeight: 844 };
  // 발은 (195, 500) — 무대 한가운데
  publisher.update({ x: 0.5, y: 500 / 844, moving: false, ...viewport });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'arena');
  assert.ok(Math.abs(sent[0].stageY - 0.5) < 0.001);

  // 같은 배치면 refresh는 보내지 않는다(이전 API 소켓에도 같은 말을 되풀이하지 않는다)
  publisher.refresh();
  assert.equal(sent.length, 1);

  // 스크롤 이벤트가 몰려도 간격 안에서는 하나로 묶고, 보낼 때 다시 잰다
  clock.advance(10);
  frame = { ...frame, top: 380 };
  publisher.refresh();
  frame = { ...frame, top: 360 };
  publisher.refresh();
  publisher.refresh();
  assert.equal(sent.length, 1);
  assert.equal(clock.pending(), 1);
  clock.advance(90);
  assert.equal(sent.length, 2);
  assert.ok(Math.abs(sent[1].stageY - 0.7) < 0.001, `${sent[1].stageY}`);

  // 무대 밖으로 밀려나면 무대 좌표를 뗀 이동이 한 번 간다
  clock.advance(200);
  frame = { ...frame, top: 0 };
  publisher.refresh();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].stage, undefined);
  // heartbeat(resend)도 보낼 때의 배치로 잰다
  frame = { left: 0, top: 400, width: 390, height: 200 };
  publisher.resend();
  assert.equal(sent.at(-1).stage, 'arena');

  // 무대를 다시 잴 수 없는 publisher(restage 없음)는 refresh가 아무것도 하지 않는다
  const plain = [];
  const legacy = createMovementPublisher({ send: (sample) => plain.push(sample), now: () => 0 });
  legacy.update({ x: 0.5, y: 0.5, moving: false, ...viewport });
  legacy.refresh();
  assert.equal(plain.length, 1);
});

test('U31: 지금 그려진 캐릭터의 발끝이 표본보다 먼저다 — 이동을 알리지 않고 옮겨 놓은 캐릭터도 맞다', async () => {
  const { normalizeViewportMovement, walkerFootPoint, withMovementStage } = await import('../js/ui/player-movement.js');
  // 표본은 공개 카드로 스크롤하기 전의 자리다(그 뒤 arena가 바닥의 같은 자리로 옮겼지만 알리지 않았다)
  const stale = normalizeViewportMovement({ x: 105.5, y: 697.6 }, false, { width: 390, height: 844 });
  const scrolledArena = { ...PHONE_ARENA, top: 360 };
  const foot = walkerFootPoint({
    getBoundingClientRect: () => ({ left: 85.5, top: 449.6, width: 40, height: 48, bottom: 497.6 }),
  });
  assert.deepEqual(foot, { x: 105.5, y: 497.6 });
  const staged = withMovementStage(stale, { id: 'arena', frame: scrolledArena, foot });
  assert.deepEqual([staged.stageX, staged.stageY], [0.25, 0.8]);
  // 표본만으로 쟀다면 바닥 밖이라 무대 좌표가 없었다
  assert.equal(withMovementStage(stale, { id: 'arena', frame: scrolledArena }).stage, undefined);
  // 그려지지 않은 캐릭터는 잴 수 없다 — 표본으로 돌아간다
  assert.equal(walkerFootPoint({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0 }) }), null);
  assert.equal(withMovementStage(stale, { id: 'arena', frame: PHONE_ARENA, foot: null }).stage, 'arena');
});

test('U31: 배치가 바뀌어 다시 세운 자리는 전환 없이 옮기고, 다음 이동이 오면 다시 잇는다', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const { loadStyles, node: cssNode, valueOf, DESKTOP } = await import('./css-cascade.mjs');
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const transitionOf = (classes) => valueOf(
    rules,
    cssNode(`div.walker.walker--remote${classes}`, cssNode('div#online-remote-characters', cssNode('body'))),
    'transition',
    DESKTOP,
  );
  // 125ms frame 사이는 전환이 잇지만, 배치 때문에 다시 세운 자리는 곧바로 옮긴다 (앉은 자리와 같다)
  assert.match(transitionOf(''), /^transform 145ms/);
  assert.equal(transitionOf('.walker--relayout'), 'none');
  assert.equal(transitionOf('.walker--seated'), 'none');

  let arena = DESKTOP_ARENA;
  const movement = createPlayerMovementController({
    stageFrame: (stage) => (stage === 'arena' ? arena : null),
  });
  const node = createNode({ width: 1440, height: 900 });
  const relayout = () => node.classList.contains('walker--relayout');
  movement.reconcile(['phone', 'legacy']);
  movement.bind('phone', node);
  movement.update({
    playerId: 'phone', x: 0.25, y: 0.8, moving: true,
    viewportWidth: 390, viewportHeight: 844,
    stage: 'arena', stageX: 0.25, stageY: 0.8,
    sequence: 1, connectionGeneration: 1,
  });
  assert.equal(node.style.transform, 'translate(600px, 517.6px) translate(-50%, -100%)');
  assert.equal(relayout(), false, '새 이동은 앞 자리에서 전환으로 잇는다');

  // 다시 그렸지만 쓸 자리가 같다(바닥이 그대로다) — 걷는 사이를 잇던 전환을 끊지 않는다
  movement.refresh();
  assert.equal(relayout(), false);

  // 스크롤로 바닥이 올라갔다 — 바닥을 늦게 따라 미끄러지지 않게 곧바로 옮긴다
  arena = { ...DESKTOP_ARENA, top: 280 };
  movement.refresh();
  assert.equal(node.style.transform, 'translate(600px, 417.6px) translate(-50%, -100%)');
  assert.equal(relayout(), true);
  // 공개 카드로 한 번에 내려가도 같다 — 질문 위를 지나 제 칸으로 가지 않는다
  arena = { ...DESKTOP_ARENA, top: -120 };
  movement.refresh();
  assert.equal(node.style.transform, 'translate(600px, 17.6px) translate(-50%, -100%)');
  assert.equal(relayout(), true);

  // 다음 이동이 오면 떼어 그 자리에서 새 자리로 잇는다
  movement.update({
    playerId: 'phone', x: 0.3, y: 0.8, moving: true,
    viewportWidth: 390, viewportHeight: 844,
    stage: 'arena', stageX: 0.3, stageY: 0.8,
    sequence: 2, connectionGeneration: 1,
  });
  assert.equal(node.style.transform, 'translate(624px, 17.6px) translate(-50%, -100%)');
  assert.equal(relayout(), false);

  // 명단을 다시 그려 새 DOM에 붙인 캐릭터도 배치다 — 기본 자리에서 미끄러져 오지 않는다
  const rebound = createNode({ width: 1440, height: 900 });
  movement.unbindAll();
  movement.reconcile(['phone', 'legacy']);
  movement.bind('phone', rebound);
  assert.equal(rebound.style.transform, 'translate(624px, 17.6px) translate(-50%, -100%)');
  assert.equal(rebound.classList.contains('walker--relayout'), true);

  // 화면 중심의 px 자리(무대 좌표 없는 이전 화면)는 스크롤해도 쓸 값이 같아 예전처럼 전환을 그대로 둔다
  const legacy = createNode({ width: 1440, height: 900 });
  movement.bind('legacy', legacy);
  movement.update({
    playerId: 'legacy', x: 0.75, y: 0.25, moving: true,
    viewportWidth: 390, viewportHeight: 844,
    sequence: 1, connectionGeneration: 1,
  });
  assert.equal(legacy.classList.contains('walker--relayout'), false);
  arena = { ...DESKTOP_ARENA, top: 40 };
  movement.refresh();
  assert.equal(legacy.classList.contains('walker--relayout'), false);
  assert.equal(rebound.classList.contains('walker--relayout'), true);
});
