import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP, MOBILE, NARROW, loadStyles, node, valueOf } from './css-cascade.mjs';

// 온라인 CTA 에만 «친구와 함께 · 2명부터» 보조 줄이 붙은 뒤, 420px 이하에서 두 버튼이 한 줄에
// 하나씩 쌓이고 아이콘 칸이 36px로 줄면 온라인만 3px 남짓 커졌다(375×812에서 57px 대 54px).
// tools/check-screens.js 의 «같은 크기의 주요 버튼» 검사가 실제 브라우저에서 잡았다.
// 쌓인 두 행도 같은 높이가 되도록 묶음이 행 높이를 맞춘다.

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const PHONE = { ...MOBILE, width: 375, height: 812 };

test('온라인과 전체 도전 묶음은 쌓여도 두 행의 높이가 같다', () => {
  const actions = node('div.home-primary-actions', node('div.home-quests#home-quests', node('section.screen')));
  for (const env of [DESKTOP, MOBILE, PHONE, NARROW]) {
    assert.equal(valueOf(rules, actions, 'display', env), 'grid', `${env.width}px`);
    assert.equal(valueOf(rules, actions, 'grid-auto-rows', env), '1fr', `${env.width}px: 쌓인 행도 같은 높이`);
  }
});
