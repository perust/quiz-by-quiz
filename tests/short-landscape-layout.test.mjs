import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, lengthOf, loadStyles, node, nodeFromHtml, shorthandParts, valueOf } from './css-cascade.mjs';

// 짧은 가로 화면 (U15·U07). 740×360 touch 휴대폰에서 로컬 퀴즈 문서가 642px이라 2×2 바닥(y=324–574)이 거의
// 다 접힘 아래였고 고정 스틱·선택이 3·4번 보기를 덮었다. 홈은 두 줄 dock이 화면의 절반(171px)을 먹어 두 보조
// 입구와 조작부가 위 가운데로 밀려 올라왔고 브랜드는 접혀 있었다. 실측은 tools/check-screens.js ⑮·⑯이 맡고,
// 여기서는 그 배치를 이루는 캐스케이드와 계산식을 잠근다.

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const homeSource = await readFile(new URL('../src/ui/home.ts', import.meta.url), 'utf8');

const touch = (width, height) => ({ width, height, pointer: 'coarse', hover: 'none', reducedMotion: false });
/** 이번 작업이 맞춘 네 휴대폰 가로 화면 */
const LANDSCAPE_PHONES = [touch(740, 360), touch(667, 375), touch(844, 390), touch(915, 412)];
const OLD_LANDSCAPE = touch(568, 320);
const px = (value, env) => lengthOf(rules, value, env);

function quizTree(screen = 'quiz', { controlsOn = true } = {}) {
  const has = [`[data-screen='${screen}']:not([hidden])`];
  if (controlsOn) has.push('.walk-controls--on', ".walk-controls--on[data-placement='viewport']");
  const body = node('body', null, { has });
  const app = node('main.app', body);
  const section = node(`section.screen.quiz--character[data-screen='${screen}']`, app);
  const controls = node("div.walk-controls.walk-controls--on[data-placement='viewport']#walk-controls", app);
  return {
    body,
    section,
    hud: node('div.quiz-hud', section),
    meta: node('div.quiz-meta', node('header.quiz-header', node('div.quiz-hud', section))),
    progress: node('div.progress', node('div.quiz-meta', node('header.quiz-header', node('div.quiz-hud', section)))),
    question: node('h1.question', section),
    choices: node('ul.choices', section),
    choice: node('button.choice', node('li', node('ul.choices', section))),
    mark: node('span.choice__mark', node('button.choice', node('li', node('ul.choices', section)))),
    arena: node('div.arena', section),
    tile: node('div.arena-tile', node('div.arena__grid', node('div.arena__stage', node('div.arena', section)))),
    stick: node('div.walk-stick#walk-stick', controls),
    confirm: node('button.walk-confirm#walk-confirm', controls),
    controls,
    feedback: node('div.feedback#feedback', body),
  };
}

test('짧은 가로 touch 퀴즈(U15): 왼쪽 열은 HUD·질문·보기, 오른쪽 열은 arena다', () => {
  for (const env of [...LANDSCAPE_PHONES, OLD_LANDSCAPE]) {
    const at = `${env.width}×${env.height}`;
    for (const screen of ['quiz', 'online-quiz']) {
      const tree = quizTree(screen);
      assert.equal(valueOf(rules, tree.section, 'display', env), 'grid', `${at} ${screen}`);
      assert.equal(valueOf(rules, tree.section, 'grid-template-columns', env), 'minmax(0, 5fr) minmax(0, 3fr)', `${at} ${screen}`);
      // 넷째 줄(1fr)만 arena 길이에 맞춰 늘어 HUD·질문·보기 사이를 벌리지 않는다
      assert.equal(valueOf(rules, tree.section, 'grid-template-rows', env), 'auto auto auto minmax(0, 1fr)', `${at} ${screen}`);
      for (const part of [tree.hud, tree.question, tree.choices]) {
        assert.equal(valueOf(rules, part, 'grid-column', env), '1', `${at} ${screen} ${part.classes[0]}`);
      }
      assert.equal(valueOf(rules, tree.arena, 'grid-column', env), '2', `${at} ${screen} arena`);
      assert.equal(valueOf(rules, tree.arena, 'grid-row', env), '1 / 5', `${at} ${screen} arena`);
      // grid 안의 auto margin 은 늘이기를 막으므로 폭을 명시해 오른쪽 열을 다 쓴다(88vw 고정 폭은 열을 넘쳤다)
      assert.equal(valueOf(rules, tree.arena, 'width', env), '100%', `${at} ${screen} arena`);
      assert.equal(valueOf(rules, tree.arena, 'margin', env), 'auto 0 0', `${at} ${screen} arena`);
    }
  }
});

