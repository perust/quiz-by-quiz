import { CATEGORIES, ROOM_CAPACITY_CHOICES } from '../constants.js';
import { DEFAULT_CHARACTER_ID } from '../characters.js';
import type { KeyValueStorage } from '../storage/safe-storage.js';
import type { CategoryId } from '../types.js';
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
  OnlineReveal,
  OnlineRevealingMatch,
  OnlineReviewItem,
  OnlineRunningMatch,
  OnlineScore,
  PlayerInfo,
  PublicPlayer,
  PublicRoom,
  RoomActionResult,
  RoomEvent,
  RoomEventHandler,
  RoomPatch,
  RoomStore,
  ReadyResult,
  StartGameResult,
  Unsubscribe,
} from './adapter.js';
import {
  isWaitingRoomSeatId,
  MOVEMENT_VIEWPORT_CAPABILITY,
  type MovementViewport,
  type WaitingRoomSeatId,
  validMovementViewportDimension,
  WAITING_ROOM_SEAT_CAPABILITY,
} from './movement-contract.js';
import {
  LeaveRoomRejected,
  normalizeCode,
  OnlinePlayerError,
  type JoinFailReason,
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
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CODE_PATTERN = /^[A-Z0-9]{6}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const RECONNECT_DELAY_MS = 1_000;
const WEBSOCKET_PROTOCOL = 'qbb.v1';
const WEBSOCKET_TICKET_PREFIX = 'qbb.ticket.';

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
  latest: ({
    type: 'movement';
    x: number;
    y: number;
    moving: boolean;
    seatId?: WaitingRoomSeatId;
  } & MovementViewport) | null;
}

export interface NetworkRoomStoreOptions {
  baseUrl: string;
  storage: KeyValueStorage;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocketLike;
  newIdentity?: () => BrowserIdentity;
}

/** 서버가 이유를 말하지 않았거나(5xx·형식 밖 응답) 그 말이 개발 용어일 때 플레이어가 보는 말 (U40) */
const SERVICE_TROUBLE_MESSAGE = '온라인 연결이 잠시 원활하지 않아요. 잠시 후 다시 시도해 주세요.';
/** 요청이 REQUEST_TIMEOUT_MS 안에 끝나지 않았을 때 (U40) */
const TIMEOUT_MESSAGE = '응답이 늦어요. 연결을 확인하고 다시 시도해 주세요.';

/**
 * HTTP 거절. `message`는 화면에 그대로 띄워도 되는 말이다 — 서버가 4xx로 알려 준 이유이거나
 * `SERVICE_TROUBLE_MESSAGE`다. 상태·코드 같은 개발 상세는 필드와 콘솔에만 남긴다.
 */
class ApiFailure extends OnlinePlayerError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

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

  return {
    code: value.code,
    name: value.name,
    categoryId: categoryId as CategoryId | null,
    capacity,
    gameMode: true,
    players: players.map(parsePlayer),
    isPublic: value.isPublic,
    hasPassword: value.hasPassword,
    isMine: value.isMine,
    joined: value.joined,
    createdAt: value.createdAt,
    status,
    inMatch,
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
  const base = {
    matchId,
    categoryId,
    gameMode: true as const,
    currentPosition,
    totalQuestions,
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
    } satisfies OnlineFinishedMatch;
  }
  throw new Error('서버 매치 상태가 올바르지 않습니다.');
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

function failureFrom(status: number, body: unknown): ApiFailure {
  const detail = isObject(body) && isObject(body.detail) ? body.detail : null;
  const code = detail && typeof detail.code === 'string' ? detail.code : 'request-failed';
  const serverMessage = detail && typeof detail.message === 'string' ? detail.message : null;
  // 4xx의 이유는 서버가 플레이어에게 쓴 말이다(«이미 다음 문제로 넘어갔습니다»). 5xx나 이유 없는
  // 응답은 «데이터베이스…» 같은 개발 상세라 콘솔에만 남기고 화면에는 한 가지 말을 쓴다 (U40)
  if (serverMessage !== null && status < 500) return new ApiFailure(status, code, serverMessage);
  console.warn(`[온라인 오류] 요청 실패 (${status} ${code})`, serverMessage ?? '');
  return new ApiFailure(status, code, SERVICE_TROUBLE_MESSAGE);
}

