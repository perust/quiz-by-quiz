import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { MOBILE, loadStyles, node, valueOf } from './css-cascade.mjs';

// 부팅·로딩 화면 (U05).
// 예전에는 느린 망에서도 3초 고정 타이머가 «file:// · python3 -m http.server» 개발자 안내를 띄웠고,
// 문제를 받는 동안 빈 dock과 눌러도 아무 일 없는 버튼이 보였다. 치명 오류는 «data 폴더의 JSON»을
// 말하고 다시 시도할 길이 없었다. 잠그는 것:
//   · 개발자 안내는 file:// 일 때만. http(s)는 3초에 «네트워크가 느려요»+새로고침, 15초에야 실패 안내
//   · 앱은 문제를 받은 뒤에 보인다(markBooted 가 loadQuestionBanks 뒤)
//   · 치명 오류는 플레이어의 말 + 다시 시도, 문제 JSON 하나는 10초에 끊는다

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const html = await source('index.html');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

/** head 의 인라인 부팅 스크립트. 모듈이 아니라 어떤 환경에서도 도는 일반 스크립트다 */
const bootScript = (() => {
  const head = html.slice(0, html.indexOf('</head>'));
  const match = head.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'head 에 인라인 부팅 스크립트가 있다');
  return match[1];
})();

class FakeClassList {
  names = new Set();
  add(...names) { names.forEach((name) => this.names.add(name)); }
  remove(...names) { names.forEach((name) => this.names.delete(name)); }
  contains(name) { return this.names.has(name); }
}

/** 부팅 스크립트를 가짜 브라우저 위에서 돌린다. 타이머는 손으로 돌린다 */
function boot(protocol) {
  const timers = new Map();
  let nextId = 0;
  let clock = 0;
  const listeners = [];
  const reloads = [];
  const body = { classList: new FakeClassList() };
  const sandbox = {
    location: { protocol, reload: () => reloads.push(clock) },
    document: {
      body,
      addEventListener: (type, listener) => listeners.push({ type, listener }),
    },
    setTimeout: (callback, ms) => {
      nextId += 1;
      timers.set(nextId, { callback, at: clock + ms });
      return nextId;
    },
    clearTimeout: (id) => { timers.delete(id); },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(bootScript, sandbox);

  /** 시계를 ms 만큼 돌려 때가 된 타이머를 부른다 */
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      clock = timer.at;
      timer.callback();
    }
    clock = until;
  }

  return {
    classes: body.classList,
    advance,
    /** app.ts 의 markBooted() 가 하는 일 — 담긴 타이머 하나를 끈다 */
    markBooted: () => sandbox.clearTimeout(sandbox.__bootTimer),
    pending: () => timers.size,
    click: (target) => listeners.filter(({ type }) => type === 'click').forEach(({ listener }) => listener({ target })),
    reloads,
  };
}

test('부팅: http(s)는 3초에 «느려요» 안내, 15초가 되어서야 실패 안내 — 개발자 안내는 띄우지 않는다', () => {
  for (const protocol of ['https:', 'http:']) {
    const page = boot(protocol);
    page.advance(2_999);
    assert.equal(page.classes.contains('is-boot-slow'), false, '3초 전에는 «불러오는 중…»만');
    page.advance(1);
    assert.equal(page.classes.contains('is-boot-slow'), true, `${protocol} 3초: 네트워크가 느려요`);
    assert.equal(page.classes.contains('is-boot-failed'), false, '3초에 실패라고 하지 않는다');
    page.advance(11_999);
    assert.equal(page.classes.contains('is-boot-failed'), false, '15초 전에는 실패 안내가 없다');
    page.advance(1);
    assert.equal(page.classes.contains('is-boot-failed'), true, '15초: 실패 안내');
    assert.equal(page.classes.contains('is-boot-slow'), false, '느려요 안내는 실패 안내로 바뀐다');
    assert.equal(page.classes.contains('is-boot-file'), false, 'http(s) 에서는 file:// 개발자 안내가 아니다');
  }
});

