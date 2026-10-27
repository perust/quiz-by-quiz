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
//   listRooms()            공개·비공개 방 목록(비밀번호 원문 제외)
//   myRooms()              내가 들어가 있는 방
//   createRoom(spec)       {ok, room} | {ok:false, message}
//   joinRoom(spec)         {ok, room} | {ok:false, reason}
//   leaveRoom(spec)
//   removeMember(spec)     다른 참가자 내보내기 (방장만, 확인창을 거친다, U24)
//   getRoom(code)          방 하나
//   updateRoom(spec)       방 설정 (방장만): 분야·인원·문항 시간(20초·40초)
//   sendChat(spec)         한마디
//   startGame(spec)        판 열기 (방장만). 방장 혼자서도 연다 (`minPlayers`)
//   sendStandingAnswer     시간이 끝나면 답이 되는 발밑 칸 초안 (U13, 받는다고 알린 서버에만)
//   onlineRules()          세션을 열 때 서버가 알려 준 규칙(시작 인원·발밑 칸·서버 랭킹). 모르면 null
//   getOnlineRankings(q)   온라인 랭킹 상위 10 (FR-7.13 2단계). 랭킹을 모르는 API·로컬 방은 {supported:false}
//   subscribe(code, fn)    방에서 일어나는 일. 그만 들으려면 되돌려 준 함수를 부른다
//
// 구독으로 오는 이벤트
//   {type: 'room',  room}                     방 설정이 바뀌었다
//   {type: 'chat',  playerId, nickname, text} 누가 한마디 했다
//   {type: 'match', phase: 'started', setup}  판이 열렸다
//   {type: 'removed', kind}                   방장이 나를 내보냈다 (U24, kind는 rules.ts의 RemovalKind)
//   {type: 'standing-delivery', deliverable}  발밑 칸 초안이 서버에 닿을 수 있는지가 바뀌었다 (U13)
//
// **여는 사람이 판을 직접 시작하지 않는다.** `startGame`은 «시작됐다»는 이벤트를
// 보낼 뿐이고 화면은 그 이벤트를 보고 움직인다. 서버 구현에서는 같은 이벤트가 방에
// 있는 모두에게 가므로, 부르는 쪽을 고치지 않고 여럿이 함께 시작하는 판이 된다.
//
// **여럿이 같은 문제를 푸는 판은 서버가 진행한다.** `getMatch`·`submitMatchAnswer`와
// `{type: 'match', phase: 'started' | 'invalidated'}`가 그 자리다. 언제 다음 문항으로 넘길지,
// 점수를 어떻게 합칠지는 서버만 정하고 화면은 인증된 snapshot을 그릴 뿐이다
// (`match-controller.ts`). 그래서 진행 규칙을 `core/`에 두 벌 두지 않는다.
//
// **로컬 구현이 동기여도 모든 메서드는 Promise를 반환한다.** 서버 구현으로
// 바뀔 때 부르는 쪽을 고치지 않기 위해서다.
//
// **비밀번호는 구현체 안에서만 견준다.** 목록에는 잠김 여부만 나가고, 화면은
// 비밀번호가 맞는지 모른 채 넘기기만 한다.

import { safeStorage } from '../storage/safe-storage.js';
import type { CategoryId, OnlineQuestionTime, RankingTarget } from '../types.js';
import { localRooms } from './local-rooms.js';
import type {
  MovementStage,
  MovementViewport,
  WaitingRoomSeatId,
} from './movement-contract.js';
import { createNetworkRoomStore } from './network-rooms.js';
import type { JoinFailReason, RemovalKind, RemoveMemberFailReason } from './rules.js';

