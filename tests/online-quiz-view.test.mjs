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

test('finished online quiz view는 질문을 다시 만들지 않고 server final ranking 화면으로 넘긴다', async () => {
  const { onlineQuizView } = await import('../js/ui/online-quiz.js');
  const view = onlineQuizView({
    matchId: MATCH_ID,
    state: 'finished',
    categoryId: 'history', gameMode: false, currentPosition: 10, totalQuestions: 10,
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
