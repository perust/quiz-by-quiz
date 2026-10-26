import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 「한 판 더」의 자동 준비 (U38)와 온라인 효과음 (N03).

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ME = '12345678-1234-5678-9234-567812345678';
const HOST = '22345678-1234-5678-9234-567812345678';

function room({ mine = false, ready = false } = {}) {
  const me = { id: ME, nickname: '나', characterId: 'slime-blue', isReady: ready, connected: true };
  const host = { id: HOST, nickname: '방장', characterId: 'slime-blue', isReady: false, connected: true };
  return {
    code: 'ABC234', name: '방', categoryId: null, capacity: 4, gameMode: true,
    // 방장이 첫 자리다
    players: mine ? [me, host] : [host, me],
    isPublic: true, hasPassword: false, isMine: mine, joined: true,
    createdAt: '2026-09-18T00:00:00Z', status: 'waiting', inMatch: false,
  };
}

function fakeStore(current, { failRoom = false, readyResult } = {}) {
  const calls = [];
  return {
    calls,
    me: () => ME,
    async getRoom(code) {
      calls.push(['getRoom', code]);
      if (failRoom) throw new Error('Failed to fetch');
      return current;
    },
    async setReady(spec) {
      calls.push(['setReady', spec]);
      return readyResult ?? { ok: true, room: { ...current, players: current.players.map((p) => (p.id === ME ? { ...p, isReady: true } : p)) } };
    },
  };
}

test('「한 판 더」: 참가자는 대기실을 열기 전에 준비를 켜 둔다', async () => {
  const { readyForRematch } = await import('../js/online/rematch.js');
  const store = fakeStore(room());
  assert.equal(await readyForRematch(store, 'ABC234'), 'readied');
  assert.deepEqual(store.calls, [['getRoom', 'ABC234'], ['setReady', { code: 'ABC234', isReady: true }]]);
});

test('「한 판 더」: 방장은 준비를 보내지 않는다 — 시작 요청이 곧 준비다 (U28)', async () => {
  const { readyForRematch } = await import('../js/online/rematch.js');
  const store = fakeStore(room({ mine: true }));
  assert.equal(await readyForRematch(store, 'ABC234'), 'host');
  assert.deepEqual(store.calls.map(([name]) => name), ['getRoom']);
});

test('「한 판 더」: 이미 준비했으면 토글을 되돌리지 않는다', async () => {
  const { readyForRematch } = await import('../js/online/rematch.js');
  const store = fakeStore(room({ ready: true }));
  assert.equal(await readyForRematch(store, 'ABC234'), 'already-ready');
  assert.deepEqual(store.calls.map(([name]) => name), ['getRoom']);
});

test('「한 판 더」: 방을 못 읽거나 준비가 거절돼도 막지 않는다 — 대기실의 토글로 다시 누른다', async () => {
  const { readyForRematch } = await import('../js/online/rematch.js');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await readyForRematch(fakeStore(room(), { failRoom: true }), 'ABC234'), 'skipped');
  } finally {
    console.warn = warn;
  }
  assert.equal(await readyForRematch(fakeStore(null), 'ABC234'), 'skipped', '방이 사라졌다');
  assert.equal(
    await readyForRematch(fakeStore(room(), { readyResult: { ok: false, reason: 'game-in-progress' } }), 'ABC234'),
    'skipped',
  );
  const notMember = { ...room(), players: room().players.filter(({ id }) => id !== ME) };
  assert.equal(await readyForRematch(fakeStore(notMember), 'ABC234'), 'skipped');
});

// ── 기다리는 사이 다른 행동이 이겼다 (online-flow-1) ──────────────────
//
// 「한 판 더」는 방 GET → 준비 PUT 두 번을 기다린다. 그사이 「홈으로」를 누르면 화면은 홈이 이기는데,
// 준비가 서버에 남으면 홈에 있는 사람이 방장의 다음 시작에 끌려 들어간다(60초 유예 안이라 «접속 중»이다).

/** 응답을 손으로 푸는 가짜 저장소. getRoom·setReady 가 부를 때마다 기다리는 약속을 남긴다 */
function deferredStore(current) {
  const calls = [];
  const pending = [];
  const wait = (value) => new Promise((resolve) => { pending.push(() => resolve(value)); });
  return {
    calls,
    me: () => ME,
    getRoom(code) {
      calls.push(['getRoom', code]);
      return wait(current);
    },
    setReady(spec) {
      calls.push(['setReady', spec]);
      return wait({ ok: true, room: current });
    },
    /** 가장 먼저 기다린 응답을 푼다 */
    async release() {
      pending.shift()();
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    },
  };
}

