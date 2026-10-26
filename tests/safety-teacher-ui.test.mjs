import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lengthOf, loadStyles, MOBILE, NARROW, node, valueOf } from './css-cascade.mjs';

// 대기실 액자의 «말 숨기기»(N06)·«내보내기»(U24)와 랭킹의 «기록 내보내기»(N02)의 화면 계약.
// - 손가락 목표 44px, 상태는 색만이 아니라 채움·모양(아이콘)으로, 아이콘은 묶음에서
// - 내보내기 확인은 인페이지 대화상자(window.confirm 금지), 세계 위 작은 글자는 유리 표면
// - 순수 규칙: 누구 액자에 무엇이 붙는지, 내보낸 사람의 퇴장을 두 줄로 쓰지 않는지

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const waiting = node("section.screen[data-screen='waiting']", node('main.app', node('body')));
const portrait = node('li.lounge__player', node('ul.lounge__players#lounge-players', node('div.lounge#lounge', waiting)));
const mute = (pressed) => node(`button.lounge__mute[aria-pressed='${pressed}']`, portrait);

test('액자의 말 숨기기·내보내기는 휴대폰 폭에서도 44px 목표다', () => {
  for (const env of [MOBILE, NARROW]) {
    for (const property of ['width', 'height']) {
      const size = lengthOf(rules, valueOf(rules, mute(false), property, env), env);
      assert.ok(size >= 44, `${env.width}px 말 숨기기 ${property} ${size}`);
    }
    const remove = node('button.button.button--ghost.button--small.lounge__remove', portrait);
    assert.ok(lengthOf(rules, valueOf(rules, remove, 'min-height', env), env) >= 44, `${env.width}px 내보내기`);
    assert.equal(valueOf(rules, remove, 'white-space', env), 'nowrap', '80px 칸에서 «내보내기»가 갈라지지 않는다');
  }
});

test('말 숨기기는 액자 귀퉁이에 걸려 명단을 늘리지 않고, 걷는 캐릭터를 덮지 않는다', async () => {
  assert.equal(valueOf(rules, mute(false), 'position', MOBILE), 'absolute');
  assert.equal(valueOf(rules, portrait, 'position', MOBILE), 'relative');
  // 명단은 걷는 캐릭터(fixed)보다 DOM 앞에 있어야 위치를 줘도 캐릭터를 덮지 않는다 (z-index 없음)
  const html = await source('index.html');
  assert.ok(html.indexOf('id="lounge-players"') < html.indexOf('id="waiting-remote-characters"'));
  assert.ok(html.indexOf('id="lounge-players"') < html.indexOf('id="waiting-character"'));
  // 배지는 누르는 자리를 가로채지 않는다 — elementFromPoint 가 버튼을 집어야 워커가 밟는다
  assert.equal(valueOf(rules, node('span.lounge__mute-badge', mute(false)), 'pointer-events', MOBILE), 'none');
});

test('숨김 상태는 색만이 아니라 채움과 아이콘 모양으로 구분된다 (디자인 시스템 §6)', () => {
  assert.equal(valueOf(rules, mute(false), '--icon', MOBILE), 'var(--i-chat)');
  assert.equal(valueOf(rules, mute(true), '--icon', MOBILE), 'var(--i-chat-off)');
  const badge = (pressed) => node('span.lounge__mute-badge', mute(pressed));
  assert.equal(valueOf(rules, badge(false), 'background', MOBILE), 'var(--surface)');
  assert.equal(valueOf(rules, badge(true), 'background', MOBILE), 'var(--accent)');
  // 걸어서 올라선 표시는 초점 고리와 같은 모양이다
  assert.match(valueOf(rules, node('button.lounge__mute.is-standing', portrait), 'outline', MOBILE) ?? '', /var\(--focus\)/);
});

