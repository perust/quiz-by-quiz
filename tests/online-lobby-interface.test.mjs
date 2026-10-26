import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, loadStyles, node, resolveVars, tokens, valueOf } from './css-cascade.mjs';

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

test('온라인 주요 동작은 선택한 본문만 보여 주고 기존 방 필터를 임의로 바꾸지 않는다', async () => {
  const online = await source('../src/ui/online.ts');
  const showPanel = between(online, 'function showPanel', '// ── 목록');
  const browseHandler = between(
    online,
    "el.openPublic.addEventListener('click'",
    "el.openPrivate.addEventListener('click'",
  );
  const joinHandler = between(
    online,
    "el.openPrivate.addEventListener('click'",
    "el.openCreate.addEventListener('click'",
  );

  assert.match(showPanel, /roomBrowser\.hidden = panel !== 'rooms'/);
  assert.doesNotMatch(browseHandler, /visibility\.value|availability\.value/);
  assert.doesNotMatch(joinHandler, /visibility\.value|renderList\(\)/);
  assert.match(joinHandler, /scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\)/);
});

test('빈 방 목록은 방 만들기·혼자 연습하기 또는 필터 초기화로 바로 이어진다', async () => {
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
  // 혼자 온 사람에게 2명부터라는 것을 먼저 말하고, 혼자서도 갈 길을 둔다 (U29)
  assert.match(online, /'친구를 불러야 시작할 수 있어요 \(2명부터\)'/);
  assert.match(online, /'방 만들고 친구 부르기'/);
  assert.match(lobby, /id="room-empty-secondary"[^>]*hidden>혼자 연습하기</);
  assert.match(online, /el\.emptySecondary\.addEventListener\('click', leaveForPractice\)/);
  assert.match(online, /'필터 초기화'/);
  assert.match(
    online,
    /el\.emptyAction\.addEventListener\('click',[\s\S]*?showPanel\('create'/,
  );
});

test('온라인 워커는 좁은 화면의 안내문을 가리지 않는 머리말 오른쪽에서 시작한다', async () => {
  const online = await source('../src/ui/online.ts');
  const walker = await source('../src/ui/screen-walker.ts');

  assert.match(online, /startPoint: \(\) => pointBelowRightEdge\(el\.header, el\.character\)/);
  assert.match(walker, /x: box\.right - character\.offsetWidth \/ 2 - 12/);
  assert.match(walker, /y: box\.bottom \+ character\.offsetHeight \+ 6/);
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

// ── 동작 바의 대비 (U47) ─────────────────────────────────────────
// 반투명 HUD 바는 가장 밝은 그림(흰 구름) 위에 얹힌 경우가 가장 옅다. 그 위에 칸·아이콘 칸 바탕을
// 차례로 겹친 «실제 바탕»과 글자·아이콘 색을 견준다 — 토큰 짝만 보면 30절이 바꾼 글자색과
// 19절에 남은 옅은 바탕이 만나는 자리를 놓친다.
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

function rgba(value) {
  if (value === 'transparent') return [0, 0, 0, 0];
  const hexMatch = value.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) return [...hexMatch[1].match(/../g).map((part) => Number.parseInt(part, 16)), 1];
  const rgbMatch = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/);
  assert.ok(rgbMatch, `알 수 없는 색: ${value}`);
  return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]), rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4])];
}

function over(top, bottom) {
  const [r, g, b, a] = top;
  return [0, 1, 2].map((i) => [r, g, b][i] * a + bottom[i] * (1 - a)).concat(1);
}