test('부팅: file:// 로 열었을 때만 3초에 개발자 안내(로컬 서버)를 띄운다', () => {
  const page = boot('file:');
  page.advance(3_000);
  assert.equal(page.classes.contains('is-boot-failed'), true);
  assert.equal(page.classes.contains('is-boot-file'), true);
  assert.equal(page.classes.contains('is-boot-slow'), false, '파일로 연 것은 느린 것이 아니라 막힌 것이다');
  assert.equal(page.pending(), 0, '더 기다릴 것이 없다');
});

test('부팅: markBooted 의 clearTimeout 하나로 3초 전에도, «느려요»가 뜬 뒤에도 남은 타이머가 꺼진다', () => {
  const early = boot('https:');
  early.advance(1_000);
  early.markBooted();
  early.advance(60_000);
  assert.equal(early.classes.contains('is-boot-slow'), false);
  assert.equal(early.classes.contains('is-boot-failed'), false);

  const late = boot('https:');
  late.advance(5_000);
  assert.equal(late.classes.contains('is-boot-slow'), true);
  late.markBooted();
  late.advance(60_000);
  assert.equal(late.classes.contains('is-boot-failed'), false, '두 번째 타이머도 같은 __bootTimer 에 담겨 함께 꺼진다');
});

test('부팅: 「새로고침」·「다시 시도」는 모듈이 뜨지 않아도 인라인 스크립트가 받아 새로 읽는다', () => {
  const page = boot('https:');
  const button = { closest: (selector) => (selector === '[data-boot-reload]' ? button : null) };
  page.click(button);
  assert.equal(page.reloads.length, 1);
  page.click({ closest: () => null });
  assert.equal(page.reloads.length, 1, '다른 곳을 누르면 아무 일도 없다');
});

test('부팅 마크업: «python3»·file:// 는 개발자 카드에만 있고, 느려요·실패 카드는 플레이어의 말과 새로 읽기를 갖는다', () => {
  // 주석은 화면에 보이지 않는다. 보이는 마크업만 본다
  const bootArea = html.slice(html.indexOf('<div class="boot" id="boot">'), html.indexOf('<main class="app">'))
    .replace(/<!--[\s\S]*?-->/g, '');
  const fileCard = bootArea.slice(bootArea.indexOf('boot__error--file'));
  const rest = bootArea.slice(0, bootArea.indexOf('boot__error--file'));
  assert.match(fileCard, /python3 -m http\.server 8765/);
  assert.doesNotMatch(rest, /python3|http\.server|file:\/\/|data 폴더|JSON/, '플레이어가 보는 카드에는 개발 용어가 없다');

  assert.match(bootArea, /<div class="boot__slow" role="status">\s*<p class="boot__body">불러오는 중… 네트워크가 느려요<\/p>\s*<button type="button" class="button button--ghost" data-boot-reload>새로고침<\/button>/);
  assert.match(bootArea, /<div class="boot__error boot__error--net" role="alert">\s*<h1 class="boot__title" id="boot-error-title">게임을 불러오지 못했어요<\/h1>\s*<p class="boot__body" id="boot-error-body">연결을 확인하고 다시 시도해 주세요\.<\/p>\s*<button type="button" class="button button--primary" data-boot-reload>다시 시도<\/button>/);
  assert.match(bootScript, /location\.protocol === 'file:'/);
});

test('부팅 화면: 클래스마다 한 장면만 보인다 (불러오는 중 → 느려요 → 실패 / file:// 개발자 안내)', () => {
  const scene = (classes) => {
    const body = node(`body${classes.map((name) => `.${name}`).join('')}`);
    const area = node('div.boot#boot', body);
    const shown = (descriptor) => valueOf(rules, node(descriptor, area), 'display', MOBILE) !== 'none';
    return {
      loading: shown('p.boot__loading'),
      slow: shown('div.boot__slow'),
      net: shown('div.boot__error.boot__error--net'),
      file: shown('div.boot__error.boot__error--file'),
    };
  };
  assert.deepEqual(scene([]), { loading: true, slow: false, net: false, file: false });
  assert.deepEqual(scene(['is-boot-slow']), { loading: false, slow: true, net: false, file: false });
  assert.deepEqual(scene(['is-boot-failed']), { loading: false, slow: false, net: true, file: false });
  assert.deepEqual(scene(['is-boot-failed', 'is-boot-file']), { loading: false, slow: false, net: false, file: true });
  // 앱이 뜨면 부팅 영역째 숨는다
  assert.equal(valueOf(rules, node('div.boot#boot', node('body.is-booted.is-boot-slow')), 'display', MOBILE), 'none');
});

