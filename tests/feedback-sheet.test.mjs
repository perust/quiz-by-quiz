import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, lengthOf, loadStyles, node, nodeFromHtml, tokens, valueOf } from './css-cascade.mjs';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const html = await source('index.html');

test('피드백 시트: 「다음 문제」의 키 표시는 시트가 실제로 놓인 자리에서 마우스·키보드 기기에만 보인다', () => {
  // 시트는 z-index 없이 위에 오려고 <main> 밖에 있다. 퀴즈 화면의 자손이 아니므로
  // «.quiz--character .key-hint» 같은 규칙은 이 표시에 닿지 않는다.
  const keyHint = node('span.key-hint', nodeFromHtml(html, 'next-button'));

  assert.equal(valueOf(rules, keyHint, 'display', DESKTOP), 'inline-flex', '키보드가 있는 기기에서는 보인다');
  assert.equal(valueOf(rules, keyHint, 'display', MOBILE), 'none', '손가락 기기에서는 쓸모가 없다');
  assert.equal(
    valueOf(rules, keyHint, 'display', { ...DESKTOP, width: 380 }),
    'none',
    '좁으면 버튼 글자와 부딪혀 접는다',
  );
});

test('피드백 시트: 데스크톱에서도 읽기 폭을 넘지 않고 가운데 붙는다', () => {
  const sheet = nodeFromHtml(html, 'feedback');
  const px = (value) => lengthOf(rules, value, DESKTOP);

  // 앱은 이제 전체 월드 폭이라 max-width가 없다. 시트만 기존 읽기 열
  // (--content-max - 양쪽 page pad)을 유지해 해설 한 줄이 과도하게 길어지지 않는다.
  const root = tokens(rules, DESKTOP);
  const column = px(root.get('--content-max')) - 2 * px(root.get('--page-pad'));
  const width = px(valueOf(rules, sheet, 'max-width', DESKTOP));
  assert.ok(Number.isFinite(column) && column > 0, `콘텐츠 열 폭을 계산하지 못했다: ${column}`);
  assert.equal(width, column);
});

test('피드백 패널: 문서 흐름에서 arena 뒤에 이어져 질문·보기·바닥 칸을 덮지 않는다', () => {
  const sheet = nodeFromHtml(html, 'feedback');
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(valueOf(rules, sheet, 'position', env), 'relative');
    assert.equal(valueOf(rules, sheet, 'overflow-y', env), 'auto');
  }
});

