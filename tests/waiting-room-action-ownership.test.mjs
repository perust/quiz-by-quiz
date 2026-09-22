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

test('waiting-room action ownership rejects navigation and newer snapshots', async () => {
  const { isCurrentWaitingRoomAction } = await import('../js/ui/waiting-room-action.js');
  const snapshot = { code: 'AAA111' };
  const action = { request: 7, code: 'AAA111', snapshot };

  assert.equal(isCurrentWaitingRoomAction(action, { request: 7, room: snapshot }), true);
  assert.equal(isCurrentWaitingRoomAction(action, { request: 8, room: snapshot }), false);
  assert.equal(isCurrentWaitingRoomAction(action, { request: 7, room: { code: 'BBB222' } }), false);
  assert.equal(isCurrentWaitingRoomAction(action, { request: 7, room: { code: 'AAA111' } }), false);
  assert.equal(
    isCurrentWaitingRoomAction(action, { request: 7, room: { code: 'AAA111' } }, false),
    true,
  );
});

test('every awaited waiting-room action checks its captured owner before side effects', async () => {
  const waiting = await source('../src/ui/waiting-room.ts');
  const patch = between(waiting, '  async function patch', '  el.category.addEventListener');
  const ready = between(waiting, "  el.ready.addEventListener", '  // 여기서 판을 열지 않는다.');
  const start = between(waiting, "  el.start.addEventListener", "  el.leave.addEventListener");
  const leave = between(waiting, "  el.leave.addEventListener", '  // ── 채팅');
  const chat = between(waiting, "  el.chatForm.addEventListener", '  /**\n   * 채팅칸과 걷기를 오간다.');

  assert.match(waiting, /let visibleRequest: number \| null = null;/);
  assert.match(waiting, /function captureAction\(\): WaitingRoomActionOwnership \| null/);
  for (const action of [patch, ready, start, chat]) {
    assert.match(action, /const action = captureAction\(\);/);
    assert.match(action, /if \(!action\) return;/);
  }
  assert.match(
    leave,
    /const action = captureAction\(\);\s*const entryGeneration = visibleEntry\?\.entryGeneration;\s*if \(!action\) \{\s*if \(visibleEntry\) onLeave\(visibleEntry\.code, visibleEntry\.entryGeneration\);\s*return;\s*\}\s*if \(entryGeneration === undefined\) return;/,
  );
  assert.match(patch, /await roomStore\.updateRoom[\s\S]*?if \(!ownsAction\(action\)\) return;/);
  assert.match(ready, /await roomStore\.setReady[\s\S]*?if \(!ownsAction\(action\)\) return;/);
  assert.match(start, /await roomStore\.startGame[\s\S]*?if \(!ownsAction\(action\)\) return;/);
  assert.match(leave, /await roomStore\.leaveRoom[\s\S]*?if \(!ownsAction\(action, false\)\) return;/);
  assert.match(leave, /onLeave\(action\.code, entryGeneration\);/);
  assert.match(chat, /await roomStore\.sendChat[\s\S]*?if \(!ownsAction\(action, false\)\) return;/);
  assert.match(chat, /if \(el\.chatInput\.value === text\) \{\s*el\.chatInput\.value = '';[\s\S]*?el\.chatInput\.blur\(\);\s*\}/);
});