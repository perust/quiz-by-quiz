// 방 저장소의 «지금» 구현. 브라우저 안에서만 돈다.
//
// **이 앱에는 서버가 없다.** 정적 파일로만 배포되므로 다른 사람과 방을 나눠 가질
// 길이 없다. 그래서 화면과 흐름을 먼저 온전히 만들어 두고, 방을 이 브라우저의
// localStorage에 담아 둔다. 서버가 생기면 같은 인터페이스로 구현체만 갈아끼운다
// (`adapter.js` 한 줄) — 랭킹 저장소와 같은 방식이다.
//
// **localStorage를 직접 만지지 않고 `storage/safe-storage.js`를 거친다.**
// 못 쓰는 환경(사생활 보호 모드)에서 메모리로 넘어가는 대비가 거기 있다 —
// 한때 여기서 직접 불렀고, 그래서 저장이 막힌 브라우저에서는 「만들기」를 눌러도
// 아무 일이 없었다. 방이 저장되지 않아 곧바로 «없는 방»이 됐기 때문이다.
// 화면(`ui/`)에서 저장소를 직접 부르면 설계 위반이다.

import { ROOM_CAPACITY_CHOICES } from '../constants.js';
import { isPersistent, safeStorage } from '../storage/safe-storage.js';
import {
  checkPassword, checkRoomName, makeCode, normalizeCode, uniqueNickname,
} from './rules.js';

const KEY = 'quiz.rooms';
const ME_KEY = 'quiz.playerId';

/**
 * 참가자를 «없는 사람»으로 보기까지의 시간.
 *
 * 서버라면 연결이 끊긴 순간을 알지만 여기서는 알 길이 없다. 그래서 마지막으로
 * 본 시각을 적어 두고 오래된 사람을 떨군다. **`seenAt`이 아예 없는 참가자도
 * 떨군다** — 신분을 남기기 전에 만들어진 자취라 주인이 다시 찾아올 수 없다.
 */
const GHOST_MS = 6 * 60 * 60 * 1000;

/**
 * 이 브라우저를 가리키는 값. **새로고침해도 그대로여야 한다.**
 *
 * 예전에는 페이지를 열 때마다 새로 만들었는데, 그러면 새로고침한 뒤의 내가
 * 방에게는 «다른 사람»이 된다. 들어갔던 자취가 남아 자리를 차지하고, 두 번
 * 새로고침하면 2인용 방이 나 혼자로 가득 차 다시 들어갈 수 없었다.
 *
 * 서버 구현에서는 계정이나 세션이 이 자리를 대신한다.
 */
const meId = (() => {
  try {
    const saved = safeStorage.getItem(ME_KEY);
    if (saved) return saved;
    const fresh = globalThis.crypto?.randomUUID?.() ?? `me-${Date.now()}`;
    safeStorage.setItem(ME_KEY, fresh);
    return fresh;
  } catch {
    // 저장을 못 하면 이번 세션에만 쓰는 값으로 버틴다
    return globalThis.crypto?.randomUUID?.() ?? `me-${Date.now()}`;
  }
})();

/**
 * 방마다 «무슨 일이 있었는지»를 듣는 사람들.
 *
 * 서버 구현에서는 소켓이 이 자리를 대신한다. 화면은 `subscribe`만 보고 그리므로,
 * 로컬에서 «내가 보낸 말»만 되돌아오든 서버에서 남의 말까지 오든 **그리는 코드는
 * 그대로다.** 지금 쓸 데가 없다고 빼 두면 서버를 붙일 때 화면을 다시 짜야 한다.
 */
const listeners = new Map();

function emit(code, event) {
  listeners.get(code)?.forEach((handler) => handler(event));
}

/**
 * 오래 안 보인 참가자를 떨군다. 아무도 남지 않은 방은 사라진다.
 *
 * 방 자체는 사람이 잠깐 나갔다 와도 남아 있어야 한다 — 새로고침하거나 연결이
 * 끊겼다고 방이 없어지면 남은 사람들이 함께 튕긴다. 그래서 **방이 아니라
 * 참가자를 정리한다.**
 */
