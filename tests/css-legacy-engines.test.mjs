// 새 문법을 모르는 엔진에서만 이기는 선언(대체값)을 잠근다.
//
// css-cascade 는 선택자를 하나씩 맞춰 보고 모든 선언을 읽는다. 그래서 지금 엔진에서 «늘 지는» 선언은 죽은 코드처럼
// 보이는데, 브라우저는 모르는 선택자가 든 선택자 목록을 규칙째 버리고 모르는 속성의 선언을 버린다 — 그 엔진에서는
// 그 선언이 이긴다. U49 정리에서 그런 대체값 셋을 «이길 수 없는 선언»으로 지웠다가 되살렸다(아래 셋). 정리 전체는
// tools/css-snapshot.mjs 의 구형 엔진 판이 두 판을 견주고, 이 테스트는 그 판이 본 사실을 빠르게 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MOBILE, loadStyles, node, nodeFromHtml, valueOf } from './css-cascade.mjs';
import { ENGINES, breakpoints, selectorUses, withoutFeatures } from '../tools/css-snapshot.mjs';

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const engine = (name) => {
  const found = ENGINES.find((entry) => entry.name === name);
  assert.ok(found, `ENGINES 에 ${name} 이 있다`);
  return withoutFeatures(rules, found.features).rules;
};

test(':has() 를 모르는 엔진의 앱 바는 가운데 정렬·안전 영역 여백의 흐름 배치다', () => {
  const appBar = nodeFromHtml(html, 'open-settings').parent;
  // 지금 엔진: :has() 가 든 목록 규칙이 fixed edge HUD 로 덮는다
  assert.equal(valueOf(rules, appBar, 'position', MOBILE), 'fixed');
  for (const name of ['Firefox 115–120 ESR', 'Safari 15.0–15.3', 'Chrome 93–103']) {
    const legacy = engine(name);
    assert.equal(valueOf(legacy, appBar, 'position', MOBILE), null, `${name}: fixed 규칙이 목록째 버려진다`);
    assert.equal(valueOf(legacy, appBar, 'max-width', MOBILE), 'var(--content-max)', name);
    assert.equal(valueOf(legacy, appBar, 'margin', MOBILE), '0 auto', name);
    assert.match(
      valueOf(legacy, appBar, 'padding', MOBILE),
      /safe-area-inset-top[\s\S]*safe-area-inset-right[\s\S]*safe-area-inset-left/,
      name,
    );
  }
});

test(':focus-visible 을 모르는 엔진에서도 올라선 홈 HUD 조각은 어두운 바탕이다 — 흰 HUD 글자가 남는다', () => {
  const legacy = engine('Safari 15.0–15.3');
  for (const id of ['open-characters', 'open-ranking', 'open-nickname']) {
    const card = nodeFromHtml(html, id);
    card.classes.push('is-standing');
    for (const set of [rules, legacy]) {
      assert.equal(valueOf(set, card, 'background', MOBILE), 'var(--hud-bg)', `#${id}`);
      assert.equal(valueOf(set, card, 'color', MOBILE), 'var(--hud-text)', `#${id}`);
    }
  }
});

test('논리 속성을 모르는 엔진의 저장 범위 안내는 사방 padding 을 지킨다', () => {
  const legacy = engine('Safari 14.0');
  for (const id of ['register-scope', 'quiz-review-scope']) {
    const scope = nodeFromHtml(html, id);
    assert.equal(valueOf(rules, scope, 'padding-block', MOBILE), 'var(--space-2)', `#${id}`);
    assert.equal(valueOf(legacy, scope, 'padding-block', MOBILE), null, `#${id}: padding-block 이 버려진다`);
    assert.equal(valueOf(legacy, scope, 'padding', MOBILE), 'var(--space-3)', `#${id}`);
  }
});

test('css-snapshot: 선택자 목록은 :is()·:where() 밖에서 쓴 새 선택자 하나로 버려지고, 격자는 중단점 양쪽을 담는다', () => {
  const has = /:has\(/;
  const focusVisible = /:focus-visible/;
  assert.equal(selectorUses('body:has(.x) .app-bar', has), true);
  assert.equal(selectorUses('.app-bar', has), false);
  // :has() 안의 :is() 뒤에 붙은 :focus-visible 은 너그러운 목록 밖이다 — 규칙째 버려진다
  assert.equal(selectorUses(":root:has(:is(button, a[href]):focus-visible) .is-standing:not(:focus-visible)", focusVisible), true);
  assert.throws(() => selectorUses(':is(.a, :focus-visible)', focusVisible), /너그러운|손으로/);

  const list = [{ selectors: ['.app-bar', 'body:has(.x) .app-bar'], declarations: [{ property: 'position', value: 'fixed', important: false }], media: [], order: 0 }];
  const dropped = withoutFeatures(list, ['has']);
  assert.equal(dropped.rules.length, 0, '목록의 한 선택자가 :has() 면 .app-bar 갈래도 함께 버려진다');
  assert.deepEqual([...dropped.longhands], ['position']);

  const logical = [{ selectors: ['.x'], declarations: [
    { property: 'padding', value: '12px', important: false },
    { property: 'padding-block', value: '8px', important: false },
    { property: '--gap', value: '100svh', important: false },
  ], media: [], order: 0 }];
  assert.deepEqual(withoutFeatures(logical, ['logical']).rules[0].declarations.map((d) => d.property), ['padding', '--gap']);
  assert.equal(withoutFeatures(logical, ['viewportUnits']).rules[0], logical[0], '사용자 속성의 값은 버리지 않는다');

  const { widths, heights } = breakpoints(['(max-width: 420px)', '(min-width: 600px), (orientation: landscape)', '(pointer: coarse) and (max-height: 480px)']);
  for (const value of [419, 420, 421, 599, 600, 601]) assert.ok(widths.includes(value), `폭 ${value}`);
  for (const value of [479, 480, 481]) assert.ok(heights.includes(value), `높이 ${value}`);
  assert.throws(() => breakpoints(['(max-width: 40em)']), /px/);
});