function luminance([r, g, b]) {
  const linear = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** 아래(바)에서 위(아이콘 칸)로 겹친 실제 바탕. 맨 아래는 가장 밝은 그림이다 */
function backdrop(layers, env) {
  const map = tokens(rules, env);
  return layers.reduce((base, element) => {
    const value = valueOf(rules, element, 'background', env);
    if (value === null) return base;
    return over(rgba(resolveVars(value, map)), base);
  }, [255, 255, 255, 1]);
}

function colorOf(element, env) {
  return rgba(resolveVars(valueOf(rules, element, 'color', env), tokens(rules, env)));
}

test('온라인 동작 바: 쉬는·hover·고른·올라선 칸 모두 아이콘(3:1)과 이름·설명(4.5:1)이 어두운 바 위에서 읽힌다', () => {
  const lobby = node("section.screen[data-screen='online']", node('main.app', node('body')));
  const bar = node('nav.online-actions', lobby);
  const states = [
    ['쉬는 칸', "button.online-action-card#open-private-join[aria-pressed='false']", [DESKTOP, MOBILE, NARROW]],
    ['hover 칸', "button.online-action-card#open-private-join[aria-pressed='false']:hover", [DESKTOP]],
    ['고른 칸', "button.online-action-card#open-public-rooms[aria-pressed='true']", [DESKTOP, MOBILE, NARROW]],
    ['고른 칸 hover', "button.online-action-card#open-public-rooms[aria-pressed='true']:hover", [DESKTOP]],
    ['올라선 칸', "button.online-action-card#open-create-room[aria-pressed='false'].is-standing", [DESKTOP, MOBILE]],
  ];
  assert.equal(valueOf(rules, bar, 'background', DESKTOP), 'var(--hud-bg)', '동작 바는 어두운 HUD다');
  for (const [label, descriptor, envs] of states) {
    for (const env of envs) {
      const card = node(descriptor, bar);
      const icon = node('span.online-action-card__icon', card);
      const glyph = node('span.online-action-card__icon::before', card);
      const body = node('span.online-action-card__body', card);
      const name = node('strong', body);
      const copy = node('span.online-action-card__copy', body);

      // 아이콘은 currentColor 로 그린다 — 아이콘 칸의 글자색이 곧 아이콘 색이다
      assert.equal(valueOf(rules, glyph, 'background-color', env), 'currentColor');
      const iconRatio = contrast(colorOf(icon, env), backdrop([bar, card, icon], env));
      assert.ok(iconRatio >= 3, `${label} ${env.width}px: 아이콘 ${iconRatio.toFixed(2)}:1`);
      for (const [part, element] of [['이름', name], ['설명', copy]]) {
        const ratio = contrast(colorOf(element, env), backdrop([bar, card], env));
        assert.ok(ratio >= 4.5, `${label} ${env.width}px: ${part} ${ratio.toFixed(2)}:1`);
      }
    }
  }

  // 네 상태는 서로 다르게 보인다 — hover 는 고른 칸처럼 채우지 않는다
  const look = (descriptor) => {
    const card = node(descriptor, bar);
    const icon = node('span.online-action-card__icon', card);
    return ['background', 'border-color'].map((property) => valueOf(rules, card, property, DESKTOP))
      .concat(valueOf(rules, icon, 'background', DESKTOP)).join(' | ');
  };
  const looks = states.slice(0, 3).map(([, descriptor]) => look(descriptor));
  assert.equal(new Set(looks).size, 3, `쉬는·hover·고른 칸: ${looks.join(' / ')}`);
  assert.equal(valueOf(rules, node(states[1][1], bar), 'background', DESKTOP), 'transparent', 'hover 는 채우지 않는다');
  assert.equal(valueOf(rules, node(states[2][1], bar), 'border-color', DESKTOP), 'var(--gold-soft)', '고른 칸은 금빛 선');
  assert.equal(valueOf(rules, node('span.online-action-card__icon', node(states[2][1], bar)), 'background', DESKTOP), 'var(--accent)', '고른 칸은 아이콘 칸도 채운다');
  assert.equal(valueOf(rules, node(states[4][1], bar), 'outline-color', DESKTOP), 'var(--focus-on-hud)', '올라선 칸은 HUD 고리');
});
