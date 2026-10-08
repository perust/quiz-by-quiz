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

test('홈 바로가기는 닉네임 아래 한 줄에 모이고 좁은 화면에서는 세로로 압축된다', async () => {
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
  assert.match(homeSource, /x: box\.right - 20/);

  assert.match(css, /\.home-menu \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /\.menu-card:nth-child\(odd\):last-child/);
  assert.match(css, /\.menu-card__name \{[\s\S]*?white-space: nowrap/);

  const narrow = between(
    css,
    '/* 좁은 화면의 dock 은 아이콘과 짧은 이름만 세로로 쌓는다.',
    '/* 마을 패널',
  );
  assert.match(narrow, /@media \(max-width: 576px\)/);
  assert.match(narrow, /\.home-menu \.menu-card \{[\s\S]*?flex-direction: column[\s\S]*?min-height: (\d+)px/);
  assert.ok(Number(narrow.match(/min-height: (\d+)px/)[1]) >= 44, '세로로 쌓아도 손가락 목표는 44px 이상이다');
  assert.match(narrow, /\.home-menu \.menu-card__desc \{[\s\S]*?display: none/);
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
});
