// 온라인 방의 규칙. 순수 함수와 그 함수들이 쓰는 이유·문구만 둔다 — DOM도 저장소도 모른다.
//
// 화면과 방 저장소가 **같은 규칙을 쓰게** 하려고 따로 뺐다. 화면에서만 검사하면
// 서버 구현으로 갈아끼웠을 때 서버가 다른 기준으로 거절해 말이 어긋난다.

import {
  ONLINE_QUESTION_TIME_CHOICES,
  ROOM_CODE_LENGTH, ROOM_NAME_MAX_LENGTH,
  ROOM_PASSWORD_MAX_LENGTH, ROOM_PASSWORD_MIN_LENGTH,
  TIME_LIMIT_MS,
} from '../constants.js';
import type { OnlineQuestionTime } from '../types.js';

/**
 * 검사 결과.
 *
 * 통과했으면 다듬은 값이, 아니면 화면에 띄울 말이 온다. 둘을 한 타입에 섞지 않아
 * `if (!result.ok) return result.message` 뒤에 값이 있다는 것을 컴파일러가 안다.
 */
export type CheckResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** 참가가 거절될 수 있는 사연. JOIN_MESSAGES가 이 목록을 빠짐없이 옮긴다 */
export type JoinFailReason =
  | 'not-found'
  | 'wrong-password'
  | 'need-password'
  | 'full'
  | 'save-failed'
  // 서버만 낸다 (U33). 연결 문제가 아니므로 «네트워크를 확인하라»로 뭉뚱그리지 않는다
  | 'game-in-progress'
  | 'rate-limited';

/** 방에서 나가기가 거절될 수 있는 사연. LEAVE_MESSAGES가 이 목록을 빠짐없이 옮긴다 */
export type LeaveFailReason = 'game-in-progress';

/**
 * 방장의 «내보내기»가 거절될 수 있는 사연 (U24). REMOVE_MEMBER_MESSAGES가 빠짐없이 옮긴다.
 * `member-connected`는 그 사이 다시 붙은 사람이다 — 접속 중인 사람은 내보낼 수 없다.
 */
export type RemoveMemberFailReason =
  | 'not-found'
  | 'not-host'
  | 'not-member'
  | 'member-connected'
  | 'game-in-progress';

/**
 * 방 코드에 쓰는 글자.
 * 0·O·1·I·L 처럼 눈으로 헷갈리는 것은 뺐다 — 코드는 사람이 불러 주고 받아 적는다.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 초대 링크(`…?room=CODE`)의 코드 자리. 붙여 넣은 링크 전체에서 코드만 뽑는다 */
const INVITE_CODE = /[?&]room=([^&#\s]*)/i;

/** 한글 자모·음절. 한글 자판 그대로 코드를 치면 이 글자들이 들어온다 */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff]/;

/**
 * 입력한 코드를 견줄 수 있는 꼴로 다듬는다. 소문자와 공백을 받아준다.
 * 초대 링크를 통째로 붙여 넣어도 `room=` 값만 쓴다 (U27).
 */
export function normalizeCode(raw: string | null | undefined): string {
  const text = String(raw ?? '');
  const invite = INVITE_CODE.exec(text);
  return (invite ? invite[1] : text).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 한글이 섞였는가. 지워 버리면 «여섯 글자가 아니다»로만 보여 이유를 알 수 없다 */
export function hasHangul(raw: string | null | undefined): boolean {
  return HANGUL.test(String(raw ?? ''));
}

/** 코드 칸이 거절될 때 띄우는 말. 화면이 같은 말을 입력 중에도 쓴다 */
export const CODE_MESSAGES = {
  hangul: '방 코드는 영문과 숫자예요. 영문 자판으로 바꿔 주세요.',
  length: '방 코드는 여섯 글자예요.',
} as const;

/**
 * 코드 칸에 적은 것을 검사한다. 한글이 섞였으면 지우고 넘어가지 않고 자판을 바꾸라고
 * 알린다 — 한글 자판이 기본인 휴대폰에서 가장 흔한 실수다 (U27).
 */
export function checkCodeInput(raw: string | null | undefined): CheckResult {
  if (hasHangul(raw)) return { ok: false, message: CODE_MESSAGES.hangul };
  const value = normalizeCode(raw);
  if (value.length !== ROOM_CODE_LENGTH) return { ok: false, message: CODE_MESSAGES.length };
  return { ok: true, value };
}

export function isValidCode(code: string | null | undefined): boolean {
  return normalizeCode(code).length === ROOM_CODE_LENGTH;
}

/** 새 방 코드. random을 받아 두어 테스트에서 결과를 고정할 수 있다 */
export function makeCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return code;
}

/**
 * 검사 결과는 {ok, message} 로 돌려준다. 던지지 않는 이유는 저장소 쪽과 같다 —
 * 사용자가 잘못 적은 것은 «예외»가 아니라 화면에 띄울 말이다.
 */
export function checkRoomName(name: string | null | undefined): CheckResult {
  const value = String(name ?? '').trim();
  if (value.length === 0) return { ok: false, message: '방 이름을 적어주세요.' };
  if (value.length > ROOM_NAME_MAX_LENGTH) {
    return { ok: false, message: `방 이름은 ${ROOM_NAME_MAX_LENGTH}자까지 쓸 수 있어요.` };
  }
  return { ok: true, value };
}

/** 비밀번호로 잠근 방일 때만 부른다. 공개방은 비밀번호를 두지 않는다 */
export function checkPassword(password: string | null | undefined): CheckResult {
  const value = String(password ?? '');
  if (value.length < ROOM_PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `비밀번호는 ${ROOM_PASSWORD_MIN_LENGTH}자 이상이어야 해요.` };
  }
  if (value.length > ROOM_PASSWORD_MAX_LENGTH) {
    return { ok: false, message: `비밀번호는 ${ROOM_PASSWORD_MAX_LENGTH}자까지 쓸 수 있어요.` };
  }
  return { ok: true, value };
}

