import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 브라우저 «뒤로»의 안전망 (U03).
// 화면 상태가 히스토리에 없어, 시스템 「뒤로」나 뒤로 스와이프가 곧바로 앱 밖으로 나가
// 풀던 판과 결과가 통째로 사라졌다. 주소는 바꾸지 않고(해시 라우팅 없음) 히스토리 상태만 쓴다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const { backStepFor, createBackGuard, isGuardState } = await import('../js/ui/back-guard.js');

/** 브라우저의 세션 히스토리를 흉내 낸다. 주소는 다루지 않는다 — 바뀌면 안 되기 때문이다 */
class FakeHistory {
  constructor() {
    this.entries = [null];
    this.index = 0;
    this.urls = [];
  }
  get state() { return this.entries[this.index]; }
  pushState(state, _title, url) {
    this.urls.push(url);
    this.entries = [...this.entries.slice(0, this.index + 1), structuredClone(state)];
    this.index += 1;
  }
  replaceState(state, _title, url) {
    this.urls.push(url);
    this.entries[this.index] = structuredClone(state);
  }
  /** 「뒤로」. popstate 가 받는 state 를 돌려준다. 맨 앞이면 앱 밖으로 나간 것이다 */
  back() {
    if (this.index === 0) return 'left-app';
    this.index -= 1;
    return this.state;
  }
}

test('guard 는 화면을 몇 번 옮겨도 하나뿐이고, 주소는 건드리지 않는다', () => {
  const history = new FakeHistory();
  const guard = createBackGuard(history);

  guard.enter('home');
  assert.equal(history.entries.length, 1, '홈에서는 아무것도 얹지 않는다');

  for (const screen of ['quiz', 'result', 'ranking', 'home', 'characters', 'home', 'online', 'waiting', 'quiz', 'result', 'home']) {
    guard.enter(screen);
  }
  assert.equal(history.entries.length, 2, '페이지를 연 자리와 guard 하나뿐이다');
  assert.equal(isGuardState(history.state), true);
  assert.equal(history.state.screen, 'home', '홈으로 돌아오면 guard 를 홈 표시로 바꿔 둔다');
  assert.ok(history.urls.every((url) => url === undefined), '주소를 넘기지 않는다 — 넘기지 않으면 지금 주소 그대로다');
});

test('다른 코드가 같은 항목에 남긴 상태는 지우지 않고 표시만 더한다', () => {
  const history = new FakeHistory();
  history.entries[0] = { invite: 'ABC234' };
  createBackGuard(history).enter('home');
  assert.deepEqual(history.entries[0], { invite: 'ABC234', qbq: 'base', screen: 'home' });
  assert.equal(isGuardState(history.entries[0]), false);
  assert.equal(isGuardState(null), false);
  assert.equal(isGuardState({ qbq: 'guard', screen: 'quiz' }), true);
});

test('뒤로: 대화상자가 열려 있으면 그것만 닫고, 화면마다 그 화면의 버튼을 탄다', () => {
  const at = (screen, options = {}) => backStepFor(screen, { dialogOpen: false, landedOnGuard: false, ...options });

  for (const screen of ['home', 'quiz', 'result', 'ranking', 'waiting', 'online-quiz']) {
    assert.deepEqual(at(screen, { dialogOpen: true }), { kind: 'close-dialog' }, screen);
  }
  // 로컬 퀴즈는 나가기 확인을 연다 (FR-3.6) — 곧바로 판을 버리지 않는다
  assert.deepEqual(at('quiz'), { kind: 'control', id: 'quiz-exit' });
  // 결과는 「홈으로」를 눌러 자동 저장(FR-6.1)을 거친다
  assert.deepEqual(at('result'), { kind: 'control', id: 'result-home' });
  // 온라인 화면은 제 나가기·홈 버튼의 확인과 정리를 그대로 탄다
  assert.deepEqual(at('online-quiz'), { kind: 'control', id: 'online-quiz-exit' });
  assert.deepEqual(at('online'), { kind: 'control', id: 'online-home' });
  // 대기실의 «뒤로»는 방을 떠나는 것이 아니다 — 「나가기」를 누르지 않는다
  assert.deepEqual(at('waiting'), { kind: 'lobby' });
  assert.notDeepEqual(at('waiting'), { kind: 'control', id: 'waiting-leave' });
  for (const screen of ['ranking', 'characters']) {
    assert.deepEqual(at(screen), { kind: 'home' }, screen);
  }
  // 온라인 결과는 「홈으로」를 누른다 (FR-7.13 3단계) — 친구와 푼 판은 예전처럼 홈으로 가고(방에는 남는다),
  // 혼자 푼 판은 그 버튼이 혼자 방을 나가 지운다. «뒤로»가 혼자 방을 남겨 두지 않는다
  assert.deepEqual(at('online-result'), { kind: 'control', id: 'online-final-home' });
  // 홈에서 base 에 닿았으면 앱을 나가려던 것이고, 앞으로 가기로 guard 에 닿았으면 그대로 둔다
  assert.deepEqual(at('home'), { kind: 'leave' });
  assert.deepEqual(at('home', { landedOnGuard: true }), { kind: 'stay' });
});

