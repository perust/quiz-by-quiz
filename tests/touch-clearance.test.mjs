import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, lengthOf, loadStyles, node, shorthandParts, valueOf } from './css-cascade.mjs';

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
const homeSource = await readFile(new URL('../src/ui/home.ts', import.meta.url), 'utf8');
const SHORT_ZOOM = { width: 390, height: 420, pointer: 'coarse', hover: 'none', reducedMotion: false };
const SHORT_LANDSCAPE = { width: 568, height: 320, pointer: 'coarse', hover: 'none', reducedMotion: false };

/**
 * 이긴 선언을 토큰까지 풀어 px 로 계산한다. 선언이 없으면 0 이다.
 * 계산할 수 없는 값(모르는 단위·함수)은 NaN 이라 아래 비교가 실패한다 — 거짓으로 통과하지 않는다.
 */
function px(value, env) {
  if (value === null || value === undefined) return 0;
  return lengthOf(rules, value, env);
}

/** padding 단축 속성에서 아래쪽 값만 */
function bottomOf(value) {
  if (!value) return null;
  const parts = shorthandParts(value);
  return parts.length === 1 ? parts[0] : parts[2] ?? parts[0];
}

function controlTree({ screen = null, on = true } = {}) {
  const rootDescriptor = `div.walk-controls${on ? '.walk-controls--on' : ''}#walk-controls`;
  const has = [];
  if (screen) has.push(`[data-screen='${screen}']:not([hidden])`);
  if (on) has.push('.walk-controls--on');
  const body = node('body', null, { has });
  const app = node('main.app', body);
  const root = node(rootDescriptor, app);
  const stick = node('div.walk-stick#walk-stick', root);
  const knob = node('div.walk-stick__knob#walk-knob', stick);
  const confirm = node('button.walk-confirm#walk-confirm', root);
  return { body, app, root, stick, knob, confirm };
}

function stickReserve(env, screen = null) {
  const { root, stick } = controlTree({ screen });
  return px(valueOf(rules, stick, 'height', env), env)
    + px(valueOf(rules, root, '--walk-controls-bottom', env), env);
}

/** 걷는 화면이 맨 아래에 비워 두는 높이 = .app 의 아래 여백 + 화면 자신의 아래 여백 */
function bottomSpace(screen, env, { stickOn = true } = {}) {
  const has = [`[data-screen='${screen}']:not([hidden])`];
  if (stickOn) has.push('.walk-controls--on');
  const body = node('body', null, { has });
  const app = node('main.app', body);
  const section = node(`section.screen[data-screen='${screen}']`, app);
  return px(bottomOf(valueOf(rules, app, 'padding-bottom', env)), env)
    + px(bottomOf(valueOf(rules, section, 'padding-bottom', env)), env);
}

test('손가락 조작부: 홈과 다른 walking 화면은 같은 하단 엄지 anchor를 공유한다', () => {
  for (const env of [MOBILE, NARROW, SHORT_ZOOM, SHORT_LANDSCAPE]) {
    const ranking = controlTree({ screen: 'ranking' });
    const home = controlTree({ screen: 'home' });

    for (const property of ['--walk-controls-bottom', '--walk-stick-left', '--walk-confirm-right']) {
      const expected = px(valueOf(rules, ranking.root, property, env), env);
      const actual = px(valueOf(rules, home.root, property, env), env);
      assert.equal(actual, expected, `${env.width}×${env.height} ${property}: 홈 ${actual}px / 공용 ${expected}px`);
    }
  }
});

const SCROLLING_WALKING_SCREENS = ['characters', 'ranking', 'result', 'online', 'waiting'];