export function createNetworkRoomStore(options: NetworkRoomStoreOptions): RoomStore {
  const baseUrl = configuredBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const socketFactory = options.webSocketFactory
    ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols));
  const identityFactory = options.newIdentity ?? randomIdentity;
  let identity = readIdentity(options.storage, identityFactory);
  let playerProfile: PlayerInfo = {
    nickname: '손님',
    characterId: DEFAULT_CHARACTER_ID,
  };
  let sessionFingerprint: string | null = null;
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
      if (!response.ok) throw failureFrom(response.status, body);
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

  async function createRoom(spec: CreateRoomSpec): Promise<CreateRoomResult> {
    try {
      const value = await request('/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: spec.name,
          categoryId: spec.categoryId,
          capacity: spec.capacity,
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
    requestGeneration: number;
  }> {
    const requestGeneration = beginRoomSnapshotRequest();
    try {
      return {
        room: parseRoom(await request(`/v1/rooms/${encodeURIComponent(code)}`)),
        requestGeneration,
      };
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) {
        return { room: null, requestGeneration };
      }
      throw error;
    }
  }

  async function getRoom(rawCode: string): Promise<PublicRoom | null> {
    const code = normalizeCode(rawCode);
    if (!CODE_PATTERN.test(code)) return null;
    return (await fetchRoomSnapshot(code)).room;
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
    code: rawCode, x, y, moving, viewportWidth, viewportHeight, seatId,
  }: {
    code: string;
    x: number;
    y: number;
    moving: boolean;
    seatId?: WaitingRoomSeatId;
  } & MovementViewport): boolean {
    const code = normalizeCode(rawCode);
    if (
      !CODE_PATTERN.test(code)
      || !Number.isFinite(x) || x < 0 || x > 1
      || !Number.isFinite(y) || y < 0 || y > 1
      || typeof moving !== 'boolean'
      || (seatId !== undefined && (!isWaitingRoomSeatId(seatId) || moving))
      || !validMovementViewportDimension(viewportWidth)
      || !validMovementViewportDimension(viewportHeight)
    ) return false;
    const channel = movementChannels.get(code);
    if (!channel) return false;
    channel.latest = {
      type: 'movement', x, y, moving, viewportWidth, viewportHeight,
      ...(seatId !== undefined ? { seatId } : {}),
    };
    if (channel.socket?.readyState !== 1) return false;
    try {
      const payload = movementPayload(channel);
      if (!payload) return false;
      channel.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      channel.socket.close();
      return false;
    }
  }

  function subscribe(rawCode: string, handler: RoomEventHandler): Unsubscribe {
    const code = normalizeCode(rawCode);
    if (!CODE_PATTERN.test(code)) return () => undefined;

    const mutationState = retainRoomMutationState(code);
    let stopped = false;
    let socket: WebSocketLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let generation = 0;
    let latestDeliveredRoomGeneration = 0;
    /** room 재조회가 지금 날아가는 중인가. 한 subscription에 하나만 띄운다. */
    let roomRefreshInFlight = false;
    /** 그 사이 무효화가 또 왔는가. 몇 번이 오든 끝난 뒤 한 번만 더 읽는다. */
    let roomRefreshQueued = false;
    const movementChannel: MovementChannel = {
      socket: null,
      supportsViewport: false,
      supportsSeat: false,
      latest: null,
    };
    movementChannels.set(code, movementChannel);

    function clearTimers(): void {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (pingTimer !== null) clearInterval(pingTimer);
      reconnectTimer = null;
      pingTimer = null;
    }

    function scheduleReconnect(): void {
      if (stopped || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, RECONNECT_DELAY_MS);
    }

    async function refreshRoom(connectionGeneration: number): Promise<void> {
      const { room, requestGeneration } = await fetchRoomSnapshot(code);
      if (stopped || connectionGeneration !== generation) return;
      if (requestGeneration < latestDeliveredRoomGeneration) return;
      if (requestGeneration < mutationState.committedGeneration) return;
      latestDeliveredRoomGeneration = requestGeneration;
      if (room) handler({ type: 'room', room });
    }

    /**
     * room-invalidated와 재연결 복구가 부르는 재조회. **요청을 합친다** — 방송 하나에 방
     * 전원이 GET을 보내므로, 준비 토글이 몰리면 무효화마다 한 번씩 읽는 것만으로 IP·프로세스
     * 요청 한도를 먼저 먹는다. 날아가는 요청이 있으면 표시만 해 두고, 끝나면 최신 상태를
     * 한 번 더 읽는다(그사이 몇 번이 왔든 한 번). 실패해도 다음 무효화·재연결이 다시 맞춘다.
     */
    function requestRoomRefresh(): void {
      if (stopped) return;
      if (roomRefreshInFlight) {
        roomRefreshQueued = true;
        return;
      }
      roomRefreshInFlight = true;
      void (async () => {
        try {
          do {
            roomRefreshQueued = false;
            await refreshRoom(generation).catch(() => undefined);
          } while (roomRefreshQueued && !stopped);
        } finally {
          roomRefreshInFlight = false;
        }
      })();
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
        requestRoomRefresh();
        return;
      }
      const hasViewportWidth = Object.hasOwn(value, 'viewportWidth');
      const hasViewportHeight = Object.hasOwn(value, 'viewportHeight');
      const hasSeat = Object.hasOwn(value, 'seatId');
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

        const url = new URL(endpoint(`/v1/rooms/${encodeURIComponent(code)}/events`));
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const connected = socketFactory(url.toString(), [
          WEBSOCKET_PROTOCOL,
          `${WEBSOCKET_TICKET_PREFIX}${ticketBody.ticket}`,
        ]);
        socket = connected;
        movementChannel.socket = connected;
        connected.addEventListener('open', () => {
          if (stopped || connected !== socket) return;
          clearTimers();
          const latest = movementPayload(movementChannel);
          if (latest && connected.readyState === 1) {
            connected.send(JSON.stringify(latest));
          }
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
          }
          if (pingTimer !== null) clearInterval(pingTimer);
          pingTimer = null;
          scheduleReconnect();
        });
        connected.addEventListener('error', () => connected.close());
      } catch {
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
    startGame,
    getMatch,
    submitMatchAnswer,
    subscribe,
  };
}
