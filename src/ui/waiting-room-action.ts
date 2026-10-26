import type { PublicPlayer, PublicRoom } from '../online/adapter.js';

export interface WaitingRoomActionOwnership {
  request: number;
  code: string;
  snapshot: PublicRoom;
}

export interface WaitingRoomActionState {
  request: number | null;
  room: PublicRoom | null;
}

export interface WaitingRoomControls {
  /** 방장은 시작 요청이 곧 준비라 「준비 완료」를 따로 누를 일이 없다. */
  readyHidden: boolean;
  readyDisabled: boolean;
  startHidden: boolean;
  startDisabled: boolean;
}

/**
 * 시작 판정에 세는 참가자. 서버 `start_game`과 같은 규칙이다 — 화면에서만 다르게 세면
 * 서버가 다른 기준으로 거절해 말이 어긋난다.
 *
 * - 방장(시작을 누르는 사람)은 언제나 센다. 시작 요청이 곧 방장의 준비다
 * - 유예를 넘겨 끊긴 사람(`connected: false`)은 기다리지 않고 판에도 넣지 않는다
 */
function startRoster(room: PublicRoom, hostId: string): {
  counted: PublicPlayer[];
  waiting: PublicPlayer[];
  offline: PublicPlayer[];
} {
  const counted = room.players.filter((player) => player.connected || player.id === hostId);
  return {
    counted,
    waiting: counted.filter((player) => player.id !== hostId && !player.isReady),
    offline: room.players.filter((player) => !player.connected && player.id !== hostId),
  };
}

/** 역할과 server 시작 조건을 그대로 반영한 대기실 CTA 상태. */
export function waitingRoomControls(room: PublicRoom, playerId: string): WaitingRoomControls {
  const me = room.players.find((player) => player.id === playerId) ?? null;
  const joined = room.joined && me !== null;
  // 판이 도는 동안 준비를 못 바꾸는 것은 그 판의 참가자뿐이다(서버 set_ready와 같다).
  // 끊겨서 판에서 빠진 멤버(U24)는 다음 판을 미리 준비해 둔다. 시작은 판이 끝나야 된다.
  const readyDisabled = !joined || (room.status === 'playing' && room.inMatch);
  const roster = startRoster(room, playerId);
  const canStart = room.isMine
    && joined
    && room.status !== 'playing'
    && roster.counted.length >= 2
    && roster.waiting.length === 0;

  return {
    readyHidden: room.isMine,
    readyDisabled,
    startHidden: !room.isMine,
    startDisabled: !canStart,
  };
}

/** 「민수 님」 / 「민수 님 외 2명」 */
function who(players: readonly PublicPlayer[]): string {
  const [first] = players;
  if (!first) return '';
  return players.length === 1
    ? `${first.nickname} 님`
    : `${first.nickname} 님 외 ${players.length - 1}명`;
}

/**
 * 「게임 시작」 아래 상태 줄(`#waiting-start-status`, role=status)의 글.
 *
 * 꺼진 버튼은 눌러도 click이 나지 않아 «왜 안 되는지»를 알릴 자리가 없었다. 그래서
 * 이유를 버튼 밖 한 줄에 늘 적어 두고 `aria-describedby`로 버튼과 묶는다. 준비 토글처럼
 * 자주 바뀌는 변화도 대화 로그가 아니라 여기서만 낭독된다(CHAT_LINES를 대화에 남긴다).
 */
export function waitingRoomStartStatus(
  room: PublicRoom,
  playerId: string,
  { canInvite = true }: { canInvite?: boolean } = {},
): string {
  const me = room.players.find((player) => player.id === playerId) ?? null;
  if (!room.joined || me === null) return '';

  // 판이 도는 동안에는 시작 조건이 아니라 «언제 함께할 수 있는지»를 말한다 (U24). 판에서
  // 빠진 멤버가 이 화면에 남는다 — 판의 참가자는 복구 경로가 판 화면으로 데려간다.
  if (room.status === 'playing') {
    if (room.inMatch) return '진행 중인 판에 내 자리가 있어요. 곧 판 화면으로 이어져요.';
    if (room.isMine) return '지금 진행 중인 판이 끝나면 다음 판을 시작할 수 있어요.';
    return me.isReady
      ? '준비 완료! 지금 진행 중인 판이 끝나면 다음 판에 함께해요.'
      : '지금 진행 중인 판이 끝나면 다음 판에 함께할 수 있어요. 준비는 미리 해 둘 수 있어요.';
  }

  if (!room.isMine) {
    const host = room.players[0];
    if (host && host.id !== playerId && !host.connected) {
      return `방장 ${host.nickname} 님 연결이 끊겼어요. 곧 다음 사람이 방장이 돼요.`;
    }
    return me.isReady
      ? '준비 완료! 방장이 시작하면 바로 출발해요.'
      : '준비 완료를 눌러 주세요. 방장이 시작하면 바로 출발해요.';
  }

  const { counted, waiting, offline } = startRoster(room, playerId);
  if (counted.length < 2) {
    return offline.length > 0
      ? `${who(offline)} 연결이 끊겼어요. 최소 2명이 필요해요.`
      : canInvite
        ? '최소 2명이 필요해요. 초대 링크로 친구를 불러 보세요.'
        : '최소 2명이 필요해요.';
  }
  if (waiting.length > 0) {
    return `준비 ${counted.length - waiting.length}/${counted.length}명 · ${who(waiting)} 기다리는 중`;
  }
  return offline.length > 0
    ? `모두 준비됐어요 · ${who(offline)}은 연결이 끊겨 이번 판에서 빠져요`
    : '모두 준비됐어요. 게임을 시작해 보세요.';
}

