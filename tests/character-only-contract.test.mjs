import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('제품 UI에는 보통/게임 모드 선택이 없고 로컬·온라인 퀴즈 모두 캐릭터 무대를 가진다', async () => {
  const html = await source('index.html');

  assert.doesNotMatch(html, /id="game-mode-(?:toggle|icon|label)"/);
  assert.doesNotMatch(html, /id="setting-mode(?:-value)?"/);
  assert.doesNotMatch(html, /보통 모드/);
  assert.match(html, /id="arena"/);
  assert.match(html, /id="online-arena"/);
  assert.match(html, /id="online-arena-character"/);
  assert.match(html, /id="online-arena-tiles"/);
});

test('사용자 설정과 화면 흐름에는 선택 가능한 gameMode 상태가 없다', async () => {
  const [types, store, app, waiting, online] = await Promise.all([
    source('src/types.ts'),
    source('src/storage/local-store.ts'),
    source('src/app.ts'),
    source('src/ui/waiting-room.ts'),
    source('src/ui/online.ts'),
  ]);

  assert.doesNotMatch(types, /gameMode\s*:\s*boolean/);
  assert.doesNotMatch(store, /saved\.gameMode|gameMode:\s*false/);
  assert.doesNotMatch(app, /gameModeToggle|restoreMyGameMode|setGameMode/);
  assert.doesNotMatch(waiting, /setting-mode|modeValue|gameMode\s*\?/);
  assert.doesNotMatch(online, /보통 모드|게임 모드/);
});

test('로컬과 온라인 문제 화면은 같은 캐릭터 arena 경계를 사용한다', async () => {
  const [localQuiz, onlineQuiz] = await Promise.all([
    source('src/ui/quiz.ts'),
    source('src/ui/online-quiz.ts'),
  ]);

  assert.match(localQuiz, /createArena\(/);
  assert.match(localQuiz, /arena\.setEnabled\(true\)/);
  assert.match(onlineQuiz, /createCharacterArena\(/);
  assert.match(onlineQuiz, /setCharacter\(id/);
  assert.match(onlineQuiz, /arena\.showOutcome\(/);
  assert.match(
    onlineQuiz,
    /shouldAutoFocusOnlineQuestion\(\s*arena\.isDialogOpen\(\)/,
  );
  assert.match(
    onlineQuiz,
    /setRefreshError\(message\) \{\s*setStatus\(`온라인 매치 오류: \$\{message\}`\);\s*\}/,
  );
  assert.match(
    onlineQuiz,
    /setSubmitError\(message, owner\)[\s\S]*ownsOnlineSubmitError\(current, owner\)[\s\S]*submissionGate\.owns\(owner\)[\s\S]*submissionGate\.invalidate\(owner\)[\s\S]*setStatus/,
  );
});
