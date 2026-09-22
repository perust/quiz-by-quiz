import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('opening an authoritative online match presents snapshot loading as a notice, not an error', async () => {
  const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /onlineQuizScreen\.setNotice\('서버 매치 상태를 불러오는 중입니다\.'\)/,
  );
  assert.doesNotMatch(
    source,
    /onlineQuizScreen\.setError\('서버 매치 상태를 불러오는 중입니다\.'\)/,
  );
});
