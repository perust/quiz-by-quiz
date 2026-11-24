// 오늘의 퀴즈 흐름 (daily). 홈 입구 → 20문제(퀴즈 화면 그대로) → 결과·풀이(«푼 문제» 화면 그대로).
//
// - 화면은 새로 만들지 않는다. 퀴즈 화면에 `DailySession`(시간 제한 없음)을 넘기고, 결과는 중간에 나온 판의
//   «푼 문제» 화면에 제목·저장 범위 한 줄만 바꿔 그린다. **결과 화면(`result.ts`)을 쓰지 않는다** — 그 화면은
//   떠날 때 랭킹에 자동 저장한다(FR-6.1). 오늘의 퀴즈는 랭킹·개인 기록·온라인 어디에도 남지 않는다
// - 답을 확정하는 즉시 저장한다(`DailySession` 의 `onConfirm`). 새로고침·홈으로 가도 첫 안 푼 문제부터 잇는다
// - 판은 연 날짜에 묶인다. 자정을 넘겨 끝내도 그 날짜의 기록이고, 홈은 늘 «지금»의 날짜를 따로 보인다
// - 끝낸 날은 결과만 다시 연다(점수가 바뀌는 다시 풀기가 없다)

import {
  DAILY_QUESTION_COUNT,
  buildDailyQuestions,
  createDailyRecord,
  createDailySession,
  dailyAnswerRecords,
  dailyDateKey,
  dailyDateLabel,
  isDailyComplete,
  planDailyWrite,
  sameDailyQuestions,
  questionFingerprint,
  appendDailyAnswer,
  type DailyBuild,
  type DailyRecord,
  type DailySaveStatus,
  type DailySession,
  type DailyStore,
} from '../core/daily.js';
import { dailyShareText } from '../core/daily-share.js';
import { reviewAnswered } from '../core/scoring.js';
import type { AnsweredReview, CategoryId } from '../types.js';

/** 홈 입구가 말하는 오늘의 상태 */
export type DailyHomeStatus =
  | { kind: 'new'; dateKey: string }
  | { kind: 'resume'; dateKey: string; answered: number }
  | { kind: 'done'; dateKey: string; correct: number }
  | { kind: 'unavailable'; dateKey: string };

/** 홈 입구의 보조 줄. 짧게 — 시작 전·이어 풀기 n/20·완료 */
export function dailyStatusText(status: DailyHomeStatus): string {
  switch (status.kind) {
    case 'new': return `${DAILY_QUESTION_COUNT}문제 · 시작 전`;
    case 'resume': return `이어 풀기 ${status.answered}/${DAILY_QUESTION_COUNT}`;
    case 'done': return `완료 · 결과 보기`;
    case 'unavailable': return '지금은 열 수 없어요';
  }
}

/** 화면 낭독용 상태 설명 (입구의 aria-describedby 가 읽는 글과 같다) */
export function dailyStatusDescription(status: DailyHomeStatus): string {
  const date = dailyDateLabel(status.dateKey);
  switch (status.kind) {
    case 'new': return `${date}, ${DAILY_QUESTION_COUNT}문제, 시작 전`;
    case 'resume': return `${date}, ${DAILY_QUESTION_COUNT}문제 중 ${status.answered}문제 풀었어요, 이어 풀기`;
    case 'done': return `${date}, 완료, ${DAILY_QUESTION_COUNT}문제 중 ${status.correct}개 정답, 결과 보기`;
    case 'unavailable': return `${date}, 지금은 열 수 없어요, 눌러서 다시 시도`;
  }
}

/** 확정 뒤 피드백에 붙는 저장 한 줄. 저장하지 못했으면 저장했다고 말하지 않는다 */
export function dailySaveNote(status: DailySaveStatus, complete: boolean): string {
  if (status === 'adopted') return '다른 창에서 먼저 저장한 기록으로 이어 가요';
  if (status === 'memory') return '저장하지 못했어요 · 이 창을 닫으면 사라져요';
  return complete ? '오늘의 퀴즈를 마쳤어요 · 이 기기에 저장했어요' : '이 기기에 저장했어요';
}

/** 나가기 확인의 본문. 오늘의 퀴즈는 나가도 푼 문제가 남는다 */
export function dailyExitNote(durable: boolean): string {
  return durable
    ? '푼 문제는 이 기기에 저장돼요. 홈의 「오늘의 퀴즈」에서 이어 풀 수 있어요.'
    : '저장하지 못하고 있어요. 이 창을 닫으면 푼 문제가 사라져요.';
}

/** 오늘의 퀴즈 결과의 저장 범위 한 줄. 화면 워커가 쉬는 오른쪽 자리를 남기도록 짧게 쓴다 */
export const DAILY_SCOPE = '이 기기에만 저장되고 랭킹·기록에는 남지 않아요.';
/** 끝내지 않은 판의 푼 문제 화면 */
export const DAILY_PARTIAL_SCOPE = '푼 문제는 이 기기에 저장돼 있어요. 홈에서 이어 풀 수 있어요.';
/** 저장하지 못한 판 */
export const DAILY_UNSAVED_SCOPE = '저장하지 못했어요. 이 창을 닫으면 사라져요.';