/** 방에 서 있는 사람. **밖으로 나가는 모습이라 `seenAt` 같은 속사정은 없다** */
export interface PublicPlayer {
  id: string;
  nickname: string;
  characterId: string;
  /** 이 참가자가 server-authoritative 시작 조건에 준비됐는가 */
  isReady: boolean;
  /**
   * 방에 연결돼 있는가. 소켓이 끊긴 뒤 유예(서버 60초)를 넘기면 false가 된다.
   * false인 참가자는 시작 판정에서 기다리지 않고 판에도 넣지 않는다 — 멤버십과
   * 재입장 유예는 그대로다. 로컬 방은 끊김을 알 길이 없어 언제나 true다.
   */
  connected: boolean;
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
  /** 구버전 client 호환 필드. 캐릭터 전용 게임에서는 언제나 true다. */
  gameMode: true;
  /**
   * 방장이 고른 문항 시간(20초·40초). 판을 열 때 그 판의 모든 문항 마감이 된다. 모두에게 보이고
   * 방장만 바꾼다. 문항 시간을 모르는 이전 서버의 방은 20초였다.
   */
  questionTimeMs: OnlineQuestionTime;
  /**
   * 현재 방장이 첫 자리다. 나가거나 오래 끊기면 가장 먼저 들어온 접속 중인 참가자가 첫 자리로
   * 승계한다(나갈 때 모두 끊겼으면 가장 먼저 들어온 사람이 받고, 누가 다시 붙으면 넘긴다).
   */
  players: PublicPlayer[];
  isPublic: boolean;
  hasPassword: boolean;
  /** 내가 만든 방인가 (방장) */
  isMine: boolean;
  /** 내가 들어가 있는 방인가 */
  joined: boolean;
  createdAt: string;
  /**
   * 판이 도는 중인가 (U33). 서버는 진행 중인 판에 새 참가를 받지 않으므로 목록이 미리
   * 「게임 중」으로 알린다. 서버 권위 판이 없는 로컬 구현은 언제나 `waiting`이다.
   */
  status: RoomStatus;
  /**
   * 그 도는 판에 내 자리가 있는가 (U24). `playing`인데 false면 끊겨서 판에서 빠진 멤버다 —
   * 판이 도는 동안에도 나가거나 다음 판을 준비할 수 있다. 로컬 구현은 언제나 false다.
   */
  inMatch: boolean;
  /**
   * 방장의 시작 요청을 곧 방장의 준비로 보는 저장소인가 (U28). 이 규칙이 생기기 전의 API는
   * 방장도 준비해야 시작을 받는다. 그런 서버를 만나면 화면은 방장의 「게임 시작」 앞에 준비를
   * 먼저 보낸다 — 화면(Pages)이 API보다 먼저 배포돼도 시작이 막히지 않게 하는 호환 장치다.
   * 같은 때 생긴 참가자별 `connected` 필드를 보내면 새 서버다. 로컬 구현은 언제나 true다.
   */
  hostReadyImplicit: boolean;
  /**
   * 판을 여는 데 필요한 세는 사람(방장 + 연결된 참가자)의 수. 지금 API와 로컬 방은 1이다 — 방장
   * 혼자서도 연다. 이 필드를 보내지 않는 이전 API는 둘이었다(`rules.ts`의 `roomMinPlayers`가 2로 읽는다).
   */
  minPlayers?: number;
}

/**
 * 방 snapshot이 아직 없는 화면(홈 입구·빈 로비·「게임 방법」)이 말할 온라인 규칙. 저장소가 처음 세션을
 * 열 때 서버가 함께 알려 준다. 이 필드를 모르는 이전 API는 둘부터·직접 낸 답만 세었다.
 */
export interface OnlineRules {
  /** 판을 여는 데 필요한 세는 사람 수. 1이면 방장 혼자서도 연다 */
  minPlayers: number;
  /** 시간이 끝나면 발밑 칸이 답인가 (U13, 혼자 하기와 같은 규칙) */
  standingAnswers: boolean;
  /**
   * 끝난 판을 서버 랭킹에 남기고 GET /v1/rankings로 보이는가 (FR-7.13 2단계). 세션 응답의 `rankings: true`다.
   * 이 필드가 없는 이전 API면 false — 화면은 온라인 랭킹을 숨긴다
   */
  rankings: boolean;
}

