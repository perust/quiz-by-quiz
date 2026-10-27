import test from 'node:test';
import assert from 'node:assert/strict';

// 오류 전달 경로를 보는 테스트는 이유를 플레이어의 말로 가진 오류(OnlinePlayerError)를 던진다.
// 어댑터의 개발 상세가 화면에 새지 않는지는 아래의 따로 된 테스트가 본다 (U40).
const { ApiFailure, OnlinePlayerError } = await import('../js/online/rules.js');

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

test('답안 제출 뒤에는 따로 GET을 보내지 않고 제출 응답의 server snapshot을 그린다 (N01)', async () => {
  const submitted = [];
  const snapshots = [];
  let reads = 0;
  let answer = runningMatch({ ownSubmission: { position: 1, choiceIndex: 2, timedOut: false } });
  const gateway = {
    subscribe() {
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      return runningMatch();
    },
    async submitMatchAnswer(spec) {
      submitted.push(spec);
      return { match: answer, accepted: true, advanced: answer.state === 'revealing' };
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
  // 넘어가지 않은 답은 서버가 방송하지 않고, 낸 사람은 응답의 snapshot을 그린다. 다시 읽지 않는다
  assert.equal(reads, 1);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.at(-1).ownSubmission, { position: 1, choiceIndex: 2, timedOut: false });

  // 마지막으로 낸 답이 공개를 열었으면 그 공개도 응답에 있다 — 화면은 채점하지 않고 그대로 그린다
  answer = revealingMatch();
  await controller.submit(submitSpec());
  assert.equal(reads, 1);
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

test('제출 응답보다 먼저 출발한 GET은 같은 진행의 낡은 snapshot으로 응답을 덮지 못한다', async () => {
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
  await controller.submit(submitSpec());
  // 응답의 snapshot을 곧바로 그리고, 제출 때문에 GET을 더 보내지 않는다
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.at(-1).ownSubmission, { position: 1, choiceIndex: 2, timedOut: false });
  await settle();
  assert.equal(pendingReads.length, 1);

  // 먼저 출발한 GET이 늦게 돌아온다. 진행이 같으면(제출까지 같다) 낡은 것으로 보고 버린다
  pendingReads[0](runningMatch({
    ownSubmission: { position: 1, choiceIndex: 2, timedOut: false },
    question: { ...runningMatch().question, question: 'stale snapshot' },
  }));
  await settle();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1).question.question, '서버 문제');
  assert.equal(pendingReads.length, 1, '합칠 무효화가 없었으니 후속 GET도 없다');
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

test('이미 그린 공개보다 뒤처진 제출 응답은 화면을 되돌리지 않는다', async () => {
  const snapshots = [];
  let eventHandler;
  let reads = 0;
  let resolveSubmit;
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      return reads === 1 ? runningMatch() : revealingMatch();
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
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');
  const submitting = controller.submit(submitSpec());
  // 내 답이 공개를 열었고, 그 방송의 GET이 POST 응답보다 먼저 돌아왔다
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => snapshots.at(-1)?.state === 'revealing', 'broadcast refresh was not delivered');
  resolveSubmit({
    match: runningMatch({ ownSubmission: { position: 1, choiceIndex: 2, timedOut: false } }),
    accepted: true,
    advanced: false,
  });
  await submitting;

  assert.equal(reads, 2);
  assert.deepEqual(snapshots.map(({ state }) => state), ['running', 'revealing']);
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

test('POST 응답 전에 시작한 더 최신 question refresh는 제출 응답 snapshot으로 rollback되지 않는다', async () => {
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
  resolveSubmit({ match: acknowledged, accepted: true, advanced: false });
  await submitting;
  assert.deepEqual(snapshots.at(-1).ownSubmission, acknowledged.ownSubmission);
  await settle();
  // 제출 때문에 GET을 더 보내지 않는다
  assert.equal(pendingRefreshes.length, 1);

  const initial = runningMatch();
  const nextQuestion = { ...initial, currentPosition: 2, question: { ...initial.question, position: 2 } };
  pendingRefreshes[0].resolve(nextQuestion);
  await waitFor(() => snapshots.at(-1).currentPosition === 2, 'newer question was not delivered');
  await settle();

  assert.equal(snapshots.at(-1).ownSubmission, null);
  assert.equal(pendingRefreshes.length, 1);
  assert.deepEqual(errors, []);
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

// ── N01: 같은 IP 다인원 — 429 재시도와 마감 뒤 다시 읽기 ────────────────────
//
// 가짜 시계: 걸린 타이머를 모아 두고 테스트가 골라 돌린다. random은 jitter 폭의 가운데(0.5)다.

function fakeTimers() {
  const pending = new Map();
  const scheduled = [];
  const cleared = [];
  let nextId = 1;
  return {
    timers: {
      setTimeout(callback, delayMs) {
        const id = nextId;
        nextId += 1;
        pending.set(id, { callback, delayMs });
        scheduled.push(delayMs);
        return id;
      },
      clearTimeout(id) {
        if (pending.delete(id)) cleared.push(id);
      },
      random: () => 0.5,
    },
    scheduled,
    cleared,
    pendingDelays: () => [...pending.values()].map(({ delayMs }) => delayMs),
    /** 지금 걸린 타이머를 모두 돌린다(돌리는 사이 새로 걸린 것은 남긴다) */
    runPending() {
      const due = [...pending.entries()];
      for (const [id] of due) pending.delete(id);
      for (const [, { callback }] of due) callback();
      return due.length;
    },
  };
}

function rateLimited(retryAfterMs = 1_000) {
  return new ApiFailure(429, 'rate-limited', '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.', retryAfterMs);
}

test('요청 한도에 걸린 무효화 GET은 Retry-After와 jitter를 두고 한 번만 다시 보낸다 (N01)', async () => {
  const snapshots = [];
  const errors = [];
  const clock = fakeTimers();
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
      if (reads === 2) throw rateLimited(2_000);
      return revealingMatch();
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
    timers: clock.timers,
  });

  await controller.open('ABC234');
  // phase가 바뀌었다는 방송. 그 GET이 같은 IP의 몫에 걸렸다
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => clock.scheduled.length === 1, 'retry was not scheduled');
  // Retry-After 2초 + jitter(0.5 × 500ms). 상한 3초 안이다
  assert.deepEqual(clock.scheduled, [2_250]);
  // 기다리는 동안 온 무효화는 후속 GET 하나로 합쳐진다 — 지금 GET을 더 보내지 않는다
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await settle();
  assert.equal(reads, 2);

  clock.runPending();
  await waitFor(() => snapshots.at(-1)?.state === 'revealing', 'coalesced follow-up was not delivered');
  await settle();
  // 기다리는 사이 후속 GET이 예약됐으면 재시도를 따로 보내지 않는다 — 후속 GET이 같은 일을 한다.
  // 둘을 잇달아 보내면 방금 429를 준 몫에 하나를 더 밀어 넣는다(N01 리뷰 client-retry-2)
  assert.equal(reads, 3, '첫 GET · 기다림 뒤 합친 후속 하나');
  assert.deepEqual(clock.scheduled, [2_250], '후속 GET은 다시 기다리지 않는다');
  assert.deepEqual(errors, [], '후속 GET으로 맞췄으면 첫 거절을 알리지 않는다');
  controller.close();
});

test('기다리는 사이 무효화가 없으면 429에 걸린 GET은 그대로 한 번 다시 보낸다', async () => {
  const snapshots = [];
  const errors = [];
  const clock = fakeTimers();
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
      if (reads === 2) throw rateLimited(1_000);
      return revealingMatch();
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
    timers: clock.timers,
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => clock.scheduled.length === 1, 'retry was not scheduled');
  clock.runPending();
  await waitFor(() => snapshots.at(-1)?.state === 'revealing', 'retried GET was not delivered');
  await settle();
  assert.equal(reads, 3, '첫 GET · 거절 · 재시도 하나');
  assert.deepEqual(errors, []);
  controller.close();
});

test('다시 보낸 GET도 요청 한도에 걸리면 한 번만 알리고 더 되풀이하지 않는다', async () => {
  const errors = [];
  const clock = fakeTimers();
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
      // 서버가 Retry-After를 말하지 않았거나(CORS가 가린 구버전) 60초라고 했다
      throw rateLimited(reads === 2 ? null : 60_000);
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
    onError: (message) => errors.push(message),
    timers: clock.timers,
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => clock.scheduled.length === 1, 'retry was not scheduled');
  // Retry-After가 없으면 1초 + jitter
  assert.deepEqual(clock.scheduled, [1_250]);
  clock.runPending();
  await waitFor(() => errors.length === 1, 'second rate limit was not reported');
  await settle();
  assert.equal(reads, 3);
  assert.equal(clock.pendingDelays().length, 0, '두 번째 거절 뒤에는 다시 보내지 않는다');
  assert.deepEqual(errors, ['요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.']);

  // 오래 기다리라는 Retry-After도 상한 안에서 jitter와 함께 기다린다
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => clock.scheduled.length === 2, 'second retry was not scheduled');
  assert.equal(clock.scheduled[1], 2_750);
  assert.ok(clock.scheduled[1] <= 3_000);
  controller.close();
  clock.runPending();
  await settle();
  assert.equal(reads, 4, '닫힌 뒤에는 다시 보내지 않는다');
});

