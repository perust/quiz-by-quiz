import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('screen walker targets the visible character center instead of the point below it', async () => {
  const { walkerHitPoint } = await import('../js/ui/walker-geometry.js');
  const logicalPosition = { x: 853.044, y: 100.798 };
  const characterSize = { width: 40, height: 48 };
  const leaveButton = { top: 52, bottom: 99.594 };

  const foot = walkerHitPoint(logicalPosition, characterSize, 'foot');
  const center = walkerHitPoint(logicalPosition, characterSize, 'center');

  assert.deepEqual(foot, { x: 853.044, y: 99.798 });
  assert.deepEqual(center, { x: 853.044, y: 76.798 });
  assert.equal(foot.y > leaveButton.bottom, true);
  assert.equal(center.y >= leaveButton.top && center.y <= leaveButton.bottom, true);
});

// U10: 선택점은 화면마다 고르지 않는다. 워커의 기본값(몸통 가운데)을 모든 화면이 쓰고, 넘기는 곳은
// 퀴즈 무대의 발끝 하나다. 화면마다의 실측은 tests/walker-pick-point.test.mjs 가 잠근다
test('every walker shares the centred default and only the quiz arena opts into foot targeting', async () => {
  const [screenWalker, walker, arena] = await Promise.all([
    source('src/ui/screen-walker.ts'),
    source('src/ui/walker.ts'),
    source('src/ui/arena.ts'),
  ]);
  const { DEFAULT_WALKER_HIT_ANCHOR } = await import('../js/ui/walker-geometry.js');

  assert.equal(DEFAULT_WALKER_HIT_ANCHOR, 'center');
  assert.match(walker, /hitAnchor\s*=\s*DEFAULT_WALKER_HIT_ANCHOR/);
  assert.doesNotMatch(screenWalker, /hitAnchor:/, 'screen walker 는 홈·내 캐릭터와 같은 기본값을 쓴다');
  assert.match(arena, /hitAnchor:\s*'foot'/);
});
