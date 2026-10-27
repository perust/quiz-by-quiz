import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function player(id, nickname, { isReady = false, connected = true } = {}) {
  return { id, nickname, characterId: 'slime-blue', isReady, connected };
}

function room(players, changes = {}) {
  return {
    code: 'ABC234',
    name: '상태 줄 검증방',
    categoryId: null,
    capacity: 6,
    gameMode: true,
    players,
    isPublic: true,
    hasPassword: false,
    isMine: false,
    joined: true,
    createdAt: '2026-10-27T00:00:00.000Z',
    ...changes,
  };
}

const action = () => import('../js/ui/waiting-room-action.js');

test('U28: 방장의 시작 상태 줄은 꺼진 「게임 시작」의 이유와 기다리는 사람을 말한다', async () => {
  const { waitingRoomStartStatus } = await action();
  const host = player('host', '방장');

  assert.equal(
    waitingRoomStartStatus(room([host], { isMine: true }), 'host'),
    '최소 2명이 필요해요. 초대 링크로 친구를 불러 보세요.',
  );
  // 이 브라우저 안의 방은 링크로 들어올 길이 없어 초대를 권하지 않는다
  assert.equal(
    waitingRoomStartStatus(room([host], { isMine: true }), 'host', { canInvite: false }),
    '최소 2명이 필요해요.',
  );
  assert.equal(
    waitingRoomStartStatus(room([
      host,
      player('a', '민수', { isReady: true }),
      player('b', '지아'),
    ], { isMine: true }), 'host'),
    '준비 2/3명 · 지아 님 기다리는 중',
  );
  assert.equal(
    waitingRoomStartStatus(room([
      host,
      player('a', '민수'),
      player('b', '지아'),
      player('c', '하늘'),
    ], { isMine: true }), 'host'),
    '준비 1/4명 · 민수 님 외 2명 기다리는 중',
  );
  assert.equal(
    waitingRoomStartStatus(room([host, player('a', '민수', { isReady: true })], { isMine: true }), 'host'),
    '모두 준비됐어요. 게임을 시작해 보세요.',
  );
});

test('U24: 판에서 빠진 멤버에게는 «준비 완료를 눌러 주세요» 대신 다음 판을 말한다', async () => {
  const { waitingRoomStartStatus } = await action();
  const host = player('host', '방장');
  const me = player('me', '나');
  const playing = { status: 'playing', inMatch: false };

  // 거절될 「준비 완료」를 권하지 않는다. 판이 도는 동안에도 다음 판을 준비해 둘 수 있다.
  assert.equal(
    waitingRoomStartStatus(room([host, me], playing), 'me'),
    '지금 진행 중인 판이 끝나면 다음 판에 함께할 수 있어요. 준비는 미리 해 둘 수 있어요.',
  );
  assert.equal(
    waitingRoomStartStatus(room([host, player('me', '나', { isReady: true })], playing), 'me'),
    '준비 완료! 지금 진행 중인 판이 끝나면 다음 판에 함께해요.',
  );
  // 방장이 끊겨 판 밖의 내가 방장을 넘겨받았어도 지금은 시작할 수 없다.
  assert.equal(
    waitingRoomStartStatus(room([me, host], { ...playing, isMine: true }), 'me'),
    '지금 진행 중인 판이 끝나면 다음 판을 시작할 수 있어요.',
  );
  // 판에 내 자리가 있으면 복구 경로가 판 화면으로 데려간다.
  assert.equal(
    waitingRoomStartStatus(room([host, me], { status: 'playing', inMatch: true }), 'me'),
    '진행 중인 판에 내 자리가 있어요. 곧 판 화면으로 이어져요.',
  );
  // 판이 끝나 방이 다시 기다리면 원래 안내로 돌아온다.
  assert.equal(
    waitingRoomStartStatus(room([host, me], { status: 'waiting', inMatch: false }), 'me'),
    '준비 완료를 눌러 주세요. 방장이 시작하면 바로 출발해요.',
  );
});

test('U24: 오래 끊긴 사람은 기다리지 않고, 상태 줄이 빠진다는 사실을 알린다', async () => {
  const { waitingRoomStartStatus } = await action();
  const host = player('host', '방장');
  const ghost = player('ghost', '유령', { connected: false });

  assert.equal(
    waitingRoomStartStatus(room([host, ghost], { isMine: true }), 'host'),
    '유령 님 연결이 끊겼어요. 최소 2명이 필요해요.',
  );
  assert.equal(
    waitingRoomStartStatus(room([host, player('a', '민수', { isReady: true }), ghost], { isMine: true }), 'host'),
    '모두 준비됐어요 · 유령 님은 연결이 끊겨 이번 판에서 빠져요',
  );
});

test('참가자의 상태 줄은 방장이 시작한다는 것과 내 준비 여부를 말한다', async () => {
  const { waitingRoomStartStatus } = await action();
  const players = (meReady, hostConnected = true) => [
    player('host', '방장', { connected: hostConnected }),
    player('me', '퀴즈왕', { isReady: meReady }),
  ];

  assert.equal(
    waitingRoomStartStatus(room(players(false)), 'me'),
    '준비 완료를 눌러 주세요. 방장이 시작하면 바로 출발해요.',
  );
  assert.equal(
    waitingRoomStartStatus(room(players(true)), 'me'),
    '준비 완료! 방장이 시작하면 바로 출발해요.',
  );
  assert.equal(
    waitingRoomStartStatus(room(players(true, false)), 'me'),
    '방장 방장 님 연결이 끊겼어요. 곧 다음 사람이 방장이 돼요.',
  );
  assert.equal(waitingRoomStartStatus(room(players(true), { joined: false }), 'me'), '');
});

