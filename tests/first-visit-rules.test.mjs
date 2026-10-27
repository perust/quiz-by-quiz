import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, loadStyles, node, valueOf } from './css-cascade.mjs';

// 한 판의 규칙을 말하는 글과 처음 세 판의 규칙 줄 (U01·U04).
// 숫자는 상수에서만 온다 — 은행 크기를 말하지 않는다(#94). 무대 아래 한 줄은 조작이 아니라
// «무엇이 답이 되는가»를 말하고, 처음 세 판은 짧은 touch·좁은 화면에서도 접지 않는다.
// 세는 값은 preferences(safe-storage)를 거친다 — localStorage 를 직접 만지지 않는다.

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
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

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const constants = await import('../js/constants.js');
const roundRules = await import('../js/ui/round-rules.js');
const { createLocalPreferences } = await import('../js/storage/local-store.js');

test('한 판의 글은 상수에서 온다: 분야 10문제 · 전체 도전 25문제 · 정답당 10점', () => {
  assert.equal(roundRules.ALL_ROUND_QUESTIONS, constants.QUESTIONS_PER_CATEGORY_IN_ALL * constants.CATEGORIES.length);
  assert.equal(roundRules.categoryDockCaption(), `분야 골라 ${constants.QUESTIONS_PER_ROUND}문제`);
  assert.equal(roundRules.categoryDockCaption(), '분야 골라 10문제');
  assert.equal(roundRules.allRoundLength(), '25문제');
  assert.equal(roundRules.allRoundLength(23), '23문제', '은행이 모자라면 실제로 나갈 수만큼');
  assert.equal(roundRules.roundLengthRule(), '분야 10문제 · 전체 도전 25문제');
  assert.equal(roundRules.scoreRule(), '정답당 10점 · 빨리 답해도 점수는 같아요', '속도 점수가 없다는 것을 시작 전에 말한다 (PRD 2.1)');
  assert.equal(roundRules.timeRule(20_000), '문항당 20초 · 설정에서 바꿀 수 있어요');
  assert.equal(roundRules.timeRule(40_000), '문항당 40초 · 설정에서 바꿀 수 있어요');
  assert.equal(roundRules.timeRule(null), '시간 제한 없음 · 설정에서 바꿀 수 있어요');
  assert.equal(roundRules.RECORD_RULE, '이 브라우저에만 저장돼요');
});

test('「게임 방법」의 온라인 한 줄: 서 있기만 해서는 제출되지 않고 문항 시간은 방장이 고른다 (local-ux-1)', () => {
  // 위 줄들(«시간이 끝나면 선 칸이 답»·«설정에서 바꿀 수 있어요»·«이 브라우저에만»)은 혼자 하기 규칙이다.
  // 온라인은 그 둘이 다르다 — 온라인 조작법·설정의 도움말과 같은 말을 한다
  const online = roundRules.onlineRule();
  assert.equal(online, '칸에 서 있기만 해서는 제출되지 않아요. 선택 버튼이나 Enter · Space를 눌러요. 문항 시간은 방장이 20초나 40초로 정해요.');
  assert.doesNotMatch(online, /시간이 끝나면|설정에서/, '혼자 하기 규칙을 섞지 않는다');
  // 고를 수 있는 값은 상수에서 온다 — 서버 ALLOWED_QUESTION_TIMES_MS·DB CHECK 와 같은 목록이다
  for (const ms of constants.ONLINE_QUESTION_TIME_CHOICES) assert.match(online, new RegExp(`${ms / 1000}초`));
});

test('답하는 법: 직접 누르면 바로 답, 시간이 끝나면 선 칸이 답, 십자 틈은 무응답 — 제한 없음이면 «시간이 끝나면»이 없다', () => {
  const timed = roundRules.answerRule(20_000);
  assert.match(timed, /보기나 바닥 칸을 누르면 바로 답이 나가요/);
  assert.match(timed, /시간이 끝나면 캐릭터가 서 있는 칸이 답이에요/);
  assert.match(timed, /십자 틈에 서 있으면 답하지 않은 것이 돼요/);
  const untimed = roundRules.answerRule(null);
  assert.doesNotMatch(untimed, /시간이 끝나면|십자 틈/);
  assert.match(untimed, /칸 위에서 선택 버튼이나 Enter · Space를 눌러요/);

  assert.equal(roundRules.arenaRuleHint(20_000), '보기를 누르면 바로 답 · 시간이 끝나면 선 칸이 답');
  assert.equal(roundRules.arenaRuleHint(40_000), roundRules.arenaRuleHint(20_000));
  assert.equal(roundRules.arenaRuleHint(null), '보기를 누르면 바로 답 · 칸 위에서 선택하면 답');
});

// ── 무대 아래 규칙 줄 ─────────────────────────────────────────────

test('무대 아래 안내: 규칙 줄이 먼저 오고, 조작 줄은 입력 장치에 따라 달라진다', async () => {
  const html = await source('index.html');
  const quiz = html.slice(html.indexOf('data-screen="quiz"'), html.indexOf('data-screen="online-quiz"'));
  assert.match(quiz, /<p class="arena__hint" id="arena-hint" aria-hidden="true">\s*<span class="arena__hint-rule" id="arena-hint-rule">보기를 누르면 바로 답 · 시간이 끝나면 선 칸이 답<\/span>\s*<span class="arena__hint-key">[^<]*<\/span>\s*<span class="arena__hint-touch">[^<]*<\/span>\s*<\/p>/);
  // 온라인은 판마다 다르다 (U13): 시간이 끝나면 선 칸이 답인 판(snapshot의 standingAnswers)에서만 같은 규칙
  // 줄을 보이고, 직접 낸 답만 세는 이전 API의 판에서는 숨긴 채 둔다(online-quiz.ts의 renderAnswerRule)
  const online = html.slice(html.indexOf('data-screen="online-quiz"'), html.indexOf('data-screen="online-result"'));
  assert.match(online, /<span class="arena__hint-rule" id="online-arena-hint-rule" hidden>보기를 누르면 바로 답 · 시간이 끝나면 선 칸이 답<\/span>/);
  assert.equal(online.match(/arena__hint-rule/g).length, 1, '규칙 줄은 하나뿐이다');
});