function flowFor(store, nav) {
  const opened = [];
  return {
    opened,
    flow: {
      store,
      code: 'ABC234',
      isStillCurrent: () => nav.current,
      isInWaitingRoom: () => nav.inWaitingRoom,
      openWaitingRoom: async () => { opened.push('ABC234'); },
    },
  };
}

test('「한 판 더」: 방을 읽는 사이 홈으로 갔으면 준비를 보내지 않는다 (online-flow-1)', async () => {
  const { playAgainInRoom } = await import('../js/online/rematch.js');
  const store = deferredStore(room());
  const nav = { current: true, inWaitingRoom: false };
  const { flow, opened } = flowFor(store, nav);
  const done = playAgainInRoom(flow);

  nav.current = false; // 「홈으로」가 이겼다
  await store.release(); // 늦게 온 방 GET
  assert.deepEqual(store.calls, [['getRoom', 'ABC234']], '준비 PUT 이 나가지 않는다');
  assert.equal(await done, 'skipped');
  assert.deepEqual(opened, [], '대기실을 열지 않는다');
});

test('「한 판 더」: 준비가 나간 뒤에 홈으로 갔으면 서버에 닿은 준비를 되돌린다 (online-flow-1)', async () => {
  const { playAgainInRoom } = await import('../js/online/rematch.js');
  const store = deferredStore(room());
  const nav = { current: true, inWaitingRoom: false };
  const { flow, opened } = flowFor(store, nav);
  const done = playAgainInRoom(flow);

  await store.release(); // 방 GET — 아직 결과 화면이다
  assert.deepEqual(store.calls.at(-1), ['setReady', { code: 'ABC234', isReady: true }]);
  nav.current = false; // PUT 이 도는 사이 「홈으로」
  await store.release();
  assert.equal(await done, 'readied');
  assert.deepEqual(store.calls.at(-1), ['setReady', { code: 'ABC234', isReady: false }], '켜 둔 준비를 되돌린다');
  assert.deepEqual(opened, []);
});

test('「한 판 더」: 기다리는 사이 그 방의 「대기실로」를 눌렀으면 준비를 그대로 둔다 — 대기실이 보여 준다', async () => {
  const { playAgainInRoom } = await import('../js/online/rematch.js');
  const store = deferredStore(room());
  const nav = { current: true, inWaitingRoom: false };
  const { flow, opened } = flowFor(store, nav);
  const done = playAgainInRoom(flow);

  await store.release();
  nav.current = false;
  nav.inWaitingRoom = true; // 「대기실로」가 같은 방의 대기실을 여는 중이다
  await store.release();
  assert.equal(await done, 'readied');
  assert.deepEqual(store.calls.map(([name, spec]) => [name, spec?.isReady]), [['getRoom', undefined], ['setReady', true]]);
  assert.deepEqual(opened, [], '「대기실로」가 연다 — 두 번 열지 않는다');
});

test('「한 판 더」: 아무것도 끼어들지 않으면 준비를 켜고 대기실을 연다. 되돌림은 내가 켠 준비뿐이다', async () => {
  const { playAgainInRoom } = await import('../js/online/rematch.js');
  const store = deferredStore(room());
  const nav = { current: true, inWaitingRoom: false };
  const { flow, opened } = flowFor(store, nav);
  const done = playAgainInRoom(flow);
  await store.release();
  await store.release();
  assert.equal(await done, 'readied');
  assert.deepEqual(opened, ['ABC234']);
  assert.equal(store.calls.length, 2, '되돌리지 않는다');

  // 이미 준비해 둔 사람(대기실에서 스스로 켰다)은 홈으로 가도 그 준비를 건드리지 않는다
  const ready = deferredStore(room({ ready: true }));
  const away = { current: true, inWaitingRoom: false };
  const other = flowFor(ready, away);
  const pending = playAgainInRoom(other.flow);
  await ready.release();
  away.current = false;
  assert.equal(await pending, 'already-ready');
  assert.deepEqual(ready.calls.map(([name]) => name), ['getRoom']);
});

// ── 효과음 (N03) ────────────────────────────────────────────────

