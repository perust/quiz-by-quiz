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

test('screen walkers opt into centered targeting while specialized walkers retain foot targeting', async () => {
  const [screenWalker, walker] = await Promise.all([
    source('src/ui/screen-walker.ts'),
    source('src/ui/walker.ts'),
  ]);

  assert.match(screenWalker, /hitAnchor:\s*'center'/);
  assert.match(walker, /hitAnchor\s*=\s*'foot'/);
});
