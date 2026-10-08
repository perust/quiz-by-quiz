import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { DESKTOP, loadStyles, resolveVars, tokens } from './css-cascade.mjs';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const root = tokens(rules, DESKTOP);

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

/** 역할 토큰을 별칭까지 풀어 #rrggbb 로 */
function hex(name) {
  const value = resolveVars(`var(${name})`, root);
  assert.match(value ?? '', /^#[0-9a-f]{6}$/i, `${name} 는 6자리 색으로 풀려야 한다: ${value}`);
  return value;
}

function contrastRatio(foreground, background) {
  const luminance = (value) => {
    const channels = value.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
    const linear = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };

  const [lighter, darker] = [luminance(foreground), luminance(background)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function assertContrast(pairs, minimum) {
  for (const [foreground, background] of pairs) {
    const ratio = contrastRatio(hex(foreground), hex(background));
    assert.ok(ratio >= minimum, `${foreground} on ${background} contrast ${ratio.toFixed(2)} is below ${minimum}:1`);
  }
}

test('디자인 층은 기본 스타일 뒤에 로드되고 로컬 한글 픽셀 폰트를 짧은 표식용으로만 둔다', async () => {
  const [html, theme] = await Promise.all([
    source('../index.html'),
    source('../css/voxel-theme.css'),
  ]);

  const baseStyle = html.indexOf('href="css/style.css"');
  const designLayer = html.indexOf('href="css/voxel-theme.css"');
  assert.ok(baseStyle !== -1 && designLayer > baseStyle);
  assert.match(theme, /@font-face\s*{[\s\S]*font-family:\s*['"]NeoDunggeunmo['"][\s\S]*url\(['"]fonts\/neodgm\.woff2['"]\)/);
  assert.match(theme, /font-display:\s*swap/);
  assert.match(root.get('--font-display') ?? '', /^'NeoDunggeunmo',/);
  assert.doesNotMatch(root.get('--font-text') ?? '', /NeoDunggeunmo/, '본문 글꼴은 읽기 좋은 시스템 글꼴이다');
  assert.equal(root.get('--space-1'), '4px');
});

test('홈은 장식 패널 대신 세로·가로 원본 월드 art를 viewport 전체에 쓴다', async () => {
  const [html, theme, mobileArt, desktopArt] = await Promise.all([
    source('../index.html'),
    source('../css/voxel-theme.css'),
    stat(new URL('../css/assets/world-academy-mobile.webp', import.meta.url)),
    stat(new URL('../css/assets/world-academy-desktop.webp', import.meta.url)),
  ]);
  const home = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const hero = between(home, '<header class="home-header">', '</header>');

  assert.match(hero, /<h1 class="home-title" id="home-title">/);
  assert.doesNotMatch(home, /class="voxel-scene/, '별도 장식 카드가 월드를 복제하지 않는다');
  assert.match(root.get('--world-art-mobile') ?? '', /world-academy-mobile\.webp/);
  assert.match(root.get('--world-art-desktop') ?? '', /world-academy-desktop\.webp/);
  assert.ok(mobileArt.size > 100_000, '세로 월드 art가 실재한다');
  assert.ok(desktopArt.size > 100_000, '가로 월드 art가 실재한다');
  assert.match(theme, /body:has\(\[data-screen='home'\]:not\(\[hidden\]\)\)[\s\S]*var\(--world-art-mobile\)/);
  assert.match(theme, /@media \(min-width: 600px\)[\s\S]*var\(--world-art-desktop\)/);
});

test('카테고리 카드는 분야 식별자를 노출해 같은 아이콘 묶음과 작은 식별 색을 받는다', async () => {
  const [homeSource, constants, theme] = await Promise.all([
    source('../src/ui/home.ts'),
    source('../src/constants.ts'),
    source('../css/voxel-theme.css'),
  ]);

  assert.match(homeSource, /card\.dataset\.category = category\.id/);
  assert.match(homeSource, /icon\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(homeSource, /icon\.dataset\.icon = category\.icon/);
  assert.doesNotMatch(homeSource, /icon\.textContent = category\.icon/, '아이콘 칸에 글리프를 넣지 않는다');
  for (const category of ['history', 'science', 'geography', 'general', 'art']) {
    assert.match(theme, new RegExp(`\\.category-card\\[data-category=['"]${category}['"]\\]`));
    assert.match(constants, new RegExp(`id: '${category}', name: '[^']+', icon: '[a-z-]+'`));
  }
});

test('주 행동·위험·상태 글자는 제 바탕에서 작은 글자 AA(4.5:1) 대비를 지킨다', () => {
  assertContrast([
    // 채운 버튼과 칩: 주 행동·눌림·위험·정답·오답 배지
    ['--on-accent', '--accent'],
    ['--on-accent', '--accent-hover'],
    ['--on-accent-muted', '--accent'],
    ['--on-accent-muted', '--accent-hover'],
    ['--on-accent', '--wrong'],
    ['--on-accent', '--correct'],
    // 옅은 바탕 위 글자: 선택·정답·오답·경고(시간·제출 대기·신기록)
    ['--accent-ink', '--accent-soft'],
    ['--accent-ink', '--accent-subtle'],
    ['--accent-ink', '--surface'],
    ['--accent-ink', '--surface-subtle'],
    ['--correct-ink', '--correct-soft'],
    ['--correct-ink', '--surface'],
    ['--wrong-ink', '--wrong-soft'],
    ['--wrong-ink', '--surface'],
    ['--warning', '--warning-soft'],
    ['--warning', '--surface'],
    ['--text', '--gold-soft'],
    ['--text', '--medal-silver'],
    ['--text', '--medal-bronze'],
    // 본문과 보조 글자
    ['--text', '--bg'],
    ['--text-muted', '--surface'],
    ['--text-muted', '--bg'],
    ['--text-muted', '--surface-subtle'],
    ['--text-muted', '--surface-sunken'],
    // 마을 패널 위 브랜드와 설명
    ['--accent-strong', '--world-sky-1'],
    ['--accent-strong', '--world-sky-2'],
    ['--text-muted', '--world-sky-2'],
  ], 4.5);

  // 분야 식별 색은 아이콘이지만 글자처럼 읽히게 둔다
  for (const category of ['history', 'science', 'geography', 'general', 'art']) {
    assertContrast([[`--cat-${category}`, `--cat-${category}-soft`]], 4.5);
  }
});

test('입력칸 테두리와 초점 고리는 흰 바탕에서 3:1 을 넘겨 칸과 위치가 보인다 (WCAG 1.4.11)', () => {
  assertContrast([
    ['--border-strong', '--surface'],
    ['--focus', '--surface'],
    ['--focus', '--bg'],
    ['--accent', '--surface'],
  ], 3);
});

test('아이콘은 번들 픽셀 글꼴에 없는 장식 글리프에 기대지 않는다', async () => {
  const files = [
    '../index.html',
    '../src/app.ts',
    '../src/constants.ts',
    '../src/ui/home.ts',
    '../src/ui/quiz.ts',
    '../src/ui/online.ts',
    '../src/ui/online-quiz.ts',
    '../src/ui/result.ts',
    '../src/ui/waiting-room.ts',
  ];
  // NeoDunggeunmo(css/fonts/neodgm.woff2)에 없는 글리프. 시스템 글꼴로 바뀌어 모양이 제각각이 된다.
  // 화살표는 조작법의 <kbd> 키 이름으로만 남긴다 — 장식이 아니라 실제 자판의 이름이다
  const unsupported = /[✓✗✔✘⏱⚠♛★☆✦♪♥⚙↻←→↑↓]/u;
  for (const file of files) {
    let text = await source(file);
    text = file.endsWith('.html')
      ? text.replace(/<!--[\s\S]*?-->/g, '').replace(/<kbd>[^<]*<\/kbd>/g, '')
      : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    const found = text.match(unsupported);
    assert.equal(found, null, `${file}: ${found?.[0]} 은 아이콘 묶음(data-icon)으로 그린다`);
  }
});

test('강제 색상 모드에서도 판정 아이콘은 시스템 글자색의 mask로 남는다', async () => {
  const theme = await source('../css/voxel-theme.css');
  const forced = theme.slice(theme.indexOf('@media (forced-colors: active)'));
  assert.match(forced, /\.choice--correct \.choice__mark::before,[\s\S]*\.choice--wrong \.choice__mark::before,[\s\S]*\.choice--submitted \.choice__mark::before[\s\S]*background-color:\s*CanvasText/);
  assert.match(forced, /\.feedback--correct \.feedback__verdict::before,[\s\S]*\.feedback--wrong \.feedback__verdict::before,[\s\S]*\.online-reveal--correct \.online-reveal__verdict::before,[\s\S]*\.online-reveal--wrong \.online-reveal__verdict::before[\s\S]*background:\s*CanvasText/);
  assert.match(forced, /\.feedback--correct \.feedback__verdict::before,[\s\S]*-webkit-mask:\s*var\(--badge-icon\)[\s\S]*mask:\s*var\(--badge-icon\)/);
});
