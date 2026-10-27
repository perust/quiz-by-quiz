import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 온라인도 혼자 하기와 같은 답 규칙이다 (U13) — 시간이 끝나면 캐릭터가 서 있는 칸이 답이다. 서버 권위는
// 그대로다: 화면은 실제로 움직인 뒤 선 칸을 «초안»으로 방 소켓에 알리고(잠깐 멈췄다, 멈춰 서면 곧바로),
// 칸에서 내려서면 지운다. 서버는 마감이 빈 답을 채울 때만 그 칸을 답으로 남긴다. 이 규칙을 모르는 이전
// API(snapshot에 `standingAnswers`가 없다, ws-ticket에 capability가 없다)에는 초안을 한 글자도 보내지 않고
// 예전 말(«선택을 눌러야 제출»)을 그대로 한다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const MATCH_ID = '12345678-1234-5678-9234-567812345678';

function running(changes = {}) {
  return {
    matchId: MATCH_ID, state: 'running', categoryId: 'history', gameMode: true,
    currentPosition: 3, totalQuestions: 10, deadlineAt: '2026-10-27T11:00:20+00:00', remainingMs: 15_000,
    questionTimeMs: 20_000,
    question: {
      id: 'history-003', categoryId: 'history', question: '문제',
      choices: ['가', '나', '다', '라'], position: 3, total: 10,
    },
    ownSubmission: null, reveal: null, scores: [],
    ...changes,
  };
}

// ── 감지: 이전 API와 새 API의 snapshot ───────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

const identity = {
  id: 'a2345678-1234-5678-9234-567812345678',
  secret: 'browser-session-secret-with-thirty-two-chars',
};

class FakeWebSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) listener({});
  }
  send(value) { this.sent.push(value); }
  emit(type, event = {}) {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function storeWith({ match, ticket }) {
  const { createNetworkRoomStore } = await import('../js/online/network-rooms.js');
  return createNetworkRoomStore({
    baseUrl: 'https://quiz-api.example.test',
    storage: memoryStorage(),
    newIdentity: () => identity,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/session')) return json({ playerId: identity.id });
      if (url.endsWith('/match')) return json(match);
      if (url.endsWith('/ws-ticket')) return json(ticket, 201);
      if (url.endsWith('/v1/rooms/ABC234')) return json({});
      throw new Error(`unexpected request: ${url}`);
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols),
  });
}

test('매치 snapshot: standingAnswers가 true일 때만 새 규칙이다 — 없거나 다른 값이면 이전 API', async () => {
  for (const [value, expected] of [[true, true], [undefined, undefined], ['true', undefined], [false, undefined]]) {
    const snapshot = running(value === undefined ? {} : { standingAnswers: value });
    const store = await storeWith({ match: snapshot, ticket: { ticket: 'x' } });
    const parsed = await store.getMatch('ABC234');
    assert.equal(parsed.standingAnswers, expected, String(value));
  }
});