/** 「민수 님이」 / 「민수 님, 철수 님이」 / 「민수 님 외 2명이」 */
function subjects(players: readonly PublicPlayer[]): string {
  if (players.length === 2) return `${players[0].nickname} 님, ${players[1].nickname} 님이`;
  return `${who(players)}이`;
}

/**
 * 이전 snapshot과 견줘 대화 로그에 한 줄씩 남길 드문 사건(FR 밖, 온라인 대기실).
 *
 * 입장·퇴장·방장 승계만 알린다. 준비 토글은 잦아서 여기 넣으면 CHAT_LINES 몇 줄짜리
 * 대화가 금방 밀려난다 — 그건 시작 상태 줄이 맡는다. 한 snapshot의 같은 종류 사건은
 * 한 줄로 합친다. `quiet`의 사람은 퇴장을 알리지 않는다 — 내가 방금 내보낸 사람이라
 * 부르는 쪽이 «내보냈어요»로 따로 말한다(같은 일을 두 줄로 쓰지 않는다, U24).
 */
export function waitingRoomChangeNotices(
  previous: PublicRoom,
  next: PublicRoom,
  playerId: string,
  quiet: readonly string[] = [],
): string[] {
  if (previous.code !== next.code) return [];
  const before = new Set(previous.players.map((player) => player.id));
  const after = new Set(next.players.map((player) => player.id));
  const joined = next.players.filter((player) => !before.has(player.id) && player.id !== playerId);
  const left = previous.players.filter((player) => !after.has(player.id)
    && player.id !== playerId
    && !quiet.includes(player.id));

  const notices: string[] = [];
  if (joined.length > 0) notices.push(`${subjects(joined)} 들어왔어요.`);
  if (left.length > 0) notices.push(`${subjects(left)} 나갔어요.`);

  const host = next.players[0];
  if (host && host.id !== previous.players[0]?.id) {
    notices.push(next.isMine
      ? '이제 내가 방장이에요. 설정을 바꾸고 게임을 시작할 수 있어요.'
      : `이제 ${host.nickname} 님이 방장이에요.`);
  }
  return notices;
}

/** 「퀴즈왕1로」 / 「퀴즈왕3으로」. 받침이 ㄹ이거나 없으면 «로»다. */
function withRo(word: string): string {
  const last = word.at(-1) ?? '';
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const final = (code - 0xac00) % 28;
    return `${word}${final === 0 || final === 8 ? '로' : '으로'}`;
  }
  // 숫자는 읽는 소리로 본다: 영·삼·육은 받침이 있다
  if (/[0-9]/.test(last)) return `${word}${'036'.includes(last) ? '으로' : '로'}`;
  return `${word}(으)로`;
}

/**
 * 방이 내 이름을 바꿔 보여 주면 한 번 알린다 (`rules.ts`의 `uniqueNickname`).
 *
 * 이름이 겹치면 서버가 조용히 뒤에 숫자를 붙인다. 알리지 않으면 액자·말풍선의
 * «퀴즈왕2»가 나인지 알 길이 없다.
 */
export function waitingRoomNicknameNotice(roomNickname: string, savedNickname: string): string | null {
  if (!savedNickname || roomNickname === savedNickname) return null;
  return `이 방에서는 ${withRo(roomNickname)} 보여요.`;
}

/**
 * 초대 링크. 부팅 때 `?room=`을 읽어 코드 참가를 채운다(해시 라우팅은 쓰지 않는다).
 *
 * **비밀번호는 절대 싣지 않는다.** 링크는 메신저·기록에 그대로 남는다. 잠긴 방은 받은
 * 사람이 비밀번호를 따로 넣는다 — 인자에 비밀번호 자리가 아예 없다.
 */
export function waitingRoomInviteLink(
  location: { origin: string; pathname: string },
  code: string,
): string {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

/**
 * An awaited action may mutate the waiting-room UI only while the show request
 * and room still belong to it. Snapshot identity also prevents an old REST
 * response from replacing a newer subscription snapshot from the same room.
 */
export function isCurrentWaitingRoomAction(
  action: WaitingRoomActionOwnership,
  state: WaitingRoomActionState,
  requireSameSnapshot = true,
): boolean {
  return state.request === action.request
    && state.room?.code === action.code
    && (!requireSameSnapshot || state.room === action.snapshot);
}
