import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DESKTOP, MOBILE, NARROW, lengthOf, loadStyles, node, nodeFromHtml, shorthandParts, valueOf,
} from './css-cascade.mjs';

// 휴대폰의 채팅 (U39). 대기실은 방(58svh, 390×844에서 약 490px)이 채팅을 한참 아래로 밀었고, 두 화면 모두 채팅칸
// 아래에 최근 대화가 있어 칸을 누르면 OS 키보드가 마지막 말을 덮었다. 키보드 단축키 안내(/ · Esc)는 키보드가 없는
// 손가락 기기에도 보였다. 이제 최근 대화 → (키보드 안내) → 채팅칸 순서이고, 안내는 손가락만 쓰는 기기에서 접히며,
// 좁은 화면의 방은 기본 높이까지만 늘어난다. 고정 조작부와 겹치지 않게 비우는 자리(화면 아래 여백·채팅 아래 여백)는
// 그대로이고 z-index·position 으로 올리지 않는다. 실측은 브라우저에서 하고 여기서는 캐스케이드를 잠근다.

const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = (await Promise.all(['css/style.css', 'css/voxel-theme.css']
  .map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))).join('\n');

const px = (value, env) => lengthOf(rules, value, env);
/** 단축 속성(padding·margin)이 이겼으면 아래쪽 값만 */
function bottomOf(value) {
  const parts = shorthandParts(value);
  return parts.length === 1 ? parts[0] : parts[2] ?? parts[0];
}
/** 터치 노트북·태블릿+트랙패드처럼 굵은 포인터에 hover 가 있는 기기, hover 없는 펜 기기 */
const TOUCH_WITH_HOVER = { width: 1024, height: 768, pointer: 'coarse', hover: 'hover', reducedMotion: false };
const PEN = { width: 1024, height: 768, pointer: 'fine', hover: 'none', reducedMotion: false };
const TOUCH_ONLY = [MOBILE, NARROW];
const KEYBOARD_LIKELY = [DESKTOP, TOUCH_WITH_HOVER, PEN];

const waitingLog = nodeFromHtml(html, 'chat-log');
const waitingSection = waitingLog.parent;
const waitingHint = node('p.chat__hint', waitingSection);
const waitingForm = nodeFromHtml(html, 'chat-form');
const onlineLog = nodeFromHtml(html, 'online-chat-log');
const onlineChat = onlineLog.parent;
const onlineHint = node('p.chat__hint', onlineChat);
const onlineForm = nodeFromHtml(html, 'online-chat-form');

/** 한 화면의 마크업 조각 */
function screenMarkup(name, next) {
  const start = html.indexOf(`data-screen="${name}"`);
  return html.slice(start, html.indexOf(`data-screen="${next}"`, start));
}

test('키보드 안내(/ · Esc)는 손가락만 쓰는 기기에서 접히고, 키보드가 있을 법한 기기에서는 그대로 보인다', () => {
  for (const [label, hint] of [['대기실', waitingHint], ['온라인 퀴즈', onlineHint]]) {
    for (const env of TOUCH_ONLY) {
      assert.equal(valueOf(rules, hint, 'display', env), 'none', `${label} ${env.width}×${env.height}: 누를 수 없는 단축키다`);
    }
    for (const env of KEYBOARD_LIKELY) {
      assert.notEqual(valueOf(rules, hint, 'display', env), 'none', `${label} ${env.pointer}/${env.hover}: 키보드 안내는 남는다`);
    }
  }
  // 걷기 조작부를 보이는 기준과 따로 놀지 않는다 — 손가락만 쓰는 기기에서만 접는다(굵은 포인터 + hover 없음)
  assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.chat__hint \{\s*display: none;/);
});

test('낭독기는 짧은 표식 대신 문장을 읽는다 — 온라인 퀴즈의 «/ 채팅 · Esc 다시 걷기»는 눈에만 보인다', () => {
  const quiz = screenMarkup('online-quiz', 'online-result');
  const hint = quiz.match(/<p class="chat__hint">([\s\S]*?)<\/p>/)?.[1] ?? '';
  assert.match(hint, /<span aria-hidden="true"><kbd>\/<\/kbd> 채팅 · <kbd>Esc<\/kbd> 다시 걷기<\/span>/);
  const spoken = hint.match(/<span class="sr-only">([^<]*)<\/span>/)?.[1] ?? '';
  assert.match(spoken, /\/ 키를 누르면 채팅칸으로/);
  assert.match(spoken, /Esc 키를 누르면 다시 걷기로 가요\.$/);
  // 대기실 안내는 이미 문장이라 그대로 읽는다
  const waiting = screenMarkup('waiting', 'result');
  assert.match(waiting, /<p class="chat__hint">걷는 중에 <kbd>\/<\/kbd> 를 누르면 채팅칸으로, 채팅칸에서 <kbd>Esc<\/kbd> 를 누르면 다시 걷기로 가요\.<\/p>/);
});

