import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP, MOBILE, NARROW, lengthOf, loadStyles, node, valueOf } from './css-cascade.mjs';

// «이 문제 이상해요» 신고 링크 (FR-5.8, 소유자 결정).
// 풀이의 문제마다 GitHub 새 이슈 화면을 새 창으로 연다. 주소에는 문제만 싣고 개인 정보는 싣지 않는다.
// 온라인 문제는 비공개 은행이라 번호와 분야만 싣는다 — 질문·보기·정답이 공개 이슈로 새면 안 된다.
// 로컬 결과 화면의 렌더링은 tests/result-auto-save.test.mjs 가 같은 가짜 DOM 위에서 본다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── 가짜 DOM (온라인 결과 화면) ───────────────────────────────────────
// 화면 모듈은 불러올 때 DOM 을 건드리지 않고, 만들 때 요소를 집는다. 필요한 만큼만 흉내 낸다.

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
    this.className = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.children = [];
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector() { return null; }
}

const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement());
  return elements.get(id);
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  getElementById: byId,
  createElement: (tag) => new FakeElement(tag),
  addEventListener() {},
};

const {
  ONLINE_REPORT_NOTICE,
  QUESTION_REPORT_TEXT,
  QUESTION_REPORT_TRIMMED,
  createQuestionReportLink,
  localQuestionReportUrl,
  onlineQuestionReportUrl,
  questionReportLabel,
  questionReportSubject,
} = await import('../js/ui/report-link.js');
const { QUESTION_REPORT_URL_MAX_LENGTH, REPOSITORY_URL } = await import('../js/constants.js');
const { createOnlineResultScreen, onlineReviewRows } = await import('../js/ui/online-result.js');

const ISSUE_PAGE = 'https://github.com/perust/quiz-by-quiz/issues/new';

/** 주소를 칸별로 풀어 본다. URLSearchParams 가 만든 주소는 같은 규칙으로 되읽혀야 한다 */
function parse(href) {
  const url = new URL(href);
  return {
    url,
    page: `${url.origin}${url.pathname}`,
    keys: [...url.searchParams.keys()],
    template: url.searchParams.get('template'),
    title: url.searchParams.get('title'),
    body: url.searchParams.get('body'),
    /** 주소 전체를 사람이 읽는 글로 — 무엇이 실렸는지 찾는 데 쓴다 */
    text: [...url.searchParams.values()].join('\n'),
  };
}

const LOCAL = {
  id: 'history-012',
  category: 'history',
  question: '조선을 세운 왕은?',
  choices: ['왕건', '이성계', '이방원', '정도전'],
  answer: '이성계',
};

// ── 로컬(공개 은행) ──────────────────────────────────────────────────

test('로컬 신고 주소: 저장소의 새 이슈 화면 + 템플릿 + 번호 제목, 본문은 번호·분야·질문·보기·저장된 정답·빈 칸이다', () => {
  assert.equal(REPOSITORY_URL, 'https://github.com/perust/quiz-by-quiz');
  const report = parse(localQuestionReportUrl(LOCAL));
  assert.equal(report.page, ISSUE_PAGE);
  assert.deepEqual(report.keys, ['template', 'title', 'body'], '세 칸뿐이다');
  assert.equal(report.template, 'question-report.md');
  assert.equal(report.title, '[문제 신고] history-012', '제목은 번호 하나다');

  const lines = report.body.split('\n');
  for (const line of [
    '## 어떤 문제인가요?',
    '- 문제 번호: history-012',
    '- 분야: 한국사 (history)',
    '- 문제 은행: 공개 (data/history.json)',
    '### 질문',
    '조선을 세운 왕은?',
    '### 보기 (화면에 나온 순서)',
    '- 왕건', '- 이성계', '- 이방원', '- 정도전',
    '### 저장된 정답',
    '이성계',
    '## 무엇이 이상한가요?',
  ]) {
    assert.ok(lines.includes(line), `본문에 «${line}» 줄이 있다`);
  }
  // 순서: 번호 → 질문 → 보기 → 정답 → 빈 칸(맨 끝)
  const at = (line) => lines.indexOf(line);
  assert.ok(at('- 문제 번호: history-012') < at('### 질문'));
  assert.ok(at('### 질문') < at('### 보기 (화면에 나온 순서)'));
  assert.ok(at('### 보기 (화면에 나온 순서)') < at('### 저장된 정답'));
  assert.ok(at('### 저장된 정답') < at('## 무엇이 이상한가요?'));
  const after = lines.slice(at('## 무엇이 이상한가요?') + 1).filter((line) => line.trim() && !line.startsWith('<!--'));
  assert.deepEqual(after, [], '«무엇이 이상한가요?» 아래는 신고하는 사람이 채울 빈 칸이다(안내 주석만)');
  assert.ok(!report.body.includes(QUESTION_REPORT_TRIMMED), '짧으면 자르지 않는다');
});

