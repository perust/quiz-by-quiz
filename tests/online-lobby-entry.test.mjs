// 온라인 입구 회귀 — 초대 링크 받기(U27), 혼자 온 사람(U29), 게임 중인 방(U33),
// 로딩·오류 상태(U34), «비밀번호 잠금» 용어(U36), 방 만들기 폼(U41), 나가기 거절(U32),
// 홈의 복귀 줄(U35).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadStyles, nodeFromHtml, valueOf, DESKTOP, MOBILE, NARROW } from './css-cascade.mjs';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

function json(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

const identity = {
  id: '12345678-1234-5678-9234-567812345678',
  secret: 'browser-session-secret-with-thirty-two-chars',
};

function serverRoom(changes = {}) {
  return {
    code: 'ABC234',
    name: '온라인 퀴즈',
    categoryId: 'history',
    capacity: 12,
    gameMode: true,
    players: [{ id: identity.id, nickname: '퀴즈왕', characterId: 'slime-blue', isReady: false }],
    isPublic: true,
    hasPassword: false,
    isMine: false,
    joined: false,
    createdAt: '2026-09-17T00:00:00+00:00',
    status: 'waiting',
    ...changes,
  };
}

async function networkStore(route) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  return createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
      return route(url, init);
    },
    newIdentity: () => identity,
    webSocketFactory: () => { throw new Error('socket is not used here'); },
  });
}

function listRoom({ code, joined = false, status = 'waiting', capacity = 4, playerCount = 1, isPublic = true, createdAt = '2026-09-17T00:00:00.000Z' }) {
  return {
    code,
    name: code,
    categoryId: 'history',
    capacity,
    gameMode: true,
    players: Array.from({ length: playerCount }, (_, index) => ({ id: `${code}-${index}`, nickname: `참가자${index}` })),
    isPublic,
    hasPassword: !isPublic,
    isMine: false,
    joined,
    createdAt,
    status,
  };
}

// ── 규칙 (U27) ───────────────────────────────────────────────────

test('방 코드는 붙여 넣은 초대 링크에서 room 값만 뽑고, 소문자와 공백도 받아 준다', async () => {
  const { normalizeCode, isValidCode } = await import('../js/online/rules.js');

  assert.equal(normalizeCode('https://perust.github.io/quiz-by-quiz/?room=abc234'), 'ABC234');
  assert.equal(normalizeCode('https://example.test/?lang=ko&room=XY7Z23#top'), 'XY7Z23');
  assert.equal(normalizeCode('  ab c2 34 '), 'ABC234');
  assert.equal(isValidCode('친구가 보낸 링크 https://example.test/?room=ABC234'), true);
});

test('코드 칸에 한글이 섞이면 지우고 넘어가지 않고 영문 자판으로 바꾸라고 알린다', async () => {
  const { CODE_MESSAGES, checkCodeInput, hasHangul } = await import('../js/online/rules.js');

  assert.equal(hasHangul('ㅁㅠㅊ234'), true);
  assert.equal(hasHangul('뮻'), true);
  assert.equal(hasHangul('ABC234'), false);
  assert.deepEqual(checkCodeInput('ㅁㅠㅊ234'), { ok: false, message: CODE_MESSAGES.hangul });
  assert.match(CODE_MESSAGES.hangul, /영문 자판으로 바꿔 주세요/);
  assert.deepEqual(checkCodeInput('ABC2'), { ok: false, message: '방 코드는 여섯 글자예요.' });
  assert.deepEqual(checkCodeInput('abc 234'), { ok: true, value: 'ABC234' });
});

test('참가·나가기 거절 이유는 연결 문제와 다른 말로 옮긴다', async () => {
  const { JOIN_MESSAGES, LEAVE_MESSAGES, LeaveRoomRejected } = await import('../js/online/rules.js');

  assert.equal(JOIN_MESSAGES['game-in-progress'], '지금 게임 중이에요. 끝나면 들어갈 수 있어요.');
  assert.equal(JOIN_MESSAGES['rate-limited'], '요청이 많아요. 잠시 후 다시 시도해 주세요.');
  assert.equal(LEAVE_MESSAGES['game-in-progress'], '게임이 끝나면 나갈 수 있어요.');
  for (const message of [JOIN_MESSAGES['game-in-progress'], JOIN_MESSAGES['rate-limited'], LEAVE_MESSAGES['game-in-progress']]) {
    assert.doesNotMatch(message, /네트워크|연결/);
  }
  const rejected = new LeaveRoomRejected('game-in-progress');
  assert.ok(rejected instanceof Error);
  assert.equal(rejected.reason, 'game-in-progress');
});

