// 닉네임 금칙 규칙 (PRD 12.1, FR-7.13 2단계)
//
// 온라인 랭킹은 모두에게 보이므로 서버가 받는 닉네임에서 욕설과 개인 정보 모양(전화번호처럼 긴 숫자,
// 이메일, 주소창 주소)을 막는다. 같은 이름은 그대로 허용한다(방 안에서만 뒤에 숫자를 붙인다).
// 이 파일은 server/app/nickname_rules.json 과 server/app/nickname_filter.py 를 그대로 옮긴 것이다 —
// 홈의 닉네임 대화상자가 보내기 전에 같은 말로 설명하려는 것이다. 값이나 판정을 고치면 두 곳을 함께
// 고친다(tests/nickname-rules.test.mjs 가 값과 서버의 사례 표를 견준다).
//
// 판정은 일부러 단순하다. 정규화(전각 → 반각, 소문자) 뒤에
// - 숫자가 NICKNAME_MAX_DIGIT_RUN 개를 넘어 이어지면(사이의 공백·하이픈·점·밑줄은 무시) 전화번호 모양,
// - «글자@글자»면 이메일 모양,
// - «://»·«www.»나 «무엇.<주소 끝>»(com, kr …)이면 주소창 주소 모양,
// - 글자만 남긴 꼴(숫자·기호·공백을 지운다)에 금칙어가 들어 있으면 욕설이다.
// 길이(2~10자)는 여기서 보지 않는다 — 대화상자가 먼저 본다.

export type NicknameProblem = 'profanity' | 'digits' | 'email' | 'url';

/** 이만큼까지는 숫자를 이어 써도 된다. 하나 더 이어지면 전화번호 모양으로 본다 */
export const NICKNAME_MAX_DIGIT_RUN = 5;

export const NICKNAME_URL_SUFFIXES: readonly string[] = [
  'com', 'net', 'org', 'kr', 'io', 'co', 'me', 'gg', 'xyz', 'app',
  'dev', 'ly', 'to', 'tv', 'info', 'biz', 'site', 'link', 'shop', 'page',
];

/** 짧고 보수적으로 둔다. 글자만 남긴 꼴로 적는다 */
export const NICKNAME_BLOCKED_WORDS: readonly string[] = [
  '시발', '씨발', '씨빨', '씨팔', 'ㅅㅂ', 'ㅆㅂ',
  '병신', '븅신', 'ㅂㅅ', 'ㅄ',
  '개새끼', '개새기', '개색기', '개색히',
  '좆', '존나', '지랄', 'ㅈㄹ',
  '미친놈', '미친년', '니애미', '느금마', '엿먹', '썅', '쌍년',
  '섹스',
  'fuck', 'shit', 'bitch', 'tlqkf', 'qudtls', 'sibal', 'ssibal', 'porn',
];

/** 대화상자가 보내기 전에 보이는 까닭 (해요체 한 문장씩) */
export const NICKNAME_PROBLEM_MESSAGES: Readonly<Record<NicknameProblem, string>> = {
  profanity: '닉네임에 쓸 수 없는 말이 들어 있어요. 다른 이름을 지어 주세요.',
  digits: `숫자는 ${NICKNAME_MAX_DIGIT_RUN}개까지만 이어 쓸 수 있어요. 전화번호 같은 개인 정보는 넣지 말아 주세요.`,
  email: '이메일 주소처럼 보이는 닉네임은 쓸 수 없어요. 개인 정보는 넣지 말아 주세요.',
  url: '인터넷 주소처럼 보이는 닉네임은 쓸 수 없어요.',
};

const FULL_WIDTH = /[！-～]/g;
const IDEOGRAPHIC_SPACE = /　/g;
const NOT_LETTER = /[^a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g;
const DIGITS = new RegExp(`[0-9](?:[ .\\-_]*[0-9]){${NICKNAME_MAX_DIGIT_RUN},}`);
const EMAIL = /[0-9a-z._%+-]@[0-9a-z]/;
const URL_MARKERS = /:\/\/|www\./;
const URL_SHAPE = new RegExp(`[^ .]\\.(?:${NICKNAME_URL_SUFFIXES.join('|')})(?![0-9a-z])`);

/**
 * 전각 영숫자·기호(０１＠．)와 대문자를 한 꼴로 모은다. 서버와 같은 순서다.
 * NFKC는 쓰지 않는다 — 한글 호환 자모(ㅅ·ㅂ)까지 첫가끝 자모로 풀어 «ㅅㅂ»을 놓친다.
 */
export function normalizeNickname(value: string): string {
  return value
    .normalize('NFC')
    .replace(FULL_WIDTH, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(IDEOGRAPHIC_SPACE, ' ')
    .toLowerCase();
}

/** 정규화한 뒤 영문 소문자와 한글만 남긴다 */
export function compactNickname(value: string): string {
  return normalizeNickname(value).replace(NOT_LETTER, '');
}

/** 닉네임이 걸리는 까닭. 괜찮으면 null 이다 */
export function nicknameProblem(value: string): NicknameProblem | null {
  const normalized = normalizeNickname(value);
  if (DIGITS.test(normalized)) return 'digits';
  if (EMAIL.test(normalized)) return 'email';
  if (URL_MARKERS.test(normalized) || URL_SHAPE.test(normalized)) return 'url';
  const letters = compactNickname(value);
  if (NICKNAME_BLOCKED_WORDS.some((word) => letters.includes(word))) return 'profanity';
  return null;
}
