import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
const theme = await readFile(new URL('../css/voxel-theme.css', import.meta.url), 'utf8');
const home = await readFile(new URL('../src/ui/home.ts', import.meta.url), 'utf8');
const rule = css.match(/\n#open-ranking \{([\s\S]*?)\n\}/)?.[1] ?? '';

test('랭킹 입구와 홈 메뉴는 dock 실측값 대신 공용 하단 reserve를 따른다', () => {
  assert.match(rule, /top:\s*min\(42%, calc\(100% - var\(--walk-controls-reserve\) - 60px - var\(--space-2\)\)\)/);
  assert.match(theme, /--walk-controls-reserve: calc\([\s\S]*?var\(--walk-stick-size\)[\s\S]*?var\(--walk-controls-edge\)[\s\S]*?safe-area-inset-bottom/);
  assert.match(css, /body:has\(\.walk-controls--on\) \[data-screen='home'\]:not\(\[hidden\]\) \.home-quests \{[\s\S]*?bottom: var\(--walk-controls-reserve\)/);
  assert.doesNotMatch(`${css}\n${home}`, /home-dock|--home-dock-h|data-placement|syncDockHeight|ResizeObserver|MutationObserver/);
});

test('키 큰 viewport의 랭킹 입구는 공용 reserve 경계 위에 남는다', () => {
  const reserve = 96 + 16 + 8;
  const entry = 60;
  const gap = 8;
  for (const height of [812, 844]) {
    const top = Math.min(height * 0.42, height - reserve - entry - gap);
    assert.ok(top + entry <= height - reserve - gap + 0.5, `${height}px: 입구 ${top + entry}px`);
  }
});
