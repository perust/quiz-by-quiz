import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, loadStyles, node, resolveVars, tokens, valueOf } from './css-cascade.mjs';

// 설정 대화상자 (U42·U54·U55). 앱 바의 소리 토글 자리를 「설정」 하나로 바꾸고 소리·문항 시간·
// 움직임 줄이기를 인페이지 대화상자에 모았다. 잠그는 것:
//   · 앱 바의 같은 자리·같은 DOM 순서, 대화상자 계약(Tab 가두기·Esc·포커스 되돌리기)
//   · 토글 이름은 고정이고 상태는 aria-pressed 만 말한다 (U54 — «소리 꺼짐, 눌리지 않음» 이중 부정 금지)
//   · 열려 있는 동안 키가 뒤의 화면(로비 Esc·퀴즈 숫자키)으로 새지 않는다
//   · 움직임 줄이기는 prefers-reduced-motion 과 같은 규칙이다
//   · 상태는 색만이 아니라 글자·✓·높이로도 구분되고 글자 대비는 AA 다

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const html = await source('index.html');
const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

const dialogMarkup = between(html, '<div class="dialog-backdrop" id="settings-dialog"', '<script type="module"');

// ── 마크업 ─────────────────────────────────────────────────────────

test('앱 바: 소리 토글 자리에 「설정」 버튼 하나가 같은 DOM 순서로 선다', () => {
  assert.doesNotMatch(html, /id="sound-toggle"|id="sound-label"/, '예전 소리 토글은 대화상자 안으로 옮겼다');
  const appBar = between(html, '<div class="app-bar">', '</div>');
  assert.match(appBar, /<button type="button" class="icon-button" id="open-settings" aria-haspopup="dialog">/);
  assert.match(appBar, /data-icon="gear" aria-hidden="true"/);
  assert.match(appBar, /<span class="sr-only">설정<\/span>/, '아이콘만 보이지만 이름은 «설정»이다');
  assert.doesNotMatch(appBar, /aria-pressed/, '여는 버튼은 토글이 아니다');
  // main 뒤 · 피드백 앞 · 대화상자 앞 (z-index 없이 DOM 순서가 겹침 순서다)
  assert.ok(html.indexOf('</main>') < html.indexOf('<div class="app-bar"'));
  assert.ok(html.indexOf('<div class="app-bar"') < html.indexOf('id="feedback"'));
  assert.ok(html.indexOf('<div class="app-bar"') < html.indexOf('id="settings-dialog"'));
});

test('대화상자: 다른 대화상자와 같은 인페이지 구조이고 select 를 쓰지 않는다', () => {
  assert.ok(html.indexOf('id="feedback"') < html.indexOf('id="settings-dialog"'), '피드백 패널보다 위에 그려진다');
  assert.match(dialogMarkup, /^<div class="dialog-backdrop" id="settings-dialog" hidden>/);
  assert.match(dialogMarkup, /<div class="dialog settings" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="settings-dialog-title">/);
  assert.match(dialogMarkup, /<h2 class="dialog__title" id="settings-dialog-title">설정<\/h2>/);
  assert.match(dialogMarkup, /id="settings-close">닫기<\/button>/);
  assert.doesNotMatch(dialogMarkup, /<select|<input/, '캐릭터가 밟아도 열리지 않는 select 대신 누르는 버튼만 둔다');
});

