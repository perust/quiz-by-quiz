import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStyles, node, selectorMatches } from './css-cascade.mjs';

// 아이콘은 mask 를 씌운 배경색(currentColor)으로 그린다. 강제 색상(고대비) 모드는 그 배경을
// Canvas 로 다시 칠해, 목록에 빠진 아이콘은 바탕과 같은 색의 빈칸이 된다. 홈의 «방에 아직 있어요»
// 줄과 로비의 «게임 중» 배지가 그렇게 빠졌다. 이름 목록을 손으로 맞추지 않고, mask 아이콘을 모두
// 찾아 강제 색상 규칙이 시스템 글자색으로 다시 칠하는지 본다.

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const isForced = (rule) => rule.media.some((query) => query.includes('forced-colors: active'));

/** 강제 색상에서 mask 아이콘을 시스템 글자색으로 다시 칠하는 규칙 */
const repaint = rules.filter((rule) => isForced(rule)
  && rule.declarations.some(({ property, value }) => property === 'forced-color-adjust' && value === 'none')
  && rule.declarations.some(({ property, value }) => /^background(-color)?$/.test(property) && value === 'CanvasText'));

/** 같은 선택자이거나, 한 덩어리 선택자면 더 넓은 선택자가 그 요소를 덮는다 (`.waiting-ready::before`) */
function covered(selector) {
  return repaint.some((rule) => rule.selectors.some((candidate) => candidate === selector
    || (!/\s/.test(selector) && selectorMatches(candidate, node(selector)))));
}

test('강제 색상 모드: currentColor 로 칠하는 mask 아이콘은 모두 시스템 글자색으로 다시 칠한다', () => {
  const icons = rules
    .filter((rule) => !isForced(rule)
      && rule.declarations.some(({ property }) => property === 'mask' || property === '-webkit-mask')
      && rule.declarations.some(({ property, value }) => /^background(-color)?$/.test(property) && /^currentColor$/i.test(value)))
    .flatMap((rule) => rule.selectors);

  assert.ok(icons.length >= 20, `mask 아이콘을 찾지 못했다: ${icons.length}`);
  assert.deepEqual(icons.filter((selector) => !covered(selector)), [], '강제 색상에서 사라지는 아이콘');
});

test('강제 색상 모드: 이번에 빠졌던 아이콘을 이름으로도 붙든다', () => {
  for (const selector of ['.home-room-note::before', '.room-item__status::before', '.category-card__best::before', '.feedback__answer-label::before']) {
    assert.ok(covered(selector), selector);
  }
});
