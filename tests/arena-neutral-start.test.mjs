import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const arena = await readFile(new URL('../src/ui/arena.ts', import.meta.url), 'utf8');

test('짧은 화면의 초기 clamp는 실제 이동 전까지 답으로 인정하지 않는다', () => {
  assert.match(arena, /let movedSinceReset = false/);
  assert.match(arena, /onMove: \(point, moving\) => \{[\s\S]*?if \(moving && !movedSinceReset\) \{[\s\S]*?movedSinceReset = true/);
  assert.match(arena, /markArenaTarget\(getChoiceNodes\(\), tileIndexOf\(standing\)\)/);
  assert.match(arena, /canPick: \(node\) => movedSinceReset \|\| indexOfNode\(node\) === null/);
  assert.match(arena, /reset\(choiceCount\) \{\s*movedSinceReset = false;[\s\S]*?walker\.setEnabled\(true\)/);
  assert.match(arena, /standingIndex\(\) \{\s*return enabled && movedSinceReset \? indexOfNode\(walker\.standingElement\(\)\) : null/);
});