test('손가락 조작부: 스크롤 끝과 홈 메뉴는 공용 하단 조작부 위에 여백을 둔다', () => {
  for (const env of [MOBILE, NARROW]) {
    const reserve = stickReserve(env);
    assert.ok(reserve >= 88, `스틱이 차지하는 높이를 읽지 못했다: ${reserve}`);
    for (const screen of SCROLLING_WALKING_SCREENS) {
      const screenReserve = stickReserve(env, screen);
      assert.ok(
        bottomSpace(screen, env) >= screenReserve,
        `${env.width}×${env.height} ${screen}: 아래 여백 ${bottomSpace(screen, env)}px < 스틱 ${screenReserve}px`,
      );
    }

    const expectedGap = 8;
    assert.equal(
      bottomSpace('ranking', env) - reserve,
      expectedGap,
      `${env.width}×${env.height}: 스크롤 화면은 조작부 위에 숨 쉴 틈을 남긴다`,
    );

    const { app, root, stick } = controlTree({ screen: 'home' });
    const home = node("section.screen[data-screen='home']", app);
    const quests = node('div.home-quests#home-quests', home);
    const controlsTop = px(valueOf(rules, root, '--walk-controls-bottom', env), env)
      + px(valueOf(rules, stick, 'height', env), env);
    const questsBottom = px(valueOf(rules, quests, 'bottom', env), env);
    assert.equal(questsBottom - controlsTop, 8, `${env.width}×${env.height}: 홈 메뉴와 공용 조작부 간격`);
  }
});

test('손가락 조작부: 여백은 조작부가 떠 있을 때만이고, 온라인 퀴즈의 채팅 여백과 겹치지 않는다', () => {
  // 마우스 기기와 조작부를 거둔 화면(로컬 피드백 등)은 원래 여백 그대로다
  assert.equal(bottomSpace('home', DESKTOP), 0);
  assert.equal(bottomSpace('home', MOBILE), 0);
  assert.ok(bottomSpace('quiz', MOBILE, { stickOn: false }) < stickReserve(MOBILE));
  // 온라인 퀴즈는 채팅 블록이 공용 스틱 크기만큼 비운다. 화면 padding까지 두 번 비우지 않는다
  assert.equal(bottomSpace('online-quiz', MOBILE), bottomSpace('quiz', MOBILE, { stickOn: false }));
  const onlineQuiz = node("section.screen[data-screen='online-quiz']", node('main.app', node('body')));
  const chat = node('section.online-quiz-chat', onlineQuiz);
  assert.equal(px(valueOf(rules, chat, 'margin-bottom', MOBILE), MOBILE), 120);
  assert.equal(px(valueOf(rules, chat, 'margin-bottom', SHORT_LANDSCAPE), SHORT_LANDSCAPE), 64);
});

test('짧은 touch 홈도 공용 하단 이동 스틱과 선택 버튼을 유지한다', () => {
  const { app, root, stick, knob, confirm } = controlTree({ screen: 'home' });
  const home = node("section.screen[data-screen='home']", app);
  const quests = node('div.home-quests#home-quests', home);

  assert.equal(valueOf(rules, stick, 'display', NARROW), 'block');
  assert.equal(valueOf(rules, confirm, 'display', NARROW), 'block');
  assert.equal(px(valueOf(rules, stick, 'width', NARROW), NARROW), 80);
  assert.equal(px(valueOf(rules, stick, 'height', NARROW), NARROW), 80);
  assert.equal(px(valueOf(rules, knob, 'width', NARROW), NARROW), 40);
  assert.equal(px(valueOf(rules, confirm, 'width', NARROW), NARROW), 64);
  const controlsBottom = px(valueOf(rules, root, '--walk-controls-bottom', NARROW), NARROW);
  assert.equal(controlsBottom, 12, '조작부는 공용 viewport 하단 edge를 쓴다');
  assert.equal(
    px(valueOf(rules, quests, 'bottom', NARROW), NARROW) - controlsBottom - 80,
    8,
    '홈 메뉴는 조작부 위에 토큰 간격을 둔다',
  );
});

