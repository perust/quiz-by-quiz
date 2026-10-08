import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, node, valueOf } from './css-cascade.mjs';

// 브라우저와 같은 순서로 읽는다. 디자인 층(voxel-theme.css)이 뒤에 와서 같은 명시도에서 이긴다.
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const quiz = node("section.screen.quiz--character[data-screen='quiz']", node('main.app', node('body')));
const choice = (descriptor) => node(descriptor, node('li', node('ul.choices', quiz)));
const tile = (descriptor) => node(
  descriptor,
  node('div.arena__grid', node('div.arena__stage', node('div.arena', quiz))),
);

/** 눈에 보이는 상태 = 배경 + 테두리 색 */
function look(element, env) {
  return ['background', 'border-color'].map((property) => valueOf(rules, element, property, env)).join(' | ');
}

test('정답 공개: 정답·오답 보기는 공통 표면 규칙에 덮이지 않고 제 상태색을 쓴다', () => {
  for (const env of [DESKTOP, MOBILE]) {
    const correct = choice('button.choice.choice--correct:disabled');
    const wrong = choice('button.choice.choice--wrong:disabled');
    assert.match(valueOf(rules, correct, 'background', env), /var\(--correct-soft\)/);
    assert.match(valueOf(rules, correct, 'border-color', env), /var\(--correct\)/);
    assert.match(valueOf(rules, wrong, 'background', env), /var\(--wrong-soft\)/);
    assert.match(valueOf(rules, wrong, 'border-color', env), /var\(--wrong\)/);
  }
});

test('정답 공개: 바닥의 정답·오답 칸도 상태색으로 칠해 ✓ ✗ 표시와 함께 읽힌다', () => {
  for (const env of [DESKTOP, MOBILE]) {
    const correct = tile("div.arena-tile.arena-tile--correct[data-selectable='false']");
    const wrong = tile("div.arena-tile.arena-tile--wrong[data-selectable='false']");
    assert.match(valueOf(rules, correct, 'background', env), /var\(--correct-soft\)/);
    assert.match(valueOf(rules, correct, 'border-color', env), /var\(--correct\)/);
    assert.match(valueOf(rules, wrong, 'background', env), /var\(--wrong-soft\)/);
    assert.match(valueOf(rules, wrong, 'border-color', env), /var\(--wrong\)/);
  }
});

test('선택 상태: 고른 캐릭터·방금 등록한 기록·내 최종 순위는 평범한 카드와 구분된다', () => {
  const pairs = [
    ['button.character-card', 'button.character-card.character-card--on'],
    ['li.ranking-item', 'li.ranking-item.ranking-item--mine'],
    ['li.online-final-ranking__item', 'li.online-final-ranking__item.online-final-ranking__item--mine'],
  ];
  for (const [plain, selected] of pairs) {
    for (const env of [DESKTOP, MOBILE]) {
      assert.notEqual(look(node(selected), env), look(node(plain), env), selected);
      assert.match(valueOf(rules, node(selected), 'background', env), /var\(--(?:purple|accent)-soft\)/, selected);
    }
  }
});

test('상호작용: 마우스 hover는 캐릭터가 선 보기나 정답처럼 칠하지 않고, 터치에서는 남지 않는다', () => {
  const idle = choice('button.choice');
  const hover = choice('button.choice:hover');
  const standing = choice('button.choice.is-standing');
  const correct = choice('button.choice.choice--correct:disabled');

  assert.notEqual(look(hover, DESKTOP), look(idle, DESKTOP), '마우스에는 눌릴 수 있다는 반응이 있어야 한다');
  assert.notEqual(look(hover, DESKTOP), look(standing, DESKTOP), 'hover는 캐릭터 위치(불 켜진 칸)와 달라야 한다');
  assert.doesNotMatch(valueOf(rules, hover, 'background', DESKTOP), /--(?:purple|accent)-soft/, 'hover는 고른 것처럼 채우지 않는다');
  assert.notEqual(look(standing, DESKTOP), look(correct, DESKTOP), '캐릭터 위치는 확정된 정답처럼 보이지 않는다');
  // 손가락으로 스크롤하다 스친 보기에 hover가 남으면 고르지 않은 답이 골라진 것처럼 보인다
  assert.equal(look(hover, MOBILE), look(idle, MOBILE), '터치 기기의 남은 hover는 아무 표시도 하지 않는다');
});

test('상호작용: 마우스로 보기를 누르는 동안 hover보다 아래로 눌리고 그림자가 접힌다', () => {
  const hover = choice('button.choice:hover');
  const pressed = choice('button.choice:hover:active');
  // hover 는 한 칸 들리고(음수) 떠 있는 그림자(높이 2)를 갖는다. 누르면 아래로(양수) 내려앉고
  // 그림자가 사라진다 — 색이 아니라 높이로 «눌렸다»가 읽힌다
  assert.match(valueOf(rules, hover, 'translate', DESKTOP), /^0 -\d+px$/);
  assert.equal(valueOf(rules, hover, 'box-shadow', DESKTOP), 'var(--elevation-2)');
  assert.match(valueOf(rules, pressed, 'translate', DESKTOP), /^0 [1-9]\d*px$/);
  assert.equal(valueOf(rules, pressed, 'box-shadow', DESKTOP), 'none');
});

