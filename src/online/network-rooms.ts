import { CATEGORIES, ROOM_CAPACITY_CHOICES, TIME_LIMIT_MS } from '../constants.js';
import { DEFAULT_CHARACTER_ID } from '../characters.js';
import type { KeyValueStorage } from '../storage/safe-storage.js';
import type { CategoryId, RankingTarget } from '../types.js';
import type {
  CreateRoomResult,
  CreateRoomSpec,
  JoinRoomResult,
  JoinRoomSpec,
  MatchSetup,
  OnlineFinishedMatch,
  OnlineMatchAnswerResult,
  OnlineMatchQuestion,
  OnlineMatchSnapshot,
  OnlineOwnSubmission,
  OnlineRankingBoard,
  OnlineRankingEntry,
  OnlineRankingPeriod,
  OnlineRankingResult,
  OnlineRules,
  OnlineReveal,
  OnlineRevealingMatch,
  OnlineReviewItem,
  OnlineRunningMatch,
  OnlineScore,
  PlayerInfo,
  PublicPlayer,
  PublicRoom,
  RemoveMemberResult,
  RoomActionResult,
  RoomEvent,
  RoomEventHandler,
  RoomPatch,
  RoomStore,
  ReadyResult,
  StandingAnswerDraft,
  StartGameResult,
  Unsubscribe,
} from './adapter.js';
import {
  isMovementStageId,
  isWaitingRoomSeatId,
  MAX_STANDING_ANSWER_POSITION,
  MOVEMENT_STAGE_CAPABILITY,
  MOVEMENT_VIEWPORT_CAPABILITY,
  type MovementStage,
  type MovementViewport,
  STANDING_ANSWER_CAPABILITY,
  type WaitingRoomSeatId,
  validMovementStageUnit,
  validMovementViewportDimension,
  WAITING_ROOM_SEAT_CAPABILITY,
} from './movement-contract.js';
import { nicknameProblem } from './nickname-rules.js';
import {
  ApiFailure,
  isOnlineQuestionTime,
  LEGACY_MIN_PLAYERS,
  LeaveRoomRejected,
  NICKNAME_REJECTION_MESSAGES,
  NicknameRejected,
  nicknameRejection,
  normalizeCode,
  OnlinePlayerError,
  parseRetryAfterMs,
  rateLimitRetryDelayMs,
  removalKind,
  RemovedFromRoom,
  type JoinFailReason,
  type RemovalKind,
  type RemoveMemberFailReason,
} from './rules.js';

