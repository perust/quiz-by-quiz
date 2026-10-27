// 방장이 고르는 온라인 문항 시간 (20초 기본 · 40초, FR-3.7) — 소유자 결정.
//
// 온라인에는 제한 없음이 없다: 한 사람이 답하지 않으면 방 전체가 마감까지 멈춘다.
// 대기실의 세 번째 «도는» 설정 칸, 방 만들기 폼의 고르기, 안내 문구, 좁은 화면의 배치를 잠근다.
// 동작은 tests/waiting-room-runtime.test.mjs·online-lobby-runtime.test.mjs·local-room-store.test.mjs·
// network-room-store.test.mjs·online-quiz-countdown.test.mjs가, 서버는 server/tests가 본다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadStyles, nodeFromHtml, valueOf, DESKTOP, MOBILE, NARROW } from './css-cascade.mjs';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

const plain = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

test('온라인 문항 시간은 20초·40초 둘뿐이고 20초 → 40초 → 20초로 돈다', async () => {
  const { ONLINE_QUESTION_TIME_CHOICES, TIME_LIMIT_MS } = await import('../js/constants.js');
  const {
    isOnlineQuestionTime, nextOnlineQuestionTime, onlineQuestionTimeLabel, onlineQuestionTimeOrDefault,
  } = await import('../js/online/rules.js');

  assert.deepEqual([...ONLINE_QUESTION_TIME_CHOICES], [20_000, 40_000]);
  assert.equal(ONLINE_QUESTION_TIME_CHOICES[0], TIME_LIMIT_MS, '첫 값이 기본이다');
  assert.equal(nextOnlineQuestionTime(20_000), 40_000);
  assert.equal(nextOnlineQuestionTime(40_000), 20_000);
  assert.deepEqual(ONLINE_QUESTION_TIME_CHOICES.map(onlineQuestionTimeLabel), ['20초', '40초']);

  for (const value of [20_000, 40_000]) assert.equal(isOnlineQuestionTime(value), true);
  // 로컬 설정의 «제한 없음»(null)과 모양만 비슷한 값은 받지 않는다
  for (const value of [null, undefined, 30_000, 0, '40000', true, 40_000.5]) {
    assert.equal(isOnlineQuestionTime(value), false, String(value));
    assert.equal(onlineQuestionTimeOrDefault(value), 20_000, String(value));
  }
  assert.equal(onlineQuestionTimeOrDefault(40_000), 40_000);
});