// ── 온라인 랭킹 (FR-7.13 2단계, PRD 12.1) ─────────────────────────
// 서버가 채점한 온라인 판의 결과다. 브라우저가 점수를 보고하지 않는다 — 읽기만 한다.

/** «이번 주»(서울 시각 월요일 0시부터 다음 월요일 0시 전까지)와 «전체» */
export type OnlineRankingPeriod = 'week' | 'all';

export interface OnlineRankingEntry {
  /** 점수 내림차순, 같은 점수는 먼저 남긴 기록이 위 — 순위는 그 순서다(1, 2, 3, 혼자 하기 랭킹과 같다) */
  rank: number;
  nickname: string;
  characterId: string;
  score: number;
  correctCount: number;
  totalCount: number;
  /** 서버가 판을 닫은 시각 (ISO 8601) */
  recordedAt: string;
  /** 이 브라우저의 기록인가. 서버가 인증된 브라우저 신분으로 가린다 — 신분 자체는 오지 않는다 */
  isMine: boolean;
}

export interface OnlineRankingBoard {
  target: RankingTarget;
  period: OnlineRankingPeriod;
  /** «이번 주»의 두 끝 (ISO 8601). «전체»면 null */
  window: { start: string; end: string } | null;
  /** 상위 10까지 */
  entries: OnlineRankingEntry[];
}

/** 랭킹을 모르는 API·로컬 방이면 supported:false. 연결 실패는 던진다 */
export type OnlineRankingResult =
  | { supported: false }
  | { supported: true; board: OnlineRankingBoard };

/** 시간이 끝나면 답으로 세는 발밑 칸 초안 (U13). `choiceIndex`가 null이면 칸에서 내려섰다 */
export interface StandingAnswerDraft {
  matchId: string;
  position: number;
  choiceIndex: number | null;
}

/** 방이 사람을 기다리는지, 판이 도는지 */
export type RoomStatus = 'waiting' | 'playing';

/** 판을 열 때 쓰는 방 설정 */
export interface MatchSetup {
  categoryId: CategoryId | null;
  /** 구버전 client 호환 필드. 캐릭터 전용 게임에서는 언제나 true다. */
  gameMode: true;
}

/** 방에 들어갈 때 알리는 나. 저장소가 이것으로 참가자를 만든다 */
export interface PlayerInfo {
  nickname: string;
  characterId: string;
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
  /** 방장이 고르는 문항 시간. 만들기 폼의 기본은 20초다 */
  questionTimeMs: OnlineQuestionTime;
  isPublic: boolean;
  /** 비공개 방일 때만 본다 */
  password?: string;
  player: PlayerInfo;
}

export interface JoinRoomSpec {
  code: string;
  password?: string;
  player: PlayerInfo;
}

