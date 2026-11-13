import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, lengthOf, loadStyles, node, nodeFromHtml, valueOf } from './css-cascade.mjs';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test("홈은 게임 시작·분야·개인화·기록·도움말을 중앙 읽기 순서로 묶는다", async () => {
  const [html, homeSource, css] = await Promise.all([source("../index.html"), source("../src/ui/home.ts"), source("../css/style.css")]);
  const rules = await loadStyles(["css/style.css", "css/voxel-theme.css"]);
  const order = ["home-title", "home-quests", "open-online", "start-all", "category-grid", "open-nickname", "open-characters", "open-ranking", "open-rules"];
  order.reduce((previous, id) => { const at = html.indexOf(`id="${id}"`); assert.ok(at > previous, id); return at; }, -1);
  const hub = nodeFromHtml(html, "home-hub");
  for (const env of [DESKTOP, MOBILE, {...MOBILE, width:320, height:550}, {...MOBILE, width:480, height:320}]) {
    assert.equal(valueOf(rules, hub, "overflow", env), "auto");
    for (const id of order.slice(2)) assert.notEqual(valueOf(rules, nodeFromHtml(html,id), "position", env), "absolute", id);
    assert.equal(valueOf(rules, nodeFromHtml(html,"category-grid"), "grid-template-columns", env), "repeat(5, minmax(0, 1fr))");
  }
  for (const id of ["open-characters", "open-ranking", "open-rules"]) {
    const item = nodeFromHtml(html,id);
    assert.ok(item.parent.classes.includes("home-menu"), id);
    assert.equal(valueOf(rules,item,"width",MOBILE), "100%");
    assert.ok(lengthOf(rules,valueOf(rules,item,"min-height",MOBILE),MOBILE)>=44);
  }
  // 배치만 바뀐다. 기존 이름·목적지·아이콘·단일 캐릭터·공용 조작부 소유권은 그대로 잠근다.
  const home = between(html, "data-screen=\"home\"", "data-screen=\"quiz\"");
  const shortcuts = between(home, "<nav class=\"home-menu\"", "</nav>");
  const quests = between(home, "class=\"home-quests\"", "class=\"home-secondary\"");
  const nickname = between(home, "id=\"open-nickname\"", "</button>");
  assert.match(shortcuts, /aria-label="홈 바로가기"/);
  assert.match(shortcuts, /id="open-characters"[^>]*aria-label="캐릭터 모습 바꾸기"[\s\S]*data-icon="palette"/);
  assert.match(shortcuts, /id="open-ranking"[^>]*aria-label="랭킹: 이 브라우저의 최고 기록 보기"[\s\S]*data-icon="trophy"/);
  assert.doesNotMatch(shortcuts, /id="open-online"|id="my-character-figure"/);
  assert.match(quests, /id="home-quests" role="group" aria-label="게임 선택"/);
  assert.equal((quests.match(/class="challenge-card challenge-card--/g) ?? []).length, 2);
  assert.match(quests, /id="open-online"[\s\S]*data-icon="users"[\s\S]*challenge-card__name">온라인<\/span>/);
  assert.match(nickname, /menu-card__edit" aria-hidden="true"/);
  assert.doesNotMatch(homeSource, /createBody|characterFigure|controls:|home-dock|--home-dock-h/);
  assert.match(homeSource, /category-card__name category-card__name--compact/);
  assert.match(homeSource, /`\$\{category\.name\} 문제 풀기, 최고 \$\{bestScore\}점`/);
  assert.doesNotMatch(css, /\.walk-controls\[data-placement|home-dock|--home-dock-h/);
  assert.doesNotMatch(css, /\.home-header \{\s*display: none/);
  assert.match(html, /menu-card__label">닉네임<\/span>/);
  assert.match(html, /menu-card__desc sr-only">바꾸기/);
  assert.match(html, /menu-card__name">게임 방법<\/span>/);
  assert.match(homeSource, /const box = el\.hub\.getBoundingClientRect\(\)/);
  assert.match(homeSource, /y: box\.bottom \+ el\.walker\.offsetHeight \+ 8/);
  assert.doesNotMatch(homeSource, /ResizeObserver|MutationObserver|syncDockHeight|--home-dock-h|shortHomeStartPoint/);
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
  const quests = html.slice(html.indexOf('id="home-quests"'), html.indexOf('class="home-secondary"'));
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
      assert.equal(valueOf(rules, quests, 'width', env), '100%', at);
      assert.equal(valueOf(rules, quests, 'border', env), 'var(--border-1) solid var(--border)', at);
      assert.equal(valueOf(rules, grid, 'grid-template-columns', env), 'repeat(5, minmax(0, 1fr))', `${at}: 다섯 칸 한 줄`);
      const dock = Math.min(width - 24, 600) - 8 - 2 * 1 - 2 * px(quests, 'padding', env);
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