test('짧은 가로 touch 퀴즈(U15): 양옆 여백이 공용 조작부 자리라 스틱·선택·설정 버튼이 보기와 바닥을 덮지 않는다', () => {
  const appBar = node('div.app-bar', node('body'));
  const settings = node('button.icon-button#open-settings', appBar);
  for (const env of [...LANDSCAPE_PHONES, OLD_LANDSCAPE]) {
    const at = `${env.width}×${env.height}`;
    const tree = quizTree('quiz');
    const left = px(valueOf(rules, tree.section, 'padding-left', env), env);
    const right = px(valueOf(rules, tree.section, 'padding-right', env), env);
    const stickRight = px(valueOf(rules, tree.controls, '--walk-stick-left', env), env)
      + px(valueOf(rules, tree.stick, 'width', env), env);
    const confirmLeft = px(valueOf(rules, tree.controls, '--walk-confirm-right', env), env)
      + px(valueOf(rules, tree.confirm, 'width', env), env);
    assert.ok(Number.isFinite(left) && Number.isFinite(right), `${at}: 여백을 계산하지 못했다`);
    // 조작부를 화면 이름으로 바꾸거나 숨기지 않는다 — 공용 크기 그대로 떠 있다
    assert.equal(valueOf(rules, tree.stick, 'display', env), 'block', at);
    assert.equal(valueOf(rules, tree.confirm, 'display', env), 'block', at);
    assert.ok(px(valueOf(rules, tree.stick, 'width', env), env) >= 44, `${at}: 스틱은 44px 이상`);
    assert.equal(left - stickRight, 8, `${at}: 왼쪽 열은 스틱 오른쪽 8px 뒤에서 시작한다 (${left}px / 스틱 ${stickRight}px)`);
    assert.equal(right - confirmLeft, 8, `${at}: 오른쪽 열은 선택 버튼 왼쪽 8px 앞에서 끝난다 (${right}px / 선택 ${confirmLeft}px)`);
    // 앱 바는 padding 단축 속성이다 (위 · 오른쪽 · 아래 · 왼쪽)
    const settingsLeft = px(shorthandParts(valueOf(rules, appBar, 'padding', env))[1], env)
      + px(valueOf(rules, settings, 'width', env), env);
    assert.ok(settingsLeft >= 56, `${at}: 설정 버튼 자리를 읽지 못했다 (${settingsLeft}px)`);
    assert.ok(right >= settingsLeft, `${at}: 위 끝의 설정 버튼(${settingsLeft}px)도 오른쪽 여백 안이다`);
    // 그래서 HUD는 설정 버튼 슬롯(64px)을 비우지 않는다
    assert.equal(valueOf(rules, tree.hud, 'padding', env), 'var(--space-2) var(--space-3)', at);
    // 조작부가 아래가 아니라 옆에 있으므로 아래를 스틱 높이만큼 비우지 않는다
    assert.equal(px(valueOf(rules, tree.section, 'padding-bottom', env), env), 12, `${at}: 아래 여백`);
  }
});