test('최근 대화 → (키보드 안내) → 채팅칸 순서다 — 가장 새 줄이 칸 바로 위에 오고 채팅칸이 화면의 마지막 조각이다', () => {
  const waiting = screenMarkup('waiting', 'result');
  const quiz = screenMarkup('online-quiz', 'online-result');
  for (const [label, markup, ids] of [
    ['대기실', waiting, ['id="chat-log"', 'class="chat__hint"', 'id="chat-form"']],
    ['온라인 퀴즈', quiz, ['id="online-chat-log"', 'class="chat__hint"', 'id="online-chat-form"']],
  ]) {
    const at = ids.map((needle) => markup.indexOf(needle));
    assert.ok(at.every((index) => index !== -1), `${label}: ${ids.join(' · ')}`);
    assert.ok(at[0] < at[1] && at[1] < at[2], `${label}: 로그 → 안내 → 채팅칸`);
  }
  // 채팅칸 뒤에는 화면을 닫는 태그뿐이다 — 조작부 위로 올려 주는 아래 여백이 곧 채팅칸의 자리다
  assert.match(waiting.slice(waiting.indexOf('id="chat-form"')), /^[^]*?<\/form>\s*<\/section>/);
  assert.match(quiz.slice(quiz.indexOf('id="online-chat-form"')), /^[^]*?<\/form>\s*<\/section>\s*<\/section>/);
});

test('대기실 채팅: 로그·안내·채팅칸이 한 표면으로 이어지고, 안내가 접혀도 로그와 채팅칸이 맞물린다', () => {
  const empty = { ...waitingLog, states: ['empty'] };
  for (const env of [...TOUCH_ONLY, DESKTOP]) {
    const at = `${env.width}×${env.height}`;
    // 세계 방과 표면 사이의 틈은 맨 위의 로그가 진다
    assert.equal(px(valueOf(rules, waitingLog, 'margin-top', env), env), 12, at);
    const logPadding = shorthandParts(valueOf(rules, waitingLog, 'padding', env)).map((part) => px(part, env));
    assert.deepEqual(logPadding, [12, 12, 0], `${at}: 로그는 표면의 위 안쪽 여백을 진다`);
    assert.equal(px(bottomOf(valueOf(rules, waitingLog, 'padding-bottom', env)), env), 8, `${at}: 대화가 있으면 그 아래 8px`);
    assert.equal(px(bottomOf(valueOf(rules, empty, 'padding-bottom', env)), env), 0, `${at}: 빈 로그는 아래 틈을 두지 않는다`);
    assert.equal(px(valueOf(rules, waitingForm, 'margin-top', env), env), 0, at);
    const formPadding = shorthandParts(valueOf(rules, waitingForm, 'padding', env)).map((part) => px(part, env));
    assert.deepEqual(formPadding, [0, 12, 12], `${at}: 채팅칸이 표면의 아래 안쪽 여백을 진다`);
    // 표면은 위치를 갖지 않는다 — 앞에 오는 fixed 캐릭터와 말풍선을 덮지 않는다(z-index 없음)
    for (const element of [waitingLog, waitingHint, waitingForm]) {
      assert.equal(valueOf(rules, element, 'position', env), null, at);
      assert.equal(valueOf(rules, element, 'z-index', env), null, at);
    }
  }
  assert.equal(valueOf(rules, waitingForm, 'border-top', MOBILE), '0');
  assert.equal(valueOf(rules, waitingLog, 'border-bottom', MOBILE), '0');
  assert.equal(valueOf(rules, waitingForm, 'border-radius', MOBILE), '0 0 var(--radius-lg) var(--radius-lg)', '안내가 접혀도 채팅칸이 아래 모서리를 진다');
});

