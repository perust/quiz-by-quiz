import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, lengthOf, loadStyles, node, valueOf } from './css-cascade.mjs';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function block(text, selector) {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = withoutComments.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`));
  assert.ok(match, `missing flat selector block: ${selector}`);
  return match[1];
}

test('퀴즈의 직접 보기와 조작법 버튼은 44px 이상 터치 목표를 유지한다', async () => {
  const [html, css] = await Promise.all([
    source('../index.html'),
    source('../css/style.css'),
  ]);

  const localQuizMarker = html.indexOf('data-screen="quiz"');
  const onlineQuizStart = html.indexOf('data-screen="online-quiz"');
  assert.notEqual(localQuizMarker, -1);
  assert.notEqual(onlineQuizStart, -1);

  const localQuizStart = html.lastIndexOf('<section', localQuizMarker);
  const localQuiz = html.slice(localQuizStart, onlineQuizStart);
  assert.match(localQuiz, /class="screen quiz--character"/);
  assert.match(localQuiz, /id="arena-help"[\s\S]*?<span class="sr-only">캐릭터 퀴즈 조작법<\/span>/);
  assert.match(localQuiz, /<ul class="choices" id="choices" aria-label="보기"><\/ul>/);

  // 보기 높이는 화면마다 다른 규칙이 정한다(56px · 420px 이하 52px · 짧은 가로 touch 44px). 예전에는 첫
  // 평평한 블록의 글자를 보았는데, 그 블록(44px)은 뒤의 월드 배치 규칙에 늘 덮여 화면에 나오지 않는 값이었다 —
  // 그 죽은 선언은 U49 에서 지웠다. 이제 이긴 값을 잰다
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const quiz = node("section.screen.quiz--character[data-screen='quiz']");
  const choice = node('button.choice', node('li', node('ul.choices#choices', quiz)));
  const envs = [DESKTOP, MOBILE, NARROW, { ...MOBILE, width: 740, height: 360 }, { ...MOBILE, width: 568, height: 320 }];
  for (const env of envs) {
    const height = lengthOf(rules, valueOf(rules, choice, 'min-height', env), env);
    assert.ok(height >= 44, `${env.width}×${env.height} 보기 ${height}px`);
  }

  const helpButton = block(css, '.arena__help');
  assert.match(helpButton, /width:\s*44px\s*;/);
  assert.match(helpButton, /height:\s*44px\s*;/);
});

test('조작법 대화상자는 확대 시 제목부터 읽도록 패널에 초기 포커스를 둔다', async () => {
  const [html, arena, quiz] = await Promise.all([
    source('../index.html'),
    source('../src/ui/arena.ts'),
    source('../src/ui/quiz.ts'),
  ]);

  for (const id of ['help-dialog', 'online-help-dialog']) {
    const marker = html.indexOf(`id="${id}"`);
    assert.notEqual(marker, -1, `${id} exists`);
    const fragment = html.slice(marker, marker + 260);
    assert.match(
      fragment,
      /<div class="dialog" role="dialog" tabindex="-1" aria-modal="true"/,
      `${id} panel can receive programmatic focus`,
    );
  }

  assert.match(arena, /el\.helpDialog\.scrollTop = 0;/);
  assert.match(arena, /helpPanel\?\.focus\(\{ preventScroll: true \}\);/);
  assert.doesNotMatch(arena, /el\.helpClose\.focus\(\);/);
  assert.match(
    quiz,
    /if \(!items\.includes\(document\.activeElement as HTMLElement\)\)[\s\S]*event\.preventDefault\(\);[\s\S]*\(event\.shiftKey \? last : first\)\.focus\(\);/,
    '패널 자체에 포커스가 있을 때 Tab과 Shift+Tab 모두 대화상자 안으로 들어간다',
  );
});

test('로컬 조작법은 실제 동작대로 말한다: 바닥 칸·보기를 직접 누르면 걷지 않고 바로 내고, 시간이 끝나면 밟은 칸이 답이다', async () => {
  const [html, readme] = await Promise.all([source('../index.html'), source('../README.md')]);
  const start = html.indexOf('id="help-dialog"');
  const end = html.indexOf('id="online-help-dialog"');
  assert.ok(start !== -1 && end > start);
  const help = html.slice(start, end);

  // 칸 click 은 캐릭터를 옮기지 않고 곧바로 답을 낸다 (src/ui/arena.ts 의 tile click → onChoose)
  assert.doesNotMatch(help, /걸어가서 (냅니다|내요)/);
  assert.match(help, /바닥 칸이나 위 보기를 직접 누르면 캐릭터가 걸어가지 않고 <strong>그 답을 바로 내요<\/strong>/);
  assert.match(help, /<strong>시간이 다 되면 그때 밟고 있는 칸이 답<\/strong>/);
  assert.match(help, /십자 틈에 서 있으면 아무것도 고르지 않은 것이라 시간 초과가 돼요/);

  // README 도 로컬 규칙을 같은 말로 적는다 — «시간이 끝나면 오답»이 아니다
  assert.doesNotMatch(readme, /시간이 끝나면 오답으로 처리하고/);
  assert.match(readme, /시간이 끝나면 그때 캐릭터가 밟고 있는 칸이 답이 되고, 아무 칸도 밟지 않았으면 시간 초과 오답이다/);
});

test('누르고 있는 Enter·Space·숫자키의 자동 반복은 해설을 건너뛰지 못한다 (FR-4.4)', async () => {
  const quiz = await source('../src/ui/quiz.ts');
  const handlerStart = quiz.indexOf("document.addEventListener('keydown', (event) => {");
  assert.notEqual(handlerStart, -1);
  const handler = quiz.slice(handlerStart, quiz.indexOf('\n  });', handlerStart));

  // 반복은 기본 동작까지 막는다 — 포커스가 간 「다음 문제」를 브라우저가 반복마다 누르기 때문이다
  const guard = handler.match(
    /if \(\s*event\.repeat\s*&& session\s*&& !el\.screen\.hidden\s*&& \(NEXT_KEYS\.includes\(event\.key\) \|\| CHOICE_KEYS\.includes\(event\.key\)\)\s*\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/,
  );
  assert.ok(guard, '자동 반복 가드가 있다');

  // 다른 어떤 처리보다 먼저 온다: 대화상자, 다음 문제, 숫자키, 캐릭터 고르기
  for (const later of ['if (!el.dialog.hidden)', 'goNext();', 'selectChoice(index);', 'arena.handleKey(event)']) {
    const at = handler.indexOf(later);
    assert.ok(at > guard.index, `${later} 보다 반복 가드가 먼저다`);
  }
});