test('U37: 입장·퇴장·방장 승계만 한 줄씩 알리고 준비 토글은 로그에 남기지 않는다', async () => {
  const { waitingRoomChangeNotices } = await action();
  const host = player('host', '방장');
  const me = player('me', '퀴즈왕');
  const minsu = player('a', '민수');
  const jia = player('b', '지아');
  const before = room([host, me, minsu]);

  assert.deepEqual(
    waitingRoomChangeNotices(before, room([host, me, { ...minsu, isReady: true }]), 'me'),
    [],
    '준비 토글은 상태 줄이 맡는다',
  );
  assert.deepEqual(
    waitingRoomChangeNotices(before, room([host, me, minsu, jia]), 'me'),
    ['지아 님이 들어왔어요.'],
  );
  assert.deepEqual(
    waitingRoomChangeNotices(before, room([host, me, minsu, jia, player('c', '하늘'), player('d', '바다')]), 'me'),
    ['지아 님 외 2명이 들어왔어요.'],
    '한 snapshot의 같은 사건은 한 줄로 합친다',
  );
  assert.deepEqual(
    waitingRoomChangeNotices(before, room([me, minsu], { isMine: true }), 'me'),
    ['방장 님이 나갔어요.', '이제 내가 방장이에요. 설정을 바꾸고 게임을 시작할 수 있어요.'],
  );
  assert.deepEqual(
    waitingRoomChangeNotices(before, room([minsu, host, me]), 'me'),
    ['이제 민수 님이 방장이에요.'],
  );
  assert.deepEqual(
    waitingRoomChangeNotices(before, room([host, me, minsu], { code: 'XYZ789' }), 'me'),
    [],
    '다른 방 snapshot과는 견주지 않는다',
  );
});

test('U02: 방이 내 이름을 바꿔 보여 주면 그 이름을 알맞은 조사로 알린다', async () => {
  const { waitingRoomNicknameNotice } = await action();

  assert.equal(waitingRoomNicknameNotice('퀴즈왕', '퀴즈왕'), null);
  assert.equal(waitingRoomNicknameNotice('퀴즈왕1', '퀴즈왕'), '이 방에서는 퀴즈왕1로 보여요.');
  assert.equal(waitingRoomNicknameNotice('퀴즈왕3', '퀴즈왕'), '이 방에서는 퀴즈왕3으로 보여요.');
  assert.equal(waitingRoomNicknameNotice('하늘', '바다'), '이 방에서는 하늘로 보여요.');
  assert.equal(waitingRoomNicknameNotice('민준', '바다'), '이 방에서는 민준으로 보여요.');
  assert.equal(waitingRoomNicknameNotice('Kim2', 'Kim'), '이 방에서는 Kim2로 보여요.');
  assert.equal(waitingRoomNicknameNotice('Kim', 'Lee'), '이 방에서는 Kim(으)로 보여요.');
});

test('U27: 초대 링크는 지금 주소에 ?room=코드만 붙이고 비밀번호를 싣지 않는다', async () => {
  const { waitingRoomInviteLink } = await action();
  const link = waitingRoomInviteLink(
    { origin: 'https://perust.github.io', pathname: '/quiz-by-quiz/' },
    'ABC234',
  );

  assert.equal(link, 'https://perust.github.io/quiz-by-quiz/?room=ABC234');
  assert.equal(waitingRoomInviteLink.length, 2, '비밀번호를 넘길 자리가 없다');

  const [waiting, html] = await Promise.all([
    source('../src/ui/waiting-room.ts'),
    source('../index.html'),
  ]);
  assert.match(html, /<strong class="waiting-invite__value" id="waiting-code"><\/strong>/);
  assert.match(html, /id="waiting-invite">초대 링크 복사<\/button>/);
  assert.match(html, /id="waiting-invite-link" type="text" readonly hidden/);
  // 공유 시트 → 클립보드 → 직접 복사 순으로 내려가고, 결과는 대화 로그 안내로 알린다
  const share = waiting.indexOf('navigator.share({');
  const clipboard = waiting.indexOf('navigator.clipboard.writeText(link)');
  const select = waiting.indexOf('el.inviteLink.select()');
  assert.ok(share > 0 && share < clipboard && clipboard < select);
  assert.match(waiting, /const link = waitingRoomInviteLink\(window\.location, action\.code\);/);
  assert.match(waiting, /notice\(`초대 링크를 복사했어요/);
  assert.match(waiting, /el\.code\.textContent = room\.code;/);
  assert.match(waiting, /el\.invite\.hidden = !roomStore\.isNetworked;/);
  assert.doesNotMatch(waiting, /`방 코드 \$\{room\.code\}/, '코드는 lead 글 사이에 묻지 않는다');
});

test('드문 사건 안내와 이름 안내도 대화 로그의 CHAT_LINES 한도를 따른다', async () => {
  const waiting = await source('../src/ui/waiting-room.ts');
  const notice = waiting.slice(waiting.indexOf('function notice('), waiting.indexOf('// ── 설정 바꾸기'));
  assert.match(notice, /while \(el\.chatLog\.children\.length > CHAT_LINES\)/);
  assert.match(waiting, /for \(const line of waitingRoomChangeNotices\(previous, next, roomStore\.me\(\)\)\) notice\(line\);/);
  assert.match(waiting, /waitingRoomNicknameNotice\(me\.nickname, getPlayer\(\)\.nickname\)/);
});
