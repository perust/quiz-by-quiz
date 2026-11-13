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
  if (controlsOn) has.push('.walk-controls--on');
  const body = node('body', null, { has });
  const app = node('main.app', body);
  const section = node(`section.screen.quiz--character[data-screen='${screen}']`, app);
  const controls = node('div.walk-controls.walk-controls--on#walk-controls', app);
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
    // 조작부가 아래가 아니라 옆에 있으므로 아래를 스틱 높이만큼 비우지 않는다. 높이 340px 이하는 한 단계 더 줄인다
    assert.equal(px(valueOf(rules, tree.section, 'padding-bottom', env), env), env.height <= 340 ? 8 : 12, `${at}: 아래 여백`);
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

test('짧은 가로 touch 퀴즈(U15): 혼자 판의 앞 판 알림은 왼쪽 열이 아니라 두 열 아래, 공개·상태 줄 위다', () => {
  // 끝내고 새로 연 판(PRD 10.1 #11)의 첫 문항 동안 알림이 HUD 아래(왼쪽 열)에 서면 그 높이(38–57px + 12px)가
  // 왼쪽 열에 더해져 740×360에서 아래 줄 보기가 화면 밖으로 7–13px 나갔다. 실측은 tools/check-screens.js ㉓다
  const notice = nodeFromHtml(html, 'online-solo-notice');
  assert.ok(notice.parent.classes.includes('quiz--character'), '알림은 온라인 퀴즈 grid의 자식이다');
  for (const env of [...LANDSCAPE_PHONES, OLD_LANDSCAPE]) {
    const at = `${env.width}×${env.height}`;
    assert.equal(valueOf(rules, notice, 'grid-column', env), '1 / -1', at);
    // 넷째 줄(1fr)까지가 두 열이다. 다섯째 줄로 정해 두면 공개 카드·상태 줄·채팅은 그 뒤로 놓인다
    assert.equal(valueOf(rules, notice, 'grid-row', env), '5', at);
    assert.equal(valueOf(rules, notice, 'width', env), '100%', at);
    assert.equal(valueOf(rules, notice, 'margin', env), 'var(--space-3) 0', at);
    const position = valueOf(rules, notice, 'position', env);
    assert.ok(position === null || position === 'static', `${at}: position ${position}`);
  }
  // 다른 화면에서는 그대로 HUD 바로 아래 흐름이다
  for (const env of [MOBILE, DESKTOP, touch(1024, 768)]) {
    assert.equal(valueOf(rules, notice, 'grid-row', env), null, `${env.width}×${env.height}`);
    assert.equal(valueOf(rules, notice, 'margin', env), '0 auto var(--space-3)', `${env.width}×${env.height}`);
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
  const body = node('body', null, { has: ["[data-screen='home']:not([hidden])", '.walk-controls--on'] });
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
    controls: node('div.walk-controls.walk-controls--on#walk-controls', app),
  };
}

test("짧은 가로 홈도 중앙 메뉴의 같은 읽기 순서와 동등한 두 CTA를 쓴다", () => {
  for(const env of [...LANDSCAPE_PHONES,OLD_LANDSCAPE,touch(480,320)]) {
    const home=homeTree();
    assert.equal(valueOf(rules,home.actions,"grid-template-columns",env),"repeat(2, minmax(0, 1fr))");
    assert.equal(valueOf(rules,home.actions,"grid-auto-rows",env),"1fr");
    assert.equal(valueOf(rules,home.meta,"display",env),"none");
    assert.equal(valueOf(rules,home.header,"position",env),"static");
    assert.equal(valueOf(rules,home.header,"width",env),"100%");
    assert.equal(valueOf(rules,home.subtitle,"display",env),"none");
  }
});

test('홈과 퀴즈는 짧은 가로에서도 같은 viewport 하단 anchor를 쓴다', () => {
  for (const env of [...LANDSCAPE_PHONES, OLD_LANDSCAPE, touch(480, 320), touch(926, 428)]) {
    const at = `${env.width}×${env.height}`;
    const homeControls = homeTree().controls;
    const quizControls = quizTree('quiz').controls;
    for (const property of ['--walk-controls-bottom', '--walk-stick-left', '--walk-confirm-right']) {
      assert.equal(
        px(valueOf(rules, homeControls, property, env), env),
        px(valueOf(rules, quizControls, property, env), env),
        `${at}: ${property}`,
      );
    }
  }
});

test("짧은 홈의 보조 입구와 복귀 줄은 절대 HUD 배치가 아닌 중앙 일반 흐름이다", () => {
  const stage=node("div.home-stage#home-stage");
  const hub=node("div.home-hub#home-hub",stage);
  const nav=node("nav.home-menu",hub);
  for(const env of [OLD_LANDSCAPE,touch(480,320),MOBILE]) {
    assert.equal(valueOf(rules,hub,"overflow",env),"auto");
    for(const id of ["open-characters","open-ranking","open-rules"]) {
      const button=node(`button.menu-card#${id}`,nav);
      assert.notEqual(valueOf(rules,button,"position",env),"absolute");
      assert.ok(px(valueOf(rules,button,"min-height",env),env)>=44);
    }
    assert.equal(valueOf(rules,node("button.home-room-note",node("div.home-quests",hub)),"min-height",env),"var(--tap)");
  }
});

test('568×320 퀴즈: 아래 여백을 한 단계 줄여 두 열 배치가 화면 높이 안에 든다', () => {
  // 아래 여백 12px 때문에 문서가 324px 이 되어 4px 스크롤이 생겼다. 위 여백은 설정 버튼과 줄을 맞춘 채 둔다
  for (const screen of ['quiz', 'online-quiz']) {
    const tree = quizTree(screen);
    assert.equal(px(valueOf(rules, tree.section, 'padding-bottom', OLD_LANDSCAPE), OLD_LANDSCAPE), 8, screen);
    assert.equal(px(valueOf(rules, tree.section, 'padding-top', OLD_LANDSCAPE), OLD_LANDSCAPE), 12, screen);
  }
  for (const env of LANDSCAPE_PHONES) {
    assert.equal(px(valueOf(rules, quizTree('quiz').section, 'padding-bottom', env), env), 12, `${env.width}×${env.height}`);
  }
});

test("홈 캐릭터는 중앙 메뉴의 아래 빈 바닥에서 시작한다", () => {
  assert.match(homeSource,/const box = el\.hub\.getBoundingClientRect\(\)/);
  assert.match(homeSource,/x: box\.left \+ box\.width \/ 2/);
  assert.match(homeSource,/y: box\.bottom \+ el\.walker\.offsetHeight \+ 8/);
  assert.doesNotMatch(homeSource,/shortHomeStartPoint|window\.innerHeight <= 700/);
});