test('소리·움직임 줄이기: 이름은 고정이고 켜짐/꺼짐은 aria-pressed 와 숨긴 글이 말한다 (U54)', () => {
  for (const [id, name] of [['setting-sound', '소리'], ['setting-motion', '움직임 줄이기']]) {
    const button = dialogMarkup.match(new RegExp(`<button type="button" class="settings-toggle" id="${id}"([^>]*)>([\\s\\S]*?)</button>`));
    assert.ok(button, `#${id} 가 있다`);
    assert.match(button[1], /aria-pressed="(?:true|false)"/);
    assert.doesNotMatch(button[1], /aria-label/, '눈에 보이는 이름이 곧 접근 가능한 이름이다');
    assert.match(button[2], new RegExp(`<span class="settings-toggle__name">${name}</span>`));
    assert.match(button[2], /<span class="settings-toggle__state" id="[\w-]+" aria-hidden="true">(?:켜짐|꺼짐)<\/span>/);
    // 이름에 섞이는 것은 이름 글자뿐이다 — 아이콘과 상태 글은 숨는다
    const spoken = button[2].replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').trim();
    assert.equal(spoken, name);
  }
  assert.match(dialogMarkup, /id="setting-motion" aria-pressed="false" aria-describedby="settings-motion-note"/);
  assert.match(dialogMarkup, /id="settings-motion-note">[^<]*기기의 움직임 줄이기 설정도 그대로 따라요/);
});

test('문항 시간: 세 칸 가운데 하나만 눌려 있고, 온라인은 20초로 고정이라고 말한다 (FR-3.7)', async () => {
  const group = dialogMarkup.match(/<div class="settings-choices" role="group" aria-labelledby="settings-time-title" aria-describedby="settings-time-note">([\s\S]*?)<\/div>/);
  assert.ok(group);
  const buttons = [...group[1].matchAll(/<button type="button" class="settings-choice" data-time-limit="([^"]+)" aria-pressed="(true|false)">([^<]+)<\/button>/g)]
    .map(([, value, pressed, label]) => ({ value, pressed, label }));
  assert.deepEqual(buttons, [
    { value: '20000', pressed: 'true', label: '20초' },
    { value: '40000', pressed: 'false', label: '40초' },
    { value: 'none', pressed: 'false', label: '제한 없음' },
  ]);
  assert.match(dialogMarkup, /<h3 class="settings__heading" id="settings-time-title">문항 시간<\/h3>/);
  assert.match(dialogMarkup, /id="settings-time-note">[^<]*온라인 매치는 20초로 고정돼요\.<\/p>/);
  assert.match(dialogMarkup, /새로 시작하는 판부터 적용돼요/);
});

// ── 동작 (가짜 DOM) ─────────────────────────────────────────────────

