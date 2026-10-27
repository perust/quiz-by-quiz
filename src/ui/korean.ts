// 앞말에 맞는 조사를 고른다. DOM 도 게임 규칙도 모르는 글자 도우미다.
//
// 분야 이름처럼 바뀌는 낱말 뒤에 «는»을 박아 두면 받침이 있는 이름에서 틀린다 — 한때 홈 알림이
// «과학는 문제가 …»였다. 마지막 글자의 받침을 보고 고른다.

/** 숫자를 읽는 소리에 받침이 있는 것: 영(십·백…)·일·삼·육·칠·팔 */
const DIGITS_WITH_FINAL = '013678';

/**
 * 마지막 글자에 받침이 있는가. 한글 음절과 숫자(읽는 소리)만 판단하고, 그 밖(영문·기호·빈 글)은
 * 알 수 없어 `null` 이다.
 */
export function hasFinalConsonant(word: string): boolean | null {
  const last = word.trimEnd().at(-1);
  if (last === undefined) return null;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return DIGITS_WITH_FINAL.includes(last);
  return null;
}

/** 「과학은」 / 「한국사는」. 받침을 알 수 없으면 «은(는)»을 붙인다. 여럿을 이었으면 마지막 낱말을 본다 */
export function withTopic(word: string): string {
  const final = hasFinalConsonant(word);
  if (final === null) return `${word}은(는)`;
  return `${word}${final ? '은' : '는'}`;
}