test('app: 문제를 받은 뒤에 앱을 보이고, 치명 오류는 플레이어의 말로 다시 시도를 권한다', async () => {
  const app = await source('src/app.ts');
  const main = app.slice(app.indexOf('async function main(): Promise<void>'));
  const load = main.indexOf('await loadQuestionBanks()');
  const booted = main.lastIndexOf('markBooted();');
  assert.ok(load !== -1 && booted !== -1 && load < booted, '빈 dock 이 보이지 않게 문제를 받은 뒤 markBooted 를 부른다');
  assert.ok(booted < main.lastIndexOf('await goHome();'), '홈을 그리기 직전이다 — 보인 뒤에 그려야 홈 워커가 시작 자리를 잰다');
  assert.ok(main.indexOf("showFatalError('문제를 불러오지 못했어요'") < booted, '문제를 하나도 못 받으면 앱을 보이지 않는다');

  const fatal = app.slice(app.indexOf('function showFatalError('), app.indexOf('function takeInviteCode('));
  assert.match(fatal, /body\.remove\('is-booted', 'is-boot-slow', 'is-boot-file'\)/, '개발자 안내·느려요 안내를 걷고 실패 카드만');
  assert.match(fatal, /body\.add\('is-boot-failed'\);[\s\S]*?heading\.textContent = title;[\s\S]*?reason\.textContent = message;/, '먼저 펼치고 넣는다');
  for (const call of app.matchAll(/showFatalError\(([^;]*)\);/g)) {
    if (call[1].startsWith('title')) continue; // 선언부
    assert.doesNotMatch(call[1], /data|JSON|폴더|message|\$\{/, `개발 상세는 콘솔에만 남긴다: ${call[1]}`);
  }
  assert.match(app, /main\(\)\.catch\(\(error: unknown\) => \{[\s\S]*?console\.error\('\[앱 시작 실패\]', error\);\s*showFatalError\('게임을 시작하지 못했어요', '잠시 뒤 다시 시도해 주세요\.'\);/);

  const markBooted = app.slice(app.indexOf('function markBooted(): void'), app.indexOf('function showFatalError('));
  assert.match(markBooted, /clearTimeout\(window\.__bootTimer\);[\s\S]*?remove\('is-boot-slow'\)[\s\S]*?add\('is-booted'\)/);
});

// ── 문제 JSON 기다리기 한도 ──────────────────────────────────────────

test('문제 JSON 하나는 10초에 끊고 그 분야를 실패로 둔다 — 영영 «불러오는 중…»에 멈추지 않는다', async () => {
  const { BANK_FETCH_TIMEOUT_MS } = await import('../js/constants.js');
  assert.equal(BANK_FETCH_TIMEOUT_MS, 10_000);

  const signals = [];
  const realFetch = globalThis.fetch;
  const realError = console.error;
  console.error = () => {};
  // 응답이 오지 않는 망. 끊으라는 신호가 오면 브라우저처럼 AbortError 로 거절한다
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    signals.push(options?.signal);
    options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { loadQuestionBanks } = await import('../js/data/loader.js');
    let settled = null;
    const loading = loadQuestionBanks().then((result) => { settled = result; });
    await Promise.resolve();
    assert.equal(signals.length, 5, '다섯 분야를 함께 요청하고 저마다 끊을 신호를 단다');
    assert.ok(signals.every((signal) => signal instanceof AbortSignal));

    mock.timers.tick(9_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, null, '10초 전에는 기다린다');

    mock.timers.tick(1);
    await loading;
    assert.equal(settled.failedCategories.length, 5);
    assert.ok(settled.failedCategories.every(({ message }) => message === '10초 안에 받지 못했습니다'), '무엇을 기다렸는지 남긴다');
    assert.ok(Object.values(settled.banks).every((bank) => bank.length === 0));
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});
