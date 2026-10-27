import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('모든 walker는 단일 이동 UI 컴포넌트의 DOM·입력 수명을 재사용한다', async () => {
  const [html, controls, walker] = await Promise.all([
    source('../index.html'),
    source('../src/ui/walk-controls.ts'),
    source('../src/ui/walker.ts'),
  ]);

  assert.equal((html.match(/id="walk-controls"/g) ?? []).length, 1);
  assert.equal((html.match(/id="walk-stick"/g) ?? []).length, 1);
  assert.equal((html.match(/id="walk-confirm"/g) ?? []).length, 1);
  assert.match(html, /class="walk-controls" id="walk-controls" aria-hidden="true"/);
  assert.match(html, /class="walk-confirm" id="walk-confirm" tabindex="-1"/);
  assert.match(html, /id="walk-controls"[\s\S]*?id="walk-stick"[\s\S]*?id="walk-confirm"[\s\S]*?<\/div>\s*<\/main>/);

  assert.match(walker, /createWalkControls\(\{/);
  assert.match(walker, /controls\.show\(options\)/);
  assert.match(walker, /controls\.hide\(\)/);
  assert.match(walker, /controls\.contains\(hit\)/);
  assert.doesNotMatch(walker, /getElementById\(['"]walk-(?:stick|confirm|controls)/);
  assert.doesNotMatch(walker, /addEventListener\(['"]pointer(?:down|move|up|cancel)/);
  assert.doesNotMatch(walker, /closest\(['"][^'"]*\.walk-(?:stick|confirm)/);

  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.match(controls, new RegExp(`addEventListener\\('${event}'`), `${event} 수명은 컴포넌트가 소유한다`);
  }
  assert.match(controls, /setPointerCapture\(event\.pointerId\)/);
  assert.match(controls, /if \(event\.pointerId !== pointerId\) return/);
  assert.match(controls, /root\.dataset\.placement = options\.placement \?\? 'viewport'/);
  assert.match(controls, /root\.classList\.add\('walk-controls--on'\)/);
  assert.match(controls, /if \(!wasVisible\) release\(\)/);
});

test('화면은 공용 조작부에 배치만 선언하고 짧은 화면까지 같은 UI를 유지한다', async () => {
  const [css, theme, home, arena, onlineQuiz] = await Promise.all([
    source('../css/style.css'),
    source('../css/voxel-theme.css'),
    source('../src/ui/home.ts'),
    source('../src/ui/arena.ts'),
    source('../src/ui/online-quiz.ts'),
  ]);

  assert.match(home, /controls: \{ placement: 'home-dock' \}/);
  assert.doesNotMatch(`${arena}\n${onlineQuiz}\n${css}`, /shortViewport|data-short-viewport/);

  const styles = `${css}\n${theme}`;
  const screenStyledControls = [];
  const screenSizedControls = [];
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1].split(',')) {
      const target = selector.trim().split(/\s+/).at(-1) ?? '';
      const ancestor = selector.slice(0, selector.lastIndexOf(target));
      const screenScope = /\[data-screen|(?:^|[\s>+~])\.(?:home|quiz|online|waiting|ranking|characters|result)(?:\b|--)/.test(ancestor);
      const selectorScreenScope = /\[data-screen|(?:^|[\s>+~])\.(?:home|quiz|online|waiting|ranking|characters|result)(?:\b|--)/.test(selector);
      if (screenScope && /[.#]walk-(?:controls|stick|confirm|knob)(?:\b|__)/.test(target)) {
        screenStyledControls.push(selector.trim());
      }
      if (selectorScreenScope && /--walk-(?:stick|knob|confirm)-size\s*:/.test(match[2])) {
        screenSizedControls.push(selector.trim());
      }
    }
  }
  assert.deepEqual(screenStyledControls, [], '화면 이름으로 공용 조작부 자식을 스타일하지 않는다');
  assert.deepEqual(screenSizedControls, [], '화면 범위에서 공용 크기 토큰을 덮지 않는다');
  assert.match(css, /\.walk-controls--on \.walk-stick \{\s*display: block/);
  assert.match(css, /\.walk-controls--on \.walk-confirm \{\s*display: block/);
  assert.match(css, /\.walk-controls\[data-placement='home-dock'\]/);
  const shortQuiz = css.match(/@media \(pointer: coarse\) and \(max-height: 772px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(shortQuiz, /[.#]walk-(?:controls|stick|confirm|knob)/);
  assert.match(css, /\.walk-stick \{[\s\S]*?left: var\(--walk-stick-left\);[\s\S]*?bottom: var\(--walk-controls-bottom\)/);
  assert.match(css, /\.walk-confirm \{[\s\S]*?right: var\(--walk-confirm-right\);[\s\S]*?bottom: var\(--walk-controls-bottom\)/);

  assert.match(theme, /--walk-stick-size: 96px/);
  assert.match(theme, /--walk-knob-size: 48px/);
  assert.match(theme, /--walk-confirm-size: 72px/);
  assert.match(theme, /max-height: 360px[\s\S]*?--walk-stick-size: 44px/);
  assert.match(css, /width: var\(--walk-stick-size\)/);
  assert.match(css, /width: var\(--walk-knob-size\)/);
  assert.match(css, /width: var\(--walk-confirm-size\)/);
});

test('입력 상태가 조작부 모습을 정한다: 적는 동안 숨김·대상 없음 흐림·누르는 동안 눌림', async () => {
  const { MOBILE, loadStyles, node, valueOf } = await import('./css-cascade.mjs');
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const tree = (attrs = '', confirmClasses = '') => {
    const root = node(`div.walk-controls.walk-controls--on#walk-controls${attrs}`, node('main.app', node('body')));
    return {
      stick: node('div.walk-stick#walk-stick', root),
      confirm: node(`button.walk-confirm#walk-confirm${confirmClasses}`, root),
    };
  };

  const shown = tree("[data-armed='true']");
  assert.equal(valueOf(rules, shown.stick, 'display', MOBILE), 'block');
  assert.equal(valueOf(rules, shown.confirm, 'display', MOBILE), 'block');
  assert.equal(valueOf(rules, shown.confirm, 'background', MOBILE), 'var(--accent)');

  // 글자를 적는 동안에는 --on 이어도 둘 다 거둔다
  const typing = tree("[data-typing='true']");
  assert.equal(valueOf(rules, typing.stick, 'display', MOBILE), 'none');
  assert.equal(valueOf(rules, typing.confirm, 'display', MOBILE), 'none');

  // 누를 것이 없으면 채움을 거둔 빈 고리 — 색만이 아니라 채움·두께가 함께 빠진다
  const idle = tree("[data-armed='false']");
  assert.equal(valueOf(rules, idle.confirm, 'display', MOBILE), 'block', '흐려도 자리는 그대로다');
  assert.equal(valueOf(rules, idle.confirm, 'background', MOBILE), 'var(--glass)');
  assert.equal(valueOf(rules, idle.confirm, 'box-shadow', MOBILE), 'var(--elevation-1)');
  assert.match(valueOf(rules, idle.confirm, 'border', MOBILE) ?? '', /solid var\(--border-strong\)/);

  // 확정은 뗄 때 하므로 누르고 있는 동안의 눌림을 상태 클래스로도 그린다
  const pressed = tree("[data-armed='true']", '.walk-confirm--pressed');
  assert.equal(valueOf(rules, pressed.confirm, 'translate', MOBILE), '0 2px');
  assert.equal(valueOf(rules, pressed.confirm, 'background', MOBILE), 'var(--accent-hover)');
  assert.equal(valueOf(rules, pressed.confirm, 'touch-action', MOBILE), 'none');
});

test('제자리 뛰기는 끝없이 돌지 않고 세 번에서 멈춘다 (WCAG 2.2.2)', async () => {
  const { MOBILE, loadStyles, node, valueOf } = await import('./css-cascade.mjs');
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const walker = node('div.walker.walker--idle', node('body'));
  const body = node('span.walker__body', walker);
  const shadow = node('span.walker__shadow', walker);
  assert.equal(valueOf(rules, body, 'animation', MOBILE), 'walker-idle 1.1s 3');
  assert.equal(valueOf(rules, shadow, 'animation', MOBILE), 'walker-idle-shadow 1.1s 3');

  // 고를 때의 한 번 뛰기는 여전히 제자리 뛰기를 이긴다 (walker.ts가 animationend로 뗀다)
  const hop = node('div.walker.walker--idle.walker--hop', node('body'));
  assert.equal(valueOf(rules, node('span.walker__body', hop), 'animation', MOBILE), 'walker-land 0.42s');
});
