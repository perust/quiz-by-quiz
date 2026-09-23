import assert from 'node:assert/strict';
import test from 'node:test';

function createClock() {
  let now = 1_000;
  let sequence = 0;
  const scheduled = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = ++sequence;
      scheduled.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer(id) {
      scheduled.delete(id);
    },
    advance(milliseconds) {
      now += milliseconds;
      const due = [...scheduled.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of due) {
        if (!scheduled.delete(id)) continue;
        timer.callback();
      }
    },
  };
}

function node() {
  return { hidden: true, textContent: '' };
}

test('remote player bubbles survive room rerenders and expire from the rebound node', async () => {
  const clock = createClock();
  const { createPlayerBubbleController } = await import('../js/ui/player-bubbles.js');
  const bubbles = createPlayerBubbleController({
    durationMs: 3_200,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const first = node();
  bubbles.bind('player-b', first);

  bubbles.show('player-b', '반가워!');
  assert.deepEqual(first, { hidden: false, textContent: '반가워!' });

  bubbles.unbindAll();
  const rebound = node();
  bubbles.bind('player-b', rebound);
  assert.deepEqual(rebound, { hidden: false, textContent: '반가워!' });

  clock.advance(3_200);
  assert.deepEqual(rebound, { hidden: true, textContent: '' });
});

test('a chat event received before the player snapshot projects when that figure binds', async () => {
  const clock = createClock();
  const { createPlayerBubbleController } = await import('../js/ui/player-bubbles.js');
  const bubbles = createPlayerBubbleController({
    durationMs: 3_200,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  bubbles.show('joining-player', '먼저 도착한 말');
  clock.advance(500);
  const lateFigure = node();
  bubbles.bind('joining-player', lateFigure);
  assert.deepEqual(lateFigure, { hidden: false, textContent: '먼저 도착한 말' });

  clock.advance(2_700);
  assert.deepEqual(lateFigure, { hidden: true, textContent: '' });
});

test('a newer message owns expiry and an older timer cannot hide it', async () => {
  const clock = createClock();
  const { createPlayerBubbleController } = await import('../js/ui/player-bubbles.js');
  const bubbles = createPlayerBubbleController({
    durationMs: 3_200,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const target = node();
  bubbles.bind('player-b', target);

  bubbles.show('player-b', '첫 말');
  clock.advance(1_000);
  bubbles.show('player-b', '새 말');
  clock.advance(2_200);
  assert.deepEqual(target, { hidden: false, textContent: '새 말' });

  clock.advance(1_000);
  assert.deepEqual(target, { hidden: true, textContent: '' });
});

test('reset clears pending bubbles so a previous room cannot project into a new room', async () => {
  const clock = createClock();
  const { createPlayerBubbleController } = await import('../js/ui/player-bubbles.js');
  const bubbles = createPlayerBubbleController({
    durationMs: 3_200,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const oldRoomNode = node();
  bubbles.bind('same-player-id', oldRoomNode);
  bubbles.show('same-player-id', '이전 방 메시지');

  bubbles.reset();
  const newRoomNode = node();
  bubbles.bind('same-player-id', newRoomNode);
  clock.advance(3_200);

  assert.deepEqual(oldRoomNode, { hidden: true, textContent: '' });
  assert.deepEqual(newRoomNode, { hidden: true, textContent: '' });
});

test('waiting room binds remote player figures to speech bubbles while keeping the chat log live region', async () => {
  const [waiting, html] = await Promise.all([
    import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/ui/waiting-room.ts', import.meta.url), 'utf8')),
    import('node:fs/promises').then(({ readFile }) => readFile(new URL('../index.html', import.meta.url), 'utf8')),
  ]);

  assert.match(waiting, /createPlayerBubbleController/);
  assert.match(waiting, /bubble\.className = 'lounge__bubble'/);
  assert.match(waiting, /bubble\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(waiting, /remoteBubbles\.bind\(player\.id, bubble\)/);
  assert.match(waiting, /remoteBubbles\.show\(event\.playerId, event\.text\)/);
  assert.match(
    waiting,
    /if \(event\.playerId === roomStore\.me\(\)\) \{\s*showBubble\(event\.text\);\s*\} else \{\s*remoteBubbles\.show\(event\.playerId, event\.text\);/,
  );
  assert.match(html, /id="chat-log" role="log" aria-live="polite"/);
});