function prune(rooms) {
  const now = Date.now();
  return rooms
    .map((room) => ({
      ...room,
      players: (room.players ?? []).filter((player) => player.seenAt && now - player.seenAt < GHOST_MS),
    }))
    .filter((room) => room.players.length > 0);
}

function readAll() {
  try {
    const raw = safeStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    // 저장 데이터가 깨져도 앱이 죽지 않는다 (PRD 8). 성한 것만 살린다
    const rooms = Array.isArray(parsed)
      ? parsed.filter((room) => room && typeof room.code === 'string')
      : [];
    return prune(rooms);
  } catch {
    return [];
  }
}

/** 내가 아직 여기 있다고 알린다. 방을 읽거나 무엇을 할 때마다 찍는다 */
function touch(room) {
  const me = room.players.find((player) => player.id === meId);
  if (me) me.seenAt = Date.now();
  return room;
}

/**
 * 성공했는지 돌려준다.
 *
 * **삼키기만 하면 안 된다.** 저장 공간이 꽉 차 방이 남지 않으면 다음 `readAll`이
 * 그 방을 못 찾아, 「만들기」를 눌러도 아무 일이 없는 것처럼 보인다. 실제로 그랬다 —
 * 화면도 바뀌지 않고 안내도 없어 버튼이 고장 난 줄 알게 된다.
 *
 * 방을 여는 길목(`createRoom`·`joinRoom`)만 이 값을 본다. 설정 변경이나 한마디는
 * 실패해도 화면이 그대로 돌고, 다음 새로고침에 되돌아갈 뿐이다.
 */
function writeAll(rooms) {
  try {
    safeStorage.setItem(KEY, JSON.stringify(rooms));
    return true;
  } catch {
    return false;
  }
}