// ── 목록 정책 (U33·U35) ──────────────────────────────────────────

test('목록은 내가 있는 방을 맨 위에, 그다음 기다리는 방, 게임 중인 방 순으로 둔다', async () => {
  const { DEFAULT_ROOM_FILTERS, filterAndSortRooms } = await import('../js/online/room-list.js');
  const rooms = [
    listRoom({ code: 'PLAYNG', status: 'playing', createdAt: '2026-09-17T12:00:00.000Z' }),
    listRoom({ code: 'FULLUP', capacity: 2, playerCount: 2, createdAt: '2026-09-17T11:00:00.000Z' }),
    listRoom({ code: 'WAITNG', createdAt: '2026-09-17T09:00:00.000Z' }),
    listRoom({ code: 'MYROOM', joined: true, status: 'playing', createdAt: '2026-09-17T08:00:00.000Z' }),
  ];

  assert.deepEqual(
    filterAndSortRooms(rooms, DEFAULT_ROOM_FILTERS).map(({ code }) => code),
    ['MYROOM', 'WAITNG', 'FULLUP', 'PLAYNG'],
  );
});

test('게임 중인 방은 새로 참가할 수 없고, 이미 들어간 사람은 다시 들어갈 수 있다', async () => {
  const { DEFAULT_ROOM_FILTERS, filterAndSortRooms, roomListAction } = await import('../js/online/room-list.js');

  assert.equal(roomListAction(listRoom({ code: 'PLAYNG', status: 'playing' })), 'playing');
  assert.equal(roomListAction(listRoom({ code: 'LOCKED', status: 'playing', isPublic: false })), 'playing');
  assert.equal(roomListAction(listRoom({ code: 'MINE23', status: 'playing', joined: true })), 'enter');

  const rooms = [
    listRoom({ code: 'PLAYNG', status: 'playing' }),
    listRoom({ code: 'WAITNG' }),
    listRoom({ code: 'FULLUP', capacity: 2, playerCount: 2 }),
  ];
  assert.deepEqual(
    filterAndSortRooms(rooms, { ...DEFAULT_ROOM_FILTERS, availability: 'joinable' }).map(({ code }) => code),
    ['WAITNG'],
    '«참가 가능»에는 게임 중인 방이 없다',
  );
  assert.deepEqual(
    filterAndSortRooms(rooms, { ...DEFAULT_ROOM_FILTERS, availability: 'full' }).map(({ code }) => code),
    ['FULLUP'],
    '«가득 참»은 정원만 본다',
  );
});

// ── 저장소 (U32·U33) ─────────────────────────────────────────────

test('네트워크 방 상태를 받아 오고, 상태를 모르는 이전 API는 기다리는 방으로 본다', async () => {
  let rooms = [serverRoom({ status: 'playing' }), serverRoom({ code: 'OLD234', status: undefined })];
  const store = await networkStore((url) => {
    if (url.endsWith('/v1/rooms')) return json(rooms);
    throw new Error(`unexpected request: ${url}`);
  });

  assert.deepEqual((await store.listRooms()).map(({ status }) => status), ['playing', 'waiting']);

  rooms = [serverRoom({ status: 'paused' })];
  await assert.rejects(() => store.listRooms(), /진행 상태/);
});

test('게임 중·요청 과다로 거절된 참가는 연결 실패로 던지지 않고 이유를 돌려준다', async () => {
  let failure = { code: 'game-in-progress', message: '진행 중인 게임에는 새로 참가할 수 없습니다.', status: 409 };
  const store = await networkStore((url) => {
    if (url.endsWith('/join')) return json({ detail: { code: failure.code, message: failure.message } }, failure.status);
    throw new Error(`unexpected request: ${url}`);
  });
  const player = { nickname: '퀴즈왕', characterId: 'slime-blue' };

  assert.deepEqual(await store.joinRoom({ code: 'ABC234', player }), { ok: false, reason: 'game-in-progress' });
  failure = { code: 'rate-limited', message: '참가 시도가 너무 많습니다.', status: 429 };
  assert.deepEqual(await store.joinRoom({ code: 'ABC234', player }), { ok: false, reason: 'rate-limited' });
});

