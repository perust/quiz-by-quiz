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
