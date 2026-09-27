import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MATCH_ID = '12345678-1234-5678-9234-567812345678';

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
      id: 'history-001', categoryId: 'history', question: '서버 문제',
      choices: ['1번', '2번', '3번', '4번'], position: 1, total: 10,
    },
    ownSubmission: null,
    reveal: null,
    scores: [],
    ...changes,
  };
}

test('running online quiz view는 제출 여부만 표시하고 정오답·정답·점수·해설을 전혀 만들지 않는다', async () => {
  const { onlineQuizView } = await import('../js/ui/online-quiz.js');
  const view = onlineQuizView(runningMatch({
    ownSubmission: { position: 1, choiceIndex: 2, timedOut: false },
  }));

  assert.equal(view.phase, 'running');
  assert.equal(view.canSubmit, false);
  assert.equal(view.selectedChoiceIndex, 2);
  assert.equal(view.reveal, null);
  assert.equal(view.status.includes('정답'), false);
  assert.equal(view.status.includes('점'), false);
  assert.equal(view.status.includes('해설'), false);
});

test('running online quiz view는 client clock의 지난 deadline으로 제출을 거절하지 않는다', async () => {
  const { canAttemptOnlineSubmission, onlineQuizView } = await import('../js/ui/online-quiz.js');
  const snapshot = runningMatch({ deadlineAt: '2000-01-01T00:00:00+00:00' });

  assert.equal(canAttemptOnlineSubmission(snapshot), true);
  assert.equal(onlineQuizView(snapshot).canSubmit, true);
});

test('revealing online quiz view는 server reveal만으로 정오답과 해설을 표시한다', async () => {
  const { onlineQuizView } = await import('../js/ui/online-quiz.js');
  const view = onlineQuizView({
    ...runningMatch(),
    state: 'revealing',
    ownSubmission: null,
    reveal: { position: 1, choiceIndex: 2, timedOut: false, correct: true, answerIndex: 2, explanation: '서버 해설' },
    scores: [{
      playerId: MATCH_ID, nickname: '퀴즈왕', characterId: 'slime-blue',
      score: 10, correctCount: 1, answeredCount: 1,
    }],
  });

  assert.equal(view.phase, 'revealing');
  assert.equal(view.canSubmit, false);
  assert.deepEqual(view.reveal, {
    chosenChoiceIndex: 2,
    answerIndex: 2,
    correct: true,
    timedOut: false,
    explanation: '서버 해설',
  });
});

test('온라인 답안 제출·정답 공개 중에도 이동 인터페이스를 잠그지 않는다', async () => {
  const {
    handleOnlineMovementKey,
    onlineArenaMovementEnabled,
    onlineArenaSelectionEnabled,
    onlineQuizView,
  } = await import('../js/ui/online-quiz.js');
  const freshSnapshot = runningMatch();
  const submittedSnapshot = runningMatch({
    ownSubmission: { position: 1, choiceIndex: 2, timedOut: false },
  });
  const revealingSnapshot = {
    ...runningMatch(),
    state: 'revealing',
    reveal: {
      position: 1,
      choiceIndex: 2,
      timedOut: false,
      correct: true,
      answerIndex: 2,
      explanation: '서버 해설',
    },
  };
  const finishedSnapshot = {
    ...runningMatch(),
    state: 'finished',
    deadlineAt: null,
    currentPosition: 2,
    question: null,
    ownSubmission: null,
    reveal: null,
    scores: [],
  };
  const fresh = onlineQuizView(freshSnapshot);
  const submitted = onlineQuizView(submittedSnapshot);
  const revealing = onlineQuizView(revealingSnapshot);
  const finished = onlineQuizView(finishedSnapshot);
  const source = await readFile(
    new URL('../src/ui/online-quiz.ts', import.meta.url),
    'utf8',
  );
  const forwarded = [];
  const arena = {
    handleKey(event) {
      forwarded.push(event.key);
      return true;
    },
  };

  assert.equal(onlineArenaMovementEnabled(submitted), true);
  assert.equal(onlineArenaMovementEnabled(revealing), true);
  assert.equal(onlineArenaMovementEnabled(finished), false);
  assert.equal(onlineArenaSelectionEnabled(fresh, false), true);
  assert.equal(onlineArenaSelectionEnabled(fresh, true), false);
  assert.equal(onlineArenaSelectionEnabled(submitted, false), false);
  assert.equal(onlineArenaSelectionEnabled(revealing, false), false);
  assert.equal(handleOnlineMovementKey(submittedSnapshot, { key: 'ArrowRight' }, arena), true);
  assert.equal(handleOnlineMovementKey(revealingSnapshot, { key: 'ArrowLeft' }, arena), true);
  assert.equal(handleOnlineMovementKey(finishedSnapshot, { key: 'ArrowUp' }, arena), false);
  assert.equal(handleOnlineMovementKey(null, { key: 'ArrowDown' }, arena), false);
  assert.deepEqual(forwarded, ['ArrowRight', 'ArrowLeft']);
  assert.doesNotMatch(source, /arena\.lock\(\)/);
  assert.match(source, /lockMovement:\s*false/);
  assert.match(
    source,
    /arena\.setSelectionEnabled\(onlineArenaSelectionEnabled\(view, isSubmitPending\)\)/,
  );
});

