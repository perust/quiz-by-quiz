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

test('상태판 «연결 끊김»은 데스크톱에서도 320px에서도 80px 액자 칸 안에 한 줄로 든다', async () => {
  const { loadStyles, valueOf, lengthOf, shorthandParts, node, DESKTOP, NARROW } = await import('./css-cascade.mjs');
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const pill = node('span.lounge__ready.lounge__ready--offline');
  const icon = node('span.lounge__ready.lounge__ready--offline::before');

  for (const env of [DESKTOP, NARROW]) {
    // 글자 안에서 줄을 바꾸지 않는다 — 한때 «연결 끊 / 김»으로 갈라졌다
    assert.equal(valueOf(rules, pill, 'white-space', env), 'nowrap');
    assert.equal(valueOf(rules, pill, 'word-break', env), 'keep-all');

    const px = (value) => lengthOf(rules, value, env);
    const column = px(valueOf(rules, node('li.lounge__player'), 'width', env));
    const border = px(shorthandParts(valueOf(rules, pill, 'border', env))[0]);
    const padding = shorthandParts(valueOf(rules, pill, 'padding', env));
    const paddingInline = px(padding[1] ?? padding[0]);
    const mark = px(valueOf(rules, icon, 'width', env));
    const gap = px(valueOf(rules, pill, 'gap', env));
    const fontSize = px(valueOf(rules, pill, 'font-size', env));
    // 가장 넓은 한글 시스템 글꼴인 맑은 고딕은 한글 한 자가 1em, 띄어쓰기가 0.352em 이다
    // (malgunbd.ttf 의 advance width). 네 자 + 한 칸
    const label = fontSize * (4 + 0.352);
    const width = border * 2 + paddingInline * 2 + mark + gap + label;

    assert.equal(column, 80);
    assert.ok(Number.isFinite(width), '토큰을 모두 풀어 길이로 계산할 수 있어야 한다');
    assert.ok(width <= column, `상태판 ${width.toFixed(1)}px 이 ${column}px 칸을 넘는다 (${env.width}px 화면)`);
  }
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
