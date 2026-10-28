import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';

// 화면 문구의 말투는 해요체 하나다 (N10, 소유자 결정 — docs/design-system.md §11).
// 한때 한 화면 안에서 «정답입니다»(판정)와 «정답 공개까지 8초»·«제출 완료! … 기다리는 중이에요»가,
// 대기실에서는 «그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.»가 한 문장 안에서
// 섞였다. 플레이어가 보거나 듣는 글 — index.html 의 글·이름 속성, src/ 의 문자열, 서버가 화면에
// 보내는 거절 이유 — 에 합쇼체(…습니다·…입니다·…냅니다·…십시오)와 한다체 문장 끝(…한다.)이 없는지 본다.
//
// 범위 밖: 문제 은행(data/*.json), 주석(한다체 그대로), 문서, 테스트 이름, legacy/.
// 개발 진단은 화면에 나가지 않으므로 보지 않는다 — `console.*`·`warnOnce`에 넘기는 글과 기본 `Error`의
// message(화면은 `OnlinePlayerError`만 그대로 쓰고 나머지는 고른 말로 바꾼다, U40). 화면에 그대로
// 옮길 오류는 이름 있는 오류(`OnlinePlayerError` 등)로 던지고, 그 글은 여기서 검사된다.

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

/** 화면에 나가지 않는 글만 남은 파일. 이유를 함께 적고, 더 필요 없어지면 지운다 */
const ALLOWED_FILES = new Map([
  ['src/data/validate.ts', '문제 은행 검증 사유 — loader.ts 가 console.warn 에만 남기고 화면에 쓰지 않는다 (FR-1.9)'],
]);

/** 글을 받아 콘솔로만 보내는 호출 */
const DIAGNOSTIC_CALLS = /^(console\.\w+|warnOnce)$/;
/** message 가 개발 진단인 기본 오류 (U40) */
const DIAGNOSTIC_ERRORS = new Set(['Error', 'TypeError', 'RangeError']);

const HANGUL = /[가-힣]/;
const JONGSEONG_BIEUP = 17; // 받침 ㅂ

/** 합쇼체 끝: ㅂ 받침 뒤의 니다·니까·시다(습니다·입니다·됩니다·냅니다·합시다 …)와 십시오 */
function formalEndings(text) {
  const found = [];
  for (const match of text.matchAll(/([가-힣])(니다|니까|시다)/g)) {
    if ((match[1].charCodeAt(0) - 0xac00) % 28 === JONGSEONG_BIEUP) found.push(match[0]);
  }
  for (const match of text.matchAll(/십시오/g)) found.push(match[0]);
  return found;
}

/** 한다체 문장 끝: 낱말에 붙은 «다»가 문장(또는 글 조각)을 닫는다 — «지워진다.»·«냅니다»는 여기서도 걸린다 */
function plainEndings(text) {
  return [...text.matchAll(/[가-힣]다(?=[.!?]|\s*$)/g)].map((match) => match[0]);
}

function toneProblems(text) {
  const formal = formalEndings(text);
  // «…니다»는 위에서 합쇼체로 이미 잡았다 — 같은 끝을 두 번 말하지 않는다
  const plain = plainEndings(text).filter((ending) => !(formal.length > 0 && ending === '니다'));
  return [...formal, ...plain];
}

// ── index.html ────────────────────────────────────────────────

const NAME_ATTRIBUTES = /\s(aria-label|aria-description|aria-roledescription|aria-valuetext|aria-placeholder|title|placeholder|alt|content)="([^"]*)"/g;

/** 보이는 글(문장 안의 <strong>·<kbd> 같은 글자 꾸밈은 이어 붙인다)과 이름 속성 */
function htmlUnits(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const units = [];
  for (const tag of body.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const [, name, value] of tag[0].matchAll(NAME_ATTRIBUTES)) {
      units.push({ where: `index.html [${name}]`, text: value });
    }
  }
  const sentences = body.replace(/<\/?(strong|em|b|i|kbd|code|a)\b[^>]*>/gi, '');
  for (const piece of sentences.split(/<[^>]*>/)) {
    const text = piece.replace(/\s+/g, ' ').trim();
    if (text) units.push({ where: 'index.html', text });
  }
  return units.filter(({ text }) => HANGUL.test(text));
}

// ── src/**/*.ts ───────────────────────────────────────────────

