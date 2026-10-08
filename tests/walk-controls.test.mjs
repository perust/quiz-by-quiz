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