test('초안은 ws-ticket이 capability를 준 소켓에만 보낸다 — 이전 API의 소켓에는 한 글자도 보내지 않는다', async () => {
  const draft = { code: 'ABC234', matchId: MATCH_ID, position: 3, choiceIndex: 2 };

  FakeWebSocket.instances.length = 0;
  const legacy = await storeWith({
    match: running(),
    ticket: { ticket: 'legacy-ticket', movementViewport: 'sender-css-pixels-v1' },
  });
  const stopLegacy = legacy.subscribe('ABC234', () => undefined);
  await waitFor(() => FakeWebSocket.instances.length === 1, 'legacy socket was not created');
  const legacySocket = FakeWebSocket.instances[0];
  legacySocket.emit('open');
  assert.equal(legacy.sendStandingAnswer(draft), false);
  assert.equal(legacySocket.sent.some((text) => text.includes('standing-answer')), false);
  stopLegacy();

  FakeWebSocket.instances.length = 0;
  const fresh = await storeWith({
    match: running({ standingAnswers: true }),
    ticket: { ticket: 'fresh-ticket', standingAnswer: 'standing-answer-v1' },
  });
  const stop = fresh.subscribe('ABC234', () => undefined);
  try {
    await waitFor(() => FakeWebSocket.instances.length === 1, 'socket was not created');
    const socket = FakeWebSocket.instances[0];
    // 소켓이 열리기 전에는 보내지 못한다(기억만 한다)
    assert.equal(fresh.sendStandingAnswer(draft), false);
    socket.emit('open');
    // 열리면 칸 위에 서 있던 마지막 초안을 다시 알린다 — API를 다시 띄웠으면 메모리의 초안이 사라졌다
    const resent = socket.sent.map((text) => JSON.parse(text)).filter((value) => value.type === 'standing-answer');
    assert.deepEqual(resent, [{ type: 'standing-answer', matchId: MATCH_ID, position: 3, choiceIndex: 2 }]);

    assert.equal(fresh.sendStandingAnswer({ ...draft, choiceIndex: null }), true, '칸에서 내려서면 지운다');
    assert.deepEqual(JSON.parse(socket.sent.at(-1)), {
      type: 'standing-answer', matchId: MATCH_ID, position: 3, choiceIndex: null,
    });
    for (const bad of [
      { ...draft, choiceIndex: 4 },
      { ...draft, choiceIndex: 1.5 },
      { ...draft, position: 0 },
      { ...draft, position: 26 },
      { ...draft, matchId: 'not-a-uuid' },
      { ...draft, code: 'ZZ' },
    ]) {
      assert.equal(fresh.sendStandingAnswer(bad), false, JSON.stringify(bad));
    }
    assert.equal(fresh.sendStandingAnswer({ ...draft, code: 'XYZ789' }), false, '구독하지 않은 방');

    // 끊긴 사이에 칸에서 내려섰다. 다시 붙으면 마지막 초안(지우기)을 다시 보내 서버에 남은 앞 칸을 지운다
    socket.close();
    await waitFor(() => FakeWebSocket.instances.length === 2, 'socket did not reconnect');
    const reconnected = FakeWebSocket.instances[1];
    reconnected.emit('open');
    const again = reconnected.sent.map((text) => JSON.parse(text)).filter((value) => value.type === 'standing-answer');
    assert.deepEqual(again, [{ type: 'standing-answer', matchId: MATCH_ID, position: 3, choiceIndex: null }]);
  } finally {
    stop();
  }
});

// ── 무엇을 언제 보내나 ───────────────────────────────────────────

test('초안을 쓰는 때: 새 규칙의 판이 돌고, 아직 답을 내지 않았고, 내는 중도 아닐 때뿐이다', async () => {
  const { onlineStandingDraft } = await import('../js/online/standing-answer.js');
  const fresh = running({ standingAnswers: true });

  assert.deepEqual(onlineStandingDraft(fresh, 1, false), { matchId: MATCH_ID, position: 3, choiceIndex: 1 });
  assert.deepEqual(onlineStandingDraft(fresh, null, false), { matchId: MATCH_ID, position: 3, choiceIndex: null });
  assert.equal(onlineStandingDraft(running(), 1, false), null, '이전 API의 판');
  assert.equal(onlineStandingDraft(null, 1, false), null);
  assert.equal(onlineStandingDraft(fresh, 1, true), null, '답을 내는 중');
  assert.equal(
    onlineStandingDraft({ ...fresh, ownSubmission: { position: 3, choiceIndex: 0, timedOut: false } }, 1, false),
    null,
    '이미 낸 답이 이긴다',
  );
  assert.equal(
    onlineStandingDraft({ ...fresh, state: 'revealing', reveal: null, scores: [] }, 1, false),
    null,
    '공개 중',
  );
});

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delayMs) {
      const handle = next++;
      pending.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimeout(handle) { pending.delete(handle); },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        pending.delete(handle);
        timer.callback();
      }
    },
    get size() { return pending.size; },
  };
}

