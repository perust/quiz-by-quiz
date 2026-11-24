// 오늘의 퀴즈 (daily) — 날짜 열쇠·출제·저장 레코드의 검증과 충돌 규칙.
// DOM 도 저장소도 모르는 순수 로직이다. 저장은 저장소 층의 `daily-store.ts`, 화면 흐름은 `ui/daily.ts` 가 맡는다.
//
// - 날짜는 **Asia/Seoul** 의 달력 날짜다. 한국은 1988년 뒤로 서머타임이 없어 UTC+9 고정으로 셈한다 —
//   브라우저의 시간대(`Intl`·`Date#getHours`)를 읽지 않으므로 어느 나라에서 열어도 같은 날짜다.
// - 출제는 같은 날짜·같은 은행 판이면 언제나 같다. 은행의 배열 순서·최근 출제 기록·새로고침과 무관하다 —
//   문제를 ID 로 정렬하고, 날짜에서 만든 씨앗으로만 고른다. 분야 다섯에서 하나씩, 보기 순서도 씨앗으로 섞는다.
//   분야 하나라도 비었거나 분야 정의가 다섯이 아니면 **대신 아무 문제나 채우지 않고** 만들지 않는다.
// - 시간 제한이 없다. 일반 판의 문항 시간 설정은 건드리지 않는다.

import { CATEGORIES, CHOICE_COUNT } from '../constants.js';
import { validateQuestion } from '../data/validate.js';
import { shuffle, shuffleChoices } from './sampler.js';
import { createSession, type QuizSession, type SubmitInput } from './session.js';
import type { AnswerRecord, Category, CategoryId, Question } from '../types.js';

/** 하루에 푸는 문제 수 — 분야마다 하나 */
export const DAILY_QUESTION_COUNT = 5;

/** 저장 레코드의 판. 모양이 바뀌면 올린다 — 모르는 판은 읽지 않는다 */
export const DAILY_SCHEMA = 'quiz.daily.v1';