test('온라인 퀴즈 채팅: 로그가 표면 첫 줄이고 줄 사이는 8px, 빈 로그는 채팅칸 위를 비우지 않으며 새 줄이 칸 안에서 잘리지 않는다', () => {
  const empty = { ...onlineLog, states: ['empty'] };
  for (const env of [...TOUCH_ONLY, DESKTOP]) {
    const at = `${env.width}×${env.height}`;
    assert.equal(px(valueOf(rules, onlineLog, 'margin-top', env), env), 0, at);
    assert.equal(px(valueOf(rules, onlineLog, 'margin-bottom', env), env), 8, `${at}: 대화가 있으면 그 아래 8px`);
    assert.equal(px(valueOf(rules, empty, 'margin-bottom', env), env), 0, `${at}: 판이 막 열려 대화가 없으면 틈이 없다`);
    assert.equal(px(valueOf(rules, onlineHint, 'margin-top', env), env), 0, at);
    assert.equal(px(valueOf(rules, onlineHint, 'margin-bottom', env), env), 8, at);
    assert.equal(px(valueOf(rules, onlineForm, 'margin-top', env), env), 0, at);
    // 높이는 묶여 있고(가장 새 줄은 online-quiz.ts 가 끝에 맞춘다) 표면은 위치를 갖지 않는다
    assert.equal(valueOf(rules, onlineLog, 'max-height', env), '80px', at);
    assert.equal(valueOf(rules, onlineLog, 'overflow-y', env), 'auto', at);
    assert.equal(valueOf(rules, onlineChat, 'position', env), null, at);
    assert.equal(valueOf(rules, onlineChat, 'z-index', env), null, at);
  }
});

test('고정 조작부 자리는 그대로 비운다: 채팅칸(마지막 조각)을 스틱·선택 버튼 위까지 올릴 수 있다', () => {
  // 대기실은 화면 아래 여백, 온라인 퀴즈는 채팅 표면 아래 여백이 공용 스틱 크기 + 여백이다 (touch-clearance 와 같은 셈)
  const has = ["[data-screen='waiting']:not([hidden])", '.walk-controls--on', ".walk-controls--on[data-placement='viewport']"];
  const body = node('body', null, { has });
  const waiting = node("section.screen[data-screen='waiting']", node('main.app', body));
  const controls = node("div.walk-controls.walk-controls--on[data-placement='viewport']#walk-controls", node('main.app', body));
  const stick = node('div.walk-stick#walk-stick', controls);
  const onlineQuiz = node("section.screen[data-screen='online-quiz']", node('main.app', node('body')));
  const chat = node('section.online-quiz-chat', onlineQuiz);
  for (const env of TOUCH_ONLY) {
    const reserve = px(valueOf(rules, stick, 'height', env), env) + px(valueOf(rules, controls, '--walk-controls-bottom', env), env);
    assert.ok(px(valueOf(rules, waiting, 'padding-bottom', env), env) >= reserve, `${env.width}×${env.height} 대기실`);
    assert.ok(px(valueOf(rules, chat, 'margin-bottom', env), env) >= reserve, `${env.width}×${env.height} 온라인 퀴즈`);
  }
  // 채팅 규칙은 z-index 로 조작부 위에 올리지 않는다 — DOM 순서가 곧 겹침 순서다
  const chatRules = rules.filter((rule) => rule.selectors.some((selector) => /chat/.test(selector) && !/walker/.test(selector)));
  assert.ok(chatRules.length > 0);
  for (const rule of chatRules) {
    assert.ok(!rule.declarations.some(({ property }) => property === 'z-index'), rule.selectors.join(', '));
  }
});

test('좁은 휴대폰 세로 화면의 대기실 방은 기본 높이(360px)까지만 늘어 채팅을 한참 아래로 밀지 않는다', () => {
  const lounge = nodeFromHtml(html, 'lounge');
  for (const env of [MOBILE, NARROW, { ...MOBILE, width: 430, height: 932 }]) {
    assert.equal(valueOf(rules, lounge, 'min-height', env), 'min(58svh, 360px)', `${env.width}×${env.height}`);
  }
  // 넓은 화면은 예전처럼 화면 높이의 58%를 방이 쓴다
  for (const env of [DESKTOP, { ...MOBILE, width: 768, height: 1024 }]) {
    assert.equal(valueOf(rules, lounge, 'min-height', env), '58svh', `${env.width}×${env.height}`);
  }
});