test('요청 한도가 아닌 실패는 다시 보내지 않는다', async () => {
  const errors = [];
  const clock = fakeTimers();
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
      throw new ApiFailure(503, 'database-unavailable', '온라인 연결이 잠시 원활하지 않아요.');
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
    onError: (message) => errors.push(message),
    timers: clock.timers,
  });

  await controller.open('ABC234');
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => errors.length === 1, 'failure was not reported');
  assert.equal(reads, 2);
  assert.deepEqual(clock.scheduled, []);
  controller.close();
});

test('남은 시간 + 2초가 지나도 phase가 그대로면 한 번 다시 읽고 공개 마감에도 또 읽는다 (N01)', async () => {
  const snapshots = [];
  const clock = fakeTimers();
  const responses = [
    runningMatch({ remainingMs: 5_000 }),
    // 방송을 놓친 채 마감 뒤 다시 읽기가 공개를 찾는다
    revealingMatch({ remainingMs: 8_000 }),
    // 마지막 공개 뒤에는 방송이 더 오지 않는다 — 공개 마감 뒤 다시 읽기가 최종 순위를 찾는다
    {
      ...revealingMatch(),
      state: 'finished',
      deadlineAt: null,
      question: null,
      reveal: null,
    },
  ];
  let reads = 0;
  let submits = 0;
  const gateway = {
    subscribe() {
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      return responses[Math.min(reads, responses.length) - 1];
    },
    async submitMatchAnswer() {
      submits += 1;
      throw new Error('safety reread must never submit');
    },
  };
  const { createOnlineMatchController, SAFETY_REREAD_GRACE_MS } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
    timers: clock.timers,
  });

  await controller.open('ABC234');
  assert.equal(SAFETY_REREAD_GRACE_MS, 2_000);
  assert.deepEqual(clock.pendingDelays(), [7_000]);

  clock.runPending();
  await waitFor(() => snapshots.at(-1)?.state === 'revealing', 'safety reread did not find the reveal');
  assert.equal(reads, 2);
  assert.deepEqual(clock.pendingDelays(), [10_000], '공개 마감 + 2초에 다시 건다');

  clock.runPending();
  await waitFor(() => snapshots.at(-1)?.state === 'finished', 'safety reread did not find the final standings');
  await settle();
  assert.equal(reads, 3);
  assert.deepEqual(clock.pendingDelays(), [], '끝난 판에는 다시 읽기를 걸지 않는다');
  assert.equal(submits, 0, '다시 읽기는 답을 대신 내지 않는다');
  controller.close();
});