test('스쳐 지나간 칸은 보내지 않고, 멈춰 서면 곧바로, 같은 말은 되풀이하지 않는다', async () => {
  const { createStandingAnswerPublisher, STANDING_ANSWER_SETTLE_MS } = await import('../js/online/standing-answer.js');
  const timers = fakeTimers();
  const sent = [];
  const publisher = createStandingAnswerPublisher({ send: (draft) => sent.push(draft), timers });
  const at = (choiceIndex, position = 3) => ({ matchId: MATCH_ID, position, choiceIndex });

  // 아무 칸에도 선 적 없는 문항의 «내려섰다»는 보낼 것이 없다
  publisher.update(at(null));
  timers.advance(1_000);
  assert.deepEqual(sent, []);

  // 1번 칸을 스쳐 2번 칸에 머문다
  publisher.update(at(0));
  timers.advance(STANDING_ANSWER_SETTLE_MS - 1);
  publisher.update(at(1));
  timers.advance(STANDING_ANSWER_SETTLE_MS);
  assert.deepEqual(sent, [at(1)]);

  // 같은 칸이면 다시 보내지 않는다. 잠깐 내려섰다 돌아와도 마찬가지다
  publisher.update(at(1));
  publisher.update(at(null));
  publisher.update(at(1));
  timers.advance(1_000);
  assert.deepEqual(sent, [at(1)]);

  // 멈춰 서면 기다리지 않는다 — 마감 직전에 선 칸도 늦지 않게
  publisher.update(at(3));
  publisher.flush();
  assert.deepEqual(sent, [at(1), at(3)]);
  publisher.update(at(null));
  timers.advance(STANDING_ANSWER_SETTLE_MS);
  assert.deepEqual(sent, [at(1), at(3), at(null)], '칸에서 내려서면 지운다');

  // 초안을 쓰지 않는 때(답을 냈다·공개)면 기다리던 것도 버린다
  publisher.update(at(2));
  publisher.update(null);
  timers.advance(1_000);
  assert.equal(sent.length, 3);

  // 새 문항은 처음부터 센다 — 지난 문항에 보낸 칸과 같아도 보낸다
  publisher.update(at(1, 4));
  publisher.flush();
  assert.deepEqual(sent.at(-1), at(1, 4));
  publisher.reset();
  publisher.update(at(1, 4));
  publisher.flush();
  assert.deepEqual(sent.at(-1), at(1, 4));
  assert.equal(sent.length, 5);
  assert.equal(timers.size, 0);
});

// ── 화면: 판마다 말이 다르고, 실제로 움직인 뒤에만 보낸다 ──────────

test('상태 줄은 판의 규칙을 말한다 — 새 규칙이면 «시간이 끝나면 서 있는 칸», 이전 API면 예전 말', async () => {
  const { onlineQuizView, ONLINE_STANDING_STATUS } = await import('../js/ui/online-quiz.js');
  assert.equal(onlineQuizView(running({ standingAnswers: true })).status, ONLINE_STANDING_STATUS);
  assert.equal(ONLINE_STANDING_STATUS, '보기를 누르면 바로 제출돼요. 시간이 끝나면 서 있는 칸이 답이에요.');
  assert.equal(onlineQuizView(running()).status, '칸 위에서 선택을 누르거나 보기를 눌러야 제출돼요.');
  assert.equal(
    onlineQuizView(running({ standingAnswers: true, ownSubmission: { position: 3, choiceIndex: 1, timedOut: false } })).status,
    '제출 완료! 다른 친구를 기다리는 중이에요.',
  );
});

