import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canSendOnlineChat,
  shouldAutoFocusOnlineQuestion,
} from '../js/ui/online-quiz.js';
import { shouldPlacePlayerBubbleBelow } from '../js/ui/player-bubbles.js';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('question transitions do not steal focus from chat or an open help dialog', () => {
  assert.equal(shouldAutoFocusOnlineQuestion(false, false), true);
  assert.equal(shouldAutoFocusOnlineQuestion(false, true), false);
  assert.equal(shouldAutoFocusOnlineQuestion(true, false), false);
});

test('chat sends once while pending and tall bubbles choose the side with enough room', () => {
  assert.equal(canSendOnlineChat(true, false, '같이 풀자'), true);
  assert.equal(canSendOnlineChat(true, true, '같이 풀자'), false);
  assert.equal(canSendOnlineChat(false, false, '같이 풀자'), false);
  assert.equal(canSendOnlineChat(true, false, '   '), false);

  assert.equal(shouldPlacePlayerBubbleBelow(85, 60, 102, 844), true);
  assert.equal(shouldPlacePlayerBubbleBelow(85, 700, 742, 844), false);
  assert.equal(shouldPlacePlayerBubbleBelow(40, 60, 102, 844), false);
});

test('online quiz chat is a normal-flow control with an accessible recent-message log', async () => {
  const [html, css] = await Promise.all([source('index.html'), source('css/style.css')]);
  const quizStart = html.indexOf('data-screen="online-quiz"');
  // 공개 카드가 무대 바로 뒤로 옮겨 와 더 이상 화면의 마지막 자식이 아니다. 다음 화면 앞까지 본다.
  const quizEnd = html.indexOf('data-screen="online-result"', quizStart);
  const quizMarkup = html.slice(quizStart, quizEnd);

  assert.match(quizMarkup, /id="online-chat-form"[^>]*novalidate/);
  assert.match(quizMarkup, /for="online-chat-input">문제 풀이 중 한마디/);
  assert.match(quizMarkup, /id="online-chat-input"[^>]*maxlength="60"/);
  assert.match(quizMarkup, /id="online-chat-submit"[^>]*disabled/);
  assert.match(quizMarkup, /id="online-chat-log"[^>]*role="log"[^>]*aria-live="polite"/);
  // 위치를 주지 않는다. z-index 가 없어 DOM 순서가 겹침 순서라, 위치를 가진 유리 표면은 앞에 오는
  // fixed 캐릭터(내 캐릭터·다른 참가자)를 덮는다 (css-responsive-02)
  assert.doesNotMatch(css, /\.online-quiz-chat\s*{[^}]*position:/s);
  assert.match(
    css,
    /@media \(pointer: coarse\)[\s\S]*\[data-screen='online-quiz'\] \.online-quiz-chat\s*{[^}]*margin-bottom:\s*calc\(var\(--walk-stick-size\) \+ var\(--space-4\) \+ var\(--space-2\) \+ env\(safe-area-inset-bottom, 0px\)\)/,
  );
});

