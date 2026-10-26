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

function finishedWith(scores) {
  return {
    matchId: '32345678-1234-5678-9234-567812345678',
    state: 'finished', categoryId: 'history', gameMode: true,
    currentPosition: 10, totalQuestions: 10, deadlineAt: null,
    question: null, ownSubmission: null, reveal: null,
    scores,
  };
}

function score(playerId, nickname, points) {
  return {
    playerId, nickname, characterId: 'slime-blue',
    score: points, correctCount: points / 10, answeredCount: 10,
  };
}

test('같은 점수는 같은 순위를 나눠 갖고(1, 1, 3) 닉네임 순서가 순위를 정하지 않는다 (U38)', async () => {
  const { onlineFinalResultView, onlineFinalSummary, onlinePlaceLabel } = await import('../js/ui/online-result.js');
  const THIRD = '42345678-1234-5678-9234-567812345678';
  // 서버는 동점을 닉네임 오름차순으로 늘어놓는다 — «가»가 앞이라고 더 높은 순위가 아니다
  const snapshot = finishedWith([
    score(OTHER, '가나다', 70),
    score(ME, '하늘', 70),
    score(THIRD, '바다', 40),
  ]);

  const view = onlineFinalResultView(snapshot, ME);

  assert.deepEqual(view.entries.map(({ place, tied }) => ({ place, tied })), [
    { place: 1, tied: true },
    { place: 1, tied: true },
    { place: 3, tied: false },
  ]);
  assert.equal(view.myPlace, 1);
  assert.equal(view.myTied, true);
  assert.equal(onlineFinalSummary(view, snapshot.totalQuestions), '공동 1위 · 70점 · 7/10 정답');
  assert.deepEqual(view.entries.map(({ place, tied }) => onlinePlaceLabel(place, tied)), ['공동 1위', '공동 1위', '3위']);
  // 표시는 바꾸되 서버 배열 순서는 그대로다
  assert.deepEqual(view.entries.map(({ playerId }) => playerId), [OTHER, ME, THIRD]);

  // 닉네임만 바꿔도 순위는 그대로다
  const renamed = onlineFinalResultView(finishedWith([
    score(ME, '가나다', 70),
    score(OTHER, '하늘', 70),
    score(THIRD, '바다', 40),
  ]), ME);
  assert.equal(renamed.myPlace, 1);
  assert.equal(renamed.myTied, true);
});

test('동점이 아니면 «최종 N위», 결과 줄에도 «서버» 같은 개발 용어를 쓰지 않는다 (U40)', async () => {
  const { onlineFinalResultView, onlineFinalSummary } = await import('../js/ui/online-result.js');
  const THIRD = '42345678-1234-5678-9234-567812345678';
  const snapshot = finishedWith([
    score(OTHER, '친구', 90),
    score(THIRD, '바다', 70),
    score(ME, '나', 70),
  ]);

  const view = onlineFinalResultView(snapshot, ME);
  assert.deepEqual(view.entries.map(({ place }) => place), [1, 2, 2]);
  assert.equal(onlineFinalSummary(view, 10), '공동 2위 · 70점 · 7/10 정답');

  const alone = onlineFinalResultView(finishedWith([score(OTHER, '친구', 90), score(ME, '나', 70)]), ME);
  assert.equal(onlineFinalSummary(alone, 10), '최종 2위 · 70점 · 7/10 정답');

  const absent = onlineFinalResultView(finishedWith([score(OTHER, '친구', 90)]), ME);
  assert.equal(onlineFinalSummary(absent, 10), '최종 순위가 나왔어요.');

  for (const text of [
    onlineFinalSummary(view, 10), onlineFinalSummary(alone, 10), onlineFinalSummary(absent, 10),
  ]) assert.doesNotMatch(text, /서버/);
});