const IDENTITY_KEY = 'quiz.online.identity.v1';
const CATEGORIES_SET = new Set<string>(CATEGORIES.map(({ id }) => id));
const JOIN_FAILURES = new Set<JoinFailReason>([
  'not-found',
  'wrong-password',
  'need-password',
  'full',
  'save-failed',
  // 409·429. 연결 실패로 던지면 화면이 «네트워크를 확인하라»고 잘못 말한다 (U33)
  'game-in-progress',
  'rate-limited',
  // 403. 접속 중에 방장이 내보내 잠시 다시 들어갈 수 없다
  'kicked',
]);
/** 내보내기 거절 가운데 화면이 이유를 말할 것. 그 밖(요청 한도 등)은 오류로 던진다 */
const REMOVE_MEMBER_FAILURES = new Set<RemoveMemberFailReason>([
  'not-found',
  'not-host',
  'not-member',
  'member-connected',
  'game-in-progress',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CODE_PATTERN = /^[A-Z0-9]{6}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const RECONNECT_DELAY_MS = 1_000;
const WEBSOCKET_PROTOCOL = 'qbb.v1';
const WEBSOCKET_TICKET_PREFIX = 'qbb.ticket.';
/** 서버 프로세스의 판 번호 묶음 이름. 다시 띄우면 바뀐다 — 다른 묶음의 번호끼리는 견주지 않는다 */
const ROOM_EPOCH_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 방 snapshot의 판 번호 (room-invalidated 줄이기). 서버는 방이 바뀔 때마다 프로세스 전체에서 하나씩 오르는
 * 번호를 붙여 알리고, snapshot에는 DB를 읽기 **전에** 읽은 번호를 붙인다 — 그래서 번호 v가 붙은 snapshot은
 * v까지 알린 변화를 모두 담는다. 번호를 모르는 이전 API(#106)는 보내지 않고, 그때는 예전처럼 늘 다시 읽는다.
 */
interface RoomStamp {
  epoch: string;
  version: number;
}

/** 준비 토글 하나 (가장 잦은 방 변화). 받은 쪽의 방이 정확히 `previousVersion` 뒤의 것이면 GET 없이 고친다 */
interface ReadyChange {
  previousVersion: number;
  playerId: string;
  isReady: boolean;
}

function parseRoomStamp(value: unknown): RoomStamp | null {
  if (!isObject(value)) return null;
  const { roomEpoch, roomVersion } = value;
  if (typeof roomEpoch !== 'string' || !ROOM_EPOCH_PATTERN.test(roomEpoch)) return null;
  if (!Number.isSafeInteger(roomVersion) || (roomVersion as number) < 0) return null;
  // 바로 위에서 0 이상의 안전한 정수인 것을 확인했다
  return { epoch: roomEpoch, version: roomVersion as number };
}

/** 깨졌거나 모르는 모양이면 null — 그때는 고치지 않고 다시 읽는다 */
function parseReadyChange(value: unknown, version: number): ReadyChange | null {
  if (!isObject(value)) return null;
  const { previousVersion, playerId, isReady } = value;
  if (
    !Number.isSafeInteger(previousVersion)
    || (previousVersion as number) < 0
    || (previousVersion as number) >= version
    || typeof playerId !== 'string'
    || !UUID_PATTERN.test(playerId)
    || typeof isReady !== 'boolean'
  ) return null;
  // 바로 위에서 version보다 작은 0 이상의 안전한 정수인 것을 확인했다
  return { previousVersion: previousVersion as number, playerId, isReady };
}

interface BrowserIdentity {
  id: string;
  secret: string;
}

interface WebSocketLike {
  readonly url?: string;
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(value: string): void;
  close(): void;
}

interface MovementChannel {
  socket: WebSocketLike | null;
  supportsViewport: boolean;
  supportsSeat: boolean;
  /** 이 소켓의 서버가 공유 무대 좌표(U31)를 받는다고 알렸는가. 소켓마다 다시 묻는다 */
  supportsStage: boolean;
  /** 이 소켓에 마지막으로 실은 이동 줄. 무대만 움직인 이동(`onlyIfChanged`)이 같은 줄을 되풀이하지 않게 한다 */
  lastSentMovement: string | null;
  /** 이 소켓의 서버가 발밑 칸 초안을 받는다고 알렸는가 (U13). 소켓마다 다시 묻는다 */
  supportsStandingAnswer: boolean;
  /** 마지막으로 보낸(보내려던) 초안. 소켓이 다시 붙으면 다시 보낸다 — 지우기(null)도 */
  latestStanding: StandingAnswerDraft | null;
  latest: ({
    type: 'movement';
    x: number;
    y: number;
    moving: boolean;
    seatId?: WaitingRoomSeatId;
  } & MovementViewport & Partial<MovementStage>) | null;
}

export interface NetworkRoomStoreOptions {
  baseUrl: string;
  storage: KeyValueStorage;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocketLike;
  newIdentity?: () => BrowserIdentity;
  /** 요청 한도(429)에 걸린 방 재조회를 다시 보내기 전의 기다림과 jitter (N01). 테스트가 가짜 시계를 넣는다 */
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

/** 서버가 이유를 말하지 않았거나(5xx·형식 밖 응답) 그 말이 개발 용어일 때 플레이어가 보는 말 (U40) */
const SERVICE_TROUBLE_MESSAGE = '온라인 연결이 잠시 원활하지 않아요. 잠시 후 다시 시도해 주세요.';
/** 요청이 REQUEST_TIMEOUT_MS 안에 끝나지 않았을 때 (U40) */
const TIMEOUT_MESSAGE = '응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configuredBaseUrl(raw: string): string {
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('온라인 API 주소는 HTTPS여야 합니다.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('온라인 API 주소에는 인증 정보나 쿼리를 넣을 수 없습니다.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function validIdentity(value: unknown): value is BrowserIdentity {
  return isObject(value)
    && typeof value.id === 'string'
    && UUID_PATTERN.test(value.id)
    && typeof value.secret === 'string'
    && value.secret.length >= 32
    && value.secret.length <= 256
    && /^[A-Za-z0-9_-]+$/.test(value.secret);
}

function randomIdentity(): BrowserIdentity {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('안전한 브라우저 난수 기능을 사용할 수 없습니다.');
  }

  let id: string;
  if (cryptoApi.randomUUID) {
    id = cryptoApi.randomUUID();
  } else {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const random = cryptoApi.getRandomValues(new Uint8Array(43));
  const secret = [...random].map((value) => alphabet[value & 63]).join('');
  return { id, secret };
}

function readIdentity(
  storage: KeyValueStorage,
  create: () => BrowserIdentity,
): BrowserIdentity {
  try {
    const raw = storage.getItem(IDENTITY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (validIdentity(parsed)) return parsed;
  } catch {
    // 손상됐거나 읽기를 막은 저장소면 이번 세션의 새 식별자로 계속한다.
  }

  const identity = create();
  if (!validIdentity(identity)) throw new Error('온라인 식별자 생성기가 잘못된 값을 돌려줬습니다.');
  try {
    storage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // 서버 방은 유지되지만 새로고침 뒤 재입장 식별자는 바뀔 수 있다.
  }
  return identity;
}

function parsePlayer(value: unknown): PublicPlayer {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error('서버 참가자 응답이 올바르지 않습니다.');
  }
  if (typeof value.nickname !== 'string' || !value.nickname.trim()) {
    throw new Error('서버 참가자 이름이 올바르지 않습니다.');
  }
  const characterId = value.characterId;
  if (typeof characterId !== 'string' || !CHARACTER_ID_PATTERN.test(characterId)) {
    throw new Error('서버 참가자 캐릭터가 올바르지 않습니다.');
  }
  if (typeof value.isReady !== 'boolean') {
    throw new Error('서버 참가자 준비 상태가 올바르지 않습니다.');
  }
  // 접속 상태를 모르는 이전 서버는 이 필드를 보내지 않는다. 그때는 끊김을 단정하지 않는다.
  const connected = value.connected ?? true;
  if (typeof connected !== 'boolean') {
    throw new Error('서버 참가자 접속 상태가 올바르지 않습니다.');
  }
  return {
    id: value.id,
    nickname: value.nickname,
    characterId,
    isReady: value.isReady,
    connected,
  };
}

function parseRoom(value: unknown): PublicRoom {
  if (!isObject(value)) throw new Error('서버 방 응답이 올바르지 않습니다.');
  for (const forbidden of ['password', 'passwordHash', 'password_hash']) {
    if (Object.hasOwn(value, forbidden)) {
      throw new Error('서버 방 응답에 비밀번호 필드가 포함됐습니다.');
    }
  }

  const categoryId = value.categoryId;
  const capacity = value.capacity;
  const players = value.players;
  if (typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) {
    throw new Error('서버 방 코드가 올바르지 않습니다.');
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 16) {
    throw new Error('서버 방 이름이 올바르지 않습니다.');
  }
  if (categoryId !== null && (typeof categoryId !== 'string' || !CATEGORIES_SET.has(categoryId))) {
    throw new Error('서버 게임 형식이 올바르지 않습니다.');
  }
  if (typeof capacity !== 'number' || !ROOM_CAPACITY_CHOICES.includes(capacity)) {
    throw new Error('서버 방 정원이 올바르지 않습니다.');
  }
  if (!Array.isArray(players) || players.length > capacity) {
    throw new Error('서버 참가 인원이 올바르지 않습니다.');
  }
  if (
    typeof value.isPublic !== 'boolean'
    || typeof value.hasPassword !== 'boolean'
    || typeof value.isMine !== 'boolean'
    || typeof value.joined !== 'boolean'
  ) {
    throw new Error('서버 방 상태가 올바르지 않습니다.');
  }
  if (value.gameMode !== true) {
    throw new Error('서버 방이 캐릭터 전용이 아닙니다.');
  }
  if (value.isPublic === value.hasPassword || (value.isMine && !value.joined)) {
    throw new Error('서버 방 공개 상태가 서로 맞지 않습니다.');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('서버 방 생성 시각이 올바르지 않습니다.');
  }
  // status 를 모르는 이전 API로 되돌려도 목록이 깨지지 않게, 없으면 기다리는 방으로 본다.
  // 있는데 모르는 값이면 다른 계약이므로 믿지 않는다.
  const status = value.status ?? 'waiting';
  if (status !== 'waiting' && status !== 'playing') {
    throw new Error('서버 방 진행 상태가 올바르지 않습니다.');
  }
  // 판의 자리를 모르는 이전 API는 이 필드를 보내지 않는다. 그때는 판에 없는 것으로 본다.
  const inMatch = value.inMatch ?? false;
  if (typeof inMatch !== 'boolean') {
    throw new Error('서버 방 진행 상태가 올바르지 않습니다.');
  }
  // 문항 시간을 모르는 이전 API의 방은 모두 20초였다. 있는데 20초·40초가 아니면 다른 계약이다 —
  // null(로컬 설정의 «제한 없음»)도 20초로 바꿔 읽지 않는다.
  const questionTimeMs = value.questionTimeMs === undefined ? TIME_LIMIT_MS : value.questionTimeMs;
  if (!isOnlineQuestionTime(questionTimeMs)) {
    throw new Error('서버 방 문항 시간이 올바르지 않습니다.');
  }
  // 방장 자동 준비(U28)와 접속 상태(U24)는 같은 API에서 함께 생겼다. 참가자마다 `connected`를
  // 보내지 않는 이전 API는 방장의 준비도 요구하므로, 화면이 시작 앞에 준비를 먼저 보낸다.
  const hostReadyImplicit = players.every((player) => isObject(player) && Object.hasOwn(player, 'connected'));
  // 판을 여는 인원 (방장 혼자서도 연다). 이 필드를 모르는 이전 API는 둘부터였다. 있는데 정원 밖이면
  // 다른 계약이라 믿지 않는다
  const minPlayers = value.minPlayers === undefined ? LEGACY_MIN_PLAYERS : value.minPlayers;
  if (!Number.isInteger(minPlayers) || (minPlayers as number) < 1 || (minPlayers as number) > capacity) {
    throw new Error('서버 방 시작 인원이 올바르지 않습니다.');
  }

  return {
    code: value.code,
    name: value.name,
    categoryId: categoryId as CategoryId | null,
    capacity,
    gameMode: true,
    questionTimeMs,
    players: players.map(parsePlayer),
    isPublic: value.isPublic,
    hasPassword: value.hasPassword,
    isMine: value.isMine,
    joined: value.joined,
    createdAt: value.createdAt,
    status,
    inMatch,
    hostReadyImplicit,
    // 바로 위에서 정수인 것을 확인했다
    minPlayers: minPlayers as number,
  };
}

function parseRooms(value: unknown): PublicRoom[] {
  if (!Array.isArray(value)) throw new Error('서버 방 목록이 올바르지 않습니다.');
  return value.map(parseRoom);
}

function parseMatchSetup(value: unknown): MatchSetup {
  if (!isObject(value)) throw new Error('서버 게임 시작 응답이 올바르지 않습니다.');
  if (
    value.categoryId !== null
    && (typeof value.categoryId !== 'string' || !CATEGORIES_SET.has(value.categoryId))
  ) {
    throw new Error('서버 게임 형식이 올바르지 않습니다.');
  }
  if (value.gameMode !== true) {
    throw new Error('서버 게임이 캐릭터 전용이 아닙니다.');
  }
  return { categoryId: value.categoryId as CategoryId | null, gameMode: true };
}

function parseCategoryId(value: unknown, label: string): CategoryId | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !CATEGORIES_SET.has(value)) {
    throw new Error(`서버 ${label}이(가) 올바르지 않습니다.`);
  }
  return value as CategoryId;
}

function parseInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`서버 ${label}이(가) 올바르지 않습니다.`);
  }
  return value as number;
}

function parseMatchQuestion(value: unknown, totalQuestions: number): OnlineMatchQuestion {
  if (!isObject(value)) throw new Error('서버 문제 snapshot이 올바르지 않습니다.');
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error('서버 문제 ID가 올바르지 않습니다.');
  }
  const categoryId = parseCategoryId(value.categoryId, '문제 분야');
  if (categoryId === null || typeof value.question !== 'string' || !value.question.trim()) {
    throw new Error('서버 문제가 올바르지 않습니다.');
  }
  if (
    !Array.isArray(value.choices)
    || value.choices.length !== 4
    || value.choices.some((choice) => typeof choice !== 'string' || !choice.trim())
  ) {
    throw new Error('서버 문제 보기가 올바르지 않습니다.');
  }
  const position = parseInteger(value.position, '문제 순서', 1);
  const total = parseInteger(value.total, '문제 수', 1);
  if (total !== totalQuestions || position > total) {
    throw new Error('서버 문제 진행 상태가 올바르지 않습니다.');
  }
  return {
    id: value.id,
    categoryId,
    question: value.question,
    choices: [...value.choices] as string[],
    position,
    total,
  };
}

function parseOwnSubmission(value: unknown): OnlineOwnSubmission | null {
  if (value === null) return null;
  if (!isObject(value)) throw new Error('서버 제출 acknowledgement가 올바르지 않습니다.');
  const position = parseInteger(value.position, '제출 문제 순서', 1);
  const choiceIndex = value.choiceIndex;
  if (
    choiceIndex !== null
    && (typeof choiceIndex !== 'number' || !Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3)
  ) {
    throw new Error('서버 제출 보기가 올바르지 않습니다.');
  }
  if (typeof value.timedOut !== 'boolean') {
    throw new Error('서버 제출 시간 상태가 올바르지 않습니다.');
  }
  return { position, choiceIndex: choiceIndex as number | null, timedOut: value.timedOut };
}

