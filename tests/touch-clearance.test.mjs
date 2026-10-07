import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP, MOBILE, NARROW, loadStyles, node, valueOf } from './css-cascade.mjs';

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

/** calc(48px + var(--x, 0px)) 같은 값의 px 합. 대체값과 env() 는 0 으로 본다 */
function px(value) {
  if (!value) return 0;
  return [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

/** padding 단축 속성에서 아래쪽 값만 */
function bottomOf(value) {
  if (!value) return null;
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ' ' && depth === 0) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts.length === 1 ? parts[0] : parts[2] ?? parts[0];
}

function stickReserve(env) {
  const stick = node('div.walk-stick.walk-stick--on#walk-stick', node('main.app'));
  return px(valueOf(rules, stick, 'height', env)) + px(valueOf(rules, stick, 'bottom', env));
}

/** 걷는 화면이 맨 아래에 비워 두는 높이 = .app 의 아래 여백 + 화면 자신의 아래 여백 */
function bottomSpace(screen, env, { stickOn = true } = {}) {
  const body = node('body', null, { has: stickOn ? ['.walk-stick--on'] : [] });
  const app = node('main.app', body);
  const section = node(`section.screen[data-screen='${screen}']`, app);
  return px(bottomOf(valueOf(rules, app, 'padding-bottom', env)))
    + px(bottomOf(valueOf(rules, section, 'padding-bottom', env)));
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
    assert.ok(px(valueOf(rules, row, 'min-height', env)) >= 44, `${env.width}px: 줄 높이`);
    assert.equal(valueOf(rules, row, 'align-items', env), 'stretch', `${env.width}px: 라벨이 줄 높이를 다 채운다`);
    assert.equal(px(bottomOf(valueOf(rules, row, 'padding-bottom', env))), 0, `${env.width}px: 줄의 위아래 여백은 라벨 안으로 옮긴다`);
    assert.equal(valueOf(rules, label, 'flex', env), '1', `${env.width}px: 라벨이 남은 폭을 다 쓴다`);
    assert.equal(valueOf(rules, input, 'flex', env), 'none', `${env.width}px: 좁은 화면에서도 체크박스가 찌그러지지 않는다`);
  }
});
