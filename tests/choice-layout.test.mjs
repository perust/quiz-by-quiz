import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, lengthOf, loadStyles, node, valueOf } from './css-cascade.mjs';

// 짧은 보기 넷은 좁은 화면에서도 2×2 (U16).
// 375×812 휴대폰에서 보기가 한 줄에 하나면 네 줄이 세로를 먹어, 답한 뒤 결과 패널과 질문이 한 화면에
// 들지 않았다 — 패널 끝에 맞추느라 질문 첫 줄이 위로 25px 잘렸다(문서 높이 947px).
// 넷이 모두 짧은 문항(은행의 약 97%)은 바닥 칸과 같은 2×2로 놓아 두 줄로 줄인다.

const { choiceLayout } = await import('../js/ui/choice-layout.js');
const { SHORT_CHOICE_MAX_LENGTH } = await import('../js/constants.js');

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const PHONE = { width: 375, height: 812, pointer: 'coarse', hover: 'none', reducedMotion: false };

async function loadBank() {
  const dir = new URL('../data/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const banks = await Promise.all(files.map(async (name) => JSON.parse(await readFile(new URL(name, dir), 'utf8'))));
  return banks.flat();
}

test('배치 표시: 보기 넷이 모두 12자 이하(앞뒤 공백 제외)일 때만 grid 다', () => {
  assert.equal(SHORT_CHOICE_MAX_LENGTH, 12);
  const twelve = '가나다라마바사아자차카타';
  assert.equal(choiceLayout(['조선', '고려', '신라', twelve]), 'grid', '12자는 짧다');
  assert.equal(choiceLayout(['조선', '고려', '신라', `${twelve}파`]), 'list', '13자가 하나라도 있으면 한 줄에 하나');
  assert.equal(choiceLayout(['조선', '고려', '신라', `  ${twelve}  `]), 'grid', '앞뒤 공백은 세지 않는다');
  assert.equal(choiceLayout(['21.0975킬로미터', '42.195킬로미터', '10킬로미터', '5킬로미터']), 'grid');
});

test('실제 은행: grid 는 정확히 «넷이 모두 12자 이하»인 문항에만 붙고, 대부분의 문항이 여기 든다', async () => {
  const bank = await loadBank();
  assert.ok(bank.length > 0);
  let grid = 0;
  for (const question of bank) {
    const expected = question.choices.every((text) => [...text.trim()].length <= 12) ? 'grid' : 'list';
    assert.equal(choiceLayout(question.choices), expected, `${question.id}: ${question.choices.join(' / ')}`);
    if (expected === 'grid') grid += 1;
  }
  // 설계의 전제: 2×2가 보통이고 긴 보기 문항만 한 줄에 하나다. 은행을 바꿔 이 비율이 무너지면 다시 본다
  assert.ok(grid / bank.length >= 0.9, `짧은 문항 비율 ${(grid / bank.length * 100).toFixed(1)}%`);
  assert.ok(grid < bank.length, '긴 보기 문항도 은행에 있어 한 줄 배치가 실제로 쓰인다');
});

test('로컬 퀴즈와 온라인 매치가 같은 배치 표시를 단다', async () => {
  const [quiz, online] = await Promise.all([source('src/ui/quiz.ts'), source('src/ui/online-quiz.ts')]);
  assert.match(quiz, /function renderChoices\(question: Question\): void \{\s*el\.choices\.replaceChildren\(\);[\s\S]*?el\.choices\.dataset\.layout = choiceLayout\(question\.choices\);/);
  // 온라인은 새 문항으로 보기를 다시 지을 때만 단다. 공개·제출 표시는 같은 노드를 고쳐 쓴다
  assert.match(online, /el\.choices\.replaceChildren\(\.\.\.items\);\s*(?:\/\/.*\n\s*)*el\.choices\.dataset\.layout = choiceLayout\(question\.choices\);/);
});

for (const screen of ['quiz', 'online-quiz']) {
  const section = node(`section.screen.quiz--character[data-screen='${screen}']`, node('main.app', node('body')));
  const list = (layout) => node(`ul.choices[data-layout='${layout}']`, section);
  const item = (layout) => node('li', list(layout));
  const choice = (layout, state = '') => node(`button.choice${state}`, item(layout));

  test(`${screen}: 375px 휴대폰에서도 짧은 보기 넷은 2×2, 긴 보기는 한 줄에 하나다`, () => {
    for (const env of [PHONE, MOBILE, NARROW]) {
      const at = `${env.width}px`;
      assert.equal(valueOf(rules, list('grid'), 'display', env), 'grid', at);
      assert.equal(valueOf(rules, list('grid'), 'grid-template-columns', env), 'repeat(2, minmax(0, 1fr))', at);
      // 한 줄의 두 보기 높이를 맞춘다 — 넓은 화면의 2×2와 같다
      assert.equal(valueOf(rules, item('grid'), 'display', env), 'flex', at);
      assert.equal(valueOf(rules, choice('grid'), 'flex', env), '1', at);

      assert.equal(valueOf(rules, list('list'), 'display', env), 'flex', `${at} 긴 보기`);
      assert.equal(valueOf(rules, list('list'), 'flex-direction', env), 'column', `${at} 긴 보기`);
    }
  });

  test(`${screen}: 좁은 2×2도 직접 누르는 보기는 44px 이상이고, 칸 안에서 글을 끊고 판정은 모양만 남긴다`, () => {
    for (const env of [PHONE, NARROW]) {
      const at = `${env.width}px`;
      assert.ok(lengthOf(rules, valueOf(rules, choice('grid'), 'min-height', env), env) >= 44, `${at} 터치 목표`);
      assert.equal(valueOf(rules, choice('grid'), 'padding', env), 'var(--space-2)', `${at} 글자 자리를 넓힌다`);
      assert.equal(valueOf(rules, node('span.choice__text', choice('grid')), 'overflow-wrap', env), 'anywhere', `${at} 띄어 쓸 데 없는 긴 낱말`);

      // ✓ ✗ ⧗ 알약은 아이콘 한 칸 폭만 보이고 글은 잘려 낭독용으로만 남는다
      const mark = node('span.choice__mark', choice('grid', '.choice--correct'));
      assert.equal(lengthOf(rules, valueOf(rules, mark, 'width', env), env), 24, at);
      assert.equal(valueOf(rules, mark, 'overflow', env), 'hidden', at);
      assert.equal(valueOf(rules, mark, 'display', env), 'inline-flex', `${at} 글을 display:none 으로 숨기지 않는다`);
    }
    // 긴 보기 한 줄 배치와 넓은 화면의 알약은 그대로 글을 보인다
    for (const env of [PHONE, DESKTOP]) {
      const mark = node('span.choice__mark', choice('list', '.choice--correct'));
      assert.equal(valueOf(rules, mark, 'overflow', env), null, `${env.width}px 한 줄 배치`);
    }
    assert.equal(valueOf(rules, node('span.choice__mark', choice('grid', '.choice--correct')), 'overflow', DESKTOP), null, '넓은 화면');
  });

  test(`${screen}: 넓은 화면은 배치 표시와 관계없이 지금처럼 2×2다`, () => {
    for (const layout of ['grid', 'list']) {
      assert.equal(valueOf(rules, list(layout), 'display', DESKTOP), 'grid', layout);
      assert.match(valueOf(rules, list(layout), 'grid-template-columns', DESKTOP), /^repeat\(2,/, layout);
    }
  });
}
