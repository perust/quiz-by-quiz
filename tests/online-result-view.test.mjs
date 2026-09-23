import test from 'node:test';
import assert from 'node:assert/strict';

const ME = '12345678-1234-5678-9234-567812345678';
const OTHER = '22345678-1234-5678-9234-567812345678';

test('online final result는 server score array 순서를 그대로 순위로 표시한다', async () => {
  const { onlineFinalResultView } = await import('../js/ui/online-result.js');
  const snapshot = {
    matchId: '32345678-1234-5678-9234-567812345678',
    state: 'finished', categoryId: 'history', gameMode: true,
    currentPosition: 10, totalQuestions: 10, deadlineAt: '2026-09-18T11:00:20+00:00',
    question: null, ownSubmission: null, reveal: null,
    // This intentionally is not score-sorted: a client may not reorder it.
    scores: [
      { playerId: OTHER, nickname: '먼저 온 서버 순위', characterId: 'slime-blue', score: 0, correctCount: 0, answeredCount: 10 },
      { playerId: ME, nickname: '나', characterId: 'slime-blue', score: 100, correctCount: 10, answeredCount: 10 },
    ],
  };

  const view = onlineFinalResultView(snapshot, ME);

  assert.deepEqual(view.entries.map(({ place, playerId, score }) => ({ place, playerId, score })), [
    { place: 1, playerId: OTHER, score: 0 },
    { place: 2, playerId: ME, score: 100 },
  ]);
  assert.equal(view.myPlace, 2);
  assert.equal(snapshot.scores[0].playerId, OTHER);
});

test('online final result는 current player가 score list에 없으면 존재하지 않는 순위를 만들지 않는다', async () => {
  const { onlineFinalResultView } = await import('../js/ui/online-result.js');
  const snapshot = {
    matchId: '32345678-1234-5678-9234-567812345678',
    state: 'finished', categoryId: null, gameMode: true,
    currentPosition: 10, totalQuestions: 10, deadlineAt: '2026-09-18T11:00:20+00:00',
    question: null, ownSubmission: null, reveal: null,
    scores: [{ playerId: OTHER, nickname: '다른 사람', characterId: 'slime-blue', score: 20, correctCount: 2, answeredCount: 10 }],
  };

  const view = onlineFinalResultView(snapshot, ME);

  assert.equal(view.myPlace, null);
  assert.equal(view.entries.length, 1);
});
