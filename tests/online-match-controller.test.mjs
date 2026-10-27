import test from 'node:test';
import assert from 'node:assert/strict';

// 오류 전달 경로를 보는 테스트는 이유를 플레이어의 말로 가진 오류(OnlinePlayerError)를 던진다.
// 어댑터의 개발 상세가 화면에 새지 않는지는 아래의 따로 된 테스트가 본다 (U40).
const { OnlinePlayerError } = await import('../js/online/rules.js');

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

test('active match socket forwards room, movement, and chat but rejects a stale subscription', async () => {
  const handlers = [];
  const presence = [];
  const gateway = {
    subscribe(_code, handler) {
      handlers.push(handler);
      return () => undefined;
    },
    async getMatch() {
      return runningMatch();
    },
    async submitMatchAnswer() {
      throw new Error('not used');
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: () => undefined,
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
    onPresenceEvent: (event) => presence.push(event),
  });

  await controller.open('ABC234');
  const roomEvent = { type: 'room', room: { code: 'ABC234' } };
  const movementEvent = {
    type: 'movement', playerId: 'remote-1', x: 0.2, y: 0.3, moving: true,
    sequence: 1, connectionGeneration: 1,
  };
  handlers[0](roomEvent);
  const chatEvent = { type: 'chat', playerId: 'remote-1', nickname: '상대', text: '안녕', at: 1 };
  handlers[0](chatEvent);
  handlers[0](movementEvent);
  assert.deepEqual(presence, [roomEvent, chatEvent, movementEvent]);

  await controller.open('XYZ234');
  handlers[0]({ ...movementEvent, sequence: 2 });
  handlers[1]({ ...movementEvent, sequence: 3, connectionGeneration: 2 });
  assert.deepEqual(presence, [
    roomEvent,
    chatEvent,
    movementEvent,
    { ...movementEvent, sequence: 3, connectionGeneration: 2 },
  ]);
  controller.close();
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

/** 이벤트가 처리될 틈을 몇 번 준다. 그동안 GET이 더 나가지 않았음을 확인할 때 쓴다. */
async function settle(turns = 5) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('후속 refresh가 실패해도 먼저 성공한 snapshot은 버리지 않는다', async () => {
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
  await waitFor(() => pending.length === 1, 'first refresh did not start');
  await settle();
  assert.equal(pending.length, 1, '두 번째 무효화는 날아가는 GET 뒤로 합쳐진다');

  pending[0].resolve(revealingMatch());
  await waitFor(() => pending.length === 2, 'coalesced follow-up refresh did not start');
  assert.equal(snapshots.at(-1).state, 'revealing');
  pending[1].reject(new OnlinePlayerError('newer refresh failed'));
  await waitFor(() => errors.length === 1, 'newer refresh failure was not reported');

  assert.equal(snapshots.at(-1).state, 'revealing');
  assert.equal(snapshots.at(-1).reveal.explanation, '서버 해설');
  assert.deepEqual(errors, ['newer refresh failed']);
  controller.close();
});

test('무효화 6번이 몰려도 GET은 최대 2번이고 마지막 화면은 최신 snapshot이다', async () => {
  const snapshots = [];
  const pending = [];
  let eventHandler;
  let reads = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    getMatch() {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => pending.push((value) => {
        inFlight -= 1;
        resolve(value);
      }));
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
  // 여섯 명이 거의 동시에 답을 내면 서버는 무효화를 여섯 번 방송한다.
  for (let count = 0; count < 6; count += 1) {
    eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  }
  await waitFor(() => pending.length === 1, 'first refresh did not start');
  await settle();
  assert.equal(pending.length, 1, '날아가는 GET이 있으면 새 GET을 보내지 않는다');

  // 첫 GET은 무효화 전에 출발했을 수 있다 — 아직 제출 전 상태를 돌려준다.
  pending[0](runningMatch({ ownSubmission: { position: 1, choiceIndex: 2, timedOut: false } }));
  await waitFor(() => pending.length === 2, 'follow-up refresh did not start');
  await settle();
  assert.equal(pending.length, 2, '합쳐진 무효화는 후속 GET 하나만 만든다');

  pending[1](revealingMatch());
  await waitFor(() => snapshots.at(-1)?.state === 'revealing', 'fresh snapshot was not delivered');
  await settle();

  assert.equal(reads - 1, 2, '무효화 6번에 GET은 2번');
  assert.equal(maxInFlight, 1, '한 번에 GET은 하나만 날아간다');
  assert.deepEqual(snapshots.map(({ state }) => state), ['running', 'running', 'revealing']);
  controller.close();
});

test('후속 GET이 예약된 채 닫으면 보내지 않고, 다음 매치의 첫 읽기를 늦은 GET이 막지 않는다', async () => {
  const snapshots = [];
  const pending = [];
  const handlers = [];
  let reads = 0;
  const gateway = {
    subscribe(_code, handler) {
      handlers.push(handler);
      return () => undefined;
    },
    getMatch(code) {
      reads += 1;
      if (reads === 1) return Promise.resolve(runningMatch());
      return new Promise((resolve) => pending.push({ code, resolve }));
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
  handlers[0]({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  handlers[0]({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => pending.length === 1, 'first refresh did not start');

  const reopening = controller.open('XYZ234');
  await waitFor(() => pending.length === 2, 'new lifecycle waited for the old in-flight GET');
  assert.equal(pending[1].code, 'XYZ234');

  pending[0].resolve(revealingMatch());
  await settle();
  assert.equal(pending.length, 2, '닫힌 lifecycle의 후속 GET은 보내지 않는다');
  assert.equal(snapshots.length, 1, '닫힌 lifecycle의 늦은 응답은 그리지 않는다');

  const replacement = runningMatch({ matchId: '42345678-1234-5678-9234-567812345678' });
  pending[1].resolve(replacement);
  await reopening;
  assert.equal(snapshots.at(-1).matchId, replacement.matchId);
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
  await settle();
  // 제출 뒤 다시 읽기는 날아가는 GET 뒤로 합쳐진다. 그 GET이 끝나야 출발한다.
  assert.equal(pendingReads.length, 1);

  pendingReads[0](runningMatch({ question: { ...runningMatch().question, question: 'stale snapshot' } }));
  await waitFor(() => pendingReads.length === 2, 'post-mutation refresh did not start');
  assert.equal(snapshots.length, 1);

  pendingReads[1](revealingMatch());
  await submitting;
  assert.equal(snapshots.at(-1).state, 'revealing');
  controller.close();
});

test('후속 GET이 더 오래된 진행 상태를 돌려줘도 화면을 rollback하지 않는다', async () => {
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
  await waitFor(() => pending.length === 1, 'first refresh did not start');

  pending[0](revealingMatch());
  await waitFor(() => snapshots.length === 2, 'newer snapshot was not delivered');
  await waitFor(() => pending.length === 2, 'coalesced follow-up refresh did not start');
  // 서버 진행은 되돌아가지 않는다. 늦게 도착한 «더 이른 phase»는 응답 순서가 어떻든 버린다.
  pending[1](runningMatch({ question: { ...runningMatch().question, question: 'older stale snapshot' } }));
  await settle();

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
      throw new OnlinePlayerError('post-submit refetch failed');
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
      throw new OnlinePlayerError('refresh failed');
    },
    async submitMatchAnswer() {
      throw new OnlinePlayerError('submit failed');
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

test('후속 refresh가 예약돼 있으면 먼저 온 null은 match missing navigation을 commit하지 않는다', async () => {
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
  await waitFor(() => pending.length === 1, 'first refresh was not started');

  pending[0].resolve(null);
  await waitFor(() => pending.length === 2, 'coalesced follow-up refresh was not started');
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
  await settle();
  // 제출 뒤 다시 읽기는 이미 날아가는 이벤트 GET 뒤로 합쳐진다.
  assert.equal(pendingRefreshes.length, 1);

  const initial = runningMatch();
  const nextQuestion = { ...initial, currentPosition: 2, question: { ...initial.question, position: 2 } };
  pendingRefreshes[0].resolve(nextQuestion);
  await waitFor(() => pendingRefreshes.length === 2, 'post-submit refresh did not start');
  pendingRefreshes[1].reject(new OnlinePlayerError('post-submit refresh failed'));
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
  pending[0].reject(new OnlinePlayerError('reconnect refresh failed'));
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

test('어댑터의 개발 상세는 화면에 넘기지 않고 콘솔에만 남긴다 (U40)', async () => {
  const errors = [];
  const warnings = [];
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
      throw new Error('서버 매치 snapshot이 올바르지 않습니다.');
    },
    async submitMatchAnswer() {
      throw new TypeError('Failed to fetch');
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: () => undefined,
    onMissing: () => assert.fail('match should exist'),
    onError: (message, context) => errors.push({ message, source: context.source }),
  });

  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await controller.open('ABC234');
    eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
    await waitFor(() => errors.length === 1, 'refresh error was not reported');
    await controller.submit(submitSpec());
  } finally {
    console.warn = warn;
    controller.close();
  }

  assert.deepEqual(errors, [
    { message: '게임 상태를 불러오지 못했어요. 잠시 뒤 다시 맞춰요.', source: 'refresh' },
    { message: '답을 보내지 못했어요. 다시 골라 주세요.', source: 'submit' },
  ]);
  for (const { message } of errors) {
    assert.doesNotMatch(message, /서버|snapshot|API|fetch/i);
  }
  assert.ok(warnings.some((line) => line.includes('서버 매치 snapshot이 올바르지 않습니다.')), '개발 상세는 콘솔에 남는다');
  assert.ok(warnings.some((line) => line.includes('Failed to fetch')));
});
