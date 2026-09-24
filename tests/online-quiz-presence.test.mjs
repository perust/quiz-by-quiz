import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('online quiz has an isolated, non-interactive layer for remote participants', async () => {
  const [html, css] = await Promise.all([source('index.html'), source('css/style.css')]);
  const choicesStart = html.indexOf('id="online-choices"');
  const arenaStart = html.indexOf('id="online-arena"');
  const arenaEnd = html.indexOf('</section>', arenaStart);
  const arenaMarkup = html.slice(arenaStart, arenaEnd);

  assert.notEqual(choicesStart, -1);
  assert.notEqual(arenaStart, -1);
  assert.ok(choicesStart < arenaStart, 'remote figures must not be children of the answer list');
  assert.match(html, /id="online-presence-status" aria-live="polite"/);
  assert.ok(html.indexOf('online-presence-status') < arenaStart);
  assert.match(arenaMarkup, /id="online-remote-characters" aria-hidden="true"/);
  assert.ok(
    arenaMarkup.indexOf('online-remote-characters')
      < arenaMarkup.indexOf('online-arena-character'),
    'the local character should remain after the remote character layer',
  );
  assert.match(css, /#online-remote-characters\s*{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.walker--name-above \.walker__name\s*{[^}]*bottom:/s);
  assert.match(css, /\.walker--name-left \.walker__name\s*{[^}]*left:\s*0/s);
  assert.match(css, /\.walker--name-right \.walker__name\s*{[^}]*right:\s*0/s);
});

test('online quiz reuses authenticated room movement without opening a second subscription', async () => {
  const [quiz, arena, app] = await Promise.all([
    source('src/ui/online-quiz.ts'),
    source('src/ui/arena.ts'),
    source('src/app.ts'),
  ]);

  assert.match(quiz, /createMovementPublisher/);
  assert.match(quiz, /createPlayerMovementController/);
  assert.match(quiz, /normalizeViewportMovement/);
  assert.match(quiz, /remoteMovements\.reconcile/);
  assert.match(quiz, /remoteMovements\.bind/);
  assert.match(quiz, /remoteMovements\.update/);
  assert.match(quiz, /remoteMovements\.reset/);
  assert.match(quiz, /startPresence\(\)/);
  assert.match(quiz, /function setRoom\(room: PublicRoom\)/);
  assert.match(quiz, /setTextIfChanged\(el\.presenceStatus, onlinePresenceText\(room\.players\)\)/);
  assert.match(quiz, /function updateMovement\(movement: OnlineMovementEvent\)/);
  assert.match(quiz, /stopPresence\(\)/);
  assert.match(
    quiz,
    /function stopPresence\(\)[\s\S]*submissionGate\.invalidate\(\);[\s\S]*snapshot = null;[\s\S]*lastArenaQuestionKey = null;[\s\S]*button\.disabled = true;/,
  );

  assert.match(arena, /onMove/);
  assert.match(arena, /createWalker\(\{[\s\S]*onMove/);

  assert.match(app, /onPresenceEvent:/);
  assert.match(app, /onlineQuizScreen\.setRoom\(event\.room\)/);
  assert.match(app, /onlineQuizScreen\.updateMovement\(event\)/);
  assert.match(app, /roomStore\.sendMovement\(\{ code, \.\.\.sample \}\)/);
  assert.match(
    app,
    /function stopOnlineMatch\(\)[\s\S]*onlineQuizScreen\.stopPresence\(\);[\s\S]*onlineMatchController\?\.close\(\)/,
  );
  assert.match(
    app,
    /onExit: \(\) => \{\s*stopOnlineMatch\(\);\s*onlineQuizScreen\.setNotice\('온라인 로비를 불러오는 중입니다\.'\);/,
  );
  assert.doesNotMatch(app, /onlineQuizScreen[\s\S]{0,200}roomStore\.subscribe/);
});