test('내보내기 확인은 인페이지 대화상자이고 브라우저 모달을 쓰지 않는다', async () => {
  const [html, room] = await Promise.all([source('index.html'), source('src/ui/waiting-room.ts')]);
  const dialog = html.slice(html.indexOf('id="remove-member-dialog"'), html.indexOf('id="nickname-dialog"'));
  assert.match(dialog, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="remove-member-title"/);
  assert.match(dialog, /id="remove-member-cancel">그대로 두기</);
  assert.match(dialog, /class="button button--danger" id="remove-member-confirm">내보내기</);
  // 대화상자는 <main> 뒤에 와서 DOM 순서로 위에 온다
  assert.ok(html.indexOf('</main>') < html.indexOf('id="remove-member-dialog"'));
  assert.doesNotMatch(room, /window\.(?:confirm|alert|prompt)\(/);
  assert.match(room, /trapFocus\(el\.removeDialog, event\)/);
});

test('기록 내보내기는 랭킹 목록 아래 유리 표면이고, 탭마다 10개뿐이라는 것을 말한다 (N02)', async () => {
  const html = await source('index.html');
  const ranking = html.slice(html.indexOf('data-screen="ranking"'), html.indexOf('id="ranking-character"'));
  assert.match(ranking, /id="ranking-export-file"[^>]*>기록 내보내기</);
  assert.match(ranking, /id="ranking-export-copy"[^>]*>기록 복사</);
  assert.match(ranking, /id="ranking-export-note">[^<]*상위 10개/);
  assert.match(ranking, /id="ranking-export-status" role="status"/);
  assert.ok(ranking.indexOf('id="ranking-export"') < ranking.indexOf('id="ranking-footer"'), '위험 보조 버튼보다 앞에 온다');
  const block = node('div.ranking-export#ranking-export', node("section.screen[data-screen='ranking']", node('main.app', node('body'))));
  assert.equal(valueOf(rules, block, 'background', MOBILE), 'var(--world-glass)');
  const textarea = node('textarea.ranking-export__text#ranking-export-text', block);
  assert.equal(valueOf(rules, textarea, 'font-size', MOBILE), 'var(--text-md)', '입력칸은 16px — iOS 확대를 막는다');
});

test('누구 액자에 무엇이 붙는가: 말 숨기기는 남에게만, 내보내기는 방장 화면의 남에게만', async () => {
  const { waitingRoomPortraitActions, waitingRoomMuteLabel, waitingRoomRemoveLabel } = await import('../js/ui/waiting-room-portrait.js');
  const other = { isMe: false, connected: true };
  const ghost = { isMe: false, connected: false };
  const me = { isMe: true, connected: true };
  // 소유자 결정: 방장은 접속 중인 사람도 확인창을 거쳐 내보낸다
  assert.deepEqual(waitingRoomPortraitActions(other, { isHost: true, muted: false }), { mute: true, muted: false, remove: true });
  assert.deepEqual(waitingRoomPortraitActions(ghost, { isHost: true, muted: true }), { mute: true, muted: true, remove: true });
  assert.deepEqual(waitingRoomPortraitActions(other, { isHost: false, muted: false }), { mute: true, muted: false, remove: false });
  assert.deepEqual(waitingRoomPortraitActions(ghost, { isHost: false, muted: false }), { mute: true, muted: false, remove: false });
  assert.deepEqual(waitingRoomPortraitActions(me, { isHost: true, muted: true }), { mute: false, muted: false, remove: false });
  assert.equal(waitingRoomMuteLabel('민수'), '민수 님 말 숨기기');
  assert.equal(waitingRoomRemoveLabel('민수'), '민수 님 내보내기');
});

test('내보내기 확인창은 접속 중인 사람과 끊긴 사람에게 일어날 일을 다르게 말한다', async () => {
  const { waitingRoomRemoveDialogText } = await import('../js/ui/waiting-room-portrait.js');
  const connected = waitingRoomRemoveDialogText('민수', true);
  assert.equal(connected.title, '민수 님을 방에서 내보낼까요?');
  assert.match(connected.body, /^잠시 다시 들어올 수 없어요\./);
  assert.doesNotMatch(connected.body, /다시 참가할 수 있어요/, '막히는 사람에게 다시 들어올 수 있다고 하지 않는다');

  const ghost = waitingRoomRemoveDialogText('유령', false);
  assert.equal(ghost.title, '유령 님을 내보낼까요?');
  assert.match(ghost.body, /연결이 끊긴 지 1분이 넘었어요/);
  assert.match(ghost.body, /방 코드로 다시 참가할 수 있어요/);

  // 새로 쓴 문장은 해요체다
  for (const text of [connected.title, connected.body, ghost.title, ghost.body]) {
    assert.doesNotMatch(text, /니다[.?]?$|니까\?$/);
  }
  // 정적 HTML 의 기본 설명은 끊긴 사람 쪽 문장과 같다(스크립트가 상태마다 바꾼다)
  const html = await source('index.html');
  assert.ok(html.includes(`id="remove-member-body">${ghost.body}</p>`));
});

test('말 숨기기 목록은 방마다 따로이고 서버로 가지 않는다', async () => {
  const [{ createChatMutes, chatMuteNotice }, mutesSource] = await Promise.all([
    import('../js/ui/chat-mutes.js'),
    source('src/ui/chat-mutes.ts'),
  ]);
  const mutes = createChatMutes();
  assert.equal(mutes.toggle('AAA222', 'p1'), true);
  assert.equal(mutes.isMuted('AAA222', 'p1'), true);
  assert.equal(mutes.isMuted('BBB333', 'p1'), false, '다른 방에서는 숨기지 않는다');
  assert.equal(mutes.toggle('AAA222', 'p1'), false);
  assert.equal(mutes.isMuted('AAA222', 'p1'), false);
  assert.equal(chatMuteNotice('민수', true), '민수 님의 말을 숨겼어요. 내 화면에서만 숨겨져요.');
  assert.equal(chatMuteNotice('민수', false), '민수 님의 말을 다시 보여요.');
  assert.doesNotMatch(mutesSource.replace(/\/\/.*$/gm, ''), /fetch|localStorage|import /, '메모리에만 둔다');
});

test('내가 내보낸 사람의 퇴장은 «나갔어요»로 다시 쓰지 않는다 (U24)', async () => {
  const { waitingRoomChangeNotices } = await import('../js/ui/waiting-room-action.js');
  const player = (id, nickname) => ({ id, nickname, characterId: 'slime-blue', isReady: false, connected: true });
  const room = (players) => ({ code: 'AAA222', players, isMine: true });
  const before = room([player('me', '나'), player('ghost', '유령'), player('guest', '민수')]);
  const after = room([player('me', '나')]);
  assert.deepEqual(waitingRoomChangeNotices(before, after, 'me', ['ghost']), ['민수 님이 나갔어요.']);
  assert.deepEqual(waitingRoomChangeNotices(before, after, 'me'), ['유령 님, 민수 님이 나갔어요.']);
});

test('내보내기 거절 이유는 빠짐없이 플레이어의 말로 옮긴다', async () => {
  const { REMOVE_MEMBER_MESSAGES } = await import('../js/online/rules.js');
  assert.deepEqual(
    Object.keys(REMOVE_MEMBER_MESSAGES).sort(),
    ['game-in-progress', 'member-connected', 'not-found', 'not-host', 'not-member'],
  );
  for (const message of Object.values(REMOVE_MEMBER_MESSAGES)) {
    assert.doesNotMatch(message('민수'), /서버|snapshot|API/, '화면 문구에 개발 용어를 쓰지 않는다 (U40)');
  }
  // 끊긴 자리를 비우려던 사이 다시 붙었다 — 이제는 막힌 내보내기를 다시 고를 수 있다고 말한다
  assert.equal(REMOVE_MEMBER_MESSAGES['member-connected']('민수'), '민수 님이 다시 연결됐어요. 그래도 내보내려면 다시 눌러 주세요.');
});

test('내보내진 사람이 듣는 말은 다시 들어올 수 있는지를 방식마다 맞게 말한다', async () => {
  const { REMOVED_BY_HOST_MESSAGES, REMOVED_BY_HOST_MESSAGE, removalKind, RemovedFromRoom } = await import('../js/online/rules.js');
  assert.deepEqual(Object.keys(REMOVED_BY_HOST_MESSAGES).sort(), ['kicked', 'removed']);
  assert.equal(REMOVED_BY_HOST_MESSAGES.removed, REMOVED_BY_HOST_MESSAGE);
  for (const message of Object.values(REMOVED_BY_HOST_MESSAGES)) assert.match(message, /^방장이 방에서 내보냈어요\./);
  assert.match(REMOVED_BY_HOST_MESSAGES.kicked, /잠시 뒤에 다시 들어올 수 있어요/);
  assert.equal(removalKind('kicked'), 'kicked');
  assert.equal(removalKind('removed'), 'removed');
  assert.equal(removalKind('not-found'), null);
  assert.equal(new RemovedFromRoom().kind, 'removed', '구버전 서버의 removed 와 같다');
  assert.equal(new RemovedFromRoom('kicked').message, REMOVED_BY_HOST_MESSAGES.kicked);
});
