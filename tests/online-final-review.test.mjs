import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, node, valueOf } from './css-cascade.mjs';

// 온라인 최종 순위의 캐릭터·금은동·축하·「한 판 더」·«문제 다시 보기» (U38)와
// 공개 단계 참가자별 정오·끝난 판 풀이의 어댑터 경계 (U30·U38).

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

const MATCH_ID = '32345678-1234-5678-9234-567812345678';
const ME = '12345678-1234-5678-9234-567812345678';
const OTHER = '22345678-1234-5678-9234-567812345678';
const identity = { id: ME, secret: 'browser-session-secret-with-thirty-two-chars' };

function scoreRow(playerId, points, extra = {}) {
  return {
    playerId, nickname: playerId === ME ? '나' : '친구', characterId: 'slime-blue',
    score: points, correctCount: points / 10, answeredCount: 2, ...extra,
  };
}

function reviewItem(position, changes = {}) {
  return {
    position, id: `online-history-${position}`, categoryId: 'history',
    question: `문제 ${position}`, choices: ['가', '나', '다', '라'], answerIndex: 1,
    explanation: `해설 ${position}`, choiceIndex: 1, correct: true, timedOut: false,
    ...changes,
  };
}

function finished(changes = {}) {
  return {
    matchId: MATCH_ID, state: 'finished', categoryId: 'history', gameMode: true,
    currentPosition: 2, totalQuestions: 2, deadlineAt: null,
    question: null, ownSubmission: null, reveal: null,
    scores: [scoreRow(ME, 10), scoreRow(OTHER, 0)],
    ...changes,
  };
}

function running(changes = {}) {
  return {
    matchId: MATCH_ID, state: 'running', categoryId: 'history', gameMode: true,
    currentPosition: 1, totalQuestions: 2, deadlineAt: '2026-09-18T11:00:20+00:00',
    question: { id: 'q1', categoryId: 'history', question: '문제', choices: ['가', '나', '다', '라'], position: 1, total: 2 },
    ownSubmission: null, reveal: null, scores: [],
    ...changes,
  };
}

function revealingMatch(changes = {}) {
  return {
    ...running(),
    state: 'revealing',
    reveal: { position: 1, choiceIndex: 1, timedOut: false, correct: true, answerIndex: 1, explanation: '해설' },
    scores: [scoreRow(ME, 10, { lastAnswerCorrect: true }), scoreRow(OTHER, 0, { lastAnswerCorrect: false })],
    ...changes,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

async function storeReturning(match) {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return new Response(JSON.stringify({ playerId: identity.id }), { status: 200 });
    if (url.endsWith('/v1/rooms/ABC234/match')) return new Response(JSON.stringify(match), { status: 200 });
    throw new Error(`unexpected request: ${url}`);
  };
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  return createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: () => { throw new Error('socket not used'); },
  });
}

// ── 어댑터 경계 ─────────────────────────────────────────────────

test('참가자별 정오(lastAnswerCorrect)는 공개 중에만 싣고, 끝난 판에 섞여 와도 버린다', async () => {
  const revealing = await (await storeReturning(revealingMatch())).getMatch('ABC234');
  assert.deepEqual(revealing.scores.map(({ lastAnswerCorrect }) => lastAnswerCorrect), [true, false]);

  const done = await (await storeReturning(finished({
    scores: [scoreRow(ME, 10, { lastAnswerCorrect: true })],
  }))).getMatch('ABC234');
  assert.equal(Object.hasOwn(done.scores[0], 'lastAnswerCorrect'), false);

  // 표시용 값이 깨졌으면 그 값만 뺀다 — 공개 전체를 거절하지 않는다
  const broken = await (await storeReturning(revealingMatch({
    scores: [scoreRow(ME, 10, { lastAnswerCorrect: 'yes' })],
  }))).getMatch('ABC234');
  assert.equal(broken.state, 'revealing');
  assert.equal(Object.hasOwn(broken.scores[0], 'lastAnswerCorrect'), false);
});

