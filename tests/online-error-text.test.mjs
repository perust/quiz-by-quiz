import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// 온라인 오류는 플레이어의 말로 보이고, 개발 상세는 콘솔에만 남는다 (U40).
// 한때 매치 화면에 «온라인 매치 오류: 서버 매치 snapshot이 올바르지 않습니다»나
// «온라인 매치 오류: Failed to fetch»가 그대로 떴다.

const identity = {
  id: '12345678-1234-5678-9234-567812345678',
  secret: 'browser-session-secret-with-thirty-two-chars',
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function storeWith(listResponse) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  return createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    newIdentity: () => identity,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
      if (url.endsWith('/v1/rooms')) return listResponse();
      throw new Error(`unexpected request: ${url}`);
    },
  });
}

async function captureWarnings(run) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map((value) => (
    value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  )).join(' '));
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = warn;
  }
}

test('onlineErrorText는 이유를 아는 오류만 그 말을 쓰고, 나머지는 고른 말로 바꾼다', async () => {
  const {
    LEAVE_MESSAGES, LeaveRoomRejected, OnlinePlayerError, onlineErrorText,
  } = await import('../js/online/rules.js');

  const { result, warnings } = await captureWarnings(() => [
    onlineErrorText(new OnlinePlayerError('요청이 많아요.'), '대신 보일 말'),
    onlineErrorText(new LeaveRoomRejected('game-in-progress'), '대신 보일 말'),
    onlineErrorText(new Error('서버 방 응답이 올바르지 않습니다.'), '대신 보일 말'),
    onlineErrorText(new TypeError('Failed to fetch'), '대신 보일 말'),
    onlineErrorText('문자열로 던진 것', '대신 보일 말'),
  ]);

  assert.deepEqual(result, [
    '요청이 많아요.',
    LEAVE_MESSAGES['game-in-progress'],
    '대신 보일 말',
    '대신 보일 말',
    '대신 보일 말',
  ]);
  // 바꿔 말한 오류의 상세는 콘솔에 남는다. 이유를 이미 아는 오류는 콘솔을 어지럽히지 않는다
  assert.equal(warnings.length, 3);
  assert.ok(warnings[0].includes('서버 방 응답이 올바르지 않습니다.'));
  assert.ok(warnings[1].includes('Failed to fetch'));
});

test('응답 시간 초과는 플레이어의 말로 던지고 요청 경로는 콘솔에만 남긴다', async () => {
  const { OnlinePlayerError } = await import('../js/online/rules.js');
  const store = await storeWith(() => {
    throw new DOMException('The operation was aborted.', 'AbortError');
  });

  const { result: error, warnings } = await captureWarnings(
    () => store.listRooms().then(() => assert.fail('listRooms should reject'), (reason) => reason),
  );
  assert.ok(error instanceof OnlinePlayerError);
  assert.equal(error.message, '응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.');
  assert.ok(warnings.some((line) => line.includes('GET /v1/rooms')));
});

test('서버가 4xx로 알려 준 이유는 그대로, 5xx의 개발 상세는 한 가지 말로 바꾼다', async () => {
  const { OnlinePlayerError } = await import('../js/online/rules.js');
  const limited = await storeWith(() => json({
    detail: { code: 'rate-limited', message: '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.' },
  }, 429));
  const rejected = await limited.listRooms().then(() => assert.fail('should reject'), (reason) => reason);
  assert.ok(rejected instanceof OnlinePlayerError);
  assert.equal(rejected.message, '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.');

  const broken = await storeWith(() => json({
    detail: { code: 'database-unavailable', message: '데이터베이스에 연결할 수 없어요.' },
  }, 503));
  const { result: failure, warnings } = await captureWarnings(
    () => broken.listRooms().then(() => assert.fail('should reject'), (reason) => reason),
  );
  assert.ok(failure instanceof OnlinePlayerError);
  assert.equal(failure.message, '온라인 연결이 잠시 원활하지 않아요. 잠시 후 다시 시도해 주세요.');
  assert.ok(warnings.some((line) => line.includes('503') && line.includes('데이터베이스에 연결할 수 없어요.')));
});

test('응답 형식 검증 실패는 개발 상세를 지니되 화면에는 고른 말이 간다', async () => {
  const { onlineErrorText } = await import('../js/online/rules.js');
  const store = await storeWith(() => json({ not: 'a list' }));
  const error = await store.listRooms().then(() => assert.fail('should reject'), (reason) => reason);
  // 개발자가 원인을 찾을 수 있게 상세는 오류에 남아 있다
  assert.match(error.message, /서버 방 목록이 올바르지 않습니다/);
  const { result } = await captureWarnings(() => onlineErrorText(error, '잠시 후 다시 시도해 주세요.'));
  assert.equal(result, '잠시 후 다시 시도해 주세요.');
});

/** 주석을 걷어 낸 소스의 문자열 조각. 코드 식별자와 주석은 화면에 나가지 않는다 */
function stringLiterals(code) {
  const withoutComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
  return [...withoutComments.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)]
    // 템플릿 안의 `${…}`는 코드다(`${action.snapshot.name}`). 보이는 글자만 남긴다
    .map(([literal]) => literal.replace(/\$\{[^}]*\}/g, ''));
}

test('화면 코드의 문구에 «서버»·snapshot·API 같은 개발 용어가 없다 (U40)', async () => {
  const uiDir = new URL('../src/ui/', import.meta.url);
  const files = [
    ...(await readdir(uiDir)).filter((name) => name.endsWith('.ts')).map((name) => new URL(name, uiDir)),
    new URL('../src/app.ts', import.meta.url),
  ];
  const offenders = [];
  for (const file of files) {
    for (const literal of stringLiterals(await readFile(file, 'utf8'))) {
      if (/서버|snapshot|\bAPI\b|WebSocket/.test(literal)) offenders.push(`${file.pathname.split('/').pop()}: ${literal}`);
    }
  }
  assert.deepEqual(offenders, []);
});
