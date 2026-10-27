import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 닉네임 금칙 규칙 (PRD 12.1). 온라인 랭킹은 모두에게 보이므로 서버가 욕설과 개인 정보 모양(긴 숫자·이메일·
// 주소창 주소)을 거절한다. 홈의 닉네임 대화상자가 보내기 전에 같은 말로 설명하려고 화면도 같은 규칙을 갖는다.
// 두 벌이 어긋나면 화면은 통과시켰는데 서버가 거절하거나 그 반대가 된다 — 값과 사례 판정을 함께 견준다.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const rules = await import('../js/online/nickname-rules.js');
const serverRules = JSON.parse(await source('server/app/nickname_rules.json'));
const { cases } = JSON.parse(await source('server/tests/fixtures/nickname_cases.json'));

test('화면의 규칙 값은 서버의 데이터 파일과 같다', () => {
  assert.equal(rules.NICKNAME_MAX_DIGIT_RUN, serverRules.maxDigitRun);
  assert.deepEqual([...rules.NICKNAME_URL_SUFFIXES], serverRules.urlSuffixes);
  assert.deepEqual([...rules.NICKNAME_BLOCKED_WORDS], serverRules.blockedWords);
  // 목록은 글자만 남긴 꼴로 적는다 — 그래야 «시1발»·«시 발»도 같은 말로 걸린다
  for (const word of rules.NICKNAME_BLOCKED_WORDS) assert.equal(rules.compactNickname(word), word, word);
});

test('서버의 사례 표와 같은 판정을 낸다', () => {
  assert.ok(cases.length >= 30);
  for (const { nickname, problem } of cases) {
    assert.equal(rules.nicknameProblem(nickname), problem, nickname);
  }
  // 같은 이름은 막지 않는다 — 방 안에서만 뒤에 숫자를 붙인다
  assert.equal(rules.nicknameProblem('퀴즈왕1'), null);
});

test('정규화는 전각과 대문자를 모으되 한글 호환 자모를 풀지 않는다', () => {
  assert.equal(rules.normalizeNickname('ＡＢＣ１２３＠．'), 'abc123@.');
  assert.equal(rules.normalizeNickname('ㅅㅂ'), 'ㅅㅂ');
  assert.equal(rules.normalizeNickname('가'), '가');
  assert.equal(rules.compactNickname('시 1 발!'), '시발');
});

test('까닭마다 해요체 한 문장으로 무엇을 고칠지 말하고, 받은 이름을 되풀이하지 않는다', () => {
  assert.deepEqual(Object.keys(rules.NICKNAME_PROBLEM_MESSAGES).sort(), ['digits', 'email', 'profanity', 'url']);
  for (const message of Object.values(rules.NICKNAME_PROBLEM_MESSAGES)) {
    assert.match(message, /요\.$/);
    assert.doesNotMatch(message, /서버|API/);
  }
  assert.match(rules.NICKNAME_PROBLEM_MESSAGES.digits, /5개까지만/);
});

test('홈의 닉네임 대화상자가 저장하기 전에 같은 규칙으로 막고 까닭을 상태 줄에 쓴다', async () => {
  const home = await source('src/ui/home.ts');
  const html = await source('index.html');
  const submit = home.slice(home.indexOf("el.dialogForm.addEventListener('submit'"));
  const check = submit.indexOf('nicknameProblem(wanted)');
  assert.ok(check !== -1, '저장 전에 금칙 규칙을 본다');
  assert.ok(check < submit.indexOf('onNickname(nickname)'), '걸린 이름은 저장하지 않는다');
  assert.match(submit, /el\.dialogMessage\.hidden = false;\s*el\.dialogMessage\.textContent = NICKNAME_PROBLEM_MESSAGES\[problem\];/);
  // 대화상자의 상태 줄은 role=status 이고, 모두에게 보인다는 것을 미리 말한다
  assert.match(html, /<p class="room-message" id="nickname-message" role="status" hidden><\/p>/);
  assert.match(html, /온라인 랭킹은 모두가 보니 전화번호·이메일 같은 개인 정보는 넣지 마세요\./);
});
