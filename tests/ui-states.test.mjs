import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, node, shorthandParts, valueOf, winning } from './css-cascade.mjs';

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

// ── 초점·올라섬 고리 (U44, U52) ────────────────────────────────────
// outline 단축 속성도 색을 정하므로 단축·개별 선언 가운데 실제로 이기는 쪽에서 색을 읽는다.
// 개별 선언만 보면 뒤에 온 단축 속성이 색을 되돌려도 테스트가 모른다.
function precedes(a, b) {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i += 1) {
    if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i];
  }
  return a.order > b.order;
}

/** 실제로 그려지는 고리의 색·띄움·선 모양 */
function ring(element, env) {
  const shorthand = winning(rules, element, 'outline', env);
  const color = winning(rules, element, 'outline-color', env);
  const offset = winning(rules, element, 'outline-offset', env);
  const shorthandWins = (longhand) => shorthand && (!longhand || precedes(shorthand, longhand));
  return {
    color: shorthandWins(color) ? shorthandParts(shorthand.value).at(-1) : color?.value ?? null,
    offset: offset?.value ?? null,
    style: shorthand ? shorthandParts(shorthand.value)[1] ?? null : null,
  };
}

// 키보드 초점이 «제 키를 쓰는 것»에 보이는 상태. CSS 의 :has() 인자와 글자 그대로 같아야 한다
const KEYBOARD_FOCUS = ":is(button, a[href], [role='button'], summary, input, textarea, select):focus-visible";
const pageRoot = (focusElsewhere) => node('html:root', null, { has: focusElsewhere ? [KEYBOARD_FOCUS] : [] });
const screenOf = (descriptor, focusElsewhere = false) => node(descriptor, node('main.app', node('body', pageRoot(focusElsewhere))));

/** 어두운 HUD 안의 버튼들 — 고리가 HUD 바탕 위에 그려진다 */
function darkHudButtons(focusElsewhere = false) {
  const quizHud = (screen) => node('header.quiz-header', node('div.quiz-hud', screenOf(screen, focusElsewhere)));
  const local = "section.screen.quiz--character[data-screen='quiz']";
  const online = "section.screen.online-quiz.quiz--character[data-screen='online-quiz']";
  const home = node('div.home-quests#home-quests', node('div.home-stage#home-stage', screenOf("section.screen[data-screen='home']", focusElsewhere)));
  const lobby = screenOf("section.screen[data-screen='online']", focusElsewhere);
  return [
    ['로컬 퀴즈 나가기', (state) => node(`button.button.button--ghost.button--small#quiz-exit${state}`, quizHud(local))],
    ['로컬 퀴즈 조작법', (state) => node(`button.arena__help#arena-help${state}`, quizHud(local))],
    ['온라인 퀴즈 나가기', (state) => node(`button.button.button--ghost.button--small#online-quiz-exit${state}`, quizHud(online))],
    ['온라인 퀴즈 조작법', (state) => node(`button.arena__help#online-arena-help${state}`, quizHud(online))],
    ['홈 전체 도전', (state) => node(`button.challenge-card.challenge-card--all#start-all${state}`, node('div.home-primary-actions', home))],
    ['홈 온라인', (state) => node(`button.challenge-card.challenge-card--online#open-online${state}`, node('div.home-primary-actions', home))],
    ['로비 동작 칸', (state) => node(`button.online-action-card#open-private-join${state}`, node('nav.online-actions', lobby))],
    ['로비 홈', (state) => node(`button.button.button--ghost.online-home#online-home${state}`, node('header.quiz-header.online-hero__header', node('div.online-hero', lobby)))],
    ['랭킹 홈', (state) => node(`button.button.button--ghost#ranking-home${state}`, node('header.ranking-header', screenOf("section.screen[data-screen='ranking']", focusElsewhere)))],
    ['캐릭터 홈', (state) => node(`button.button.button--ghost#characters-back${state}`, node('header.quiz-header', screenOf("section.screen[data-screen='characters']", focusElsewhere)))],
    ['대기실 나가기', (state) => node(`button.button.button--ghost#waiting-leave${state}`, node('header.quiz-header', screenOf("section.screen[data-screen='waiting']", focusElsewhere)))],
  ];
}