test('정답 공개 카드는 무대 바로 뒤, 상태 줄·채팅 앞에 오고 처음 공개될 때 한 번만 화면으로 옮긴다', async () => {
  const [html, quiz] = await Promise.all([source('index.html'), source('src/ui/online-quiz.ts')]);
  const quizStart = html.indexOf('data-screen="online-quiz"');
  const quizEnd = html.indexOf('data-screen="online-result"', quizStart);
  const quizMarkup = html.slice(quizStart, quizEnd);
  const at = (needle) => {
    const index = quizMarkup.indexOf(needle);
    assert.notEqual(index, -1, `${needle} 가 온라인 퀴즈 화면에 있다`);
    return index;
  };

  // 채팅 아래 맨 끝에 있으면 휴대폰에서는 공개 시간 안에 화면에 들어오지 않았다 (U26)
  assert.ok(at('id="online-arena"') < at('id="online-reveal"'));
  assert.ok(at('id="online-reveal"') < at('id="online-match-status"'));
  assert.ok(at('id="online-reveal"') < at('id="online-chat-form"'));
  // «정답 / 내 답» 줄은 판정과 해설 사이에 공유 마크업으로 둔다 (U11)
  assert.ok(at('id="online-reveal-verdict"') < at('id="online-reveal-answer"'));
  assert.ok(at('id="online-reveal-answer"') < at('id="online-reveal-explanation"'));
  assert.match(quizMarkup, /<div class="feedback__answer" id="online-reveal-answer" hidden><\/div>/);

  // 문항마다 한 번만, 채팅을 치는 중이 아닐 때만 옮긴다. 쓰던 글과 caret을 빼앗지 않는다.
  assert.match(
    quiz,
    /function revealIntoView\(active: OnlineActiveMatch\)[\s\S]*if \(key === revealScrolledKey\) return;[\s\S]*revealScrolledKey = key;[\s\S]*if \(document\.activeElement === el\.chatInput\) return;[\s\S]*el\.reveal\.scrollIntoView\(\{ block: 'nearest' \}\);/,
  );
  // 화면이 움직여도 fixed 캐릭터는 arena 안의 같은 자리에 남는다 (로컬 피드백과 같은 방식)
  assert.match(
    quiz,
    /const anchor = arena\.captureCharacterAnchor\(\);\s*el\.reveal\.scrollIntoView\(\{ block: 'nearest' \}\);\s*arena\.restoreCharacterAnchor\(anchor\);/,
  );
  // 다음 문제는 HUD·질문부터 보이게 맨 위로 되돌리고, 그 뒤에 새 무대 자리를 잰다
  assert.match(
    quiz,
    /function returnFromReveal\(view: OnlineQuizView\)[\s\S]*if \(document\.activeElement !== el\.chatInput\) window\.scrollTo\(0, 0\);/,
  );
  assert.match(quiz, /renderReveal\(view\);\s*returnFromReveal\(view\);[\s\S]*arena\.reset\(question\.choices\.length\);/);
});

test('online quiz chat reuses the active match subscription and binds bubbles to moving players', async () => {
  const [quiz, controller, app] = await Promise.all([
    source('src/ui/online-quiz.ts'),
    source('src/online/match-controller.ts'),
    source('src/app.ts'),
  ]);

  assert.match(controller, /\{ type: 'room' \| 'movement' \| 'chat' \}/);
  assert.match(controller, /event\.type === 'room' \|\| event\.type === 'movement' \|\| event\.type === 'chat'/);
  assert.match(quiz, /createPlayerBubbleController/);
  assert.match(quiz, /bubble\.className = 'walker__bubble'/);
  assert.match(quiz, /bindChatBubble\(player\.id, bubble\)/);
  assert.match(quiz, /function updateChat\(event: OnlineChatEvent\)/);
  assert.match(quiz, /chatBubbles\.show\(event\.playerId, event\.text\)/);
  assert.match(quiz, /chatBubbles\.reset\(\)/);
  assert.match(quiz, /el\.chatSubmit\.disabled = true/);
  assert.match(quiz, /el\.chatSubmit\.disabled = false/);
  assert.match(app, /onSendChat:/);
  assert.match(app, /roomStore\.sendChat\(\{ code, text, player: currentPlayer\(\) \}\)/);
  assert.match(app, /onlineQuizScreen\.updateChat\(event\)/);
  assert.doesNotMatch(app, /onlineQuizScreen[\s\S]{0,300}roomStore\.subscribe/);
});

test('chat focus owns typing keys and stale sends cannot mutate a stopped match lifecycle', async () => {
  const quiz = await source('src/ui/online-quiz.ts');

  assert.match(
    quiz,
    /const sendGeneration = presenceGeneration;[\s\S]*await onSendChat\(text\);[\s\S]*if \(!presenceActive \|\| sendGeneration !== presenceGeneration\) return;/,
  );
  assert.match(quiz, /if \(!canSendOnlineChat\(presenceActive, chatSendPending, text\)\) return;/);
  assert.match(quiz, /chatSendPending = true;[\s\S]*el\.chatSubmit\.disabled = true;/);
  assert.match(quiz, /finally \{[\s\S]*chatSendPending = false;[\s\S]*el\.chatSubmit\.disabled = false;/);
  assert.match(
    quiz,
    /function stopPresence\(\)[\s\S]*presenceGeneration \+= 1;[\s\S]*chatBubbles\.reset\(\);[\s\S]*el\.chatLog\.replaceChildren\(\);/,
  );
  assert.match(
    quiz,
    /if \(event\.key === '\/' && document\.activeElement !== el\.chatInput && presenceActive\)[\s\S]*el\.chatInput\.focus\(\);[\s\S]*if \(document\.activeElement === el\.chatInput\) return;[\s\S]*const choiceIndex/,
  );
  assert.match(quiz, /shouldAutoFocusOnlineQuestion\([\s\S]*document\.activeElement === el\.chatInput/);
});
