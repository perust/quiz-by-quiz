import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shouldAutoFocusOnlineQuestion } from '../js/ui/online-quiz.js';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('question transitions do not steal focus from chat or an open help dialog', () => {
  assert.equal(shouldAutoFocusOnlineQuestion(false, false), true);
  assert.equal(shouldAutoFocusOnlineQuestion(false, true), false);
  assert.equal(shouldAutoFocusOnlineQuestion(true, false), false);
});

test('online quiz chat is a normal-flow control with an accessible recent-message log', async () => {
  const [html, css] = await Promise.all([source('index.html'), source('css/style.css')]);
  const quizStart = html.indexOf('data-screen="online-quiz"');
  const quizEnd = html.indexOf('</section>', html.indexOf('id="online-reveal"', quizStart));
  const quizMarkup = html.slice(quizStart, quizEnd);

  assert.match(quizMarkup, /id="online-chat-form"[^>]*novalidate/);
  assert.match(quizMarkup, /for="online-chat-input">문제 풀이 중 한마디/);
  assert.match(quizMarkup, /id="online-chat-input"[^>]*maxlength="60"/);
  assert.match(quizMarkup, /id="online-chat-submit"[^>]*disabled/);
  assert.match(quizMarkup, /id="online-chat-log"[^>]*role="log"[^>]*aria-live="polite"/);
  assert.match(css, /\.online-quiz-chat\s*{[^}]*position:\s*relative/s);
  assert.doesNotMatch(css, /\.online-quiz-chat\s*{[^}]*position:\s*(?:fixed|absolute)/s);
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
