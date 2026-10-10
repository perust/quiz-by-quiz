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

test('홈 보조 바로가기는 edge HUD, 온라인과 전체 도전은 같은 크기의 주요 진입점이다', async () => {
  const [html, css, homeSource] = await Promise.all([
    source('../index.html'),
    source('../css/style.css'),
    source('../src/ui/home.ts'),
  ]);
  const home = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const shortcuts = between(home, '<nav class="home-menu"', '</nav>');
  const quests = between(home, 'class="home-quests"', 'id="home-character"');
  const profile = between(home, 'id="open-nickname"', '</button>');

  assert.ok(home.indexOf('id="open-nickname"') < home.indexOf('<nav class="home-menu"'));
  assert.match(profile, /menu-card__label">닉네임<\/span>[\s\S]*menu-card__name" id="nickname-value">퀴즈왕/);
  assert.match(profile, /menu-card__desc sr-only">바꾸기/);
  assert.match(profile, /menu-card__edit" aria-hidden="true"/);
  assert.match(home, /<nav class="home-menu" aria-label="홈 바로가기">/);
  assert.equal((shortcuts.match(/class="menu-card"/g) ?? []).length, 2);
  // 아이콘은 글리프가 아니라 디자인 시스템 아이콘이다. 낭독은 버튼의 aria-label 이 맡는다
  assert.match(shortcuts, /id="open-characters"[^>]*aria-label="캐릭터 모습 바꾸기"[\s\S]*?<span class="menu-card__figure" data-icon="palette" aria-hidden="true"><\/span>[\s\S]*?<span class="menu-card__name">캐릭터<\/span>/);
  assert.match(shortcuts, /id="open-ranking"[^>]*aria-label="랭킹에서 최고 기록 보기"[\s\S]*?data-icon="trophy"[\s\S]*?<span class="menu-card__name">랭킹<\/span>/);
  assert.doesNotMatch(shortcuts, /id="open-online"/);
  assert.match(quests, /id="home-quests" role="group" aria-label="게임 선택"/);
  assert.match(quests, /class="home-primary-actions"[\s\S]*?class="challenge-card challenge-card--online" id="open-online"[\s\S]*?data-icon="users"[\s\S]*?<span class="challenge-card__name">온라인<\/span>[\s\S]*?class="challenge-card challenge-card--all" id="start-all"/);
  assert.equal((quests.match(/class="challenge-card challenge-card--/g) ?? []).length, 2);
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
  const narrowHome = between(
    css,
    '@media (max-width: 420px) {\n  .category-card__name--full',
    '@media (max-width: 360px)',
  );
  assert.match(worldFirst, /\.home-menu \{[\s\S]*?display: contents/);
  assert.match(worldFirst, /#open-ranking \{[\s\S]*?right: max\(/);
  assert.doesNotMatch(worldFirst, /#open-online\s*\{/);
  assert.match(worldFirst, /\.category-grid \{[\s\S]*?repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(worldFirst, /\.home-primary-actions \{[\s\S]*?width: min\(568px, 100%\)/);
  assert.match(worldFirst, /\.category-card:nth-child\(odd\):last-child \{[\s\S]*?grid-column: auto/);
  assert.doesNotMatch(css, /\.menu-card:nth-child\(odd\):last-child/);
  assert.match(css, /\.menu-card__name \{[\s\S]*?white-space: nowrap/);
  assert.match(worldFirst, /\.home-menu \.menu-card \{[\s\S]*?min-height: 64px/);
  assert.match(worldFirst, /\.menu-card--wide \{[\s\S]*?grid-template-columns: 36px minmax\(0, 1fr\) 16px/);
  assert.match(worldFirst, /\.menu-card--wide \.menu-card__edit \{[\s\S]*?display: block/);
  assert.match(narrowHome, /\.home-primary-actions \{[\s\S]*?grid-template-columns: minmax\(0, 280px\)/);
  assert.match(css, /@media \(max-height: 700px\)[\s\S]*?\.home-player \{[\s\S]*?width: 120px[\s\S]*?\.menu-card--wide \{[\s\S]*?grid-template-columns: 36px minmax\(0, 1fr\)[\s\S]*?\.menu-card--wide \.menu-card__edit \{[\s\S]*?display: none/);
  assert.match(css, /@media \(max-height: 700px\)[\s\S]*?#open-characters,[\s\S]*?bottom: calc\(var\(--home-dock-h/);
  assert.match(homeSource, /controls: \{ placement: 'home-dock' \}/);
  assert.doesNotMatch(css, /body:has\(\[data-screen='home'[^)]*\)\s+\.walk-(?:stick|confirm)/);
  assert.match(css, /\.walk-controls\[data-placement='home-dock'\] \{[\s\S]*?--home-dock-h/);
  assert.match(css, /@media \(pointer: coarse\) and \(max-height: 420px\) and \(min-width: 480px\)[\s\S]*?\.walk-controls\[data-placement='home-dock'\] \{[\s\S]*?--walk-stick-left: calc\(50% - 140px\)/);
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
  assert.match(homeSource, /best === null \|\| best === undefined \? '전체 도전' : `전체 도전, 최고 \$\{best\}점`/);
  assert.match(homeSource, /best\.textContent = String\(bestScore\)/, '분야 최고점은 dock 안에서 짧은 숫자로 보인다');
  assert.doesNotMatch(css, /\.challenge-card__desc,\s*\.challenge-card__meta\s*\{\s*display: none/);
});
