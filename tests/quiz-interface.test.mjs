import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

  const compactChoice = block(css, '.quiz--character .choice');
  assert.match(compactChoice, /min-height:\s*44px\s*;/);

  const helpButton = block(css, '.arena__help');
  assert.match(helpButton, /width:\s*44px\s*;/);
  assert.match(helpButton, /height:\s*44px\s*;/);
});