class FakeClassList {
  #names = new Set();
  add(...names) { names.forEach((name) => this.#names.add(name)); }
  remove(...names) { names.forEach((name) => this.#names.delete(name)); }
  toggle(name, force) {
    const on = force ?? !this.#names.has(name);
    if (on) this.#names.add(name);
    else this.#names.delete(name);
    return on;
  }
  contains(name) { return this.#names.has(name); }
}

class FakeElement extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.textContent = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.isConnected = true;
    this.scrollTop = 0;
    this.focusable = [];
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  // trapFocus 가 묻는 «안의 조작부». 대화상자만 답한다
  querySelectorAll() { return this.focusable; }
  querySelector() { return null; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id.startsWith('setting') || id.endsWith('settings') ? 'button' : 'div'));
  return elements.get(id);
};
const panel = new FakeElement();
const timeButtons = ['20000', '40000', 'none'].map((value) => {
  const button = new FakeElement('button');
  button.dataset.timeLimit = value;
  return button;
});

/** 문서에 단 keydown 리스너와 그 옵션. 캡처 단계인지 본다 */
const keyListeners = [];
const fakeDocument = new EventTarget();
const addListener = fakeDocument.addEventListener.bind(fakeDocument);
Object.assign(fakeDocument, {
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => (selector === '#settings-dialog [role="dialog"]' ? panel : null),
  querySelectorAll: (selector) => (selector === '#settings-dialog [data-time-limit]' ? timeButtons : []),
  createElement: (tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  contains: () => true,
  addEventListener(type, listener, options) {
    if (type === 'keydown') keyListeners.push({ listener, options });
    return addListener(type, listener, options);
  },
});
globalThis.document = fakeDocument;
globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { applyMotionPreference, createSettingsDialog, timeLimitFromAttr } = await import('../js/ui/settings-dialog.js');

const dialog = byId('settings-dialog');
dialog.hidden = true;
const opener = byId('open-settings');
const close = byId('settings-close');
const sound = byId('setting-sound');
const motion = byId('setting-motion');
dialog.focusable = [sound, ...timeButtons, motion, close];

const changes = [];
let closeAnswer = false;
let closeCalls = 0;
const settingsDialog = createSettingsDialog({
  onChange: (patch) => changes.push(patch),
  onClose: () => { closeCalls += 1; return closeAnswer; },
});
const dialogKeys = keyListeners.at(-1);

class FakeKey extends Event {
  constructor(key, { repeat = false, shiftKey = false } = {}) {
    super('keydown', { cancelable: true, bubbles: true });
    this.key = key;
    this.repeat = repeat;
    this.shiftKey = shiftKey;
    this.stopped = false;
  }
  stopPropagation() {
    this.stopped = true;
    super.stopPropagation();
  }
}

function press(key, options) {
  const event = new FakeKey(key, options);
  dialogKeys.listener(event);
  return event;
}

function reset(values = { soundEnabled: false, timeLimitMs: 20_000, reduceMotion: false }) {
  settingsDialog.dismiss();
  settingsDialog.set(values);
  changes.length = 0;
  closeAnswer = false;
  closeCalls = 0;
}

const pressedTimes = () => timeButtons.filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.dataset.timeLimit);

test('저장된 값을 얹을 때는 onChange 를 부르지 않고, 토글 이름은 그대로 둔다', () => {
  reset({ soundEnabled: false, timeLimitMs: null, reduceMotion: true });
  assert.deepEqual(changes, []);
  assert.equal(sound.getAttribute('aria-pressed'), 'false');
  assert.equal(byId('setting-sound-state').textContent, '꺼짐');
  assert.equal(byId('setting-sound-icon').dataset.icon, 'sound-off', '꺼진 소리는 아이콘 모양으로도 보인다');
  assert.equal(motion.getAttribute('aria-pressed'), 'true');
  assert.equal(byId('setting-motion-state').textContent, '켜짐');
  assert.deepEqual(pressedTimes(), ['none']);
  assert.equal(sound.getAttribute('aria-label'), null, '이름을 «소리 꺼짐»으로 바꾸지 않는다');
});

test('누르면 그 자리에서 바뀌고 한 값씩 알린다 — 같은 시간을 다시 누르면 아무 일도 없다', () => {
  reset();
  sound.click();
  assert.deepEqual(changes.at(-1), { soundEnabled: true });
  assert.equal(sound.getAttribute('aria-pressed'), 'true');
  assert.equal(byId('setting-sound-state').textContent, '켜짐');
  assert.equal(byId('setting-sound-icon').dataset.icon, 'sound-on');

  timeButtons[1].click();
  assert.deepEqual(changes.at(-1), { timeLimitMs: 40_000 });
  assert.deepEqual(pressedTimes(), ['40000'], '셋 가운데 하나만 눌려 있다');
  const before = changes.length;
  timeButtons[1].click();
  assert.equal(changes.length, before, '이미 고른 시간');
  timeButtons[2].click();
  assert.deepEqual(changes.at(-1), { timeLimitMs: null }, '«제한 없음»은 null 이다');
  assert.deepEqual(pressedTimes(), ['none']);

  motion.click();
  assert.deepEqual(changes.at(-1), { reduceMotion: true });
  assert.equal(motion.getAttribute('aria-pressed'), 'true');
});

test('열면 패널에 포커스를 두고, Esc 로 닫으면 연 버튼으로 돌아온다', () => {
  reset();
  opener.focus();
  opener.click();
  assert.equal(dialog.hidden, false);
  assert.equal(fakeDocument.activeElement, panel, '200% 확대에서도 제목부터 보이게 패널이 먼저 받는다');

  const escape = press('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(dialog.hidden, true);
  assert.equal(fakeDocument.activeElement, opener);
  assert.equal(closeCalls, 1);

  // 「닫기」도 같은 길이다
  opener.click();
  close.click();
  assert.equal(dialog.hidden, true);
  assert.equal(fakeDocument.activeElement, opener);
});

test('걸어가서 열었으면(포커스가 body) 닫을 때 「설정」 버튼으로 돌아온다', () => {
  reset();
  fakeDocument.activeElement = fakeDocument.body;
  opener.click();
  press('Escape');
  assert.equal(fakeDocument.activeElement, opener);
});

test('뒤에서 퀴즈 시간이 끝났으면 퀴즈가 포커스를 이어 받고, 화면을 옮길 때는 조용히 접는다', () => {
  reset();
  opener.focus();
  opener.click();
  closeAnswer = true;
  const next = new FakeElement('button');
  next.focus();
  close.click();
  assert.equal(fakeDocument.activeElement, next, 'onClose 가 참이면 연 자리로 되돌리지 않는다');

  reset();
  opener.click();
  const screen = new FakeElement('section');
  screen.focus();
  settingsDialog.dismiss();
  assert.equal(dialog.hidden, true);
  assert.equal(closeCalls, 0, 'goTo 가 접을 때는 onClose 를 부르지 않는다');
  assert.equal(fakeDocument.activeElement, screen, '포커스는 새 화면 것이다');
});

test('열려 있는 동안 키는 캡처 단계에서 멈춰 뒤의 화면으로 새지 않는다 (로비 Esc·퀴즈 숫자키)', () => {
  reset();
  assert.ok(dialogKeys.options === true || dialogKeys.options?.capture === true, '캡처 단계에서 받는다');

  const closed = press('1');
  assert.equal(closed.stopped, false, '닫혀 있으면 아무 키도 건드리지 않는다');

  opener.click();
  for (const key of ['1', 'Enter', ' ', 'ArrowDown', '/', 'Escape']) {
    if (dialog.hidden) opener.click();
    const event = press(key);
    assert.equal(event.stopped, true, `${key} 는 화면 쪽으로 넘기지 않는다`);
  }
  opener.click();
  // 버튼을 누르는 기본 동작은 그대로 둔다. 길게 누른 반복만 막는다 (FR-4.4)
  assert.equal(press('Enter').defaultPrevented, false);
  assert.equal(press(' ').defaultPrevented, false);
  assert.equal(press('Enter', { repeat: true }).defaultPrevented, true);
  assert.equal(press(' ', { repeat: true }).defaultPrevented, true);
  press('Escape');
});

test('Tab 은 대화상자 안에서 맴돈다', () => {
  reset();
  opener.click();
  // 패널에서 Tab → 첫 조작부, Shift+Tab → 마지막 조작부
  let event = press('Tab');
  assert.equal(event.defaultPrevented, true);
  assert.equal(fakeDocument.activeElement, sound);
  close.focus();
  event = press('Tab');
  assert.equal(event.defaultPrevented, true);
  assert.equal(fakeDocument.activeElement, sound, '마지막에서 Tab 은 처음으로');
  event = press('Tab', { shiftKey: true });
  assert.equal(fakeDocument.activeElement, close, '처음에서 Shift+Tab 은 마지막으로');
  timeButtons[1].focus();
  event = press('Tab');
  assert.equal(event.defaultPrevented, false, '가운데서는 브라우저가 옮긴다');
  press('Escape');
});

test('움직임 줄이기는 html[data-motion] 하나로 켜고 끈다', () => {
  applyMotionPreference(true);
  assert.equal(fakeDocument.documentElement.dataset.motion, 'reduce');
  applyMotionPreference(false);
  assert.equal('motion' in fakeDocument.documentElement.dataset, false);
  assert.equal(timeLimitFromAttr('20000'), 20_000);
  assert.equal(timeLimitFromAttr('40000'), 40_000);
  assert.equal(timeLimitFromAttr('none'), null);
  assert.equal(timeLimitFromAttr('30000'), undefined);
  assert.equal(timeLimitFromAttr(undefined), undefined);
});

test('워커는 대화상자가 열려 있으면 키를 받지 않는다 — 설정도 같은 표지(.dialog-backdrop)를 쓴다', async () => {
  const walker = await source('src/ui/walker.ts');
  assert.match(walker, /function isBlocked\(\): boolean \{[\s\S]*?document\.querySelector\('\.dialog-backdrop:not\(\[hidden\]\)'\)/);
  assert.match(dialogMarkup, /^<div class="dialog-backdrop"/);
  // 화면을 옮기면 접는다 — 새 화면 위에 남아 포커스를 가두지 않는다
  const app = await source('src/app.ts');
  // 홈의 「게임 방법」(U01)도 같은 자리에서 접는다
  assert.match(app, /function goTo\(name: ScreenName\): void \{[\s\S]*?settingsDialog\.dismiss\(\);\s*rulesDialog\.dismiss\(\);\s*showScreen\(name\);/);
  assert.match(app, /onClose: \(\) => quizScreen\.resumeAfterDialog\(\)/);
});

test('소리를 켜면 그 클릭 안에서 짧은 확인음을 낸다 (U54)', async () => {
  const [app, audio] = await Promise.all([source('src/app.ts'), source('src/audio.ts')]);
  assert.match(audio, /export function playToggleOn\(\): void \{\s*if \(!enabled\) return;/);
  assert.match(app, /setSoundEnabled\(patch\.soundEnabled\);[\s\S]*?if \(patch\.soundEnabled\) playToggleOn\(\);/);
});

// ── CSS ────────────────────────────────────────────────────────────

test('움직임 줄이기: 앱 설정 블록은 prefers-reduced-motion 블록과 같은 선언이다 (U55)', () => {
  const system = rules.find((rule) => rule.media.some((query) => query.includes('prefers-reduced-motion: reduce')) && rule.selectors.includes('*'));
  const inApp = rules.find((rule) => rule.selectors.includes("html[data-motion='reduce'] *"));
  assert.ok(system && inApp);
  assert.deepEqual(inApp.declarations, system.declarations);
  assert.deepEqual(inApp.selectors, [
    "html[data-motion='reduce']",
    "html[data-motion='reduce'] *",
    "html[data-motion='reduce'] *::before",
    "html[data-motion='reduce'] *::after",
  ]);
  assert.equal(inApp.media.length, 0, '기기 설정과 상관없이 건다');
});

const root = tokens(rules, DESKTOP);

function hex(value) {
  const resolved = resolveVars(value, root);
  assert.match(resolved ?? '', /^#[0-9a-f]{6}$/i, `${value} 는 6자리 색으로 풀려야 한다: ${resolved}`);
  return resolved;
}

function contrast(foreground, background) {
  const luminance = (value) => {
    const channels = value.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
    const linear = channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [lighter, darker] = [luminance(hex(foreground)), luminance(hex(background))].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const panelNode = node('div.dialog.settings', node('div.dialog-backdrop#settings-dialog', node('body')));
const section = node('div.settings__section', panelNode);
const toggle = (pressed) => node(`button.settings-toggle#setting-sound[aria-pressed='${pressed}']`, section);
const choices = node('div.settings-choices', section);
const choice = (pressed, state = '') => node(`button.settings-choice[aria-pressed='${pressed}']${state}`, choices);

test('대비: 설정의 글자는 제 바탕에서 AA(4.5:1)이고 아이콘은 3:1 을 넘는다', () => {
  for (const env of [DESKTOP, MOBILE]) {
    const surface = valueOf(rules, panelNode, 'background', env);
    assert.equal(surface, 'var(--surface)');
    const pairs = [];
    for (const pressed of ['true', 'false']) {
      const button = toggle(pressed);
      pairs.push([`토글 ${pressed}`, valueOf(rules, button, 'color', env), valueOf(rules, button, 'background', env)]);
      const state = node('span.settings-toggle__state', button);
      pairs.push([`상태 칸 ${pressed}`, valueOf(rules, state, 'color', env), valueOf(rules, state, 'background', env)]);
      // 고르지 않은 칸은 바탕이 비어 묶음의 트랙 색이 비친다
      const cell = choice(pressed);
      const cellBackground = valueOf(rules, cell, 'background', env);
      pairs.push([`시간 칸 ${pressed}`, valueOf(rules, cell, 'color', env),
        cellBackground === 'transparent' ? valueOf(rules, choices, 'background', env) : cellBackground]);
    }
    pairs.push(['소제목', valueOf(rules, node('h3.settings__heading', section), 'color', env), surface]);
    pairs.push(['도움말', valueOf(rules, node('p.settings__note', section), 'color', env), surface]);
    for (const [label, foreground, background] of pairs) {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= 4.5, `${env.width}px ${label}: ${foreground} on ${background} = ${ratio.toFixed(2)}`);
    }
    const icon = valueOf(rules, node('span.settings-toggle__icon.icon', toggle('true')), 'color', env);
    assert.ok(contrast(icon, surface) >= 3, `소리 아이콘 ${icon}`);
  }
});

test('상태: 켜짐·고른 칸은 색만이 아니라 ✓·들린 높이로도 구분되고, hover 는 고른 것처럼 채우지 않는다', () => {
  for (const env of [DESKTOP, MOBILE]) {
    const onMark = node('span.settings-toggle__state::before', toggle('true'));
    const offMark = node('span.settings-toggle__state::before', toggle('false'));
    assert.equal(valueOf(rules, onMark, 'content', env), "''");
    assert.match(valueOf(rules, onMark, 'mask', env) ?? '', /var\(--i-check\)/);
    assert.equal(valueOf(rules, offMark, 'content', env), null, '꺼짐에는 ✓ 가 없다');

    const pickedMark = node('button.settings-choice::before', choices);
    pickedMark.attrs['aria-pressed'] = 'true';
    assert.match(valueOf(rules, pickedMark, 'mask', env) ?? '', /var\(--i-check\)/);
    const restMark = node('button.settings-choice::before', choices);
    restMark.attrs['aria-pressed'] = 'false';
    assert.equal(valueOf(rules, restMark, 'content', env), null);
    assert.equal(valueOf(rules, choice('true'), 'box-shadow', env), 'var(--elevation-1)', '고른 칸은 흰 표면으로 들린다');
    assert.notEqual(valueOf(rules, choice('false'), 'box-shadow', env), 'var(--elevation-1)');
  }
  const hovered = valueOf(rules, choice('false', ':hover'), 'background', DESKTOP);
  assert.equal(hovered, valueOf(rules, choice('false'), 'background', DESKTOP), 'hover 는 바탕을 채우지 않는다');
  assert.equal(valueOf(rules, toggle('false'), 'background', DESKTOP), valueOf(rules, node("button.settings-toggle[aria-pressed='false']:hover", section), 'background', DESKTOP));
});

test('배치: 문항 시간 세 칸은 320px 대화상자에서도 넘치지 않게 한 줄을 나눠 쓰고 44px 이상이다', () => {
  for (const env of [DESKTOP, MOBILE, { ...MOBILE, width: 320, height: 640 }]) {
    assert.equal(valueOf(rules, choices, 'grid-template-columns', env), 'repeat(3, minmax(0, 1fr))');
    assert.equal(valueOf(rules, choice('false'), 'min-width', env), '0');
    assert.equal(valueOf(rules, choice('false'), 'word-break', env), 'keep-all', '«제한 없음»은 낱말 단위로만 접힌다');
    for (const element of [choice('false'), toggle('false')]) {
      assert.equal(valueOf(rules, element, 'min-height', env), '44px');
    }
    assert.equal(valueOf(rules, toggle('false'), 'width', env), '100%');
  }
});
