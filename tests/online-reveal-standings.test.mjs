import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, node, valueOf } from './css-cascade.mjs';

// 공개 단계의 미니 점수판·정답자 수·이름표 ✓/✗ (U30)와 내 결과 효과음 (N03).
// 원칙: 아직 답을 고르는 사람에게 남의 점수·정오·정답자 수를 보이지 않는다(PRD 2.1). 지어낸 값도 없다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

const MATCH_ID = '12345678-1234-5678-9234-567812345678';
const ME = 'a2345678-1234-5678-9234-567812345678';
const id = (n) => `b${String(n).padStart(7, '0')}-1234-5678-9234-567812345678`;

function score(playerId, nickname, points, lastAnswerCorrect) {
  return {
    playerId, nickname, characterId: 'slime-blue',
    score: points, correctCount: points / 10, answeredCount: 3,
    ...(lastAnswerCorrect === undefined ? {} : { lastAnswerCorrect }),
  };
}

function revealing(scores) {
  return {
    matchId: MATCH_ID, state: 'revealing', categoryId: 'history', gameMode: true,
    currentPosition: 3, totalQuestions: 10, deadlineAt: '2026-09-18T11:00:20+00:00',
    question: {
      id: 'history-003', categoryId: 'history', question: '문제',
      choices: ['가', '나', '다', '라'], position: 3, total: 10,
    },
    ownSubmission: null,
    reveal: { position: 3, choiceIndex: 1, timedOut: false, correct: true, answerIndex: 1, explanation: '해설' },
    scores,
  };
}

test('미니 점수판은 공개 단계에만 있다 — 고르는 중(running)이나 끝난 판에는 만들지 않는다', async () => {
  const { onlineRevealStandings } = await import('../js/ui/online-quiz.js');
  const scores = [score(ME, '나', 20, true), score(id(1), '민수', 10, false)];
  const reveal = revealing(scores);

  assert.notEqual(onlineRevealStandings(reveal, ME), null);
  // 같은 점수 배열이 섞여 와도 running에서는 그리지 않는다
  assert.equal(onlineRevealStandings({ ...reveal, state: 'running', reveal: null, scores }, ME), null);
  assert.equal(onlineRevealStandings({ ...reveal, state: 'finished', question: null, reveal: null }, ME), null);
  assert.equal(onlineRevealStandings(revealing([]), ME), null);
});

test('공개 단계 순위는 서버 순서 그대로, 같은 점수는 같은 순위이고 닉네임이 순위를 정하지 않는다', async () => {
  const { onlineRevealStandings, onlineRevealTally } = await import('../js/ui/online-quiz.js');
  const view = onlineRevealStandings(revealing([
    score(id(1), '가나다', 30, true),
    score(ME, '하하', 30, true),
    score(id(2), '마바사', 10, false),
  ]), ME);

  assert.deepEqual(view.rows.map(({ nickname, place, tied, isMe, correct }) => ({ nickname, place, tied, isMe, correct })), [
    { nickname: '가나다', place: 1, tied: true, isMe: false, correct: true },
    { nickname: '하하', place: 1, tied: true, isMe: true, correct: true },
    { nickname: '마바사', place: 3, tied: false, isMe: false, correct: false },
  ]);
  assert.equal(view.correctCount, 2);
  assert.equal(view.playerCount, 3);
  assert.equal(view.hiddenCount, 0);
  assert.equal(onlineRevealTally(view), '이번 문제 정답 2/3명');
  assert.deepEqual([...view.results], [[id(1), true], [ME, true], [id(2), false]]);

  // 이름만 바꿔도(서버가 동점을 닉네임 순으로 늘어놓는다) 표시 순위는 같다
  const swapped = onlineRevealStandings(revealing([
    score(ME, '하하', 30, true),
    score(id(1), '가나다', 30, true),
    score(id(2), '마바사', 10, false),
  ]), ME);
  assert.deepEqual(swapped.rows.map(({ place }) => place), [1, 1, 3]);
});

test('참가자별 정오를 모르면(구버전 서버·일부만 옴) «정답 n/m명»과 ✓/✗를 지어내지 않는다', async () => {
  const { onlineRevealStandings, onlineRevealTally } = await import('../js/ui/online-quiz.js');
  const legacy = onlineRevealStandings(revealing([score(ME, '나', 20), score(id(1), '민수', 10)]), ME);
  assert.equal(legacy.correctCount, null);
  assert.equal(onlineRevealTally(legacy), null);
  assert.deepEqual(legacy.rows.map(({ correct }) => correct), [null, null]);
  assert.equal(legacy.results.size, 0);

  const partial = onlineRevealStandings(revealing([score(ME, '나', 20, true), score(id(1), '민수', 10)]), ME);
  assert.equal(partial.correctCount, null, '한 사람이라도 모르면 세지 않는다');
  assert.deepEqual([...partial.results], [[ME, true]]);
});

