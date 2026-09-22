import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test('online lobby action ownership rejects newer navigation and a hidden screen', async () => {
  const { isCurrentOnlineScreenAction } = await import('../js/ui/online-action.js');
  const owner = { screenRequest: 4, actionRequest: 9 };

  assert.equal(isCurrentOnlineScreenAction(owner, owner), true);
  assert.equal(
    isCurrentOnlineScreenAction(owner, { screenRequest: 4, actionRequest: 10 }),
    false,
  );
  assert.equal(
    isCurrentOnlineScreenAction(owner, { screenRequest: null, actionRequest: 9 }),
    false,
  );
  assert.equal(
    isCurrentOnlineScreenAction(owner, { screenRequest: 5, actionRequest: 9 }),
    false,
  );
});

test('join and create recheck lobby ownership before navigation side effects', async () => {
  const online = await source('../src/ui/online.ts');
  const join = between(online, '  async function joinByCode(', '  el.joinForm.addEventListener');
  const create = between(online, "  el.createForm.addEventListener('submit'", '  // ── 목록 필터');
  const showHide = between(online, '  return {', '\n  };\n}');

  assert.match(online, /const screenGuard = createLatestRequestGuard\(\);/);
  assert.match(online, /function captureNavigationAction\(\): OnlineScreenActionOwnership \| null/);
  assert.match(online, /function ownsNavigationAction\(owner: OnlineScreenActionOwnership\): boolean/);
  assert.match(
    join,
    /const owner = captureNavigationAction\(\);\s*if \(!owner\) return;[\s\S]*?await roomStore\.joinRoom\([\s\S]*?if \(!ownsNavigationAction\(owner\)\) return;[\s\S]*?commitEnterRoom\(result\.room\.code, owner\);/,
  );
  assert.match(
    create,
    /const owner = captureNavigationAction\(\);\s*if \(!owner\) return;[\s\S]*?await roomStore\.createRoom\([\s\S]*?if \(!ownsNavigationAction\(owner\)\) return;[\s\S]*?commitEnterRoom\(result\.room\.code, owner\);/,
  );
  assert.match(
    online,
    /function commitEnterRoom\(code: string, owner: OnlineScreenActionOwnership\): void \{\s*if \(!ownsNavigationAction\(owner\)\) return;\s*invalidateScreenOwnership\(\);\s*walker\.hide\(\);\s*onEnterRoom\(code\);/,
  );
  assert.match(
    online,
    /function leaveForHome\(\): void \{[\s\S]*?invalidateScreenOwnership\(\);[\s\S]*?onHome\(\);/,
  );
  assert.match(
    showHide,
    /const request = screenGuard\.begin\(\);[\s\S]*?await loadRooms\(request\);\s*if \(!ownsScreen\(request\)\) return;\s*walker\.show\(characterId\);[\s\S]*?hide\(\) \{\s*invalidateScreenOwnership\(\);\s*walker\.hide\(\);/,
  );
});