/** 결과·풀이 화면에 넘기는 것 (`ui/quiz-review.ts` 의 view 에 그대로 얹는다) */
export interface DailyReviewView {
  review: AnsweredReview;
  title: string;
  scope: string;
  summary: string;
  /** 끝낸 판의 공유 글(레코드의 고정 값에서 만든다). 덜 푼 판이면 null — 입구가 없다 */
  share: string | null;
}

/** 퀴즈 화면에 넘기는 것 */
export interface DailyPlayView {
  categoryLabel: string;
  saveNote: () => string | null;
  exitNote: string;
}

export interface DailyControllerDeps {
  store: DailyStore;
  /** 분야 코드 → 검증을 지난 문제 (`data/loader.ts`) */
  banks: Partial<Record<CategoryId, readonly unknown[]>>;
  now: () => number;
  newSessionId: () => string;
  /** 퀴즈 화면으로 가서 판을 올린다 */
  play: (session: DailySession, view: DailyPlayView) => void;
  /** 결과·풀이 화면으로 간다 */
  showReview: (view: DailyReviewView) => void;
  /** 오늘의 퀴즈를 만들 수 없을 때 홈의 알림(다시 불러오기·닫기)에 띄운다 */
  showUnavailable: (message: string) => void;
  setHomeStatus: (status: DailyHomeStatus) => void;
  announce: (message: string) => void;
  /** 늦게 부를 일 하나를 맡기고 무르는 함수를 받는다. 생략하면 setTimeout 이다 (테스트가 시계를 갈아 끼운다) */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

export interface DailyController {
  /** 홈을 그릴 때·탭이 다시 보일 때·다른 탭이 저장했을 때. 지금 날짜로 입구를 다시 쓴다 */
  refreshHome(): DailyHomeStatus;
  /** 홈 입구를 눌렀을 때. 끝낸 날이면 결과, 아니면 첫 안 푼 문제부터 */
  open(): void;
  /** 이 세션이 지금 도는 오늘의 퀴즈인가 */
  owns(session: unknown): session is DailySession;
  /** 판이 도는 중인가. 새로고침 확인을 띄우지 않는다 — 답마다 저장돼 있다 */
  isPlaying(): boolean;
  /** 퀴즈 화면이 마지막 문제의 「결과 보기」를 눌렀다 */
  complete(session: DailySession): void;
  /** 나가기 확인의 «나가고 푼 문제 해설 보기» */
  reviewAnswered(session: DailySession): void;
  /** 퀴즈 화면을 떠났다 (판은 저장돼 있다) */
  release(): void;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createDailyController(deps: DailyControllerDeps): DailyController {
  const { store } = deps;
  /** 날짜마다의 출제. 은행은 부팅 뒤 바뀌지 않는다 */
  const builds = new Map<string, DailyBuild>();
  /** 저장소에 쓰지 못한 레코드. 이 창 안에서만 이어 간다 */
  const unsaved = new Map<string, DailyRecord>();
  let run: DailySession | null = null;
  /**
   * 지금 판을 열 때의 레코드가 저장소에 있었는가 (`known()` 의 그 레코드의 값). 다시 연 판에서 아직 답하지 않았으면
   * `lastSave()` 가 null 이라, 저장소의 능력(`store.durable`)만 보면 메모리에만 있던 진행을 «저장돼 있어요»라고 한다
   */
  let runDurable = false;
  let note: string | null = null;
  /** 홈의 자정 다시 쓰기를 무르는 함수 */
  let cancelMidnight: (() => void) | null = null;
  const schedule = deps.schedule ?? ((callback: () => void, delayMs: number) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  });

  function build(dateKey: string): DailyBuild {
    let built = builds.get(dateKey);
    if (!built) {
      built = buildDailyQuestions({ dateKey, banks: deps.banks });
      builds.set(dateKey, built);
    }
    return built;
  }

  /** 그 날짜에 알고 있는 가장 앞선 레코드와, 그것이 저장소에 있는가 */
  function known(dateKey: string): { record: DailyRecord | null; durable: boolean; corrupt: boolean } {
    const loaded = store.load(dateKey);
    const stored = loaded.kind === 'record' ? loaded.record : null;
    const memory = unsaved.get(dateKey) ?? null;
    if (memory && (!stored || planDailyWrite(stored, memory).action === 'write')) {
      return { record: memory, durable: false, corrupt: false };
    }
    if (memory) unsaved.delete(dateKey);
    return { record: stored, durable: store.durable, corrupt: loaded.kind === 'corrupt' };
  }

  function matchesBuild(record: DailyRecord, built: DailyBuild): boolean {
    return built.ok && sameDailyQuestions(record, { fingerprints: built.questions.map(questionFingerprint) });
  }