test('판이 도는 방의 나가기 거절(409)은 이유가 실린 오류로 던지고, 이미 없는 방은 그대로 성공이다', async () => {
  const { LeaveRoomRejected } = await import('../js/online/rules.js');
  let status = 409;
  const store = await networkStore((url, init) => {
    if (url.endsWith('/members/me') && init.method === 'DELETE') {
      if (status === 409) {
        return json({ detail: { code: 'game-in-progress', message: '진행 중인 게임에서는 방을 나갈 수 없습니다.' } }, 409);
      }
      return json({ detail: { code: 'not-found', message: '그런 코드의 방이 없습니다.' } }, 404);
    }
    throw new Error(`unexpected request: ${url}`);
  });

  await assert.rejects(
    () => store.leaveRoom({ code: 'ABC234' }),
    (error) => error instanceof LeaveRoomRejected && error.reason === 'game-in-progress',
  );
  status = 404;
  assert.deepEqual(await store.leaveRoom({ code: 'ABC234' }), { ok: true });
});

test('로컬 방에는 서버 권위 판이 없어 언제나 기다리는 방이다', async () => {
  globalThis.window = { localStorage: memoryStorage() };
  const { localRooms } = await import('../js/online/local-rooms.js?status-contract');
  const created = await localRooms.createRoom({
    name: '혼자 연습',
    categoryId: null,
    capacity: 2,
    isPublic: true,
    player: { nickname: '퀴즈왕', characterId: 'slime-blue' },
  });

  assert.equal(created.ok, true);
  assert.equal(created.room.status, 'waiting');
  assert.deepEqual((await localRooms.listRooms()).map(({ status }) => status), ['waiting']);
});

// ── 화면 계약 ────────────────────────────────────────────────────

