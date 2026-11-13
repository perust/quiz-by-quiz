import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, nodeFromHtml, valueOf } from './css-cascade.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const ids = ['open-nickname', 'open-characters', 'open-ranking', 'open-rules', 'open-online', 'start-all', 'category-grid'];

test('모든 홈 진입점은 중앙 메뉴의 같은 DOM 묶음에 남고 보조 행동은 게임 아래에 읽힌다', () => {
  for (const id of ids) {
    const item = nodeFromHtml(html, id);
    const ancestors = [];
    for (let at = item.parent; at; at = at.parent) ancestors.push(at.id);
    assert.ok(ancestors.includes('home-hub'), `${id}: 중앙 메뉴의 자손이어야 한다`);
  }
  assert.ok(html.indexOf('id="start-all"') < html.indexOf('id="open-nickname"'), '게임 진입 다음에 개인화·기록·도움말을 둔다');
  assert.match(html, /menu-card__name">게임 방법<\/span>/, '도움말은 아이콘뿐 아니라 보이는 이름을 갖는다');
});

test('중앙 메뉴는 스크롤 가능한 보통 흐름이고 바로가기는 절대 위치로 흩어지지 않는다', () => {
  const hub = nodeFromHtml(html, 'home-hub');
  for (const env of [DESKTOP, MOBILE, { ...MOBILE, width: 320, height: 550 }, { ...MOBILE, width: 480, height: 320 }]) {
    assert.equal(valueOf(rules, hub, 'overflow', env), 'auto');
    for (const id of ids.slice(0, 6)) {
      assert.notEqual(valueOf(rules, nodeFromHtml(html, id), 'position', env), 'absolute', `${id}: ${env.width}×${env.height}`);
    }
  }
});
