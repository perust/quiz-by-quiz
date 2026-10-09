// 디자인 시스템 잠금 (docs/design-system.md).
//
// 화면을 하나씩 고치다 보면 «이 카드만 2px 더», «이 버튼만 하단 그림자»가 쌓여 다시 조잡해진다.
// 그래서 개별 화면이 아니라 시스템의 규칙 자체를 검사한다.
//   · 간격은 4px 미세 / 8px 기본 격자 토큰으로만
//   · 표면 높이는 세 단계, 테두리는 1px·2px 두 종류, 모서리·색·글꼴·움직임은 토큰으로만
//   · 픽셀 글꼴은 브랜드·숫자·짧은 표식에만, 긴 글은 시스템 글꼴
//   · 상태는 색만이 아니라 모양·표식·높이로도 구분
//   · 아이콘은 하나의 24×24 픽셀 묶음에서만, 손가락 목표 44px, 안전 영역
//
// «세계 장식»(복셀 마을, 대기실 픽셀 가구·액자, 캐릭터 몸통과 몸짓)은 그림이라 이 규칙에서 뺀다.
// 그 목록은 아래 DECOR 하나뿐이다 — 장식 이름을 붙여 규칙을 피해 가지 못하게 좁게 둔다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DESKTOP, MOBILE, NARROW,
  lengthOf, loadStyles, node, nodeFromHtml, resolveVars, shorthandParts, tokens, valueOf,
} from './css-cascade.mjs';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const html = await source('index.html');
const files = {
  'css/style.css': await loadStyles(['css/style.css']),
  'css/voxel-theme.css': await loadStyles(['css/voxel-theme.css']),
};
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const root = tokens(rules, DESKTOP);

const DECOR = [
  /^\.voxel-/,
  /^\.iso-cube/,
  /\.lounge__(?:chair|sofa|table|seat|portrait|furniture)/,
  /\.walker__(?:body|face|dot|shadow)/,
  /^\.walker--(?:sad|seated|walking|idle|hop)\b/,
  /^\.walker--remote/,
  /^\.sr-only$/,
];

const isDecor = (rule) => rule.selectors.every((selector) => DECOR.some((pattern) => pattern.test(selector)));
const isRoot = (rule) => rule.selectors.every((selector) => selector.trim() === ':root');

/** 장식과 토큰 정의를 뺀 모든 선언 */
function* componentDeclarations() {
  for (const [file, list] of Object.entries(files)) {
    for (const rule of list) {
      if (isRoot(rule) || isDecor(rule)) continue;
      for (const declaration of rule.declarations) {
        if (declaration.property.startsWith('--')) continue;
        yield { file, selector: rule.selectors.join(', '), media: rule.media.join(' and '), ...declaration };
      }
    }
  }
}

function px(value) {
  return Number.parseFloat(value);
}

// ── 토큰 ───────────────────────────────────────────────────────────

test('토큰: 간격은 4px 미세 / 8px 기본 격자 한 벌이다', () => {
  const scale = [...root].filter(([name]) => /^--space-\d+$/.test(name));
  assert.deepEqual(
    Object.fromEntries(scale),
    {
      '--space-1': '4px',
      '--space-2': '8px',
      '--space-3': '12px',
      '--space-4': '16px',
      '--space-5': '20px',
      '--space-6': '24px',
      '--space-8': '32px',
      '--space-10': '40px',
      '--space-12': '48px',
      '--space-16': '64px',
    },
  );
  for (const [name, value] of scale) {
    assert.equal(px(value) % 4, 0, `${name} 는 4px 격자 위에 있다`);
  }
  // 바깥 여백도 격자 토큰이고, 좁은 화면에서만 한 단계 줄어든다
  assert.equal(lengthOf(rules, 'var(--page-pad)', DESKTOP), 16);
  assert.equal(lengthOf(rules, 'var(--page-pad)', NARROW), 12);
});

test('토큰: 표면 높이는 세 단계, 테두리는 1px·2px 두 종류, 모서리는 정해진 단계뿐이다', () => {
  const elevations = [...root.keys()].filter((name) => name.startsWith('--elevation-')).sort();
  assert.deepEqual(elevations, ['--elevation-1', '--elevation-2', '--elevation-3']);

  const borders = [...root].filter(([name]) => /^--border-\d+$/.test(name));
  assert.deepEqual(Object.fromEntries(borders), { '--border-1': '1px', '--border-2': '2px' });

  const radii = Object.fromEntries([...root].filter(([name]) => name.startsWith('--radius-')));
  assert.deepEqual(radii, {
    '--radius-xs': '4px',
    '--radius-sm': '8px',
    '--radius-md': '12px',
    '--radius-lg': '16px',
    '--radius-xl': '24px',
    '--radius-full': '999px',
  });
});