test('캐릭터 위치: 바닥 칸 위에 서면 같은 번호의 위 보기에도 같은 불이 켜진다', async () => {
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(
      look(choice('button.choice[data-arena-target]'), env),
      look(choice('button.choice.is-standing'), env),
      '칸 번호만으로는 무슨 답인지 모른다. 위 보기가 같은 표시로 이어 준다',
    );
    assert.equal(
      look(choice('button.choice.choice--correct[data-arena-target]:disabled'), env),
      look(choice('button.choice.choice--correct:disabled'), env),
      '채점 뒤에는 표시가 정답 색을 덮지 않는다',
    );
  }

  const { markArenaTarget } = await import('../js/ui/arena-state.js');
  const fakeChoice = () => {
    const attrs = new Set();
    return {
      attrs,
      toggleAttribute(name, force) {
        if (force) attrs.add(name);
        else attrs.delete(name);
        return force;
      },
    };
  };
  const choices = [fakeChoice(), fakeChoice(), fakeChoice(), fakeChoice()];
  markArenaTarget(choices, 2);
  assert.deepEqual(choices.map((item) => item.attrs.has('data-arena-target')), [false, false, true, false]);
  markArenaTarget(choices, null);
  assert.deepEqual(choices.map((item) => item.attrs.has('data-arena-target')), [false, false, false, false]);

  const arena = await source('src/ui/arena.ts');
  assert.match(arena, /onStep:\s*\(node\)\s*=>\s*\{[\s\S]*?markArenaTarget\(getChoiceNodes\(\),\s*movedSinceReset \? tileIndexOf\(node\) : null\)/);
  // 워커는 꺼질 때 발밑 표시(is-standing)만 거두고 onStep 은 부르지 않는다.
  // 무대를 끌 때 위 보기의 표시도 함께 거둬야 꺼진 무대의 불이 남지 않는다
  assert.match(arena, /if \(!enabled\) \{[^}]*markArenaTarget\(getChoiceNodes\(\), null\);[^}]*return;\s*\}/);
});

test('랭킹: 순위는 칸 안의 숫자로 서고 1·2·3위는 서로 다른 칸이라 위에서부터 훑어 읽힌다', () => {
  const list = node('ol.ranking-list#ranking-list', node("section.screen[data-screen='ranking']"));
  const rank = (place) => node('span.ranking-item__rank', node(`li.ranking-item:nth-child(${place})`, list));

  for (const env of [DESKTOP, MOBILE]) {
    const [first, second, third, fourth] = [1, 2, 3, 4].map((place) => valueOf(rules, rank(place), 'background', env));
    assert.ok(fourth, '순위 숫자는 맨 글자가 아니라 칸 안에 놓인다');
    assert.equal(new Set([first, second, third]).size, 3, '1·2·3위 칸은 서로 다르다');
    assert.ok(![first, second, third].includes(fourth), '4위부터는 같은 평범한 칸이다');
  }
});

test('온라인 제출 대기: «제출됨» 보기는 캐릭터 위치·정답 공개와 다른 기다림 표시로 남는다', () => {
  // 공통 표면 규칙에 덮여 «제출됨» 글자만 남고 보기 자체는 평범했다
  const online = node("section.screen.online-quiz.quiz--character[data-screen='online-quiz']", node('main.app', node('body')));
  const onlineChoice = (descriptor) => node(descriptor, node('li', node('ul.choices#online-choices', online)));
  const submitted = onlineChoice('button.choice.choice--submitted:disabled');

  for (const env of [DESKTOP, MOBILE]) {
    const others = [
      ['평범한 보기', onlineChoice('button.choice')],
      ['캐릭터 위치', onlineChoice('button.choice.is-standing')],
      ['정답 공개', onlineChoice('button.choice.choice--correct:disabled')],
    ];
    for (const [label, other] of others) {
      assert.notEqual(look(submitted, env), look(other, env), `${env.width}px: ${label}와 구분된다`);
    }
  }
});

test('온라인 정답 공개: 정답·오답 판정은 서로 다른 선과 아이콘을 받고 렌더러가 상태 클래스를 갱신한다', async () => {
  const screen = node("section.screen.online-quiz.quiz--character[data-screen='online-quiz']", node('main.app', node('body')));
  const correct = node('section.online-reveal.online-reveal--correct#online-reveal', screen);
  const wrong = node('section.online-reveal.online-reveal--wrong#online-reveal', screen);
  const correctMark = node('p.online-reveal__verdict::before', correct);
  const wrongMark = node('p.online-reveal__verdict::before', wrong);

  for (const env of [DESKTOP, MOBILE]) {
    assert.notEqual(valueOf(rules, correct, 'border-color', env), valueOf(rules, wrong, 'border-color', env));
    assert.equal(valueOf(rules, correctMark, '--badge-icon', env), 'var(--i-check-inverse)');
    assert.equal(valueOf(rules, wrongMark, '--badge-icon', env), 'var(--i-cross-inverse)');
  }

  const renderer = await source('src/ui/online-quiz.ts');
  assert.match(renderer, /el\.reveal\.classList\.toggle\('online-reveal--correct', reveal\?\.correct === true\)/);
  assert.match(renderer, /el\.reveal\.classList\.toggle\('online-reveal--wrong', reveal !== null && !reveal\.correct\)/);
});