test('처음 세 판(data-pinned)은 짧은 touch·좁은 화면에서도 규칙 줄을 남기고 조작 줄만 접는다', () => {
  const tree = (pinned) => {
    const body = node('body', null, { has: ["[data-screen='quiz']:not([hidden])", '.walk-controls--on'] });
    const quiz = node("section.screen.quiz--character[data-screen='quiz']", node('main.app', body));
    const hint = node(`p.arena__hint#arena-hint${pinned ? "[data-pinned='true']" : "[data-pinned='false']"}`, node('div.arena#arena', quiz));
    return {
      hint,
      rule: node('span.arena__hint-rule#arena-hint-rule', hint),
      key: node('span.arena__hint-key', hint),
      touch: node('span.arena__hint-touch', hint),
    };
  };
  const shortLandscape = { width: 844, height: 390, pointer: 'coarse', hover: 'none', reducedMotion: false };
  const narrowDesktop = { width: 400, height: 900, pointer: 'fine', hover: 'hover', reducedMotion: false };

  for (const env of [MOBILE, NARROW, shortLandscape, narrowDesktop]) {
    const label = `${env.width}×${env.height} ${env.pointer}`;
    const pinned = tree(true);
    assert.equal(valueOf(rules, pinned.hint, 'display', env), 'block', `${label}: 처음 세 판은 규칙 줄이 보인다`);
    assert.equal(valueOf(rules, pinned.rule, 'display', env), 'block', `${label}: 규칙은 제 줄`);
    assert.equal(valueOf(rules, pinned.key, 'display', env), 'none', `${label}: 중복 조작 설명은 그대로 접는다`);
    assert.equal(valueOf(rules, pinned.touch, 'display', env), 'none', `${label}: 스틱이 이미 말한다`);

    const later = tree(false);
    assert.equal(valueOf(rules, later.hint, 'display', env), 'none', `${label}: 세 판이 지나면 예전처럼 줄째 접는다`);
  }

  // 넓은 데스크톱은 늘 규칙과 키 조작 두 줄을 보인다
  const desktop = tree(false);
  assert.notEqual(valueOf(rules, desktop.hint, 'display', DESKTOP), 'none');
  assert.equal(valueOf(rules, desktop.rule, 'display', DESKTOP), 'block');
  assert.notEqual(valueOf(rules, desktop.key, 'display', DESKTOP), 'none');
  assert.equal(valueOf(rules, desktop.rule, 'font-weight', DESKTOP), 'var(--weight-bold)', '규칙 줄이 조작 줄보다 무겁게 읽힌다');
});

// ── 세는 값 (preferences) ─────────────────────────────────────────

test('규칙 줄을 보인 판 수는 preferences 를 거쳐 남고, 깨진 값은 0 이다', async () => {
  assert.equal(constants.RULE_HINT_ROUNDS, 3);
  const preferences = createLocalPreferences();
  assert.equal(await preferences.getRuleHintRounds(), 0, '처음 온 사람');
  await preferences.setRuleHintRounds(2);
  assert.equal(storage.values.get('quiz.ruleHintRounds'), '2');
  assert.equal(await createLocalPreferences().getRuleHintRounds(), 2, '새로고침해도 이어 센다');

  for (const raw of ['-1', '1.5', '"3"', 'null', '{}', '깨짐']) {
    storage.values.set('quiz.ruleHintRounds', raw);
    assert.equal(await preferences.getRuleHintRounds(), 0, `${raw} 는 0 으로 본다`);
  }
  storage.values.delete('quiz.ruleHintRounds');
});

test('app: 로컬 판을 열 때만 센다 — 처음 RULE_HINT_ROUNDS 판은 규칙 줄을 접지 않고 넘긴다', async () => {
  const [app, local] = await Promise.all([source('src/app.ts'), source('src/storage/local-store.ts')]);
  assert.match(app, /let ruleHintRounds = await preferences\.getRuleHintRounds\(\);/);
  const start = app.slice(app.indexOf('  async function startRound('), app.indexOf('  function labelFor('));
  assert.match(start, /const pinRules = ruleHintRounds < RULE_HINT_ROUNDS;\s*if \(pinRules\) \{\s*ruleHintRounds \+= 1;\s*void preferences\.setRuleHintRounds\(ruleHintRounds\);\s*\}/);
  assert.match(start, /quizScreen\.start\(session, \{ categoryLabel: labelFor\(round\), pinRules \}\);/);
  assert.ok(start.indexOf('if (questions.length === 0)') < start.indexOf('const pinRules'), '열지 못한 판은 세지 않는다');
  // localStorage 는 safe-storage 한 곳만 만진다
  assert.doesNotMatch(app, /localStorage/);
  assert.match(local, /ruleHintRounds: 'quiz\.ruleHintRounds'/);
});