  function status(dateKey: string): DailyHomeStatus {
    const { record } = known(dateKey);
    if (record && isDailyComplete(record)) {
      return { kind: 'done', dateKey, correct: record.answers.filter((answer) => answer.correct).length };
    }
    const built = build(dateKey);
    if (!built.ok) return { kind: 'unavailable', dateKey };
    if (record && record.answers.length > 0 && matchesBuild(record, built)) {
      return { kind: 'resume', dateKey, answered: record.answers.length };
    }
    return { kind: 'new', dateKey };
  }

  /** 홈에 머무는 동안 KST 자정이 지나면 입구를 새 날짜로 고쳐 쓴다 */
  function scheduleMidnight(): void {
    cancelMidnight?.();
    const now = deps.now();
    const today = Date.parse(`${dailyDateKey(now)}T00:00:00+09:00`);
    const wait = Math.max(1000, today + MS_PER_DAY - now + 500);
    cancelMidnight = schedule(() => {
      cancelMidnight = null;
      if (!run) refreshHome();
    }, wait);
  }

  function refreshHome(): DailyHomeStatus {
    const current = status(dailyDateKey(deps.now()));
    deps.setHomeStatus(current);
    scheduleMidnight();
    return current;
  }

  function reviewView(record: DailyRecord, durable: boolean, finished: boolean): DailyReviewView {
    const review = reviewAnswered({
      questions: record.questions,
      answers: dailyAnswerRecords(record),
      // 분야로 묶지 않고 실제로 푼 순서대로 펼친다 — 공유 글의 정오 순서와 같다
      mode: 'category',
      categoryId: null,
    });
    const date = dailyDateLabel(record.dateKey);
    const scope = !durable ? DAILY_UNSAVED_SCOPE : finished ? DAILY_SCOPE : DAILY_PARTIAL_SCOPE;
    const summary = finished
      ? `${date} · ${review.totalCount}문제 중 ${review.correctCount}개 정답`
      : `${date} · ${review.totalCount}문제 중 ${review.answeredCount}문제를 풀었어요 · 맞힌 문제 ${review.correctCount}개`;
    // 공유 글은 저장 여부와 무관하게 레코드에서 만든다 — 메모리에만 있는 결과도 공유하되 저장 범위 줄은 그대로다
    const share = finished ? dailyShareText(record) : null;
    return { review, title: finished ? '오늘의 퀴즈 결과' : '오늘의 퀴즈 · 푼 문제', scope, summary, share };
  }

  function onConfirm(record: DailyRecord, answer: Parameters<typeof appendDailyAnswer>[1]) {
    const next = appendDailyAnswer(record, answer, deps.now());
    const outcome = store.save(next);
    if (outcome.status === 'memory') unsaved.set(next.dateKey, next);
    else unsaved.delete(next.dateKey);
    const complete = isDailyComplete(outcome.record);
    note = dailySaveNote(outcome.status, complete);
    return outcome;
  }

  function open(): void {
    if (run) return;
    const dateKey = dailyDateKey(deps.now());
    const { record, durable, corrupt } = known(dateKey);
    if (record && isDailyComplete(record)) {
      deps.showReview(reviewView(record, durable, true));
      return;
    }
    const built = build(dateKey);
    if (!built.ok) {
      deps.setHomeStatus({ kind: 'unavailable', dateKey });
      deps.showUnavailable('오늘의 퀴즈에 쓸 문제를 다 받지 못했어요. 다시 불러오면 다시 시도해요. 다른 판은 그대로 할 수 있어요.');
      return;
    }
    let start: DailyRecord;
    let notice: string | null = null;
    if (record && matchesBuild(record, built)) {
      start = record;
    } else {
      start = createDailyRecord(built, { sessionId: deps.newSessionId(), nowMs: deps.now() });
      if (record && record.answers.length > 0) notice = '문제가 바뀌어 오늘의 퀴즈를 처음부터 풀어요.';
      else if (corrupt) notice = '저장된 오늘의 퀴즈를 읽지 못해 처음부터 풀어요.';
    }
    note = null;
    const session = createDailySession(start, { onConfirm });
    run = session;
    runDurable = durable && store.durable;
    deps.play(session, {
      categoryLabel: `오늘의 퀴즈 · ${dailyDateLabel(dateKey)}`,
      saveNote: () => (run === session ? note : null),
      exitNote: dailyExitNote(durable && store.durable),
    });
    if (notice) deps.announce(notice);
  }

  return {
    refreshHome,
    open,
    owns(session): session is DailySession {
      return run !== null && session === run;
    },
    isPlaying: () => run !== null,
    complete(session) {
      if (run !== session) return;
      run = null;
      const record = session.record();
      const saved = session.lastSave();
      deps.showReview(reviewView(record, saved === 'saved' || saved === 'adopted', isDailyComplete(record)));
    },
    reviewAnswered(session) {
      if (run !== session) return;
      run = null;
      const record = session.record();
      const saved = session.lastSave();
      // 이 판에서 아직 답하지 않았으면 연 레코드의 저장 여부를, 답했으면 마지막 저장의 결과를 따른다
      const durable = saved === null ? runDurable : saved !== 'memory' && store.durable;
      deps.showReview(reviewView(record, durable, false));
    },
    release() {
      run = null;
    },
  };
}