test('초점·올라섬: 어두운 HUD 안에서는 HUD 고리색(3:1 이상)을 쓰고 두 표시는 같은 모양이다', () => {
  for (const env of [DESKTOP, MOBILE]) {
    for (const [label, button] of darkHudButtons()) {
      const focused = ring(button(':focus-visible'), env);
      const standing = ring(button('.is-standing'), env);
      assert.equal(focused.color, 'var(--focus-on-hud)', `${label}: 키보드 초점`);
      assert.equal(standing.color, 'var(--focus-on-hud)', `${label}: 캐릭터가 올라섬`);
      assert.equal(focused.style, 'solid', `${label}: 초점 고리가 그려진다`);
      assert.deepEqual(standing, focused, `${label}: 초점과 올라섬은 같은 고리다`);
    }
  }
  // 분야 칸은 고리 대신 금빛 선·보라 바탕으로 올라섬을 보이고, 키보드 초점 고리는 HUD 고리색이다
  const card = node("button.category-card[data-category='science']:focus-visible", node('div.category-grid#category-grid', node('div.home-quests#home-quests', screenOf("section.screen[data-screen='home']"))));
  assert.equal(ring(card, MOBILE).color, 'var(--focus-on-hud)');
  // 밝은 표면 위의 버튼은 그대로 진한 보라 고리다 (흰 바탕 3:1)
  const dialogButton = node('button.button.button--primary:focus-visible', node('div.dialog__actions', node('div.dialog', node('div.dialog-backdrop', node('body')))));
  assert.equal(ring(dialogButton, DESKTOP).color, 'var(--focus)');
});

test('초점·올라섬: 그림 위에 홀로 뜬 edge HUD 조각은 고리를 안쪽 어두운 바탕에 그린다', () => {
  const stage = node('div.home-stage#home-stage', screenOf("section.screen[data-screen='home']"));
  const pieces = [
    ['소리', (state) => node(`button.icon-button#sound-toggle${state}`, node('div.app-bar', node('body', pageRoot(false))))],
    ['닉네임', (state) => node(`button.menu-card.menu-card--wide#open-nickname${state}`, node('div.home-player', stage))],
    ['랭킹 입구', (state) => node(`button.menu-card#open-ranking${state}`, node('nav.home-menu', stage))],
  ];
  for (const env of [DESKTOP, MOBILE]) {
    for (const [label, piece] of pieces) {
      for (const state of [':focus-visible', '.is-standing']) {
        const { color, offset, style } = ring(piece(state), env);
        assert.equal(color, 'var(--focus-on-hud)', `${label}${state}`);
        assert.equal(offset, 'calc(var(--focus-width) * -1)', `${label}${state}: 고리가 조각 안쪽에 그려진다`);
        assert.equal(style, 'solid', `${label}${state}`);
      }
    }
  }
});

test('Enter 대상 하나: 키보드 초점이 다른 곳에 보이면 올라섬 고리를 거두고, 초점이 풀리면 돌아온다', () => {
  const resultGhost = (elsewhere) => (state) => node(`button.button.button--ghost#result-home${state}`, node('div.result-actions', screenOf("section.screen[data-screen='result']", elsewhere)));
  const sound = (elsewhere) => (state) => node(`button.icon-button#sound-toggle${state}`, node('div.app-bar', node('body', pageRoot(elsewhere))));
  for (const env of [DESKTOP, MOBILE]) {
    const elsewhere = [...darkHudButtons(true), ['결과 홈', resultGhost(true)], ['소리', sound(true)]];
    for (const [label, button] of elsewhere) {
      assert.equal(ring(button('.is-standing'), env).color, 'transparent', `${label}: 초점이 다른 곳에 있으면 올라섬 고리는 숨는다`);
      // 초점과 발밑이 같은 요소면 그 고리는 그대로 보인다
      assert.notEqual(ring(button('.is-standing:focus-visible'), env).color, 'transparent', `${label}: 초점이 선 자리의 고리`);
    }
    // 초점이 없으면(걷기 시작하면 walker 가 초점을 놓는다) 올라섬 고리가 돌아온다
    for (const [label, button] of [...darkHudButtons(false), ['결과 홈', resultGhost(false)], ['소리', sound(false)]]) {
      const { color, style } = ring(button('.is-standing'), env);
      assert.ok(color && color !== 'transparent', `${label}: 초점이 없을 때의 올라섬 고리 ${color}`);
      assert.equal(style, 'solid', `${label}: 초점이 없을 때의 올라섬 고리`);
    }
  }
});

