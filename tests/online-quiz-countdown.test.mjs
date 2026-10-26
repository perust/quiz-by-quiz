import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
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

test('온라인 남은 시간은 «N초 남았어요»로 보이고 남은 5초에만 경고한다', async () => {
  const { onlineCountdownView } = await import('../js/ui/online-quiz.js');
  const open = { submitted: false, lastQuestion: false };

  assert.deepEqual(onlineCountdownView('running', 20_000, 20_000, open), {
    text: '20초 남았어요', fraction: 1, warning: false,
  });
  assert.deepEqual(onlineCountdownView('running', 12_300, 20_000, open), {
    text: '13초 남았어요', fraction: 0.615, warning: false,
  });
  assert.equal(onlineCountdownView('running', 5_001, 20_000, open).warning, false);
  assert.deepEqual(onlineCountdownView('running', 5_000, 20_000, open), {
    text: '5초 남았어요', fraction: 0.25, warning: true,
  });
  // 이미 낸 사람에게는 서두르라고 하지 않는다. 시간은 계속 보여 준다.
  assert.deepEqual(onlineCountdownView('running', 3_000, 20_000, { ...open, submitted: true }), {
    text: '3초 남았어요', fraction: 0.15, warning: false,
  });
});

test('0초가 되어도 화면은 결과를 기다릴 뿐 스스로 마감하지 않는다', async () => {
  const { canAttemptOnlineSubmission, onlineCountdownView, onlineQuizView } = await import('../js/ui/online-quiz.js');
  const open = { submitted: false, lastQuestion: false };

  assert.deepEqual(onlineCountdownView('running', 0, 20_000, open), {
    text: '결과를 기다리는 중…', fraction: 0, warning: false,
  });
  assert.equal(onlineCountdownView('running', -250, 20_000, open).text, '결과를 기다리는 중…');

  // 표시가 0이어도 제출 가능 여부는 서버 snapshot만 닫는다 (CLAUDE.md: client clock으로 닫지 않는다)
  const expired = runningMatch({ remainingMs: 0 });
  assert.equal(canAttemptOnlineSubmission(expired), true);
  assert.equal(onlineQuizView(expired).canSubmit, true);
});

test('정답 공개 중에는 다음 문제(마지막 문제면 최종 순위)까지 남은 시간을 보여 준다', async () => {
  const { onlineCountdownView } = await import('../js/ui/online-quiz.js');

  assert.deepEqual(
    onlineCountdownView('revealing', 7_200, 8_000, { submitted: false, lastQuestion: false }),
    { text: '다음 문제까지 8초', fraction: 0.9, warning: false },
  );
  assert.equal(
    onlineCountdownView('revealing', 2_000, 8_000, { submitted: false, lastQuestion: true }).text,
    '최종 순위까지 2초',
  );
  assert.equal(
    onlineCountdownView('revealing', 0, 8_000, { submitted: false, lastQuestion: false }).text,
    '다음 문제를 불러오는 중…',
  );
  // 공개 중에는 경고하지 않는다 — 더 낼 답이 없다.
  assert.equal(onlineCountdownView('revealing', 1_000, 8_000, { submitted: false, lastQuestion: false }).warning, false);
});

