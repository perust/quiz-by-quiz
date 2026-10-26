import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 온라인 최종 순위 화면도 방 소켓을 붙든다 (U24). 서버는 방 소켓이 없는 참가자를 60초
// 유예 뒤 «연결 끊김»으로 보아 다음 판의 시작 판정에서 빼고 방장 자리도 넘긴다. 결과를
// 1분 넘게 읽는 사람이 그렇게 되면 안 된다.

const MATCH_ID = '12345678-1234-5678-9234-567812345678';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

function fakeGateway() {
  const subscriptions = [];
  return {
    subscriptions,
    subscribe(code, handler) {
      const entry = { code, handler, closed: false };
      subscriptions.push(entry);
      return () => { entry.closed = true; };
    },
  };
}

test('keepalive는 방마다 소켓 하나만 붙들고, 놓으면 닫는다', async () => {
  const { createRoomKeepalive } = await import('../js/online/room-keepalive.js');
  const gateway = fakeGateway();
  const keepalive = createRoomKeepalive(gateway);

  assert.equal(keepalive.heldCode(), null);
  keepalive.release(); // 붙든 것이 없어도 안전하다

  keepalive.hold('ABC234', () => undefined);
  keepalive.hold('ABC234', () => undefined);
  assert.equal(gateway.subscriptions.length, 1, '같은 방을 다시 붙들어도 소켓을 다시 열지 않는다');
  assert.equal(keepalive.heldCode(), 'ABC234');

  keepalive.hold('XYZ789', () => undefined);
  assert.equal(gateway.subscriptions[0].closed, true, '다른 방으로 옮기면 앞의 소켓을 닫는다');
  assert.equal(gateway.subscriptions[1].code, 'XYZ789');

  keepalive.release();
  assert.equal(gateway.subscriptions[1].closed, true);
  assert.equal(keepalive.heldCode(), null);
});

test('keepalive는 새 판이 열렸다는 이벤트만 넘기고, 놓은 뒤 늦게 온 이벤트는 버린다', async () => {
  const { createRoomKeepalive } = await import('../js/online/room-keepalive.js');
  const gateway = fakeGateway();
  const keepalive = createRoomKeepalive(gateway);
  const started = [];
  keepalive.hold('ABC234', (matchId) => started.push(matchId));
  const { handler } = gateway.subscriptions[0];

  // 재연결마다 오는 무효화·방 snapshot·이동·채팅은 결과 화면이 그리지 않는다
  handler({ type: 'match', phase: 'invalidated', matchId: null });
  handler({ type: 'room', room: {} });
  handler({ type: 'chat', playerId: MATCH_ID, nickname: '친구', text: '한 판 더', at: 0 });
  assert.deepEqual(started, []);

  handler({ type: 'match', phase: 'started', matchId: MATCH_ID, setup: { categoryId: null, gameMode: true } });
  assert.deepEqual(started, [MATCH_ID]);

  keepalive.release();
  handler({ type: 'match', phase: 'started', matchId: MATCH_ID, setup: { categoryId: null, gameMode: true } });
  assert.deepEqual(started, [MATCH_ID], '놓은 소켓의 늦은 이벤트로 판을 열지 않는다');
});

test('keepalive는 실제 네트워크 저장소로 방 소켓을 열고 놓으면 닫는다', async () => {
  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const identity = { id: MATCH_ID, secret: 'browser-session-secret-with-thirty-two-chars' };
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
    if (url.endsWith('/v1/rooms/ABC234/ws-ticket')) return json({ ticket: 'result-screen-ticket-0123456789abcdef' }, 201);
    throw new Error(`unexpected request: ${url}`);
  };

  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  const { createRoomKeepalive } = await import('../js/online/room-keepalive.js');
  const store = createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage,
    fetchImpl,
    newIdentity: () => identity,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
  const keepalive = createRoomKeepalive(store);

  keepalive.hold('ABC234', () => undefined);
  for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(sockets.length, 1, '결과 화면에서도 방 이벤트 소켓이 열린다');
  assert.match(sockets[0].url, /\/v1\/rooms\/ABC234\/events$/);

  keepalive.release();
  assert.equal(sockets[0].readyState, 3, '화면을 떠나면 소켓을 닫는다');
});

test('최종 순위 화면은 아직 그 방에 있을 때만 소켓을 붙들고, 화면을 떠나면 놓는다', async () => {
  const app = await source('../src/app.ts');
  const final = between(app, '  function showOnlineFinal(', '  function stopOnlineMatch(');

  // 매치 controller가 room code를 비우기 전에 잡아 둔다
  assert.match(final, /const code = onlineMatchRoomCode;\s*stopOnlineMatch\(\);/);
  assert.match(final, /if \(!roomStore\.isNetworked \|\| !code \|\| code !== activeRoomCode\) return;/);
  assert.match(final, /resultKeepalive\.hold\(code,/);
  // 결과 화면에서 새 판이 열려도 socket event로 판을 열지 않는다. 서버 snapshot으로만 판정한다
  assert.match(final, /recoverActiveNetworkMatch\(code, \{/);
  assert.match(final, /isStillCurrent: \(\) => currentScreen === 'online-result'/);

  // goTo는 가는 곳 말고 모두 접는다 — 홈·로비·대기실 어느 쪽으로 떠나도 이 줄이 놓는다
  const closer = between(app, "    'online-result': () => {", '    ranking:');
  assert.match(closer, /resultKeepalive\.release\(\);/);
});
