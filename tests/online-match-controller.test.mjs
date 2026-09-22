import test from 'node:test';
import assert from 'node:assert/strict';

const MATCH_ID = '12345678-1234-5678-9234-567812345678';

function runningMatch(changes = {}) {
  return {
    matchId: MATCH_ID,
    state: 'running',
    categoryId: 'history',
    gameMode: false,
    currentPosition: 1,
    totalQuestions: 10,
    deadlineAt: '2026-09-18T11:00:20+00:00',
    question: {
      id: 'history-001',
      categoryId: 'history',
      question: '서버 문제',
      choices: ['1번', '2번', '3번', '4번'],
      position: 1,
      total: 10,
    },
    ownSubmission: null,
    reveal: null,
    scores: [],
    ...changes,
  };
}

function revealingMatch(changes = {}) {
  const running = runningMatch();
  return {
    ...running,
    state: 'revealing',
    ownSubmission: null,
    reveal: { position: 1, choiceIndex: 2, timedOut: false, correct: true, answerIndex: 2, explanation: '서버 해설' },
    scores: [{
      playerId: MATCH_ID,
      nickname: '퀴즈왕',
      characterId: 'slime-blue',
      score: 10,
      correctCount: 1,
      answeredCount: 1,
    }],
    ...changes,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

test('online match controller는 구독을 먼저 열고 authorization-bound snapshot만 그린다', async () => {
  const calls = [];
  const snapshots = [];
  const gateway = {
    subscribe(code, handler) {
      calls.push(`subscribe:${code}`);
      assert.equal(typeof handler, 'function');
      return () => calls.push('unsubscribe');
    },
    async getMatch(code) {
      calls.push(`get:${code}`);
      return runningMatch();
    },
    async submitMatchAnswer() {
      throw new Error('not used');
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');

  assert.deepEqual(calls, ['subscribe:ABC234', 'get:ABC234']);
  assert.deepEqual(snapshots, [runningMatch()]);
  controller.close();
  assert.equal(calls.at(-1), 'unsubscribe');
});

test('match invalidation은 기존 payload를 믿지 않고 새 snapshot을 다시 읽는다', async () => {
  const snapshots = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      return reads === 1 ? runningMatch() : revealingMatch();
    },
    async submitMatchAnswer() {
      throw new Error('not used');
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => snapshots.length === 2, 'invalidation did not refresh snapshot');

  assert.equal(reads, 2);
  assert.equal(snapshots[1].state, 'revealing');
  assert.equal(snapshots[1].reveal.explanation, '서버 해설');
  controller.close();
});

test('답안 제출 뒤에는 response를 local 채점하지 않고 fresh snapshot을 다시 읽는다', async () => {
  const submitted = [];
  const snapshots = [];
  let reads = 0;
  const gateway = {
    subscribe() {
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      return reads === 1 ? runningMatch() : revealingMatch();
    },
    async submitMatchAnswer(spec) {
      submitted.push(spec);
      return {
        match: runningMatch({ ownSubmission: { position: 1, choiceIndex: 2, timedOut: false } }),
        accepted: true,
        advanced: false,
      };
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');
  await controller.submit({ position: 1, choiceIndex: 2 });

  assert.deepEqual(submitted, [{ code: 'ABC234', position: 1, choiceIndex: 2 }]);
  assert.equal(reads, 2);
  assert.equal(snapshots.at(-1).state, 'revealing');
  assert.equal(snapshots.at(-1).reveal.correct, true);
  controller.close();
});

test('닫은 controller는 늦게 끝난 snapshot을 화면에 반영하지 않는다', async () => {
  const snapshots = [];
  let resolveMatch;
  const gateway = {
    subscribe() {
      return () => undefined;
    },
    getMatch() {
      return new Promise((resolve) => { resolveMatch = resolve; });
    },
    async submitMatchAnswer() {
      throw new Error('not used');
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onMissing: () => assert.fail('closed controller must not announce missing'),
    onError: (message) => assert.fail(message),
  });

  const opening = controller.open('ABC234');
  controller.close();
  resolveMatch(runningMatch());
  await opening;

  assert.deepEqual(snapshots, []);
});