test('토큰: 움직임은 100–180ms 의 짧은 피드백이고, 글자 크기는 12px 아래로 내려가지 않는다', () => {
  const durations = [...root].filter(([name]) => name.startsWith('--duration-'));
  assert.ok(durations.length >= 2);
  for (const [name, value] of durations) {
    const ms = value.endsWith('ms') ? px(value) : px(value) * 1000;
    assert.ok(ms >= 100 && ms <= 180, `${name} ${value} 는 100–180ms 안이어야 한다`);
  }

  const sizes = [...root].filter(([name]) => /^--text-(?:xs|sm|md|lg|xl|\dxl)$/.test(name));
  assert.ok(sizes.length >= 6);
  for (const [name, value] of sizes) {
    assert.ok(px(value) >= 12, `${name} ${value} 는 12px 이상이어야 한다`);
  }
});

// ── 규칙 검사 (장식 밖의 모든 컴포넌트) ───────────────────────────────

const SPACING = /^(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/;
const SPACING_TOKENS = /var\(--(?:space-\d+|page-pad|icon-tile|icon-(?:sm|md|lg)|tap|walk-(?:stick|knob|confirm)-size|(?:screen-)?walker-width|lounge-floor)(?:,\s*0px)?\)/g;

test('간격: margin·padding·gap 은 토큰이거나 4px 격자 위의 값이다', () => {
  const offenders = [];
  for (const declaration of componentDeclarations()) {
    if (!SPACING.test(declaration.property)) continue;
    const stripped = declaration.value
      .replace(SPACING_TOKENS, '0')
      .replace(/env\(safe-area-inset-(?:top|right|bottom|left)(?:,\s*0px)?\)/g, '0');
    if (/var\(/.test(stripped)) {
      offenders.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} } — 간격 토큰이 아니다`);
      continue;
    }
    if (/\d(?:em|rem|%|vh|vw)\b/.test(stripped)) {
      offenders.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} } — 격자 밖 단위`);
      continue;
    }
    for (const match of stripped.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      if (Number(match[1]) % 4 !== 0) {
        offenders.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} } — ${match[0]} 는 4px 격자 밖`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('표면: box-shadow 는 세 단계 높이 토큰과 정해진 표식만 쓴다 — 카드마다 굵은 하단 그림자를 두지 않는다', () => {
  const allowed = /^var\(--(?:elevation-[123]|press-edge|marker-mine)\)$/;
  const offenders = [];
  for (const declaration of componentDeclarations()) {
    if (declaration.property !== 'box-shadow') continue;
    if (declaration.value === 'none') continue;
    const layers = declaration.value.split(/,(?![^(]*\))/).map((layer) => layer.trim());
    if (!layers.every((layer) => allowed.test(layer))) {
      offenders.push(`${declaration.selector} { box-shadow: ${declaration.value} }`);
    }
  }
  assert.deepEqual(offenders, []);

  // 덮는 것(대화상자·피드백 시트)만 가장 높은 3단계에 있다
  for (const id of ['feedback']) {
    assert.equal(valueOf(rules, nodeFromHtml(html, id), 'box-shadow', MOBILE), 'var(--elevation-3)');
  }
  const dialog = node('div.dialog', node('div.dialog-backdrop#exit-dialog', node('body')));
  assert.equal(valueOf(rules, dialog, 'box-shadow', MOBILE), 'var(--elevation-3)');
  // 읽는 표면은 1단계, 가장자리에 떠 있는 상태 HUD는 2단계다.
  for (const descriptor of ['div.result-block', 'ol.ranking-list']) {
    const element = node(descriptor, node("section.screen.quiz--character[data-screen='quiz']", node('main.app', node('body'))));
    assert.equal(valueOf(rules, element, 'box-shadow', MOBILE), 'var(--elevation-1)', descriptor);
  }
  for (const descriptor of ['div.quiz-hud', 'h1.question', 'div.home-quests']) {
    const element = node(descriptor, node("section.screen.quiz--character[data-screen='quiz']", node('main.app', node('body'))));
    assert.equal(valueOf(rules, element, 'box-shadow', MOBILE), 'var(--elevation-2)', descriptor);
  }
});

test('테두리: 폭은 --border-1(1px) 과 --border-2(2px) 두 종류뿐이고 이중 테두리를 쓰지 않는다', () => {
  const offenders = [];
  for (const declaration of componentDeclarations()) {
    if (!/^border(?:-(?:top|right|bottom|left))?(?:-width)?$/.test(declaration.property)) continue;
    const widths = declaration.value.replace(/var\(--border-[12]\)/g, '').replace(/var\(--[a-z0-9-]+\)/g, '');
    if (/\d+(?:\.\d+)?px/.test(widths) && declaration.value !== '0') {
      offenders.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} }`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('모서리·색·글꼴: 컴포넌트는 토큰만 쓴다', () => {
  const offenders = [];
  const colorProperties = /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|fill|stroke|accent-color|caret-color)$/;
  for (const declaration of componentDeclarations()) {
    const where = `${declaration.selector} { ${declaration.property}: ${declaration.value} }`;
    if (declaration.property === 'border-radius') {
      const parts = shorthandParts(declaration.value);
      if (!parts.every((part) => /^(?:0|50%|var\(--radius-(?:xs|sm|md|lg|xl|full)\))$/.test(part))) offenders.push(where);
    }
    if (colorProperties.test(declaration.property)) {
      if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black|red|blue|green|gray|grey)\b/i.test(declaration.value)) offenders.push(where);
      if (/var\(--(?:mist|violet|mint|coral|gold)-\d+\)/.test(declaration.value)) offenders.push(`${where} — 컴포넌트는 역할 색을 쓴다`);
    }
    if (declaration.property === 'font-family') {
      if (!/^(?:var\(--font-(?:text|display)\)|inherit)$/.test(declaration.value)) offenders.push(where);
    }
    if (declaration.property === 'font') {
      if (declaration.value !== 'inherit') offenders.push(where);
    }
    if (declaration.property === 'font-size') {
      if (!/^(?:var\(--text-(?:xs|sm|md|lg|xl|2xl|3xl|4xl|5xl)\)|inherit)$/.test(declaration.value)) offenders.push(where);
    }
    if (declaration.property === 'font-weight') {
      if (!/^(?:var\(--weight-(?:bold|heavy)\)|400|inherit)$/.test(declaration.value)) offenders.push(where);
    }
  }
  assert.deepEqual(offenders, []);
});

