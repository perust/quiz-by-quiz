import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP, MOBILE, NARROW, lengthOf, loadStyles, node, shorthandParts, valueOf } from './css-cascade.mjs';

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

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

function stickReserve(env) {
  const stick = node('div.walk-stick.walk-stick--on#walk-stick', node('main.app'));
  return px(valueOf(rules, stick, 'height', env), env) + px(valueOf(rules, stick, 'bottom', env), env);
}

/** 걷는 화면이 맨 아래에 비워 두는 높이 = .app 의 아래 여백 + 화면 자신의 아래 여백 */
function bottomSpace(screen, env, { stickOn = true } = {}) {
  const body = node('body', null, { has: stickOn ? ['.walk-stick--on'] : [] });
  const app = node('main.app', body);
  const section = node(`section.screen[data-screen='${screen}']`, app);
  return px(bottomOf(valueOf(rules, app, 'padding-bottom', env)), env)
    + px(bottomOf(valueOf(rules, section, 'padding-bottom', env)), env);
}

const WALKING_SCREENS = ['home', 'characters', 'ranking', 'result', 'online', 'waiting', 'quiz'];

test('손가락 조작부: 걷는 화면은 스틱 높이만큼 아래를 비워 마지막 행동도 스틱 위로 올릴 수 있다', () => {
  for (const env of [MOBILE, NARROW]) {
    const reserve = stickReserve(env);
    assert.ok(reserve >= 140, `스틱이 차지하는 높이를 읽지 못했다: ${reserve}`);
    for (const screen of WALKING_SCREENS) {
      assert.ok(
        bottomSpace(screen, env) >= reserve,
        `${env.width}×${env.height} ${screen}: 아래 여백 ${bottomSpace(screen, env)}px < 스틱 ${reserve}px`,
      );
    }
  }
});

test('손가락 조작부: 여백은 조작부가 떠 있을 때만이고, 온라인 퀴즈의 채팅 여백과 겹치지 않는다', () => {
  // 마우스 기기와 조작부를 거둔 화면(로컬 피드백 등)은 원래 여백 그대로다
  assert.equal(bottomSpace('home', DESKTOP), 48);
  assert.equal(bottomSpace('quiz', MOBILE, { stickOn: false }), 48);
  // 온라인 퀴즈는 채팅 블록이 이미 176px 를 비워 둔다. 두 번 비우면 빈 화면만 길어진다
  assert.equal(bottomSpace('online-quiz', MOBILE), 48);
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
  assert.notEqual(valueOf(rules, homeHint, 'display', DESKTOP), 'none');
  assert.notEqual(valueOf(rules, emptyCopy, 'display', DESKTOP), 'none');
});