test('인코딩: 질문 속 & # = + % 줄바꿈·이모지가 칸을 가르지 않고 그대로 되읽힌다', () => {
  const tricky = {
    ...LOCAL,
    question: 'A&title=가짜 #1 + 50% = ?\n둘째 줄 🧪 "따옴표" <b>',
    choices: ['a&b', 'c#d', 'e+f', '100%'],
    answer: 'e+f',
  };
  const href = localQuestionReportUrl(tricky);
  assert.doesNotMatch(href, /[\s#"<>]/, '공백·#·따옴표·꺾쇠가 날것으로 남지 않는다');
  const report = parse(href);
  assert.equal(report.url.hash, '', '#이 주소의 조각으로 잘리지 않는다');
  assert.deepEqual(report.keys, ['template', 'title', 'body'], '질문 속 &·= 가 새 칸을 만들지 않는다');
  assert.equal(report.title, '[문제 신고] history-012');
  assert.ok(report.body.includes('A&title=가짜 #1 + 50% = ?\n둘째 줄 🧪 "따옴표" <b>'), '질문이 글자 그대로 돌아온다');
  for (const choice of tricky.choices) assert.ok(report.body.split('\n').includes(`- ${choice}`), choice);
  // 손으로 이어 붙인 주소가 아니라 URLSearchParams 의 규칙이다(공백은 +, + 는 %2B)
  assert.match(href, /title=%5B%EB%AC%B8%EC%A0%9C\+%EC%8B%A0%EA%B3%A0%5D\+history-012/);
  assert.match(href, /%2B/);
});

test('길이 한도: 아주 긴 질문·보기도 주소가 한도 안이고, 번호와 빈 칸은 남기며 잘린 자리를 말한다', () => {
  assert.equal(QUESTION_REPORT_URL_MAX_LENGTH, 6000);
  const long = { ...LOCAL, question: '가'.repeat(3000), choices: ['나'.repeat(400), '다'.repeat(400), '라'.repeat(400), '마'.repeat(400)], answer: '나'.repeat(400) };
  const href = localQuestionReportUrl(long);
  assert.ok(href.length <= QUESTION_REPORT_URL_MAX_LENGTH, `${href.length}자`);
  // 남길 수 있는 만큼은 남긴다 — 한글 한 자(아홉 자) 더 넣으면 넘는 데까지
  assert.ok(href.length > QUESTION_REPORT_URL_MAX_LENGTH - 12, `너무 많이 잘랐다: ${href.length}자`);
  const report = parse(href);
  assert.deepEqual(report.keys, ['template', 'title', 'body']);
  assert.equal(report.title, '[문제 신고] history-012');
  assert.ok(report.body.includes('- 문제 번호: history-012'), '번호는 언제나 남는다');
  assert.ok(report.body.includes(QUESTION_REPORT_TRIMMED), '잘랐다고 말한다');
  assert.ok(report.body.trimEnd().split('\n').includes('## 무엇이 이상한가요?'), '빈 칸은 언제나 남는다');
  assert.ok(report.body.indexOf(QUESTION_REPORT_TRIMMED) < report.body.indexOf('## 무엇이 이상한가요?'));

  // 이모지(서로게이트 쌍)를 반으로 가르지 않는다 — 갈리면 주소가 깨진다
  const emoji = parse(localQuestionReportUrl({ ...LOCAL, question: '🧪'.repeat(2000) }));
  assert.ok(emoji.url.href.length <= QUESTION_REPORT_URL_MAX_LENGTH);
  assert.equal(emoji.body.isWellFormed(), true);
  assert.ok(emoji.body.includes(QUESTION_REPORT_TRIMMED));

  // 서버가 정하는 온라인 번호가 아무리 길어도 주소는 한도 안이다
  const longId = 'online-' + 'x'.repeat(5000);
  for (const href of [onlineQuestionReportUrl({ id: longId, category: 'art' }), localQuestionReportUrl({ ...LOCAL, id: longId })]) {
    assert.ok(href.length <= QUESTION_REPORT_URL_MAX_LENGTH, `${href.length}자`);
    assert.ok(parse(href).body.includes('## 무엇이 이상한가요?'));
  }
});

test('개인 정보를 싣지 않는다: 닉네임·플레이어 ID·점수·방 코드·내 답을 함께 넘겨도 주소에 없다', () => {
  // 화면이 실수로 더 많은 것을 넘겨도 함수는 문제의 칸만 읽는다
  const leaky = {
    ...LOCAL,
    nickname: '비밀닉네임', playerId: '12345678-1234-5678-9234-567812345678', score: 7340,
    roomCode: 'QWERTY', chosenChoice: '왕건', timedOut: true,
  };
  for (const href of [
    localQuestionReportUrl(leaky),
    onlineQuestionReportUrl({ ...leaky, id: 'online-history-001' }),
  ]) {
    const { text } = parse(href);
    for (const secret of ['비밀닉네임', '12345678-1234-5678-9234-567812345678', '7340', 'QWERTY', '내 답', '시간 초과']) {
      assert.ok(!text.includes(secret), `«${secret}» 가 주소에 실렸다`);
    }
    assert.ok(!href.includes('QWERTY') && !href.includes('7340'));
  }
});

// ── 온라인(비공개 은행) ──────────────────────────────────────────────

const ONLINE_ITEM = {
  position: 2, id: 'online-history-007', categoryId: 'history',
  question: '훈민정음을 반포한 해는?', choices: ['1443년', '1446년', '1450년', '1418년'], answerIndex: 1,
  explanation: '세종 28년에 반포했다.', choiceIndex: 0, correct: false, timedOut: false,
};
const ONLINE_SECRETS = [ONLINE_ITEM.question, ...ONLINE_ITEM.choices, ONLINE_ITEM.explanation, '훈민정음', '반포'];

test('온라인 신고 주소: 번호와 분야만 싣고 «문제 번호만 보내요»라고 말한다 — 질문·보기·정답·해설은 없다', () => {
  // 함수가 받는 모양에는 질문 자리가 없다. 서버 풀이 한 줄을 통째로 넘겨도 번호와 분야만 쓴다
  const report = parse(onlineQuestionReportUrl({ ...ONLINE_ITEM, category: ONLINE_ITEM.categoryId }));
  assert.equal(report.page, ISSUE_PAGE);
  assert.deepEqual(report.keys, ['template', 'title', 'body']);
  assert.equal(report.template, 'question-report.md');
  assert.equal(report.title, '[문제 신고] online-history-007');
  const lines = report.body.split('\n');
  for (const line of ['- 문제 번호: online-history-007', '- 분야: 한국사 (history)', '- 문제 은행: 온라인 (비공개)', '## 무엇이 이상한가요?']) {
    assert.ok(lines.includes(line), line);
  }
  assert.ok(report.body.includes(ONLINE_REPORT_NOTICE));
  assert.match(ONLINE_REPORT_NOTICE, /^문제 번호만 보내요\./);
  for (const heading of ['### 질문', '### 보기 (화면에 나온 순서)', '### 저장된 정답']) {
    assert.ok(!lines.includes(heading), `온라인 신고에 «${heading}» 칸이 없다`);
  }
  for (const secret of ONLINE_SECRETS) assert.ok(!report.text.includes(secret), `«${secret}» 가 공개 이슈로 샌다`);
  // 공개 이슈라 옮겨 적지 말라고도 적는다
  assert.match(report.body, /옮겨 적지 말고/);
});

test('온라인 «문제 다시 보기» 줄: 줄마다 신고 주소가 있고 거기에는 그 줄의 질문·보기·정답·해설이 없다', () => {
  const items = [
    ONLINE_ITEM,
    { ...ONLINE_ITEM, position: 3, id: 'online-art-031', categoryId: 'art', choiceIndex: 1, correct: true },
  ];
  const rows = onlineReviewRows(items);
  assert.equal(rows.length, 2);
  for (const [index, row] of rows.entries()) {
    const report = parse(row.reportUrl);
    assert.equal(report.title, `[문제 신고] ${items[index].id}`, '맞힌 문제도 신고할 수 있다');
    for (const secret of [row.question, row.answer, row.explanation, ...items[index].choices]) {
      assert.ok(!report.text.includes(secret), `«${secret}» 가 공개 이슈로 샌다`);
    }
  }
  assert.ok(parse(rows[1].reportUrl).body.includes('- 분야: 예술과문화 (art)'));
});

test('온라인 결과 화면: 풀이마다 새 창 신고 링크를 달고, 이름이 문항 번호와 «GitHub에서 새 창»을 말한다', () => {
  const screen = createOnlineResultScreen({
    onAgain: async () => {}, onRoom() {}, onHome() {}, getPlayerId: () => 'me',
  });
  screen.show({
    matchId: '32345678-1234-5678-9234-567812345678', state: 'finished', categoryId: 'history', gameMode: true,
    currentPosition: 2, totalQuestions: 2, deadlineAt: null, question: null, ownSubmission: null, reveal: null,
    scores: [
      { playerId: 'me', nickname: '비밀닉네임', characterId: 'slime-blue', score: 7340, correctCount: 1, answeredCount: 2 },
    ],
    review: [{ ...ONLINE_ITEM, position: 1, id: 'online-history-006' }, ONLINE_ITEM],
  }, { inRoom: true });

  const items = byId('online-final-review').children;
  assert.equal(items.length, 2);
  for (const [index, item] of items.entries()) {
    const report = item.children.at(-1);
    assert.equal(report.tagName, 'P', '풀이 맨 끝의 한 줄');
    assert.equal(report.className, 'review__report');
    const [link] = report.children;
    assert.equal(link.tagName, 'A', '진짜 링크라 워커가 밟고 누른다');
    assert.equal(link.className, 'review__report-link');
    assert.equal(link.textContent, QUESTION_REPORT_TEXT);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(link.attributes['aria-label'], `이 문제 이상해요 · ${index + 1}번 문제 신고하기 — GitHub에서 새 창`);
    const { title, text } = parse(link.href);
    assert.equal(title, `[문제 신고] online-history-00${index + 6}`);
    for (const secret of [...ONLINE_SECRETS, '비밀닉네임', '7340']) {
      assert.ok(!text.includes(secret), `«${secret}» 가 주소에 실렸다`);
    }
  }
});

// ── 이름·요소 ───────────────────────────────────────────────────────

test('접근 가능한 이름은 보이는 글자로 시작하고 어느 문제인지·GitHub 새 창을 함께 말한다', () => {
  assert.equal(QUESTION_REPORT_TEXT, '이 문제 이상해요');
  assert.equal(questionReportLabel('3번 문제'), '이 문제 이상해요 · 3번 문제 신고하기 — GitHub에서 새 창');
  assert.equal(questionReportSubject('  조선을 세운 왕은?  '), '「조선을 세운 왕은?」');
  // 긴 질문은 앞부분만 — 목록에서 Tab 으로 다닐 때 긴 이름이 되풀이되지 않게
  assert.equal(questionReportSubject('가'.repeat(30)), `「${'가'.repeat(20)}…」`);
  assert.equal(questionReportSubject('🧪'.repeat(30)), `「${'🧪'.repeat(20)}…」`, '이모지를 반으로 가르지 않는다');

  const row = createQuestionReportLink('https://github.com/perust/quiz-by-quiz/issues/new?template=question-report.md', '이름');
  const [link] = row.children;
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer', '연 페이지가 이 페이지를 건드리지 못하고, 어디서 왔는지도 보내지 않는다');
  assert.equal(link.attributes['aria-label'], '이름');
});

test('로컬·온라인 결과 화면 모두 같은 링크 함수를 쓰고, 로컬은 공개 문제의 칸을 넘긴다', async () => {
  const [result, online, walker] = await Promise.all([
    source('src/ui/result.ts'), source('src/ui/online-result.ts'), source('src/ui/walker.ts'),
  ]);
  assert.match(result, /createQuestionReportLink\(\s*localQuestionReportUrl\(\{\s*id: item\.id,\s*category: item\.category,\s*question: item\.question,\s*choices: item\.choices,\s*answer: item\.correctChoice,\s*\}\),/);
  assert.match(online, /reportUrl: onlineQuestionReportUrl\(\{ id: item\.id, category: item\.categoryId \}\),/);
  assert.doesNotMatch(online, /localQuestionReportUrl/, '온라인 화면은 공개 은행용 주소를 만들지 않는다');
  // 링크는 워커가 밟는 «밟을 수 있는 것»이다
  assert.match(walker, /pickable = '[^']*\ba\[href\]/);
});

// ── 모양 ────────────────────────────────────────────────────────────

test('신고 링크: 밑줄 보라 글자, 44px 목표, 새 창 아이콘, 걸어서 올라서면 초점과 같은 고리', async () => {
  const rules = await loadStyles(['css/style.css', 'css/voxel-theme.css']);
  const screens = [
    node('ol.review#result-review', node('div.result-block#result-review-block', node("section.screen[data-screen='result']", node('main.app', node('body'))))),
    node('ol.review#online-final-review', node('div.result-block.online-final__review', node("section.screen.online-final[data-screen='online-result']", node('main.app', node('body'))))),
  ];
  for (const list of screens) {
    const row = node('p.review__report', node('li.review__item', list));
    const link = node('a.review__report-link', row);
    for (const env of [MOBILE, DESKTOP, NARROW]) {
      assert.ok(lengthOf(rules, valueOf(rules, link, 'min-height', env), env) >= 44, '홀로 서는 링크라 44px 목표');
      assert.equal(valueOf(rules, link, 'display', env), 'inline-flex');
      assert.equal(valueOf(rules, link, 'text-decoration', env), 'underline', '버튼이 아니라 링크로 읽힌다');
      assert.equal(valueOf(rules, link, 'color', env), 'var(--accent-ink)');
      assert.ok(lengthOf(rules, valueOf(rules, link, 'font-size', env), env) >= 12);
    }
    const icon = node('a.review__report-link::after', row);
    assert.match(valueOf(rules, icon, 'mask', MOBILE) ?? '', /var\(--i-external\)/, '글리프(↗)가 아니라 아이콘 묶음');
    assert.equal(valueOf(rules, icon, 'background-color', MOBILE), 'currentColor');
    const standing = node('a.review__report-link.is-standing', row);
    assert.equal(valueOf(rules, standing, 'outline', MOBILE), 'var(--focus-width) solid var(--focus)');
  }
});

// ── 템플릿·문서 ─────────────────────────────────────────────────────

test('이슈 템플릿: 한국어 «문제 신고»이고, 미리 채운 본문의 칸을 모두 갖는다', async () => {
  const template = await source('.github/ISSUE_TEMPLATE/question-report.md');
  const front = template.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, 'YAML 머리말');
  assert.match(front[1], /^name: 문제 신고$/m);
  assert.match(front[1], /^about: .+/m);
  assert.match(front[1], /^title: '\[문제 신고\] '$/m);
  // 신고는 저장소의 «문제 신고» 라벨로 모인다. URL 의 labels= 는 협업자만 붙일 수 있어 템플릿이 단다
  assert.match(front[1], /^labels: '문제 신고'$/m);

  const headings = (body) => body.split('\n').filter((line) => /^#{2,3} /.test(line));
  const templateLines = template.split('\n');
  for (const href of [localQuestionReportUrl(LOCAL), onlineQuestionReportUrl({ id: 'online-history-001', category: 'history' })]) {
    const { title, body } = parse(href);
    assert.ok(title.startsWith('[문제 신고] '), '제목 머리가 템플릿과 같다');
    for (const heading of headings(body)) assert.ok(templateLines.includes(heading), `템플릿에 «${heading}» 칸이 있다`);
    for (const field of body.split('\n').filter((line) => line.startsWith('- ') && line.includes(': '))) {
      const label = field.slice(0, field.indexOf(':') + 1);
      assert.ok(templateLines.some((line) => line.startsWith(label)), `템플릿에 «${label}» 칸이 있다`);
    }
  }
  assert.match(template, /개인 정보는 적지 말아 주세요/);
  assert.match(template, /문제 번호만 보내요/);
});

test('문서: 신고 처리 절차와 온라인 문제의 «번호만» 규칙을 적어 둔다', async () => {
  const [guide, bank, claude, prd] = await Promise.all([
    source('docs/question-bank-maintenance.md'),
    source('deploy/oracle/ONLINE_QUESTION_BANK.md'),
    source('CLAUDE.md'),
    source('docs/quiz-game-prd.md'),
  ]);
  assert.match(guide, /^## 받은 신고 처리/m);
  assert.match(guide, /\[문제 신고\]/);
  assert.match(guide, /question-report\.md/);
  assert.match(bank, /이 문제 이상해요/);
  assert.match(claude, /ui\/report-link\.ts/);
  assert.match(prd, /\| FR-5\.8 \|/);
  assert.doesNotMatch(prd.slice(prd.indexOf('### 3.3'), prd.indexOf('## 4.')), /문제 신고/, 'v1 제외 목록에서 뺐다');
});