/**
 * 방장이 고를 수 있는 온라인 문항 시간인가 (20초·40초). 서버·DB와 같은 목록이다.
 * 글자 `'40000'`이나 `true`처럼 모양만 비슷한 값은 받지 않는다.
 */
export function isOnlineQuestionTime(value: unknown): value is OnlineQuestionTime {
  return ONLINE_QUESTION_TIME_CHOICES.some((choice) => choice === value);
}

/**
 * 읽어 온 값을 문항 시간으로 좁힌다. 모르는 값이면 기본 20초 — 문항 시간을 모르던 때의 방은
 * 모두 20초였다. 서버 응답처럼 «있는데 모르는 값»을 믿지 않아야 하는 자리는 `isOnlineQuestionTime`으로 따로 거른다.
 */
export function onlineQuestionTimeOrDefault(value: unknown): OnlineQuestionTime {
  return isOnlineQuestionTime(value) ? value : TIME_LIMIT_MS;
}

/** 대기실 설정 칸이 누를 때마다 도는 다음 값 (20초 → 40초 → 20초) */
export function nextOnlineQuestionTime(current: OnlineQuestionTime): OnlineQuestionTime {
  const index = ONLINE_QUESTION_TIME_CHOICES.indexOf(current);
  return ONLINE_QUESTION_TIME_CHOICES[(index + 1) % ONLINE_QUESTION_TIME_CHOICES.length];
}

/** 설정 칸·만들기 폼에 쓰는 짧은 이름: «20초» */
export function onlineQuestionTimeLabel(value: OnlineQuestionTime): string {
  return `${Math.round(value / 1000)}초`;
}

/**
 * 방 안에서 겹치지 않는 이름을 만든다. 겹치면 뒤에 1부터 숫자를 붙인다.
 *
 * 이름이 같으면 누가 누구인지 알 수 없고, 말풍선이 떠도 누가 한 말인지 모른다.
 * **거절하지 않고 조용히 비켜 준다** — 방에 들어가려는 사람에게 이름을 고쳐 오라고
 * 돌려보낼 일이 아니다.
 *
 * @param wanted 쓰고 싶은 이름
 * @param taken 이미 방에 있는 이름들
 */