test('마감 뒤 다시 읽기는 phase마다 한 번뿐이고, 새 phase가 오면 이전 것을 거둔다', async () => {
  const snapshots = [];
  const clock = fakeTimers();
  let eventHandler;
  let reads = 0;
  const running = runningMatch({ remainingMs: 4_000 });
  const gateway = {
    subscribe(_code, handler) {
      eventHandler = handler;
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      if (reads <= 2) return running;
      return revealingMatch({ remainingMs: 8_000 });
    },
    async submitMatchAnswer() {
      return {
        match: runningMatch({
          remainingMs: 1_000,
          ownSubmission: { position: 1, choiceIndex: 2, timedOut: false },
        }),
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
    timers: clock.timers,
  });

  await controller.open('ABC234');
  assert.deepEqual(clock.pendingDelays(), [6_000]);
  // 같은 phase의 제출 응답은 다시 걸지 않는다(마감은 그대로다)
  await controller.submit(submitSpec());
  assert.deepEqual(clock.pendingDelays(), [6_000]);

  // 마감 뒤 다시 읽었더니 아직 같은 phase였다 — 같은 phase에는 다시 걸지 않아 되풀이 GET이 없다
  clock.runPending();
  await waitFor(() => reads === 2, 'safety reread did not run');
  await settle();
  assert.deepEqual(clock.pendingDelays(), []);

  // 방송으로 새 phase가 오면 그 phase의 마감에 새로 건다
  eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
  await waitFor(() => snapshots.at(-1)?.state === 'revealing', 'broadcast refresh was not delivered');
  assert.deepEqual(clock.pendingDelays(), [10_000]);

  // 닫으면 걸어 둔 다시 읽기도 거둔다
  controller.close();
  assert.deepEqual(clock.pendingDelays(), []);
  assert.equal(clock.cleared.length, 1);
});

// ── N01 리뷰: 낸 답이 화면에 오지 않았을 때의 한 번 다시 읽기 ─────────────────
//
// 넘어가지 않은 답은 방송하지 않는다. 그래서 서버가 받은 답을 화면이 모르면(응답 유실·guard가 버린
// 응답) 아무도 바로잡아 주지 않는다 — 다른 보기를 누르면 서버는 첫 답을 지켜 화면이 튀었다.

const SUBMITTED = { position: 1, choiceIndex: 2, timedOut: false };

for (const [label, failure] of [
  ['응답 시간 초과', () => new OnlinePlayerError('응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.')],
  ['연결 끊김', () => new TypeError('Failed to fetch')],
  ['5xx', () => new ApiFailure(503, 'database-unavailable', '온라인 연결이 잠시 원활하지 않아요.')],
]) {
  test(`답 응답을 받지 못하면(${label}) 한 번 다시 읽어 서버가 받은 답을 그린다`, async () => {
    const snapshots = [];
    const errors = [];
    let reads = 0;
    const gateway = {
      subscribe() {
        return () => undefined;
      },
      async getMatch() {
        reads += 1;
        // 서버는 답을 받았다 — 응답만 오지 않았다
        return reads === 1 ? runningMatch() : runningMatch({ ownSubmission: SUBMITTED });
      },
      async submitMatchAnswer() {
        throw failure();
      },
    };
    const { createOnlineMatchController } = await import('../js/online/match-controller.js');
    const controller = createOnlineMatchController({
      gateway,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onMissing: () => assert.fail('match should exist'),
      onError: (message, context) => errors.push({ message, source: context.source }),
    });

    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await controller.open('ABC234');
      await controller.submit(submitSpec());
      await waitFor(() => snapshots.at(-1)?.ownSubmission !== null, 'own submission was not repaired');
      await settle();
    } finally {
      console.warn = warn;
      controller.close();
    }

    assert.equal(reads, 2, '첫 GET · 다시 읽기 하나');
    assert.deepEqual(snapshots.at(-1).ownSubmission, SUBMITTED);
    // 실패는 그대로 알린다. 다시 읽기는 답을 대신 내지 않고 서버 snapshot을 그릴 뿐이다
    assert.equal(errors.length, 1);
    assert.equal(errors[0].source, 'submit');
  });
}

