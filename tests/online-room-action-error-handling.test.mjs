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

test('대기실의 네트워크 방 작업은 실패를 알리고 leave/chat 성공 상태를 보존한다', async () => {
  const waiting = await source('../src/ui/waiting-room.ts');

  const patch = between(waiting, 'async function patch(change: RoomPatch)', "  el.category.addEventListener('click'");
  assert.match(patch, /const action = captureAction\(\);\s*if \(!action\) return;/);
  assert.match(patch, /await roomStore\.updateRoom\(\{ code: action\.code, patch: change \}\);/);
  assert.match(
    patch,
    /catch\s*\{\s*if \(!ownsAction\(action\)\) return;\s*notice\('방 설정을 바꾸지 못했어요\. 연결을 확인한 뒤 다시 시도해 주세요\.'\);/,
  );

  const leave = between(waiting, "  el.leave.addEventListener('click'", '  // ── 채팅');
  assert.match(
    leave,
    /const action = captureAction\(\);\s*const entryGeneration = visibleEntry\?\.entryGeneration;\s*if \(!action\) \{\s*if \(visibleEntry\) onLeave\(visibleEntry\.code, visibleEntry\.entryGeneration\);\s*return;\s*\}\s*if \(entryGeneration === undefined\) return;/,
  );
  assert.match(leave, /await roomStore\.leaveRoom\(\{ code: action\.code \}\);/);
  assert.match(leave, /if \(!ownsAction\(action, false\)\) return;\s*onLeave\(action\.code, entryGeneration\);/);
  assert.match(
    leave,
    /catch\s*\{\s*if \(!ownsAction\(action, false\)\) return;\s*notice\('방에서 나오지 못했어요\. 연결을 확인한 뒤 다시 시도해 주세요\.'\);/,
  );

  const chat = between(waiting, "  el.chatForm.addEventListener('submit'", '  /**\n   * 채팅칸과 걷기를 오간다.');
  assert.match(chat, /const action = captureAction\(\);\s*if \(!action\) return;/);
  assert.match(
    chat,
    /await roomStore\.sendChat\(\{ code: action\.code, text, player: getPlayer\(\) \}\);/,
  );
  assert.match(chat, /if \(!ownsAction\(action, false\)\) return;/);
  assert.match(
    chat,
    /catch\s*\{\s*if \(!ownsAction\(action, false\)\) return;\s*notice\('메시지를 보내지 못했어요\. 연결을 확인한 뒤 다시 시도해 주세요\.'\);/,
  );
  assert.match(chat, /if \(el\.chatInput\.value === text\) \{[\s\S]*?el\.chatInput\.value = '';/);
});

test('로비의 나가기 실패는 목록 갱신 대신 화면 메시지로 처리한다', async () => {
  const online = await source('../src/ui/online.ts');
  const leave = between(online, '  async function leave(code: string)', '  async function joinByCode(');

  assert.match(
    leave,
    /const request = visibleRequest;\s*if \(request === null \|\| !ownsScreen\(request\)\) return;[\s\S]*?await roomStore\.leaveRoom\(\{ code \}\);\s*if \(!ownsScreen\(request\)\) return;\s*await loadRooms\(request\);\s*\}\s*catch\s*\{\s*if \(!ownsScreen\(request\)\) return;\s*say\(el\.message, '방에서 나오지 못했어요\. 연결을 확인한 뒤 다시 시도해 주세요\.', 'bad'\);/,
  );
});
