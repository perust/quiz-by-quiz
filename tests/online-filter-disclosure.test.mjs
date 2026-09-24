import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('방 목록 필터는 첫 진입에 접혀 있고 헤더 토글로 명시적으로 연다', async () => {
  const [html, online, style] = await Promise.all([
    source('../index.html'),
    source('../src/ui/online.ts'),
    source('../css/style.css'),
  ]);

  assert.match(
    html,
    /id="room-filter-toggle"[^>]*aria-controls="room-filters"[^>]*aria-expanded="false"/,
  );
  assert.match(html, /<form class="room-filters" id="room-filters" hidden>/);
  assert.ok(
    html.indexOf('id="room-filter-toggle"') < html.indexOf('id="room-list-summary"'),
    '필터 토글은 목록 헤더에 있어야 한다',
  );
  assert.match(online, /filterToggle: need<HTMLButtonElement>\('room-filter-toggle'\)/);
  assert.match(
    online,
    /function setFiltersExpanded\(expanded: boolean\): void \{[\s\S]*?el\.filters\.hidden = !expanded;[\s\S]*?aria-expanded/,
  );
  assert.match(
    online,
    /el\.filterToggle\.addEventListener\('click', \(\) => setFiltersExpanded\(Boolean\(el\.filters\.hidden\)\)\);/,
  );
  assert.match(
    online,
    /async show\(characterId, notice\) \{[\s\S]*?setFiltersExpanded\(false\);[\s\S]*?await loadRooms\(request\);/,
  );
  assert.match(style, /\.room-filters\[hidden\]\s*\{\s*display: none;/);
});

test('닫힌 필터 버튼은 적용된 조건 수를 알려 준다', async () => {
  const online = await source('../src/ui/online.ts');

  assert.match(online, /function activeFilterCount\(filters: RoomListFilters\): number/);
  assert.match(online, /`필터 \(\$\{activeCount\}개 적용\)`/);
});