test('홈 오류 문구가 보이면 숨은 캐릭터의 조작부도 꺼서 문구를 덮지 않는다', () => {
  assert.match(homeSource, /let noteVisible = false/);
  assert.match(homeSource, /walker\.setEnabled\(!noteVisible\)/);
  assert.match(
    homeSource,
    /function setNote\(message[^)]*\): void \{[\s\S]*?noteVisible = Boolean\(message\)[\s\S]*?if \(noteVisible\) \{\s*walker\.setEnabled\(false\)/,
  );
  // 닫으면 다시 걷는다 (U06) — 예전에는 닫을 길이 없어 세션 내내 조작부가 꺼져 있었다
  assert.match(homeSource, /el\.noteClose\.addEventListener\('click', \(\) => \{[\s\S]*?setNote\(null\);/);
});

test('손가락 목표: 「비공개로 만들기」의 라벨은 44px 높이와 남은 폭을 채운다', () => {
  // 18px 체크박스와 한 줄 라벨(19px)뿐이라 손가락이 닿는 면이 너무 얇았다
  const row = node('div.room-form__row.room-form__row--check', node('form.room-form#create-form'));
  const input = node("input#create-private[type='checkbox']", row);
  const label = node("label[for='create-private']", row);

  for (const env of [DESKTOP, MOBILE, NARROW]) {
    assert.ok(px(valueOf(rules, row, 'min-height', env), env) >= 44, `${env.width}px: 줄 높이`);
    assert.equal(valueOf(rules, row, 'align-items', env), 'stretch', `${env.width}px: 라벨이 줄 높이를 다 채운다`);
    assert.equal(px(bottomOf(valueOf(rules, row, 'padding-bottom', env)), env), 0, `${env.width}px: 줄의 위아래 여백은 라벨 안으로 옮긴다`);
    assert.equal(valueOf(rules, label, 'flex', env), '1', `${env.width}px: 라벨이 남은 폭을 다 쓴다`);
    assert.equal(valueOf(rules, input, 'flex', env), 'none', `${env.width}px: 좁은 화면에서도 체크박스가 찌그러지지 않는다`);
  }
});

test('짧은 touch 화면: 고정 조작부 아래의 중복 설명은 접어 핵심 행동을 가리지 않는다', () => {
  const body = node('body');
  const app = node('main.app', body);
  const homeHint = node('p.home-hint', node("section.screen[data-screen='home']", app));
  const emptyCopy = node('p.room-empty__copy', node('div.room-empty', node("section.screen[data-screen='online']", app)));

  for (const env of [MOBILE, NARROW]) {
    assert.equal(valueOf(rules, homeHint, 'display', env), 'none', `${env.width}px 홈 조작 설명`);
    assert.equal(valueOf(rules, emptyCopy, 'display', env), 'none', `${env.width}px 빈 방 중복 설명`);
  }
  assert.equal(valueOf(rules, homeHint, 'display', DESKTOP), 'none', '월드 HUD는 데스크톱에서도 자명하게 유지한다');
  assert.notEqual(valueOf(rules, emptyCopy, 'display', DESKTOP), 'none');
});

test('홈·퀴즈는 짧은 화면까지 같은 touch 조작부를 쓰고 피드백은 arena 뒤 문서 흐름에서 이어진다', () => {
  const quizControls = controlTree({ screen: 'quiz' });
  const home = controlTree({ screen: 'home' });
  const { app, stick, knob } = quizControls;

  assert.equal(px(valueOf(rules, stick, 'width', MOBILE), MOBILE), 96);
  assert.equal(px(valueOf(rules, stick, 'height', MOBILE), MOBILE), 96);
  assert.equal(px(valueOf(rules, knob, 'width', MOBILE), MOBILE), 48);
  assert.equal(px(valueOf(rules, home.stick, 'width', MOBILE), MOBILE), px(valueOf(rules, stick, 'width', MOBILE), MOBILE));
  assert.equal(px(valueOf(rules, home.knob, 'width', MOBILE), MOBILE), px(valueOf(rules, knob, 'width', MOBILE), MOBILE));
  assert.equal(px(valueOf(rules, home.confirm, 'width', MOBILE), MOBILE), px(valueOf(rules, quizControls.confirm, 'width', MOBILE), MOBILE));
  assert.equal(valueOf(rules, stick, 'display', MOBILE), 'block');
  assert.equal(valueOf(rules, stick, 'display', NARROW), 'block', '짧은 touch 퀴즈도 이동 UI를 유지한다');
  const hint = node('p.arena__hint', node("section.screen.quiz--character[data-screen='quiz']", app));
  assert.equal(valueOf(rules, hint, 'display', NARROW), 'none', '공용 UI가 보이면 중복 스틱 안내는 접는다');
  const lockedBody = node('body', null, { has: ["[data-screen='quiz']:not([hidden])"] });
  const lockedHint = node('p.arena__hint', node("section.screen.quiz--character[data-screen='quiz']", node('main.app', lockedBody)));
  assert.equal(valueOf(rules, lockedHint, 'display', NARROW), 'none', '피드백 잠금으로 조작부가 꺼져도 중복 안내는 돌아오지 않는다');
  assert.equal(valueOf(rules, lockedHint, 'display', SHORT_LANDSCAPE), 'none', '넓고 짧은 피드백도 중복 안내를 되살리지 않는다');
  assert.ok(bottomSpace('quiz', MOBILE) >= stickReserve(MOBILE, 'quiz'), '일반 세로 화면은 arena 아래 스틱 여백을 둔다');
  assert.ok(bottomSpace('quiz', NARROW) >= stickReserve(NARROW, 'quiz'), '짧은 세로 화면도 arena 아래 스틱 여백을 둔다');
  assert.equal(bottomSpace('quiz', MOBILE) - stickReserve(MOBILE, 'quiz'), 8);
  assert.equal(bottomSpace('quiz', NARROW) - stickReserve(NARROW, 'quiz'), 8);

  assert.equal(px(valueOf(rules, stick, 'width', SHORT_LANDSCAPE), SHORT_LANDSCAPE), 44);
  assert.equal(px(valueOf(rules, quizControls.confirm, 'width', SHORT_LANDSCAPE), SHORT_LANDSCAPE), 44);
  assert.equal(px(valueOf(rules, quizControls.confirm, 'font-size', SHORT_LANDSCAPE), SHORT_LANDSCAPE), 12);
  assert.equal(valueOf(rules, stick, 'display', SHORT_LANDSCAPE), 'block');
  assert.equal(px(valueOf(rules, stick, 'width', SHORT_ZOOM), SHORT_ZOOM), 64);
  assert.equal(px(valueOf(rules, knob, 'width', SHORT_ZOOM), SHORT_ZOOM), 40);
  assert.equal(px(valueOf(rules, quizControls.confirm, 'width', SHORT_ZOOM), SHORT_ZOOM), 56);

  const feedbackBody = node('body', null, { has: ['#feedback:not([hidden])'] });
  const quiz = node("section.screen.quiz--character[data-screen='quiz']", node('main.app', feedbackBody));
  const grid = node('div.arena__grid', node('div.arena', quiz));
  const feedback = node('div.feedback#feedback', feedbackBody);
  assert.equal(valueOf(rules, grid, 'translate', MOBILE), 'none');
  assert.equal(valueOf(rules, feedback, 'position', MOBILE), 'relative');
});

test('짧은 화면의 핵심 직접 행동은 양쪽 공용 조작부 사이 안전 통로를 쓴다', () => {
  const body = node('body', null, { has: ['.walk-controls--on'] });
  const app = node('main.app', body);
  const quiz = node("section.screen.quiz--character[data-screen='quiz']", app);
  const choices = node('ul.choices#choices', quiz);
  const online = node("section.screen[data-screen='online']", app);
  const tools = node('div.online-block__tools', node('div.online-block__head', node('section.online-block.online-block--rooms', online)));
  const waiting = node("section.screen[data-screen='waiting']", app);
  const start = node('button.button.button--primary.waiting-start#waiting-start', waiting);
  const onlineQuiz = node("section.screen.online-quiz.quiz--character[data-screen='online-quiz']", app);
  const chat = node('form.chat.online-quiz-chat__form#online-chat-form', node('section.online-quiz-chat', onlineQuiz));

  for (const element of [choices, start]) {
    assert.equal(valueOf(rules, element, 'margin-left', SHORT_LANDSCAPE), 'var(--walk-controls-left-clearance)');
    assert.equal(valueOf(rules, element, 'margin-right', SHORT_LANDSCAPE), 'var(--walk-controls-right-clearance)');
  }
  assert.equal(valueOf(rules, choices, 'width', SHORT_LANDSCAPE), 'auto');
  assert.equal(valueOf(rules, start, 'width', SHORT_LANDSCAPE), 'auto');
  assert.equal(valueOf(rules, tools, 'margin-right', SHORT_LANDSCAPE), 'var(--walk-controls-right-clearance)');

  for (const env of [MOBILE, NARROW, SHORT_ZOOM]) {
    assert.equal(valueOf(rules, chat, 'margin-left', env), 'var(--walk-controls-left-clearance)');
    assert.equal(valueOf(rules, chat, 'margin-right', env), 'var(--walk-controls-right-clearance)');
    assert.equal(valueOf(rules, chat, 'flex-direction', env), 'column');
  }
});

test('대기실 라운지는 fixed walker의 좌표 기준을 바꾸는 backdrop-filter를 쓰지 않는다', () => {
  const waiting = node("section.screen[data-screen='waiting']", node('main.app', node('body')));
  const lounge = node('div.lounge#lounge', waiting);
  assert.equal(valueOf(rules, lounge, 'backdrop-filter', MOBILE), 'none');
});

test('온라인 정답 공개 카드: 자동 스크롤이 카드 끝을 고정 스틱·선택 버튼 위에 멈춘다 (css-responsive-01)', () => {
  // 공개 중에도 조작부는 떠 있다(lockMovement: false). scrollIntoView({ block: 'nearest' }) 는
  // scroll-margin 까지 보이게 옮기므로, 이 여백이 없으면 해설 아래 줄이 스틱과 선택 버튼 밑에 멈췄다
  const onlineQuiz = node("section.screen.quiz--character[data-screen='online-quiz']", node('main.app', node('body')));
  const reveal = node('section.online-reveal#online-reveal', onlineQuiz);
  const chat = node('section.online-quiz-chat', onlineQuiz);

  for (const env of [MOBILE, NARROW, SHORT_ZOOM]) {
    const { root, confirm } = controlTree({ screen: 'online-quiz' });
    const controlsTop = Math.max(
      stickReserve(env, 'online-quiz'),
      px(valueOf(rules, confirm, 'height', env), env) + px(valueOf(rules, root, '--walk-controls-bottom', env), env),
    );
    const margin = px(valueOf(rules, reveal, 'scroll-margin-bottom', env), env);
    assert.ok(margin > controlsTop, `${env.width}×${env.height}: 공개 카드 아래 여백 ${margin}px ≤ 조작부 ${controlsTop}px`);
    // 화면별 숫자를 따로 두지 않고 채팅 아래 비움과 같은 공용 크기를 쓴다
    assert.equal(margin, px(valueOf(rules, chat, 'margin-bottom', env), env), `${env.width}×${env.height}`);
  }
  // 짧은 가로 touch 화면(U15)은 두 열 배치의 양옆 여백이 조작부 자리라 카드가 그 아래로 들어가지 않는다.
  // 스틱 높이만큼 더 올리면 보기와 바닥만 화면 위로 더 밀려나므로 카드 끝을 아래 여백 안에만 들인다
  {
    const { root, stick, confirm } = controlTree({ screen: 'online-quiz' });
    const env = SHORT_LANDSCAPE;
    assert.equal(px(valueOf(rules, reveal, 'scroll-margin-bottom', env), env), 12);
    assert.ok(
      px(valueOf(rules, onlineQuiz, 'padding-left', env), env)
        >= px(valueOf(rules, root, '--walk-stick-left', env), env) + px(valueOf(rules, stick, 'width', env), env),
      '공개 카드는 스틱 오른쪽에서 시작한다',
    );
    assert.ok(
      px(valueOf(rules, onlineQuiz, 'padding-right', env), env)
        >= px(valueOf(rules, root, '--walk-confirm-right', env), env) + px(valueOf(rules, confirm, 'width', env), env),
      '공개 카드는 선택 버튼 왼쪽에서 끝난다',
    );
    assert.equal(valueOf(rules, reveal, 'grid-column', env), '1 / -1', '공개 카드는 두 열 아래에 폭을 다 쓴다');
  }
  // 조작부가 없는 마우스 기기에서는 카드 끝에 그대로 맞춘다
  assert.equal(px(valueOf(rules, reveal, 'scroll-margin-bottom', DESKTOP), DESKTOP), 0);
});

test('온라인 퀴즈: 걷는 캐릭터 뒤에 오는 표면(공개 카드·상태 줄·채팅)은 위치를 갖지 않는다 (css-responsive-02)', () => {
  // z-index 가 없어 DOM 순서가 겹침 순서다. #online-remote-characters·#online-arena-character(fixed)
  // 뒤에 오는 표면이 위치를 가지면 그 유리 바탕이 캐릭터와 말풍선을 덮는다
  const onlineQuiz = node("section.screen.quiz--character[data-screen='online-quiz']", node('main.app', node('body')));
  const surfaces = {
    '공개 카드': node('section.online-reveal#online-reveal', onlineQuiz),
    '상태 줄': node('p.online-match-status#online-match-status', onlineQuiz),
    채팅: node('section.online-quiz-chat', onlineQuiz),
  };
  for (const env of [DESKTOP, MOBILE, NARROW]) {
    for (const [label, surface] of Object.entries(surfaces)) {
      const position = valueOf(rules, surface, 'position', env);
      assert.ok(position === null || position === 'static', `${env.width}px ${label}: position ${position}`);
    }
  }
});


test('walking 목록·대기실·온라인 입력·arena는 초기·최대 scroll에서 양쪽 엄지 목표와 경쟁하지 않는다', () => {
  assert.match(css, /\[data-screen='waiting'\]:not\(\[hidden\]\) \.lounge \{[\s\S]*?margin-top: calc\(var\(--walk-controls-reserve\) \+ var\(--space-10\)\)/);
  assert.match(css, /\[data-screen='online-quiz'\]:not\(\[hidden\]\) \.online-quiz-chat__form \{[\s\S]*?margin-right: var\(--walk-controls-right-clearance\)[\s\S]*?margin-left: var\(--walk-controls-left-clearance\)/);
  assert.match(css, /\[data-screen='characters'\]:not\(\[hidden\]\) \.character-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)[\s\S]*?margin-right: var\(--walk-controls-right-clearance\)[\s\S]*?margin-left: var\(--walk-controls-left-clearance\)/);
  assert.match(css, /\.quiz--character:not\(\[hidden\]\) \.arena__grid \{[\s\S]*?margin-right: var\(--walk-controls-right-clearance\)[\s\S]*?margin-left: var\(--walk-controls-left-clearance\)/);
  assert.match(css, /\.ranking-tab \{[\s\S]*?min-width: var\(--tap\)/);

  assert.match(css, /\[data-screen='result'\]:not\(\[hidden\]\) \.result-actions,[\s\S]*?\[data-screen='result'\]:not\(\[hidden\]\) \.review \{[\s\S]*?margin-right: var\(--walk-controls-right-clearance\)[\s\S]*?margin-left: var\(--walk-controls-left-clearance\)/);
  assert.match(css, /max-height: 360px[\s\S]*?\[data-screen='characters'\]:not\(\[hidden\]\) \.character-grid \{[\s\S]*?margin-right: var\(--walk-controls-right-clearance\)[\s\S]*?margin-left: var\(--walk-controls-left-clearance\)/);
});
