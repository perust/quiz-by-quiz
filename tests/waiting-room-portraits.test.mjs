import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function player(id, nickname, isReady, connected = true) {
  return {
    id,
    nickname,
    characterId: id === 'host' ? 'slime-green' : 'slime-blue',
    isReady,
    connected,
  };
}

test('대기실 액자 모델은 참가자 전원과 방장·나·준비·연결 끊김을 구분한다', async () => {
  const { waitingRoomPortraits } = await import('../js/ui/waiting-room-portrait.js');
  const players = [
    player('host', '방장', false),
    player('me', '퀴즈왕', true),
    player('guest', '친구', false),
    player('ghost', '유령', true, false),
  ];

  // 방장은 시작 요청이 곧 준비라 «준비»로 보인다(U28). 오래 끊긴 사람은 준비했어도
  // 시작 판정이 기다리지 않으므로 «연결 끊김»이 먼저다(U24).
  assert.deepEqual(waitingRoomPortraits(players, 'me'), [
    {
      id: 'host', nickname: '방장', characterId: 'slime-green',
      isHost: true, isMe: false, isReady: true, connected: true, statusLabel: '준비',
    },
    {
      id: 'me', nickname: '퀴즈왕', characterId: 'slime-blue',
      isHost: false, isMe: true, isReady: true, connected: true, statusLabel: '준비',
    },
    {
      id: 'guest', nickname: '친구', characterId: 'slime-blue',
      isHost: false, isMe: false, isReady: false, connected: true, statusLabel: '대기',
    },
    {
      id: 'ghost', nickname: '유령', characterId: 'slime-blue',
      isHost: false, isMe: false, isReady: false, connected: false, statusLabel: '연결 끊김',
    },
  ]);
});

test('연결 끊김 상태판은 색만이 아니라 경고 표식·점선·글자로 구분된다', async () => {
  const [{ loadStyles, valueOf, node, MOBILE }, waiting] = await Promise.all([
    import('./css-cascade.mjs'),
    source('../src/ui/waiting-room.ts'),
  ]);
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const env = MOBILE;
  const offline = node('span.lounge__ready.lounge__ready--offline');

  assert.match(valueOf(rules, node('span.lounge__ready.lounge__ready--offline::before'), 'mask', env) ?? '', /var\(--i-alert\)/);
  assert.equal(valueOf(rules, node('span.lounge__ready.lounge__ready--offline::before'), 'border-radius', env), '0');
  assert.equal(valueOf(rules, offline, 'border-style', env), 'dashed');
  assert.match(waiting, /lounge__ready--offline/);
  assert.match(waiting, /lounge__player--offline/);
  assert.match(waiting, /if \(player\.isMe \|\| !player\.connected\) continue;/);
});

test('대기실 참가자 명단은 멈춘 전신 캐릭터 대신 벽걸이 액자를 그린다', async () => {
  const [waiting, css, html] = await Promise.all([
    source('../src/ui/waiting-room.ts'),
    source('../css/style.css'),
    source('../index.html'),
  ]);

  assert.match(waiting, /waitingRoomPortraits\(room\.players, roomStore\.me\(\)\)/);
  assert.match(waiting, /className = 'lounge__portrait'/);
  assert.match(waiting, /className = 'lounge__portrait-crop'/);
  assert.match(waiting, /className = 'lounge__identity'/);
  assert.match(waiting, /className = 'lounge__me'/);
  assert.match(waiting, /className = 'lounge__host'/);
  assert.match(waiting, /lounge__ready--on/);
  assert.doesNotMatch(waiting, /className = 'lounge__figure'/);

  assert.match(css, /\.lounge__portrait\s*\{/);
  assert.match(css, /\.lounge__portrait-crop\s*\{/);
  assert.match(css, /\.lounge__player--me\s+\.lounge__portrait/);
  assert.match(css, /\.lounge__ready--on\s*\{/);
  assert.match(html, /참가자 액자가 걸린 대기실/);
});

test('준비한 참가자의 액자는 본인 강조보다 우선해 초록 테두리가 된다', async () => {
  const css = await source('../css/style.css');
  const meRuleStart = css.indexOf('.lounge__player--me .lounge__portrait');
  const readyRule = css.match(
    /\.lounge__player--ready\s+\.lounge__portrait\s*\{([^}]*)\}/,
  );

  assert.notEqual(meRuleStart, -1, '본인 액자 강조 규칙이 있어야 한다');
  assert.ok(readyRule, '준비된 참가자의 액자 테두리 규칙이 있어야 한다');
  assert.match(readyRule[1], /border-color:\s*var\(--correct\)/);
  assert.ok(
    css.indexOf(readyRule[0]) > meRuleStart,
    '준비 테두리 규칙이 본인 테두리 규칙보다 뒤에 와서 같은 액자에서도 우선해야 한다',
  );
});
