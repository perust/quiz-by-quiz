import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, loadStyles, node, nodeFromHtml, valueOf, winning } from './css-cascade.mjs';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

const SCREENS = {
  quiz: {
    pieces: ['quiz-category', 'quiz-position', 'progress', 'arena-help', 'quiz-exit', 'timer'],
    question: 'question-text',
  },
  'online-quiz': {
    pieces: [
      'online-quiz-category', 'online-quiz-position', 'online-progress',
      'online-arena-help', 'online-quiz-exit', 'online-timer',
    ],
    question: 'online-question-text',
  },
};

function hudOf(element) {
  for (let ancestor = element; ancestor; ancestor = ancestor.parent) {
    if (ancestor.classes.includes('quiz-hud')) return ancestor;
  }
  return null;
}

test('퀴즈 HUD: 분야·문항 위치·진행률·조작법·나가기·타이머가 한 블록 안에 읽는 순서대로 모인다', async () => {
  const html = await source('index.html');

  for (const [screen, { pieces, question }] of Object.entries(SCREENS)) {
    let previous = -1;
    for (const id of pieces) {
      const element = nodeFromHtml(html, id);
      const hud = hudOf(element);
      assert.ok(hud, `${screen}: #${id} 는 HUD 블록 안에 있어야 한다`);
      let screenOfHud = hud;
      while (screenOfHud && screenOfHud.attrs['data-screen'] === undefined) screenOfHud = screenOfHud.parent;
      assert.equal(screenOfHud?.attrs['data-screen'], screen, `#${id} 는 ${screen} 화면의 HUD에 있어야 한다`);

      const at = html.indexOf(`id="${id}"`);
      assert.ok(at > previous, `${screen}: #${id} 의 순서가 어긋났다`);
      previous = at;
    }
    assert.equal(hudOf(nodeFromHtml(html, question)), null, `${screen}: 문제는 HUD 다음에 온다`);
    assert.ok(html.indexOf(`id="${question}"`) > previous, `${screen}: 문제는 HUD 뒤에 온다`);
  }
});

test('퀴즈 HUD: 진행률은 접근 가능한 progressbar로, 타이머는 저절로 낭독하지 않는 채로 남는다', async () => {
  const html = await source('index.html');
  for (const id of ['progress', 'online-progress']) {
    const progress = nodeFromHtml(html, id);
    assert.equal(progress.attrs.role, 'progressbar');
    assert.ok(progress.attrs['aria-label'], `#${id} 에는 이름이 있어야 한다`);
    for (const attr of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow']) {
      assert.ok(attr in progress.attrs, `#${id} 의 ${attr}`);
    }
  }
  for (const id of ['online-timer']) {
    assert.equal(nodeFromHtml(html, id).attrs['aria-hidden'], 'true', `#${id} 는 1초마다 낭독되면 안 된다`);
  }
});