test('답 칸 선택을 닫으면 발밑 강조만 지우고 채점 결과 색은 보존한다', async () => {
  const { setArenaTileSelectable } = await import('../js/ui/arena-state.js');
  const classes = new Set(['arena-tile', 'is-standing', 'arena-tile--correct']);
  const tile = {
    dataset: { selectable: 'true' },
    classList: {
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
    },
  };

  setArenaTileSelectable(tile, false);

  assert.equal(tile.dataset.selectable, 'false');
  assert.equal(classes.has('is-standing'), false);
  assert.equal(classes.has('arena-tile--correct'), true);
});

test('finished online quiz view는 질문을 다시 만들지 않고 server final ranking 화면으로 넘긴다', async () => {
  const { onlineQuizView } = await import('../js/ui/online-quiz.js');
  const view = onlineQuizView({
    matchId: MATCH_ID,
    state: 'finished',
    categoryId: 'history', gameMode: true, currentPosition: 10, totalQuestions: 10,
    deadlineAt: null,
    question: null, ownSubmission: null, reveal: null,
    scores: [{
      playerId: MATCH_ID, nickname: '퀴즈왕', characterId: 'slime-blue',
      score: 100, correctCount: 10, answeredCount: 10,
    }],
  });

  assert.equal(view.phase, 'finished');
  assert.equal(view.question, null);
  assert.equal(view.showFinalResult, true);
});

test('stale online submission completion은 재진입한 새 match owner를 바꾸지 못한다', async () => {
  const { createOnlineSubmissionGate } = await import('../js/ui/online-quiz.js');
  const firstSnapshot = runningMatch();
  const secondSnapshot = runningMatch({
    matchId: '22345678-1234-5678-9234-567812345678',
    question: { ...runningMatch().question, position: 2 },
    currentPosition: 2,
  });
  const gate = createOnlineSubmissionGate();

  const first = gate.begin(firstSnapshot);
  assert.equal(gate.pendingFor(firstSnapshot), true);
  assert.equal(gate.owns({ ...first }), true);
  gate.reconcile(secondSnapshot);
  const second = gate.begin(secondSnapshot);

  assert.equal(gate.finish(first, secondSnapshot), false);
  assert.equal(gate.owns({ ...first }), false);
  assert.equal(gate.owns({ ...second }), true);
  assert.equal(gate.pendingFor(secondSnapshot), true);
  assert.equal(gate.finish(second, secondSnapshot), true);
  assert.equal(gate.pendingFor(secondSnapshot), false);

  const interrupted = gate.begin(secondSnapshot);
  gate.invalidate(interrupted);
  assert.equal(gate.finish(interrupted, secondSnapshot), false);
  assert.equal(gate.pendingFor(secondSnapshot), false);
});

