import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP, MOBILE, NARROW, loadStyles, node, valueOf } from './css-cascade.mjs';

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const TABLET = { ...DESKTOP, width: 768, height: 1024 };

test('넓은 화면의 보기는 바닥 칸과 같은 2×2로 놓여 번호 자리가 그대로 이어진다', () => {
  for (const screen of ['quiz', 'online-quiz']) {
    const section = node(`section.screen.quiz--character[data-screen='${screen}']`, node('main.app', node('body')));
    const choices = node('ul.choices', section);

    for (const env of [DESKTOP, TABLET]) {
      assert.equal(valueOf(rules, choices, 'display', env), 'grid', `${screen} ${env.width}px`);
      assert.match(valueOf(rules, choices, 'grid-template-columns', env), /^repeat\(2,/, `${screen} ${env.width}px`);
    }
    // 좁은 화면에서는 긴 보기를 먼저 다 읽을 수 있게 한 줄에 하나씩 둔다
    for (const env of [MOBILE, NARROW]) {
      assert.equal(valueOf(rules, choices, 'display', env), 'flex', `${screen} ${env.width}px`);
      assert.equal(valueOf(rules, choices, 'flex-direction', env), 'column', `${screen} ${env.width}px`);
    }
  }
});

test('넓은 화면의 캐릭터 고르기는 4열로 펼쳐 납작한 빈 카드를 줄이고, 좁으면 3열을 지킨다', () => {
  const grid = node('div.character-grid#character-grid', node('div.character-stage'));
  assert.match(valueOf(rules, grid, 'grid-template-columns', DESKTOP), /^repeat\(4,/);
  assert.match(valueOf(rules, grid, 'grid-template-columns', MOBILE), /^repeat\(3,/);
  assert.match(valueOf(rules, grid, 'grid-template-columns', NARROW), /^repeat\(3,/);
});
