import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, lengthOf, loadStyles, node, nodeFromHtml, shorthandParts, tokens, valueOf } from './css-cascade.mjs';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const html = await source('index.html');

test('피드백 시트: 「다음 문제」의 키 표시는 시트가 실제로 놓인 자리에서 마우스·키보드 기기에만 보인다', () => {
  // 시트는 z-index 없이 위에 오려고 <main> 밖에 있다. 퀴즈 화면의 자손이 아니므로
  // «.quiz--character .key-hint» 같은 규칙은 이 표시에 닿지 않는다.
  const keyHint = node('span.key-hint', nodeFromHtml(html, 'next-button'));

  assert.equal(valueOf(rules, keyHint, 'display', DESKTOP), 'inline-flex', '키보드가 있는 기기에서는 보인다');
  assert.equal(valueOf(rules, keyHint, 'display', MOBILE), 'none', '손가락 기기에서는 쓸모가 없다');
  assert.equal(
    valueOf(rules, keyHint, 'display', { ...DESKTOP, width: 380 }),
    'none',
    '좁으면 버튼 글자와 부딪혀 접는다',
  );
});

test('피드백 시트: 데스크톱에서 콘텐츠 열과 같은 폭으로 붙는다', () => {
  const app = node('main.app', node('body'));
  const sheet = nodeFromHtml(html, 'feedback');
  const px = (value) => lengthOf(rules, value, DESKTOP);

  // 토큰을 풀어 실제 px 로 비교한다. 풀지 못하면 NaN 이 되어 «NaN === NaN» 으로 통과하던
  // 빈 검사가 되지 않게, 숫자인지부터 확인한다
  const max = px(valueOf(rules, app, 'max-width', DESKTOP));
  const inline = shorthandParts(valueOf(rules, app, 'padding-inline', DESKTOP)).map(px);
  const column = max - (inline.length === 1 ? 2 * inline[0] : inline[0] + inline[1]);
  const width = px(valueOf(rules, sheet, 'max-width', DESKTOP));
  assert.ok(Number.isFinite(column) && column > 0, `콘텐츠 열 폭을 계산하지 못했다: ${column}`);
  assert.equal(width, column);
});

test('피드백 시트: 판정은 글자색만이 아니라 시트 테두리와 ✓ ✗ 배지로도 구분된다', () => {
  const body = node('body');
  const sheetOf = (state) => node(`div.feedback.feedback--${state}#feedback`, body);
  const verdictOf = (state) => node('p.feedback__verdict::before', sheetOf(state));
  const root = tokens(rules, DESKTOP);

  for (const env of [DESKTOP, MOBILE]) {
    assert.match(valueOf(rules, sheetOf('correct'), 'border-color', env), /var\(--correct\)/);
    assert.match(valueOf(rules, sheetOf('wrong'), 'border-color', env), /var\(--wrong\)/);
  }

  // 배지는 상태 색으로 채운 칸 위의 흰 아이콘이다. 정답은 체크, 오답·시간 초과는 엑스 —
  // 색을 못 보는 사람에게도 모양이 다르다
  const badge = {
    correct: valueOf(rules, verdictOf('correct'), '--badge-icon', DESKTOP),
    wrong: valueOf(rules, verdictOf('wrong'), '--badge-icon', DESKTOP),
  };
  assert.equal(badge.correct, 'var(--i-check-inverse)');
  assert.equal(badge.wrong, 'var(--i-cross-inverse)');
  for (const name of ['--i-check-inverse', '--i-cross-inverse']) {
    assert.match(root.get(name) ?? '', /^url\("data:image\/svg\+xml,.*viewBox='0 0 24 24'/, `${name} 는 24×24 아이콘이다`);
  }
  assert.equal(valueOf(rules, verdictOf('correct'), '--badge-color', DESKTOP), 'var(--correct)');
  assert.equal(valueOf(rules, verdictOf('wrong'), '--badge-color', DESKTOP), 'var(--wrong)');
  assert.match(valueOf(rules, verdictOf('correct'), 'background', DESKTOP), /var\(--badge-icon\)[\s\S]*var\(--badge-color\)/);

  // 라이브 리전 안이라 배지는 다시 낭독할 글자가 없어야 한다
  for (const state of ['correct', 'wrong']) {
    assert.equal(valueOf(rules, verdictOf(state), 'content', DESKTOP), "''");
  }
});
