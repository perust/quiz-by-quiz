// 온라인 방의 규칙. 순수 함수만 둔다 — DOM도 저장소도 모른다.
//
// 화면과 방 저장소가 **같은 규칙을 쓰게** 하려고 따로 뺐다. 화면에서만 검사하면
// 서버 구현으로 갈아끼웠을 때 서버가 다른 기준으로 거절해 말이 어긋난다.

import {
  ROOM_CODE_LENGTH, ROOM_NAME_MAX_LENGTH,
  ROOM_PASSWORD_MAX_LENGTH, ROOM_PASSWORD_MIN_LENGTH,
} from '../constants.js';

/**
 * 방 코드에 쓰는 글자.
 * 0·O·1·I·L 처럼 눈으로 헷갈리는 것은 뺐다 — 코드는 사람이 불러 주고 받아 적는다.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 입력한 코드를 견줄 수 있는 꼴로 다듬는다. 소문자와 공백을 받아준다 */
export function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code) {
  return normalizeCode(code).length === ROOM_CODE_LENGTH;
}

/** 새 방 코드. random을 받아 두어 테스트에서 결과를 고정할 수 있다 */
export function makeCode(random = Math.random) {
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
export function checkRoomName(name) {
  const value = String(name ?? '').trim();
  if (value.length === 0) return { ok: false, message: '방 이름을 적어주세요.' };
  if (value.length > ROOM_NAME_MAX_LENGTH) {
    return { ok: false, message: `방 이름은 ${ROOM_NAME_MAX_LENGTH}자까지 쓸 수 있어요.` };
  }
  return { ok: true, value };
}

/** 비공개 방일 때만 부른다. 공개방은 비밀번호를 두지 않는다 */
export function checkPassword(password) {
  const value = String(password ?? '');
  if (value.length < ROOM_PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `비밀번호는 ${ROOM_PASSWORD_MIN_LENGTH}자 이상이어야 해요.` };
  }
  if (value.length > ROOM_PASSWORD_MAX_LENGTH) {
    return { ok: false, message: `비밀번호는 ${ROOM_PASSWORD_MAX_LENGTH}자까지 쓸 수 있어요.` };
  }
  return { ok: true, value };
}

/** 참가가 거절된 이유를 화면에 띄울 말로 옮긴다 */
export const JOIN_MESSAGES = {
  'not-found': '그런 코드의 방이 없어요. 코드를 다시 확인해 주세요.',
  'wrong-password': '비밀번호가 맞지 않아요.',
  'need-password': '비밀번호가 필요한 방이에요.',
  full: '방이 이미 가득 찼어요.',
  already: '이미 들어가 있는 방이에요.',
};
