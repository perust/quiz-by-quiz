import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, node, nodeFromHtml, valueOf } from './css-cascade.mjs';

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
  const px = (value) => Number.parseFloat(value);

  const column = px(valueOf(rules, app, 'max-width', DESKTOP)) - 2 * px(valueOf(rules, app, 'padding-inline', DESKTOP));
  assert.equal(px(valueOf(rules, sheet, 'max-width', DESKTOP)), column);
});

test('피드백 시트: 판정은 글자색만이 아니라 시트 테두리와 ✓ ✗ 블록으로도 구분된다', () => {
  const body = node('body');
  const verdictOf = (state) => node('p.feedback__verdict::before', node(`div.feedback.feedback--${state}#feedback`, body));

  for (const env of [DESKTOP, MOBILE]) {
    assert.match(valueOf(rules, node('div.feedback.feedback--correct#feedback', body), 'border-color', env), /var\(--correct\)/);
    assert.match(valueOf(rules, node('div.feedback.feedback--wrong#feedback', body), 'border-color', env), /var\(--wrong\)/);
  }
  // 라이브 리전 안이라 기호를 다시 낭독하지 않도록 대체 글을 비운다
  assert.match(valueOf(rules, verdictOf('correct'), 'content', DESKTOP), /^'✓'\s*\/\s*''$/);
  assert.match(valueOf(rules, verdictOf('wrong'), 'content', DESKTOP), /^'✗'\s*\/\s*''$/);
});