async function tsFiles(dir) {
  const entries = await readdir(new URL(dir, root), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return tsFiles(`${path}/`);
    return path.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

/** 이 글이 콘솔로만 가는가 — 가장 가까운 함수 경계 안에서 진단 호출·기본 오류의 인자인지 본다 */
function isDiagnostic(node) {
  for (let parent = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
    if (ts.isCallExpression(parent) && DIAGNOSTIC_CALLS.test(parent.expression.getText())) return true;
    if (ts.isNewExpression(parent) && DIAGNOSTIC_ERRORS.has(parent.expression.getText())) return true;
  }
  return false;
}

/** 주석을 뺀 문자열 리터럴과 템플릿 글. 템플릿의 ${…} 자리는 {} 로 잇는다(끝이 아니다) */
function tsUnits(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const units = [];
  const skipped = [];
  const take = (node, value) => {
    if (!HANGUL.test(value)) return;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    (isDiagnostic(node) ? skipped : units).push({ where: `${path}:${line}`, text: value });
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      take(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      take(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('{}'));
      node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { units, skipped };
}

// ── server/app/*.py ───────────────────────────────────────────

/**
 * 한 줄 문자열 리터럴만 모은다. 주석과 세 따옴표 글(docstring·SQL)은 뺀다 — 화면으로 가는 거절
 * 이유(`_error(...)`·`DomainError(...)`의 message)는 모두 한 줄 리터럴이다.
 */
function pythonUnits(path, text) {
  const units = [];
  let line = 1;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '\n') { line += 1; i += 1; continue; }
    if (char === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (char !== '"' && char !== "'") { i += 1; continue; }
    const quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
    let end = i + quote.length;
    while (end < text.length && !text.startsWith(quote, end)) {
      if (quote.length === 1 && text[end] === '\n') break;
      end += text[end] === '\\' ? 2 : 1;
    }
    const value = text.slice(i + quote.length, end);
    if (quote.length === 1 && HANGUL.test(value)) units.push({ where: `${path}:${line}`, text: value });
    line += (text.slice(i, end + quote.length).match(/\n/g) ?? []).length;
    i = end + quote.length;
  }
  return units;
}

async function serverUnits() {
  const names = (await readdir(new URL('server/app/', root))).filter((name) => name.endsWith('.py'));
  const all = await Promise.all(names.map(async (name) => pythonUnits(`server/app/${name}`, await source(`server/app/${name}`))));
  return all.flat();
}

function report(problems) {
  return problems.map(({ where, text, found }) => `${where} «${found.join('·')}» ${text}`).join('\n');
}

function check(units) {
  return units
    .map((unit) => ({ ...unit, found: toneProblems(unit.text) }))
    .filter(({ found }) => found.length > 0);
}

// ──────────────────────────────────────────────────────────────

test('말투 검사기: 합쇼체·한다체 끝을 잡고 해요체·명사형 라벨은 그대로 둔다', () => {
  for (const formal of ['정답입니다', '시간 초과입니다', '기록이 아직 없습니다.', '방이 지워집니다.', '바로 냅니다',
    '두 방향을 함께 누릅니다', '움직입니다', '시작합니다', '출제됩니다', '어떻습니까?', '함께 갑시다', '눌러 주십시오']) {
    assert.ok(formalEndings(formal).length > 0, `합쇼체를 놓쳤다: ${formal}`);
  }
  for (const plain of ['방이 지워진다.', '기록이 남지 않는다', '정답이다.', '다시 걷기로 간다!']) {
    assert.ok(plainEndings(plain).length > 0, `한다체 끝을 놓쳤다: ${plain}`);
  }
  for (const polite of ['정답이에요', '시간 초과예요', '아쉬워요, 오답이에요', '퀴즈를 그만둘까요?', '다음 문제', '나가기',
    '준비 완료', '방 코드', '비밀번호로 잠그기', '다시 하기', '보기를 누르면 바로 답 · 시간이 끝나면 선 칸이 답',
    '문항 시간은 방장이 방마다 20초나 40초로 정해요.', '시간이 다 되면 그때 밟고 있는 칸이 답이 돼요.',
    '웬만한 건 다 알고 계시네요.', '잠시 뒤 다시 시도해 주세요.', '「${room.name}」 방에 아직 있어요', '다시 시도']) {
    assert.deepEqual(toneProblems(polite), [], `해요체·라벨을 잘못 잡았다: ${polite}`);
  }
});

test('index.html 의 보이는 글과 이름 속성은 해요체다 (부팅 화면·대화상자·조작법 포함)', async () => {
  const units = htmlUnits(await source('index.html'));
  assert.ok(units.length > 150, `글을 거의 읽지 못했다: ${units.length}개`);
  // 비어 있게 통과하지 않도록 아는 자리를 짚는다 — 조작법·부팅 개발자 카드·대화상자
  for (const known of ['캐릭터는 십자 한가운데에서 시작해요.', '게임을 불러오지 못했어요', '저장된 랭킹 기록이 전부 사라져요. 되돌릴 수 없어요.']) {
    assert.ok(units.some(({ text }) => text.includes(known)), `읽은 글에 없다: ${known}`);
  }
  assert.ok(units.some(({ where }) => where === 'index.html [aria-label]'), '이름 속성도 읽는다');
  const problems = check(units);
  assert.equal(problems.length, 0, `해요체가 아닌 화면 글:\n${report(problems)}`);
});

test('src/ 의 화면 문자열(주석·콘솔 진단 제외)은 해요체다', async () => {
  const files = await tsFiles('src/');
  assert.ok(files.length > 40, `src 파일을 거의 찾지 못했다: ${files.length}개`);
  const scanned = [];
  const allowedHits = new Map([...ALLOWED_FILES.keys()].map((path) => [path, 0]));
  for (const path of files) {
    const { units } = tsUnits(path, await source(path));
    if (ALLOWED_FILES.has(path)) {
      allowedHits.set(path, check(units).length);
      continue;
    }
    scanned.push(...units);
  }
  assert.ok(scanned.length > 300, `문자열을 거의 읽지 못했다: ${scanned.length}개`);
  const problems = check(scanned);
  assert.equal(problems.length, 0, `해요체가 아닌 화면 문자열:\n${report(problems)}`);
  for (const [path, hits] of allowedHits) {
    assert.ok(hits > 0, `${path} 는 더 이상 예외가 필요 없다 — ALLOWED_FILES 에서 지운다 (${ALLOWED_FILES.get(path)})`);
  }
});

test('콘솔 진단만 건너뛴다 — 화면으로 가는 이름 있는 오류와 announce 글은 검사한다', () => {
  const sample = [
    "console.warn('[저장소] 값이 손상되어 무시합니다');",
    "throw new Error('서버 방 응답이 올바르지 않습니다.');",
    "warnOnce('key', '[저장소] 랭킹을 비우고 시작합니다');",
    "throw new OnlinePlayerError('채팅은 잠시 뒤 다시 보낼 수 있습니다.');",
    "announce('시간이 얼마 남지 않았습니다.');",
    "const verdict = ok ? '정답입니다' : `${label}입니다.`;",
  ].join('\n');
  const { units, skipped } = tsUnits('sample.ts', sample);
  assert.deepEqual(skipped.map(({ where }) => where), ['sample.ts:1', 'sample.ts:2', 'sample.ts:3']);
  assert.deepEqual(check(units).map(({ where }) => where), ['sample.ts:4', 'sample.ts:5', 'sample.ts:6', 'sample.ts:6']);
});

test('로컬·온라인 판정은 같은 해요체 세 말이다', async () => {
  const [quiz, online] = await Promise.all([source('src/ui/quiz.ts'), source('src/ui/online-quiz.ts')]);
  for (const verdict of ['정답이에요', '시간 초과예요', '아쉬워요, 오답이에요']) {
    assert.ok(quiz.includes(`'${verdict}'`), `로컬 판정에 없다: ${verdict}`);
    assert.ok(online.includes(`'${verdict}'`), `온라인 판정에 없다: ${verdict}`);
  }
});

test('서버가 화면에 보내는 거절 이유(server/app)는 해요체다 — 오류 코드는 그대로다', async () => {
  const units = await serverUnits();
  assert.ok(units.length > 40, `서버 문자열을 거의 읽지 못했다: ${units.length}개`);
  assert.ok(units.some(({ text }) => text === '그런 코드의 방이 없어요.'), '거절 이유를 읽는다');
  const problems = check(units);
  assert.equal(problems.length, 0, `해요체가 아닌 서버 거절 이유:\n${report(problems)}`);
  const main = await source('server/app/main.py');
  assert.match(main, /_error\(404, "not-found", "그런 코드의 방이 없어요\."\)/, '코드(not-found)는 그대로 두고 말만 바꾼다');
});

test('서버 문자열 읽기: 주석과 docstring 은 빼고 한 줄 리터럴만 모은다', () => {
  const sample = [
    'def handler():',
    '    """방을 잠그고 다시 확인한다. 끝났습니다."""',
    '    # 주석은 한다체다. 지웁니다.',
    '    raise _error(404, "not-found", "그런 코드의 방이 없습니다.")',
    "    name = '손님'",
  ].join('\n');
  assert.deepEqual(pythonUnits('sample.py', sample), [
    { where: 'sample.py:4', text: '그런 코드의 방이 없습니다.' },
    { where: 'sample.py:5', text: '손님' },
  ]);
});