test('퀴즈 HUD: 로컬 남은 시간 글은 브라우즈 모드에서 찾아 읽히고, 막대·아이콘만 숨긴다', async () => {
  const [html, quiz] = await Promise.all([source('index.html'), source('src/ui/quiz.ts')]);

  // 조상의 aria-hidden 은 자손에서 풀 수 없다. 그래서 영역(#timer)이 아니라 그림 조각에만 단다
  const text = nodeFromHtml(html, 'timer-text');
  for (let element = text; element; element = element.parent) {
    assert.notEqual(element.attrs['aria-hidden'], 'true', `#timer-text 의 조상 <${element.tag}${element.id ? `#${element.id}` : ''}> 이 글을 숨긴다`);
    // 라이브 리전이 아니어야 1초마다 낭독되지 않는다
    assert.equal(element.attrs['aria-live'], undefined, `<${element.tag}${element.id ? `#${element.id}` : ''}> 에 aria-live 를 달지 않는다`);
    assert.ok(!['status', 'alert', 'log', 'timer', 'marquee'].includes(element.attrs.role), `<${element.tag}> 의 role=${element.attrs.role}`);
  }
  assert.equal(nodeFromHtml(html, 'timer-icon').attrs['aria-hidden'], 'true', '시계·경고 아이콘은 그림이다');
  const track = nodeFromHtml(html, 'timer-fill').parent;
  assert.ok(track.classes.includes('timer__track'));
  assert.equal(track.attrs['aria-hidden'], 'true', '막대는 눈으로만 본다');

  // 남은 5초는 문항당 한 번만 알리고, 재촉하지 않는 말로 쓴다 (PRD 2.1, FR-3.9)
  assert.equal(quiz.match(/announce\(/g)?.length, 1, 'announce 는 5초 경고 한 곳뿐이다');
  assert.match(quiz, /if \(isWarning && !warned\) \{\s*warned = true;\s*announce\('시간이 얼마 남지 않았습니다\.'\);/);
  assert.ok(quiz.includes('`${seconds}초 남았어요`'));
  assert.doesNotMatch(quiz, /서두르세요/);
});

test('퀴즈 HUD: 전체 도전에서는 분야 칩이 문항마다 «전체 도전 · 분야»를 보이고 분야 색은 칠하지 않는다 (FR-2.2)', async () => {
  const [quiz, css, theme] = await Promise.all([
    source('src/ui/quiz.ts'), source('css/style.css'), source('css/voxel-theme.css'),
  ]);
  assert.match(quiz, /const CATEGORY_NAMES = new Map\(CATEGORIES\.map\(\(category\) => \[category\.id, category\.name\]\)\);/);
  assert.match(
    quiz,
    /function renderQuestion\(\): void \{[\s\S]*?session!\.mode === 'all' \? CATEGORY_NAMES\.get\(question\.category\) : undefined;\s*el\.category\.textContent = categoryName \? `\$\{categoryLabel\} · \$\{categoryName\}` : categoryLabel;/,
  );
  // 분야 색은 아이콘 칸에만 쓴다 (docs/design-system.md §1·§3)
  assert.doesNotMatch(quiz, /el\.category\.(?:dataset|setAttribute\('data-category')/);
  for (const text of [css, theme]) assert.doesNotMatch(text, /\.quiz-category\[data-category/);

  // 칩이 길어져도 문항 위치 칸은 제 글 폭 아래로 줄지 않는다 — 칩이 말줄임으로 물러난다
  const meta = node('div.quiz-meta', node('header.quiz-header', node('div.quiz-hud', node("section.screen.quiz--character[data-screen='quiz']"))));
  for (const env of [NARROW, DESKTOP]) {
    const columns = valueOf(rules, meta, 'grid-template-columns', env) ?? '';
    const [, position] = columns.match(/^minmax\(0, auto\)\s+(minmax\(auto, 1fr\)|auto)(?:\s|$)/) ?? [];
    assert.ok(position, `${env.width}px: 칩 다음 칸(문항 위치)이 0까지 줄 수 있다: ${columns}`);
  }
});

test('퀴즈 HUD: 하나의 블록 표면이고, 안쪽 조각은 따로 놀던 구분선과 여백을 버린다', () => {
  const quiz = node("section.screen.quiz--character[data-screen='quiz']", node('main.app', node('body')));
  const hud = node('div.quiz-hud', quiz);
  const header = node('header.quiz-header', hud);
  const meta = node('div.quiz-meta', header);
  const progress = node('div.progress#progress', meta);
  const timer = node('div.timer#timer', hud);

  for (const env of [DESKTOP, NARROW]) {
    assert.match(valueOf(rules, hud, 'border-color', env) ?? '', /var\(--hud-line\)/, 'HUD는 월드 위의 전용 선을 가진다');
    assert.match(valueOf(rules, hud, 'background', env) ?? '', /var\(--hud-bg\)/, 'HUD는 깊은 보라 edge 표면이다');
    assert.match(valueOf(rules, hud, 'box-shadow', env) ?? '', /^var\(--elevation-2\)$/, 'HUD는 월드 위에 뜬 높이(2)에 있다');

    // 구분선 선언이 아예 없거나 0/none 이어야 한다. HUD 안에 따로 노는 줄을 긋지 않는다
    const divider = valueOf(rules, header, 'border-bottom', env);
    assert.ok(divider === null || /^(?:0|none)\b/.test(divider), `헤더 아래 구분선은 HUD 안에서 없다: ${divider}`);
    for (const [label, element] of [['헤더', header], ['진행률', progress], ['타이머', timer]]) {
      assert.match(valueOf(rules, element, 'margin-bottom', env), /^0(?:px)?$/, `${label}는 HUD 안에서 따로 아래 여백을 두지 않는다`);
    }
    assert.equal(valueOf(rules, timer, 'display', env), 'flex', '남은 시간 글자와 막대는 한 줄로 읽힌다');
  }

  assert.match(valueOf(rules, hud, 'padding', DESKTOP) ?? '', /\b64px\b/, '설정 HUD 한 칸을 비운다');
  assert.equal(valueOf(rules, hud, 'padding-right', NARROW), '52px', '320px에서는 문항 위치와 ?가 겹치지 않게 12px을 되돌린다');
});

test('퀴즈 HUD: 첫 문제를 받기 전(분야·위치가 빈 로딩 중)에도 진행률 막대가 제 칸을 지킨다', () => {
  // 온라인 퀴즈는 서버 상태를 받기 전에 화면이 먼저 열린다. 빈 분야 칩이 숨으면 자동
  // 배치된 진행률이 폭 없는 칸으로 밀려 막대가 사라졌다가, 문제가 오면 튀어나왔다
  const quiz = node("section.screen.quiz--character[data-screen='online-quiz']", node('main.app', node('body')));
  const meta = node('div.quiz-meta', node('header.quiz-header', node('div.quiz-hud', quiz)));
  const progress = node('div.progress#online-progress', meta);

  assert.match(valueOf(rules, progress, 'grid-column', DESKTOP), /^-2(?:\s*\/\s*-1)?$/, '넓으면 마지막 열에 못 박는다');
  assert.match(valueOf(rules, progress, 'grid-column', NARROW), /^1\s*\/\s*-1$/, '좁으면 한 줄을 다 쓴다');
});

test('퀴즈 HUD: 두 자리 현재·전체 문항도 ? 버튼 앞에서 넘치지 않도록 공백 없는 짧은 표기를 쓴다', async () => {
  const [local, online] = await Promise.all([source('src/ui/quiz.ts'), source('src/ui/online-quiz.ts')]);
  assert.ok(local.includes('`${session!.position}/${session!.total}`'));
  assert.ok(online.includes('`${question.position}/${question.total}`'));
  assert.ok(local.includes('`전체 ${session!.total}문제 중 ${session!.position}번 문제`'));
  assert.ok(online.includes('`전체 ${question.total}문제 중 ${question.position}번 문제`'));
});

/** 캐스케이드에서 a 가 b 를 이기는가 (중요도 → 명시도 → 순서) */
function outranks(a, b) {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i += 1) {
    if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i];
  }
  return a.order > b.order;
}

test('퀴즈 HUD: ?·나가기의 초점·올라섬 고리와 남은 5초 경고 색은 두 화면의 어두운 HUD 위에서 보인다', async () => {
  const html = await source('index.html');
  for (const [screen, { pieces }] of Object.entries(SCREENS)) {
    // 실제 마크업 사슬: section.quiz--character > div.quiz-hud > header > button
    for (const id of [pieces[3], pieces[4]]) {
      const button = nodeFromHtml(html, id);
      for (const state of ['focus-visible', null]) {
        const element = { ...button, states: state ? [state] : [], classes: state ? button.classes : [...button.classes, 'is-standing'] };
        for (const env of [DESKTOP, MOBILE]) {
          const color = winning(rules, element, 'outline-color', env);
          const shorthand = winning(rules, element, 'outline', env);
          assert.equal(color?.value, 'var(--focus-on-hud)', `${screen} #${id} ${state ?? 'is-standing'}`);
          // 뒤에 오거나 더 센 outline 단축 속성이 색을 보라로 되돌리지 않는다
          assert.ok(!(shorthand && outranks(shorthand, color)), `${screen} #${id}: ${shorthand?.selector} 가 고리 색을 덮는다`);
        }
      }
    }

    const timer = nodeFromHtml(html, pieces[5]);
    const hud = timer.parent;
    const warningHud = { ...hud, has: ['.timer--warning'] };
    const warningTimer = { ...timer, parent: warningHud, classes: [...timer.classes, 'timer--warning'] };
    const label = node('p.timer__label', warningTimer);
    const fill = node('div.timer__fill', node('div.timer__track', warningTimer));
    for (const env of [DESKTOP, NARROW]) {
      assert.equal(valueOf(rules, label, 'color', env), 'var(--hud-warning)', `${screen}: 경고 글자`);
      assert.equal(valueOf(rules, fill, 'background', env), 'var(--hud-warning)', `${screen}: 경고 막대`);
      assert.equal(valueOf(rules, warningHud, 'border-color', env), 'var(--hud-warning)', `${screen}: 경고 HUD 선`);
    }
  }
});