test('서버가 4xx로 거절한 답은 다시 읽지 않는다 — 저장되지 않았다', async () => {
  const errors = [];
  let reads = 0;
  const rejections = [
    new ApiFailure(409, 'stale-question', '이미 다음 문제로 넘어갔어요.'),
    new ApiFailure(429, 'rate-limited', '답안 제출이 너무 빨라요. 잠시 뒤 다시 시도해 주세요.', 8_000),
  ];
  const gateway = {
    subscribe() {
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      return runningMatch();
    },
    async submitMatchAnswer() {
      throw rejections.shift();
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: () => undefined,
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => errors.push(message),
  });

  await controller.open('ABC234');
  await controller.submit(submitSpec());
  await controller.submit(submitSpec());
  await settle();

  assert.equal(reads, 1);
  assert.deepEqual(errors, [
    '이미 다음 문제로 넘어갔어요.',
    '답안 제출이 너무 빨라요. 잠시 뒤 다시 시도해 주세요.',
  ]);
  controller.close();
});

test('재연결 무효화가 답 응답을 버리게 하면 한 번 다시 읽어 내 답을 되살린다', async () => {
  // 답을 내는 사이 소켓이 다시 붙어 matchId 없는 무효화가 왔다. 그 GET이 답보다 먼저 서버에 닿아
  // «아직 안 냄»을 그렸고, 뒤에 온 답 응답은 identity가 바뀌어 버려진다
  const snapshots = [];
  const pending = [];
  let eventHandler;
  let reads = 0;
  let resolveSubmit;
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
    submitMatchAnswer() {
      return new Promise((resolve) => { resolveSubmit = resolve; });
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
  const submitting = controller.submit(submitSpec());
  eventHandler({ type: 'match', phase: 'invalidated', matchId: null });
  await waitFor(() => pending.length === 1, 'reconnect refresh did not start');
  pending[0](runningMatch());
  await waitFor(() => snapshots.length === 2, 'reconnect snapshot was not delivered');
  assert.equal(snapshots.at(-1).ownSubmission, null);

  resolveSubmit({ match: runningMatch({ ownSubmission: SUBMITTED }), accepted: true, advanced: false });
  await submitting;
  await waitFor(() => pending.length === 2, 'dropped answer response did not trigger one re-read');
  pending[1](runningMatch({ ownSubmission: SUBMITTED }));
  await waitFor(() => snapshots.at(-1).ownSubmission !== null, 'own submission was not repaired');
  await settle();

  assert.equal(reads, 3, '첫 GET · 재연결 GET · 다시 읽기 하나');
  assert.deepEqual(snapshots.at(-1).ownSubmission, SUBMITTED);
  controller.close();
});

test('다시 읽기는 날아가는 GET 뒤의 후속 GET 하나로 합쳐진다', async () => {
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
      throw new TypeError('Failed to fetch');
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onMissing: () => assert.fail('match should exist'),
    onError: () => undefined,
  });

  const warn = console.warn;
  console.warn = () => undefined;
  try {
    await controller.open('ABC234');
    // 다른 무효화의 GET이 이미 날아가는 중이다
    eventHandler({ type: 'match', phase: 'invalidated', matchId: MATCH_ID });
    await waitFor(() => pending.length === 1, 'broadcast refresh did not start');
    await controller.submit(submitSpec());
    await controller.submit(submitSpec());
    await settle();
    assert.equal(pending.length, 1, '날아가는 GET이 끝나기 전에는 더 보내지 않는다');

    pending[0](runningMatch());
    await waitFor(() => pending.length === 2, 'coalesced re-read did not run');
    pending[1](runningMatch({ ownSubmission: SUBMITTED }));
    await waitFor(() => snapshots.at(-1).ownSubmission !== null, 'own submission was not repaired');
    await settle();
  } finally {
    console.warn = warn;
    controller.close();
  }

  assert.equal(reads, 3, '첫 GET · 방송 GET · 두 실패를 합친 다시 읽기 하나');
});

test('닫힌 controller는 답 실패 뒤에도 다시 읽지 않는다', async () => {
  let reads = 0;
  let rejectSubmit;
  const gateway = {
    subscribe() {
      return () => undefined;
    },
    async getMatch() {
      reads += 1;
      return runningMatch();
    },
    submitMatchAnswer() {
      return new Promise((_resolve, reject) => { rejectSubmit = reject; });
    },
  };
  const { createOnlineMatchController } = await import('../js/online/match-controller.js');
  const controller = createOnlineMatchController({
    gateway,
    onSnapshot: () => undefined,
    onMissing: () => assert.fail('match should exist'),
    onError: (message) => assert.fail(message),
  });

  await controller.open('ABC234');
  const submitting = controller.submit(submitSpec());
  controller.close();
  rejectSubmit(new OnlinePlayerError('응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.'));
  await submitting;
  await settle();
  assert.equal(reads, 1);
});
