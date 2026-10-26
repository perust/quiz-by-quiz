import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, lengthOf, loadStyles, node, nodeFromHtml, valueOf } from './css-cascade.mjs';

// 홈 부제 (U09 뒤의 실측). 1024px 데스크톱에서 «4지선다 상식 퀴즈 · 혼자 또는 친구와»가 200px 폭에
// 들지 않아 «…혼자 또는» / «친구와»로 말 덩어리 한가운데에서 줄이 바뀌었고, 폭을 묶은 상자가 왼쪽에
// 붙어 가운데 정렬한 브랜드 아래가 아니라 마을 그림 위에 떴다.

const [html, rules] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  loadStyles(['css/style.css', 'css/voxel-theme.css']),
]);
const LAPTOP = { ...DESKTOP, width: 1024, height: 768 };
const MID = { width: 500, height: 900, pointer: 'coarse', hover: 'none', reducedMotion: false };

const markup = html.match(/<p class="home-subtitle">([\s\S]*?)<\/p>/)?.[1] ?? '';
const phrases = [...markup.matchAll(/<span class="home-subtitle__phrase">([^<]*)<\/span>/g)].map((match) => match[1]);
const text = markup.replace(/<[^>]+>/g, '');

/** 넉넉하게 잡은 글 폭: 한글은 1em, 그 밖(숫자·공백·가운뎃점)은 0.6em */
const estimateWidth = (value, fontSize) => [...value]
  .reduce((sum, char) => sum + (/[가-힣]/.test(char) ? 1 : 0.6) * fontSize, 0);

test('부제는 말 덩어리 둘이고, 덩어리 안에서는 줄을 바꾸지 않는다', () => {
  assert.deepEqual(phrases, ['4지선다 상식 퀴즈', '혼자·친구와']);
  assert.equal(text, '4지선다 상식 퀴즈 · 혼자·친구와');
  // 덩어리 밖의 줄 바꿈 자리는 가운뎃점 곁뿐이다
  assert.equal(markup.replace(/<span class="home-subtitle__phrase">[^<]*<\/span>/g, '|'), '| · |');

  const phrase = node('span.home-subtitle__phrase', node('p.home-subtitle', node('div.home-heading', node('header.home-header'))));
  for (const env of [LAPTOP, DESKTOP, MID]) {
    assert.equal(valueOf(rules, phrase, 'white-space', env), 'nowrap', `${env.width}px`);
  }
});

test('넓은 화면에서 부제는 한 줄에 들고, 브랜드 아래 가운데에 선다', () => {
  const subtitle = nodeFromHtml(html.replace('<p class="home-subtitle">', '<p class="home-subtitle" id="home-subtitle-probe">'), 'home-subtitle-probe');
  for (const env of [LAPTOP, DESKTOP]) {
    const at = `${env.width}×${env.height}`;
    assert.notEqual(valueOf(rules, subtitle, 'display', env), 'none', `${at}에서 보인다`);
    const fontSize = lengthOf(rules, valueOf(rules, subtitle, 'font-size', env), env);
    const maxWidth = lengthOf(rules, valueOf(rules, subtitle, 'max-width', env), env);
    assert.equal(fontSize, 14, at);
    assert.ok(estimateWidth(text, fontSize) <= maxWidth, `${at}: 넉넉히 잡아도 ${maxWidth}px 안에 든다`);
    assert.equal(valueOf(rules, subtitle, 'margin-inline', env), 'auto', `${at}: 폭을 묶은 상자를 가운데에 둔다`);
    assert.equal(valueOf(rules, subtitle, 'word-break', env), 'keep-all', at);
  }
  // 예전 문구는 같은 계산으로 넘친다 — 이 검사가 실제로 줄 바꿈을 가려낸다
  assert.ok(estimateWidth('4지선다 상식 퀴즈 · 혼자 또는 친구와', 14) > 240);
});
