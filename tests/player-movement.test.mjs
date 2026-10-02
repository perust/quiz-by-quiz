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