test('움직임: 화면 피드백은 duration 토큰만 쓰고 끝없이 깜빡이지 않으며, 움직임 줄이기 설정을 따른다', () => {
  const offenders = [];
  for (const declaration of componentDeclarations()) {
    // 움직임 줄이기 블록은 움직임을 끄는 스위치 자체다
    if (declaration.media.includes('prefers-reduced-motion')) continue;
    if (/^transition(?:-duration)?$/.test(declaration.property) && declaration.value !== 'none') {
      const durations = declaration.value.replace(/var\(--duration-(?:fast|base|slow)\)/g, '');
      if (/\d(?:ms|s)\b/.test(durations)) offenders.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} }`);
    }
    if (/^animation(?:-duration)?$/.test(declaration.property) && declaration.value !== 'none') {
      const durations = declaration.value.replace(/var\(--duration-(?:fast|base|slow)\)/g, '').replace(/var\(--ease-[a-z-]+\)/g, '');
      if (/\d(?:ms|s)\b|infinite/.test(durations)) offenders.push(`${declaration.selector} { ${declaration.property}: ${declaration.value} }`);
    }
  }
  assert.deepEqual(offenders, []);

  const reduced = { ...MOBILE, reducedMotion: true };
  const anything = node('div.choice.choice--correct', node('body'));
  for (const property of ['animation-duration', 'transition-duration']) {
    assert.match(valueOf(rules, anything, property, reduced) ?? '', /^0\.0+1ms$/, `움직임 줄이기에서는 ${property} 를 끈다`);
  }
  assert.equal(valueOf(rules, anything, 'animation-iteration-count', reduced), '1', '캐릭터의 제자리 뛰기도 한 번에 멈춘다');
});

// ── 글꼴 위계 ──────────────────────────────────────────────────────

test('글꼴: 픽셀 글꼴은 브랜드·숫자·짧은 게임 표식에만 쓰고, 긴 글은 시스템 글꼴로 읽힌다', () => {
  const allowed = new Set([
    '.home-title',
    '.quiz-position',
    '.choice__key',
    '.arena-tile__number',
    '.result-score strong',
    '.result-grade',
    '.ranking-item__rank',
    '.online-final-ranking__place',
    '.voxel-building--tower .voxel-building__clock',
  ]);
  const display = [];
  for (const list of Object.values(files)) {
    for (const rule of list) {
      if (rule.declarations.some((d) => d.property === 'font-family' && d.value.includes('--font-display'))) {
        display.push(...rule.selectors);
      }
    }
  }
  assert.ok(display.length > 0);
  for (const selector of display) assert.ok(allowed.has(selector), `${selector} 에 픽셀 글꼴을 쓰지 않는다`);

  const body = node('body');
  assert.equal(valueOf(rules, body, 'font-family', MOBILE), 'var(--font-text)');
  const quiz = node("section.screen.quiz--character[data-screen='quiz']", node('main.app', body));
  const longText = [
    node('h1.question#question-text', quiz),
    node('span.choice__text', node('button.choice', node('li', node('ul.choices#choices', quiz)))),
    node('p.feedback__explanation#feedback-explanation', node('div', node('div.feedback#feedback', body))),
    node('p.review__question', node('li.review__item', node('ol.review#result-review', body))),
    node('p.dialog__body', node('div.dialog', node('div.dialog-backdrop', body))),
    node('button.button.button--primary#next-button', node('div.feedback#feedback', body)),
  ];
  for (const element of longText) {
    const family = valueOf(rules, element, 'font-family', MOBILE);
    assert.ok(family === null || family === 'var(--font-text)', `${element.classes.join('.')} 는 시스템 글꼴을 물려받는다: ${family}`);
  }
  // 질문·보기·해설은 16px 이상으로 읽힌다
  for (const [element, minimum] of [[longText[0], 18], [longText[1], 16], [longText[2], 16]]) {
    for (const env of [MOBILE, DESKTOP]) {
      const size = lengthOf(rules, valueOf(rules, element, 'font-size', env), env);
      assert.ok(size >= minimum, `${element.classes.join('.')} ${size}px < ${minimum}px`);
    }
  }
});

// ── 화면 위계 ──────────────────────────────────────────────────────

test('홈: 전체 월드 위 edge HUD와 하단 5칸 dock, 전체 도전 하나만 주 행동이다', () => {
  const home = html.slice(html.indexOf('data-screen="home"'), html.indexOf('data-screen="quiz"'));
  const order = ['id="open-nickname"', '<nav class="home-menu"', '<header class="home-header">', 'class="home-quests"', 'id="category-grid"', 'id="start-all"'];
  order.reduce((previous, marker) => {
    const at = home.indexOf(marker);
    assert.ok(at > previous, `${marker} 의 순서가 어긋났다`);
    return at;
  }, -1);
  const quests = home.slice(home.indexOf('class="home-quests"'), home.indexOf('id="home-character"'));
  assert.match(quests, /id="category-grid"[\s\S]*id="start-all"/, '다섯 분야와 전체 도전은 한 패널 안에 있다');

  const body = node('body', null, { has: ["[data-screen='home']:not([hidden])"] });
  const stage = node('div.home-stage#home-stage', node("section.screen[data-screen='home']", node('main.app', body)));
  const panel = node('div.home-quests', stage);
  const startAll = node('button.challenge-card#start-all', panel);
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(valueOf(rules, startAll, 'background', env), 'var(--primary-action)', '전체 도전은 골드 주 행동이다');
    assert.match(valueOf(rules, startAll, 'box-shadow', env), /var\(--press-edge\)/, '눌러 들어가는 두께가 있다');
    assert.equal(valueOf(rules, panel, 'background', env), 'var(--hud-bg)');

    // 분야 색은 아이콘 칸에만. 칸 자체는 모두 같은 중립 바탕이다 — 무지개 카드를 만들지 않는다
    const looks = new Set();
    for (const category of ['history', 'science', 'geography', 'general', 'art']) {
      const card = node(`button.category-card[data-category='${category}']`, node('div.category-grid#category-grid', panel));
      looks.add(`${valueOf(rules, card, 'background', env)} | ${valueOf(rules, card, 'border-color', env)}`);
      assert.equal(valueOf(rules, node('span.category-card__icon', card), 'background', env), 'var(--cat-soft)');
      assert.equal(valueOf(rules, card, '--cat-soft', env), `var(--cat-${category}-soft)`);
    }
    assert.equal(looks.size, 1, `분야 칸의 바탕과 테두리는 하나다: ${[...looks].join(' / ')}`);

    // 세 바로가기는 중앙 콘텐츠를 미는 panel이 아니라 독립 edge HUD 슬롯이다.
    const dock = node('nav.home-menu', stage);
    assert.equal(valueOf(rules, dock, 'display', env), 'contents');
    assert.equal(valueOf(rules, node('button.menu-card#open-ranking', dock), 'background', env), 'var(--hud-bg)');
    assert.equal(valueOf(rules, node('header.home-header', stage), 'background', env), 'transparent');
  }

  // 앱 바는 main 뒤에 있어 z-index 없이 월드 위, modal 아래에 뜬다.
  assert.ok(html.indexOf('</main>') < html.indexOf('<div class="app-bar"'));
  assert.ok(html.indexOf('<div class="app-bar"') < html.indexOf('id="feedback"'));
  const appBar = node('div.app-bar', body);
  assert.equal(valueOf(rules, appBar, 'position', MOBILE), 'fixed');
  assert.equal(valueOf(rules, node('button.menu-card.menu-card--wide#open-nickname', node('div.home-player', stage)), 'width', MOBILE), '100%');
});

test('홈: 창 점·이중 테두리 같은 가짜 장식이 없다', () => {
  for (const descriptor of ['button.menu-card::after', 'button.category-card::after', 'button.challenge-card::after', 'header.home-header::before', 'header.home-header::after']) {
    assert.equal(valueOf(rules, node(descriptor), 'content', DESKTOP), null, `${descriptor} 에 그려 넣은 장식이 없다`);
  }
});

test('결과: 점수 장면 → 요약 칩 셋 → 다시 하기(주 행동) → 보조 행동 순서이고 칩은 아이콘을 단다', () => {
  const result = html.slice(html.indexOf('data-screen="result"'), html.indexOf('data-screen="ranking"'));
  const items = [...result.matchAll(/<div class="result-stats__item" data-icon="([a-z-]+)">/g)].map((match) => match[1]);
  assert.deepEqual(items, ['check', 'target', 'clock']);
  assert.match(result, /class="button button--primary" id="result-retry"/);
  for (const id of ['result-room', 'result-ranking', 'result-home']) {
    assert.match(result, new RegExp(`class="button button--ghost" id="${id}"`));
  }
  assert.ok(result.indexOf('class="result-header"') < result.indexOf('class="result-stats"'));

  const actions = node('div.result-actions', node("section.screen[data-screen='result']", node('main.app', node('body'))));
  assert.equal(valueOf(rules, node('button.button.button--primary#result-retry', actions), 'flex-basis', MOBILE), '100%', '다시 하기는 한 줄을 다 쓴다');
  const chip = node("div.result-stats__item[data-icon='check']", node('dl.result-stats', node('section.screen')));
  assert.equal(valueOf(rules, chip, 'box-shadow', MOBILE), 'var(--elevation-1)', '칩 셋은 각자 표면이다 — 한 카드 안의 세 칸이 아니다');
  assert.equal(valueOf(rules, node('dl.result-stats', node('section.screen')), 'box-shadow', MOBILE), null);
});

test('결과: 320px 요약 칩은 네 글자 라벨과 값을 위한 가로 공간을 남긴다', () => {
  const stats = node('dl.result-stats', node('section.screen'));
  const chip = node("div.result-stats__item[data-icon='clock']", stats);
  assert.equal(valueOf(rules, chip, 'grid-template-columns', NARROW), 'var(--icon-sm) minmax(0, 1fr)');
  assert.equal(valueOf(rules, chip, 'padding', NARROW), 'var(--space-2) var(--space-1)');
  assert.equal(valueOf(rules, node('dd', chip), 'font-size', NARROW), 'var(--text-sm)');
});

// ── 상태 언어 ───────────────────────────────────────────────────────

test('상태: 보기의 정답·오답·제출 대기·캐릭터 위치는 색만이 아니라 표식과 모양으로도 다르다', () => {
  const list = node('ul.choices', node("section.screen.quiz--character[data-screen='quiz']", node('main.app', node('body'))));
  const choice = (descriptor) => node(descriptor, node('li', list));
  const markOf = (state) => node('span.choice__mark', choice(`button.choice.${state}:disabled`));

  assert.equal(valueOf(rules, markOf('choice--correct'), '--icon', MOBILE), 'var(--i-check)');
  assert.equal(valueOf(rules, markOf('choice--wrong'), '--icon', MOBILE), 'var(--i-cross)');
  assert.equal(valueOf(rules, markOf('choice--submitted'), '--icon', MOBILE), 'var(--i-hourglass)');
  assert.equal(valueOf(rules, choice('button.choice.choice--submitted:disabled'), 'border-style', MOBILE), 'dashed', '제출 대기는 점선 테두리다');
  assert.equal(valueOf(rules, node('span.choice__mark::before', choice('button.choice.choice--correct:disabled')), 'content', MOBILE), "''");

  // 캐릭터 위치는 번호 칸까지 채워 «불이 켜진» 모양이 된다
  const key = (descriptor) => node('span.choice__key', choice(descriptor));
  assert.equal(valueOf(rules, key('button.choice.is-standing'), 'background', MOBILE), 'var(--accent)');
  assert.equal(valueOf(rules, key('button.choice[data-arena-target]'), 'background', MOBILE), 'var(--accent)');
  assert.equal(valueOf(rules, key('button.choice'), 'background', MOBILE), 'var(--surface-subtle)');

  // 바닥 칸의 ✓ ✗ 도 같은 아이콘이다
  const tile = (state) => node('span.arena-tile__mark', node(`div.arena-tile.${state}`, node('div.arena__grid', node('div.arena'))));
  assert.equal(valueOf(rules, tile('arena-tile--correct'), '--icon', MOBILE), 'var(--i-check)');
  assert.equal(valueOf(rules, tile('arena-tile--wrong'), '--icon', MOBILE), 'var(--i-cross)');

  // 남은 5초는 아이콘 모양도 바뀐다 (FR-3.9)
  const timerIcon = (warning) => node('span.timer__icon', node('p.timer__label', node(`div.timer${warning ? '.timer--warning' : ''}`, node('div.quiz-hud'))));
  assert.match(valueOf(rules, timerIcon(false), '-webkit-mask', MOBILE) ?? '', /var\(--i-clock\)/);
  assert.equal(valueOf(rules, timerIcon(true), 'mask-image', MOBILE), 'var(--i-alert)');
});

test('상태: 버튼은 쉬는·눌림·꺼짐이 높이와 채움으로 구분되고, 걸어서 올라선 표시는 초점 고리와 같다', () => {
  const primary = (state = '') => node(`button.button.button--primary${state}`, node('div.dialog__actions'));
  assert.match(valueOf(rules, primary(), 'box-shadow', MOBILE), /var\(--press-edge\)/);
  assert.equal(valueOf(rules, primary(':active'), 'box-shadow', MOBILE), 'none');
  assert.equal(valueOf(rules, primary(':active'), 'translate', MOBILE), '0 2px');
  assert.equal(valueOf(rules, primary(':disabled'), 'box-shadow', MOBILE), 'none');
  assert.equal(valueOf(rules, primary(':disabled'), 'background', MOBILE), 'var(--surface-subtle)');
  assert.equal(valueOf(rules, primary(':disabled'), 'color', MOBILE), 'var(--text-disabled)');

  const focusRing = valueOf(rules, node('button.button:focus-visible'), 'outline', DESKTOP);
  assert.equal(focusRing, 'var(--focus-width) solid var(--focus)');
  for (const descriptor of ['button.button.is-standing', 'button.menu-card.is-standing', 'button.setting-card.is-standing', 'button.character-card.is-standing', 'input.room-form__input.is-standing']) {
    assert.equal(valueOf(rules, node(descriptor), 'outline', MOBILE), focusRing, descriptor);
  }

  // 고른 탭은 흰 표면으로 들려 있다 — 색만이 아니라 높이로
  const tabs = node('div.ranking-tabs#ranking-tabs');
  assert.equal(valueOf(rules, node('button.ranking-tab.ranking-tab--active', tabs), 'box-shadow', MOBILE), 'var(--elevation-1)');
  assert.equal(valueOf(rules, node('button.ranking-tab', tabs), 'box-shadow', MOBILE), null);

  // 온라인·랭킹 워커는 머리말 오른쪽 아래에 쉬므로, 본문을 덮지 않는 전용 주차 폭을 둔다
  const ranking = node("section.screen[data-screen='ranking']", node('main.app', node('body')));
  assert.equal(root.get('--walker-width'), '34px');
  assert.equal(root.get('--walker-height'), '42px');
  assert.equal(root.get('--screen-walker-width'), '40px');
  assert.equal(root.get('--screen-walker-height'), '48px');
  assert.equal(valueOf(rules, node('div.walker.walker--home'), 'width', MOBILE), 'var(--screen-walker-width)');
  assert.equal(valueOf(rules, node('div.walker.walker--home'), 'height', MOBILE), 'var(--screen-walker-height)');
  assert.equal(
    valueOf(rules, node('p.ranking-scope', ranking), 'padding-inline-end', MOBILE),
    'calc(var(--screen-walker-width) + var(--space-5))',
  );
  assert.equal(
    valueOf(rules, node('p.online-note#online-note'), 'padding-inline-end', MOBILE),
    'calc(var(--screen-walker-width) + var(--space-5))',
  );

  // 고른 캐릭터·준비 완료·대기실 준비판은 ✓ 표식을 함께 단다
  assert.match(valueOf(rules, node('button.character-card.character-card--on::after'), 'background', MOBILE), /var\(--i-check-inverse\)/);
  assert.match(valueOf(rules, node("button.button.waiting-ready[aria-pressed='true']::before"), '-webkit-mask', MOBILE), /var\(--i-check\)/);
  assert.match(valueOf(rules, node('span.lounge__ready.lounge__ready--on::before'), 'mask', MOBILE), /var\(--i-check\)/);
  assert.equal(valueOf(rules, node('span.lounge__ready::before'), 'border-radius', MOBILE), '50%', '대기는 빈 동그라미다');
});

test('좁거나 짧은 온라인 동작의 compact 글자·아이콘은 theme cascade 뒤에도 유지된다', () => {
  const card = node('button.online-action-card');
  const body = node('span.online-action-card__body', card);
  const label = node('strong', body);
  const icon = node('span.online-action-card__icon', card);
  const glyph = node('span.online-action-card__icon::before', card);

  for (const viewport of [MOBILE, NARROW]) {
    assert.equal(valueOf(rules, label, 'font-size', viewport), 'var(--text-xs)');
    assert.equal(valueOf(rules, icon, 'width', viewport), 'var(--icon-sm)');
    assert.equal(valueOf(rules, glyph, 'width', viewport), 'var(--icon-sm)');
    assert.equal(valueOf(rules, glyph, 'height', viewport), 'var(--icon-sm)');
  }
});

// ── 아이콘 ─────────────────────────────────────────────────────────

test('아이콘: 쓰는 이름마다 하나의 24×24 픽셀 격자 아이콘이 있다', async () => {
  const [constants, app, online] = await Promise.all([
    source('src/constants.ts'),
    source('src/app.ts'),
    source('src/ui/online.ts'),
  ]);
  const names = new Set([
    ...[...html.matchAll(/data-icon="([a-z-]+)"/g)].map((match) => match[1]),
    ...[...constants.matchAll(/icon: '([a-z-]+)'/g)].map((match) => match[1]),
    ...[...app.matchAll(/(?:on|off): \{ icon: '([a-z-]+)'/g)].map((match) => match[1]),
    ...[...online.matchAll(/\?\.icon \?\? '([a-z-]+)'/g)].map((match) => match[1]),
  ]);
  assert.ok(names.size >= 20, `아이콘 이름을 충분히 모으지 못했다: ${[...names]}`);

  const mapped = new Map();
  for (const rule of files['css/voxel-theme.css']) {
    for (const selector of rule.selectors) {
      const match = selector.match(/^\[data-icon='([a-z-]+)'\]$/);
      if (match) mapped.set(match[1], rule.declarations.find((d) => d.property === '--icon')?.value);
    }
  }
  for (const name of names) {
    assert.equal(mapped.get(name), `var(--i-${name})`, `data-icon="${name}" 을 그릴 규칙이 있다`);
  }

  // 모든 아이콘 토큰은 같은 격자: viewBox 24×24, 점 하나가 2 단위인 픽셀 경로
  const iconTokens = [...root].filter(([name]) => name.startsWith('--i-'));
  assert.ok(iconTokens.length >= names.size);
  for (const [name, value] of iconTokens) {
    assert.match(value, /^url\("data:image\/svg\+xml,%3Csvg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 24 24'%3E%3Cpath (?:fill='%23fff' )?d='[^']+'\/%3E%3C\/svg%3E"\)$/, name);
    const path = value.match(/ d='([^']+)'/)[1];
    for (const number of path.match(/-?\d+(?:\.\d+)?/g)) {
      const unit = Math.abs(Number(number));
      assert.ok(Number.isInteger(unit) && unit % 2 === 0 && unit <= 24, `${name}: ${number} 는 2단위 픽셀 격자 밖이다`);
    }
  }

  // CSS 가 부르는 아이콘 토큰은 모두 정의되어 있다
  const theme = await source('css/voxel-theme.css');
  const style = await source('css/style.css');
  for (const match of `${theme}\n${style}`.matchAll(/var\((--i-[a-z-]+)\)/g)) {
    assert.ok(root.has(match[1]), `${match[1]} 가 정의되지 않았다`);
  }
});

// ── 손가락 목표 · 안전 영역 ─────────────────────────────────────────

test('손가락 목표: 직접 누르는 모든 조각은 휴대폰 폭에서 44px 이상이다', () => {
  const quiz = node("section.screen.quiz--character[data-screen='quiz']", node('main.app', node('body')));
  const targets = [
    ['button.button', 'min-height'],
    ['button.button.button--small', 'min-height'],
    ['button.icon-button#sound-toggle', 'min-height'],
    ['button.icon-button#sound-toggle', 'min-width'],
    ['button.arena__help', 'height'],
    ['button.arena__help', 'width'],
    ['button.category-card', 'min-height'],
    ['button.challenge-card#start-all', 'min-height'],
    ['button.menu-card.menu-card--wide#open-nickname', 'min-height'],
    ['button.ranking-tab', 'min-height'],
    ['button.online-action-card', 'min-height'],
    ['button.setting-card', 'min-height'],
    ['button.character-card', 'min-height'],
    ['input.room-form__input', 'min-height'],
    ['input.register__input', 'min-height'],
    ['input.chat__input', 'min-height'],
    ['button.lounge__seat', 'min-height'],
    ['button.walk-confirm#walk-confirm', 'height'],
  ];
  for (const env of [MOBILE, NARROW]) {
    for (const [descriptor, property] of targets) {
      const size = lengthOf(rules, valueOf(rules, node(descriptor, quiz), property, env), env);
      assert.ok(size >= 44, `${env.width}px ${descriptor} ${property} ${size}`);
    }
    const dockCell = node('button.menu-card#open-characters', node('nav.home-menu', node('div.home-player')));
    assert.ok(lengthOf(rules, valueOf(rules, dockCell, 'min-height', env), env) >= 44, `${env.width}px dock 칸`);
    const quizChoice = node('button.choice', node('li', node('ul.choices', quiz)));
    assert.ok(lengthOf(rules, valueOf(rules, quizChoice, 'min-height', env), env) >= 44, `${env.width}px 보기`);
  }
});

test('안전 영역: 노치·홈 표시줄이 있는 기기에서도 조작과 글이 가려지지 않는다', () => {
  const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)[1];
  assert.match(viewport, /viewport-fit=cover/);
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=/i, '확대를 막지 않는다');

  const body = node('body');
  const app = node('main.app', body);
  const controls = node("div.walk-controls[data-placement='viewport']#walk-controls", app);
  const checks = [
    [app, 'padding-inline', /safe-area-inset-left[\s\S]*safe-area-inset-right/],
    [node('div.app-bar', body), 'padding', /safe-area-inset-top/],
    [node("section.screen[data-screen='home']", app), 'padding-top', /safe-area-inset-top/],
    [nodeFromHtml(html, 'feedback'), 'padding', /safe-area-inset-bottom/],
    [controls, '--walk-controls-bottom', /safe-area-inset-bottom/],
    [controls, '--walk-stick-left', /safe-area-inset-left/],
    [controls, '--walk-confirm-right', /safe-area-inset-right/],
    [node('div.dialog-backdrop', body), 'padding', /safe-area-inset-top[\s\S]*safe-area-inset-bottom/],
  ];
  for (const [element, property, pattern] of checks) {
    for (const env of [MOBILE, NARROW]) {
      assert.match(valueOf(rules, element, property, env) ?? '', pattern, `${element.classes.join('.') || element.id} ${property}`);
    }
  }
  assert.equal(resolveVars('var(--page-pad)', tokens(rules, NARROW)), '12px');
});

test('확대: viewport보다 긴 대화상자는 위에서 시작해 제목부터 끝까지 스크롤할 수 있다', () => {
  const body = node('body');
  const backdrop = node('div.dialog-backdrop', body);
  const dialog = node('div.dialog', backdrop);

  // `safe center`는 남는 공간에서는 가운데 정렬하고, 넘치는 경우 start로 물러나
  // 제목이 음수 좌표로 잘리지 않는다.
  assert.equal(valueOf(rules, backdrop, 'display', DESKTOP), 'flex');
  assert.equal(valueOf(rules, backdrop, 'align-items', DESKTOP), 'safe center');
  assert.equal(valueOf(rules, backdrop, 'justify-content', DESKTOP), 'center');
  assert.equal(valueOf(rules, dialog, 'margin', DESKTOP), '0');
  assert.equal(valueOf(rules, backdrop, 'overflow-y', DESKTOP), 'auto');
  assert.equal(valueOf(rules, node("div.dialog[tabindex='-1']:focus", backdrop), 'outline', DESKTOP), 'none');
});

test('화면 읽기 폭: 숨은 제목은 1px 접근성 위치를 지키고 대기실 직접 행동은 가운데 block flex다', () => {
  const resultTitle = nodeFromHtml(html, 'result-title');
  const ready = nodeFromHtml(html, 'waiting-ready');

  for (const env of [DESKTOP, MOBILE, NARROW]) {
    assert.equal(valueOf(rules, resultTitle, 'position', env), 'absolute');
    assert.equal(lengthOf(rules, valueOf(rules, resultTitle, 'width', env), env), 1);
    assert.equal(valueOf(rules, ready, 'display', env), 'flex');
    assert.equal(valueOf(rules, ready, 'margin-left', env), 'auto');
    assert.equal(valueOf(rules, ready, 'margin-right', env), 'auto');
  }
});
