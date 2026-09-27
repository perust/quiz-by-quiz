import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test('온라인 로비는 방 목록을 먼저 보여 주고 참가·생성 폼을 필요할 때만 펼친다', async () => {
  const [html, online] = await Promise.all([
    source('../index.html'),
    source('../src/ui/online.ts'),
  ]);
  const lobby = between(html, 'data-screen="online"', 'data-screen="waiting"');

  assert.match(lobby, /id="open-public-rooms"[^>]*aria-pressed="true"/);
  assert.match(lobby, /id="open-private-join"[^>]*aria-controls="private-join-block"[^>]*aria-pressed="false"/);
  assert.match(lobby, /id="open-create-room"[^>]*aria-controls="create-room-block"[^>]*aria-pressed="false"/);
  assert.match(lobby, /id="private-join-block"[^>]*hidden/);
  assert.match(lobby, /id="create-room-block"[^>]*hidden/);

  assert.match(online, /type OnlinePanel = 'rooms' \| 'join' \| 'create';/);
  assert.match(
    online,
    /function showPanel\(panel: OnlinePanel[\s\S]*?joinBlock\.hidden = panel !== 'join'[\s\S]*?createBlock\.hidden = panel !== 'create'/,
  );
  assert.match(
    online,
    /function preparePrivateJoin\(room: PublicRoom\)[\s\S]*?showPanel\('join'/,
  );
  assert.match(
    online,
    /el\.openPublic\.addEventListener\('click',[\s\S]*?showPanel\('rooms'/,
  );
  assert.match(
    online,
    /el\.openPrivate\.addEventListener\('click',[\s\S]*?showPanel\('join'/,
  );
  assert.match(
    online,
    /el\.openCreate\.addEventListener\('click',[\s\S]*?showPanel\('create'/,
  );
  assert.match(
    online,
    /async show\(characterId, notice\)[\s\S]*?resetRoomFilters\(\);[\s\S]*?showPanel\('rooms'/,
  );
});

test('빈 방 목록은 첫 방 만들기 또는 필터 초기화로 바로 이어진다', async () => {
  const [html, online] = await Promise.all([
    source('../index.html'),
    source('../src/ui/online.ts'),
  ]);
  const lobby = between(html, 'data-screen="online"', 'data-screen="waiting"');

  assert.match(lobby, /<div class="room-empty" id="room-empty"[^>]*hidden>/);
  assert.match(lobby, /id="room-empty-title"/);
  assert.match(lobby, /id="room-empty-copy"/);
  assert.match(lobby, /id="room-empty-action"/);
  assert.match(online, /emptyTitle: need\('room-empty-title'\)/);
  assert.match(online, /emptyCopy: need\('room-empty-copy'\)/);
  assert.match(online, /emptyAction: need<HTMLButtonElement>\('room-empty-action'\)/);
  assert.match(online, /'첫 방 만들기'/);
  assert.match(online, /'필터 초기화'/);
  assert.match(
    online,
    /el\.emptyAction\.addEventListener\('click',[\s\S]*?showPanel\('create'/,
  );
});

test('온라인 워커는 홈 버튼을 가리지 않도록 캐릭터 높이만큼 아래에서 시작한다', async () => {
  const online = await source('../src/ui/online.ts');

  assert.match(
    online,
    /startPoint: \(\) => \{[\s\S]*?el\.home\.getBoundingClientRect\(\)[\s\S]*?box\.bottom \+ el\.character\.offsetHeight \+ 6/,
  );
  assert.doesNotMatch(online, /startAt: \(\) => el\.home/);
});

test('온라인 전용 시각 계층은 영웅 영역·행동 카드·빈 상태를 반응형으로 구분한다', async () => {
  const [html, style] = await Promise.all([
    source('../index.html'),
    source('../css/style.css'),
  ]);
  const lobby = between(html, 'data-screen="online"', 'data-screen="waiting"');

  assert.match(lobby, /class="online-hero"/);
  assert.match(lobby, /class="online-action-card/);
  assert.match(lobby, /class="room-empty__icon"/);
  assert.match(style, /\.online-hero\s*\{/);
  assert.match(style, /\.online-action-card\s*\{/);
  assert.match(style, /\.online-action-card\[aria-pressed='true'\]/);
  assert.match(style, /\.room-empty__icon\s*\{/);
  assert.match(style, /@media \(max-width: 420px\)[\s\S]*?\.online-action-card__copy/);
});