/** Asia/Seoul 은 UTC+9 고정이다 (1988년 뒤로 서머타임 없음) */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 그 순간의 Asia/Seoul 달력 날짜 `YYYY-MM-DD`. KST 자정에 바뀐다 */
export function dailyDateKey(nowMs: number): string {
  if (!Number.isFinite(nowMs)) throw new Error(`시각이 올바르지 않습니다: ${nowMs}`);
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 실제로 있는 날짜의 `YYYY-MM-DD` 인가 */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 화면의 날짜 이름: «11월 24일» */
export function dailyDateLabel(dateKey: string): string {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return '';
  return `${Number(match[2])}월 ${Number(match[3])}일`;
}

/**
 * 글 하나의 53비트 해시 (cyrb53). 암호용이 아니다 — 같은 글이면 어느 엔진에서도 같은 값이 나오고,
 * 다른 글이면 거의 언제나 다른 값이 나오면 된다. 16진 14자리 이하의 글로 돌려준다.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** 글에서 씨앗을 만든 결정적 난수 (mulberry32). `Math.random` 자리에 넘긴다 */
export function seededRandom(seedText: string): () => number {
  let state = Number.parseInt(hashText(seedText).slice(-8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 문자열의 코드 단위 순서. `localeCompare` 는 엔진·언어 설정마다 달라 쓰지 않는다 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 문제 한 개의 내용 지문. 화면에 나온 보기 순서까지 담는다 — 순서가 바뀐 문제는 다른 문제다 */
export function questionFingerprint(question: Question): string {
  return hashText(JSON.stringify([
    question.id,
    question.category,
    question.question,
    question.choices,
    question.answerIndex,
    question.explanation,
  ]));
}

/** 분야 정의와 은행에서 오늘의 퀴즈가 쓸 수 있는 문제. 분야마다 ID 순서다 */
interface DailyPool {
  category: CategoryId;
  questions: Question[];
}

export type DailyBuildFailure =
  /** 분야 정의가 다섯 개의 서로 다른 분야가 아니다 */
  | 'categories'
  /** 문제가 하나도 없는(못 받았거나 모두 불량인) 분야가 있다 */
  | 'missing-category';

export type DailyBuild =
  | { ok: true; dateKey: string; bankVersion: string; questions: Question[] }
  | { ok: false; dateKey: string; reason: DailyBuildFailure; categories: CategoryId[] };

export interface DailyBuildParams {
  dateKey: string;
  /** 분야 코드 → 문제. 불러오지 못한 분야는 빈 배열이다 (`data/loader.ts`) */
  banks: Partial<Record<CategoryId, readonly unknown[]>>;
  /** 분야 정의. 생략하면 `CATEGORIES` */
  categories?: readonly Pick<Category, 'id'>[];
}

/** 분야마다 검증을 지난 문제를 ID 순서로 모은다. 다른 분야의 문제·겹친 ID·불량 문제는 뺀다 */
function dailyPools(banks: DailyBuildParams['banks'], categories: readonly CategoryId[]): DailyPool[] {
  const seen = new Set<string>();
  return categories.map((category) => {
    const valid: Question[] = [];
    for (const candidate of banks[category] ?? []) {
      if (validateQuestion(candidate, category).length > 0) continue;
      // validateQuestion 이 id·category·question·choices·answerIndex·explanation 을 확인했다
      const question = candidate as Question;
      valid.push(question);
    }
    valid.sort((a, b) => byCodeUnit(a.id, b.id));
    const unique = valid.filter((question) => {
      if (seen.has(question.id)) return false;
      seen.add(question.id);
      return true;
    });
    return { category, questions: unique };
  });
}

/**
 * 은행의 판. 오늘의 퀴즈가 쓰는 문제 내용(ID 순서)에서 만든다 — 배열 순서가 달라도 같고, 문제 하나의 글이나
 * 보기·정답이 바뀌면 다르다.
 */
function poolVersion(pools: readonly DailyPool[]): string {
  return hashText(pools.map(({ category, questions }) =>
    `${category}:${questions.map(questionFingerprint).join(',')}`).join('|'));
}

/** 분야 정의가 정확히 다섯 개의 서로 다른 분야인가. 정렬한 코드를 돌려준다 */
function expectedCategories(categories: readonly Pick<Category, 'id'>[]): CategoryId[] | null {
  const ids = [...new Set(categories.map((category) => category.id))].sort(byCodeUnit);
  if (categories.length !== DAILY_QUESTION_COUNT || ids.length !== DAILY_QUESTION_COUNT) return null;
  return ids;
}

/**
 * 그 날짜의 다섯 문제. 분야마다 하나를 고르고(ID 로 정렬한 목록에서 씨앗으로), 문제 순서와 보기 순서를
 * 씨앗으로 섞는다. 고른 문제는 원본을 건드리지 않은 새 객체다.
 */
export function buildDailyQuestions({ dateKey, banks, categories = CATEGORIES }: DailyBuildParams): DailyBuild {
  if (!isDateKey(dateKey)) throw new Error(`날짜가 올바르지 않습니다: ${dateKey}`);
  const ids = expectedCategories(categories);
  if (!ids) return { ok: false, dateKey, reason: 'categories', categories: [] };

  const pools = dailyPools(banks, ids);
  const empty = pools.filter((pool) => pool.questions.length === 0).map((pool) => pool.category);
  if (empty.length > 0) return { ok: false, dateKey, reason: 'missing-category', categories: empty };

  const bankVersion = poolVersion(pools);
  const picked = pools.map(({ category, questions }) => {
    const random = seededRandom(`daily|pick|${dateKey}|${bankVersion}|${category}`);
    return questions[Math.floor(random() * questions.length)];
  });
  const ordered = shuffle(picked, seededRandom(`daily|order|${dateKey}|${bankVersion}`));
  const questions = ordered.map((question) =>
    shuffleChoices(question, seededRandom(`daily|choices|${dateKey}|${question.id}`)));
  return { ok: true, dateKey, bankVersion, questions };
}

// ── 저장 레코드 ──────────────────────────────────────────────────

/** 확정한 답 하나. 보기 번호는 레코드에 담긴 **그 문제의 보기 순서** 위의 번호다 */
export interface DailyAnswer {
  questionId: string;
  choiceIndex: number;
  correct: boolean;
  elapsedMs: number;
}

/**
 * 하루 한 판의 저장 레코드. 화면에 낸 문제(보기 순서까지)를 그대로 담아, 저장된 답 번호는 언제나 같은 보기
 * 순서 위에서만 읽힌다. 은행이 바뀌어도 끝낸 판의 결과는 이것만으로 다시 그린다.
 */
export interface DailyRecord {
  schema: typeof DAILY_SCHEMA;
  dateKey: string;
  bankVersion: string;
  /** 판을 연 탭의 표식. 여러 탭이 같은 날을 풀 때 누가 썼는지 가린다 */
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  /** 다섯 문제에 모두 답해 저장한 시각. 아니면 null */
  completedAt: string | null;
  questions: Question[];
  /** questions[i] 의 지문. 레코드가 손상되거나 고쳐졌는지 본다 */
  fingerprints: string[];
  answers: DailyAnswer[];
}

/** 새 판의 레코드 (아직 답이 없다) */
export function createDailyRecord(
  build: Extract<DailyBuild, { ok: true }>,
  { sessionId, nowMs }: { sessionId: string; nowMs: number },
): DailyRecord {
  const at = new Date(nowMs).toISOString();
  return {
    schema: DAILY_SCHEMA,
    dateKey: build.dateKey,
    bankVersion: build.bankVersion,
    sessionId,
    startedAt: at,
    updatedAt: at,
    completedAt: null,
    questions: build.questions.map((question) => ({ ...question, choices: [...question.choices], tags: [...(question.tags ?? [])] })),
    fingerprints: build.questions.map(questionFingerprint),
    answers: [],
  };
}

export function isDailyComplete(record: DailyRecord): boolean {
  return record.completedAt !== null && record.answers.length === record.questions.length;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** 날짜·시각 글인가 (ISO) */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * 저장소에서 읽은 값을 레코드로 좁힌다. 모양·판·날짜·문제 지문·답이 하나라도 어긋나면 null 이다 —
 * 깨진 레코드의 답 번호를 다른 보기 순서에 얹지 않는다. 정오는 저장된 값을 믿지 않고 다시 셈해 견준다.
 */
export function parseDailyRecord(raw: unknown, expectedDateKey: string): DailyRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.schema !== DAILY_SCHEMA) return null;
  if (value.dateKey !== expectedDateKey || !isDateKey(value.dateKey)) return null;
  if (!isText(value.bankVersion) || !isText(value.sessionId)) return null;
  if (!isTimestamp(value.startedAt) || !isTimestamp(value.updatedAt)) return null;
  if (value.completedAt !== null && !isTimestamp(value.completedAt)) return null;
  if (!Array.isArray(value.questions) || value.questions.length !== DAILY_QUESTION_COUNT) return null;
  if (!Array.isArray(value.fingerprints) || value.fingerprints.length !== DAILY_QUESTION_COUNT) return null;
  if (!Array.isArray(value.answers) || value.answers.length > DAILY_QUESTION_COUNT) return null;

  const categories = new Set<unknown>();
  const ids = new Set<unknown>();
  for (const [index, question] of value.questions.entries()) {
    if (validateQuestion(question).length > 0) return null;
    const candidate = question as Question;
    if (!CATEGORIES.some((category) => category.id === candidate.category)) return null;
    categories.add(candidate.category);
    ids.add(candidate.id);
    if (questionFingerprint(candidate) !== value.fingerprints[index]) return null;
  }
  if (categories.size !== DAILY_QUESTION_COUNT || ids.size !== DAILY_QUESTION_COUNT) return null;
  const questions = value.questions as Question[];

  const answers: DailyAnswer[] = [];
  for (const [index, answer] of value.answers.entries()) {
    if (answer === null || typeof answer !== 'object') return null;
    const { questionId, choiceIndex, correct, elapsedMs } = answer as Record<string, unknown>;
    const question = questions[index];
    if (typeof questionId !== 'string' || questionId !== question.id) return null;
    if (!Number.isInteger(choiceIndex) || (choiceIndex as number) < 0 || (choiceIndex as number) >= CHOICE_COUNT) return null;
    if (typeof correct !== 'boolean' || correct !== (choiceIndex === question.answerIndex)) return null;
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
    answers.push({ questionId, choiceIndex: choiceIndex as number, correct, elapsedMs });
  }

  const complete = answers.length === DAILY_QUESTION_COUNT;
  if (complete !== (value.completedAt !== null)) return null;

  return {
    schema: DAILY_SCHEMA,
    dateKey: value.dateKey,
    bankVersion: value.bankVersion,
    sessionId: value.sessionId,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt as string | null,
    questions: questions.map((question) => ({ ...question, choices: [...question.choices] })),
    fingerprints: [...value.fingerprints] as string[],
    answers,
  };
}

// ── 저장소 계약 ──────────────────────────────────────────────────
// 구현은 저장소 층의 `daily-store.ts` 이고 `app.ts` 가 만들어 흐름(`ui/daily.ts`)에 넘긴다. core·ui 는 저장소를 import 하지 않는다.

/** 저장소에서 읽은 그 날짜의 상태 */
export type DailyLoad =
  | { kind: 'empty' }
  /** 읽었지만 모양·판·지문이 어긋났다. 그 답을 쓰지 않는다 — 새 판의 첫 확정이 덮는다 */
  | { kind: 'corrupt' }
  | { kind: 'record'; record: DailyRecord };

export interface DailyStore {
  /** 이 저장소가 새로고침 뒤에도 남는가. 아니면 화면이 «이 창을 닫으면 사라져요»를 말한다 */
  readonly durable: boolean;
  load(dateKey: string): DailyLoad;
  /**
   * 레코드를 저장한다. 저장소의 것이 이기면 그것을 돌려준다(`adopted`). 쓰지 못했으면 `memory` 이고 넘긴 레코드를
   * 그대로 돌려준다 — 이 창 안에서는 이어 갈 수 있다
   */
  save(record: DailyRecord): { status: DailySaveStatus; record: DailyRecord };
}

/** 두 레코드가 같은 문제(보기 순서까지)를 냈는가 */
export function sameDailyQuestions(a: Pick<DailyRecord, 'fingerprints'>, b: Pick<DailyRecord, 'fingerprints'>): boolean {
  return a.fingerprints.length === b.fingerprints.length
    && a.fingerprints.every((fingerprint, index) => fingerprint === b.fingerprints[index]);
}

/** prefix 의 답이 모두 full 의 앞부분과 같은가 */
function answersExtend(full: readonly DailyAnswer[], prefix: readonly DailyAnswer[]): boolean {
  return prefix.length <= full.length && prefix.every((answer, index) =>
    answer.questionId === full[index].questionId && answer.choiceIndex === full[index].choiceIndex);
}

/** 저장할 때 저장소에 이미 있는 것과 견준 결정 */
export type DailyWritePlan =
  | { action: 'write' }
  /** 저장소의 것이 이긴다. 그것으로 이어 간다(다른 탭이 앞섰거나 이미 끝냈다) */
  | { action: 'adopt'; record: DailyRecord };

/**
 * 같은 날의 레코드를 쓸 때의 충돌 규칙. 읽은 직후·쓰기 직전에 부른다.
 *
 * 1. 저장소가 비었거나 깨졌으면 쓴다
 * 2. **끝낸 레코드는 덮지 않는다.** 저장소의 것이 끝났으면 그것을 따른다 (같은 레코드를 다시 쓰는 것만 허락한다)
 * 3. 같은 문제의 판이면 저장소의 답이 내 답의 앞부분일 때만 쓴다. 저장소가 앞서거나 다른 답을 먼저 냈으면
 *    그것을 따른다 — 확정한 답은 고칠 수 없고, 같은 문제를 두 번 채점하지 않는다
 * 4. 다른 문제의 판(은행이 바뀌기 전에 연 판)은 끝나지 않았으면 지금 은행의 판이 덮는다
 */
export function planDailyWrite(stored: DailyRecord | null, next: DailyRecord): DailyWritePlan {
  if (!stored) return { action: 'write' };
  if (stored.dateKey !== next.dateKey) throw new Error('다른 날짜의 레코드를 견줄 수 없습니다');
  if (isDailyComplete(stored)) {
    const same = sameDailyQuestions(stored, next) && isDailyComplete(next)
      && answersExtend(stored.answers, next.answers) && stored.sessionId === next.sessionId;
    return same ? { action: 'write' } : { action: 'adopt', record: stored };
  }
  if (!sameDailyQuestions(stored, next)) return { action: 'write' };
  return answersExtend(next.answers, stored.answers) ? { action: 'write' } : { action: 'adopt', record: stored };
}

/** 답 하나를 더한 새 레코드. 이미 답한 문제거나 차례가 아니면 던진다 — 부르는 쪽이 중복을 걸렀어야 한다 */
export function appendDailyAnswer(
  record: DailyRecord,
  answer: Pick<AnswerRecord, 'questionId' | 'choiceIndex' | 'elapsedMs'>,
  nowMs: number,
): DailyRecord {
  const index = record.answers.length;
  const question = record.questions[index];
  if (!question || question.id !== answer.questionId) throw new Error('지금 차례의 문제가 아닙니다');
  if (answer.choiceIndex === null || !Number.isInteger(answer.choiceIndex)) throw new Error('오늘의 퀴즈에는 시간 초과가 없습니다');
  const at = new Date(nowMs).toISOString();
  const answers = [...record.answers, {
    questionId: question.id,
    choiceIndex: answer.choiceIndex,
    correct: answer.choiceIndex === question.answerIndex,
    elapsedMs: Math.max(0, answer.elapsedMs),
  }];
  return {
    ...record,
    updatedAt: at,
    completedAt: answers.length === record.questions.length ? at : null,
    answers,
  };
}

/** 레코드의 답을 채점 기록 모양으로. 결과·풀이 화면이 `core/scoring.ts` 를 그대로 쓴다 */
export function dailyAnswerRecords(record: DailyRecord): AnswerRecord[] {
  return record.answers.map((answer, index) => ({
    questionId: answer.questionId,
    category: record.questions[index].category,
    choiceIndex: answer.choiceIndex,
    answerIndex: record.questions[index].answerIndex,
    correct: answer.correct,
    timedOut: false,
    elapsedMs: answer.elapsedMs,
  }));
}

// ── 판 ──────────────────────────────────────────────────────────

/** 확정한 답을 저장한 뒤의 상태. 화면이 «저장했어요»를 말할지 정한다 */
export type DailySaveStatus =
  /** 이 기기의 저장소에 쓰고 다시 읽어 확인했다 */
  | 'saved'
  /** 저장소를 못 써 이 창의 메모리에만 있다 — 새로고침하면 사라진다 */
  | 'memory'
  /** 다른 탭의 기록이 앞서 그것으로 이어 간다 */
  | 'adopted';

export interface DailySessionHooks {
  /**
   * 답 하나를 확정한 **즉시**(채점 직후, 화면이 결과를 그리기 전에) 부른다. 같은 문항의 두 번째 확정에는 부르지 않는다.
   * 저장소가 이긴 레코드를 돌려주면(`adopted`) 판은 「다음」에서 그 레코드로 갈아탄다
   */
  onConfirm: (record: DailyRecord, answer: AnswerRecord) => { status: DailySaveStatus; record: DailyRecord };
}

/** 오늘의 퀴즈 판. 퀴즈 화면이 그대로 돌리는 `QuizSession` 이고 지금의 레코드를 함께 들고 있다 */
export interface DailySession extends QuizSession {
  readonly dateKey: string;
  /** 지금까지 확정해 저장소에 넘긴(또는 이어받은) 레코드 */
  record(): DailyRecord;
  /** 마지막 확정의 저장 상태. 아직 답하지 않았으면 null */
  lastSave(): DailySaveStatus | null;
}

/** 레코드의 답을 다시 밟아 다음에 풀 문제에 선 세션을 만든다. 시간 제한이 없다 */
function replay(record: DailyRecord): QuizSession {
  const base = createSession({ questions: record.questions, mode: 'all', categoryId: null, timeLimitMs: null });
  for (const answer of record.answers) {
    base.submit({ choiceIndex: answer.choiceIndex, elapsedMs: answer.elapsedMs });
    if (base.hasNext()) base.goNext();
  }
  return base;
}

/**
 * 레코드에서 이어 푸는 판. 이미 답한 문제는 건너뛰고 첫 번째 안 푼 문제부터다. 끝낸 레코드로는 만들지 않는다 —
 * 끝낸 날은 결과만 다시 본다(점수가 바뀌는 다시 풀기가 없다).
 *
 * 확정은 저장을 마친 뒤에야 화면으로 돌아간다(`onConfirm` 이 동기다). 저장소가 다른 탭의 레코드를 돌려주면
 * 「다음」을 누를 때 그 레코드의 다음 안 푼 문제로 갈아탄다 — 그 레코드가 끝났으면 «결과 보기»로 끝난다.
 */
export function createDailySession(start: DailyRecord, { onConfirm }: DailySessionHooks): DailySession {
  if (isDailyComplete(start)) throw new Error('끝낸 오늘의 퀴즈는 다시 풀 수 없습니다');
  let current = start;
  let base = replay(start);
  /** 다른 탭의 레코드로 갈아탈 차례. 지금 문항의 결과를 보인 뒤 「다음」에서 갈아탄다 */
  let pending: DailyRecord | null = null;
  let saved: DailySaveStatus | null = null;

  const session: DailySession = {
    mode: 'all',
    categoryId: null,
    timeLimitMs: null,
    dateKey: start.dateKey,
    get total() { return base.total; },
    get position() { return base.position; },
    get progressRatio() { return base.progressRatio; },
    currentQuestion: () => base.currentQuestion(),
    isAnswered: () => base.isAnswered(),
    submit(input: SubmitInput) {
      // 같은 문항의 두 번째 확정·갈아탈 레코드를 기다리는 동안의 확정은 처음 기록을 그대로 돌려준다 (FR-3.3)
      if (base.isAnswered() || pending) return base.submit(input);
      // 시간 제한이 없어 시간 초과가 없다. 그래도 들어오면 채점하지 않는다
      if (input.choiceIndex === null) throw new Error('오늘의 퀴즈에는 시간 초과가 없습니다');
      const answer = base.submit(input);
      const outcome = onConfirm(current, answer);
      saved = outcome.status;
      if (outcome.status === 'adopted') pending = outcome.record;
      else current = outcome.record;
      return answer;
    },
    hasNext() {
      if (pending) return !isDailyComplete(pending);
      return base.hasNext();
    },
    goNext() {
      if (pending) {
        current = pending;
        pending = null;
        base = replay(current);
        return base.currentQuestion();
      }
      return base.goNext();
    },
    isFinished: () => (pending ? isDailyComplete(pending) : base.isFinished()),
    getAnswers: () => (pending ? dailyAnswerRecords(pending) : base.getAnswers()),
    getQuestions: () => (pending ? [...pending.questions] : base.getQuestions()),
    getQuestionIds: () => (pending ? pending.questions.map((question) => question.id) : base.getQuestionIds()),
    record: () => pending ?? current,
    lastSave: () => saved,
  };
  return session;
}