test('큰 방은 위 다섯 줄(같은 점수는 모두)과 내 줄만 그리고 나머지는 수로 알린다', async () => {
  const { onlineRevealStandings, REVEAL_STANDINGS_LIMIT } = await import('../js/ui/online-quiz.js');
  assert.equal(REVEAL_STANDINGS_LIMIT, 5);
  const points = [80, 70, 60, 50, 40, 40, 40, 10, 0];
  const scores = points.map((value, index) => score(index === 8 ? ME : id(index), `참가자${index}`, value, value > 30));
  const view = onlineRevealStandings(revealing(scores), ME);

  // 다섯째의 공동 5위가 셋이면 셋 모두 보인다 — 이름 순서로 잘라 내지 않는다
  assert.deepEqual(view.rows.map(({ place }) => place), [1, 2, 3, 4, 5, 5, 5, 9]);
  assert.deepEqual(view.rows.map(({ afterGap }) => afterGap), [false, false, false, false, false, false, false, true]);
  assert.equal(view.rows.at(-1).isMe, true);
  assert.equal(view.hiddenCount, 1);
  // ✓/✗는 그리지 않은 사람의 캐릭터에도 단다
  assert.equal(view.results.size, 9);

  // 내가 위에 있으면 덧붙이지 않는다
  const top = onlineRevealStandings(revealing(scores.map((row, index) => ({ ...row, playerId: index === 0 ? ME : id(index) }))), ME);
  assert.equal(top.rows.length, 7);
  assert.equal(top.rows.some(({ afterGap }) => afterGap), false);
  assert.equal(top.hiddenCount, 2);
});

test('내 결과 효과음은 로컬 피드백과 같은 세 소리다 (N03)', async () => {
  const { onlineRevealSound } = await import('../js/ui/online-quiz.js');
  assert.equal(onlineRevealSound({ correct: true, timedOut: false }), 'correct');
  assert.equal(onlineRevealSound({ correct: false, timedOut: false }), 'wrong');
  assert.equal(onlineRevealSound({ correct: false, timedOut: true }), 'timeout');
});

test('점수판은 공개 카드 안 해설 뒤에 있고, «정답 n/m명»만 낭독되며 공개가 끝나면 비운다', async () => {
  const [html, quiz] = await Promise.all([source('index.html'), source('src/ui/online-quiz.ts')]);
  const reveal = html.slice(html.indexOf('id="online-reveal"'), html.indexOf('id="online-match-status"'));
  assert.ok(reveal.indexOf('id="online-reveal-explanation"') < reveal.indexOf('id="online-standings"'));
  assert.match(reveal, /<div class="online-standings" id="online-standings" hidden><\/div>/);

  // 순위 목록은 라이브 리전에서 뺀다. 숨긴 채로 채우지 않는다 (먼저 펼치고 넣는다)
  assert.match(quiz, /list\.setAttribute\('aria-live', 'off'\);/);
  assert.match(quiz, /el\.standings\.hidden = false;[\s\S]*?el\.standings\.replaceChildren\(\.\.\.children\);/);
  // 내용이 바뀔 때만 다시 만든다 — 같은 공개를 다시 읽어도 다시 낭독하지 않는다
  assert.match(quiz, /if \(key === standingsKey\) return;/);
  assert.match(quiz, /const standings = view\.reveal === null \? null : onlineRevealStandings\(active, getPlayerId\(\)\);/);
  // 화면을 떠나면 점수판·정오·효과음 기억을 모두 비운다
  assert.match(
    quiz,
    /function stopPresence\(\)[\s\S]*?standingsKey = null;\s*revealResults = null;\s*revealSoundKey = null;\s*el\.standings\.hidden = true;\s*el\.standings\.replaceChildren\(\);/,
  );
  // 내 줄은 바탕색만이 아니라 «나» 글자로도, 정오는 숨긴 글자로도 말한다
  assert.match(quiz, /me\.textContent = '나';/);
  assert.match(quiz, /row\.correct \? '이번 문제 정답' : '이번 문제 오답'/);
  // 표식 글리프를 화면 글자로 쓰지 않는다 (주석의 설명은 괜찮다)
  assert.doesNotMatch(quiz, /['"`][^'"`\n]*[✓✗✔✘][^'"`\n]*['"`]/u);
});