/** 방장만 바꿀 수 있다. 넘긴 것만 바뀐다. 판이 도는 동안에는 서버가 거절한다 */
export interface RoomPatch {
  categoryId?: CategoryId | null;
  capacity?: number;
  questionTimeMs?: OnlineQuestionTime;
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

/** 본인만 바꿀 수 있는 준비 상태. 준비 충족 여부와 시작 권한은 서버가 판정한다. */
export type ReadyResult =
  | { ok: true; room: PublicRoom }
  | { ok: false; reason: 'not-found' | 'not-member' | 'game-in-progress' };

/**
 * 방장의 «내보내기» (U24). 방장만, 남만, 도는 판의 참가자는 판이 끝난 뒤에 — 판정은 구현체가 한다.
 * 화면에서만 막으면 서버 구현에서 그대로 뚫린다.
 */
export type RemoveMemberResult =
  | { ok: true; room: PublicRoom }
  | { ok: false; reason: RemoveMemberFailReason };

export type StartGameResult =
  | { ok: true; setup: MatchSetup }
  | { ok: false; reason: 'not-found' | 'not-host' | 'not-ready' | 'game-in-progress' };

/** 서버가 고른 문항. `answerIndex`와 해설은 **여기에 존재하지 않는다.** */
export interface OnlineMatchQuestion {
  id: string;
  categoryId: CategoryId;
  question: string;
  choices: string[];
  position: number;
  total: number;
}

/** running 중에는 이 acknowledgement만 보인다. 정답·점수는 타입에 없다. */
export interface OnlineOwnSubmission {
  position: number;
  choiceIndex: number | null;
  timedOut: boolean;
}

/** revealing 때만 자기 답의 정오답과 해설을 받는다. */
export interface OnlineReveal extends OnlineOwnSubmission {
  correct: boolean;
  answerIndex: number;
  explanation: string;
}

/** 배열 순서 자체가 서버가 결정한 순위다. client는 재정렬하지 않는다. */
export interface OnlineScore {
  playerId: string;
  nickname: string;
  characterId: string;
  score: number;
  correctCount: number;
  answeredCount: number;
  /**
   * 방금 공개한 문항을 맞혔는가 (U30). **revealing에만 온다** — 아직 답을 고르는 사람에게 남의
   * 정오가 가지 않는다. 구버전 서버는 보내지 않고, 그때 화면은 «정답 n/m명»을 지어내지 않는다.
   */
  lastAnswerCorrect?: boolean;
}

/**
 * 끝난 판의 문항 하나와 내 답 (U38 «문제 다시 보기»). 판이 끝난 뒤 그 판의 참가자에게만 온다 —
 * 공개 단계에서 문항마다 이미 본 것(문제·보기·정답·해설)을 한데 모은 것이다.
 */
export interface OnlineReviewItem {
  position: number;
  id: string;
  categoryId: CategoryId;
  question: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
  /** 내가 고른 보기. 시간 안에 고르지 않았으면 null */
  choiceIndex: number | null;
  correct: boolean;
  timedOut: boolean;
}

interface OnlineMatchBase {
  matchId: string;
  categoryId: CategoryId | null;
  /** 구버전 client 호환 필드. 캐릭터 전용 게임에서는 언제나 true다. */
  gameMode: true;
  currentPosition: number;
  totalQuestions: number;
  /**
   * 이 판의 문항 시간. 판을 열 때 방 설정에서 정해져 판 내내 같다. 남은 시간 막대의 «가득»으로만
   * 쓴다 — 마감 판정은 서버가 한다. 구버전 서버는 보내지 않는다(그때 막대는 처음 받은 남은 시간을 가득으로 본다).
   */
  questionTimeMs?: OnlineQuestionTime;
  /**
   * 시간이 끝나면 발밑 칸이 답인 판인가 (U13, 혼자 하기와 같은 규칙). 그런 판에서만 화면이 실제로 움직인
   * 뒤 선 칸을 초안으로 보내고 규칙을 그렇게 말한다. 이 필드가 없는 이전 API는 직접 낸 답만 센다.
   */
  standingAnswers?: true;
}

/** 진행 중인 phase에만 서버가 활성 마감 시각을 보낸다. */
interface OnlineActiveMatchBase extends OnlineMatchBase {
  deadlineAt: string;
  /**
   * 서버가 응답 시점에 잰 이 phase의 남은 시간(ms). running이면 제출 마감까지,
   * revealing이면 다음 문제(또는 최종 순위)까지다. 기기 시계와 무관하게 남은 시간을
   * **표시만** 하려는 값이고 제출 가능 여부를 닫는 데 쓰지 않는다. 구버전 서버는 보내지 않는다.
   */
  remainingMs?: number;
}

export interface OnlineRunningMatch extends OnlineActiveMatchBase {
  state: 'running';
  question: OnlineMatchQuestion;
  ownSubmission: OnlineOwnSubmission | null;
  reveal: null;
  scores: [];
}

export interface OnlineRevealingMatch extends OnlineActiveMatchBase {
  state: 'revealing';
  question: OnlineMatchQuestion;
  ownSubmission: null;
  reveal: OnlineReveal | null;
  scores: OnlineScore[];
}

export interface OnlineFinishedMatch extends OnlineMatchBase {
  state: 'finished';
  /** 최종 공개가 끝난 terminal state에는 활성 문제 deadline이 없다. */
  deadlineAt: null;
  question: null;
  ownSubmission: null;
  reveal: null;
  scores: OnlineScore[];
  /** 문항 순서대로. 구버전 서버이거나 맞춰 볼 수 없으면 없다 — 그때는 순위만 보인다 */
  review?: OnlineReviewItem[];
  /**
   * 이 판의 내 결과가 온라인 랭킹에 남았는가 (FR-7.13 2단계). 서버가 판을 닫는 transaction에서 남긴다.
   * 이 필드가 없는 이전 API면 없다 — 결과 화면은 랭킹 이야기를 하지 않는다
   */
  rankingRecorded?: boolean;
}

/** API가 준 상태는 이 union 밖으로 넓히지 않는다. */
export type OnlineMatchSnapshot = OnlineRunningMatch | OnlineRevealingMatch | OnlineFinishedMatch;

export interface OnlineMatchAnswerResult {
  match: OnlineMatchSnapshot;
  accepted: true;
  /** 제출 요청이 deadline transition도 함께 commit했는가 */
  advanced: boolean;
}

/**
 * 구독으로 오는 이벤트.
 *
 * `invalidated`에는 상태 자체를 싣지 않는다. 누가 보낸 값이든 신뢰하지 않고,
 * 각 browser가 자신의 authorization으로 match snapshot을 다시 읽는다.
 */
export type RoomEvent =
  | { type: 'room'; room: PublicRoom }
  | { type: 'chat'; playerId: string; nickname: string; text: string; at: number }
  | {
    type: 'movement';
    playerId: string;
    x: number;
    y: number;
    moving: boolean;
    /** 있으면 수신 browser의 같은 논리 좌석에 정렬한다. */
    seatId?: WaitingRoomSeatId;
    /** 구형 event에는 없다. 있으면 송신자의 CSS-pixel 이동량을 복원한다. */
    viewportWidth?: number;
    viewportHeight?: number;
    /**
     * 공유 무대 좌표 (U31). 보낸 사람의 발이 무대(대기실 라운지·온라인 퀴즈 바닥) 안에 있었고 서버가 받는다고
     * 알렸을 때만 셋이 함께 온다. 같은 무대를 보이는 화면은 제 무대의 같은 자리에 세운다.
     */
    stage?: MovementStage['stage'];
    stageX?: number;
    stageY?: number;
    /** server process 안에서 movement마다 증가한다. */
    sequence: number;
    /** 이 browser의 socket generation. reconnect 전의 늦은 event를 가둔다. */
    connectionGeneration: number;
  }
  | { type: 'match'; phase: 'started'; matchId: string | null; setup: MatchSetup }
  | { type: 'match'; phase: 'invalidated'; matchId: string | null }
  /**
   * 방장이 나를 이 방에서 내보냈다 (U24). 열린 소켓으로 곧바로 오거나, 다시 붙으려다 서버가 알려 준다.
   * 대기실은 로비로 돌아가며 그 말을 띄운다. `removed`(끊긴 사이 자리를 비웠다)는 같은 코드로 다시
   * 참가할 수 있고, `kicked`(접속 중에 내보냈다)는 잠시 다시 들어갈 수 없다.
   */
  | { type: 'removed'; kind: RemovalKind }
  /**
   * 이 구독의 소켓으로 발밑 칸 초안(U13)이 서버에 닿을 수 있는지가 바뀌었다. 바뀔 때만 온다.
   * 처음 붙는 동안은 닿는다고 본다 — 저장소가 마지막 초안을 기억했다가 소켓이 열리면 보낸다. 붙지 못했거나
   * 끊겼거나(다시 붙는 중), 열린 소켓의 서버가 받는다고 알리지 않았으면 false이고, 다시 붙어 받는다고 알리면
   * true다. false인 동안 마감이 오면 서버는 그 전에 받은 초안만 안다(없으면 시간 초과) — 온라인 퀴즈의 상태
   * 줄이 그렇게 말한다. 로컬 방은 초안을 보내지 않아 이 이벤트도 없다.
   */
  | { type: 'standing-delivery'; deliverable: boolean };

export type RoomEventHandler = (event: RoomEvent) => void;

/** 구독을 그만두는 함수 */
export type Unsubscribe = () => void;

/**
 * 방 저장소가 지켜야 할 계약.
 *
 * **로컬 action도 Promise를 반환한다** — 서버 구현체가 이 타입을 달기만 하면
 * 부르는 쪽을 고치지 않고 갈아끼울 수 있다. 프레임에서 부르는 `sendMovement`만
 * WebSocket best-effort라 즉시 전송 여부를 반환한다.
 */
export interface RoomStore {
  /** 진짜 네트워크인가. 화면이 안내 문구를 정할 때 쓴다 */
  readonly isNetworked: boolean;
  /** 만든 방이 새로고침 뒤에도 남는가 */
  readonly isPersistent: boolean;
  /** 지금 나를 가리키는 값. **새로고침해도 그대로여야 한다** */
  me(): string;
  /** 모든 network 요청 전에 사용할 현재 닉네임·캐릭터를 고정한다. */
  setPlayer(player: PlayerInfo): void;
  /** 공개·비공개 방 목록. 비밀번호 원문은 PublicRoom에 존재하지 않는다 */
  listRooms(): Promise<PublicRoom[]>;
  /** 내가 들어가 있는 방 */
  myRooms(): Promise<PublicRoom[]>;
  createRoom(spec: CreateRoomSpec): Promise<CreateRoomResult>;
  joinRoom(spec: JoinRoomSpec): Promise<JoinRoomResult>;
  leaveRoom(spec: { code: string }): Promise<{ ok: true }>;
  /**
   * 방장이 다른 참가자를 내보낸다 (U24). `connected`는 방장이 확인창에서 본 그 사람의 상태다.
   * - 없거나 false: 끊긴 자리를 비운다. 그 사이 다시 붙었으면 `member-connected`로 거절하고, 내보내진
   *   사람은 같은 코드로 다시 참가할 수 있다
   * - true: 접속 중인 사람을 내보낸다. 그 사람의 화면은 로비로 돌아가고 잠시 그 방에 다시 들어갈 수 없다
   * 로컬 방은 모두 `connected: true`이고 이 브라우저의 나뿐이라 다시 들어오는 것을 막을 상대가 없다.
   */
  removeMember(spec: { code: string; playerId: string; connected?: boolean }): Promise<RemoveMemberResult>;
  /**
   * 방 하나. 없으면 null. **방장이 나를 내보냈으면 `RemovedFromRoom`(내보낸 방식 `kind`)을 던진다** —
   * «없는 방»과 다른 말을 해야 한다 (U24)
   */
  getRoom(code: string): Promise<PublicRoom | null>;
  updateRoom(spec: { code: string; patch: RoomPatch }): Promise<RoomActionResult>;
  /** browser는 자신의 준비 여부만 요청하고, server가 돌려준 방 snapshot을 따른다 */
  setReady(spec: { code: string; isReady: boolean }): Promise<ReadyResult>;
  sendChat(spec: { code: string; text: string; player?: PlayerInfo }): Promise<{ ok: boolean }>;
  /**
   * 0~1 좌표와 송신 viewport. player identity는 socket ticket에서 정한다. 공유 무대 좌표(U31)는 셋이 함께일
   * 때만 받고, 서버가 받는다고 알린 소켓에만 싣는다 — 모르는 서버(#106)에는 예전 모양 그대로 보낸다.
   */
  sendMovement(spec: {
    code: string;
    x: number;
    y: number;
    moving: boolean;
    seatId?: WaitingRoomSeatId;
    /**
     * 무대가 움직였을 뿐이다(스크롤, U31). 이 소켓에 실을 줄이 지난번에 보낸 줄과 같으면 보내지 않는다 —
     * 무대 좌표를 싣지 않는 서버(#106)에 같은 이동을 되풀이하지 않는다. 기억해 둔 마지막 이동은 고친다.
     */
    onlyIfChanged?: true;
  } & MovementViewport & Partial<MovementStage>): boolean;
  /**
   * 발밑 칸 초안 (U13). `sendMovement`처럼 방 소켓으로 보내는 best-effort이고, 그 소켓의 서버가 받는다고
   * 알렸을 때만(ws-ticket의 capability) 보낸다 — 모르는 서버에는 한 글자도 보내지 않는다. 소켓이 닫혀 있으면
   * 기억했다가 다시 열릴 때 보낸다. 지금 닿을 수 있는지는 구독의 `standing-delivery` 이벤트가 알린다. 로컬 방은
   * 서버 권위 판이 없어 보내지 않는다(false).
   */
  sendStandingAnswer(spec: { code: string } & StandingAnswerDraft): boolean;
  /** 처음 세션을 열 때 서버가 알려 준 온라인 규칙. 아직 묻지 않았으면 null. 로컬 방은 늘 같은 값이다 */
  onlineRules(): OnlineRules | null;
  /**
   * 온라인 랭킹 상위 10 (FR-7.13 2단계). 세션을 열어(규칙을 알아) 이 API가 랭킹을 아는지 본 뒤에 읽는다 —
   * 모르는 API에는 랭킹 요청을 보내지 않고 {supported:false}다. 로컬 방도 서버 랭킹이 없어 늘 그렇다.
   * 읽기만 하고, 브라우저 신분을 실어 보내 내 기록(isMine)을 서버가 가린다
   */
  getOnlineRankings(query: { target: RankingTarget; period: OnlineRankingPeriod }): Promise<OnlineRankingResult>;
  /** 판을 연다. 여는 사람이 직접 시작하지 않고 «시작됐다»는 이벤트를 보낸다 */
  startGame(spec: { code: string }): Promise<StartGameResult>;
  /** 활성 또는 방금 끝난 server-authoritative match. 없으면 null */
  getMatch(code: string): Promise<OnlineMatchSnapshot | null>;
  /** browser는 position과 choice index만 보낸다. 채점·점수는 server snapshot을 따른다 */
  submitMatchAnswer(spec: {
    code: string;
    position: number;
    choiceIndex: number;
  }): Promise<OnlineMatchAnswerResult>;
  subscribe(code: string, handler: RoomEventHandler): Unsubscribe;
}

function configuredApiBase(): string | null {
  if (typeof document === 'undefined') return null;
  const value = document.querySelector<HTMLMetaElement>('meta[name="quiz-api-base"]')?.content.trim();
  return value || null;
}

const apiBase = configuredApiBase();

/**
 * 배포본에는 `quiz-api-base`가 있어 원격 저장소만 쓴다. 연결 실패를 로컬방으로
 * 숨기면 같은 이름의 서로 다른 방이 생기므로 조용한 fallback은 두지 않는다.
 * 메타가 없는 단위 테스트·독립 개발 문서에서만 로컬 구현을 유지한다.
 */
export const roomStore: RoomStore = apiBase
  ? createNetworkRoomStore({ baseUrl: apiBase, storage: safeStorage })
  : localRooms;