class FakeAudioContext {
  static tones = [];
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
  }
  resume() {}
  createOscillator() {
    const tone = { frequency: { setValueAtTime: (freq) => FakeAudioContext.tones.push(freq) } };
    return { ...tone, connect: (gain) => gain, start() {}, stop() {}, type: 'sine' };
  }
  createGain() {
    const ramp = () => {};
    return {
      gain: { setValueAtTime: ramp, exponentialRampToValueAtTime: ramp },
      connect: (target) => target,
    };
  }
}

test('끝난 판의 차임과 입장 차임은 audio.ts 를 거치고 소리 설정을 따른다', async () => {
  globalThis.window = { AudioContext: FakeAudioContext };
  try {
    const audio = await import('../js/audio.js');
    audio.setEnabled(true);
    FakeAudioContext.tones = [];
    audio.playFinish();
    assert.equal(FakeAudioContext.tones.length, 3, '세 음');
    assert.ok(FakeAudioContext.tones[0] < FakeAudioContext.tones[2], '올라간다');
    FakeAudioContext.tones = [];
    audio.playJoin();
    assert.equal(FakeAudioContext.tones.length, 2, '작은 두 음');

    audio.setEnabled(false);
    FakeAudioContext.tones = [];
    audio.playFinish();
    audio.playJoin();
    audio.playCorrect();
    assert.equal(FakeAudioContext.tones.length, 0, '소리를 끄면 아무 소리도 내지 않는다');
    audio.setEnabled(true);
  } finally {
    delete globalThis.window;
  }
});

test('입장 차임은 다른 사람이 새로 들어왔을 때만, 보이는 대기실에서 울린다', async () => {
  const { waitingRoomJoinedOthers, waitingRoomChangeNotices } = await import('../js/ui/waiting-room-action.js');
  const before = room();
  const guest = { id: '32345678-1234-5678-9234-567812345678', nickname: '민수', characterId: 'slime-blue', isReady: false, connected: true };
  const after = { ...before, players: [...before.players, guest] };

  assert.deepEqual(waitingRoomJoinedOthers(before, after, ME).map(({ id }) => id), [guest.id]);
  assert.deepEqual(waitingRoomJoinedOthers(after, before, ME), [], '나간 것은 입장이 아니다');
  assert.deepEqual(waitingRoomJoinedOthers({ ...before, players: [before.players[0]] }, before, ME), [], '내가 들어온 것은 알리지 않는다');
  assert.deepEqual(waitingRoomJoinedOthers({ ...before, code: 'XYZ234' }, after, ME), [], '다른 방의 첫 snapshot');
  // 안내 줄과 같은 판정이다
  assert.deepEqual(waitingRoomChangeNotices(before, after, ME), ['민수 님이 들어왔어요.']);
  // 방장이 내보낸 사람(quiet, U24)은 퇴장 안내만 조용해진다. 입장 판정은 건드리지 않으므로 차임과 안내 줄이
  // 여전히 같은 판정이고, 내보낸 snapshot에는 입장이 없어 차임도 울리지 않는다
  assert.deepEqual(waitingRoomChangeNotices(before, after, ME, [guest.id]), ['민수 님이 들어왔어요.'], 'quiet 는 입장을 숨기지 않는다');
  assert.deepEqual(waitingRoomChangeNotices(after, before, ME, [guest.id]), [], '내보낸 사람은 «나갔어요»가 없다');

  const waiting = await source('src/ui/waiting-room.ts');
  assert.match(waiting, /import \{ playJoin \} from '\.\.\/audio\.js';/);
  assert.match(
    waiting,
    /function applyRoom\(next: PublicRoom, quiet: readonly string\[\] = \[\]\): void \{[\s\S]*?for \(const line of waitingRoomChangeNotices\(previous, next, roomStore\.me\(\), quiet\)\) notice\(line\);[\s\S]*?if \(!el\.screen\.hidden && waitingRoomJoinedOthers\(previous, next, roomStore\.me\(\)\)\.length > 0\) playJoin\(\);/,
  );
});

test('온라인 결과 화면은 최종 순위를 보일 때 차임을 한 번 낸다. 째깍거리는 카운트다운 소리는 어디에도 없다', async () => {
  const [result, audio] = await Promise.all([source('src/ui/online-result.ts'), source('src/audio.ts')]);
  assert.match(result, /import \{ playFinish \} from '\.\.\/audio\.js';/);
  const show = result.slice(result.indexOf('show(snapshot, options'), result.indexOf('hide() {'));
  assert.equal(show.match(/playFinish\(\)/g)?.length, 1);
  assert.doesNotMatch(audio, /export function play(?:Tick|Countdown|Warning)/);
});