function parseReveal(value: unknown): OnlineReveal | null {
  if (value === null) return null;
  const submission = parseOwnSubmission(value);
  if (submission === null || !isObject(value)) throw new Error('서버 공개 결과가 올바르지 않습니다.');
  if (typeof value.correct !== 'boolean') throw new Error('서버 정오답 결과가 올바르지 않습니다.');
  const answerIndex = parseInteger(value.answerIndex, '정답 보기');
  if (answerIndex > 3 || typeof value.explanation !== 'string' || !value.explanation.trim()) {
    throw new Error('서버 정답 공개가 올바르지 않습니다.');
  }
  return { ...submission, correct: value.correct, answerIndex, explanation: value.explanation };
}

/**
 * `revealing`일 때만 참가자별 «방금 문항을 맞혔나»(`lastAnswerCorrect`, U30)를 받는다. 다른 phase에
 * 섞여 와도 싣지 않는다. 표시용 값이라 깨졌으면 빼고(그 판은 «정답 n/m명»을 그리지 않는다) 점수판
 * 전체를 거절하지는 않는다.
 */
function parseScores(value: unknown, { revealing = false }: { revealing?: boolean } = {}): OnlineScore[] {
  if (!Array.isArray(value)) throw new Error('서버 점수판이 올바르지 않습니다.');
  return value.map((row) => {
    if (!isObject(row)) throw new Error('서버 점수 행이 올바르지 않습니다.');
    const playerId = row.playerId;
    if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId) || typeof row.nickname !== 'string' || !row.nickname.trim()) {
      throw new Error('서버 점수 참가자가 올바르지 않습니다.');
    }
    if (typeof row.characterId !== 'string' || !CHARACTER_ID_PATTERN.test(row.characterId)) {
      throw new Error('서버 점수 캐릭터가 올바르지 않습니다.');
    }
    const score: OnlineScore = {
      playerId,
      nickname: row.nickname,
      characterId: row.characterId,
      score: parseInteger(row.score, '점수'),
      correctCount: parseInteger(row.correctCount, '정답 수'),
      answeredCount: parseInteger(row.answeredCount, '제출 수'),
    };
    if (revealing && typeof row.lastAnswerCorrect === 'boolean') score.lastAnswerCorrect = row.lastAnswerCorrect;
    return score;
  });
}

function isChoiceIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3;
}

/**
 * 끝난 판의 «문제 다시 보기» (U38). 하나라도 깨졌으면 통째로 뺀다 — 풀이 하나 때문에 최종 순위까지
 * 거절하지 않는다. 문항 순서는 1부터 판의 문제 수까지 한 번씩이다.
 */
function parseReview(value: unknown, totalQuestions: number): OnlineReviewItem[] | undefined {
  if (!Array.isArray(value) || value.length > totalQuestions) return undefined;
  const items: OnlineReviewItem[] = [];
  for (const [index, row] of value.entries()) {
    if (!isObject(row)) return undefined;
    const { position, id, categoryId, question, choices, answerIndex, explanation } = row;
    if (position !== index + 1) return undefined;
    if (typeof id !== 'string' || !id.trim()) return undefined;
    if (typeof categoryId !== 'string' || !CATEGORIES_SET.has(categoryId)) return undefined;
    if (typeof question !== 'string' || !question.trim()) return undefined;
    if (typeof explanation !== 'string' || !explanation.trim()) return undefined;
    if (
      !Array.isArray(choices)
      || choices.length !== 4
      || choices.some((choice) => typeof choice !== 'string' || !choice.trim())
    ) return undefined;
    const chosen = row.choiceIndex;
    if (!isChoiceIndex(answerIndex) || (chosen !== null && !isChoiceIndex(chosen))) return undefined;
    if (typeof row.correct !== 'boolean' || typeof row.timedOut !== 'boolean') return undefined;
    // 시간 초과는 고른 보기가 없고, 맞힌 것은 정답을 고른 것뿐이다
    if (row.timedOut ? chosen !== null : chosen === null) return undefined;
    if (row.correct !== (chosen === answerIndex)) return undefined;
    items.push({
      position: index + 1,
      id,
      categoryId: categoryId as CategoryId,
      question,
      // 바로 위에서 문자열 넷인 것을 확인했다
      choices: [...choices] as string[],
      answerIndex,
      explanation,
      choiceIndex: chosen,
      correct: row.correct,
      timedOut: row.timedOut,
    });
  }
  return items;
}

function parseMatchSnapshot(value: unknown): OnlineMatchSnapshot {
  if (!isObject(value)) throw new Error('서버 매치 snapshot이 올바르지 않습니다.');
  const matchId = value.matchId;
  if (typeof matchId !== 'string' || !UUID_PATTERN.test(matchId)) throw new Error('서버 매치 ID가 올바르지 않습니다.');
  const categoryId = parseCategoryId(value.categoryId, '매치 분야');
  if (value.gameMode !== true) throw new Error('서버 매치가 캐릭터 전용이 아닙니다.');
  const totalQuestions = parseInteger(value.totalQuestions, '매치 문제 수', 1);
  const currentPosition = parseInteger(value.currentPosition, '매치 문제 순서', 1);
  if (currentPosition > totalQuestions) throw new Error('서버 매치 진행 상태가 올바르지 않습니다.');
  // 이 판의 문항 시간은 남은 시간 막대의 «가득»에만 쓴다. remainingMs처럼 표시용이라 없거나 모르는
  // 값이면 빼고(막대는 처음 받은 남은 시간을 가득으로 본다) 매치 전체를 거절하지 않는다.
  const questionTimeMs = value.questionTimeMs;
  const base = {
    matchId,
    categoryId,
    gameMode: true as const,
    currentPosition,
    totalQuestions,
    ...(isOnlineQuestionTime(questionTimeMs) ? { questionTimeMs } : {}),
    // 시간이 끝나면 발밑 칸이 답인 판 (U13). true만 믿는다 — 없거나 다른 값이면 이전 규칙(직접 낸 답만)이다
    ...(value.standingAnswers === true ? { standingAnswers: true as const } : {}),
  };
  const activeDeadlineAt = (): string => {
    const deadlineAt = value.deadlineAt;
    if (typeof deadlineAt !== 'string' || !Number.isFinite(Date.parse(deadlineAt))) {
      throw new Error('진행 중인 서버 매치 마감 시각이 올바르지 않습니다.');
    }
    return deadlineAt;
  };
  // 표시용 남은 시간이다. 구버전 서버처럼 없거나 쓸 수 없는 값이면 빼고, 화면은 예전 안내로
  // 돌아간다 — 카운트다운 힌트 하나 때문에 매치 전체를 거절하지 않는다.
  const activeRemainingMs = (): { remainingMs?: number } => {
    const remainingMs = value.remainingMs;
    return typeof remainingMs === 'number' && Number.isFinite(remainingMs) && remainingMs >= 0
      ? { remainingMs }
      : {};
  };
  // «문제 다시 보기»는 끝난 판에만 있다 (U38). 진행 중인 응답에 섞이면 정답이 미리 나간 것이다
  if (value.state !== 'finished' && Object.hasOwn(value, 'review')) {
    throw new Error('진행 중인 매치 응답에 정답 풀이가 섞였습니다.');
  }
  if (value.state === 'running') {
    if (value.reveal !== null || !Array.isArray(value.scores) || value.scores.length !== 0) {
      throw new Error('running 응답에 정답 또는 점수 정보가 섞였습니다.');
    }
    const ownSubmission = parseOwnSubmission(value.ownSubmission);
    if (
      ownSubmission !== null
      && ['correct', 'answerIndex', 'explanation', 'score', 'rank'].some((key) => Object.hasOwn(value.ownSubmission as object, key))
    ) {
      throw new Error('running 응답에 정답 정보가 섞였습니다.');
    }
    const question = parseMatchQuestion(value.question, totalQuestions);
    if (question.position !== currentPosition) throw new Error('서버 문제 순서가 맞지 않습니다.');
    if (ownSubmission !== null && ownSubmission.position !== currentPosition) {
      throw new Error('서버 제출 문제 순서가 맞지 않습니다.');
    }
    return {
      ...base,
      deadlineAt: activeDeadlineAt(),
      ...activeRemainingMs(),
      state: 'running',
      question,
      ownSubmission,
      reveal: null,
      scores: [],
    } satisfies OnlineRunningMatch;
  }
  if (value.state === 'revealing') {
    if (value.ownSubmission !== null) throw new Error('공개 중인 매치에 제출 acknowledgement가 섞였습니다.');
    const question = parseMatchQuestion(value.question, totalQuestions);
    if (question.position !== currentPosition) throw new Error('서버 문제 순서가 맞지 않습니다.');
    return {
      ...base,
      deadlineAt: activeDeadlineAt(),
      ...activeRemainingMs(),
      state: 'revealing',
      question,
      ownSubmission: null,
      reveal: parseReveal(value.reveal),
      scores: parseScores(value.scores, { revealing: true }),
    } satisfies OnlineRevealingMatch;
  }
  if (value.state === 'finished') {
    if (
      value.deadlineAt !== null
      || value.question !== null
      || value.ownSubmission !== null
      || value.reveal !== null
    ) {
      throw new Error('끝난 매치에 문제 또는 정답 공개 상태가 섞였습니다.');
    }
    const review = parseReview(value.review, totalQuestions);
    return {
      ...base,
      deadlineAt: null,
      state: 'finished',
      question: null,
      ownSubmission: null,
      reveal: null,
      scores: parseScores(value.scores),
      ...(review === undefined ? {} : { review }),
      // 온라인 랭킹에 남았는가 (FR-7.13 2단계). 참·거짓만 믿는다 — 없으면(이전 API) 랭킹 이야기를 하지 않는다
      ...(typeof value.rankingRecorded === 'boolean' ? { rankingRecorded: value.rankingRecorded } : {}),
    } satisfies OnlineFinishedMatch;
  }
  throw new Error('서버 매치 상태가 올바르지 않습니다.');
}