test('짧은 가로 touch 퀴즈(U15): 좁은 열에서도 보기는 44px 이상이고 판정 알약은 모양만, 바닥 칸은 정사각이다', () => {
  for (const env of LANDSCAPE_PHONES) {
    const at = `${env.width}×${env.height}`;
    const tree = quizTree('quiz');
    assert.equal(px(valueOf(rules, tree.choice, 'min-height', env), env), 44, at);
    assert.equal(valueOf(rules, tree.choice, 'padding', env), 'var(--space-2)', at);
    assert.equal(valueOf(rules, tree.mark, 'overflow', env), 'hidden', `${at}: 알약 글은 잘려 보이지 않을 뿐 낭독된다`);
    assert.equal(px(valueOf(rules, tree.mark, 'width', env), env), 24, at);
    // 진행률은 위치 아래 줄로 내려 분야 칩이 말줄임 칸 안에서 읽힌다
    assert.equal(valueOf(rules, tree.progress, 'grid-column', env), '1 / -1', at);
    assert.equal(valueOf(rules, tree.meta, 'grid-template-columns', env), 'minmax(0, auto) minmax(auto, 1fr)', at);
    assert.equal(px(valueOf(rules, tree.question, 'font-size', env), env), 18, `${at}: 질문은 좁은 화면처럼 한 단계 작게`);
    assert.equal(valueOf(rules, tree.tile, 'aspect-ratio', env), '1', at);
    assert.equal(px(valueOf(rules, tree.tile, 'min-height', env), env), 64, at);
    assert.equal(px(valueOf(rules, tree.tile, 'max-height', env), env), 104, at);
    // 답한 뒤 결과 패널은 화면 높이까지 쓴다 — 60vh(360px 화면에서 216px)이면 「다음 문제」가 패널 안 스크롤 밑에 잘렸다
    assert.equal(valueOf(rules, tree.feedback, 'max-height', env), 'calc(100svh - var(--space-6))', at);
    assert.equal(valueOf(rules, tree.feedback, 'position', env), 'relative', `${at}: 결과 패널은 여전히 문서 흐름이다`);
  }
});

test('짧은 가로 touch 퀴즈(U15): 온라인의 공개·상태 줄·채팅은 두 열 아래에 폭을 다 쓰고 위치를 갖지 않는다', () => {
  const onlineQuiz = nodeFromHtml(html, 'online-reveal').parent;
  assert.ok(onlineQuiz.classes.includes('quiz--character'), '온라인 퀴즈도 같은 .quiz--character 배치를 쓴다');
  for (const env of LANDSCAPE_PHONES) {
    for (const id of ['online-reveal', 'online-match-status']) {
      const part = nodeFromHtml(html, id);
      assert.equal(valueOf(rules, part, 'grid-column', env), '1 / -1', `${env.width}px #${id}`);
      const position = valueOf(rules, part, 'position', env);
      assert.ok(position === null || position === 'static', `${env.width}px #${id}: position ${position}`);
    }
    const chat = nodeFromHtml(html, 'online-chat-log').parent;
    assert.equal(valueOf(rules, chat, 'grid-column', env), '1 / -1', `${env.width}px 채팅`);
  }
});

test('짧은 가로 배치는 touch 가로 화면에만 걸린다 — 세로 휴대폰·마우스 기기·높은 태블릿은 그대로다', () => {
  const tablet = touch(1024, 768);
  const mouseShort = { ...DESKTOP, width: 740, height: 360 };
  for (const env of [MOBILE, touch(375, 667), mouseShort, tablet, DESKTOP]) {
    const tree = quizTree('quiz');
    assert.equal(valueOf(rules, tree.section, 'display', env), 'flex', `${env.width}×${env.height} ${env.pointer}`);
    assert.equal(valueOf(rules, tree.feedback, 'max-height', env), '60vh', `${env.width}×${env.height}`);
  }
});