export function uniqueNickname(wanted: string | null | undefined, taken: string[]): string {
  const base = String(wanted ?? '').trim() || '손님';
  const used = new Set(taken);
  if (!used.has(base)) return base;

  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base}${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}${Date.now() % 1000}`;
}

/** 참가가 거절된 이유를 화면에 띄울 말로 옮긴다 */
export const JOIN_MESSAGES: Record<JoinFailReason, string> = {
  'not-found': '그런 코드의 방이 없어요. 코드를 다시 확인해 주세요.',
  'wrong-password': '비밀번호가 맞지 않아요.',
  'need-password': '비밀번호가 필요한 방이에요.',
  full: '방이 이미 가득 찼어요.',
  // 저장이 막힌 브라우저에서 일어난다. 조용히 실패하면 버튼이 고장 난 것처럼 보인다
  'save-failed': '브라우저 저장 공간이 부족해 들어가지 못했어요. 저장 공간을 비우고 다시 시도해 주세요.',
  // 진행 중인 판에는 새로 들어갈 수 없다. 언제 되는지까지 말해 준다 (U33)
  'game-in-progress': '지금 게임 중이에요. 끝나면 들어갈 수 있어요.',
  'rate-limited': '요청이 많아요. 잠시 후 다시 시도해 주세요.',
};

/** 나가기가 거절된 이유를 화면에 띄울 말로 옮긴다 */
export const LEAVE_MESSAGES: Record<LeaveFailReason, string> = {
  // 판이 도는 동안에는 서버가 멤버십을 지킨다. 연결 문제로 보이면 안 된다 (U32)
  'game-in-progress': '게임이 끝나면 나갈 수 있어요.',
};

/** 내보내기가 거절된 이유를 대기실 대화 로그에 남길 말로 옮긴다 (U24) */
export const REMOVE_MEMBER_MESSAGES: Record<RemoveMemberFailReason, (nickname: string) => string> = {
  'not-found': () => '그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.',
  'not-host': () => '방장만 참가자를 내보낼 수 있어요.',
  'not-member': (nickname) => `${nickname} 님은 이미 방에 없어요.`,
  // 확인창을 보는 사이 다시 붙었다. 연결된 사람은 내보내지 않는다
  'member-connected': (nickname) => `${nickname} 님이 다시 연결됐어요. 연결이 끊긴 참가자만 내보낼 수 있어요.`,
  'game-in-progress': (nickname) => `${nickname} 님은 진행 중인 판에 자리가 있어요. 판이 끝난 뒤에 내보낼 수 있어요.`,
};

/**
 * 끊긴 사이 방장이 나를 방에서 내보냈다 (U24). «그 방은 이미 사라졌어요»로 돌려보내면 방이
 * 없어진 줄 안다. 막은 것은 아니다 — 같은 코드로 다시 참가할 수 있다.
 */
export const REMOVED_BY_HOST_MESSAGE = '방장이 방에서 내보냈어요. 방 코드로 다시 참가할 수 있어요.';

/**
 * **플레이어에게 그대로 보여도 되는 말**을 가진 온라인 오류 (U40).
 *
 * 저장소가 던지는 그 밖의 오류의 `message`는 개발자를 위한 진단이다 — «서버 매치 snapshot이
 * 올바르지 않습니다», 브라우저의 «Failed to fetch» 같은 것. 서버가 4xx로 알려 준 거절, 응답이
 * 늦은 것처럼 이유를 플레이어의 말로 말할 수 있을 때만 이 오류로 던진다.
 */
export class OnlinePlayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnlinePlayerError';
  }
}

/**
 * 오류를 화면에 띄울 말로 옮긴다 (U40). `OnlinePlayerError`면 그 말을, 아니면 부르는 쪽이
 * 고른 `fallback`을 쓴다. **개발 상세는 콘솔에만 남긴다** — 화면에 «온라인 매치 오류: 서버 …»를
 * 띄우면 플레이어는 무엇을 해야 할지 모른다.
 */
export function onlineErrorText(error: unknown, fallback: string): string {
  if (error instanceof OnlinePlayerError) return error.message;
  console.warn('[온라인 오류]', error);
  return fallback;
}

/**
 * 저장소가 나가기를 **거절했다**는 표시 (U32).
 *
 * `leaveRoom`의 계약은 `{ok: true}`만 돌려준다. 거절을 그 값에 섞으면 결과를 보지 않던
 * 호출이 거절을 성공으로 읽고 화면을 옮겨 버리므로, 거절은 이 오류로 던진다. 연결 실패(그냥
 * `Error`)와 구분되므로 로비와 대기실이 같은 말(`LEAVE_MESSAGES`)로 이유를 말한다.
 */
export class LeaveRoomRejected extends OnlinePlayerError {
  constructor(readonly reason: LeaveFailReason) {
    super(LEAVE_MESSAGES[reason]);
    this.name = 'LeaveRoomRejected';
  }
}

/**
 * 방을 읽어 보니 방장이 나를 내보냈다는 표시 (U24). `getRoom`은 «없으면 null»인데, 내보내진
 * 것은 «없는 방»과 다른 말을 해야 해서 이 오류로 던진다. 대기실이 받아 로비로 돌려보내며 이 말을 띄운다.
 */
export class RemovedFromRoom extends OnlinePlayerError {
  constructor() {
    super(REMOVED_BY_HOST_MESSAGE);
    this.name = 'RemovedFromRoom';
  }
}
