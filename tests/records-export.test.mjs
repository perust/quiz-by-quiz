import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 랭킹 화면의 «기록 내보내기» (N02). 학생이 F12 콘솔에 스니펫을 붙여 넣던 길을 대신한다.
// - 파일 모양은 선생님 모드 로더(.claude/commands/quiz-teacher-*.md)와 맞물린다: 감싼 객체의 `records`,
//   `student` 없음(→ 파일 이름이 학생 이름). tests/fixtures/records-export.json 을 Python 쪽
//   (tests/test_guidance.py)도 읽어 실제 로더 스니펫으로 돌려 본다
// - 화면은 Blob + <a download> 로 내려받고, 「기록 복사」·클립보드 실패 때 글 펼치기로 내려간다
// - ui/ 는 저장소를 부르지 않는다. 기록은 app.ts 가 넘긴 콜백으로만 받는다

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

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
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
    this.offsetWidth = 40;
    this.offsetHeight = 48;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = globalThis.document.body; }
  select() { this.selected = true; }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
const screen = new FakeElement('section');
const header = new FakeElement('header');
const created = [];

globalThis.window = {
  innerWidth: 390, innerHeight: 844, scrollY: 0,
  addEventListener() {}, removeEventListener() {}, scrollBy() {}, scrollTo() {},
  setTimeout: () => 0,
};
globalThis.document = {
  body: new FakeElement('body'),
  activeElement: null,
  getElementById: (id) => (id.startsWith('walk-') ? null : byId(id)),
  querySelector: (selector) => {
    if (selector === '[data-screen="ranking"]') return screen;
    if (selector === '[data-screen="ranking"] .ranking-header') return header;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: (tag) => {
    const element = new FakeElement(tag);
    created.push(element);
    return element;
  },
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
console.warn = () => {};

// 내려받기·클립보드는 브라우저 기능이다. 무엇을 넘겼는지만 붙잡는다
const blobs = [];
URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
URL.revokeObjectURL = () => {};
let clipboard = { writeText: async (text) => { clipboard.text = text; } };
Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, get: () => clipboard });

const { buildRecordsExport, recordsExportFileName, RECORDS_EXPORT_VERSION } = await import('../js/core/records-export.js');
const { createRankingScreen } = await import('../js/ui/ranking.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 5; i += 1) await tick();
}

const later = {
  id: 'r-2', nickname: '김민준', mode: 'all', category: null, score: 210, correctCount: 21, totalCount: 25,
  durationMs: 301000, playedAt: '2026-10-26T09:40:00.000Z', timeLimitMs: 40000,
};
const earlier = {
  id: 'r-1', nickname: '김민준', mode: 'category', category: 'history', score: 80, correctCount: 8, totalCount: 10,
  durationMs: 96400, playedAt: '2026-10-25T09:30:00.000Z',
  questionResults: [{ id: 'history-001', correct: true, timedOut: false }, { id: 'history-002', correct: false, timedOut: true }],
};
const NOW = new Date('2026-10-27T01:02:03.000Z');

test('내보낸 파일은 선생님 모드 로더가 읽는 모양이고 student 칸을 두지 않는다 (N02)', async () => {
  const data = buildRecordsExport({ records: [later, earlier, later], nickname: '김민준', now: NOW });
  const fixture = JSON.parse(await source('tests/fixtures/records-export.json'));
  assert.deepEqual(data, fixture, 'Python 로더 회귀가 읽는 fixture 와 같은 모양이다');
  assert.equal(data.schemaVersion, RECORDS_EXPORT_VERSION);
  assert.equal('student' in data, false, '닉네임으로 채우면 기본 이름을 쓴 학생들이 한 사람으로 합쳐진다');
  assert.deepEqual(data.records.map(({ id }) => id), ['r-1', 'r-2'], '탭마다 읽어 겹친 기록은 하나로, 오래된 판부터');
  assert.deepEqual(data.records[0].questionResults, earlier.questionResults, '문항별 정오까지 싣는다');
  assert.match(data.scope, /랭킹 탭마다 상위 10개/, '탭마다 10개뿐이라는 것을 숨기지 않는다');
});

test('파일 이름은 닉네임과 그 기기의 날짜로, 파일 이름에 못 쓰는 글자는 바꾼다', () => {
  const local = new Date(2026, 9, 27, 23, 59);
  assert.equal(recordsExportFileName('김민준', local), 'quiz-by-quiz-기록-김민준-2026-10-27.json');
  assert.equal(recordsExportFileName('a/b:c d', local), 'quiz-by-quiz-기록-a_b_c_d-2026-10-27.json');
  assert.equal(recordsExportFileName('...', local), 'quiz-by-quiz-기록-나-2026-10-27.json');
});