test('코드 칸은 여섯 글자에 맞추고 자동 고침을 끄며, 붙여 넣은 링크와 한글을 다룬다 (U27)', async () => {
  const [html, online] = await Promise.all([source('../index.html'), source('../src/ui/online.ts')]);
  const codeInput = between(html, 'id="join-code"', '>');

  assert.match(codeInput, /maxlength="6"/);
  assert.match(codeInput, /autocapitalize="characters"/);
  assert.match(codeInput, /autocorrect="off"/);
  assert.match(codeInput, /spellcheck="false"/);
  assert.match(online, /const checked = checkCodeInput\(el\.joinCode\.value\);/);
  assert.match(online, /el\.joinCode\.addEventListener\('input',[\s\S]*?hasHangul\(el\.joinCode\.value\)[\s\S]*?CODE_MESSAGES\.hangul/);
  assert.match(online, /el\.joinCode\.addEventListener\('paste',[\s\S]*?normalizeCode\(text\)[\s\S]*?event\.preventDefault\(\)/);
});

test('초대 링크는 부팅 때 한 번 읽어 주소에서 지우고, 로비를 그린 뒤 코드 참가로 넘긴다 (U27)', async () => {
  const [app, online] = await Promise.all([source('../src/app.ts'), source('../src/ui/online.ts')]);
  const take = between(app, 'function takeInviteCode(): string | null', 'async function main(): Promise<void>');
  const openOnline = between(app, '  async function openOnline(', '  async function openWaitingRoom');
  const accept = between(online, '    acceptInvite(rawCode) {', '    hide() {');

  assert.match(take, /url\.searchParams\.get\('room'\)/);
  assert.match(take, /url\.searchParams\.delete\('room'\);[\s\S]*?history\.replaceState\(/);
  assert.doesNotMatch(app, /location\.hash|hashchange/);
  assert.match(app, /async function main\(\): Promise<void> \{\s*markBooted\(\);\s*const inviteCode = takeInviteCode\(\);/);
  // 초대로 왔으면 홈을 그리기만 하고 «아직 방에 있어요»는 묻지 않는다 — 곧 로비가 목록을 읽는다 (server-5)
  assert.match(
    app,
    /if \(inviteCode\) \{[\s\S]*?await showHome\(\);\s*await openOnline\(undefined, inviteCode\);\s*\} else \{\s*await goHome\(\);\s*\}/,
  );
  // «내용을 그린 뒤 goTo». 포커스를 옮기는 초대 처리는 화면이 보인 뒤에 한다
  assert.match(openOnline, /await onlineScreen\.show\(characterId, notice\);[\s\S]*?goTo\('online'\);\s*[\s\S]*?if \(invite\) onlineScreen\.acceptInvite\(invite\);/);
  assert.match(accept, /if \(room\?\.joined\) \{\s*enterRoom\(code\);/);
  assert.match(accept, /if \(room && !room\.isPublic\) \{\s*preparePrivateJoin\(room\);/);
  assert.match(accept, /void joinByCode\(code, ''\);/);
  assert.match(online, /result\.reason === 'need-password' \|\| result\.reason === 'wrong-password'[\s\S]*?el\.joinPassword\.focus/);
});

test('홈의 온라인 입구는 2명부터라는 보조 줄을 보이고, 로비를 불러오는 동안 바쁨을 알린다 (U29·U34)', async () => {
  const [html, home, app] = await Promise.all([
    source('../index.html'),
    source('../src/ui/home.ts'),
    source('../src/app.ts'),
  ]);
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const openOnline = between(app, '  async function openOnline(', '  async function openWaitingRoom');

  assert.match(html, /id="open-online"\s+aria-label="온라인, 친구와 함께 2명부터"/);
  assert.match(html, /<span class="challenge-card__desc" id="open-online-desc">친구와 함께 · 2명부터<\/span>/);
  for (const env of [DESKTOP, MOBILE, NARROW]) {
    assert.equal(valueOf(rules, nodeFromHtml(html, 'open-online-desc'), 'display', env), 'block', '온라인 보조 줄은 보인다');
  }

  assert.match(home, /el\.openOnline\.addEventListener\('click', \(\) => \{\s*if \(onlineBusy\) return;\s*onOpenOnline\(\);/);
  assert.match(home, /setOnlineBusy\(busy\) \{[\s\S]*?'연결 중…'[\s\S]*?setAttribute\('aria-busy', 'true'\)[\s\S]*?removeAttribute\('aria-busy'\)/);
  assert.match(
    openOnline,
    /homeScreen\.setOnlineBusy\(true\);\s*try \{\s*await onlineScreen\.show\(characterId, notice\);\s*\} finally \{\s*homeScreen\.setOnlineBusy\(false\);\s*\}/,
  );
});

test('로비 목록이 실패하면 «다시 시도»만 보이고 방 만들기를 권하지 않는다 (U34)', async () => {
  const online = await source('../src/ui/online.ts');
  const render = between(online, '  function renderList(): void {', '  /**\n   * 목록을 다시 읽는다.');
  const load = between(online, '  async function loadRooms(request: number)', '  // ── 참가');
  const errorBranch = between(render, 'if (listError !== null) {', 'const visible =');

  // «서버» 같은 개발 용어 대신 플레이어의 말로 말한다 (U40)
  assert.match(errorBranch, /title: '온라인에 연결할 수 없어요'/);
  assert.match(errorBranch, /copy: listError,/);
  assert.doesNotMatch(errorBranch, /서버/);
  assert.match(errorBranch, /action: 'retry',\s*label: '다시 시도',\s*practice: false/);
  assert.doesNotMatch(errorBranch, /'create'|방 만들/);
  assert.match(load, /listError = null;\s*renderList\(\);/);
  assert.match(load, /rooms = \[\];\s*listError = [^;]+;\s*renderList\(\);/);
  // 실패 사연은 onlineErrorText가 고른다. 어댑터의 개발 상세(error.message)를 괄호에 넣지 않는다
  assert.match(load, /listError = onlineErrorText\(error, '잠시 후 다시 시도해 주세요\.'\);/);
  assert.doesNotMatch(load, /error\.message/);
  assert.doesNotMatch(load, /say\(el\.message/, '목록 실패를 맨 위 알림과 빈 상태에 두 번 띄우지 않는다');
  assert.match(online, /if \(action === 'retry'\) \{\s*if \(visibleRequest !== null\) void loadRooms\(visibleRequest\);/);
  // 주기적으로 다시 읽지 않는다 (N01)
  assert.doesNotMatch(online, /setInterval|setTimeout\(\s*\(\)\s*=>\s*(?:void )?loadRooms/);
});

test('참가·만들기 제출은 요청 동안 잠기고 aria-busy를 단다 (U34)', async () => {
  const [html, online] = await Promise.all([source('../index.html'), source('../src/ui/online.ts')]);
  const setBusy = between(online, '  function setBusy(', '  // ── 안내');

  assert.match(html, /<button type="submit" class="button button--primary room-form__submit" id="join-submit">/);
  assert.match(html, /<button type="submit" class="button button--primary room-form__submit" id="create-submit">/);
  assert.match(setBusy, /button\.disabled = true;\s*button\.setAttribute\('aria-busy', 'true'\);/);
  assert.match(setBusy, /button\.disabled = false;\s*button\.removeAttribute\('aria-busy'\);/);
  assert.match(online, /setBusy\(trigger, true, trigger === el\.joinSubmit \? '참가하는 중…' : undefined\);/);
  assert.match(online, /\} finally \{\s*setBusy\(trigger, false\);/);
  assert.match(online, /setBusy\(el\.createSubmit, true, '만드는 중…'\);/);
  assert.match(online, /\} finally \{\s*setBusy\(el\.createSubmit, false\);/);
});

test('잠금 방은 목록에 남기고 «비공개» 대신 «비밀번호 잠금·잠김»이라 부른다 (U36)', async () => {
  const [html, online] = await Promise.all([source('../index.html'), source('../src/ui/online.ts')]);
  const lobby = between(html, 'data-screen="online"', 'data-screen="waiting"');
  const visibleText = lobby.replace(/<!--[\s\S]*?-->/g, '');

  assert.doesNotMatch(visibleText, /비공개/);
  assert.match(lobby, /<option value="private">잠긴 방<\/option>/);
  assert.match(lobby, /<label for="create-private">비밀번호로 잠그기 \(목록에 보이지만 비밀번호를 아는 사람만 들어와요\)<\/label>/);
  assert.match(online, /visibility\.textContent = room\.isPublic \? '공개' : '잠김';/);
  assert.doesNotMatch(online, /'비공개'/);
});

test('게임 중인 방은 배지와 막힌 참가 버튼으로 미리 알린다 (U33)', async () => {
  const [online, theme] = await Promise.all([source('../src/ui/online.ts'), source('../css/voxel-theme.css')]);
  const item = between(online, '  function createItem(room: PublicRoom)', '  function validVisibility');

  assert.match(item, /status\.className = 'room-item__status';\s*status\.textContent = '게임 중';/);
  assert.match(item, /action === 'playing' \? '끝나면 참가' : '가득 참'/);
  assert.match(item, /blocked\.disabled = true;/);
  // 색만으로 알리지 않는다 — 모래시계 모양을 함께 단다
  assert.match(theme, /\.room-item__status::before \{[\s\S]*?var\(--i-hourglass\)/);
});

test('방 만들기는 «{닉네임}의 방»으로 채워 두고, 인원은 «최대 인원»과 2명부터라는 도움말로 말한다 (U41)', async () => {
  const [html, online] = await Promise.all([source('../index.html'), source('../src/ui/online.ts')]);
  const create = between(html, 'id="create-form"', '</form>');

  assert.match(create, /<label class="room-form__label" for="create-capacity">최대 인원<\/label>/);
  assert.match(create, /id="create-capacity"\s+aria-describedby="create-capacity-help"/);
  assert.match(create, /<p class="room-form__help" id="create-capacity-help">2명부터 시작할 수 있어요<\/p>/);
  assert.doesNotMatch(create, /placeholder="같이 풀어요"/);
  assert.match(online, /suggestedRoomName = `\$\{getPlayer\(\)\.nickname\}의 방`\.slice\(0, ROOM_NAME_MAX_LENGTH\);/);
  assert.match(online, /if \(current\.trim\(\) !== '' && current !== suggestedRoomName\) return;/);
  assert.match(online, /const name = checkRoomName\(el\.createName\.value\);/);
});

test('인원 도움말은 입력칸과 같은 선에서 시작한다 — 라벨이 위로 올라가는 좁은 화면에서는 들이지 않는다 (U41)', async () => {
  const html = await source('../index.html');
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const { lengthOf } = await import('./css-cascade.mjs');
  const help = nodeFromHtml(html, 'create-capacity-help');
  // 라벨에는 id 가 없다. 같은 줄(.room-form__row)에 있는 인원 칸의 조상 사슬을 빌려 라벨을 만든다
  const select = nodeFromHtml(html, 'create-capacity');
  const labelNode = { ...select, tag: 'label', id: null, classes: ['room-form__label'], attrs: { for: 'create-capacity' } };
  const indent = (env) => lengthOf(rules, valueOf(rules, help, 'padding-left', env), env);
  const labelWidth = (env) => valueOf(rules, labelNode, 'width', env);

  // 라벨이 옆에 서는 폭: 라벨 칸(72px)과 줄 간격(12px)만큼 들여 입력칸 왼쪽 끝과 맞춘다
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(labelWidth(env), '72px');
    assert.equal(indent(env), 84);
  }
  // 380px 이하는 라벨이 위로 올라가 입력칸이 줄 왼쪽 끝에서 시작한다. 84px 밀면 떠도는 글처럼 보였다
  assert.equal(labelWidth(NARROW), 'auto');
  assert.equal(indent(NARROW), 0);
});

test('홈으로 와도 들어가 있는 방이 있으면 dock 맨 위에 복귀 줄을 띄운다 — 주기적으로 묻지 않는다 (U35)', async () => {
  const [html, home, app] = await Promise.all([
    source('../index.html'),
    source('../src/ui/home.ts'),
    source('../src/app.ts'),
  ]);
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const dock = between(html, 'class="home-quests"', 'id="category-grid"');
  const goHome = between(app, '  async function goHome(): Promise<void>', '  /** 홈을 그려 연다.');
  const showHome = between(app, '  async function showHome(): Promise<boolean>', '  /** 빈 로비');
  const openOnline = between(app, '  async function openOnline(', '  async function openWaitingRoom');
  const openWaitingRoom = between(app, '  async function openWaitingRoom(code: string)', '  // ── 내 캐릭터');
  const onLeave = between(app, '    onLeave: (code, entryGeneration, reason) => {', '    onStart:');

  assert.match(dock, /<button type="button" class="home-room-note" id="home-room-note" hidden>/);
  assert.equal(valueOf(rules, nodeFromHtml(html, 'home-room-note'), 'display', MOBILE), 'none');
  // 홈을 연 **뒤에** 묻는다. 세대는 refresh가 스스로 쥔다 — 한때 goTo 전의 세대를 넘겨 답이 늘
  // «지난 화면»으로 버려졌고 줄은 한 번도 뜨지 않았다 (online-client-1, tests/home-room-note.test.mjs)
  assert.match(goHome, /if \(!\(await showHome\(\)\)\) return;[\s\S]*?void homeRoomNote\.refresh\(\);/);
  assert.doesNotMatch(goHome + showHome, /refresh\(navigationGeneration\)/);
  assert.match(showHome, /goTo\('home'\);\s*return true;/);
  assert.match(app, /navigation: \(\) => waitingRoomEntryGeneration,/);
  // 언제 다시 묻는지: 로비를 다녀오거나 방에 들어간 뒤. 나왔거나 사라진 방은 줄과 흔적을 거둔다
  assert.match(openOnline, /homeRoomNote\.visitOnline\(\);/);
  assert.match(openWaitingRoom, /homeRoomNote\.enter\(code\);/);
  assert.match(onLeave, /homeRoomNote\.leave\(code\);/);
  // 부팅 흔적은 preferences 로만 읽고 쓴다 (localStorage 는 safe-storage.ts 한 곳)
  assert.match(app, /const lastRoomCode = await preferences\.getLastRoomCode\(\);/);
  assert.match(app, /saveLastRoomCode: \(code\) => \{ void preferences\.setLastRoomCode\(code\); \},/);
  assert.doesNotMatch(app, /setInterval/);
  assert.match(home, /el\.roomNoteText\.textContent = room \? `「\$\{room\.name\}」 방에 아직 있어요` : '';/);
  assert.match(app, /onReturnToRoom: \(code\) => \{ void openWaitingRoom\(code\); \}/);
});

test('빈 로비의 «혼자 연습하기»는 홈으로 가서 분야 dock에 선다 (U29)', async () => {
  const [online, home, app] = await Promise.all([
    source('../src/ui/online.ts'),
    source('../src/ui/home.ts'),
    source('../src/app.ts'),
  ]);

  assert.match(online, /function leaveForPractice\(\): void \{[\s\S]*?invalidateScreenOwnership\(\);[\s\S]*?onPractice\(\);/);
  assert.match(app, /async function practiceAlone\(\): Promise<void> \{\s*await goHome\(\);\s*homeScreen\.focusPractice\(\);/);
  assert.match(home, /focusPractice\(\) \{[\s\S]*?\.category-card:not\(:disabled\)/);
});