test('«문제 다시 보기»는 끝난 판에만 받는다 — 진행 중인 응답에 섞이면 fail-closed로 거절한다', async () => {
  for (const match of [running({ review: [] }), revealingMatch({ review: [reviewItem(1)] })]) {
    await assert.rejects(() => storeReturning(match).then((store) => store.getMatch('ABC234')), /정답 풀이/);
  }

  const done = await (await storeReturning(finished({
    review: [reviewItem(1), reviewItem(2, { choiceIndex: null, correct: false, timedOut: true })],
  }))).getMatch('ABC234');
  assert.equal(done.review.length, 2);
  assert.deepEqual(done.review[1], reviewItem(2, { choiceIndex: null, correct: false, timedOut: true }));

  // 구버전 서버는 보내지 않는다 → 순위만 그린다
  const legacy = await (await storeReturning(finished())).getMatch('ABC234');
  assert.equal(Object.hasOwn(legacy, 'review'), false);
});

test('끝난 판 풀이가 하나라도 맞지 않으면 풀이만 빼고 최종 순위는 그대로 받는다', async () => {
  const invalid = [
    [reviewItem(2)],
    [reviewItem(1, { answerIndex: 4 })],
    [reviewItem(1, { choices: ['가', '나', '다'] })],
    [reviewItem(1, { correct: true, choiceIndex: 0 })],
    [reviewItem(1, { timedOut: true })],
    [reviewItem(1, { categoryId: 'unknown' })],
    [reviewItem(1), reviewItem(2), reviewItem(3)],
    'not-an-array',
  ];
  for (const review of invalid) {
    const match = await (await storeReturning(finished({ review }))).getMatch('ABC234');
    assert.equal(match.state, 'finished');
    assert.equal(match.scores.length, 2);
    assert.equal(Object.hasOwn(match, 'review'), false, JSON.stringify(review));
  }
});

// ── 결과 화면 모델 ──────────────────────────────────────────────

test('축하는 내 1~3위(공동 포함)에서 한 문제라도 맞혔을 때만 붙는다', async () => {
  const { onlineFinalCelebrates, onlineFinalResultView } = await import('../js/ui/online-result.js');
  const view = (scores) => onlineFinalResultView(finished({ scores }), ME);

  assert.equal(onlineFinalCelebrates(view([scoreRow(ME, 30), scoreRow(OTHER, 10)])), true);
  assert.equal(onlineFinalCelebrates(view([scoreRow(OTHER, 30), scoreRow(ME, 30)])), true, '공동 1위');
  assert.equal(onlineFinalCelebrates(view([
    scoreRow(OTHER, 50), scoreRow('42345678-1234-5678-9234-567812345678', 40),
    scoreRow('52345678-1234-5678-9234-567812345678', 30), scoreRow(ME, 20),
  ])), false, '4위');
  assert.equal(onlineFinalCelebrates(view([scoreRow(OTHER, 0), scoreRow(ME, 0)])), false, '모두 0점');
  assert.equal(onlineFinalCelebrates(view([scoreRow(OTHER, 10)])), false, '순위에 없다');
});

test('«문제 다시 보기» 줄은 로컬 오답 복습과 같은 «내 답 / 정답» 문법이고, 맞힌 문제는 한 줄이다', async () => {
  const { onlineReviewRows, onlineReviewToggleLabel } = await import('../js/ui/online-result.js');
  const rows = onlineReviewRows([
    reviewItem(1),
    reviewItem(2, { choiceIndex: 3, correct: false }),
    reviewItem(3, { choiceIndex: null, correct: false, timedOut: true }),
  ]);

  // 신고 주소(reportUrl)는 tests/question-report.test.mjs 가 따로 본다
  assert.deepEqual(rows.map(({ reportUrl, ...row }) => row), [
    { position: 1, question: '문제 1', result: 'correct', mine: null, answer: '나', explanation: '해설 1' },
    { position: 2, question: '문제 2', result: 'wrong', mine: '라', answer: '나', explanation: '해설 2' },
    { position: 3, question: '문제 3', result: 'timeout', mine: '시간 초과', answer: '나', explanation: '해설 3' },
  ]);
  assert.equal(onlineReviewToggleLabel(rows), '문제 다시 보기 · 3문제 중 2개 놓침');
  assert.equal(onlineReviewToggleLabel(rows.slice(0, 1)), '문제 다시 보기 · 1문제 모두 정답');
  assert.deepEqual(onlineReviewRows(undefined), []);
});