/** 저장이 안 될 때 화면에 띄울 말. 두 길목이 같은 말을 쓴다 */
const SAVE_FAILED = '브라우저 저장 공간이 부족해 방을 만들지 못했어요. 저장 공간을 비우고 다시 시도해 주세요.';

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
    gameMode: Boolean(room.gameMode),
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

  /**
   * 만든 방이 새로고침 뒤에도 남는가.
   *
   * 저장이 막힌 브라우저에서는 메모리로 넘어가므로 방은 만들어지지만 탭을 닫으면
   * 사라진다. **되는 척하지 않는다** — 친구에게 코드를 알려 줬는데 새로고침 한 번에
   * 방이 없어지는 편이, 미리 알려 주는 것보다 나쁘다.
   */
  isPersistent,

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
      gameMode: false,
      password: isPublic ? '' : String(password),
      hostId: meId,
      players: [{
        id: meId,
        nickname: player?.nickname || '나',
        characterId: player?.characterId,
        seenAt: Date.now(),
      }],
      createdAt: new Date().toISOString(),
    };

    if (!writeAll([room, ...rooms])) return { ok: false, message: SAVE_FAILED };
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

    // 이미 들어가 있으면 그대로 들어간다. 새로고침하고 돌아온 것이 «거절»일 이유가 없다
    if (room.players.some((p) => p.id === meId)) {
      touch(room);
      writeAll(rooms);
      return { ok: true, room: toPublic(room) };
    }

    if (room.password) {
      if (!password) return { ok: false, reason: 'need-password' };
      if (String(password) !== room.password) return { ok: false, reason: 'wrong-password' };
    }
    if (room.players.length >= room.capacity) return { ok: false, reason: 'full' };

    room.players.push({
      id: meId,
      // 방 안에서 이름이 겹치면 뒤에 숫자를 붙인다. 같은 이름이 둘이면
      // 누가 누구인지, 말풍선이 누구 것인지 알 수 없다
      nickname: uniqueNickname(player?.nickname, room.players.map((p) => p.nickname)),
      characterId: player?.characterId,
      seenAt: Date.now(),
    });
    // 들어간 것이 저장되지 않으면 대기실에 가자마자 «없는 방»이 된다
    if (!writeAll(rooms)) return { ok: false, reason: 'save-failed' };
    return { ok: true, room: toPublic(room) };
  },

  /** 방 하나를 읽는다. 없으면 null */
  async getRoom(code) {
    const rooms = readAll();
    const room = rooms.find((item) => item.code === normalizeCode(code));
    if (!room) return null;
    // 방을 보고 있는 동안에는 «여기 있다»고 계속 알린다
    touch(room);
    writeAll(rooms);
    return toPublic(room);
  },

  /**
   * 방에서 일어나는 일을 듣는다. 되돌려 주는 함수를 부르면 그만 듣는다.
   *
   * 이벤트는 `{type: 'chat' | 'room', ...}`. 서버 구현에서는 여기가 소켓이 된다.
   */
  subscribe(code, handler) {
    const key = normalizeCode(code);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(handler);
    return () => listeners.get(key)?.delete(handler);
  },

  /**
   * 방 설정을 바꾼다. **방장만 바꿀 수 있다** — 이 판정도 구현체가 한다.
   * 화면에서만 막으면 서버 구현에서 그대로 뚫린다.
   */
  async updateRoom({ code, patch }) {
    const rooms = readAll();
    const room = rooms.find((item) => item.code === normalizeCode(code));
    if (!room) return { ok: false, reason: 'not-found' };
    if (room.hostId !== meId) return { ok: false, reason: 'not-host' };

    if ('categoryId' in patch) room.categoryId = patch.categoryId || null;
    if ('gameMode' in patch) room.gameMode = Boolean(patch.gameMode);
    if ('capacity' in patch) {
      const size = Number(patch.capacity);
      // 이미 들어와 있는 사람보다 작게 줄일 수는 없다
      if (ROOM_CAPACITY_CHOICES.includes(size) && size >= room.players.length) {
        room.capacity = size;
      }
    }

    writeAll(rooms);
    emit(room.code, { type: 'room', room: toPublic(room) });
    return { ok: true, room: toPublic(room) };
  },

  /**
   * 한 마디 보낸다. 로컬 구현에서는 **내가 보낸 것이 나에게만** 되돌아온다 —
   * 다른 브라우저로 나갈 길이 없기 때문이다. 서버 구현에서는 같은 이벤트가
   * 방에 있는 모두에게 간다.
   */
  async sendChat({ code, text, player }) {
    const said = String(text ?? '').trim().slice(0, 60);
    if (!said) return { ok: false };

    const key = normalizeCode(code);
    emit(key, {
      type: 'chat',
      playerId: meId,
      nickname: player?.nickname || '나',
      text: said,
      at: Date.now(),
    });
    return { ok: true };
  },

  /**
   * 판을 연다. **방장만 열 수 있다.**
   *
   * 여는 사람이 판을 직접 시작하지 않고 «시작됐다»는 이벤트를 보내는 것이 핵심이다.
   * 서버 구현에서는 그 이벤트가 방에 있는 **모두에게** 가므로, 화면은 «내가 눌렀는지»가
   * 아니라 «판이 열렸는지»를 보고 움직이면 된다 — 그래야 부르는 쪽을 고치지 않고
   * 여럿이 함께 시작하는 판이 된다.
   *
   * 로컬 구현에서는 방에 나뿐이라 그 이벤트가 나에게만 돌아온다.
   */
  async startGame({ code }) {
    const rooms = readAll();
    const room = rooms.find((item) => item.code === normalizeCode(code));
    if (!room) return { ok: false, reason: 'not-found' };
    if (room.hostId !== meId) return { ok: false, reason: 'not-host' };

    const setup = { categoryId: room.categoryId, gameMode: Boolean(room.gameMode) };
    emit(room.code, { type: 'match', phase: 'started', setup });
    return { ok: true, setup };
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