function homeTree() {
  const body = node('body', null, { has: ["[data-screen='home']:not([hidden])"] });
  const app = node('main.app', body);
  const section = node("section.screen[data-screen='home']", app);
  const stage = node('div.home-stage#home-stage', section);
  const quests = node('div.home-quests#home-quests', stage);
  const actions = node('div.home-primary-actions', quests);
  const header = node('header.home-header', stage);
  const heading = node('div.home-heading', header);
  return {
    quests,
    note: node('button.home-room-note#home-room-note', quests),
    actions,
    card: node('button.challenge-card.challenge-card--online#open-online', actions),
    meta: node('span.challenge-card__meta#start-all-meta', node('button.challenge-card.challenge-card--all#start-all', actions)),
    full: node('span.category-card__name.category-card__name--full', node('button.category-card', node('div.category-grid#category-grid', quests))),
    compact: node('span.category-card__name.category-card__name--compact', node('button.category-card', node('div.category-grid#category-grid', quests))),
    header,
    title: node('h1.home-title#home-title', heading),
    subtitle: node('p.home-subtitle', heading),
    controls: node("div.walk-controls.walk-controls--on[data-placement='home-dock']#walk-controls", app),
  };
}

test('짧은 가로 홈(U07): 분야 | 온라인·전체 도전을 dock 한 줄에 두고 브랜드를 되살린다', () => {
  for (const env of [...LANDSCAPE_PHONES, { ...DESKTOP, width: 740, height: 360 }]) {
    const at = `${env.width}×${env.height} ${env.pointer}`;
    const home = homeTree();
    assert.equal(valueOf(rules, home.quests, 'grid-template-columns', env), 'minmax(0, 1fr) auto', at);
    assert.equal(px(valueOf(rules, home.quests, 'padding', env), env), 4, `${at}: 넓은 화면 dock 여백 16px을 거둔다`);
    assert.equal(valueOf(rules, home.note, 'grid-column', env), '1 / -1', `${at}: 방 복귀 줄은 한 줄 위에 폭을 다 쓴다`);
    // 같은 크기의 두 주요 버튼: 같은 묶음 안의 같은 두 칸, 같은 행 높이
    assert.equal(valueOf(rules, home.actions, 'grid-template-columns', env), 'repeat(2, minmax(0, 1fr))', at);
    assert.equal(valueOf(rules, home.actions, 'grid-auto-rows', env), '1fr', at);
    assert.equal(valueOf(rules, home.actions, 'margin', env), '0', at);
    assert.equal(valueOf(rules, home.actions, 'width', env), 'auto', at);
    assert.equal(valueOf(rules, home.meta, 'display', env), 'none', `${at}: 전체 최고점 pill은 접고 이름에 남긴다`);
    assert.equal(valueOf(rules, home.full, 'display', env), 'none', at);
    assert.equal(valueOf(rules, home.compact, 'display', env), 'block', `${at}: 좁은 칸은 짧은 이름`);
    // 접었던 브랜드(1px clip)를 풀고 위 가운데에 작게 둔다. 부제는 접는다
    assert.equal(valueOf(rules, home.header, 'clip', env), 'auto', at);
    assert.equal(valueOf(rules, home.header, 'overflow', env), 'visible', at);
    assert.equal(valueOf(rules, home.header, 'height', env), 'auto', at);
    assert.equal(valueOf(rules, home.header, 'width', env), 'min(42vw, 520px)', at);
    assert.equal(px(valueOf(rules, home.header, 'min-height', env), env), 0, at);
    assert.equal(px(valueOf(rules, home.title, 'font-size', env), env), 24, at);
    assert.equal(valueOf(rules, home.subtitle, 'display', env), 'none', at);
  }
});

