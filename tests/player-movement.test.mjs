import test from 'node:test';
import assert from 'node:assert/strict';

function createNode() {
  const classes = new Set();
  return {
    hidden: true,
    style: { transform: '' },
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

test('remote movement rejects stale sequence but accepts a new socket generation', async () => {
  const { createPlayerMovementController } = await import('../js/ui/player-movement.js');
  const movement = createPlayerMovementController();
  const node = createNode();
  movement.reconcile(['remote-1']);
  movement.bind('remote-1', node);

  movement.update({
    playerId: 'remote-1', x: 0.8, y: 0.4, moving: true,
    sequence: 8, connectionGeneration: 3,
  });
  movement.update({
    playerId: 'remote-1', x: 0.1, y: 0.1, moving: false,
    sequence: 7, connectionGeneration: 3,
  });
  assert.equal(node.style.transform, 'translate(80vw, 40vh) translate(-50%, -100%)');
  assert.equal(node.classList.contains('walker--walking'), true);

  movement.update({
    playerId: 'remote-1', x: 0.2, y: 0.3, moving: false,
    sequence: 1, connectionGeneration: 4,
  });
  assert.equal(node.style.transform, 'translate(20vw, 30vh) translate(-50%, -100%)');
  assert.equal(node.classList.contains('walker--walking'), false);
  assert.equal(node.classList.contains('walker--idle'), true);
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

  publisher.update({ x: 0.5, y: 0.5, moving: false });
  publisher.update({ x: 0.55, y: 0.5, moving: true });
  clock.advance(30);
  publisher.update({ x: 0.65, y: 0.5, moving: true });
  assert.deepEqual(sent, [{ x: 0.5, y: 0.5, moving: false }]);

  clock.advance(70);
  assert.deepEqual(sent.at(-1), { x: 0.65, y: 0.5, moving: true });
  assert.equal(sent.length, 2);

  clock.advance(20);
  publisher.update({ x: 0.66, y: 0.5, moving: false });
  assert.deepEqual(sent.at(-1), { x: 0.66, y: 0.5, moving: false });
  assert.equal(sent.length, 3);
  assert.equal(clock.pending(), 0);
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

  publisher.update({ x: 0.1, y: 0.2, moving: false });
  publisher.update({ x: 0.2, y: 0.2, moving: true });
  assert.equal(clock.pending(), 1);
  publisher.resend();
  assert.equal(clock.pending(), 0);
  assert.deepEqual(sent.at(-1), { x: 0.2, y: 0.2, moving: true });

  publisher.update({ x: 0.3, y: 0.2, moving: true });
  assert.equal(clock.pending(), 1);
  publisher.reset();
  clock.advance(200);
  assert.equal(sent.length, 2);
  assert.equal(clock.pending(), 0);
});
