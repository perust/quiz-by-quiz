import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MOBILE, lengthOf, loadStyles, node, valueOf } from './css-cascade.mjs';

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
  assert.match(shortcuts, /id="open-ranking"[^>]*aria-label="랭킹: 이 브라우저의 최고 기록 보기"[\s\S]*?data-icon="trophy"[\s\S]*?<span class="menu-card__name">랭킹<\/span>/);
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

  // 홈의 월드 배치는 홈 무대 절 하나에 있다. 예전에는 맨 끝 30절(월드 우선 화면 구성)이 이 절의 같은
  // 선택자를 뒤에서 다시 썼는데 U49 에서 이 절로 녹였다 — 아래 «높이 700px 이하»는 이긴 값으로 본다
  const worldFirst = between(css, '/* ── 홈 무대 기본 구조', '/* ── 화면 머리');
  const narrowHome = between(
    css,
    '@media (max-width: 420px) {\n  .home-header',
    '@media (max-height: 700px)',
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
  // 높이 700px 이하: 닉네임 칸이 좁아지고 연필을 거두며, 두 보조 입구가 dock 바로 위로 내려오고 브랜드는 접힌다.
  // 같은 사실을 파일 안의 글 순서가 아니라 그 환경에서 이긴 값으로 본다 (규칙이 제 절의 여러 블록에 나뉘어 있다)
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const short = { ...MOBILE, width: 390, height: 700 };
  const homeChain = node("div.home-stage#home-stage", node("section.screen[data-screen='home']"));
  const player = node('div.home-player', homeChain);
  const nickname = node('button.menu-card.menu-card--wide#open-nickname', player);
  assert.equal(valueOf(rules, player, 'width', short), '120px');
  assert.equal(valueOf(rules, nickname, 'grid-template-columns', short), '36px minmax(0, 1fr)');
  assert.equal(valueOf(rules, node('span.menu-card__edit', nickname), 'display', short), 'none');
  const shortcutsNav = node('nav.home-menu', homeChain);
  for (const id of ['open-characters', 'open-ranking']) {
    const entry = node(`button.menu-card#${id}`, shortcutsNav);
    assert.equal(valueOf(rules, entry, 'top', short), 'auto', `${id} top`);
    assert.match(valueOf(rules, entry, 'bottom', short), /^calc\(var\(--home-dock-h/, `${id} bottom`);
  }
  assert.equal(valueOf(rules, node('header.home-header', homeChain), 'position', short), 'absolute');
  assert.equal(valueOf(rules, node('header.home-header', homeChain), 'width', short), '1px');
  assert.match(homeSource, /controls: \{ placement: 'home-dock' \}/);
  assert.doesNotMatch(css, /body:has\(\[data-screen='home'[^)]*\)\s+\.walk-(?:stick|confirm)/);
  assert.match(css, /\.walk-controls\[data-placement='home-dock'\] \{[\s\S]*?--home-dock-h/);
  // 두 줄 dock의 짧은 가로 홈은 가운데 anchor다 — 높이 421–480px도 두 줄이다 (layout-01)
  assert.match(css, /@media \(pointer: coarse\) and \(max-height: 480px\) and \(min-width: 480px\)[\s\S]*?\.walk-controls\[data-placement='home-dock'\] \{[\s\S]*?--walk-stick-left: calc\(50% - 140px\)/);
  assert.match(homeSource, /new MutationObserver\(syncDockHeight\)/);
  assert.doesNotMatch(css, /\.home-header \{\s*display: none/);
  assert.match(css, /\.home-note \{[\s\S]*?bottom: calc\(var\(--home-dock-h/);
  assert.match(css, /body:has\(\.home-note:not\(\[hidden\]\)\) #home-character \{\s*display: none/);
});

test('홈 문제 카드는 문제 은행 크기를 문구로 노출하지 않는다 — 판 길이는 상수에서 말한다 (U04)', async () => {
  const [html, css, homeSource, rulesSource] = await Promise.all([
    source('../index.html'),
    source('../css/style.css'),
    source('../src/ui/home.ts'),
    source('../src/ui/round-rules.ts'),
  ]);

  // #94 의 금지는 그대로다: «과학 120문제»처럼 **은행 크기**를 보이면 판마다 그만큼 푸는 줄 안다.
  // 좁힌 것은 그것뿐이다 — 은행과 분리된 상수에서 온 한 판의 길이(분야 10문제·전체 도전 25문제)는 보인다
  assert.doesNotMatch(homeSource, /\$\{count\}\s*문제|\.length\}\s*문제/, '분야 은행 크기를 문구로 쓰지 않는다');
  assert.doesNotMatch(rulesSource, /banks?|Question/, '판 길이 글은 은행을 보지 않는다 — 상수만 읽는다');
  assert.match(rulesSource, /`분야 골라 \$\{QUESTIONS_PER_ROUND\}문제`/);
  assert.match(rulesSource, /ALL_ROUND_QUESTIONS = QUESTIONS_PER_CATEGORY_IN_ALL \* CATEGORIES\.length/);
  assert.match(homeSource, /el\.caption\.textContent = categoryDockCaption\(\);/);
  assert.match(homeSource, /const length = allRoundLength\(allCount\);/, '전체 도전 길이는 실제로 나갈 문항 수다');
  assert.doesNotMatch(homeSource, /category-card__count/);
  assert.doesNotMatch(css, /category-card__count/);
  assert.match(html, /id="start-all-meta" hidden/);

  // 분야 dock 위 캡션이 분야 칸 묶음의 이름이다
  const quests = html.slice(html.indexOf('id="home-quests"'), html.indexOf('class="home-primary-actions"'));
  assert.match(quests, /<p class="home-quests__caption" id="category-caption"><\/p>\s*<div class="category-grid" id="category-grid" role="group" aria-labelledby="category-caption"><\/div>/);
  assert.ok(quests.indexOf('id="home-room-note"') < quests.indexOf('id="category-caption"'), '복귀 줄은 여전히 dock 맨 위다');

  // 문제 유무에 따른 선택 가능 여부와 최고 점수 표시는 그대로 유지한다.
  assert.match(homeSource, /card\.disabled = count === 0/);
  assert.match(homeSource, /el\.startAll\.disabled = allCount === 0/);
  assert.match(homeSource, /최고 \$\{bestScore\}점/);
  assert.match(homeSource, /최고 \$\{best\}점/);
  // 기록이 없으면 «25문제», 있으면 «최고 N점» — 접근 가능한 이름도 같다
  assert.match(homeSource, /el\.startAllMeta\.textContent = hasBest \? `최고 \$\{best\}점` : length;/);
  assert.match(homeSource, /hasBest \? `전체 도전, 최고 \$\{best\}점` : `전체 도전, \$\{length\}`/);
  assert.match(homeSource, /best\.textContent = String\(bestScore\)/, '분야 최고점은 dock 안에서 짧은 숫자로 보인다');
  assert.doesNotMatch(css, /\.challenge-card__desc,\s*\.challenge-card__meta\s*\{\s*display: none/);
});

test('dock 분야 이름은 폭 420px 이하에서만 12px 이고, 넓은 화면의 14px 이름도 다섯 칸 한 줄 안에 든다 (U53)', async () => {
  const [constants, homeSource] = await Promise.all([source('../src/constants.ts'), source('../src/ui/home.ts')]);
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const fullNames = Object.fromEntries([...constants.matchAll(/id: '([a-z]+)', name: '([^']+)'/g)].map((match) => [match[1], match[2]]));
  const compactBlock = homeSource.slice(homeSource.indexOf('COMPACT_CATEGORY_NAMES'), homeSource.indexOf('};', homeSource.indexOf('COMPACT_CATEGORY_NAMES')));
  const compactNames = Object.fromEntries([...compactBlock.matchAll(/([a-z]+): '([^']+)'/g)].map((match) => [match[1], match[2]]));
  assert.equal(Object.keys(fullNames).length, 5);
  assert.deepEqual(compactNames, { general: '상식', art: '예술' });

  const body = node('body', null, { has: ["[data-screen='home']:not([hidden])"] });
  const stage = node('div.home-stage#home-stage', node("section.screen[data-screen='home']", node('main.app', body)));
  const quests = node('div.home-quests#home-quests', stage);
  const grid = node('div.category-grid#category-grid', quests);
  const px = (element, property, env) => lengthOf(rules, valueOf(rules, element, property, env), env);

  // 칸의 안쪽 폭을 실제 캐스케이드 값(dock 여백·칸 사이·칸 여백)으로 셈한다. dock 폭 공식·테두리·칸 배치가
  // 바뀌면 그 단언들이 먼저 실패하므로 이 셈도 함께 고친다
  for (const height of [844, 600]) {
    for (const width of [320, 360, 390, 420, 421, 440, 458, 467, 480, 481, 500, 560, 599, 600, 768, 1280]) {
      const env = { ...MOBILE, width, height };
      const at = `${width}×${height}`;
      assert.equal(valueOf(rules, quests, 'width', env), 'min(calc(100% - var(--space-6)), 700px)', at);
      assert.equal(valueOf(rules, quests, 'border', env), 'var(--border-1) solid var(--border)', at);
      assert.equal(valueOf(rules, grid, 'grid-template-columns', env), 'repeat(5, minmax(0, 1fr))', `${at}: 다섯 칸 한 줄`);
      const dock = Math.min(width - 24, 700) - 2 * 1 - 2 * px(quests, 'padding', env);
      const cell = (dock - 4 * px(grid, 'gap', env)) / 5;
      for (const [id, fullName] of Object.entries(fullNames)) {
        const card = node(`button.category-card[data-category='${id}']`, grid);
        assert.match(valueOf(rules, card, 'border', env), /^var\(--border-2\) /, at);
        assert.equal(valueOf(rules, card, 'grid-template-columns', env), '1fr', `${at}: 이름이 칸 폭을 다 쓴다`);
        const inner = cell - 2 * px(card, 'padding', env) - 2 * 2;
        const full = node('span.category-card__name.category-card__name--full', card);
        const compact = node('span.category-card__name.category-card__name--compact', card);
        const shown = valueOf(rules, full, 'display', env) === 'none' ? compact : full;
        assert.notEqual(valueOf(rules, shown, 'display', env), 'none', `${at}: 이름 하나는 보인다`);
        const size = px(shown, 'font-size', env);
        assert.equal(size, width <= 420 ? 12 : 14, `${at}: 분야 이름 글자 크기`);
        // 맑은 고딕의 한글은 한 자가 1em 이다 — 가장 넓은 시스템 글꼴로 잰다
        const text = shown === full ? fullName : (compactNames[id] ?? fullName);
        assert.ok(text.length * size <= inner, `${at}: 「${text}」 ${text.length * size}px 가 칸 안쪽 ${inner.toFixed(1)}px 를 넘는다`);
      }
    }
  }
});

