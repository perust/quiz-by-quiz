import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hasFinalConsonant, withTopic } from '../js/ui/korean.js';
import { CATEGORIES } from '../js/constants.js';

// 조사 고르기 (ui/korean.ts). 홈의 문항 부족 알림이 분야 이름 뒤에 «는»을 박아 두어
// 받침이 있는 이름에서 «과학는 문제가 …»로 나왔다. 마지막 글자의 받침으로 «은/는»을 고른다.

test('withTopic: 받침이 있으면 «은», 없으면 «는»', () => {
  assert.equal(withTopic('과학'), '과학은');
  assert.equal(withTopic('한국사'), '한국사는');
  assert.equal(withTopic('일반상식'), '일반상식은');
  assert.equal(withTopic('예술과문화'), '예술과문화는');
  // ㄹ 받침도 받침이다(«로»와 다르다)
  assert.equal(withTopic('하늘'), '하늘은');
});

test('withTopic: 여럿을 이었으면 마지막 이름을 본다', () => {
  assert.equal(withTopic('과학, 지리'), '과학, 지리는');
  assert.equal(withTopic('지리, 과학'), '지리, 과학은');
});

test('withTopic: 숫자는 읽는 소리로, 알 수 없으면 «은(는)»', () => {
  assert.equal(withTopic('10'), '10은', '십');
  assert.equal(withTopic('2'), '2는', '이');
  assert.equal(withTopic('3'), '3은', '삼');
  assert.equal(withTopic('quiz'), 'quiz은(는)');
  assert.equal(hasFinalConsonant(''), null);
  assert.equal(hasFinalConsonant('과학 '), true, '끝 공백은 보지 않는다');
});

test('분야 이름 다섯 모두 «은(는)»으로 미루지 않고 맞는 조사를 고른다', () => {
  const expected = {
    history: '한국사는',
    science: '과학은',
    geography: '지리는',
    general: '일반상식은',
    art: '예술과문화는',
  };
  for (const category of CATEGORIES) {
    assert.equal(withTopic(category.name), expected[category.id], category.id);
  }
});

test('홈 알림: 문항 부족 문장은 분야 이름 뒤에 «는»을 박아 두지 않는다', async () => {
  const app = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\$\{names\}(은|는|이|가|을|를)/, '조사를 박아 둔 이름 목록이 없다');
  assert.match(app, /notes\.push\(`\$\{withTopic\(names\)\} 문제가 \$\{QUESTIONS_PER_ROUND\}개보다 적어 있는 만큼만 출제돼요\.`\);/);
});
