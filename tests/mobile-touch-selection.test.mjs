import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const css = (await source('../css/style.css')).replace(/\/\*[\s\S]*?\*\//g, '');

// 소스 규칙은 선택 정책의 회귀만 검사한다. 네이티브 제스처는 별도 브라우저 QA로 확인한다.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
  selectors: selectors.split(',').map((selector) => selector.trim()),
  body,
}));

function assertDeclaration(selector, property, expected) {
  const bodies = rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body);
  const values = bodies.flatMap((body) =>
    [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))]
      .map((match) => match[1].trim()));
  assert.equal(values.at(-1), expected, `${selector}: ${property}는 ${expected}여야 한다`);
}

const gameSurfaces = ['.app', '.app-bar', '.feedback', '.dialog-backdrop'];
const editable = [
  'input',
  'textarea',
  'select',
  "[contenteditable]:not([contenteditable='false' i])",
  "[contenteditable]:not([contenteditable='false' i]) *",
];

for (const property of ['user-select', '-webkit-user-select']) {
  test(`게임 영역은 ${property}로 네이티브 텍스트 선택을 막는다`, () => {
    for (const selector of gameSurfaces) assertDeclaration(selector, property, 'none');
  });

  test(`편집 필드와 편집 가능한 자손은 ${property}로 텍스트 선택을 되살린다`, () => {
    for (const selector of editable) assertDeclaration(selector, property, 'text');
  });
}

test('게임 영역은 WebKit의 길게 누르기 메뉴를 막는다', () => {
  for (const selector of gameSurfaces) assertDeclaration(selector, '-webkit-touch-callout', 'none');
});

test('편집 필드와 편집 가능한 자손은 기본 길게 누르기 메뉴를 유지한다', () => {
  for (const selector of editable) assertDeclaration(selector, '-webkit-touch-callout', 'default');
});

test('직접 누르는 버튼과 답 타일은 더블 탭 확대만 막고 스크롤과 핀치 줌을 허용한다', () => {
  for (const selector of ['button', '.arena-tile']) {
    assertDeclaration(selector, 'touch-action', 'manipulation');
  }
});

test('이동 스틱은 드래그하는 동안 브라우저 스크롤을 막는다', () => {
  assertDeclaration('.walk-stick', 'touch-action', 'none');
});

// 선택 버튼은 뗄 때 확정한다. 누른 엄지가 조금 구르는 사이 브라우저가 스크롤로 가져가면
// pointercancel 로 취소되어 «눌렀는데 안 된다»가 되므로 스틱과 같이 제스처를 받지 않는다.
test('선택 버튼은 누른 채 구르는 엄지를 스크롤로 빼앗기지 않는다', () => {
  assertDeclaration('.walk-confirm', 'touch-action', 'none');
});

test('고정 조작부(스틱·선택) 밖의 게임 영역이나 페이지 전체에 터치 제스처 금지를 확장하지 않는다', () => {
  for (const rule of rules) {
    if (/(?:^|;)\s*touch-action\s*:\s*none\s*;/.test(rule.body)) {
      assert.ok(
        ['.walk-stick', '.walk-confirm'].includes(rule.selectors.join(', ')),
        `touch-action: none 은 고정 조작부 하나씩에만 둔다: ${rule.selectors.join(', ')}`,
      );
    }
  }
});

test('뷰포트 설정은 사용자의 확대 기능을 제한하지 않는다', async () => {
  const html = await source('../index.html');
  const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/);
  assert.ok(viewport, '뷰포트 설정이 있어야 한다');
  assert.doesNotMatch(viewport[1], /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=/i);
});