test('Enter 대상 하나: 고리 밖의 올라섬 단서(선·바탕)도 초점이 다른 곳에 있으면 쉬는 모양으로 돌아간다', () => {
  const homeStage = (elsewhere) => node('div.home-stage#home-stage', screenOf("section.screen[data-screen='home']", elsewhere));
  const dock = (elsewhere) => node('div.home-quests#home-quests', homeStage(elsewhere));
  const characterGrid = (elsewhere) => node('div.character-grid#character-grid', node('div.character-stage#character-stage', screenOf("section.screen[data-screen='characters']", elsewhere)));
  const cases = [
    ['분야 칸', (elsewhere, state) => node(`button.category-card[data-category='art']${state}`, node('div.category-grid#category-grid', dock(elsewhere)))],
    ['전체 도전', (elsewhere, state) => node(`button.challenge-card.challenge-card--all#start-all${state}`, node('div.home-primary-actions', dock(elsewhere)))],
    ['온라인 진입', (elsewhere, state) => node(`button.challenge-card.challenge-card--online#open-online${state}`, node('div.home-primary-actions', dock(elsewhere)))],
    ['닉네임 HUD', (elsewhere, state) => node(`button.menu-card.menu-card--wide#open-nickname${state}`, node('div.home-player', homeStage(elsewhere)))],
    ['캐릭터 입구 HUD', (elsewhere, state) => node(`button.menu-card#open-characters${state}`, node('nav.home-menu', homeStage(elsewhere)))],
    ['캐릭터 칸', (elsewhere, state) => node(`button.character-card${state}`, characterGrid(elsewhere))],
  ];
  const full = (element, env) => `${look(element, env)} | ${valueOf(rules, element, 'color', env)}`;
  for (const env of [DESKTOP, MOBILE]) {
    for (const [label, make] of cases) {
      assert.notEqual(full(make(false, '.is-standing'), env), full(make(false, ''), env), `${label}: 초점이 없을 때는 올라섬이 보인다`);
      assert.equal(full(make(true, '.is-standing'), env), full(make(true, ''), env), `${label}: 초점이 다른 곳에 있으면 쉬는 모양이다`);
    }
    // 지금 쓰는 캐릭터의 «선택됨»은 올라섬이 아니라 남는다
    const chosen = (elsewhere, state) => node(`button.character-card.character-card--on[aria-pressed='true']${state}`, characterGrid(elsewhere));
    assert.equal(look(chosen(true, '.is-standing'), env), look(chosen(false, ''), env), '선택된 캐릭터 칸은 초점과 상관없이 선택 모양이다');
  }
  // 앉아 있는 좌석의 민트 고리는 «앉음» 상태라 거두지 않는다
  const seat = (elsewhere, state) => node(`button.lounge__seat.lounge__seat--sofa${state}`, node('div.lounge__sofa', node('div.lounge__furniture#waiting-furniture', node('div.lounge#lounge', screenOf("section.screen[data-screen='waiting']", elsewhere)))));
  assert.equal(ring(seat(true, ".is-standing[aria-pressed='true']"), MOBILE).color, 'var(--correct)');
  assert.equal(ring(seat(true, '.is-standing'), MOBILE).color, 'transparent');
  assert.equal(ring(seat(false, '.is-standing'), MOBILE).color, 'var(--focus)');
});

test('Enter 대상 하나: 조건은 walker 가 Enter 를 양보하는 «제 키를 쓰는 것»과 같고, 화면 전환 초점은 넣지 않는다', async () => {
  const [theme, walker] = await Promise.all([source('css/voxel-theme.css'), source('src/ui/walker.ts')]);
  assert.ok(theme.includes(`:root:has(${KEYBOARD_FOCUS})`), 'CSS 조건이 테스트의 KEYBOARD_FOCUS 와 같다');
  const pickable = walker.match(/pickable = '([^']+)'/)?.[1] ?? '';
  for (const selector of ['button', 'a[href]', '[role="button"]', 'summary', 'input', 'textarea', 'select']) {
    assert.ok(pickable.includes(selector), `walker pickable 에 ${selector}`);
    assert.ok(KEYBOARD_FOCUS.includes(selector.replace(/"/g, "'")), `조건에 ${selector}`);
  }
  assert.doesNotMatch(KEYBOARD_FOCUS, /section|h1|tabindex/, '화면 전환으로 받은 초점은 Enter 를 가져가지 않는다');

  // 보기·바닥 칸의 캐릭터 위치(불)는 시간이 끝나면 답이 되는 자리라 초점과 상관없이 남는다
  const lit = (elsewhere) => node('button.choice.is-standing', node('li', node('ul.choices', screenOf("section.screen.quiz--character[data-screen='quiz']", elsewhere))));
  const litTile = (elsewhere) => node('div.arena-tile.is-standing', node('div.arena__grid', node('div.arena__stage', node('div.arena', screenOf("section.screen.quiz--character[data-screen='quiz']", elsewhere)))));
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(look(lit(true), env), look(lit(false), env));
    assert.equal(look(litTile(true), env), look(litTile(false), env));
  }
});
