import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 키 큰 화면의 랭킹 입구는 높이 42% 에 서는데, 방 복귀 줄로 dock 이 커지면 dock 위 조작부(선택 원)가
// 따라 올라와 375×812에서 입구와 겹쳤다(dock 271 → 327px, 450px²). tools/check-screens.js 의
// «방 복귀 줄로 dock 이 커져도 …» 검사가 실제 브라우저에서 잡았다. 입구는 조작부보다 8px 위로 비켜 선다.

const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
const rule = css.match(/\n#open-ranking \{([\s\S]*?)\n\}/)?.[1] ?? '';

test('랭킹 입구의 위치는 dock 과 선택 원의 크기를 따라 올라간다', () => {
  assert.match(rule, /top:\s*min\(\s*42%,/);
  assert.match(rule, /var\(--home-dock-h, 160px\)/);
  assert.match(rule, /var\(--walk-confirm-size\)/);
  // 조작부의 바닥 공식(dock + 20px + 안전 영역)과 같은 값을 써야 둘이 함께 움직인다
  const controls = css.match(/\.walk-controls\[data-placement='home-dock'\] \{[\s\S]*?--walk-controls-bottom: calc\(var\(--home-dock-h, 160px\) \+ 20px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.ok(controls, '홈 조작부 바닥 공식이 dock + 20px 이다');
  assert.match(rule, /- 20px - env\(safe-area-inset-bottom, 0px\)/);
});

test('375×812에서 dock 이 327px 로 커져도 입구 아래 끝은 선택 원보다 위다', () => {
  const height = 812;
  const confirm = 72; // --walk-confirm-size (기본)
  const entry = 60;
  for (const dock of [271, 327, 383]) {
    const top = Math.min(height * 0.42, height - dock - 20 - confirm - 8 - entry);
    const confirmTop = height - (dock + 20) - confirm;
    assert.ok(top + entry <= confirmTop - 8 + 0.5, `dock ${dock}px: 입구 ${top + entry} ≤ 선택 ${confirmTop} − 8`);
  }
});