/**
 * 세션 응답이 알려 주는 이 API의 규칙. 방 snapshot이 아직 없는 화면(홈 입구·빈 로비·「게임 방법」)이 쓴다.
 * 필드를 모르는 이전 API는 둘부터·직접 낸 답만 세었다. 시작 인원이 깨졌으면 이전 규칙으로 읽는다 —
 * 말 하나 때문에 세션을 거절하지 않는다.
 */
function sessionRules(body: Record<string, unknown>): OnlineRules {
  const minPlayers = body.minPlayers;
  return {
    minPlayers: Number.isInteger(minPlayers) && (minPlayers as number) >= 1
      ? minPlayers as number
      : LEGACY_MIN_PLAYERS,
    standingAnswers: body.standingAnswers === true,
    // 서버 랭킹 (FR-7.13 2단계). true만 믿는다 — 없는 이전 API면 화면이 온라인 랭킹을 숨긴다
    rankings: body.rankings === true,
  };
}

const RANKING_ENTRY_KEYS = new Set([
  'rank', 'nickname', 'characterId', 'score', 'correctCount', 'totalCount', 'recordedAt', 'isMine',
]);
const RANKING_LIMIT = 10;

function parseRankingEntry(value: unknown, rank: number): OnlineRankingEntry {
  if (!isObject(value)) throw new Error('서버 랭킹 줄이 올바르지 않습니다.');
  // 공개 필드만 받는다. 브라우저 신분 같은 다른 필드가 실려 오면 믿지 않는다
  if (Object.keys(value).some((key) => !RANKING_ENTRY_KEYS.has(key))) {
    throw new Error('서버 랭킹 줄에 모르는 필드가 있습니다.');
  }
  if (value.rank !== rank) throw new Error('서버 랭킹 순위가 순서와 맞지 않습니다.');
  const nickname = value.nickname;
  const characterId = value.characterId;
  const recordedAt = value.recordedAt;
  if (typeof nickname !== 'string' || nickname.trim() === '' || nickname.length > 20) {
    throw new Error('서버 랭킹 닉네임이 올바르지 않습니다.');
  }
  if (typeof characterId !== 'string' || !CHARACTER_ID_PATTERN.test(characterId)) {
    throw new Error('서버 랭킹 캐릭터가 올바르지 않습니다.');
  }
  if (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) {
    throw new Error('서버 랭킹 기록 시각이 올바르지 않습니다.');
  }
  if (typeof value.isMine !== 'boolean') throw new Error('서버 랭킹 내 기록 표시가 올바르지 않습니다.');
  const totalCount = parseInteger(value.totalCount, '랭킹 문제 수', 1);
  const correctCount = parseInteger(value.correctCount, '랭킹 정답 수');
  const score = parseInteger(value.score, '랭킹 점수');
  if (correctCount > totalCount) throw new Error('서버 랭킹 정답 수가 문제 수보다 많습니다.');
  return { rank, nickname, characterId, score, correctCount, totalCount, recordedAt, isMine: value.isMine };
}

function parseRankingBoard(
  value: unknown,
  target: RankingTarget,
  period: OnlineRankingPeriod,
): OnlineRankingBoard {
  if (!isObject(value)) throw new Error('서버 랭킹 응답이 올바르지 않습니다.');
  const categoryId = target.mode === 'category' ? target.category : null;
  if (value.mode !== target.mode || value.categoryId !== categoryId || value.period !== period) {
    throw new Error('서버 랭킹 응답이 물어본 판과 다릅니다.');
  }
  let window: OnlineRankingBoard['window'] = null;
  if (period === 'week') {
    const raw = value.window;
    if (
      !isObject(raw)
      || typeof raw.start !== 'string'
      || typeof raw.end !== 'string'
      || !Number.isFinite(Date.parse(raw.start))
      || !Number.isFinite(Date.parse(raw.end))
    ) {
      throw new Error('서버 랭킹 기간이 올바르지 않습니다.');
    }
    window = { start: raw.start, end: raw.end };
  } else if (value.window !== null) {
    throw new Error('전체 기간 랭킹에 기간이 섞였습니다.');
  }
  if (!Array.isArray(value.entries) || value.entries.length > RANKING_LIMIT) {
    throw new Error('서버 랭킹 목록이 올바르지 않습니다.');
  }
  return {
    target: { ...target },
    period,
    window,
    entries: value.entries.map((entry, index) => parseRankingEntry(entry, index + 1)),
  };
}

async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`온라인 서버가 JSON이 아닌 응답을 보냈습니다. (${response.status})`);
  }
}

function failureFrom(status: number, body: unknown, retryAfter: string | null = null): ApiFailure {
  const detail = isObject(body) && isObject(body.detail) ? body.detail : null;
  const code = detail && typeof detail.code === 'string' ? detail.code : 'request-failed';
  const serverMessage = detail && typeof detail.message === 'string' ? detail.message : null;
  // 닉네임 금칙 규칙의 거절은 고칠 곳(홈의 닉네임)까지 말하는 화면의 말로 바꾼다 (PRD 12.1)
  const rejection = status === 400 ? nicknameRejection(code) : null;
  if (rejection !== null) return new ApiFailure(status, code, NICKNAME_REJECTION_MESSAGES[rejection]);
  // 요청 한도(429)는 «언제 다시»를 함께 든다. 재조회가 그 값을 따라 한 번 다시 보낸다 (N01)
  const retryAfterMs = status === 429 ? parseRetryAfterMs(retryAfter) : null;
  // 4xx의 이유는 서버가 플레이어에게 쓴 말이다(«이미 다음 문제로 넘어갔습니다»). 5xx나 이유 없는
  // 응답은 «데이터베이스…» 같은 개발 상세라 콘솔에만 남기고 화면에는 한 가지 말을 쓴다 (U40)
  if (serverMessage !== null && status < 500) {
    return new ApiFailure(status, code, serverMessage, retryAfterMs);
  }
  console.warn(`[온라인 오류] 요청 실패 (${status} ${code})`, serverMessage ?? '');
  return new ApiFailure(status, code, SERVICE_TROUBLE_MESSAGE, retryAfterMs);
}

