import { CATEGORIES, ROOM_CAPACITY_CHOICES } from '../constants.js';
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
import { normalizeCode, type JoinFailReason } from './rules.js';

const IDENTITY_KEY = 'quiz.online.identity.v1';
const CATEGORIES_SET = new Set<string>(CATEGORIES.map(({ id }) => id));
const JOIN_FAILURES = new Set<JoinFailReason>([
  'not-found',
  'wrong-password',
  'need-password',
  'full',
  'save-failed',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export interface NetworkRoomStoreOptions {
  baseUrl: string;
  storage: KeyValueStorage;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocketLike;
  newIdentity?: () => BrowserIdentity;
}

class ApiFailure extends Error {
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
  if (characterId !== null && characterId !== undefined && typeof characterId !== 'string') {
    throw new Error('서버 참가자 캐릭터가 올바르지 않습니다.');
  }
  if (typeof value.isReady !== 'boolean') {
    throw new Error('서버 참가자 준비 상태가 올바르지 않습니다.');
  }
  return {
    id: value.id,
    nickname: value.nickname,
    ...(typeof characterId === 'string' ? { characterId } : {}),
    isReady: value.isReady,
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
    typeof value.gameMode !== 'boolean'
    || typeof value.isPublic !== 'boolean'
    || typeof value.hasPassword !== 'boolean'
    || typeof value.isMine !== 'boolean'
    || typeof value.joined !== 'boolean'
  ) {
    throw new Error('서버 방 상태가 올바르지 않습니다.');
  }
  if (value.isPublic === value.hasPassword || (value.isMine && !value.joined)) {
    throw new Error('서버 방 공개 상태가 서로 맞지 않습니다.');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('서버 방 생성 시각이 올바르지 않습니다.');
  }

  return {
    code: value.code,
    name: value.name,
    categoryId: categoryId as CategoryId | null,
    capacity,
    gameMode: value.gameMode,
    players: players.map(parsePlayer),
    isPublic: value.isPublic,
    hasPassword: value.hasPassword,
    isMine: value.isMine,
    joined: value.joined,
    createdAt: value.createdAt,
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
  if (typeof value.gameMode !== 'boolean') {
    throw new Error('서버 게임 모드가 올바르지 않습니다.');
  }
  return { categoryId: value.categoryId as CategoryId | null, gameMode: value.gameMode };
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

function parseScores(value: unknown): OnlineScore[] {
  if (!Array.isArray(value)) throw new Error('서버 점수판이 올바르지 않습니다.');
  return value.map((row) => {
    if (!isObject(row)) throw new Error('서버 점수 행이 올바르지 않습니다.');
    const playerId = row.playerId;
    if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId) || typeof row.nickname !== 'string' || !row.nickname.trim()) {
      throw new Error('서버 점수 참가자가 올바르지 않습니다.');
    }
    if (row.characterId !== null && typeof row.characterId !== 'string') {
      throw new Error('서버 점수 캐릭터가 올바르지 않습니다.');
    }
    return {
      playerId,
      nickname: row.nickname,
      characterId: row.characterId,
      score: parseInteger(row.score, '점수'),
      correctCount: parseInteger(row.correctCount, '정답 수'),
      answeredCount: parseInteger(row.answeredCount, '제출 수'),
    };
  });
}

function parseMatchSnapshot(value: unknown): OnlineMatchSnapshot {
  if (!isObject(value)) throw new Error('서버 매치 snapshot이 올바르지 않습니다.');
  const matchId = value.matchId;
  if (typeof matchId !== 'string' || !UUID_PATTERN.test(matchId)) throw new Error('서버 매치 ID가 올바르지 않습니다.');
  const categoryId = parseCategoryId(value.categoryId, '매치 분야');
  if (typeof value.gameMode !== 'boolean') throw new Error('서버 매치 모드가 올바르지 않습니다.');
  const totalQuestions = parseInteger(value.totalQuestions, '매치 문제 수', 1);
  const currentPosition = parseInteger(value.currentPosition, '매치 문제 순서', 1);
  if (currentPosition > totalQuestions) throw new Error('서버 매치 진행 상태가 올바르지 않습니다.');
  const base = {
    matchId,
    categoryId,
    gameMode: value.gameMode,
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
      state: 'revealing',
      question,
      ownSubmission: null,
      reveal: parseReveal(value.reveal),
      scores: parseScores(value.scores),
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
    return {
      ...base,
      deadlineAt: null,
      state: 'finished',
      question: null,
      ownSubmission: null,
      reveal: null,
      scores: parseScores(value.scores),
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
  const message = detail && typeof detail.message === 'string'
    ? detail.message
    : `온라인 서버 요청에 실패했습니다. (${status})`;
  return new ApiFailure(status, code, message);
}

export function createNetworkRoomStore(options: NetworkRoomStoreOptions): RoomStore {
  const baseUrl = configuredBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const socketFactory = options.webSocketFactory
    ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols));
  const identityFactory = options.newIdentity ?? randomIdentity;
  let identity = readIdentity(options.storage, identityFactory);
  let sessionFingerprint: string | null = null;
  let roomSnapshotRequestGeneration = 0;
  const activeRoomMutationStates = new Map<string, {
    committedGeneration: number;
    subscribers: number;
  }>();

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
        throw new Error('온라인 서버 응답 시간이 너무 오래 걸립니다.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function profileBody(player?: PlayerInfo): Record<string, string> {
    if (!player) return {};
    return {
      nickname: player.nickname,
      ...(player.characterId ? { characterId: player.characterId } : {}),
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

    function receive(data: unknown, connectionGeneration: number): void {
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
        void refreshRoom(connectionGeneration).catch(() => undefined);
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
        try {
          handler({ type: 'match', phase: 'started', setup: parseMatchSetup(value) });
        } catch {
          // 계약에 맞지 않는 서버 이벤트는 화면 상태를 바꾸지 않는다.
        }
      }
    }

    async function connect(): Promise<void> {
      const connectionGeneration = ++generation;
      try {
        const ticketBody = await request(`/v1/rooms/${encodeURIComponent(code)}/ws-ticket`, {
          method: 'POST',
        });
        if (!isObject(ticketBody) || typeof ticketBody.ticket !== 'string') {
          throw new Error('온라인 서버가 WebSocket 티켓을 보내지 않았습니다.');
        }
        if (stopped || connectionGeneration !== generation) return;

        const url = new URL(endpoint(`/v1/rooms/${encodeURIComponent(code)}/events`));
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const connected = socketFactory(url.toString(), [
          WEBSOCKET_PROTOCOL,
          `${WEBSOCKET_TICKET_PREFIX}${ticketBody.ticket}`,
        ]);
        socket = connected;
        connected.addEventListener('open', () => {
          if (stopped || connected !== socket) return;
          clearTimers();
          // 연결이 끊긴 동안 room-invalidated를 놓쳤을 수 있으므로 room과 match를
          // 모두 권위 있는 REST snapshot으로 다시 맞춘다.
          void refreshRoom(connectionGeneration).catch(() => undefined);
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
      releaseRoomMutationState(code, mutationState);
    };
  }

  return {
    isNetworked: true,
    isPersistent: true,
    me: () => identity.id,
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
        if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) {
          return { ok: false };
        }
        throw error;
      }
    },
    startGame,
    getMatch,
    submitMatchAnswer,
    subscribe,
  };
}