test('카운트다운은 수신 시각 + remainingMs로 다시 계산하는 rAF 표시 루프이고 화면을 떠나면 멈춘다', async () => {
  const quiz = await source('src/ui/online-quiz.ts');

  assert.doesNotMatch(quiz, /renderServerTimeNotice/);
  assert.match(quiz, /const deadline = performance\.now\(\) \+ remainingMs;/);
  assert.match(quiz, /countdownDeadline = Math\.min\(countdownDeadline, deadline\);/);
  assert.match(quiz, /const remaining = Math\.max\(countdownDeadline - performance\.now\(\), 0\);/);
  assert.match(quiz, /if \(remaining > 0\) countdownFrame = requestAnimationFrame\(tickCountdown\);/);
  assert.match(quiz, /el\.timer\.classList\.toggle\('timer--warning', view\.warning\);/);
  // 경고 낭독은 문항당 한 번. 타이머 영역 자체는 aria-hidden 그대로다.
  assert.match(
    quiz,
    /if \(view\.warning && warnedQuestionKey !== questionKey\) \{\s*warnedQuestionKey = questionKey;\s*announce\(/,
  );
  // 표시 루프는 답을 내지 않는다. 마감은 서버가 판정한다.
  const tick = quiz.slice(quiz.indexOf('function tickCountdown'), quiz.indexOf('async function submitChoice'));
  assert.doesNotMatch(tick, /submitChoice|onSubmit|\.click\(\)/);
  // 화면을 떠나거나 매치가 끝나면 프레임을 거둔다.
  assert.match(quiz, /function stopPresence\(\)[\s\S]*stopCountdown\(\);/);
  assert.match(quiz, /if \(nextSnapshot\.state === 'finished'\) \{\s*stopCountdown\(\);/);
  assert.match(quiz, /function stopCountdown\(\): void \{\s*if \(countdownFrame !== null\) cancelAnimationFrame\(countdownFrame\);/);
  // 남은 시간을 보내지 않는 구버전 서버에서는 안내 문구로 돌아간다.
  assert.match(quiz, /if \(remainingMs === undefined\) \{\s*renderTimeNotice\(\);/);

  const html = await source('index.html');
  assert.match(html, /<div class="timer" id="online-timer" aria-hidden="true">/);
});

test('구버전 서버 안내와 첫 문구에도 «서버» 같은 개발 용어를 쓰지 않는다', async () => {
  const { ONLINE_TIME_NOTICE } = await import('../js/ui/online-quiz.js');
  const html = await source('index.html');
  const timer = html.slice(html.indexOf('id="online-timer"'), html.indexOf('id="online-question-text"'));

  assert.doesNotMatch(ONLINE_TIME_NOTICE, /서버/);
  assert.match(timer, /<span id="online-timer-text">남은 시간을 확인하는 중이에요<\/span>/);
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

async function storeReturning(match) {
  const identity = { id: MATCH_ID, secret: 'browser-session-secret-with-thirty-two-chars' };
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) {
      return new Response(JSON.stringify({ playerId: identity.id }), { status: 200 });
    }
    if (url.endsWith('/v1/rooms/ABC234/match')) {
      return new Response(JSON.stringify(match), { status: 200 });
    }
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

test('네트워크 어댑터는 서버의 remainingMs를 표시용으로 넘기고, 없거나 깨졌으면 뺀다', async () => {
  const fresh = await (await storeReturning(runningMatch({ remainingMs: 12_345 }))).getMatch('ABC234');
  assert.equal(fresh.remainingMs, 12_345);

  const revealing = await (await storeReturning({
    ...runningMatch({ remainingMs: 7_000 }),
    state: 'revealing',
    reveal: { position: 1, choiceIndex: null, timedOut: true, correct: false, answerIndex: 1, explanation: '해설' },
  })).getMatch('ABC234');
  assert.equal(revealing.remainingMs, 7_000);

  // 구버전 서버: 필드 자체가 없다 → 화면이 예전 안내로 돌아갈 수 있게 그대로 없음
  const legacy = await (await storeReturning(runningMatch())).getMatch('ABC234');
  assert.equal(Object.hasOwn(legacy, 'remainingMs'), false);

  // 표시용 값 하나가 깨졌다고 매치 전체를 거절하지 않는다
  for (const broken of [-1, 'soon', null, Number.NaN]) {
    const match = await (await storeReturning(runningMatch({ remainingMs: broken }))).getMatch('ABC234');
    assert.equal(match.state, 'running');
    assert.equal(Object.hasOwn(match, 'remainingMs'), false);
  }
});
