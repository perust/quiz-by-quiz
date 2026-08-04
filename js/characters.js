// 캐릭터 목록
//
// 두 갈래다.
//   slime   — 무대에서 뛰어다니던 그 몸통. 색만 다르다
//   pixel   — 도트로 찍은 작은 몬스터
//
// **이미지 파일을 쓰지 않는다.** 슬라임은 CSS 그라디언트, 도트는 아래 grid를
// box-shadow로 펼쳐 그린다 (ui/sprite.js). 이 프로젝트는 바이너리 자산을 두지 않는다.
//
// 도트 그림은 문자 하나가 픽셀 하나다. 공백(또는 '.')은 비운다.
// 글자는 palette의 키이며, 어느 글자를 쓰든 상관없다.

/** 도트 한 칸의 크기(px). 스프라이트 크기는 grid 폭 × 이 값이 된다.
    box-shadow 로 찍으므로 «점의 크기»와 «점 사이 간격»이 이 값으로 같아야
    픽셀이 빈틈없이 붙는다 (walker__dot 의 width/height 도 이 값이다). */
export const PIXEL_UNIT = 5;

/**
 * @typedef {object} Character
 * @property {string} id 저장에 쓰는 값. 바꾸면 예전 선택이 풀린다
 * @property {string} name 화면에 보일 이름
 * @property {'slime'|'pixel'} kind
 * @property {string} [body] slime의 몸통 배경 (CSS)
 * @property {string[]} [grid] pixel의 도트 그림
 * @property {Record<string,string>} [palette] pixel의 글자 → 색
 */

/** @type {Character[]} */
export const CHARACTERS = [
  {
    id: 'slime-blue',
    name: '파랑 슬라임',
    kind: 'slime',
    body: 'linear-gradient(160deg, #6b8afd, #3b5bdb)',
  },
  {
    id: 'slime-mint',
    name: '민트 슬라임',
    kind: 'slime',
    body: 'linear-gradient(160deg, #63e6be, #0ca678)',
  },
  {
    id: 'slime-grape',
    name: '포도 슬라임',
    kind: 'slime',
    body: 'linear-gradient(160deg, #b197fc, #7048e8)',
  },
  {
    id: 'slime-peach',
    name: '복숭아 슬라임',
    kind: 'slime',
    body: 'linear-gradient(160deg, #ffa8a8, #f03e3e)',
  },
  {
    id: 'slime-lemon',
    name: '레몬 슬라임',
    kind: 'slime',
    body: 'linear-gradient(160deg, #ffe066, #f59f00)',
  },
  {
    id: 'slime-ink',
    name: '먹물 슬라임',
    kind: 'slime',
    body: 'linear-gradient(160deg, #868e96, #343a40)',
  },
  {
    id: 'pixel-ghost',
    name: '꼬마 유령',
    kind: 'pixel',
    palette: { B: '#e9ecef', S: '#adb5bd', E: '#212529' },
    grid: [
      '..BBBB..',
      '.BBBBBB.',
      'BBBBBBBB',
      'BEBBBBEB',
      'BEBBBBEB',
      'BBBBBBBB',
      'BBBBBBBB',
      'BSB.BSB.',
    ],
  },
  {
    id: 'pixel-frog',
    name: '개구리',
    kind: 'pixel',
    palette: { G: '#40c057', D: '#2b8a3e', E: '#212529', W: '#ffffff' },
    grid: [
      '.GG..GG.',
      'GWGGGGWG',
      'GEGGGGEG',
      'GGGGGGGG',
      'GGGGGGGG',
      'DGGGGGGD',
      'DDDDDDDD',
      'DD.DD.DD',
    ],
  },
  {
    id: 'pixel-cat',
    name: '고양이',
    kind: 'pixel',
    palette: { Y: '#ffd43b', O: '#f08c00', E: '#212529', P: '#ffa8a8' },
    grid: [
      'Y......Y',
      'YY....YY',
      'YYYYYYYY',
      'YEYYYYEY',
      'YYYPYYYY',
      'YOYYYYOY',
      'YYYYYYYY',
      '.YY..YY.',
    ],
  },
  {
    id: 'pixel-bat',
    name: '박쥐',
    kind: 'pixel',
    palette: { V: '#845ef7', D: '#5f3dc4', E: '#f8f9fa' },
    grid: [
      'V......V',
      'VV.VV.VV',
      'VVVVVVVV',
      'DVEVVEVD',
      'DVVVVVVD',
      'DDVVVVDD',
      '..DVVD..',
      '..D..D..',
    ],
  },
  {
    id: 'pixel-mush',
    name: '버섯',
    kind: 'pixel',
    palette: { R: '#fa5252', W: '#fff5f5', E: '#212529', S: '#ffe8cc' },
    grid: [
      '..RRRR..',
      '.RWRRWR.',
      'RRRRRRRR',
      'RWRRRRWR',
      'RRRRRRRR',
      '.SSSSSS.',
      '.SESSES.',
      '.SSSSSS.',
    ],
  },
  {
    id: 'pixel-robot',
    name: '로봇',
    kind: 'pixel',
    palette: { M: '#dee2e6', D: '#868e96', E: '#4dabf7', R: '#fa5252' },
    grid: [
      '...R....',
      '..MMM...',
      '.MMMMMM.',
      'MEMMMMEM',
      'MMMMMMMM',
      'MDDDDDDM',
      '.MMMMMM.',
      '.DD..DD.',
    ],
  },
];

export const DEFAULT_CHARACTER_ID = CHARACTERS[0].id;

/**
 * id로 캐릭터를 찾는다. 없는 id(옛 저장값 등)면 기본값을 돌려준다 —
 * 캐릭터를 빼도 앱이 죽지 않아야 한다.
 *
 * @param {string|null|undefined} id
 * @returns {Character}
 */
export function findCharacter(id) {
  return CHARACTERS.find((character) => character.id === id) ?? CHARACTERS[0];
}