test('짧은 가로 홈(U07): 낮아진 dock 위 양쪽 모서리로 조작부 anchor를 되돌리고 입구 한 줄 위에 둔다', () => {
  for (const env of LANDSCAPE_PHONES) {
    const at = `${env.width}×${env.height}`;
    const { controls } = homeTree();
    assert.equal(px(valueOf(rules, controls, '--walk-stick-left', env), env), 12, at);
    assert.equal(px(valueOf(rules, controls, '--walk-confirm-right', env), env), 12, at);
    // dock 높이(런타임 측정값)를 뺀 나머지: 입구 한 줄(20px + 입구 56px) 위 16px
    const bottom = valueOf(rules, controls, '--walk-controls-bottom', env);
    assert.equal(px(bottom.replace('var(--home-dock-h, 148px)', '0px'), env), 92, `${at}: ${bottom}`);
  }
  // 폭 640px 아래의 짧은 가로 홈은 dock이 두 줄 그대로라 위 HUD를 피하는 가운데 anchor를 유지한다
  const { controls } = homeTree();
  assert.equal(valueOf(rules, controls, '--walk-stick-left', OLD_LANDSCAPE), 'calc(50% - 112px)');
});

test('짧은 가로 홈(U07) 규칙은 폭 640px 이상·높이 420px 이하에만 걸린다', () => {
  for (const env of [OLD_LANDSCAPE, MOBILE, touch(375, 667), DESKTOP, touch(1024, 768)]) {
    const at = `${env.width}×${env.height}`;
    const home = homeTree();
    assert.notEqual(valueOf(rules, home.quests, 'grid-template-columns', env), 'minmax(0, 1fr) auto', at);
    assert.notEqual(valueOf(rules, home.header, 'clip', env), 'auto', at);
  }
  // 높이 700px 이하의 다른 화면은 여전히 브랜드를 1px로 접는다
  assert.equal(valueOf(rules, homeTree().header, 'width', touch(375, 667)), '1px');
});

test('높이 700px 이하 홈의 시작 자리: 두 입구 사이 가운데, 보이는 브랜드 아래, 입구 줄 위', async () => {
  const { shortHomeStartPoint } = await import('../js/ui/walker-geometry.js');
  // 브랜드가 접힌 화면(375×667 등)은 예전 자리 그대로다: 머리 높이 + 48px, 입구 줄 위
  assert.deepEqual(shortHomeStartPoint({ viewportWidth: 375, walkerHeight: 48, entryTop: 376, brandBottom: null }), { x: 187.5, y: 96 });
  assert.deepEqual(shortHomeStartPoint({ viewportWidth: 320, walkerHeight: 48, entryTop: 80, brandBottom: null }), { x: 160, y: 72 });
  // 브랜드가 보이면 그 아래 8px에 머리가 온다 — 브랜드가 크면 더 내려선다
  assert.deepEqual(shortHomeStartPoint({ viewportWidth: 740, walkerHeight: 48, entryTop: 212, brandBottom: 40 }), { x: 370, y: 96 });
  assert.deepEqual(shortHomeStartPoint({ viewportWidth: 740, walkerHeight: 48, entryTop: 212, brandBottom: 64 }), { x: 370, y: 120 });
  // 그래도 입구 줄보다 아래로 내려가 입구를 밟지 않는다
  assert.deepEqual(shortHomeStartPoint({ viewportWidth: 740, walkerHeight: 48, entryTop: 110, brandBottom: 64 }), { x: 370, y: 102 });
  // 머리가 화면 위로 솟지 않는다
  assert.deepEqual(shortHomeStartPoint({ viewportWidth: 740, walkerHeight: 48, entryTop: 20, brandBottom: null }), { x: 370, y: 48 });

  // home.ts 는 접힌 브랜드(1px 칸)를 «보이지 않음»으로 넘긴다
  assert.match(homeSource, /if \(window\.innerHeight <= 700\) \{[\s\S]*?shortHomeStartPoint\(\{[\s\S]*?entryTop: el\.openRanking\.getBoundingClientRect\(\)\.top/);
  assert.match(homeSource, /brandBottom: brand\.width > 1 \? brand\.bottom : null/);
});