let stored = {};
const keyOf = (target) => (target.mode === 'all' ? 'all' : target.category);
let exportCalls = 0;
const ranking = createRankingScreen({
  onHome: () => {},
  onStart: () => {},
  canStart: () => true,
  loadRankings: async (target) => stored[keyOf(target)] ?? [],
  clearRankings: async () => { stored = {}; },
  exportRecords: async () => {
    exportCalls += 1;
    return {
      fileName: recordsExportFileName('김민준', NOW),
      data: buildRecordsExport({ records: [earlier, later], nickname: '김민준', now: NOW }),
    };
  },
});

test('기록이 없으면 내보내기를 거두고, 있으면 파일로 내려받는다', async () => {
  stored = {};
  await ranking.show({ target: { mode: 'all', category: null } });
  assert.equal(byId('ranking-export').hidden, true, '빈 파일을 선생님께 보내게 하지 않는다');

  stored = { all: [later], history: [earlier] };
  await ranking.show({ target: { mode: 'all', category: null } });
  assert.equal(byId('ranking-export').hidden, false);

  byId('ranking-export-file').click();
  await settle();
  const link = created.find((element) => element.tagName === 'A');
  assert.ok(link, '<a download> 로 내려받는다');
  assert.equal(link.download, recordsExportFileName('김민준', NOW));
  assert.equal(link.href, 'blob:test/1');
  assert.equal(blobs[0].type, 'application/json');
  const saved = JSON.parse(await blobs[0].text());
  assert.equal(saved.records.length, 2);
  assert.match(byId('ranking-export-status').textContent, /^기록 2개를 «quiz-by-quiz-기록-김민준-2026-10-27\.json» 파일로 내보냈어요\./);
  assert.match(byId('ranking-export-status').textContent, /「기록 복사」/, '앱 안 브라우저처럼 파일이 안 생기면 갈 길을 말한다');
});

test('「기록 복사」는 클립보드로, 클립보드도 막혔으면 글을 펼쳐 모두 골라 둔다', async () => {
  stored = { all: [later] };
  await ranking.show({ target: { mode: 'all', category: null } });
  assert.equal(byId('ranking-export-status').textContent, '', '지난 방문의 안내는 남기지 않는다');

  byId('ranking-export-copy').click();
  await settle();
  assert.equal(JSON.parse(clipboard.text).records.length, 2);
  assert.equal(byId('ranking-export-text').hidden, true);
  assert.match(byId('ranking-export-status').textContent, /기록 2개를 복사했어요/);

  clipboard = { writeText: async () => { throw new Error('denied'); } };
  byId('ranking-export-copy').click();
  await settle();
  const text = byId('ranking-export-text');
  assert.equal(text.hidden, false);
  assert.equal(JSON.parse(text.value).schemaVersion, RECORDS_EXPORT_VERSION);
  assert.equal(globalThis.document.activeElement, text);
  assert.equal(text.selected, true);
  assert.match(byId('ranking-export-status').textContent, /복사하지 못했어요/);
});

test('내려받기를 시작할 수 없는 브라우저는 복사로 내려간다', async () => {
  clipboard = { writeText: async (value) => { clipboard.text = value; } };
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = undefined;
  try {
    await ranking.show({ target: { mode: 'all', category: null } });
    byId('ranking-export-file').click();
    await settle();
    assert.match(byId('ranking-export-status').textContent, /^파일로 내려받지 못해 대신 기록 2개를 복사했어요/);
  } finally {
    URL.createObjectURL = createObjectURL;
  }
});

test('ui/ranking.ts 는 저장소를 부르지 않고 app.ts 가 넘긴 콜백으로만 기록을 받는다 (저장소 경계)', async () => {
  const [ranking, app] = await Promise.all([source('src/ui/ranking.ts'), source('src/app.ts')]);
  assert.doesNotMatch(ranking, /from '\.\.\/storage\//);
  assert.doesNotMatch(ranking, /localStorage/);
  assert.match(app, /exportRecords: async \(\) => \{[\s\S]*?rankingStore\.getRankings\(target\)[\s\S]*?buildRecordsExport\(/);
  assert.ok(exportCalls >= 3);
});
