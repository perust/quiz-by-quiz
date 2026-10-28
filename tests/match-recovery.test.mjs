import test from 'node:test';
import assert from 'node:assert/strict';

const MATCH_ID = '12345678-1234-5678-9234-567812345678';

function runningMatch() {
  return {
    matchId: MATCH_ID,
    state: 'running',
    categoryId: 'history',
    gameMode: true,
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

// N01 리뷰 client-retry-5: 넘어가지 않은 답은 방송하지 않으므로, 대기실 복구의 GET이 요청 한도(429)에
// 걸려 조용히 끝나면 다음 phase 방송까지(문항 하나) 대기실에 남는다. match controller와 같이 한 번 다시 보낸다.

async function rateLimited(retryAfterMs) {
  const { ApiFailure } = await import('../js/online/rules.js');
  return new ApiFailure(429, 'rate-limited', '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.', retryAfterMs);
}

test('socket invalidation recovery retries a rate-limited read once after Retry-After and jitter', async () => {
  const { recoverActiveNetworkMatch } = await import('../js/online/match-recovery.js');
  const limited = await rateLimited(2_000);
  const opened = [];
  const slept = [];
  let reads = 0;

  const recovered = await recoverActiveNetworkMatch('ABC234', {
    getMatch: async () => {
      reads += 1;
      if (reads === 1) throw limited;
      return runningMatch();
    },
    isStillCurrent: () => true,
    hasOpenMatch: () => false,
    openMatch: async (code) => { opened.push(code); },
    sleep: async (delayMs) => { slept.push(delayMs); },
    random: () => 0.5,
  });

  assert.equal(recovered, true);
  assert.equal(reads, 2);
  // Retry-After 2초 + jitter(0.5 × 500ms) — controller와 같은 rateLimitRetryDelayMs
  assert.deepEqual(slept, [2_250]);
  assert.deepEqual(opened, ['ABC234']);
});

test('socket invalidation recovery does not retry after leaving the screen or when the match opened meanwhile', async () => {
  const { recoverActiveNetworkMatch } = await import('../js/online/match-recovery.js');
  const limited = await rateLimited(null);
  let opened = 0;

  for (const moved of ['left', 'opened']) {
    let reads = 0;
    let waited = false;
    const recovered = await recoverActiveNetworkMatch('ABC234', {
      getMatch: async () => {
        reads += 1;
        throw limited;
      },
      isStillCurrent: () => !(waited && moved === 'left'),
      hasOpenMatch: () => waited && moved === 'opened',
      openMatch: async () => { opened += 1; },
      sleep: async () => { waited = true; },
      random: () => 0,
    });
    assert.equal(recovered, false);
    assert.equal(reads, 1, `${moved}: 기다린 뒤에는 보내지 않는다`);
  }
  assert.equal(opened, 0);
});

test('socket invalidation recovery retries at most once and never retries other failures', async () => {
  const { recoverActiveNetworkMatch } = await import('../js/online/match-recovery.js');
  const { ApiFailure } = await import('../js/online/rules.js');
  const limited = await rateLimited(500);
  let opened = 0;

  let reads = 0;
  const twice = await recoverActiveNetworkMatch('ABC234', {
    getMatch: async () => {
      reads += 1;
      throw limited;
    },
    isStillCurrent: () => true,
    hasOpenMatch: () => false,
    openMatch: async () => { opened += 1; },
    sleep: async () => undefined,
    random: () => 0,
  });
  assert.equal(twice, false);
  assert.equal(reads, 2, '다시 보낸 GET도 429면 그만둔다');

  let otherReads = 0;
  let slept = 0;
  const unavailable = await recoverActiveNetworkMatch('ABC234', {
    getMatch: async () => {
      otherReads += 1;
      throw new ApiFailure(503, 'database-unavailable', '온라인 연결이 잠시 원활하지 않아요.');
    },
    isStillCurrent: () => true,
    hasOpenMatch: () => false,
    openMatch: async () => { opened += 1; },
    sleep: async () => { slept += 1; },
  });
  assert.equal(unavailable, false);
  assert.equal(otherReads, 1);
  assert.equal(slept, 0);
  assert.equal(opened, 0);
});
