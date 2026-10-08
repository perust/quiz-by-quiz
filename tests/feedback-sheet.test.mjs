import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, lengthOf, loadStyles, node, nodeFromHtml, tokens, valueOf } from './css-cascade.mjs';

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

test('피드백 시트: 데스크톱에서도 읽기 폭을 넘지 않고 가운데 붙는다', () => {
  const sheet = nodeFromHtml(html, 'feedback');
  const px = (value) => lengthOf(rules, value, DESKTOP);

  // 앱은 이제 전체 월드 폭이라 max-width가 없다. 시트만 기존 읽기 열
  // (--content-max - 양쪽 page pad)을 유지해 해설 한 줄이 과도하게 길어지지 않는다.
  const root = tokens(rules, DESKTOP);
  const column = px(root.get('--content-max')) - 2 * px(root.get('--page-pad'));
  const width = px(valueOf(rules, sheet, 'max-width', DESKTOP));
  assert.ok(Number.isFinite(column) && column > 0, `콘텐츠 열 폭을 계산하지 못했다: ${column}`);
  assert.equal(width, column);
});

test('피드백 패널: 문서 흐름에서 arena 뒤에 이어져 질문·보기·바닥 칸을 덮지 않는다', () => {
  const sheet = nodeFromHtml(html, 'feedback');
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(valueOf(rules, sheet, 'position', env), 'relative');
    assert.equal(valueOf(rules, sheet, 'overflow-y', env), 'auto');
  }
});

test('피드백 패널: 자동 스크롤 뒤 fixed 캐릭터도 arena와 함께 옮기고 다음 문제에서 맨 위로 돌아온다', async () => {
  const [quiz, arena] = await Promise.all([source('src/ui/quiz.ts'), source('src/ui/arena.ts')]);
  assert.match(quiz, /scrollIntoView\(\{ block: 'end' \}\)/);
  assert.match(quiz, /feedbackCharacterAnchor = arena\.captureCharacterAnchor\(\)/);
  assert.match(quiz, /arena\.restoreCharacterAnchor\(feedbackCharacterAnchor\)/);
  assert.match(quiz, /if \(wasVisible\) window\.scrollTo\(0, 0\)/);
  assert.match(arena, /captureCharacterAnchor\(\)[\s\S]*?character\.bottom - grid\.top/);
  assert.match(arena, /restoreCharacterAnchor\(anchor\)[\s\S]*?grid\.top \+ anchor\.y/);
  assert.doesNotMatch(arena, /shiftForPageScroll/);
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
