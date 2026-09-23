import test from 'node:test';
import assert from 'node:assert/strict';

const MATCH_ID = '12345678-1234-5678-9234-567812345678';

function submitSpec(changes = {}) {
  return { token: 1, matchId: MATCH_ID, position: 1, choiceIndex: 2, ...changes };
}

function runningMatch(changes = {}) {
  return {
    matchId: MATCH_ID,
    state: 'running',
    categoryId: 'history',
    gameMode: true,
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
  await controller.submit(submitSpec());

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

test('newer refresh가 실패해도 먼저 성공한 overlap snapshot은 버리지 않는다', async () => {
  const snapshots = [];
  const errors = [];
  const pending = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
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
    onError: (message) => errors.push(message),
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => pending.length === 2, 'overlapping refreshes did not start');

  pending[0].resolve(revealingMatch());
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[1].reject(new Error('newer refresh failed'));
  await waitFor(() => errors.length === 1, 'newer refresh failure was not reported');

  assert.equal(snapshots.at(-1).state, 'revealing');
  assert.equal(snapshots.at(-1).reveal.explanation, '서버 해설');
  assert.deepEqual(errors, ['newer refresh failed']);
  controller.close();
});

test('성공한 answer mutation은 그 이전에 시작된 refresh 응답을 invalidate한다', async () => {
  const snapshots = [];
  const pendingReads = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve) => pendingReads.push(resolve));
    },
    async submitMatchAnswer() {
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
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => pendingReads.length === 1, 'pre-mutation refresh did not start');
  const submitting = controller.submit(submitSpec());
  await waitFor(() => pendingReads.length === 2, 'post-mutation refresh did not start');

  pendingReads[0](runningMatch({ question: { ...runningMatch().question, question: 'stale snapshot' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(snapshots.length, 1);

  pendingReads[1](revealingMatch());
  await submitting;
  assert.equal(snapshots.at(-1).state, 'revealing');
  controller.close();
});

test('newer refresh 성공 뒤 늦은 older snapshot은 화면을 rollback하지 않는다', async () => {
  const snapshots = [];
  const pending = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve) => pending.push(resolve));
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
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => pending.length === 2, 'overlapping refreshes did not start');

  pending[1](revealingMatch());
  await waitFor(() => snapshots.length === 2, 'newer snapshot was not delivered');
  pending[0](runningMatch({ question: { ...runningMatch().question, question: 'older stale snapshot' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1).state, 'revealing');
  controller.close();
});

test('성공한 answer 뒤 refetch 실패 시 검증된 server response snapshot을 보존한다', async () => {
  const snapshots = [];
  const errors = [];
  const events = [];
  const accepted = runningMatch({ ownSubmission: { position: 1, choiceIndex: 2, timedOut: false } });
  let reads = 0;
  const gateway = {
    subscribe() {
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      if (reads === 1) return runningMatch();
      throw new Error('post-submit refetch failed');
    },
    async submitMatchAnswer() {
      return { match: accepted, accepted: true, advanced: false };
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (next) => {
      snapshots.push(next);
      events.push('snapshot');
    },
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => {
      errors.push(message);
      events.push('error');
    },
  });

  await controller.open('ABC234');
  await controller.submit(submitSpec());

  assert.equal(reads, 2);
  assert.deepEqual(errors, ['post-submit refetch failed']);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.at(-1).ownSubmission, { position: 1, choiceIndex: 2, timedOut: false });
  assert.deepEqual(events, ['snapshot', 'snapshot', 'error']);
  controller.close();
});

test('controller errors는 background refresh와 answer submit ownership을 구분한다', async () => {
  const errors = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      if (reads === 1) return runningMatch();
      throw new Error('refresh failed');
    },
    async submitMatchAnswer() {
      throw new Error('submit failed');
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: () => undefined,
    onMissing: () => assert.fail('match should exist'),
    onError: (message, context) => errors.push({ message, context }),
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => errors.length === 1, 'refresh error was not reported');
  await controller.submit(submitSpec());

  assert.deepEqual(errors, [
    { message: 'refresh failed', context: { source: 'refresh' } },
    {
      message: 'submit failed',
      context: { source: 'submit', token: 1, matchId: MATCH_ID, position: 1 },
    },
  ]);
  controller.close();
});

