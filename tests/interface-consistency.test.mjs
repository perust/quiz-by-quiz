import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function block(text, selector) {
  const clean = withoutComments(text);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = clean.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`));
  assert.ok(match, `missing flat selector block: ${selector}`);
  return match[1];
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test('앱의 반복 조작과 필터 입력은 44px 이상 터치 목표를 공유한다', async () => {
  const css = await source('../css/style.css');
  for (const selector of [
    '.icon-button',
    '.online-home',
    '.button--small',
    '.room-filter .room-form__input',
    '.chat__input',
    '.ranking-tab',
  ]) {
    assert.match(block(css, selector), /min-height:\s*44px\s*;/, selector);
  }
});

test('좁은 랭킹 화면은 여섯 필터를 숨기지 않고 3열로 보여 준다', async () => {
  const css = withoutComments(await source('../css/style.css'));
  const mobile = between(css, '@media (max-width: 576px) {\n  .ranking-tabs', '\n.ranking-list {');

  assert.match(mobile, /display:\s*grid\s*;/);
  assert.match(mobile, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)\s*;/);
  assert.match(mobile, /overflow-x:\s*visible\s*;/);
});

test('결과의 다음 행동은 긴 오답 풀이보다 먼저 온다', async () => {
  const html = await source('../index.html');
  const result = between(html, 'data-screen="result"', 'data-screen="ranking"');
  const stats = result.indexOf('class="result-stats"');
  const actions = result.indexOf('class="result-actions"');
  const register = result.indexOf('id="register-form"');
  const review = result.indexOf('id="result-review-block"');

  assert.ok(stats !== -1 && actions !== -1 && register !== -1 && review !== -1);
  assert.ok(stats < actions, '결과 행동은 요약 통계 뒤에 와야 한다');
  assert.ok(actions < register, '다음 행동은 랭킹 등록보다 먼저 보여야 한다');
  assert.ok(register < review, '긴 오답 풀이는 등록 뒤에 와야 한다');
});