// ── 마크업·화면 계약 ────────────────────────────────────────────

test('결과 화면: 「한 판 더」가 주 행동이고 그 아래에 접힌 «문제 다시 보기»가 온다', async () => {
  const html = await source('index.html');
  const screen = html.slice(html.indexOf('data-screen="online-result"'), html.indexOf('<!-- ─────────── 내 캐릭터'));
  const at = (needle) => screen.indexOf(needle);

  assert.match(screen, /<button type="button" class="button button--primary" id="online-final-again" hidden>한 판 더<\/button>/);
  assert.match(screen, /<button type="button" class="button button--ghost" id="online-final-room">대기실로<\/button>/);
  assert.ok(at('id="online-final-ranking"') < at('id="online-final-again"'));
  assert.ok(at('id="online-final-again"') < at('id="online-final-room"'));
  assert.ok(at('id="online-final-home"') < at('id="online-final-review-toggle"'), '행동 줄이 풀이보다 먼저 온다');
  assert.match(screen, /id="online-final-review-toggle"\s+aria-controls="online-final-review-block" aria-expanded="false" hidden>/);
  assert.match(screen, /<div class="result-block online-final__review" id="online-final-review-block" hidden>/);
  assert.match(screen, /<ol class="review" id="online-final-review"><\/ol>/);
  // 화면 글에 «서버» 같은 개발 용어를 쓰지 않는다 (U40)
  assert.doesNotMatch(screen.replace(/<!--[\s\S]*?-->/g, ''), /서버/);
});