test('same-question snapshot은 choice DOM 구조 key를 유지하고 새 질문만 바꾼다', async () => {
  const { onlineChoiceStructureKey } = await import('../js/ui/online-quiz.js');
  const running = runningMatch();
  const submitted = runningMatch({
    ownSubmission: { position: 1, choiceIndex: 2, timedOut: false },
  });
  const revealing = {
    ...runningMatch(),
    state: 'revealing',
    reveal: { position: 1, choiceIndex: 2, timedOut: false, correct: true, answerIndex: 2, explanation: '서버 해설' },
  };
  const nextQuestion = runningMatch({
    currentPosition: 2,
    question: {
      ...runningMatch().question,
      id: 'history-002',
      question: '다음 서버 문제',
      position: 2,
    },
  });

  const key = onlineChoiceStructureKey(running);
  assert.equal(onlineChoiceStructureKey(submitted), key);
  assert.equal(onlineChoiceStructureKey(revealing), key);
  assert.notEqual(onlineChoiceStructureKey(nextQuestion), key);
});

test('submit error owner는 같은 running question position에만 일치한다', async () => {
  const { ownsOnlineSubmitError } = await import('../js/ui/online-quiz.js');
  const running = runningMatch();
  const nextQuestion = runningMatch({
    currentPosition: 2,
    question: { ...runningMatch().question, position: 2 },
  });
  const revealing = {
    ...running,
    state: 'revealing',
    ownSubmission: { position: 1, choiceIndex: 0, timedOut: false },
    reveal: {
      position: 1,
      choiceIndex: 0,
      timedOut: false,
      correct: true,
      answerIndex: 0,
      explanation: '서버 해설',
    },
  };

  const owner = { token: 1, matchId: MATCH_ID, position: 1 };
  const otherMatch = runningMatch({ matchId: '32345678-1234-5678-9234-567812345678' });
  assert.equal(ownsOnlineSubmitError(running, owner), true);
  assert.equal(ownsOnlineSubmitError(nextQuestion, owner), false);
  assert.equal(ownsOnlineSubmitError(revealing, owner), false);
  assert.equal(ownsOnlineSubmitError(otherMatch, owner), false);
});

test('aria-live text는 값이 바뀔 때만 DOM을 mutate한다', async () => {
  const { setTextIfChanged } = await import('../js/ui/online-quiz.js');
  let value = '같은 문구';
  let writes = 0;
  const target = {
    get textContent() { return value; },
    set textContent(next) { value = next; writes += 1; },
  };

  assert.equal(setTextIfChanged(target, '같은 문구'), false);
  assert.equal(writes, 0);
  assert.equal(setTextIfChanged(target, '새 문구'), true);
  assert.equal(writes, 1);
  assert.equal(setTextIfChanged(target, '새 문구'), false);
  assert.equal(writes, 1);
});

test('choice node reconciliation은 same-question objects를 그대로 재사용한다', async () => {
  const { reconcileOnlineChoiceNodes } = await import('../js/ui/online-quiz.js');
  const first = { id: 'first' };
  const second = { id: 'second' };
  let creates = 0;
  const create = (index) => { creates += 1; return { id: `new-${index}` }; };

  const stable = reconcileOnlineChoiceNodes(
    [first, second], 'same-key', 'same-key', 2, create,
  );
  assert.equal(stable.rebuilt, false);
  assert.equal(stable.nodes[0], first);
  assert.equal(stable.nodes[1], second);
  assert.equal(creates, 0);

  const changed = reconcileOnlineChoiceNodes(
    stable.nodes, 'same-key', 'next-key', 2, create,
  );
  assert.equal(changed.rebuilt, true);
  assert.notEqual(changed.nodes[0], first);
  assert.notEqual(changed.nodes[1], second);
  assert.equal(creates, 2);
});

test('online presence text exposes a stable non-moving participant roster', async () => {
  const { onlinePresenceText } = await import('../js/ui/online-quiz.js');
  assert.equal(onlinePresenceText([]), '');
  assert.equal(
    onlinePresenceText([{ nickname: '나' }, { nickname: '친구' }]),
    '함께 푸는 참가자 2명: 나, 친구',
  );
});