test('원격 캐릭터 이름표의 ✓/✗는 상태 클래스이고 공개가 아니면 떼며, 명단이 바뀌어도 다시 단다', async () => {
  const quiz = await source('src/ui/online-quiz.ts');
  assert.match(quiz, /character\.classList\.toggle\('walker--answer-correct', result === true\);/);
  assert.match(quiz, /character\.classList\.toggle\('walker--answer-wrong', result === false\);/);
  assert.match(quiz, /revealResults = standings\?\.results \?\? null;\s*paintRemoteResults\(\);/);
  assert.match(quiz, /function setRoom\(room: PublicRoom\)[\s\S]*?paintRemoteResults\(\);\s*movementPublisher\.resend\(\);/);

  for (const env of [DESKTOP, MOBILE]) {
    const walker = (state) => node(`div.walker.walker--remote${state}`, node('div#online-remote-characters', node('body')));
    for (const [state, icon, ink] of [['.walker--answer-correct', 'check', 'correct-ink'], ['.walker--answer-wrong', 'cross', 'wrong-ink']]) {
      const name = node('span.walker__name', walker(state));
      const mark = node('span.walker__name::before', walker(state));
      assert.equal(valueOf(rules, name, '--icon', env), `var(--i-${icon})`);
      assert.match(valueOf(rules, mark, 'mask', env) ?? '', /var\(--icon\)/);
      assert.equal(valueOf(rules, mark, 'color', env), `var(--${ink})`);
      // 줄임표가 그대로 먹도록 이름표를 flex 로 바꾸지 않는다
      assert.equal(valueOf(rules, name, 'display', env), null);
    }
    const plain = node('span.walker__name::before', walker(''));
    assert.equal(valueOf(rules, plain, 'mask', env), null, '공개가 아니면 표식이 없다');
  }
});

test('내 결과 효과음은 문항마다 처음 공개될 때 한 번, audio.ts 를 거쳐 소리 설정을 따른다 (N03)', async () => {
  const quiz = await source('src/ui/online-quiz.ts');
  assert.match(quiz, /import \{ playCorrect, playTimeout, playWrong \} from '\.\.\/audio\.js';/);
  assert.match(
    quiz,
    /function playRevealSound\([\s\S]*?if \(active\.state !== 'revealing' \|\| view\.reveal === null\) return;[\s\S]*?if \(key === revealSoundKey\) return;\s*revealSoundKey = key;/,
  );
  assert.match(quiz, /renderStandings\(nextSnapshot, view\);\s*playRevealSound\(nextSnapshot, view\);/);
  // 째깍거리는 카운트다운 소리는 없다 — 남은 시간 표시 루프는 소리를 내지 않는다
  const tick = quiz.slice(quiz.indexOf('function tickCountdown'), quiz.indexOf('async function submitChoice'));
  assert.doesNotMatch(tick, /play[A-Z]/);
});

test('점수판 칸: 금·은·동은 표시 순위로 칠하고, 내 줄은 보라 바탕·왼쪽 띠, 정오 표식은 모양으로 읽힌다', () => {
  const card = node('section.online-reveal#online-reveal', node("section.screen[data-screen='online-quiz']", node('body')));
  const list = node('ol.online-standings__list', node('div.online-standings#online-standings', card));
  const item = (state = '') => node(`li.online-standings__item${state}`, list);
  for (const env of [DESKTOP, MOBILE]) {
    for (const [place, medal] of [['1', 'gold'], ['2', 'silver'], ['3', 'bronze']]) {
      const badge = node(`span.online-standings__place[data-place='${place}']`, item());
      assert.equal(valueOf(rules, badge, 'background', env), `var(--medal-${medal})`);
    }
    assert.equal(valueOf(rules, item('.online-standings__item--mine'), 'background', env), 'var(--accent-soft)');
    assert.equal(valueOf(rules, item('.online-standings__item--mine'), 'box-shadow', env), 'var(--marker-mine)');
    for (const [state, icon] of [['correct', 'check'], ['wrong', 'cross']]) {
      const result = `span.online-standings__result.online-standings__result--${state}`;
      assert.equal(valueOf(rules, node(result, item()), '--icon', env), `var(--i-${icon})`);
      assert.match(valueOf(rules, node(`${result}::before`, item()), 'mask', env) ?? '', /var\(--icon\)/);
    }
    // 걷는 캐릭터 뒤의 문서 흐름 표면이라 위치를 갖지 않는다 (css-responsive-02)
    for (const surface of [node('div.online-standings#online-standings', card), list, item()]) {
      const position = valueOf(rules, surface, 'position', env);
      assert.ok(position === null || position === 'static', `position ${position}`);
    }
  }
});
