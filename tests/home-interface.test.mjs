import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test('홈 바로가기는 월드 가장자리 HUD이고 캐릭터는 입구 아래 월드에서 시작한다', async () => {
  const [html, css, homeSource] = await Promise.all([
    source('../index.html'),
    source('../css/style.css'),
    source('../src/ui/home.ts'),
  ]);
  const home = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const shortcuts = between(home, '<nav class="home-menu"', '</nav>');

  assert.ok(home.indexOf('id="open-nickname"') < home.indexOf('<nav class="home-menu"'));
  assert.match(home, /<nav class="home-menu" aria-label="홈 바로가기">/);
  assert.equal((shortcuts.match(/class="menu-card"/g) ?? []).length, 3);
  // 아이콘은 글리프가 아니라 디자인 시스템 아이콘이다. 낭독은 버튼의 aria-label 이 맡는다
  assert.match(shortcuts, /id="open-characters"[^>]*aria-label="캐릭터 모습 바꾸기"[\s\S]*?<span class="menu-card__figure" data-icon="palette" aria-hidden="true"><\/span>[\s\S]*?<span class="menu-card__name">캐릭터<\/span>/);
  assert.match(shortcuts, /id="open-ranking"[^>]*aria-label="랭킹에서 최고 기록 보기"[\s\S]*?data-icon="trophy"[\s\S]*?<span class="menu-card__name">랭킹<\/span>/);
  assert.match(shortcuts, /id="open-online"[^>]*aria-label="온라인에서 친구와 풀기"[\s\S]*?data-icon="users"[\s\S]*?<span class="menu-card__name">온라인<\/span>/);
  assert.doesNotMatch(shortcuts, /id="my-character-figure"/);
  assert.doesNotMatch(homeSource, /createBody|characterFigure/);
  assert.match(homeSource, /x: box\.left \+ box\.width \/ 2/);
  assert.match(homeSource, /y: box\.bottom \+ el\.walker\.offsetHeight \+ 6/);
  assert.match(homeSource, /general: '상식'/);
  assert.match(homeSource, /art: '예술'/);
  assert.match(homeSource, /`\$\{category\.name\} 문제 풀기, 최고 \$\{bestScore\}점`/, '전체 분야 이름과 최고 점수를 함께 낭독한다');
  assert.match(homeSource, /category-card__name category-card__name--compact/);
  assert.match(homeSource, /new ResizeObserver\(syncDockHeight\)/);
  assert.match(homeSource, /--home-dock-h/);
  assert.match(homeSource, /window\.innerHeight <= 700/);

  const worldFirst = between(css, '/* ── 30. 월드 우선 화면 구성', '@media (max-height: 700px)');
  assert.match(worldFirst, /\.home-menu \{[\s\S]*?display: contents/);
  assert.match(worldFirst, /#open-ranking \{[\s\S]*?left: max\(/);
  assert.match(worldFirst, /#open-online \{[\s\S]*?right: max\(/);
  assert.match(worldFirst, /\.category-grid \{[\s\S]*?repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(worldFirst, /\.category-card:nth-child\(odd\):last-child \{[\s\S]*?grid-column: auto/);
  assert.doesNotMatch(css, /\.menu-card:nth-child\(odd\):last-child/);
  assert.match(css, /\.menu-card__name \{[\s\S]*?white-space: nowrap/);
  assert.match(worldFirst, /\.home-menu \.menu-card \{[\s\S]*?min-height: 64px/);
  assert.match(css, /@media \(max-height: 700px\)[\s\S]*?#open-characters,[\s\S]*?bottom: calc\(var\(--home-dock-h/);
  assert.doesNotMatch(css, /\[data-screen='home'\][^{}]*\.walk-stick[^{}]*\{[^}]*display:\s*none/);
  assert.match(css, /@media \(pointer: coarse\) and \(max-height: 700px\)[\s\S]*?\[data-screen='home'\][^{}]*\.walk-stick \{[\s\S]*?--home-dock-h[\s\S]*?width: 80px/);
  assert.match(css, /@media \(pointer: coarse\) and \(max-height: 420px\) and \(min-width: 480px\)[\s\S]*?\.walk-stick \{[\s\S]*?left: calc\(50% - 140px\)/);
  assert.match(css, /@media \(max-height: 700px\)[\s\S]*?\.home-header \{[\s\S]*?position: absolute;[\s\S]*?width: 1px/);
  assert.doesNotMatch(css, /\.home-header \{\s*display: none/);
  assert.match(css, /\.home-note \{[\s\S]*?bottom: calc\(var\(--home-dock-h/);
  assert.match(css, /body:has\(\.home-note:not\(\[hidden\]\)\) #home-character \{\s*display: none/);
});

test('홈 문제 카드는 문제 은행 크기를 문구로 노출하지 않는다', async () => {
  const [html, css, homeSource] = await Promise.all([
    source('../index.html'),
    source('../css/style.css'),
    source('../src/ui/home.ts'),
  ]);

  assert.doesNotMatch(homeSource, /\$\{count\}문제|\$\{allCount\}문제/);
  assert.doesNotMatch(homeSource, /category-card__count/);
  assert.doesNotMatch(css, /category-card__count/);
  assert.match(html, /id="start-all-meta" hidden/);

  // 문제 유무에 따른 선택 가능 여부와 최고 점수 표시는 그대로 유지한다.
  assert.match(homeSource, /card\.disabled = count === 0/);
  assert.match(homeSource, /el\.startAll\.disabled = allCount === 0/);
  assert.match(homeSource, /최고 \$\{bestScore\}점/);
  assert.match(homeSource, /최고 \$\{best\}점/);
  assert.match(homeSource, /best\.textContent = String\(bestScore\)/, '분야 최고점은 dock 안에서 짧은 숫자로 보인다');
  assert.doesNotMatch(css, /\.challenge-card__desc,\s*\.challenge-card__meta\s*\{\s*display: none/);
});
