// 방 저장소의 «지금» 구현. 브라우저 안에서만 돈다.
//
// **이 앱에는 서버가 없다.** 정적 파일로만 배포되므로 다른 사람과 방을 나눠 가질
// 길이 없다. 그래서 화면과 흐름을 먼저 온전히 만들어 두고, 방을 이 브라우저의
// localStorage에 담아 둔다. 서버가 생기면 같은 인터페이스로 구현체만 갈아끼운다
// (`adapter.js` 한 줄) — 랭킹 저장소와 같은 방식이다.
//
// **localStorage를 만지는 것은 이 파일과 storage/local-store.js 뿐이다.**
// 화면(`ui/`)에서 직접 부르면 설계 위반이다.

import { ROOM_CAPACITY_CHOICES } from '../constants.js';
import { checkPassword, checkRoomName, makeCode, normalizeCode } from './rules.js';

const KEY = 'quiz.rooms';

/**
 * 이 브라우저를 가리키는 값. 새로고침하면 새로 생긴다.
 * 서버 구현에서는 계정이나 세션이 이 자리를 대신한다.
 */
const meId = globalThis.crypto?.randomUUID?.() ?? `me-${Date.now()}`;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    // 저장 데이터가 깨져도 앱이 죽지 않는다 (PRD 8). 성한 것만 살린다
    return Array.isArray(parsed) ? parsed.filter((room) => room && typeof room.code === 'string') : [];
  } catch {
    return [];
  }
}

function writeAll(rooms) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rooms));
  } catch {
    // 저장 공간이 꽉 차도 화면은 그대로 돈다. 다음 새로고침에 사라질 뿐이다
  }
}

/**
 * 밖으로 내보낼 모습.
 *
 * **비밀번호는 절대 나가지 않는다.** 잠겨 있는지(`hasPassword`)만 알린다 —
 * 서버 구현으로 바뀌어도 이 약속은 그대로여야 한다. 비밀번호를 내려보내면
 * 화면에서 견주게 되고, 그 순간 잠금은 아무 뜻이 없어진다.
 */
function toPublic(room) {
  return {
    code: room.code,
    name: room.name,
    categoryId: room.categoryId,
    capacity: room.capacity,
    players: room.players.map(({ id, nickname, characterId }) => ({ id, nickname, characterId })),
    isPublic: room.isPublic,
    hasPassword: Boolean(room.password),
    isMine: room.hostId === meId,
    joined: room.players.some((player) => player.id === meId),
    createdAt: room.createdAt,
  };
}

export const localRooms = {
  /** 이 저장소가 진짜 네트워크인지. 화면이 안내 문구를 정할 때 쓴다 */
  isNetworked: false,

  /** 지금 나를 가리키는 값 */
  me() {
    return meId;
  },

  /** 공개방만 돌려준다. 비공개 방은 코드를 아는 사람만 들어간다 */
  async listRooms() {
    return readAll().filter((room) => room.isPublic).map(toPublic);
  },

  /** 내가 들어가 있는 방. 목록과 따로 보여 준다 */
  async myRooms() {
    return readAll().filter((room) => room.players.some((p) => p.id === meId)).map(toPublic);
  },

  /**
   * @param {{ name, categoryId, capacity, isPublic, password, player }} spec
   *   player는 {nickname, characterId}. 만든 사람이 곧 첫 참가자다.
   * @returns {Promise<{ok: true, room: object} | {ok: false, message: string}>}
   */
  async createRoom({ name, categoryId, capacity, isPublic, password, player }) {
    const named = checkRoomName(name);
    if (!named.ok) return { ok: false, message: named.message };

    if (!isPublic) {
      const checked = checkPassword(password);
      if (!checked.ok) return { ok: false, message: checked.message };
    }

    const size = ROOM_CAPACITY_CHOICES.includes(Number(capacity))
      ? Number(capacity)
      : ROOM_CAPACITY_CHOICES[0];

    const rooms = readAll();
    // 같은 코드가 나오면 다시 뽑는다. 서른 번이면 사실상 겹치지 않는다
    let code = makeCode();
    for (let i = 0; i < 30 && rooms.some((room) => room.code === code); i += 1) code = makeCode();

    const room = {
      code,
      name: named.value,
      categoryId: categoryId || null,
      capacity: size,
      isPublic: Boolean(isPublic),
      password: isPublic ? '' : String(password),
      hostId: meId,
      players: [{ id: meId, nickname: player?.nickname || '나', characterId: player?.characterId }],
      createdAt: new Date().toISOString(),
    };

    writeAll([room, ...rooms]);
    return { ok: true, room: toPublic(room) };
  },

  /**
   * **비밀번호는 여기서 견준다.** 화면은 맞는지 모른 채 넘기기만 한다 —
   * 서버 구현이 되면 그 검사가 자연히 서버에서 일어난다.
   *
   * @returns {Promise<{ok: true, room} | {ok: false, reason: string}>}
   */
  async joinRoom({ code, password, player }) {
    const wanted = normalizeCode(code);
    const rooms = readAll();
    const room = rooms.find((item) => item.code === wanted);

    if (!room) return { ok: false, reason: 'not-found' };
    if (room.players.some((p) => p.id === meId)) return { ok: false, reason: 'already' };
    if (room.password) {
      if (!password) return { ok: false, reason: 'need-password' };
      if (String(password) !== room.password) return { ok: false, reason: 'wrong-password' };
    }
    if (room.players.length >= room.capacity) return { ok: false, reason: 'full' };

    room.players.push({
      id: meId,
      nickname: player?.nickname || '손님',
      characterId: player?.characterId,
    });
    writeAll(rooms);
    return { ok: true, room: toPublic(room) };
  },

  /** 방을 나간다. 아무도 남지 않으면 방을 지운다 */
  async leaveRoom({ code }) {
    const wanted = normalizeCode(code);
    const rooms = readAll();
    const room = rooms.find((item) => item.code === wanted);
    if (!room) return { ok: true };

    room.players = room.players.filter((player) => player.id !== meId);
    writeAll(room.players.length === 0
      ? rooms.filter((item) => item !== room)
      : rooms);
    return { ok: true };
  },
};