test('한 판을 마치고 홈에 와도 「뒤로」 한 번이면 앱을 나간다 — 들른 화면 수만큼 누르지 않는다', () => {
  const history = new FakeHistory();
  const guard = createBackGuard(history);
  for (const screen of ['home', 'quiz', 'result', 'ranking', 'home']) guard.enter(screen);

  // 홈의 guard → base 로 내려온다. 앱은 거기서 한 번 더 뒤로 보내 준다 (leave)
  const landed = history.back();
  assert.deepEqual(backStepFor('home', { dialogOpen: false, landedOnGuard: isGuardState(landed) }), { kind: 'leave' });
  assert.equal(history.back(), 'left-app');
});

test('퀴즈에서 「뒤로」는 guard 를 다시 얹어, 확인을 무르거나 또 눌러도 앱 밖으로 나가지 않는다', () => {
  const history = new FakeHistory();
  const guard = createBackGuard(history);
  guard.enter('home');
  guard.enter('quiz');

  const landed = history.back();
  assert.equal(isGuardState(landed), false);
  guard.rearm('quiz');
  assert.equal(history.entries.length, 2);
  assert.equal(isGuardState(history.state), true, '나가기 확인이 열린 동안에도 퀴즈를 지킨다');
});

// ── app.ts 배선 ───────────────────────────────────────────────────

test('app: 화면을 옮길 때마다 guard 를 알리고, 새로고침 확인은 로컬 판에서만 켠다', async () => {
  const app = await source('src/app.ts');
  const goTo = app.slice(app.indexOf('  function goTo(name: ScreenName): void {'), app.indexOf('  // ── 뒤로 가기'));
  assert.match(goTo, /showScreen\(name\);\s*currentScreen = name;[\s\S]*?backGuard\.enter\(name\);[\s\S]*?setUnloadWarning\(name === 'quiz'\);/);
  assert.equal((app.match(/addEventListener\('popstate'/g) ?? []).length, 1, 'popstate 리스너는 하나뿐이다');
  assert.match(app, /window\.addEventListener\('pagehide', \(\) => \{\s*if \(currentScreen === 'result'\) resultScreen\.flush\(\);/);
  // 대기실의 «뒤로»는 로비로 갈 뿐 방을 떠나지 않는다 (CLAUDE.md: 방을 떠나는 길은 「나가기」뿐)
  assert.match(app, /case 'lobby':\s*void openOnline\(\);/);
  // 다른 화면으로 옮기는 중에 또 「뒤로」를 눌러도 앱 밖으로 나가지 않도록 먼저 다시 얹는다
  assert.match(app, /if \(currentScreen !== 'home'\) backGuard\.rearm\(currentScreen\);\s*switch \(step\.kind\)/);
});

test('주소·해시·다른 브라우저 저장소를 쓰지 않는다 — 새로고침하면 홈이라는 계약은 그대로다', async () => {
  const [app, guard, screens] = await Promise.all([
    source('src/app.ts'),
    source('src/ui/back-guard.ts'),
    source('src/ui/screens.ts'),
  ]);
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code(app), /sessionStorage|hashchange/);
  assert.doesNotMatch(code(guard), /sessionStorage|location\.hash|hashchange/);
  // guard 는 pushState·replaceState 에 주소(세 번째 인자)를 넘기지 않는다 — 두 번째 인자 '' 로 끝난다
  const calls = [...code(guard).matchAll(/\.(?:pushState|replaceState)\((?:[^()]|\([^()]*\))*\)/g)].map((match) => match[0]);
  assert.ok(calls.length >= 3, '검사할 호출을 실제로 찾았다');
  for (const call of calls) assert.match(call, /, ''\)$/, call);
  assert.match(screens, /해시 라우팅을 쓰지 않으므로 새로고침하면 항상 홈에서 시작한다/);
});

test('뒤로가 누르는 버튼은 index.html 에 실제로 있다', async () => {
  const html = await source('index.html');
  for (const screen of ['quiz', 'result', 'online-quiz', 'online']) {
    const step = backStepFor(screen, { dialogOpen: false, landedOnGuard: false });
    assert.equal(step.kind, 'control');
    assert.match(html, new RegExp(`id="${step.id}"`), `${screen} → #${step.id}`);
  }
});