test('공개는 발밑 칸의 답을 고른 답과 똑같이 보인다 — 시간 초과가 아니라 «내 답»이다', async () => {
  const { onlineQuizView, onlineRevealAnswerText, onlineRevealSound } = await import('../js/ui/online-quiz.js');
  // 서버는 마감에 그 칸을 보통 답으로 남긴다(timedOut false, 정답이면 correct)
  const revealing = running({
    standingAnswers: true,
    state: 'revealing',
    reveal: { position: 3, choiceIndex: 2, timedOut: false, correct: false, answerIndex: 0, explanation: '해설' },
    scores: [],
  });
  const view = onlineQuizView(revealing);
  assert.equal(view.reveal.chosenChoiceIndex, 2);
  assert.equal(view.selectedChoiceIndex, 2);
  assert.deepEqual(onlineRevealAnswerText(revealing.question.choices, view.reveal), {
    correct: '1번 · 가',
    mine: '3번 · 다',
  });
  assert.equal(onlineRevealSound(view.reveal), 'wrong', '시간 초과 소리가 아니다');
});

test('arena는 실제로 움직인 뒤의 발밑 칸이 바뀔 때마다 알리고, 새 문항·끄기·선택 닫기에 다시 맞춘다', async () => {
  const arena = await source('src/ui/arena.ts');
  assert.match(arena, /function currentStanding\(\): number \| null \{\s*return enabled && movedSinceReset \? indexOfNode\(walker\.standingElement\(\)\) : null;/);
  assert.match(arena, /if \(next === reportedStanding\) return;\s*reportedStanding = next;\s*onStandingChange\?\.\(next\);/);
  // 첫 이동·발밑이 바뀔 때·새 문항·끄기·선택 닫기
  assert.match(arena, /markArenaTarget\(getChoiceNodes\(\), tileIndexOf\(standing\)\);\s*reportStanding\(\);/);
  assert.match(arena, /markArenaTarget\(getChoiceNodes\(\), movedSinceReset \? tileIndexOf\(node\) : null\);\s*reportStanding\(\);/);
  assert.match(arena, /reset\(choiceCount\) \{\s*movedSinceReset = false;\s*buildTiles\(choiceCount\);[\s\S]*?reportStanding\(\);/);
  assert.match(arena, /setSelectionEnabled\(value\) \{\s*setTileSelectionEnabled\(value\);\s*reportStanding\(\);/);
});

class FakeClassList {
  #names = new Set();
  add(...names) { names.forEach((name) => this.#names.add(name)); }
  remove(...names) { names.forEach((name) => this.#names.delete(name)); }
  toggle(name, force) {
    const on = force ?? !this.#names.has(name);
    if (on) this.#names.add(name);
    else this.#names.delete(name);
    return on;
  }
  contains(name) { return this.#names.has(name); }
}

class FakeElement extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.parentElement = null;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get childElementCount() { return this.children.filter((child) => child instanceof FakeElement).length; }
  matches(selector) {
    return selector.startsWith('.') && `${this.className}`.split(/\s+/).includes(selector.slice(1));
  }
  querySelectorAll(selector) {
    return this.children
      .filter((child) => child instanceof FakeElement)
      .flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView() {}
}

test('온라인 퀴즈 화면: 새 규칙의 판에서만, 움직인 뒤 선 칸을 초안으로 보내고 조작법·무대 안내를 바꾼다', async () => {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const screen = new FakeElement('section');
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLLIElement = FakeElement;
  globalThis.HTMLButtonElement = FakeElement;
  globalThis.window = {
    innerWidth: 390, innerHeight: 844, scrollY: 0,
    addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setInterval: () => 1, clearInterval() {},
    setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false }),
  };
  globalThis.document = {
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    activeElement: null,
    getElementById: (id) => byId(id),
    querySelector: (selector) => (selector === '[data-screen="online-quiz"]' ? screen : null),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createElement: (tag) => new FakeElement(tag),
    elementFromPoint: () => null,
  };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};

  const { createOnlineQuizScreen } = await import('../js/ui/online-quiz.js');
  let arenaDeps = null;
  let standing = null;
  const fakeArena = new Proxy({}, {
    get: (_, name) => (name === 'standingIndex' ? () => standing : () => undefined),
  });
  const drafts = [];
  const quiz = createOnlineQuizScreen({
    onSubmit: async () => {},
    onMovement: () => {},
    onStandingAnswer: (draft) => drafts.push(draft),
    onSendChat: async () => ({ ok: true }),
    onExit: () => {},
    onFinished: () => {},
    getPlayerId: () => identity.id,
    createCharacterArena: (deps) => { arenaDeps = deps; return fakeArena; },
    trapFocus: () => {},
  });
  /** arena가 실제 이동 뒤의 발밑 칸을 알리고 캐릭터가 멈춰 선다 */
  const standOn = (index) => {
    standing = index;
    arenaDeps.onStandingChange(index);
    arenaDeps.onMove({ x: 10, y: 10 }, false);
  };

  quiz.startPresence();
  // 이전 API의 판: 예전 조작법 문단을 보이고, 무대 안내의 규칙 줄은 숨기며, 초안을 보내지 않는다
  quiz.render(running());
  assert.equal(byId('online-help-rule-submit').hidden, false);
  assert.equal(byId('online-help-rule-standing').hidden, true);
  assert.equal(byId('online-arena-hint-rule').hidden, true);
  standOn(2);
  assert.deepEqual(drafts, []);

  // 새 규칙의 판: 다음 문항부터 같은 규칙을 말하고, 선 칸을 보낸다
  standing = null;
  const fresh = running({ standingAnswers: true, currentPosition: 4, question: { ...running().question, position: 4 } });
  quiz.render(fresh);
  assert.equal(byId('online-help-rule-submit').hidden, true);
  assert.equal(byId('online-help-rule-standing').hidden, false);
  assert.equal(byId('online-arena-hint-rule').hidden, false);
  assert.deepEqual(drafts, [], '움직이기 전에는 아무것도 보내지 않는다');
  standOn(1);
  assert.deepEqual(drafts, [{ matchId: MATCH_ID, position: 4, choiceIndex: 1 }]);
  standOn(null);
  assert.deepEqual(drafts.at(-1), { matchId: MATCH_ID, position: 4, choiceIndex: null }, '칸에서 내려서면 지운다');

  // 답을 냈으면 초안은 끝이다
  standOn(3);
  const count = drafts.length;
  quiz.render({ ...fresh, ownSubmission: { position: 4, choiceIndex: 3, timedOut: false } });
  standOn(0);
  assert.equal(drafts.length, count, '낸 뒤에는 보내지 않는다');

  // 화면을 떠나면(presence를 닫으면) 보내지 않는다
  quiz.render(running({ standingAnswers: true, currentPosition: 5, question: { ...running().question, position: 5 } }));
  quiz.stopPresence();
  arenaDeps.onStandingChange(2);
  arenaDeps.onMove({ x: 10, y: 10 }, false);
  assert.equal(drafts.length, count);
});

test('app은 초안을 지금 매치의 방으로만 넘기고, 조작법·「게임 방법」이 같은 규칙을 말한다', async () => {
  const [app, html] = await Promise.all([source('src/app.ts'), source('index.html')]);
  assert.match(
    app,
    /onStandingAnswer: \(draft\) => \{\s*const code = onlineMatchRoomCode;\s*if \(!code \|\| !ownsOnlineMatchNavigation\(\)\) return;\s*roomStore\.sendStandingAnswer\(\{ code, \.\.\.draft \}\);/,
  );
  const help = html.slice(html.indexOf('id="online-help-dialog"'), html.indexOf('id="online-help-close"'));
  const standingText = help.slice(help.indexOf('id="online-help-rule-standing"'), help.indexOf('id="online-help-rule-submit"'))
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.match(help, /<span id="online-help-rule-standing" hidden>/);
  assert.match(help, /<span id="online-help-rule-submit">/);
  assert.match(standingText, /시간이 다 되면 그때 밟고 있는 칸이 답이 돼요\./);
  assert.match(standingText, /십자 틈에 서 있으면 아무것도 고르지 않은 것이라 시간 초과가 돼요\./);
  assert.doesNotMatch(help.replace(/<!--[\s\S]*?-->/g, ''), /서버/);
});
