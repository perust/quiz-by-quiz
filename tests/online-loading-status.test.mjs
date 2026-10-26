import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('opening an authoritative online match presents snapshot loading as a notice, not an error', async () => {
  const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /onlineQuizScreen\.setNotice\('매치를 불러오는 중이에요\.'\)/,
  );
  assert.doesNotMatch(
    source,
    /onlineQuizScreen\.setError\('매치를 불러오는 중이에요\.'\)/,
  );
  // 플레이어에게 의미 없는 개발 용어(«서버»)를 안내 문구에 쓰지 않는다 (U40)
  assert.doesNotMatch(source, /setNotice\('[^']*서버/);
});