test('결과 화면 코드: 캐릭터 그림·표시 순위 칸·축하·소리·풀이 펼치기를 한곳에서 그린다', async () => {
  const result = await source('src/ui/online-result.ts');
  assert.match(result, /figure\.append\(createBody\(entry\.characterId\)\);/);
  assert.match(result, /figure\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(result, /place\.dataset\.place = String\(entry\.place\);/);
  assert.match(result, /item\.classList\.toggle\('online-final-ranking__item--celebrate', entry\.isMe && celebrate\);/);
  assert.match(result, /playFinish\(\);/);
  assert.match(
    result,
    /function setReviewExpanded\(expanded: boolean\): void \{\s*el\.reviewBlock\.hidden = !expanded;\s*el\.reviewToggle\.setAttribute\('aria-expanded', String\(expanded\)\);/,
  );
  assert.match(result, /el\.reviewToggle\.addEventListener\('click', \(\) => setReviewExpanded\(Boolean\(el\.reviewBlock\.hidden\)\)\);/);
  // 새 결과마다 접힌 채로 시작하고, 화면을 떠나면 비운다
  assert.match(result, /function renderReview\(snapshot: OnlineFinishedMatch\): void \{[\s\S]*?setReviewExpanded\(false\);/);
  assert.match(result, /hide\(\) \{[\s\S]*?setReviewExpanded\(false\);\s*el\.review\.replaceChildren\(\);/);
  // 방 밖이면 「한 판 더」를 그리지 않고 다른 버튼의 말도 맞춘다
  assert.match(result, /el\.again\.hidden = !options\.inRoom;/);
  assert.match(result, /el\.room\.textContent = options\.inRoom \? '대기실로' : '온라인 로비로';/);
  // 겹쳐 보내지 않는다 — 기다리는 동안 «연결 중…»
  assert.match(result, /if \(againPending\) return;/);
  assert.match(result, /el\.again\.textContent = busy \? '연결 중…' : '한 판 더';/);
});

test('「한 판 더」: 방장이 아니면 대기실을 열기 전에 준비를 켜고, 기다리는 사이 옮긴 화면을 덮지 않는다', async () => {
  const app = await source('src/app.ts');
  assert.match(app, /onAgain: \(\) => playAgain\(\),/);
  assert.match(
    app,
    /async function playAgain\(\): Promise<void> \{[\s\S]*?const navigation = waitingRoomEntryGeneration;\s*await readyForRematch\(roomStore, code\);\s*if \(!isCurrentNavigation\(navigation\) \|\| activeRoomCode !== code\) return;\s*await openWaitingRoom\(code\);/,
  );
  assert.match(app, /onlineResultScreen\.show\(snapshot, \{ inRoom: activeRoomCode !== null \}\);/);
});

test('결과 순위: 1~3위는 로컬 랭킹과 같은 금·은·동 칸, 캐릭터는 정지 그림 칸, 축하는 토큰 길이로 한 번만', () => {
  const screen = node("section.screen.online-final[data-screen='online-result']", node('main.app', node('body')));
  const item = (state = '') => node(`li.online-final-ranking__item${state}`, node('ol.online-final-ranking#online-final-ranking', screen));
  for (const env of [DESKTOP, MOBILE]) {
    for (const [place, medal] of [['1', 'gold'], ['2', 'silver'], ['3', 'bronze']]) {
      assert.equal(
        valueOf(rules, node(`span.online-final-ranking__place[data-place='${place}']`, item()), 'background', env),
        `var(--medal-${medal})`,
      );
    }
    assert.equal(valueOf(rules, node("span.online-final-ranking__place[data-place='4']", item()), 'background', env), 'var(--surface-subtle)');
    assert.equal(valueOf(rules, item(), 'grid-template-columns', env), 'auto auto minmax(0, 1fr) auto');
    const figure = node('span.online-final-ranking__figure', item());
    assert.equal(valueOf(rules, figure, 'width', env), '40px');
    assert.equal(valueOf(rules, figure, 'height', env), '48px');

    const celebrate = item('.online-final-ranking__item--celebrate');
    assert.match(valueOf(rules, node('span.online-final-ranking__place', celebrate), 'animation', env), /^final-place-pop var\(--duration-slow\)/);
    assert.equal(valueOf(rules, node('span.online-final-ranking__place', item()), 'animation', env), null, '내 줄이 아니면 움직이지 않는다');
    const star = node('span.online-final-ranking__star', node('span.online-final-ranking__score', celebrate));
    assert.match(valueOf(rules, star, 'mask', env) ?? '', /var\(--i-star\)/);
    assert.doesNotMatch(valueOf(rules, star, 'animation', env), /infinite/);

    // 움직임 줄이기(기기 설정)에서는 축하 움직임도 곧바로 끝난다
    const reduced = { ...env, reducedMotion: true };
    assert.match(valueOf(rules, node('span.online-final-ranking__place', celebrate), 'animation-duration', reduced) ?? '', /^0\.0+1ms$/);
    assert.equal(valueOf(rules, star, 'animation-iteration-count', reduced), '1');
  }
  // 앱의 움직임 줄이기도 같다 (U55)
  const app = node('html', null);
  app.attrs['data-motion'] = 'reduce';
  const appStar = node('span.online-final-ranking__star', node('li.online-final-ranking__item.online-final-ranking__item--celebrate', node('body', app)));
  assert.match(valueOf(rules, appStar, 'animation-duration', MOBILE) ?? '', /^0\.0+1ms$/);
});

test('맞힌 문제의 «내 답 · 정답» 줄은 ✓ 정답 알약이고, 틀린 줄은 로컬 오답 복습 그대로다', () => {
  const review = node('ol.review#online-final-review', node('div.result-block.online-final__review', node("section.screen[data-screen='online-result']", node('body'))));
  const tag = (modifier) => node('span.review__tag', node(`p.review__row.review__row--${modifier}`, node('li.review__item', review)));
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(valueOf(rules, tag('mine-correct'), '--icon', env), 'var(--i-check)');
    assert.equal(valueOf(rules, tag('mine-correct'), 'background', env), 'var(--correct-soft)');
    assert.equal(valueOf(rules, tag('mine'), '--icon', env), 'var(--i-cross)');
    assert.equal(valueOf(rules, tag('answer'), '--icon', env), 'var(--i-check)');
  }
});