export function createNetworkRoomStore(options: NetworkRoomStoreOptions): RoomStore {
  const baseUrl = configuredBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const socketFactory = options.webSocketFactory
    ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols));
  const identityFactory = options.newIdentity ?? randomIdentity;
  const sleep = options.sleep
    ?? ((delayMs: number) => new Promise<void>((resolve) => { setTimeout(resolve, delayMs); }));
  const random = options.random ?? Math.random;
  let identity = readIdentity(options.storage, identityFactory);
  let playerProfile: PlayerInfo = {
    nickname: '손님',
    characterId: DEFAULT_CHARACTER_ID,
  };
  let sessionFingerprint: string | null = null;
  /** 세션을 열 때 서버가 알려 준 규칙. 묻기 전에는 null — 화면은 어느 쪽이든 맞는 말을 한다 */
  let learnedRules: OnlineRules | null = null;
  let roomSnapshotRequestGeneration = 0;
  const activeRoomMutationStates = new Map<string, {
    committedGeneration: number;
    subscribers: number;
  }>();
  const movementChannels = new Map<string, MovementChannel>();

  function movementPayload(channel: MovementChannel): object | null {
    const latest = channel.latest;
    if (!latest) return null;
    const payload: Record<string, string | number | boolean> = {
      type: latest.type,
      x: latest.x,
      y: latest.y,
      moving: latest.moving,
    };
    if (channel.supportsViewport) {
      payload.viewportWidth = latest.viewportWidth;
      payload.viewportHeight = latest.viewportHeight;
    }
    if (channel.supportsViewport && channel.supportsSeat && latest.seatId) {
      payload.seatId = latest.seatId;
    }
    // 무대 좌표는 받는다고 알린 서버에만 싣는다. #106의 API는 모르는 키가 섞인 이동을 통째로 버린다
    if (
      channel.supportsViewport
      && channel.supportsStage
      && latest.stage !== undefined
      && latest.stageX !== undefined
      && latest.stageY !== undefined
    ) {
      payload.stage = latest.stage;
      payload.stageX = latest.stageX;
      payload.stageY = latest.stageY;
    }
    return payload;
  }

  function beginRoomSnapshotRequest(): number {
    roomSnapshotRequestGeneration += 1;
    return roomSnapshotRequestGeneration;
  }

  function retainRoomMutationState(code: string): {
    committedGeneration: number;
    subscribers: number;
  } {
    const current = activeRoomMutationStates.get(code);
    if (current) {
      current.subscribers += 1;
      return current;
    }
    const created = { committedGeneration: 0, subscribers: 1 };
    activeRoomMutationStates.set(code, created);
    return created;
  }

  function releaseRoomMutationState(
    code: string,
    state: { committedGeneration: number; subscribers: number },
  ): void {
    if (activeRoomMutationStates.get(code) !== state) return;
    state.subscribers -= 1;
    if (state.subscribers === 0) activeRoomMutationStates.delete(code);
  }

  function commitRoomMutation(code: string, requestGeneration: number): void {
    const state = activeRoomMutationStates.get(code);
    if (state && requestGeneration > state.committedGeneration) {
      state.committedGeneration = requestGeneration;
    }
  }
  let sessionPromise: Promise<void> | null = null;

  function endpoint(path: string): string {
    return `${baseUrl}${path}`;
  }

  function authHeaders(headers?: HeadersInit): Headers {
    const result = new Headers(headers);
    result.set('Authorization', `Bearer ${identity.secret}`);
    result.set('X-Player-Id', identity.id);
    return result;
  }

  async function rawRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(endpoint(path), {
        ...init,
        headers: authHeaders(init.headers),
        signal: controller.signal,
      });
      const body = await responseBody(response);
      if (!response.ok) throw failureFrom(response.status, body, response.headers.get('Retry-After'));
      return body;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.warn(`[온라인 오류] ${REQUEST_TIMEOUT_MS}ms 안에 응답이 없습니다: ${init.method ?? 'GET'} ${path}`);
        throw new OnlinePlayerError(TIMEOUT_MESSAGE);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function profileBody(player?: PlayerInfo): Record<string, string> {
    const active = player ?? playerProfile;
    if (!active || !CHARACTER_ID_PATTERN.test(active.characterId)) {
      throw new Error('온라인 프로필에는 캐릭터가 필요합니다.');
    }
    return {
      nickname: active.nickname,
      characterId: active.characterId,
    };
  }

  async function ensureSession(player?: PlayerInfo): Promise<void> {
    const profile = profileBody(player);
    // 금칙 규칙에 걸리는 닉네임(규칙이 생기기 전에 저장한 이름)은 보내지 않는다. 서버도 같은 규칙으로
    // 거절한다 — 보내기 전에 같은 말로 고칠 곳을 알린다 (PRD 12.1). 다시 시도해도 같으므로 화면이
    // 알아보게 따로 던진다(`isNicknameRejection` → 「홈으로」)
    const problem = nicknameProblem(profile.nickname);
    if (problem !== null) {
      throw new NicknameRejected(problem === 'profanity' ? 'nickname-profanity' : 'nickname-personal-info');
    }
    const fingerprint = JSON.stringify(profile);
    if (sessionFingerprint === fingerprint) return;
    if (sessionPromise) {
      await sessionPromise;
      if (sessionFingerprint === fingerprint) return;
    }

    sessionPromise = (async () => {
      const register = async (): Promise<void> => {
        const body = await rawRequest('/v1/session', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile),
        });
        if (!isObject(body) || body.playerId !== identity.id) {
          throw new Error('온라인 서버가 다른 참가자 식별자를 돌려줬습니다.');
        }
        learnedRules = sessionRules(body);
      };

      try {
        await register();
      } catch (error) {
        if (!(error instanceof ApiFailure) || error.code !== 'identity-conflict') throw error;
        try {
          options.storage.removeItem(IDENTITY_KEY);
        } catch {
          // 저장소 삭제가 막혀도 현재 메모리 식별자를 바꾸면 이번 세션은 복구된다.
        }
        identity = readIdentity(options.storage, identityFactory);
        await register();
      }
      sessionFingerprint = fingerprint;
    })();

    try {
      await sessionPromise;
    } finally {
      sessionPromise = null;
    }
  }

  async function request(
    path: string,
    init: RequestInit = {},
    player?: PlayerInfo,
  ): Promise<unknown> {
    await ensureSession(player);
    try {
      return await rawRequest(path, init);
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 401) throw error;
      sessionFingerprint = null;
      await ensureSession(player);
      return rawRequest(path, init);
    }
  }

  async function listRooms(): Promise<PublicRoom[]> {
    return parseRooms(await request('/v1/rooms'));
  }

  /**
   * 온라인 랭킹 (FR-7.13 2단계). 세션을 열어 이 API가 랭킹을 아는지(`rankings: true`) 먼저 본다 — 모르는
   * 이전 API에는 랭킹 요청을 보내지 않는다. 신분을 실어 보내 서버가 내 기록(isMine)을 가린다.
   */
  async function getOnlineRankings({ target, period }: {
    target: RankingTarget;
    period: OnlineRankingPeriod;
  }): Promise<OnlineRankingResult> {
    await ensureSession();
    if (learnedRules?.rankings !== true) return { supported: false };
    const params = new URLSearchParams({ mode: target.mode });
    if (target.mode === 'category') {
      const category = target.category;
      if (category === null || !CATEGORIES_SET.has(category)) throw new Error('랭킹 분야가 올바르지 않습니다.');
      params.set('category', category);
    }
    params.set('period', period);
    const value = await request(`/v1/rankings?${params.toString()}`);
    return { supported: true, board: parseRankingBoard(value, target, period) };
  }

  async function createRoom(spec: CreateRoomSpec): Promise<CreateRoomResult> {
    try {
      const value = await request('/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: spec.name,
          categoryId: spec.categoryId,
          capacity: spec.capacity,
          questionTimeMs: spec.questionTimeMs,
          isPublic: spec.isPublic,
          ...(spec.isPublic ? {} : { password: spec.password ?? '' }),
        }),
      }, spec.player);
      return { ok: true, room: parseRoom(value) };
    } catch (error) {
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  async function joinRoom(spec: JoinRoomSpec): Promise<JoinRoomResult> {
    const code = normalizeCode(spec.code);
    if (!CODE_PATTERN.test(code)) return { ok: false, reason: 'not-found' };
    const requestGeneration = beginRoomSnapshotRequest();
    try {
      const value = await request(`/v1/rooms/${encodeURIComponent(code)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: spec.password || null }),
      }, spec.player);
      const joined = parseRoom(value);
      commitRoomMutation(code, requestGeneration);
      return { ok: true, room: joined };
    } catch (error) {
      if (error instanceof ApiFailure && JOIN_FAILURES.has(error.code as JoinFailReason)) {
        return { ok: false, reason: error.code as JoinFailReason };
      }
      throw error;
    }
  }

  async function fetchRoomSnapshot(code: string): Promise<{
    room: PublicRoom | null;
    /** 서버가 붙인 판 번호. 이전 API이거나 깨졌으면 null */
    stamp: RoomStamp | null;
    requestGeneration: number;
  }> {
    const requestGeneration = beginRoomSnapshotRequest();
    try {
      const value = await request(`/v1/rooms/${encodeURIComponent(code)}`);
      return {
        room: parseRoom(value),
        stamp: parseRoomStamp(value),
        requestGeneration,
      };
    } catch (error) {
      // 방장이 나를 내보냈다. «없는 방»과 다른 말을 해야 해서 따로 던진다 (U24)
      const kind = error instanceof ApiFailure ? removalKind(error.code) : null;
      if (kind) throw new RemovedFromRoom(kind);
      if (error instanceof ApiFailure && error.status === 404) {
        return { room: null, stamp: null, requestGeneration };
      }
      throw error;
    }
  }

  async function getRoom(rawCode: string): Promise<PublicRoom | null> {
    const code = normalizeCode(rawCode);
    if (!CODE_PATTERN.test(code)) return null;
    return (await fetchRoomSnapshot(code)).room;
  }

  /**
   * 방장의 «내보내기» (U24). 접속 중인 사람은 방장이 그렇게 보고 확인했을 때만(`connected`) 보낸다 —
   * 서버는 그 사람을 잠시 다시 들이지 않는다. 없으면 끊긴 자리를 비우는 요청이다(구버전과 같다).
   */
  async function removeMember(spec: {
    code: string;
    playerId: string;
    connected?: boolean;
  }): Promise<RemoveMemberResult> {
    const code = normalizeCode(spec.code);
    if (!CODE_PATTERN.test(code)) return { ok: false, reason: 'not-found' };
    if (!UUID_PATTERN.test(spec.playerId)) return { ok: false, reason: 'not-member' };
    const requestGeneration = beginRoomSnapshotRequest();
    try {
      const path = `/v1/rooms/${encodeURIComponent(code)}/members/${encodeURIComponent(spec.playerId)}`;
      const room = parseRoom(await request(
        spec.connected === true ? `${path}?connected=true` : path,
        { method: 'DELETE' },
      ));
      commitRoomMutation(code, requestGeneration);
      return { ok: true, room };
    } catch (error) {
      if (error instanceof ApiFailure && REMOVE_MEMBER_FAILURES.has(error.code as RemoveMemberFailReason)) {
        return { ok: false, reason: error.code as RemoveMemberFailReason };
      }
      throw error;
    }
  }

  async function updateRoom(spec: { code: string; patch: RoomPatch }): Promise<RoomActionResult> {
    const code = normalizeCode(spec.code);
    if (!CODE_PATTERN.test(code)) return { ok: false, reason: 'not-found' };
    const requestGeneration = beginRoomSnapshotRequest();
    try {
      const room = parseRoom(await request(`/v1/rooms/${encodeURIComponent(code)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec.patch),
      }));
      commitRoomMutation(code, requestGeneration);
      return { ok: true, room };
    } catch (error) {
      if (error instanceof ApiFailure && (error.code === 'not-found' || error.code === 'not-host')) {
        return { ok: false, reason: error.code };
      }
      throw error;
    }
  }

  async function setReady(spec: { code: string; isReady: boolean }): Promise<ReadyResult> {
    const code = normalizeCode(spec.code);
    if (!CODE_PATTERN.test(code)) return { ok: false, reason: 'not-found' };
    if (typeof spec.isReady !== 'boolean') throw new Error('바꿀 준비 상태가 올바르지 않습니다.');
    const requestGeneration = beginRoomSnapshotRequest();
    try {
      const room = parseRoom(await request(`/v1/rooms/${encodeURIComponent(code)}/ready`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isReady: spec.isReady }),
      }));
      commitRoomMutation(code, requestGeneration);
      return { ok: true, room };
    } catch (error) {
      if (error instanceof ApiFailure) {
        switch (error.code) {
          case 'not-found':
          case 'not-member':
          case 'game-in-progress':
            return { ok: false, reason: error.code };
          default:
            break;
        }
      }
      throw error;
    }
  }

  async function startGame(spec: { code: string }): Promise<StartGameResult> {
    const code = normalizeCode(spec.code);
    if (!CODE_PATTERN.test(code)) return { ok: false, reason: 'not-found' };
    const requestGeneration = beginRoomSnapshotRequest();
    try {
      const setup = parseMatchSetup(await request(`/v1/rooms/${encodeURIComponent(code)}/start`, {
        method: 'POST',
      }));
      commitRoomMutation(code, requestGeneration);
      return { ok: true, setup };
    } catch (error) {
      if (error instanceof ApiFailure) {
        switch (error.code) {
          case 'not-found':
          case 'not-host':
          case 'not-ready':
          case 'game-in-progress':
            return { ok: false, reason: error.code };
          default:
            break;
        }
      }
      throw error;
    }
  }

  async function getMatch(rawCode: string): Promise<OnlineMatchSnapshot | null> {
    const code = normalizeCode(rawCode);
    if (!CODE_PATTERN.test(code)) return null;
    try {
      return parseMatchSnapshot(await request(`/v1/rooms/${encodeURIComponent(code)}/match`));
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return null;
      throw error;
    }
  }

  async function submitMatchAnswer({
    code: rawCode,
    position,
    choiceIndex,
  }: {
    code: string;
    position: number;
    choiceIndex: number;
  }): Promise<OnlineMatchAnswerResult> {
    const code = normalizeCode(rawCode);
    if (!CODE_PATTERN.test(code) || !Number.isInteger(position) || position < 1) {
      throw new Error('제출할 온라인 문제 순서가 올바르지 않습니다.');
    }
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3) {
      throw new Error('제출할 온라인 보기가 올바르지 않습니다.');
    }
    const value = await request(`/v1/rooms/${encodeURIComponent(code)}/match/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position, choiceIndex }),
    });
    if (!isObject(value) || value.accepted !== true || typeof value.advanced !== 'boolean') {
      throw new Error('서버 답안 제출 응답이 올바르지 않습니다.');
    }
    return { match: parseMatchSnapshot(value.match), accepted: true, advanced: value.advanced };
  }

  function sendMovement({
    code: rawCode, x, y, moving, viewportWidth, viewportHeight, seatId, stage, stageX, stageY,
    onlyIfChanged,
  }: {
    code: string;
    x: number;
    y: number;
    moving: boolean;
    seatId?: WaitingRoomSeatId;
    onlyIfChanged?: true;
  } & MovementViewport & Partial<MovementStage>): boolean {
    const code = normalizeCode(rawCode);
    const hasStage = stage !== undefined || stageX !== undefined || stageY !== undefined;
    if (
      !CODE_PATTERN.test(code)
      || !Number.isFinite(x) || x < 0 || x > 1
      || !Number.isFinite(y) || y < 0 || y > 1
      || typeof moving !== 'boolean'
      || (seatId !== undefined && (!isWaitingRoomSeatId(seatId) || moving))
      || !validMovementViewportDimension(viewportWidth)
      || !validMovementViewportDimension(viewportHeight)
      || (hasStage && (
        !isMovementStageId(stage) || !validMovementStageUnit(stageX) || !validMovementStageUnit(stageY)
      ))
    ) return false;
    const channel = movementChannels.get(code);
    if (!channel) return false;
    channel.latest = {
      type: 'movement', x, y, moving, viewportWidth, viewportHeight,
      ...(seatId !== undefined ? { seatId } : {}),
      // 바로 위에서 셋이 함께 맞는 것을 확인했다
      ...(hasStage ? { stage, stageX, stageY } as MovementStage : {}),
    };
    if (channel.socket?.readyState !== 1) return false;
    try {
      const payload = movementPayload(channel);
      if (!payload) return false;
      const line = JSON.stringify(payload);
      // 무대만 움직였는데 이 소켓이 무대를 싣지 않으면 줄이 지난번과 같다 — 되풀이하지 않는다
      if (onlyIfChanged && line === channel.lastSentMovement) return false;
      channel.socket.send(line);
      channel.lastSentMovement = line;
      return true;
    } catch {
      channel.socket.close();
      return false;
    }
  }

  /** 초안 하나를 소켓에 싣는다. 그 소켓의 서버가 받는다고 알렸을 때만 (U13) */
  function sendStandingPayload(channel: MovementChannel, draft: StandingAnswerDraft): boolean {
    const socket = channel.socket;
    if (!channel.supportsStandingAnswer || socket?.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify({
        type: 'standing-answer',
        matchId: draft.matchId,
        position: draft.position,
        choiceIndex: draft.choiceIndex,
      }));
      return true;
    } catch {
      socket.close();
      return false;
    }
  }

  function sendStandingAnswer({
    code: rawCode, matchId, position, choiceIndex,
  }: { code: string } & StandingAnswerDraft): boolean {
    const code = normalizeCode(rawCode);
    if (
      !CODE_PATTERN.test(code)
      || typeof matchId !== 'string' || !UUID_PATTERN.test(matchId)
      || !Number.isInteger(position) || position < 1 || position > MAX_STANDING_ANSWER_POSITION
      || (choiceIndex !== null && (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3))
    ) return false;
    const channel = movementChannels.get(code);
    if (!channel) return false;
    channel.latestStanding = { matchId, position, choiceIndex };
    return sendStandingPayload(channel, channel.latestStanding);
  }

  function subscribe(rawCode: string, handler: RoomEventHandler): Unsubscribe {
    const code = normalizeCode(rawCode);
    if (!CODE_PATTERN.test(code)) return () => undefined;

    const mutationState = retainRoomMutationState(code);
    let stopped = false;
    /** 방장이 나를 내보냈다. 다시 붙어도 소용이 없으니 재연결을 멈춘다 (U24) */
    let halted = false;
    let socket: WebSocketLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let generation = 0;
    let latestDeliveredRoomGeneration = 0;
    /** room 재조회가 지금 날아가는 중인가. 한 subscription에 하나만 띄운다. */
    let roomRefreshInFlight = false;
    /** 그 사이 무효화가 또 왔는가. 몇 번이 오든 끝난 뒤 한 번만 더 읽는다. */
    let roomRefreshQueued = false;
    /**
     * 이 구독이 마지막으로 화면에 넘긴 방과 그 판 번호. 번호를 모르면(이전 API·깨진 값) null — 그때는
     * 무효화마다 예전처럼 다시 읽는다. 저장소의 다른 길(준비·설정 응답)은 여기를 고치지 않는다 — 그 응답은
     * 부른 화면만 받고 이 구독의 화면(대기실·매치·결과)에는 가지 않는다.
     */
    let delivered: { room: PublicRoom; stamp: RoomStamp } | null = null;
    /**
     * 다음 재조회가 담아야 할 것. 판 번호면 «그 번호까지 담긴 방», `any`면 번호를 모르는 무효화나 재연결이라
     * 반드시 읽는다. 이미 넘긴 방이 그 번호를 담고 있으면 읽지 않는다.
     */
    let refreshWanted: RoomStamp | 'any' | null = null;
    const movementChannel: MovementChannel = {
      socket: null,
      supportsViewport: false,
      supportsSeat: false,
      supportsStage: false,
      lastSentMovement: null,
      supportsStandingAnswer: false,
      latestStanding: null,
      latest: null,
    };
    movementChannels.set(code, movementChannel);
    /**
     * 이 구독의 초안이 서버에 닿을 수 있는가 (U13). 처음 붙는 동안은 닿는다고 본다 — 기억한 마지막 초안을
     * 소켓이 열리면 보낸다. 붙지 못했거나 끊겼거나, 열린 소켓의 서버가 받는다고 알리지 않았으면 false.
     * 바뀔 때만 화면에 알린다(`standing-delivery`) — 그동안 마감이 오면 서버는 그 전에 받은 초안만 안다.
     */
    let standingDeliverable = true;

    function setStandingDeliverable(next: boolean): void {
      if (stopped || halted || next === standingDeliverable) return;
      standingDeliverable = next;
      handler({ type: 'standing-delivery', deliverable: next });
    }

    function clearTimers(): void {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (pingTimer !== null) clearInterval(pingTimer);
      reconnectTimer = null;
      pingTimer = null;
    }

    function scheduleReconnect(): void {
      if (stopped || halted || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, RECONNECT_DELAY_MS);
    }

    /**
     * 방장이 나를 내보냈다. 다시 붙어도 소용이 없으니 그만 붙고 화면에 **한 번만** 알린다 (U24).
     * 열린 소켓으로 먼저 들었으면 서버가 곧 그 소켓을 닫는다 — 닫혀도 다시 붙지 않는다.
     */
    function removedFromRoom(connectionGeneration: number, kind: RemovalKind): void {
      if (stopped || halted || connectionGeneration !== generation) return;
      halted = true;
      clearTimers();
      socket?.close();
      handler({ type: 'removed', kind });
    }

    /** 이미 넘긴 방이 그 판 번호까지 담는가. 다른 묶음(서버를 다시 띄웠다)의 번호는 견줄 수 없다 */
    function deliveredCovers(stamp: RoomStamp): boolean {
      return delivered !== null
        && delivered.stamp.epoch === stamp.epoch
        && delivered.stamp.version >= stamp.version;
    }

    /** 기다리는 재조회 둘을 하나로. 하나라도 번호를 모르거나 묶음이 다르면 반드시 읽는다 */
    function mergeRefreshWanted(
      current: RoomStamp | 'any' | null,
      next: RoomStamp | 'any',
    ): RoomStamp | 'any' {
      if (current === null) return next;
      if (current === 'any' || next === 'any' || current.epoch !== next.epoch) return 'any';
      return current.version >= next.version ? current : next;
    }

    /**
     * 방 GET 하나. 요청 한도(429)에 걸리면 Retry-After(상한 약 3초)와 jitter를 두고 **한 번만** 다시
     * 보낸다 (N01) — 조용히 버리면 준비·입장 변화가 다음 무효화까지 화면에 오지 않는다. 그사이 구독이
     * 끝났거나 소켓이 다시 붙었으면(재연결이 새로 읽는다), 또는 그사이 온 무효화가 후속 조회를
     * 예약했으면(그것이 같은 일을 한다) 다시 보내지 않는다.
     */
    async function readRoomForRefresh(
      connectionGeneration: number,
    ): Promise<Awaited<ReturnType<typeof fetchRoomSnapshot>>> {
      try {
        return await fetchRoomSnapshot(code);
      } catch (error) {
        const delayMs = rateLimitRetryDelayMs(error, random);
        if (delayMs === null) throw error;
        await sleep(delayMs);
        if (stopped || connectionGeneration !== generation || roomRefreshQueued) throw error;
        return fetchRoomSnapshot(code);
      }
    }

    async function refreshRoom(connectionGeneration: number): Promise<void> {
      let snapshot: Awaited<ReturnType<typeof fetchRoomSnapshot>>;
      try {
        snapshot = await readRoomForRefresh(connectionGeneration);
      } catch (error) {
        if (error instanceof RemovedFromRoom) {
          removedFromRoom(connectionGeneration, error.kind);
          return;
        }
        throw error;
      }
      const { room, stamp, requestGeneration } = snapshot;
      if (stopped || connectionGeneration !== generation) return;
      if (requestGeneration < latestDeliveredRoomGeneration) return;
      if (requestGeneration < mutationState.committedGeneration) return;
      if (
        stamp !== null
        && delivered !== null
        && delivered.stamp.epoch === stamp.epoch
        && delivered.stamp.version > stamp.version
      ) {
        // 이미 넘긴 방보다 앞선 번호다 — 그 뒤의 변화를 담았는지 모른다. 넘기지 않고 한 번 더 읽는다
        // (새 요청의 번호는 넘긴 번호보다 작을 수 없어 되풀이되지 않는다)
        refreshWanted = 'any';
        roomRefreshQueued = true;
        return;
      }
      latestDeliveredRoomGeneration = requestGeneration;
      delivered = room && stamp ? { room, stamp } : null;
      if (room) handler({ type: 'room', room });
    }

    /**
     * room-invalidated와 재연결 복구가 부르는 재조회. **요청을 합친다** — 방송 하나에 방
     * 전원이 GET을 보내므로, 준비 토글이 몰리면 무효화마다 한 번씩 읽는 것만으로 IP·프로세스
     * 요청 한도를 먼저 먹는다. 날아가는 요청이 있으면 표시만 해 두고, 끝나면 최신 상태를
     * 한 번 더 읽는다(그사이 몇 번이 왔든 한 번). 요청 한도(429)면 한 번 다시 보내고(N01), 그래도
     * 실패하면 다음 무효화·재연결이 다시 맞춘다. `wanted`가 판 번호면 그 번호까지 담긴 방이 필요한
     * 것이고, 합친 후속 조회 차례에 이미 받은 방이 그 번호를 담았으면 읽지 않는다. 재연결·번호 없는
     * 무효화는 `any`라 늘 읽는다.
     */
    function requestRoomRefresh(wanted: RoomStamp | 'any' = 'any'): void {
      if (stopped) return;
      refreshWanted = mergeRefreshWanted(refreshWanted, wanted);
      if (roomRefreshInFlight) {
        roomRefreshQueued = true;
        return;
      }
      roomRefreshInFlight = true;
      void (async () => {
        try {
          do {
            roomRefreshQueued = false;
            const reason = refreshWanted;
            refreshWanted = null;
            // 그사이 받은 방이 이미 그 번호를 담았다 — 합친 후속 조회가 할 일이 없다
            if (reason === null || (reason !== 'any' && deliveredCovers(reason))) continue;
            await refreshRoom(generation).catch(() => undefined);
          } while (roomRefreshQueued && !stopped);
        } finally {
          roomRefreshInFlight = false;
        }
      })();
    }

    /**
     * 준비 토글 하나를 GET 없이 고친다. 넘긴 방이 정확히 그 바로 앞(`previousVersion` 이상, 이번 번호 미만)일
     * 때만이다 — 그 사이에 이 방에 알린 다른 변화가 없다는 뜻이다. 날아가는 재조회가 있으면(그 응답이 무엇을
     * 담았는지 모른다) 고치지 않는다. 그 사람이 방에 없으면 나간 것을 먼저 들은 것이라 고치지 않는다.
     * 고칠 수 없으면 false — 부르는 쪽이 예전처럼 다시 읽는다.
     */
    function applyReadyChange(stamp: RoomStamp, raw: unknown): boolean {
      const change = parseReadyChange(raw, stamp.version);
      const base = delivered;
      if (
        change === null
        || base === null
        || roomRefreshInFlight
        || base.stamp.epoch !== stamp.epoch
        || base.stamp.version < change.previousVersion
        || base.stamp.version >= stamp.version
      ) return false;
      if (!base.room.players.some((player) => player.id === change.playerId)) return false;
      const room: PublicRoom = {
        ...base.room,
        players: base.room.players.map((player) => (
          player.id === change.playerId ? { ...player, isReady: change.isReady } : player
        )),
      };
      delivered = { room, stamp };
      handler({ type: 'room', room });
      return true;
    }

    /** room-invalidated 하나. 이미 아는 판이면 건너뛰고, 준비 토글이면 고치고, 아니면 다시 읽는다 */
    function roomInvalidated(value: Record<string, unknown>): void {
      const stamp = parseRoomStamp(value);
      if (stamp === null) {
        requestRoomRefresh('any');
        return;
      }
      if (deliveredCovers(stamp)) return;
      if (applyReadyChange(stamp, value.readyChange)) return;
      requestRoomRefresh(stamp);
    }

    function receive(data: unknown, connectionGeneration: number): void {
      if (stopped || connectionGeneration !== generation) return;
      if (typeof data !== 'string') return;
      let value: unknown;
      try {
        value = JSON.parse(data) as unknown;
      } catch {
        return;
      }
      if (!isObject(value) || typeof value.type !== 'string') return;
      if (value.type === 'match-invalidated') {
        const matchId = typeof value.matchId === 'string' && UUID_PATTERN.test(value.matchId)
          ? value.matchId
          : null;
        handler({ type: 'match', phase: 'invalidated', matchId });
        return;
      }
      if (value.type === 'room-invalidated') {
        roomInvalidated(value);
        return;
      }
      if (value.type === 'removed') {
        // 서버는 내보낸 그 사람의 소켓에만 보낸다. 이유를 모르면 끊긴 자리를 비운 쪽으로 읽는다
        removedFromRoom(connectionGeneration, removalKind(value.reason) ?? 'removed');
        return;
      }
      const hasViewportWidth = Object.hasOwn(value, 'viewportWidth');
      const hasViewportHeight = Object.hasOwn(value, 'viewportHeight');
      const hasSeat = Object.hasOwn(value, 'seatId');
      // 공유 무대 좌표 (U31). 셋이 함께 맞을 때만 싣고, 어긋나면 무대만 버린다 — 화면 중심의 px로는 그린다
      const stage = isMovementStageId(value.stage)
        && validMovementStageUnit(value.stageX)
        && validMovementStageUnit(value.stageY)
        ? { stage: value.stage, stageX: value.stageX, stageY: value.stageY }
        : null;
      if (
        value.type === 'movement'
        && typeof value.playerId === 'string'
        && UUID_PATTERN.test(value.playerId)
        && typeof value.x === 'number'
        && Number.isFinite(value.x)
        && value.x >= 0
        && value.x <= 1
        && typeof value.y === 'number'
        && Number.isFinite(value.y)
        && value.y >= 0
        && value.y <= 1
        && typeof value.moving === 'boolean'
        && (!hasSeat || (isWaitingRoomSeatId(value.seatId) && !value.moving))
        && hasViewportWidth === hasViewportHeight
        && (!hasViewportWidth || (
          validMovementViewportDimension(value.viewportWidth)
          && validMovementViewportDimension(value.viewportHeight)
        ))
        && typeof value.sequence === 'number'
        && Number.isSafeInteger(value.sequence)
        && value.sequence > 0
      ) {
        handler({
          type: 'movement',
          playerId: value.playerId,
          x: value.x,
          y: value.y,
          moving: value.moving,
          ...(hasSeat ? { seatId: value.seatId as WaitingRoomSeatId } : {}),
          ...(hasViewportWidth ? {
            viewportWidth: value.viewportWidth as number,
            viewportHeight: value.viewportHeight as number,
          } : {}),
          ...(stage ?? {}),
          sequence: value.sequence,
          connectionGeneration,
        });
        return;
      }
      if (
        value.type === 'chat'
        && typeof value.playerId === 'string'
        && typeof value.nickname === 'string'
        && typeof value.text === 'string'
      ) {
        handler({
          type: 'chat',
          playerId: value.playerId,
          nickname: value.nickname,
          text: value.text,
          at: Date.now(),
        });
        return;
      }
      if (value.type === 'game-started') {
        if (typeof value.matchId !== 'string' || !UUID_PATTERN.test(value.matchId)) return;
        try {
          handler({
            type: 'match',
            phase: 'started',
            matchId: value.matchId,
            setup: parseMatchSetup(value),
          });
        } catch {
          // 계약에 맞지 않는 서버 이벤트는 화면 상태를 바꾸지 않는다.
        }
      }
    }

    async function connect(): Promise<void> {
      const connectionGeneration = ++generation;
      // Every reconnect renegotiates the capability. A backend rollback must not leave a
      // cached new client sending payload fields that the legacy strict parser discards.
      movementChannel.supportsViewport = false;
      movementChannel.supportsSeat = false;
      movementChannel.supportsStage = false;
      movementChannel.supportsStandingAnswer = false;
      try {
        const ticketBody = await request(`/v1/rooms/${encodeURIComponent(code)}/ws-ticket`, {
          method: 'POST',
        });
        if (!isObject(ticketBody) || typeof ticketBody.ticket !== 'string') {
          throw new Error('온라인 서버가 WebSocket 티켓을 보내지 않았습니다.');
        }
        if (stopped || connectionGeneration !== generation) return;
        movementChannel.supportsViewport = (
          ticketBody.movementViewport === MOVEMENT_VIEWPORT_CAPABILITY
        );
        movementChannel.supportsSeat = movementChannel.supportsViewport
          && ticketBody.movementSeat === WAITING_ROOM_SEAT_CAPABILITY;
        // 공유 무대 좌표(U31)는 viewport 크기를 받는 서버에서만 싣는다
        movementChannel.supportsStage = movementChannel.supportsViewport
          && ticketBody.movementStage === MOVEMENT_STAGE_CAPABILITY;
        // 모르는 메시지를 버리기만 하는 이전 API에도 초안은 보내지 않는다 (U13)
        movementChannel.supportsStandingAnswer = ticketBody.standingAnswer === STANDING_ANSWER_CAPABILITY;

        const url = new URL(endpoint(`/v1/rooms/${encodeURIComponent(code)}/events`));
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const connected = socketFactory(url.toString(), [
          WEBSOCKET_PROTOCOL,
          `${WEBSOCKET_TICKET_PREFIX}${ticketBody.ticket}`,
        ]);
        socket = connected;
        movementChannel.socket = connected;
        movementChannel.lastSentMovement = null;
        connected.addEventListener('open', () => {
          if (stopped || connected !== socket) return;
          clearTimers();
          setStandingDeliverable(movementChannel.supportsStandingAnswer);
          const latest = movementPayload(movementChannel);
          if (latest && connected.readyState === 1) {
            const line = JSON.stringify(latest);
            connected.send(line);
            movementChannel.lastSentMovement = line;
          }
          // 끊긴 사이의 초안을 다시 맞춘다 (U13). API를 다시 띄웠으면 메모리의 초안이 사라졌고, 끊긴 사이
          // 칸에서 내려섰으면 서버에 남은 앞 칸을 지워야 한다 — 마지막 초안(지우기 포함)을 다시 보낸다
          const standing = movementChannel.latestStanding;
          if (standing) sendStandingPayload(movementChannel, standing);
          // 연결이 끊긴 동안 room-invalidated를 놓쳤을 수 있으므로 room과 match를
          // 모두 권위 있는 REST snapshot으로 다시 맞춘다.
          requestRoomRefresh();
          // A reconnect may have missed a match transition. Send only an invalidation;
          // the controller must obtain its own authorized REST snapshot.
          handler({ type: 'match', phase: 'invalidated', matchId: null });
          pingTimer = setInterval(() => {
            if (connected.readyState === 1) connected.send('{"type":"ping"}');
          }, PING_INTERVAL_MS);
        });
        connected.addEventListener('message', (event) => receive(event.data, connectionGeneration));
        connected.addEventListener('close', () => {
          if (connected === socket) socket = null;
          if (movementChannel.socket === connected) {
            movementChannel.socket = null;
            movementChannel.supportsViewport = false;
            movementChannel.supportsSeat = false;
            movementChannel.supportsStage = false;
            movementChannel.supportsStandingAnswer = false;
            // 다시 붙을 때까지 새 초안은 서버에 닿지 않는다. 기억했다가 다시 열리면 보낸다
            setStandingDeliverable(false);
          }
          if (pingTimer !== null) clearInterval(pingTimer);
          pingTimer = null;
          scheduleReconnect();
        });
        connected.addEventListener('error', () => connected.close());
      } catch (error) {
        // 서버가 «방장이 내보냈다»고 했다. 같은 티켓 요청을 되풀이하지 않는다 (U24)
        const kind = error instanceof ApiFailure ? removalKind(error.code) : null;
        if (kind) {
          removedFromRoom(connectionGeneration, kind);
          return;
        }
        // 티켓을 받지 못해 붙지 못했다. 다시 붙을 때까지 초안은 서버에 닿지 않는다
        if (connectionGeneration === generation) setStandingDeliverable(false);
        scheduleReconnect();
      }
    }

    void connect();
    return () => {
      if (stopped) return;
      stopped = true;
      generation += 1;
      clearTimers();
      socket?.close();
      socket = null;
      movementChannel.socket = null;
      movementChannel.supportsViewport = false;
      movementChannel.supportsSeat = false;
      movementChannel.supportsStage = false;
      movementChannel.supportsStandingAnswer = false;
      movementChannel.latestStanding = null;
      movementChannel.latest = null;
      if (movementChannels.get(code) === movementChannel) movementChannels.delete(code);
      releaseRoomMutationState(code, mutationState);
    };
  }

  return {
    isNetworked: true,
    isPersistent: true,
    me: () => identity.id,
    setPlayer(player) {
      if (!CHARACTER_ID_PATTERN.test(player.characterId)) {
        throw new Error('온라인 프로필 캐릭터가 올바르지 않습니다.');
      }
      playerProfile = { ...player };
    },
    listRooms,
    async myRooms() {
      return (await listRooms()).filter(({ joined }) => joined);
    },
    createRoom,
    joinRoom,
    async leaveRoom({ code }) {
      const normalized = normalizeCode(code);
      if (CODE_PATTERN.test(normalized)) {
        const requestGeneration = beginRoomSnapshotRequest();
        try {
          await request(`/v1/rooms/${encodeURIComponent(normalized)}/members/me`, {
            method: 'DELETE',
          });
        } catch (error) {
          // 판이 도는 동안 서버는 멤버십을 지킨다(409). 연결 실패와 구분해 던진다 (U32)
          if (error instanceof ApiFailure && error.code === 'game-in-progress') {
            throw new LeaveRoomRejected('game-in-progress');
          }
          if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
        }
        commitRoomMutation(normalized, requestGeneration);
      }
      return { ok: true };
    },
    getRoom,
    removeMember,
    updateRoom,
    setReady,
    async sendChat({ code, text, player }) {
      const normalized = normalizeCode(code);
      if (!CODE_PATTERN.test(normalized)) return { ok: false };
      try {
        await request(`/v1/rooms/${encodeURIComponent(normalized)}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }, player);
        return { ok: true };
      } catch (error) {
        // 요청 한도(429)는 «보내지 못했다»가 아니라 «잠시 뒤에»다. 서버의 말(«채팅은 잠시 뒤…»)을
        // 화면이 쓸 수 있게 그대로 던진다 (U40) — `{ok: false}`에는 이유가 실리지 않는다
        if (
          error instanceof ApiFailure && error.status >= 400 && error.status < 500 && error.status !== 429
        ) {
          return { ok: false };
        }
        throw error;
      }
    },
    sendMovement,
    sendStandingAnswer,
    onlineRules: () => learnedRules,
    getOnlineRankings,
    startGame,
    getMatch,
    submitMatchAnswer,
    subscribe,
  };
}
