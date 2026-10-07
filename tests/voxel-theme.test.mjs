import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

function colorToken(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing color token: ${name}`);
  return match[1];
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
    const linear = channels.map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };

  const [lighter, darker] = [luminance(foreground), luminance(background)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('복셀 테마는 기본 스타일 뒤에 로드되고 로컬 한글 픽셀 폰트를 쓴다', async () => {
  const [html, theme] = await Promise.all([
    source('../index.html'),
    source('../css/voxel-theme.css'),
  ]);

  const baseStyle = html.indexOf('href="css/style.css"');
  const voxelStyle = html.indexOf('href="css/voxel-theme.css"');
  assert.ok(baseStyle !== -1 && voxelStyle > baseStyle);
  assert.match(theme, /@font-face\s*{[\s\S]*font-family:\s*['"]NeoDunggeunmo['"][\s\S]*url\(['"]fonts\/neodgm\.woff2['"]\)/);
  assert.match(theme, /font-display:\s*swap/);
  assert.match(theme, /--voxel-unit:\s*4px/);
  assert.match(theme, /--font-block:\s*['"]NeoDunggeunmo['"]/);
});

test('홈 첫 화면은 지형·건물·나무가 있는 장식용 아이소메트릭 마을을 가진다', async () => {
  const html = await source('../index.html');
  const home = between(html, 'data-screen="home"', 'data-screen="quiz"');
  const scene = between(home, '<div class="voxel-scene"', '</div><!-- /voxel-scene -->');

  assert.match(scene, /aria-hidden="true"/);
  assert.match(scene, /class="voxel-island/);
  assert.ok((scene.match(/class="voxel-building/g) ?? []).length >= 2, '건물은 둘 이상이어야 한다');
  assert.ok((scene.match(/class="voxel-tree/g) ?? []).length >= 3, '나무는 셋 이상이어야 한다');
  assert.match(scene, /class="voxel-path/);
});

test('카테고리 카드는 분야 식별자를 노출해 일관된 블록 아이콘과 색을 받는다', async () => {
  const [homeSource, theme] = await Promise.all([
    source('../src/ui/home.ts'),
    source('../css/voxel-theme.css'),
  ]);

  assert.match(homeSource, /card\.dataset\.category = category\.id/);
  assert.match(homeSource, /icon\.setAttribute\('aria-hidden', 'true'\)/);
  for (const category of ['history', 'science', 'geography', 'general', 'art']) {
    assert.match(theme, new RegExp(`\\.category-card\\[data-category=['"]${category}['"]\\]`));
  }
});

test('블록 UI는 둥근 카드 대신 단단한 모서리·하단 입체 그림자·눌림 피드백을 공유한다', async () => {
  const theme = await source('../css/voxel-theme.css');

  assert.match(theme, /\.button,[\s\S]*?\.category-card,[\s\S]*?\.menu-card,[\s\S]*?\.challenge-card\s*{[\s\S]*?border-width:\s*2px[\s\S]*?border-radius:\s*var\(--block-radius\)[\s\S]*?box-shadow:\s*var\(--block-shadow\)/);
  assert.match(theme, /\.category-card:active:not\(:disabled\)[\s\S]*?translate:\s*0 4px/);
  assert.match(theme, /\.walker__body\s*{[\s\S]*?border-radius:\s*8px 8px 4px 4px/);
  assert.match(theme, /@media \(max-width:\s*420px\)[\s\S]*?\.voxel-scene/);
});

test('핵심 버튼 색은 기본·호버·위험 상태에서 작은 글자 AA 대비를 지킨다', async () => {
  const theme = await source('../css/voxel-theme.css');
  const white = '#ffffff';
  const pairs = [
    ['--purple', white],
    ['--purple', colorToken(theme, '--purple-soft')],
    ['--purple-hover', white],
    ['--danger', white],
  ];

  for (const [token, background] of pairs) {
    const ratio = contrastRatio(colorToken(theme, token), background);
    assert.ok(ratio >= 4.5, `${token} contrast ${ratio.toFixed(2)} is below 4.5:1`);
  }
  assert.match(theme, /\.button--primary:hover\s*{[\s\S]*?background:\s*var\(--purple-hover\)/);
  assert.match(theme, /\.walk-confirm:active\s*{[\s\S]*?background:\s*var\(--purple-hover\)/);
});

test('상태 블록의 작은 글자는 제 바탕에서 AA 대비를 지킨다', async () => {
  const theme = await source('../css/voxel-theme.css');
  const white = '#ffffff';
  const pairs = [
    // 정답·오답 공개: 채운 번호 칸과 ✓ ✗ 알약, 칸 번호
    [white, '--correct'],
    [white, '--wrong'],
    ['--correct', '--correct-soft'],
    ['--wrong', '--wrong-soft'],
    // 온라인 «제출됨» 대기, HUD 분야 칩, 시간 경고, 랭킹 순위 칸
    ['--ink', '--yellow-soft'],
    ['--ink', '--yellow'],
    ['--purple-dark', '--purple-soft'],
    ['--warning', '--cream'],
    ['--ink', '--silver'],
    ['--ink', '--peach'],
  ];

  for (const [foreground, background] of pairs) {
    const fg = foreground.startsWith('#') ? foreground : colorToken(theme, foreground);
    const bg = colorToken(theme, background);
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, `${foreground} on ${background} contrast ${ratio.toFixed(2)} is below 4.5:1`);
  }
});

test('블록 아이콘은 번들 폰트에 없는 장식 글리프에 의존하지 않는다', async () => {
  const activeUi = (await Promise.all([
    source('../index.html'),
    source('../src/app.ts'),
    source('../src/constants.ts'),
    source('../src/ui/online.ts'),
  ])).join('\n');

  assert.doesNotMatch(activeUi, /[✦♪★]/u);
});