test('대기실 설정은 분야·인원·문항 시간 세 «도는» 버튼이고 select가 없다', async () => {
  const html = await source('index.html');
  const settings = between(html, '<div class="waiting-settings">', '<button type="button" class="button button--ghost waiting-ready"');
  const cards = [...settings.matchAll(/<button type="button" class="setting-card" id="([\w-]+)">\s*<span class="setting-card__label">([^<]+)<\/span>\s*<span class="setting-card__value" id="([\w-]+)"><\/span>\s*<\/button>/g)]
    .map(([, id, label, valueId]) => ({ id, label, valueId }));

  assert.deepEqual(cards, [
    { id: 'setting-category', label: '분야', valueId: 'setting-category-value' },
    { id: 'setting-capacity', label: '인원', valueId: 'setting-capacity-value' },
    { id: 'setting-question-time', label: '문항 시간', valueId: 'setting-question-time-value' },
  ]);
  // 캐릭터가 밟아도 목록이 열리지 않는다 (CLAUDE.md «여기에 select를 넣지 말 것»)
  assert.doesNotMatch(settings, /<select/);

  // 방장만 돌린다 — 판정은 저장소가 하고, 화면은 미리 잠가 알린다. 값은 모두에게 보인다
  const room = await source('src/ui/waiting-room.ts');
  assert.match(room, /for \(const button of \[el\.category, el\.capacity, el\.questionTime\]\) \{\s*button\.disabled = !room\.isMine \|\| room\.status === 'playing';/);
  assert.match(room, /el\.questionTimeValue\.textContent = onlineQuestionTimeLabel\(room\.questionTimeMs\);/);
  assert.match(room, /patch\(\{ questionTimeMs: nextOnlineQuestionTime\(room\.questionTimeMs\) \}\);/);
});

test('좁은 화면에서는 두 칸씩이고 문항 시간이 한 줄을 다 쓴다 — 480px부터 세 칸', async () => {
  const html = await source('index.html');
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const group = nodeFromHtml(html, 'setting-category').parent;
  const last = nodeFromHtml(html, 'setting-question-time');
  last.states.push('last-child', 'nth-child(odd)');
  const first = nodeFromHtml(html, 'setting-category');
  first.states.push('nth-child(odd)');

  for (const env of [NARROW, MOBILE]) {
    assert.equal(valueOf(rules, group, 'grid-template-columns', env), 'repeat(2, minmax(0, 1fr))', `${env.width}px`);
    // «예술과문화»·«전체 도전»이 ↻ 표식 자리를 뺀 세 칸에 들지 않는다
    assert.equal(valueOf(rules, last, 'grid-column', env), '1 / -1', `${env.width}px`);
    assert.equal(valueOf(rules, first, 'grid-column', env), null, '홀수 첫 칸은 펼치지 않는다');
  }
  const wide = { ...MOBILE, width: 480 };
  for (const env of [wide, DESKTOP]) {
    assert.equal(valueOf(rules, group, 'grid-template-columns', env), 'repeat(3, minmax(0, 1fr))', `${env.width}px`);
    assert.equal(valueOf(rules, last, 'grid-column', env), 'auto', `${env.width}px`);
  }
  // 세 번째 칸도 같은 버튼 모양·44px 이상이다
  assert.equal(valueOf(rules, last, 'min-height', NARROW), '56px');
});

test('방 만들기 폼은 «문항 시간»을 인원 다음에 고르게 하고, 저장소에 숫자 값으로 넘긴다', async () => {
  const [html, online] = await Promise.all([source('index.html'), source('src/ui/online.ts')]);
  const form = between(html, 'id="create-form"', '</form>');

  assert.match(form, /<label class="room-form__label" for="create-question-time">문항 시간<\/label>\s*<select class="room-form__input" id="create-question-time"><\/select>/);
  assert.ok(form.indexOf('create-capacity-help') < form.indexOf('create-question-time'), '인원 도움말 다음이다');
  assert.ok(form.indexOf('create-question-time') < form.indexOf('create-private'), '잠그기 앞이다');
  // 방장 혼자서도 연다 — «친구를 기다려요»로 끝내지 않는다
  assert.match(html, /분야와 인원, 문항 시간을 정해 방을 열어요\./);

  assert.match(online, /for \(const time of ONLINE_QUESTION_TIME_CHOICES\) \{\s*appendOption\(el\.createQuestionTime, String\(time\), onlineQuestionTimeLabel\(time\)\);/);
  assert.match(online, /questionTimeMs: onlineQuestionTimeOrDefault\(Number\(el\.createQuestionTime\.value\)\),/);
});

test('안내는 «온라인 20초 고정»이 아니라 방장이 방마다 20초나 40초를 고른다고 말한다', async () => {
  const [html, readme, claude, prd, design] = await Promise.all([
    source('index.html'),
    source('README.md'),
    source('CLAUDE.md'),
    source('docs/quiz-game-prd.md'),
    source('docs/design-system.md'),
  ]);
  const help = plain(between(html, 'id="online-help-dialog"', 'id="online-help-close"'));
  const settings = plain(between(html, 'id="settings-time-note"', '</p>'));

  assert.match(help, /문항 시간은 방장이 방마다 20초나 40초로 정해요\./);
  assert.match(settings, /온라인 매치는 방장이 방마다 20초나 40초로 정해요\./);
  for (const [name, text] of [['index.html', html], ['README.md', readme], ['CLAUDE.md', claude], ['design-system', design]]) {
    assert.doesNotMatch(text, /20초로? 고정/, name);
    assert.doesNotMatch(text, /서버의 20초/, name);
  }
  // PRD는 바뀐 이력을 남긴다. 현행 요구사항 줄(FR-3.7·확정 3번)만 본다
  const lines = prd.split('\n');
  const fr37 = lines.find((line) => line.startsWith('| FR-3.7 |'));
  const decided = lines.find((line) => line.startsWith('| 3 | 시간 제한 |'));
  assert.match(fr37, /온라인 매치는 방장이 방마다 20초\(기본\)나 40초를 고른다\(제한 없음은 없다\)/);
  assert.match(decided, /온라인 방은 방장이 20초·40초를 고른다/);
  for (const line of [fr37, decided]) assert.doesNotMatch(line, /고정/);
  assert.match(prd, /\*\*FR-3\.7 온라인 \(v1\.2, 소유자 결정\)\*\*/);
});
