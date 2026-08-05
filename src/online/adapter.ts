// 방 저장소 어댑터
//
// **교체 지점은 아래 한 줄이다.** 랭킹 저장소(`storage/adapter.ts`)와 같은 방식으로,
// 서버가 생기면 `serverRooms`를 만들어 여기만 바꾼다. 화면(`ui/online.ts`)은
// 인터페이스만 알고 구현을 모르므로 그대로 돈다.
//
// 인터페이스
//   isNetworked            진짜 네트워크인가 (화면이 안내 문구를 정할 때 쓴다)
//   isPersistent           만든 방이 새로고침 뒤에도 남는가 (같은 이유로 쓴다)
//   me()                   지금 나를 가리키는 값
//   listRooms()            공개방 목록
//   myRooms()              내가 들어가 있는 방
//   createRoom(spec)       {ok, room} | {ok:false, message}
//   joinRoom(spec)         {ok, room} | {ok:false, reason}
//   leaveRoom(spec)
//   getRoom(code)          방 하나
//   updateRoom(spec)       방 설정 (방장만)
//   sendChat(spec)         한마디
//   startGame(spec)        판 열기 (방장만)
//   subscribe(code, fn)    방에서 일어나는 일. 그만 들으려면 되돌려 준 함수를 부른다
//
// 구독으로 오는 이벤트
//   {type: 'room',  room}                     방 설정이 바뀌었다
//   {type: 'chat',  playerId, nickname, text} 누가 한마디 했다
//   {type: 'match', phase: 'started', setup}  판이 열렸다
//
// **여는 사람이 판을 직접 시작하지 않는다.** `startGame`은 «시작됐다»는 이벤트를
// 보낼 뿐이고 화면은 그 이벤트를 보고 움직인다. 서버 구현에서는 같은 이벤트가 방에
// 있는 모두에게 가므로, 부르는 쪽을 고치지 않고 여럿이 함께 시작하는 판이 된다.
//
// **아직 없는 자리 — 여럿이 같은 문제를 푸는 판.**
// 여기에 `submitAnswer(spec)`와 `{type: 'match', phase: 'question' | 'reveal' | 'over'}`
// 가 들어간다. 진행 규칙(언제 다음 문항으로 넘길지, 점수를 어떻게 합칠지)은 그때
// `core/`에 순수 함수로 둔다 — 서버와 화면이 같은 규칙을 써야 하기 때문이다.
// **지금 미리 짓지 않는다.** 쓸 화면이 없으면 맞는지 확인할 길도 없다.
//
// **로컬 구현이 동기여도 모든 메서드는 Promise를 반환한다.** 서버 구현으로
// 바뀔 때 부르는 쪽을 고치지 않기 위해서다.
//
// **비밀번호는 구현체 안에서만 견준다.** 목록에는 잠김 여부만 나가고, 화면은
// 비밀번호가 맞는지 모른 채 넘기기만 한다.

import { localRooms } from './local-rooms.js';
import type { JoinFailReason } from './rules.js';
import type { CategoryId } from '../types.js';

/** 방에 서 있는 사람. **밖으로 나가는 모습이라 `seenAt` 같은 속사정은 없다** */
export interface PublicPlayer {
  id: string;
  nickname: string;
  characterId?: string;
}

/**
 * 밖으로 나가는 방의 모습.
 *
 * **비밀번호 자리가 아예 없다.** 잠겨 있는지(`hasPassword`)만 알린다 — 타입에
 * 없으면 실수로 실어 보낼 수도 없다. 서버 구현으로 바뀌어도 이 약속은 그대로다.
 */
export interface PublicRoom {
  code: string;
  name: string;
  categoryId: CategoryId | null;
  capacity: number;
  gameMode: boolean;
  players: PublicPlayer[];
  isPublic: boolean;
  hasPassword: boolean;
  /** 내가 만든 방인가 (방장) */
  isMine: boolean;
  /** 내가 들어가 있는 방인가 */
  joined: boolean;
  createdAt: string;
}

/** 판을 열 때 쓰는 방 설정 */
export interface MatchSetup {
  categoryId: CategoryId | null;
  gameMode: boolean;
}

/** 방에 들어갈 때 알리는 나. 저장소가 이것으로 참가자를 만든다 */
export interface PlayerInfo {
  nickname: string;
  characterId?: string;
}

