import test from 'node:test';
import assert from 'node:assert/strict';

// 홈의 «「방」 방에 아직 있어요» 줄 (U35, online-client-1·server-5).
//
// 한때 이 줄은 한 번도 뜨지 않았다. goHome이 화면 세대를 쥔 **다음** goTo('home')이 세대를 또
// 올려, 답이 올 때마다 «지난 화면의 답»으로 버려졌다 — 그러면서 홈에 올 때마다 목록 GET을 보냈다.
// 소스 문자열만 보던 테스트는 그 잘못된 순서까지 그대로 잠가 두었다. 여기서는 app.ts 의 화면
// 이동(대기실이 아니면 goTo가 세대를 올린다)을 그대로 옮긴 작은 앱 위에서 실제 모듈을 돌린다.
// app.ts 가 이 순서로 부르는지는 tests/online-lobby-entry.test.mjs 가 잠근다.

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

// safe-storage.js 는 불러오는 순간 저장소를 한 번 고른다. 그 전에 메모리 저장소를 깐다
const storage = memoryStorage();
globalThis.window = { localStorage: storage };

const { createHomeRoomNote } = await import('../js/online/home-room-note.js');
const { createLocalPreferences } = await import('../js/storage/local-store.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const ROOM_A = { code: 'ABC234', name: '우리 반' };
const ROOM_B = { code: 'BCD345', name: '점심 퀴즈' };

/**
 * app.ts 의 흐름을 옮긴 작은 앱. 세대 규칙은 원본과 같다 —
 * goTo(name)은 대기실이 아니면 세대를 올리고, 화면을 여는 함수는 시작할 때 세대를 쥐었다가
 * 기다린 뒤 아직 자기 세대일 때만 화면을 연다.
 */
function createApp({ isNetworked = true, lastRoomCode = null, rooms = null } = {}) {
  let generation = 0;
  let activeRoomCode = null;
  const saved = [];
  const shown = [];
  const asks = [];
  const note = createHomeRoomNote({
    isNetworked,
    lastRoomCode,
    saveLastRoomCode: (code) => saved.push(code),
    myRooms: () => {
      const answer = deferred();
      asks.push(answer);
      if (app.rooms !== null) answer.resolve(app.rooms);
      return answer.promise;
    },
    activeRoomCode: () => activeRoomCode,
    navigation: () => generation,
    show: (room) => shown.push(room),
  });

  const invalidate = () => { generation += 1; return generation; };
  function goTo(name) {
    if (name !== 'waiting') invalidate();
    app.screen = name;
  }

  const app = {
    note,
    saved,
    shown,
    asks,
    /** null 이면 myRooms 가 답을 미룬다. 테스트가 asks[i] 를 직접 푼다 */
    rooms,
    screen: 'home',
    /** app.ts 의 goHome = showHome(세대 → 최고 점수 대기 → goTo('home')) → note.refresh() */
    async goHome() {
      const mine = invalidate();
      await tick(); // loadBestScores
      if (mine !== generation) return;
      goTo('home');
      void note.refresh();
    },
    /** 고치기 전 goHome 의 순서 — 세대를 쥔 다음 goTo('home')이 그 세대를 또 올렸다 */
    async goHomeCapturingBeforeGoTo() {
      const mine = invalidate();
      await tick();
      if (mine !== generation) return;
      void note.refresh(); // 지금 세대(mine)를 쥔다
      goTo('home'); // 세대가 mine + 1 이 된다
    },
    async openRanking() {
      const mine = invalidate();
      await tick();
      if (mine !== generation) return;
      goTo('ranking');
    },
    async openOnline() {
      const mine = invalidate();
      note.visitOnline();
      await tick();
      if (mine !== generation) return;
      goTo('online');
    },
    async openWaitingRoom(code) {
      invalidate();
      note.enter(code);
      activeRoomCode = code;
      await tick();
      goTo('waiting');
    },
    /** 대기실의 「나가기」 → onLeave → 로비 */
    async leaveRoom(code) {
      activeRoomCode = null;
      note.leave(code);
      await app.openOnline();
    },
  };
  return app;
}

test('새로고침한 사람: 흔적이 있으면 홈을 연 뒤 묻고, 들어가 있는 방의 줄을 띄운다 (online-client-1)', async () => {
  const app = createApp({ lastRoomCode: ROOM_A.code, rooms: [ROOM_A] });

  await app.goHome();
  await tick();

  assert.equal(app.screen, 'home');
  assert.equal(app.asks.length, 1, '부팅 직후 한 번 묻는다');
  assert.deepEqual(app.shown, [ROOM_A], '홈에 남아 있는 동안 온 답이므로 줄을 띄운다');
  assert.deepEqual(app.saved, [], '흔적이 이미 그 방이면 다시 쓰지 않는다');

  // 그 사이에는 묻지 않는다 — 로컬 판·랭킹을 다녀와도 마지막 답을 둔다 (N01)
  await app.openRanking();
  await app.goHome();
  await tick();
  assert.equal(app.asks.length, 1);
});

test('홈을 열기 전에 세대를 쥐면 홈에 그대로 있어도 답이 버려진다 — refresh 는 goTo(home) 뒤에 부른다', async () => {
  const app = createApp({ lastRoomCode: ROOM_A.code, rooms: [ROOM_A] });

  await app.goHomeCapturingBeforeGoTo();
  await tick();
  assert.equal(app.screen, 'home', '사용자는 홈을 떠나지 않았다');
  assert.equal(app.asks.length, 1, '목록은 물었는데');
  assert.deepEqual(app.shown, [], '답이 «지난 화면»으로 읽혀 줄이 뜨지 않는다 — 고치기 전의 증상');

  // 고친 순서로 홈에 오면 다시 묻고(버린 답은 다음 홈에서 다시 묻는다) 이번에는 줄이 뜬다
  await app.goHome();
  await tick();
  assert.equal(app.asks.length, 2);
  assert.deepEqual(app.shown, [ROOM_A]);
});

test('묻는 사이 홈을 떠났으면 늦은 답으로 그리지도 흔적을 고치지도 않고, 다음 홈에서 다시 묻는다', async () => {
  const app = createApp({ lastRoomCode: ROOM_A.code });

  await app.goHome();
  assert.equal(app.asks.length, 1);
  await app.openRanking();
  app.asks[0].resolve([]); // 홈을 떠난 뒤에야 «들어간 방 없음»이 온다
  await tick();

  assert.equal(app.screen, 'ranking');
  assert.deepEqual(app.shown, [], '랭킹 화면 뒤의 홈에 지난 답을 그리지 않는다');
  assert.deepEqual(app.saved, [], '지난 답으로 흔적을 지우지 않는다');

  await app.goHome();
  assert.equal(app.asks.length, 2, '버린 답 대신 한 번 더 묻는다');
  app.asks[1].resolve([ROOM_A]);
  await tick();
  assert.deepEqual(app.shown, [ROOM_A]);
});

test('흔적도 온라인 방문도 없으면 부팅 때 서버에 묻지 않는다 — 로컬 퀴즈만 하러 온 사람 (server-5)', async () => {
  const app = createApp({ lastRoomCode: null, rooms: [] });

  await app.goHome();
  await tick();
  assert.equal(app.asks.length, 0, '세션 PUT과 로비 전체 GET을 보내지 않는다');
  assert.deepEqual(app.shown, []);

  // 로비를 다녀오면 흔적이 없어도 한 번 묻는다(로비 목록에서 나간 방 등)
  await app.openOnline();
  await app.goHome();
  await tick();
  assert.equal(app.asks.length, 1);
  assert.deepEqual(app.shown, [null]);
});

test('방에 들어가면 흔적을 남기고, 나오면 그 방의 줄과 흔적을 거둔다', async () => {
  const app = createApp({ rooms: [ROOM_A] });

  await app.openWaitingRoom(ROOM_A.code);
  assert.deepEqual(app.saved, [ROOM_A.code], '새로고침 뒤의 부팅이 물어볼 흔적');

  await app.goHome();
  await tick();
  assert.deepEqual(app.shown, [ROOM_A]);

  await app.openWaitingRoom(ROOM_A.code);
  assert.deepEqual(app.saved, [ROOM_A.code], '같은 방이면 다시 쓰지 않는다');

  await app.leaveRoom(ROOM_A.code);
  assert.deepEqual(app.saved, [ROOM_A.code, null], '나온 방은 흔적에서 지운다');
  assert.equal(app.shown.at(-1), null, '홈의 줄도 거둔다');

  app.rooms = [];
  await app.goHome();
  await tick();
  assert.equal(app.asks.length, 2, '로비를 다녀왔으므로 한 번 묻는다');
  assert.deepEqual(app.saved, [ROOM_A.code, null], '이미 지운 흔적을 또 쓰지 않는다');
});

test('다른 방에서 나와도 아직 들어가 있는 방의 줄은 그대로 둔다', async () => {
  const app = createApp({ lastRoomCode: ROOM_A.code, rooms: [ROOM_A] });
  await app.goHome();
  await tick();
  assert.deepEqual(app.shown, [ROOM_A]);

  app.note.leave(ROOM_B.code);
  assert.deepEqual(app.shown, [ROOM_A], '보이는 줄은 다른 방이다');
  assert.deepEqual(app.saved, [], '흔적도 다른 방이다');
});

test('물어보니 들어간 방이 없으면 흔적을 지운다 — 다음 부팅에는 묻지 않는다', async () => {
  const app = createApp({ lastRoomCode: ROOM_A.code, rooms: [] });

  await app.goHome();
  await tick();
  assert.deepEqual(app.shown, [null]);
  assert.deepEqual(app.saved, [null]);
});

test('여럿에 들어가 있으면 지금 들어가 있는 방을 먼저 보이고 그 방을 흔적으로 남긴다', async () => {
  const app = createApp({ rooms: [ROOM_A, ROOM_B] });

  await app.openWaitingRoom(ROOM_B.code);
  await app.goHome();
  await tick();
  assert.deepEqual(app.shown, [ROOM_B]);
  assert.deepEqual(app.saved, [ROOM_B.code]);
});

test('묻다 실패하면 조용히 넘어가고, 온라인을 다녀온 뒤에야 다시 묻는다', async () => {
  const app = createApp({ lastRoomCode: ROOM_A.code });

  await app.goHome();
  app.asks[0].reject(new Error('offline'));
  await tick();
  assert.deepEqual(app.shown, []);

  await app.openRanking();
  await app.goHome();
  assert.equal(app.asks.length, 1, '실패했다고 홈에 올 때마다 다시 묻지 않는다');

  await app.openOnline();
  await app.goHome();
  assert.equal(app.asks.length, 2);
});

test('이 브라우저 안의 방(로컬 구현)이면 묻지도 흔적을 남기지도 않는다', async () => {
  const app = createApp({ isNetworked: false, lastRoomCode: ROOM_A.code, rooms: [ROOM_A] });

  await app.openWaitingRoom(ROOM_A.code);
  await app.goHome();
  await tick();
  assert.equal(app.asks.length, 0);
  assert.deepEqual(app.saved, []);
  assert.deepEqual(app.shown, []);
});

test('부팅 흔적은 preferences 가 safe-storage 로만 읽고 쓰며, 깨진 값은 흔적으로 치지 않는다', async () => {
  const preferences = createLocalPreferences();

  assert.equal(await preferences.getLastRoomCode(), null);
  await preferences.setLastRoomCode('ABC234');
  assert.equal(storage.values.get('quiz.lastRoomCode'), '"ABC234"');
  assert.equal(await preferences.getLastRoomCode(), 'ABC234');

  await preferences.setLastRoomCode(null);
  assert.equal(storage.values.has('quiz.lastRoomCode'), false, '지울 때는 키를 남기지 않는다');
  assert.equal(await preferences.getLastRoomCode(), null);

  for (const raw of ['"abc234"', '"ABC"', '123456', '{"code":"ABC234"}', 'not json']) {
    storage.values.set('quiz.lastRoomCode', raw);
    assert.equal(await preferences.getLastRoomCode(), null, `${raw} 는 방 코드가 아니다`);
  }
  storage.values.delete('quiz.lastRoomCode');
});