test('피드백 패널: 자동 스크롤 뒤 fixed 캐릭터도 arena와 함께 옮기고 다음 문제에서 맨 위로 돌아온다', async () => {
  const [quiz, arena] = await Promise.all([source('src/ui/quiz.ts'), source('src/ui/arena.ts')]);
  // 늘 패널 끝에 맞추지 않는다. 질문 머리를 남기는 최소 스크롤을 먼저 재고,
  // 둘이 한 화면에 들지 않을 때(null)만 예전처럼 끝에 맞춘다
  assert.doesNotMatch(quiz, /^\s*el\.feedback\.scrollIntoView\(\{ block: 'end' \}\);$/m, '무조건 끝에 맞추지 않는다');
  assert.match(
    quiz,
    /function scrollFeedbackIntoView\(\): void \{[\s\S]*?feedbackScrollTarget\(\{[\s\S]*?panelBottom: el\.feedback\.getBoundingClientRect\(\)\.bottom,[\s\S]*?questionTop: el\.question\.getBoundingClientRect\(\)\.top,[\s\S]*?if \(target === null\) el\.feedback\.scrollIntoView\(\{ block: 'end' \}\);[\s\S]*?window\.scrollTo\(0, target\)/,
  );
  assert.match(
    quiz,
    /function revealFeedback\([\s\S]*?scrollFeedbackIntoView\(\);\s*if \(feedbackCharacterAnchor\) arena\.restoreCharacterAnchor\(feedbackCharacterAnchor\);/,
    '스크롤한 뒤의 새 arena 자리에 캐릭터를 되돌린다',
  );
  assert.match(quiz, /feedbackCharacterAnchor = arena\.captureCharacterAnchor\(\)/);
  assert.match(quiz, /arena\.restoreCharacterAnchor\(feedbackCharacterAnchor\)/);
  assert.match(quiz, /if \(wasVisible\) window\.scrollTo\(0, 0\)/);
  assert.match(arena, /captureCharacterAnchor\(\)[\s\S]*?character\.bottom - grid\.top/);
  assert.match(arena, /restoreCharacterAnchor\(anchor\)[\s\S]*?grid\.top \+ anchor\.y/);
  assert.doesNotMatch(arena, /shiftForPageScroll/);
});

test('피드백 시트: 판정은 글자색만이 아니라 시트 테두리와 ✓ ✗ 배지로도 구분된다', () => {
  const body = node('body');
  const sheetOf = (state) => node(`div.feedback.feedback--${state}#feedback`, body);
  const verdictOf = (state) => node('p.feedback__verdict::before', sheetOf(state));
  const root = tokens(rules, DESKTOP);

  for (const env of [DESKTOP, MOBILE]) {
    assert.match(valueOf(rules, sheetOf('correct'), 'border-color', env), /var\(--correct\)/);
    assert.match(valueOf(rules, sheetOf('wrong'), 'border-color', env), /var\(--wrong\)/);
  }

  // 배지는 상태 색으로 채운 칸 위의 흰 아이콘이다. 정답은 체크, 오답·시간 초과는 엑스 —
  // 색을 못 보는 사람에게도 모양이 다르다
  const badge = {
    correct: valueOf(rules, verdictOf('correct'), '--badge-icon', DESKTOP),
    wrong: valueOf(rules, verdictOf('wrong'), '--badge-icon', DESKTOP),
  };
  assert.equal(badge.correct, 'var(--i-check-inverse)');
  assert.equal(badge.wrong, 'var(--i-cross-inverse)');
  for (const name of ['--i-check-inverse', '--i-cross-inverse']) {
    assert.match(root.get(name) ?? '', /^url\("data:image\/svg\+xml,.*viewBox='0 0 24 24'/, `${name} 는 24×24 아이콘이다`);
  }
  assert.equal(valueOf(rules, verdictOf('correct'), '--badge-color', DESKTOP), 'var(--correct)');
  assert.equal(valueOf(rules, verdictOf('wrong'), '--badge-color', DESKTOP), 'var(--wrong)');
  assert.match(valueOf(rules, verdictOf('correct'), 'background', DESKTOP), /var\(--badge-icon\)[\s\S]*var\(--badge-color\)/);

  // 라이브 리전 안이라 배지는 다시 낭독할 글자가 없어야 한다
  for (const state of ['correct', 'wrong']) {
    assert.equal(valueOf(rules, verdictOf(state), 'content', DESKTOP), "''");
  }
});

test('피드백 패널: 질문 머리를 남기는 만큼만 스크롤하고, 둘이 한 화면에 들지 않을 때만 패널 끝에 맞춘다', async () => {
  const { feedbackScrollTarget } = await import('../js/ui/feedback-view.js');
  const at = (scrollY, panelBottom, questionTop, viewportHeight = 800) =>
    feedbackScrollTarget({ scrollY, viewportHeight, panelBottom, questionTop });

  // 패널 끝이 화면 아래로 100px 잘렸고 질문 머리는 120px 아래에 있다 → 100px만 내린다
  assert.equal(at(0, 900, 120), 100);
  // 이미 둘 다 보이면 움직이지 않는다
  assert.equal(at(40, 780, 60), 40);
  // 사용자가 내려와 질문이 화면 위에 있으면, 둘 다 보이는 가장 가까운 자리로 올라간다
  assert.equal(at(300, 500, -50), 250);
  // 질문 머리와 패널 끝 사이가 화면보다 길면 null — 그때만 패널 끝(「다음 문제」)에 맞춘다
  assert.equal(at(0, 1000, 120), null);
  // 꼭 맞으면 담는다
  assert.equal(at(0, 920, 120), 120);
});

test('피드백 패널: 패널이 열리면 arena를 바닥에 붙이던 빈 높이를 거두어 질문과 함께 담길 여지를 만든다', () => {
  const quizOf = (body) => node("section.screen.quiz--character[data-screen='quiz']", node('main.app', body));
  const open = quizOf(node('body', null, { has: ['#feedback:not([hidden])'] }));
  const closed = quizOf(node('body'));
  for (const env of [DESKTOP, MOBILE]) {
    assert.equal(valueOf(rules, closed, 'min-height', env), '100svh', '문제를 푸는 동안 arena는 화면 바닥에 선다');
    assert.equal(valueOf(rules, open, 'min-height', env), '0', '결과 패널이 열리면 빈 높이를 거둔다');
  }
});

test('정답 줄: 틀렸을 때 판정 바로 뒤, 라이브 리전 안에서 정답과 내 답을 글로 말한다 (FR-4.2)', () => {
  const answer = nodeFromHtml(html, 'feedback-answer');
  assert.equal(answer.parent.attrs.role, 'status', '판정·해설과 같은 라이브 리전 안에 있다');
  assert.ok('hidden' in answer.attrs, '정답일 때는 접혀 있다');
  assert.deepEqual(answer.classes, ['feedback__answer']);

  const verdict = html.indexOf('id="feedback-verdict"');
  const block = html.indexOf('id="feedback-answer"');
  const explanation = html.indexOf('id="feedback-explanation"');
  assert.ok(verdict < block && block < explanation, '판정 → 정답 줄 → 해설 순서로 읽힌다');

  // 온라인 결과 공개와 나눠 쓰는 마크업 계약
  const markup = html.slice(block, explanation);
  assert.match(
    markup,
    /<p class="feedback__answer-row" data-kind="correct"><span class="feedback__answer-label">정답<\/span> <span class="feedback__answer-text"><\/span><\/p>\s*<p class="feedback__answer-row" data-kind="mine"><span class="feedback__answer-label">내 답<\/span> <span class="feedback__answer-text"><\/span><\/p>/,
  );
});

test('정답 줄: 실제 문제 은행 전부에서 오답·시간 초과면 정답 번호와 보기 글이 나오고, 원문자를 쓰지 않는다', async () => {
  const { answerLines } = await import('../js/ui/feedback-view.js');
  const banks = ['art', 'general', 'geography', 'history', 'science'];
  let questionCount = 0;
  for (const bank of banks) {
    const questions = JSON.parse(await source(`data/${bank}.json`));
    for (const question of questions) {
      questionCount += 1;
      const wrongs = question.choices.map((_, index) => index).filter((index) => index !== question.answerIndex);
      for (const chosen of [...wrongs, null]) {
        const lines = answerLines(question, chosen);
        assert.equal(lines.correct, `${question.answerIndex + 1}번 · ${question.choices[question.answerIndex]}`, question.id);
        assert.equal(lines.mine, chosen === null ? '고르지 않음' : `${chosen + 1}번 · ${question.choices[chosen]}`, question.id);
        assert.doesNotMatch(`${lines.correct} ${lines.mine}`, /[\u2460-\u24ff\u2776-\u2793]/, `${question.id}: 번들 글꼴에 없는 원문자`);
      }
    }
  }
  assert.ok(questionCount >= 550, `은행 전부를 돌았다: ${questionCount}문항`);
});

test('정답 줄: 먼저 펼치고 채운다 — 맞았으면 접고, 틀렸으면 드러낸 뒤 글을 넣는다', async () => {
  const quiz = await source('src/ui/quiz.ts');
  assert.match(
    quiz,
    /el\.feedback\.hidden = false;\s*el\.answer\.hidden = record\.correct;[\s\S]*?if \(!record\.correct\) \{\s*const lines = answerLines\(question, record\.choiceIndex\);\s*el\.answerCorrect\.textContent = lines\.correct;\s*el\.answerMine\.textContent = lines\.mine;/,
  );
});

test('정답 줄: 화면에 묶지 않은 한 벌의 모양이고, 색만이 아니라 라벨 글·✓ ✗ 아이콘·굵기로 갈린다', () => {
  // 온라인 결과 공개도 같은 클래스를 쓰므로 로컬 피드백 밖(아무 부모)에서도 같은 값이어야 한다
  for (const parent of [nodeFromHtml(html, 'feedback-answer'), node('div', node('section', node('body')))]) {
    const row = (kind) => node(`p.feedback__answer-row[data-kind='${kind}']`, parent);
    const label = (kind) => node('span.feedback__answer-label', row(kind));
    const icon = (kind) => node('span.feedback__answer-label::before', row(kind));
    const text = (kind) => node('span.feedback__answer-text', row(kind));

    for (const env of [DESKTOP, MOBILE]) {
      assert.equal(valueOf(rules, row('correct'), 'display', env), 'flex', '라벨과 글이 한 줄로 선다');
      assert.equal(valueOf(rules, label('correct'), 'background', env), 'var(--correct-soft)');
      assert.equal(valueOf(rules, label('mine'), 'background', env), 'var(--wrong-soft)');
      assert.equal(valueOf(rules, label('correct'), 'color', env), 'var(--correct-ink)');
      assert.equal(valueOf(rules, label('mine'), 'color', env), 'var(--wrong-ink)');
      assert.equal(valueOf(rules, label('correct'), '--icon', env), 'var(--i-check)', '정답은 ✓ 모양');
      assert.equal(valueOf(rules, label('mine'), '--icon', env), 'var(--i-cross)', '내 답은 ✗ 모양');
      assert.equal(valueOf(rules, icon('correct'), 'content', env), "''", '아이콘은 낭독할 글자가 없다');
      assert.equal(valueOf(rules, text('correct'), 'font-weight', env), 'var(--weight-heavy)', '정답 글은 굵다');
      assert.equal(valueOf(rules, text('mine'), 'font-weight', env), null, '내 답 글은 굵게 세우지 않는다');
    }
  }
});