/**
 * 방을 만들 때 넘기는 것.
 *
 * **폼이 주는 글자를 값으로 바꾸는 것은 화면의 일이다** (`ui/online.ts`). 저장소에
 * `'4'`나 `''`를 넘기면 서버 구현이 그 변환까지 떠안는다. 그래서 타입이 요구하는
 * 것은 이미 다듬어진 값이다.
 *
 * **그래도 구현체는 `Number()`와 «고를 수 있는 인원인가»를 한 번 더 본다.**
 * 그건 변환이 아니라 **검사**라서 여기 남아야 한다 — 비밀번호를 화면에서 견주지
 * 않는 것과 같은 이유로, 서버가 붙으면 그 검사가 자연히 서버에서 일어난다.
 * 화면에서만 검사하면 서버가 다른 기준으로 거절해 말이 어긋난다.
 */
export interface CreateRoomSpec {
  name: string;
  /** 「전체 도전」이면 null */
  categoryId: CategoryId | null;
  capacity: number;
  isPublic: boolean;
  /** 비공개 방일 때만 본다 */
  password?: string;
  player?: PlayerInfo;
}

export interface JoinRoomSpec {
  code: string;
  password?: string;
  player?: PlayerInfo;
}

/** 방장만 바꿀 수 있다. 넘긴 것만 바뀐다 */
export interface RoomPatch {
  categoryId?: CategoryId | null;
  gameMode?: boolean;
  capacity?: number;
}

export type CreateRoomResult =
  | { ok: true; room: PublicRoom }
  | { ok: false; message: string };

export type JoinRoomResult =
  | { ok: true; room: PublicRoom }
  | { ok: false; reason: JoinFailReason };

/** 방장이 아니면 `not-host`. **이 판정은 화면이 아니라 구현체가 한다** */
export type RoomActionResult =
  | { ok: true; room: PublicRoom }
  | { ok: false; reason: 'not-found' | 'not-host' };

export type StartGameResult =
  | { ok: true; setup: MatchSetup }
  | { ok: false; reason: 'not-found' | 'not-host' };

/**
 * 구독으로 오는 이벤트.
 *
 * `match`의 phase는 지금 `'started'` 하나뿐이다. 여럿이 같은 문제를 푸는 판이
 * 생기면 `'question' | 'reveal' | 'over'`가 여기 붙는다 — **지금 미리 짓지 않는다.**
 */
export type RoomEvent =
  | { type: 'room'; room: PublicRoom }
  | { type: 'chat'; playerId: string; nickname: string; text: string; at: number }
  | { type: 'match'; phase: 'started'; setup: MatchSetup };

export type RoomEventHandler = (event: RoomEvent) => void;

/** 구독을 그만두는 함수 */
export type Unsubscribe = () => void;

/**
 * 방 저장소가 지켜야 할 계약.
 *
 * **로컬 구현이 동기여도 모든 메서드가 Promise를 반환한다** — 서버 구현체가
 * 이 타입을 달기만 하면 부르는 쪽을 고치지 않고 갈아끼울 수 있다.
 */
export interface RoomStore {
  /** 진짜 네트워크인가. 화면이 안내 문구를 정할 때 쓴다 */
  readonly isNetworked: boolean;
  /** 만든 방이 새로고침 뒤에도 남는가 */
  readonly isPersistent: boolean;
  /** 지금 나를 가리키는 값. **새로고침해도 그대로여야 한다** */
  me(): string;
  /** 공개방 목록 */
  listRooms(): Promise<PublicRoom[]>;
  /** 내가 들어가 있는 방 */
  myRooms(): Promise<PublicRoom[]>;
  createRoom(spec: CreateRoomSpec): Promise<CreateRoomResult>;
  joinRoom(spec: JoinRoomSpec): Promise<JoinRoomResult>;
  leaveRoom(spec: { code: string }): Promise<{ ok: true }>;
  /** 방 하나. 없으면 null */
  getRoom(code: string): Promise<PublicRoom | null>;
  updateRoom(spec: { code: string; patch: RoomPatch }): Promise<RoomActionResult>;
  sendChat(spec: { code: string; text: string; player?: PlayerInfo }): Promise<{ ok: boolean }>;
  /** 판을 연다. 여는 사람이 직접 시작하지 않고 «시작됐다»는 이벤트를 보낸다 */
  startGame(spec: { code: string }): Promise<StartGameResult>;
  subscribe(code: string, handler: RoomEventHandler): Unsubscribe;
}

export const roomStore: RoomStore = localRooms;
