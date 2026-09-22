import test from 'node:test';
import assert from 'node:assert/strict';

const MATCH_ID = '12345678-1234-5678-9234-567812345678';

function runningMatch() {
  return {
    matchId: MATCH_ID,
    state: 'running',
    categoryId: 'history',
    gameMode: false,
    currentPosition: 1,
    totalQuestions: 10,
    deadlineAt: '2026-09-18T11:00:20+00:00',
    question: {
      id: 'history-001', categoryId: 'history', question: '서버 문제',
      choices: ['1번', '2번', '3번', '4번'], position: 1, total: 10,
    },
    ownSubmission: null,
    reveal: null,
    scores: [],
  };
}

test('socket invalidation recovery opens only the current non-finished server match', async () => {
  const { recoverActiveNetworkMatch } = await import('../js/online/match-recovery.js');
  const opened = [];

  const recovered = await recoverActiveNetworkMatch('ABC234', {
    getMatch: async () => runningMatch(),
    isStillCurrent: () => true,
    hasOpenMatch: () => false,
    openMatch: async (code) => { opened.push(code); },
  });

  assert.equal(recovered, true);
  assert.deepEqual(opened, ['ABC234']);
});

test('socket invalidation recovery leaves terminal or stale matches in the waiting room', async () => {
  const { recoverActiveNetworkMatch } = await import('../js/online/match-recovery.js');
  let opened = 0;

  const terminal = await recoverActiveNetworkMatch('ABC234', {
    getMatch: async () => ({ ...runningMatch(), state: 'finished', deadlineAt: null, question: null }),
    isStillCurrent: () => true,
    hasOpenMatch: () => false,
    openMatch: async () => { opened += 1; },
  });
  const stale = await recoverActiveNetworkMatch('ABC234', {
    getMatch: async () => runningMatch(),
    isStillCurrent: () => false,
    hasOpenMatch: () => false,
    openMatch: async () => { opened += 1; },
  });

  assert.equal(terminal, false);
  assert.equal(stale, false);
  assert.equal(opened, 0);
});

test('socket invalidation recovery absorbs a snapshot transport failure without local fallback', async () => {
  const { recoverActiveNetworkMatch } = await import('../js/online/match-recovery.js');
  let opened = 0;

  const recovered = await recoverActiveNetworkMatch('ABC234', {
    getMatch: async () => { throw new Error('offline'); },
    isStillCurrent: () => true,
    hasOpenMatch: () => false,
    openMatch: async () => { opened += 1; },
  });

  assert.equal(recovered, false);
  assert.equal(opened, 0);
});