test('newer refresh가 pending이면 older null은 match missing navigation을 commit하지 않는다', async () => {
  const snapshots = [];
  let missing = 0;
  const pending = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    submitMatchAnswer: async () => ({ match: runningMatch(), accepted: true }),
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (next) => snapshots.push(next),
    onMissing: () => { missing += 1; },
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => pending.length === 2, 'overlapping refreshes were not started');

  pending[0].resolve(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(missing, 0);

  const initial = runningMatch();
  const newer = { ...initial, currentPosition: 2, question: { ...initial.question, position: 2 } };
  pending[1].resolve(newer);
  await waitFor(() => snapshots.length === 2, 'newer snapshot was not delivered');
  assert.equal(missing, 0);
  assert.equal(snapshots.at(-1).currentPosition, 2);
  controller.close();
});

test('POST 응답 전에 시작한 더 최신 question refresh는 fallback submit snapshot으로 rollback되지 않는다', async () => {
  const snapshots = [];
  const errors = [];
  const pendingRefreshes = [];
  let eventHandler;
  let resolveSubmit;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve, reject) => pendingRefreshes.push({ resolve, reject }));
    },
    submitMatchAnswer() {
      return new Promise((resolve) => { resolveSubmit = resolve; });
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (next) => snapshots.push(next),
    onMissing: () => assert.fail('match should exist'),
    onError: (message, context) => errors.push({ message, context }),
  });

  await controller.open('ABC234');
  const submitting = controller.submit(submitSpec());
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => pendingRefreshes.length === 1, 'event refresh did not start');

  const acknowledged = runningMatch({ ownSubmission: { position: 1, choiceIndex: 2, timedOut: false } });
  resolveSubmit({ match: acknowledged, accepted: true });
  await waitFor(() => pendingRefreshes.length === 2, 'post-submit refresh did not start');

  const initial = runningMatch();
  const nextQuestion = { ...initial, currentPosition: 2, question: { ...initial.question, position: 2 } };
  pendingRefreshes[0].resolve(nextQuestion);
  await new Promise((resolve) => setTimeout(resolve, 0));
  pendingRefreshes[1].reject(new Error('post-submit refresh failed'));
  await submitting;

  assert.equal(snapshots.at(-1).currentPosition, 2);
  assert.equal(snapshots.at(-1).ownSubmission, null);
  assert.deepEqual(errors, [
    { message: 'post-submit refresh failed', context: { source: 'refresh' } },
  ]);
  controller.close();
});

test('replacement match가 시작되면 old-match invalidation은 새 snapshot identity를 덮지 못한다', async () => {
  const newMatchId = '22345678-1234-5678-9234-567812345678';
  const snapshots = [];
  const pending = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    submitMatchAnswer: async () => ({ match: runningMatch(), accepted: true }),
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (next) => snapshots.push(next),
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');
  eventHandler({
    type: 'match',
    phase: 'started',
    matchId: newMatchId,
    setup: { categoryId: 'history', gameMode: true },
  });
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, 1);

  pending[0].resolve(runningMatch({ matchId: newMatchId }));
  await waitFor(() => snapshots.length === 2, 'replacement snapshot was not delivered');
  assert.equal(snapshots.at(-1).matchId, newMatchId);
  controller.close();
});

test('unknown-identity refresh 실패 뒤 specific invalidation으로 다시 복구한다', async () => {
  const snapshots = [];
  const errors = [];
  const pending = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    submitMatchAnswer: async () => ({ match: runningMatch(), accepted: true }),
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (next) => snapshots.push(next),
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => errors.push(message),
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: null });
  await waitFor(() => pending.length === 1, 'unknown identity refresh did not start');
  pending[0].reject(new Error('reconnect refresh failed'));
  await waitFor(() => errors.length === 1, 'refresh error was not reported');

  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => pending.length === 2, 'specific invalidation did not recover refresh ownership');
  pending[1].resolve(revealingMatch());
  await waitFor(() => snapshots.length === 2, 'recovery snapshot was not delivered');
  assert.equal(snapshots.at(-1).state, 'revealing');
  controller.close();
});

test('duplicate started event는 같은 match의 진행 snapshot을 rollback하지 않는다', async () => {
  const initial = runningMatch({
    currentPosition: 2,
    question: { ...runningMatch().question, id: 'history-002', position: 2 },
  });
  const snapshots = [];
  const pending = [];
  let eventHandler;
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(initial);
      return new Promise((resolve) => pending.push(resolve));
    },
    submitMatchAnswer: async () => ({ match: initial, accepted: true }),
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (next) => snapshots.push(next),
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');
  eventHandler({
    type: 'match',
    phase: 'started',
    matchId: MATCH_ID,
    setup: { categoryId: 'history', gameMode: true },
  });
  await waitFor(() => pending.length === 1, 'duplicate start refresh did not begin');
  pending[0](runningMatch());
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots.at(-1).currentPosition, 2);
  controller.close();
});
