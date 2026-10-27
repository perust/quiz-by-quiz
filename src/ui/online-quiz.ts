// Server-authoritative online match screen.
//
// This module intentionally does not import core/session, core/sampler, or scoring.
// Its inputs are validated REST snapshots; its only output is a position + choice index
// submission through the controller supplied by app.ts.

import { playCorrect, playTimeout, playWrong } from '../audio.js';
import { CATEGORIES, WARNING_THRESHOLD_MS } from '../constants.js';
import { need, needOne } from '../dom.js';
import type {
  OnlineMatchQuestion,
  OnlineMatchSnapshot,
  OnlineRevealingMatch,
  OnlineRunningMatch,
  PublicRoom,
  RoomEvent,
  StandingAnswerDraft,
} from '../online/adapter.js';
import { onlineErrorText } from '../online/rules.js';
import { createStandingAnswerPublisher, onlineStandingDraft } from '../online/standing-answer.js';
import type { Arena, ArenaDeps } from './arena.js';
import { createChatLineQueue } from './chat-queue.js';
import { choiceLayout } from './choice-layout.js';
import {
  createPlayerBubbleController,
  shouldPlacePlayerBubbleBelow,
} from './player-bubbles.js';
import {
  createMovementPublisher,
  createPlayerMovementController,
  type MovementSample,
  type MovementSendOptions,
  type MovementStageFrame,
  normalizeViewportMovement,
  walkerFootPoint,
  withMovementStage,
} from './player-movement.js';
import { onlinePlaceLabel, onlinePlaces } from './online-standings.js';
import { announce } from './screens.js';
import { createBody } from './sprite.js';

type OnlineMovementEvent = Extract<RoomEvent, { type: 'movement' }>;
type OnlineActiveMatch = OnlineRunningMatch | OnlineRevealingMatch;
type OnlineChatEvent = Extract<RoomEvent, { type: 'chat' }>;
/** 대화 로그의 한 줄. 남의 말이거나(말한 사람 이름이 앞에 온다) 화면이 남기는 안내다 */
type OnlineChatLine =
  | { kind: 'chat'; playerId: string; nickname: string; text: string }
  | { kind: 'notice'; text: string };

/** 말풍선 수명과 최근 대화 줄 수는 대기실과 같은 계약을 쓴다. */
const BUBBLE_MS = 3200;
const CHAT_LINES = 4;

export interface OnlineQuizRevealView {
  chosenChoiceIndex: number | null;
  answerIndex: number;
  correct: boolean;
  timedOut: boolean;
  explanation: string;
}

export interface OnlineQuizView {
  phase: OnlineMatchSnapshot['state'];
  question: OnlineMatchQuestion | null;
  canSubmit: boolean;
  selectedChoiceIndex: number | null;
  reveal: OnlineQuizRevealView | null;
  status: string;
  showFinalResult: boolean;
}

export interface OnlineSubmissionOwner {
  readonly token: number;
  readonly matchId: string;
  readonly position: number;
}

export interface OnlineSubmissionGate {
  begin(snapshot: Extract<OnlineMatchSnapshot, { state: 'running' }>): OnlineSubmissionOwner;
  reconcile(snapshot: OnlineMatchSnapshot | null): void;
  pendingFor(snapshot: OnlineMatchSnapshot | null): boolean;
  owns(owner: OnlineSubmissionOwner): boolean;
  finish(owner: OnlineSubmissionOwner, snapshot: OnlineMatchSnapshot | null): boolean;
  invalidate(owner?: OnlineSubmissionOwner): void;
}

function sameSubmissionOwner(
  left: OnlineSubmissionOwner,
  right: OnlineSubmissionOwner,
): boolean {
  return left.token === right.token
    && left.matchId === right.matchId
    && left.position === right.position;
}

function ownsQuestion(
  owner: OnlineSubmissionOwner,
  snapshot: OnlineMatchSnapshot | null,
): boolean {
  return snapshot !== null
    && snapshot.state !== 'finished'
    && snapshot.matchId === owner.matchId
    && snapshot.question.position === owner.position;
}

/** A stale submit promise must never unlock or redraw a newer match/question. */
export function createOnlineSubmissionGate(): OnlineSubmissionGate {
  let sequence = 0;
  let pending: OnlineSubmissionOwner | null = null;
  return {
    begin(snapshot) {
      pending = {
        token: ++sequence,
        matchId: snapshot.matchId,
        position: snapshot.question.position,
      };
      return pending;
    },
    reconcile(snapshot) {
      if (pending && !ownsQuestion(pending, snapshot)) pending = null;
    },
    pendingFor(snapshot) {
      return pending !== null && ownsQuestion(pending, snapshot);
    },
    owns(owner) {
      return pending !== null && sameSubmissionOwner(pending, owner);
    },
    finish(owner, snapshot) {
      if (pending === null || !sameSubmissionOwner(pending, owner) || !ownsQuestion(owner, snapshot)) {
        return false;
      }
      pending = null;
      return true;
    },
    invalidate(owner) {
      if (!owner || (pending !== null && sameSubmissionOwner(pending, owner))) pending = null;
    },
  };
}

/**
 * A browser may render a server deadline, but never decides whether it has elapsed.
 * Only a server-recorded submission closes the client-side submit affordance.
 */
export function canAttemptOnlineSubmission(
  snapshot: Extract<OnlineMatchSnapshot, { state: 'running' }>,
): boolean {
  return snapshot.ownSubmission === null;
}

export function ownsOnlineSubmitError(
  snapshot: OnlineMatchSnapshot | null,
  owner: OnlineSubmissionOwner,
): snapshot is Extract<OnlineMatchSnapshot, { state: 'running' }> {
  return snapshot?.state === 'running'
    && snapshot.matchId === owner.matchId
    && snapshot.question.position === owner.position;
}

/** Phase/submission changes restyle existing choices; only a new question rebuilds their nodes. */
export function onlineChoiceStructureKey(snapshot: OnlineMatchSnapshot): string | null {
  if (snapshot.state === 'finished') return null;
  return JSON.stringify([
    snapshot.matchId,
    snapshot.question.position,
    snapshot.question.choices,
  ]);
}

export function onlinePresenceText(
  players: readonly PublicRoom['players'][number][],
): string {
  if (players.length === 0) return '';
  return `함께 푸는 참가자 ${players.length}명: ${players.map((player) => player.nickname).join(', ')}`;
}

export function setTextIfChanged(
  target: { textContent: string | null },
  text: string,
): boolean {
  if (target.textContent === text) return false;
  target.textContent = text;
  return true;
}

/** Question changes announce themselves unless doing so would interrupt another focused surface. */
export function shouldAutoFocusOnlineQuestion(dialogOpen: boolean, chatFocused: boolean): boolean {
  return !dialogOpen && !chatFocused;
}

/**
 * 인페이지 대화상자가 하나라도 열려 있는가. 이 화면의 조작법·나가기 확인만이 아니라 앱 바의
 * 설정처럼 화면 밖에서 연 대화상자도 센다 — 모두 `.dialog-backdrop` 이다 (로컬 퀴즈의 anyDialogOpen 과 같다).
 */
function anyDialogOpen(): boolean {
  return document.querySelector('.dialog-backdrop:not([hidden])') !== null;
}

/**
 * 길게 누른 Enter·Space의 자동 반복이 포커스된 버튼을 다시 누르려는가 (FR-4.4). 브라우저는 반복
 * keydown마다 그 버튼을 누른다. 글자를 적는 칸과 빈자리(Space 스크롤)는 버튼이 아니라 그대로 둔다.
 */
export function isHeldButtonRepeat(
  event: Pick<KeyboardEvent, 'key' | 'repeat'>,
  focused: Pick<Element, 'closest'> | null,
): boolean {
  if (!event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return false;
  return Boolean(focused?.closest('button'));
}

/** A room-bound chat accepts one non-empty request at a time. */
export function canSendOnlineChat(active: boolean, pending: boolean, text: string): boolean {
  return active && !pending && Boolean(text.trim());
}

export function reconcileOnlineChoiceNodes<T>(
  existing: readonly T[],
  previousKey: string | null,
  nextKey: string,
  count: number,
  create: (index: number) => T,
): { nodes: T[]; rebuilt: boolean } {
  if (previousKey === nextKey && existing.length === count) {
    return { nodes: Array.from(existing), rebuilt: false };
  }
  return {
    nodes: Array.from({ length: count }, (_, index) => create(index)),
    rebuilt: true,
  };
}

/** 시간이 끝나면 선 칸이 답인 판(U13)의 상태 줄. 로컬 무대 아래 규칙 줄과 같은 규칙이다 */
export const ONLINE_STANDING_STATUS = '보기를 누르면 바로 제출돼요. 시간이 끝나면 서 있는 칸이 답이에요.';

/**
 * 같은 판인데 방 소켓이 끊겨(다시 붙는 중) 발밑 칸 초안이 닿지 않을 때의 상태 줄 (U13). 그동안 마감이 오면
 * 끊기기 전에 알린 칸만 답이 되고(그 뒤에 옮긴 칸은 모른다) 알린 칸이 없으면 시간 초과다 — 그래서 «서 있는
 * 칸이 답»을 그대로 약속하지 않고 확실한 길을 말한다. 직접 낸 답은 소켓이 아니라 요청으로 간다.
 */
export const ONLINE_STANDING_OFFLINE_STATUS = '연결이 잠시 끊겨 서 있는 칸이 답이 되지 않을 수 있어요. 칸 위에서 선택을 누르거나 보기를 눌러 제출해 주세요.';

/** 서버가 남은 시간을 보내지 않을 때(구버전 서버)의 안내. 카운트다운은 그리지 않는다. */
export const ONLINE_TIME_NOTICE = '시간이 끝나면 다 같이 결과를 확인해요.';

export interface OnlineCountdownView {
  text: string;
  /** 타이머 막대의 채움. 0~1 */
  fraction: number;
  /** 남은 5초 경고. 아이콘·문구는 디자인 층이 timer--warning을 보고 바꾼다 */
  warning: boolean;
}

/**
 * 서버 마감까지의 **표시용** 남은 시간 (로컬 FR-3.7·FR-3.9와 같은 HUD 읽는 법).
 *
 * 마감 판정은 서버만 한다. 여기서 0이 되어도 제출을 닫거나 자동으로 내지 않는다 —
 * «결과를 기다리는 중»을 보여 줄 뿐이다. 이미 낸 사람에게는 서두르라는 경고를 하지 않는다.
 */
export function onlineCountdownView(
  phase: OnlineActiveMatch['state'],
  remainingMs: number,
  spanMs: number,
  { submitted, lastQuestion }: { submitted: boolean; lastQuestion: boolean },
): OnlineCountdownView {
  const remaining = Math.max(remainingMs, 0);
  const fraction = spanMs > 0 ? Math.min(remaining / spanMs, 1) : 0;
  const seconds = Math.ceil(remaining / 1000);
  if (phase === 'revealing') {
    const next = lastQuestion ? '최종 순위' : '다음 문제';
    return {
      text: remaining > 0 ? `${next}까지 ${seconds}초` : `${next}를 불러오는 중…`,
      fraction,
      warning: false,
    };
  }
  if (remaining <= 0) return { text: '결과를 기다리는 중…', fraction: 0, warning: false };
  return {
    text: `${seconds}초 남았어요`,
    fraction,
    warning: !submitted && remaining <= WARNING_THRESHOLD_MS,
  };
}

/**
 * 남은 시간 막대의 «가득»이 가리키는 시간 (표시 전용).
 *
 * 문항(running)은 그 판의 문항 시간 — 방장이 방에 고른 20초·40초다. 문항 도중에 들어오거나
 * 새로고침한 사람이 처음 받은 남은 시간을 가득으로 두면 반쯤 지난 문항이 가득 찬 막대로 보이고,
 * 40초 방과 20초 방의 막대가 같은 속도로 줄어 보이지 않는다. 공개 중이거나 문항 시간을 보내지 않는
 * 구버전 서버면 지금까지처럼 이 phase에서 받은 가장 긴 남은 시간이다.
 */
export function onlineCountdownSpan(
  phase: OnlineActiveMatch['state'],
  questionTimeMs: number | undefined,
  remainingMs: number,
  previousSpanMs: number,
): number {
  const remaining = Math.max(remainingMs, 0);
  if (phase === 'running' && questionTimeMs !== undefined) return Math.max(questionTimeMs, remaining);
  return Math.max(previousSpanMs, remaining);
}

export interface OnlineRevealAnswerText {
  correct: string;
  mine: string;
}

/**
 * 틀렸거나 시간이 끝났을 때만 «정답 2번 · 1446년 / 내 답 3번 · 1450년»을 만든다.
 * 로컬 피드백(FR-4.2)과 같은 줄이다. 맞혔으면 판정만으로 충분해 줄을 생략한다.
 * 번호는 원문자 글리프 대신 «2번»처럼 글자로 쓴다 — 번들 글꼴에 없는 글리프다.
 */
export function onlineRevealAnswerText(
  choices: readonly string[],
  reveal: OnlineQuizRevealView,
): OnlineRevealAnswerText | null {
  if (reveal.correct) return null;
  // 어댑터가 보기 넷과 0~3 번호를 이미 검증했다.
  const describe = (index: number): string => `${index + 1}번 · ${choices[index]}`;
  return {
    correct: describe(reveal.answerIndex),
    mine: reveal.chosenChoiceIndex === null ? '고르지 않음' : describe(reveal.chosenChoiceIndex),
  };
}

/** 공개 단계 미니 점수판에 그리는 줄 수 (U30). 넘치면 내 줄을 덧붙이고 나머지는 수로만 알린다 */
export const REVEAL_STANDINGS_LIMIT = 5;

export interface OnlineRevealStandingRow {
  playerId: string;
  nickname: string;
  score: number;
  place: number;
  tied: boolean;
  isMe: boolean;
  /** 이번 문제를 맞혔는가. 서버가 참가자별 정오를 보내지 않으면(구버전) null */
  correct: boolean | null;
  /** 위 줄과 순위가 이어지지 않는다 — 위 몇 줄 뒤에 덧붙인 내 줄 */
  afterGap: boolean;
}

export interface OnlineRevealStandings {
  rows: OnlineRevealStandingRow[];
  /** 이번 문제를 맞힌 사람 수. 한 사람이라도 정오를 모르면 null이다 — 지어내지 않는다 */
  correctCount: number | null;
  playerCount: number;
  /** 줄로 그리지 않은 참가자 수 */
  hiddenCount: number;
  /** 원격 캐릭터 이름표의 ✓/✗. 정오를 아는 참가자만 들어 있다 */
  results: ReadonlyMap<string, boolean>;
}

/**
 * 공개 단계의 미니 점수판 (U30). **revealing이 아니면 null이다** — 아직 답을 고르는 사람에게 남의
 * 점수·정오·정답자 수를 보이지 않는다(PRD 2.1). 순위는 최종 순위와 같은 규칙(서버 순서, 공동 순위)이다.
 * 방이 크면 위 `limit`줄(그 마지막 순위와 같은 점수는 모두)과 내 줄만 그린다 — 같은 점수의 누구를
 * 이름 순서로 잘라 내지 않는다.
 */
export function onlineRevealStandings(
  snapshot: OnlineMatchSnapshot,
  playerId: string,
  limit = REVEAL_STANDINGS_LIMIT,
): OnlineRevealStandings | null {
  if (snapshot.state !== 'revealing' || snapshot.scores.length === 0) return null;
  const scores = snapshot.scores;
  const places = onlinePlaces(scores);
  const all: OnlineRevealStandingRow[] = scores.map((score, index) => ({
    playerId: score.playerId,
    nickname: score.nickname,
    score: score.score,
    place: places[index].place,
    tied: places[index].tied,
    isMe: score.playerId === playerId,
    correct: typeof score.lastAnswerCorrect === 'boolean' ? score.lastAnswerCorrect : null,
    afterGap: false,
  }));
  const cutoff = all.length > limit ? all[Math.max(limit, 1) - 1].place : Number.POSITIVE_INFINITY;
  const top = all.filter((row) => row.place <= cutoff);
  const me = all.find((row) => row.isMe);
  const rows = me && !top.includes(me) ? [...top, { ...me, afterGap: true }] : top;
  const results = new Map<string, boolean>();
  for (const row of all) {
    if (row.correct !== null) results.set(row.playerId, row.correct);
  }
  return {
    rows,
    correctCount: results.size === all.length
      ? all.filter((row) => row.correct === true).length
      : null,
    playerCount: all.length,
    hiddenCount: all.length - rows.length,
    results,
  };
}

/** «이번 문제 정답 2/4명». 정답자 수를 모르면(구버전 서버) 그리지 않는다 */
export function onlineRevealTally(standings: OnlineRevealStandings): string | null {
  if (standings.correctCount === null) return null;
  return `이번 문제 정답 ${standings.correctCount}/${standings.playerCount}명`;
}

/** 내 결과의 효과음 (N03). 로컬 피드백과 같은 세 소리다 — 시간 초과는 오답과 구분된다 */
export function onlineRevealSound(
  reveal: Pick<OnlineQuizRevealView, 'correct' | 'timedOut'>,
): 'correct' | 'wrong' | 'timeout' {
  if (reveal.correct) return 'correct';
  return reveal.timedOut ? 'timeout' : 'wrong';
}

/**
 * Pure projection: hidden match data has no path into a running UI.
 *
 * `standingDeliverable`은 지금 발밑 칸 초안이 서버에 닿는가다 (U13, 저장소의 `standing-delivery`). 모르면
 * 닿는다고 본다 — 처음 붙는 소켓은 기억한 초안을 열리자마자 보낸다.
 */
export function onlineQuizView(
  snapshot: OnlineMatchSnapshot,
  { standingDeliverable = true }: { standingDeliverable?: boolean } = {},
): OnlineQuizView {
  if (snapshot.state === 'running') {
    const submission = snapshot.ownSubmission;
    return {
      phase: 'running',
      question: snapshot.question,
      canSubmit: canAttemptOnlineSubmission(snapshot),
      selectedChoiceIndex: submission?.choiceIndex ?? null,
      reveal: null,
      // 답하는 규칙은 판이 정한다 (U13). 지금 판은 혼자 하기와 같다 — 시간이 끝나면 선 칸이 답이다.
      // 소켓이 끊겨 그 칸이 닿지 않는 동안은 그렇게 약속하지 않는다. 그 필드가 없는 이전 API의 판은
      // 칸에 서 있기만 해서는 답이 나가지 않는다. 그 규칙을 그대로 말한다.
      status: submission !== null
        ? '제출 완료! 다른 친구를 기다리는 중이에요.'
        : snapshot.standingAnswers === true
          ? standingDeliverable ? ONLINE_STANDING_STATUS : ONLINE_STANDING_OFFLINE_STATUS
          : '칸 위에서 선택을 누르거나 보기를 눌러야 제출돼요.',
      showFinalResult: false,
    };
  }
  if (snapshot.state === 'revealing') {
    const reveal = snapshot.reveal;
    return {
      phase: 'revealing',
      question: snapshot.question,
      canSubmit: false,
      selectedChoiceIndex: reveal?.choiceIndex ?? null,
      reveal: reveal === null ? null : {
        chosenChoiceIndex: reveal.choiceIndex,
        answerIndex: reveal.answerIndex,
        correct: reveal.correct,
        timedOut: reveal.timedOut,
        explanation: reveal.explanation,
      },
      // 판정·정답·해설은 공개 카드(aria-live)가 말한다. 상태 줄이 같은 순간에 «공개했다»고
      // 겹쳐 말하면 두 라이브 리전이 서로의 낭독을 덮는다 — 그래서 비워 둔다.
      status: '',
      showFinalResult: false,
    };
  }
  return {
    phase: 'finished',
    question: null,
    canSubmit: false,
    selectedChoiceIndex: null,
    reveal: null,
    status: '최종 순위가 나왔어요.',
    showFinalResult: true,
  };
}

/** 답은 한 번만 제출하지만 매치가 끝나기 전까지 캐릭터 이동은 계속 허용한다. */
export function onlineArenaMovementEnabled(view: OnlineQuizView): boolean {
  return view.phase !== 'finished';
}

/** 이동과 답 선택을 분리한다. 제출 중·제출 뒤·정답 공개 중에는 걷기만 허용한다. */
export function onlineArenaSelectionEnabled(
  view: OnlineQuizView,
  isSubmitPending: boolean,
): boolean {
  return view.phase === 'running' && view.canSubmit && !isSubmitPending;
}

/**
 * 답 제출 여부와 공개 phase는 이동 입력을 막지 않는다. 끝난 매치만 arena로 넘기지 않는다.
 */
export function handleOnlineMovementKey(
  snapshot: OnlineMatchSnapshot | null,
  event: KeyboardEvent,
  arena: Pick<Arena, 'handleKey'>,
): boolean {
  if (snapshot === null || !onlineArenaMovementEnabled(onlineQuizView(snapshot))) return false;
  return arena.handleKey(event);
}

/**
 * 혼자 판의 나가기 확인 (FR-7.13 3단계). 친구와 푸는 방과 같은 규칙이다 — 판은 서버에서 계속되고 방에서 나간 것도
 * 아니다. 돌아오는 길은 로비 목록이 아니라 홈의 «이어 풀기» 줄이고, 끝까지 가면 그 점수가 기록된다
 */
export const SOLO_EXIT_BODY =
  '나가도 판은 계속 진행돼요. 홈의 「이어 풀기」로 돌아올 수 있고, 판이 끝나면 그 점수가 온라인 랭킹에 남아요.';

export interface OnlineQuizScreenDeps {
  onSubmit: (spec: OnlineSubmissionOwner & { choiceIndex: number }) => Promise<void>;
  /** `onlyIfChanged`면 무대가 움직였을 뿐이다 — 소켓에 실을 줄이 지난번과 같으면 저장소가 보내지 않는다 */
  onMovement: (sample: MovementSample & MovementSendOptions) => void;
  /**
   * 발밑 칸 초안 (U13). 시간이 끝나면 선 칸이 답인 판에서, 실제로 움직인 뒤 선 칸이 바뀔 때만 부른다
   * (칸에서 내려서면 `choiceIndex: null`). 보낼 소켓이 그 초안을 받는지는 저장소가 다시 본다
   */
  onStandingAnswer?: (draft: StandingAnswerDraft) => void;
  onSendChat: (text: string) => Promise<{ ok: boolean }>;
  onExit: () => void;
  onFinished: (snapshot: Extract<OnlineMatchSnapshot, { state: 'finished' }>) => void;
  getPlayerId: () => string;
  /**
   * 대기실에서 «말 숨기기»를 켠 사람인가 (N06). 그 사람의 말풍선과 대화 줄을 내 화면에 그리지 않는다.
   * 이 화면은 방 코드를 모르므로 app.ts가 지금 매치의 방으로 묻는다. 없으면 아무도 숨기지 않는다
   */
  isChatHidden?: (playerId: string) => boolean;
  createCharacterArena: (deps: ArenaDeps) => Arena;
  trapFocus: (container: HTMLElement, event: KeyboardEvent) => void;
}

export interface OnlineQuizScreen {
  /** 한 매치의 presence lifecycle을 열고 이전 방 좌표를 비운다. */
  startPresence(): void;
  /** WebSocket이 재조회한 authoritative room roster를 반영한다. */
  setRoom(room: PublicRoom): void;
  /** 인증된 socket actor의 최신 이동만 반영한다. */
  updateMovement(movement: OnlineMovementEvent): void;
  /**
   * 발밑 칸 초안이 지금 서버에 닿는지 (U13, 저장소의 `standing-delivery`). 판의 규칙 줄이 보이는 동안만
   * 상태 줄을 고친다 — 답을 보내지 못한 이유 같은 말은 덮지 않는다. 새 매치(`startPresence`)는 닿는다고 시작한다.
   */
  setStandingDelivery(deliverable: boolean): void;
  /** 같은 match socket에서 온 인증된 채팅을 로그와 캐릭터 말풍선에 반영한다. */
  updateChat(event: OnlineChatEvent): void;
  /** socket을 닫기 전에 마지막 정지 좌표를 보내고 presence를 정리한다. */
  stopPresence(): void;
  render(snapshot: OnlineMatchSnapshot): void;
  /** 홈에서 고른 캐릭터를 온라인 문제 무대에도 적용한다. */
  setCharacter(id: string): void;
  /**
   * 혼자 푸는 온라인 판인가 (FR-7.13 3단계). 혼자 방에는 말을 받을 사람이 없어 채팅을 거두고, 혼자인 점수판(«정답
   * 1/1명»)도 그리지 않는다. 나가기 확인은 홈의 «이어 풀기»로 돌아온다고 말한다. 판의 규칙·채점·마감은 같다
   */
  setSolo(solo: boolean): void;
  /** 오류가 아닌 안내용 transport/state 문구. */
  setNotice(message: string): void;
  /** Background refresh failures are visible but never release an in-flight submit. */
  setRefreshError(message: string): void;
  /** A failed submit releases only the exact token/match/question owner. */
  setSubmitError(message: string, owner: OnlineSubmissionOwner): void;
  hide(): void;
}

export function createOnlineQuizScreen(
  {
    onSubmit,
    onMovement,
    onStandingAnswer = () => undefined,
    onSendChat,
    onExit,
    onFinished,
    getPlayerId,
    isChatHidden = () => false,
    createCharacterArena,
    trapFocus,
  }: OnlineQuizScreenDeps,
): OnlineQuizScreen {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="online-quiz"]'),
    category: need('online-quiz-category'),
    position: need('online-quiz-position'),
    progress: need('online-progress'),
    progressFill: need('online-progress-fill'),
    timer: need('online-timer'),
    timerFill: need('online-timer-fill'),
    timerText: need('online-timer-text'),
    question: need<HTMLHeadingElement>('online-question-text'),
    choices: need('online-choices'),
    presenceStatus: need('online-presence-status'),
    status: need('online-match-status'),
    reveal: need('online-reveal'),
    verdict: need('online-reveal-verdict'),
    revealAnswer: need('online-reveal-answer'),
    explanation: need('online-reveal-explanation'),
    standings: need('online-standings'),
    exitDialog: need('online-exit-dialog'),
    exitCancel: need<HTMLButtonElement>('online-exit-cancel'),
    exitConfirm: need<HTMLButtonElement>('online-exit-confirm'),
    remoteCharacters: need('online-remote-characters'),
    // 원격 캐릭터를 맞추는 공유 무대(U31)인 2×2 바닥. 칸은 arena가 그리고 여기서는 자리만 잰다
    arenaTiles: need('online-arena-tiles'),
    arenaCharacter: need('online-arena-character'),
    bubble: need('online-bubble'),
    chatForm: need<HTMLFormElement>('online-chat-form'),
    chatInput: need<HTMLInputElement>('online-chat-input'),
    chatSubmit: need<HTMLButtonElement>('online-chat-submit'),
    chatLog: need('online-chat-log'),
    chatSection: need('online-quiz-chat'),
    exitTitle: need('online-exit-dialog-title'),
    exitBody: need('online-exit-dialog-body'),
    exit: need<HTMLButtonElement>('online-quiz-exit'),
    // 답하는 규칙(U13)이 판마다 다르다 — 시간이 끝나면 선 칸이 답인 판과 직접 낸 답만 세는 이전 API의 판
    hintRule: need('online-arena-hint-rule'),
    helpRuleStanding: need('online-help-rule-standing'),
    helpRuleSubmit: need('online-help-rule-submit'),
  };
  const categoryNames = new Map(CATEGORIES.map((category) => [category.id, category.name]));
  let snapshot: OnlineMatchSnapshot | null = null;
  const submissionGate = createOnlineSubmissionGate();
  let lastQuestionKey: string | null = null;
  let lastArenaQuestionKey: string | null = null;
  let lastChoiceStructureKey: string | null = null;
  let finishedMatchId: string | null = null;
  let presenceActive = false;
  /** 발밑 칸 초안이 지금 서버에 닿는가 (U13). 매치 소켓이 처음 붙는 동안은 닿는다고 본다 */
  let standingDeliverable = true;
  /** render()가 마지막으로 상태 줄에 넣은 판의 말. 그 말이 보일 때만 소켓 사정으로 고친다 */
  let ruleStatus: string | null = null;
  /** Chat POST completion from an exited/replaced match must not mutate the next screen. */
  let presenceGeneration = 0;
  let chatSendPending = false;
  let movementHeartbeat: number | undefined;
  /** 남은 시간 표시. 같은 phase 안에서는 가장 이른 마감 추정을 믿는다 (응답이 늦을수록 부풀려진다). */
  let countdownKey: string | null = null;
  let countdownDeadline = 0;
  let countdownSpan = 0;
  let countdownFrame: number | null = null;
  /** 남은 5초 경고는 문항당 한 번만 낭독한다 */
  let warnedQuestionKey: string | null = null;
  /** 공개 카드로 한 번만 스크롤하고, 정답 줄은 내용이 바뀔 때만 다시 만든다 */
  let revealScrolledKey: string | null = null;
  /** 공개 카드 때문에 화면을 아래로 옮겼는가. 다음 문제에서 맨 위로 되돌린다 */
  let revealMovedPage = false;
  let revealAnswerKey: string | null = null;
  /** 미니 점수판은 내용(문항·순위·정오)이 바뀔 때만 다시 만든다 — 재조회마다 다시 낭독하지 않는다 */
  let standingsKey: string | null = null;
  /** 공개 중인 문항의 참가자별 정오. 원격 캐릭터 이름표의 ✓/✗가 이것을 본다. 공개가 아니면 null */
  let revealResults: ReadonlyMap<string, boolean> | null = null;
  /** 내 결과 효과음은 문항마다 처음 공개될 때 한 번만 낸다 (N03) */
  let revealSoundKey: string | null = null;
  /** 나가기 확인을 연 버튼. 취소하면 포커스를 되돌려 준다 */
  let exitDialogOpener: HTMLElement | null = null;
  /** 혼자 푸는 온라인 판인가 (FR-7.13 3단계). 채팅과 혼자인 점수판을 거둔다 */
  let solo = false;
  // 친구와 푸는 방의 나가기 확인 말(정적 HTML). 혼자 판에서 바꿨다가 되돌린다
  const exitCopy = { title: el.exitTitle.textContent ?? '', body: el.exitBody.textContent ?? '' };
  /**
   * 온라인 퀴즈의 공유 무대 (U31): 2×2 바닥. 화면마다 바닥이 질문 아래·오른쪽 열 등 다른 자리에 있어도
   * 같은 칸의 같은 자리는 같은 좌표다. 숨은 화면·꺼진 무대는 잴 수 없어 null — 예전처럼 화면 중심의 px다.
   */
  function arenaStageFrame(): MovementStageFrame | null {
    if (el.screen.hidden) return null;
    const box = el.arenaTiles.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  const remoteMovements = createPlayerMovementController({
    // 바닥에서 보낸 자리는 이 화면 바닥의 같은 자리에 세운다. 대기실 라운지에서 온 자리는 예전 길이다
    stageFrame: (stage) => (stage === 'arena' ? arenaStageFrame() : null),
  });
  const chatBubbles = createPlayerBubbleController({ durationMs: BUBBLE_MS });
  const chatBubbleNodes = new Map<string, HTMLElement>();
  /**
   * 대화 로그에 붙일 차례 (U42). 새 문항·공개로 질문 제목에 포커스를 옮기거나 남은 5초 경고를 낸 직후에
   * 온 줄은 잠깐 기다렸다 붙어, 우선 낭독 뒤에 polite로 선다(`ui/chat-queue.ts`)
   */
  const chatLines = createChatLineQueue<OnlineChatLine>({ append: writeChatLine, limit: CHAT_LINES });
  const movementPublisher = createMovementPublisher({
    send: (sample, options) => {
      if (presenceActive) onMovement(options ? { ...sample, ...options } : sample);
    },
    // 바닥은 문서와 함께 스크롤된다. 보낼 때마다 지금 배치와 지금 그려진 캐릭터로 무대 좌표를 다시 잰다 (U31) —
    // 공개 카드로 스크롤한 뒤 arena가 캐릭터를 바닥의 같은 자리로 옮겨 놓아도(이동을 알리지 않는다) 맞다
    restage: (sample) => withMovementStage(sample, {
      id: 'arena',
      frame: arenaStageFrame(),
      foot: walkerFootPoint(el.arenaCharacter),
    }),
  });

  /**
   * 캐릭터는 화면에 붙어 있고 바닥이 움직였다(스크롤·크기·문항마다 바뀌는 보기 배치). 원격 캐릭터를 이 화면
   * 바닥의 자리에 다시 세우고, 바닥 위 내 자리가 바뀌었으면 알린다 (U31, 걷는 frame과 같은 간격으로 묶는다)
   */
  function refreshStage(): void {
    if (!presenceActive) return;
    remoteMovements.refresh();
    movementPublisher.refresh();
  }
  window.addEventListener('scroll', refreshStage, { passive: true });
  window.addEventListener('resize', refreshStage);
  // 시간이 끝나면 답이 될 칸을 서버에 알린다 (U13). 스쳐 지나간 칸은 보내지 않고, 멈춰 서면 곧바로 보낸다
  const standingPublisher = createStandingAnswerPublisher({
    send: (draft) => {
      if (presenceActive) onStandingAnswer(draft);
    },
  });

  /** 지금 판·문항·제출 상태로 발밑 칸 초안을 다시 맞춘다. 초안을 쓰지 않는 때면 기다리던 것도 버린다 */
  function syncStandingDraft(standingIndex: number | null): void {
    standingPublisher.update(onlineStandingDraft(
      snapshot,
      standingIndex,
      snapshot !== null && submissionGate.pendingFor(snapshot),
    ));
  }

  const arena = createCharacterArena({
    onChoose: (index) => { void submitChoice(index); },
    onMove: (point, moving) => {
      const sample = normalizeViewportMovement(point, moving, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      if (sample) movementPublisher.update(sample);
      // 멈춰 섰다. 선 칸을 기다리지 않고 알린다 — 마감 직전에 선 칸도 늦지 않게
      if (!moving) standingPublisher.flush();
      if (!el.bubble.hidden) fitChatBubble(el.bubble);
    },
    onStandingChange: (index) => syncStandingDraft(index),
    getChoiceNodes: () => el.choices.querySelectorAll('.choice'),
    trapFocus,
    ids: {
      root: 'online-arena',
      character: 'online-arena-character',
      tiles: 'online-arena-tiles',
      help: 'online-arena-help',
      helpDialog: 'online-help-dialog',
      helpClose: 'online-help-close',
    },
  });

  function stopPresence(): void {
    // walker가 걷는 중이면 socket을 닫기 전에 마지막 정지 좌표를 보낸다.
    arena.setEnabled(false);
    presenceGeneration += 1;
    presenceActive = false;
    clearInterval(movementHeartbeat);
    movementHeartbeat = undefined;
    movementPublisher.reset();
    standingPublisher.reset();
    remoteMovements.reset();
    chatBubbles.reset();
    chatBubbleNodes.clear();
    el.remoteCharacters.replaceChildren();
    setTextIfChanged(el.presenceStatus, '');
    chatSendPending = false;
    el.chatInput.disabled = true;
    el.chatSubmit.disabled = true;
    el.chatInput.value = '';
    el.chatInput.blur();
    // 기다리던 줄도 버린다 — 떠난 매치의 말이 다음 화면의 로그에 늦게 붙지 않는다
    chatLines.reset();
    el.chatLog.replaceChildren();
    // 로비 fetch를 기다리는 동안 문제 화면이 잠시 남아도 새 제출이나 늦은 완료가
    // 이 lifecycle을 다시 그릴 수 없어야 한다.
    submissionGate.invalidate();
    snapshot = null;
    // 다음 매치는 새 소켓이다. 처음 붙는 동안은 초안이 닿는다고 본다
    standingDeliverable = true;
    ruleStatus = null;
    lastQuestionKey = null;
    lastArenaQuestionKey = null;
    lastChoiceStructureKey = null;
    // 화면을 떠나면 표시 루프도 멈춘다. 안 보이는 화면에서 프레임이 계속 돌지 않게 한다.
    stopCountdown();
    warnedQuestionKey = null;
    revealScrolledKey = null;
    revealMovedPage = false;
    revealAnswerKey = null;
    el.revealAnswer.hidden = true;
    el.revealAnswer.replaceChildren();
    standingsKey = null;
    revealResults = null;
    revealSoundKey = null;
    el.standings.hidden = true;
    el.standings.replaceChildren();
    el.reveal.hidden = true;
    // 확인 대화상자는 <main> 밖이라 화면과 함께 숨지 않는다. 열어 둔 채 떠나면 다음 화면을 덮는다.
    // 화면을 떠나는 중이므로 포커스는 되돌리지 않고 닫기만 한다.
    el.exitDialog.hidden = true;
    exitDialogOpener = null;
    for (const button of el.choices.querySelectorAll<HTMLButtonElement>('.choice')) {
      button.disabled = true;
    }
  }

  function startPresence(): void {
    stopPresence();
    presenceActive = true;
    bindChatBubble(getPlayerId(), el.bubble);
    movementHeartbeat = window.setInterval(() => movementPublisher.resend(), 2000);
  }

  function setRoom(room: PublicRoom): void {
    if (!presenceActive) return;
    // 새 match socket이 authoritative room snapshot까지 받은 뒤에만 전송을 연다.
    el.chatInput.disabled = false;
    el.chatSubmit.disabled = chatSendPending;
    setTextIfChanged(el.presenceStatus, onlinePresenceText(room.players));
    const remotePlayers = room.players.filter((player) => player.id !== getPlayerId());
    remoteMovements.unbindAll();
    remoteMovements.reconcile(remotePlayers.map((player) => player.id));
    chatBubbles.unbindAll();
    chatBubbleNodes.clear();
    bindChatBubble(getPlayerId(), el.bubble);
    el.remoteCharacters.replaceChildren();

    for (const player of remotePlayers) {
      const character = document.createElement('div');
      character.className = 'walker walker--remote';
      character.dataset.movingPlayerId = player.id;
      character.hidden = true;

      const shadow = document.createElement('span');
      shadow.className = 'walker__shadow';
      // 최근 로그가 live region이므로 시각 말풍선은 중복 낭독하지 않는다.
      const bubble = document.createElement('span');
      bubble.className = 'walker__bubble';
      bubble.setAttribute('aria-hidden', 'true');
      bubble.hidden = true;
      const name = document.createElement('span');
      name.className = 'walker__name';
      name.textContent = player.nickname;
      character.append(bubble, shadow, createBody(player.characterId), name);
      el.remoteCharacters.append(character);
      remoteMovements.bind(player.id, character);
      bindChatBubble(player.id, bubble);
    }
    // 공개 중에 명단이 바뀌어 캐릭터를 새로 만들었으면 이름표의 ✓/✗도 다시 단다
    paintRemoteResults();
    movementPublisher.resend();
  }

  /**
   * 공개 중인 문항에서 각 원격 캐릭터가 맞혔는지를 이름표 옆 ✓/✗로 보인다 (U30). 표식은 디자인 층이
   * 상태 클래스를 보고 아이콘으로 그린다(글리프 금지). 무대는 aria-hidden이고 같은 정오는 점수판이 글로 말한다.
   */
  function paintRemoteResults(): void {
    for (const character of el.remoteCharacters.querySelectorAll<HTMLElement>('.walker--remote')) {
      const id = character.dataset.movingPlayerId;
      const result = id === undefined ? undefined : revealResults?.get(id);
      character.classList.toggle('walker--answer-correct', result === true);
      character.classList.toggle('walker--answer-wrong', result === false);
    }
  }

  function updateMovement(movement: OnlineMovementEvent): void {
    if (!presenceActive || movement.playerId === getPlayerId()) return;
    remoteMovements.update(movement);
    const bubble = chatBubbleNodes.get(movement.playerId);
    if (bubble && !bubble.hidden) fitChatBubble(bubble);
  }

  /** 움직이는 캐릭터에 붙이되 viewport 밖으로 나간 폭만 안쪽으로 민다. */
  function fitChatBubble(bubble: HTMLElement): void {
    bubble.style.removeProperty('--bubble-shift');
    if (bubble.hidden) return;
    const characterBox = bubble.parentElement?.getBoundingClientRect();
    bubble.classList.remove('walker__bubble--below');
    let bubbleBox = bubble.getBoundingClientRect();
    if (characterBox) {
      bubble.classList.toggle(
        'walker__bubble--below',
        shouldPlacePlayerBubbleBelow(
          bubbleBox.height,
          characterBox.top,
          characterBox.bottom,
          window.innerHeight,
        ),
      );
      bubbleBox = bubble.getBoundingClientRect();
    }
    if (bubbleBox.width === 0) return;
    const inset = 6;
    let shift = 0;
    if (bubbleBox.left < inset) {
      shift = inset - bubbleBox.left;
    } else if (bubbleBox.right > window.innerWidth - inset) {
      shift = window.innerWidth - inset - bubbleBox.right;
    }
    if (shift !== 0) bubble.style.setProperty('--bubble-shift', `${Math.round(shift)}px`);
  }

  function bindChatBubble(playerId: string, bubble: HTMLElement): void {
    chatBubbleNodes.set(playerId, bubble);
    chatBubbles.bind(playerId, bubble);
    if (!bubble.hidden) fitChatBubble(bubble);
  }

  /**
   * 대화 로그에 한 줄을 붙인다. 로그는 `role="log"`·`aria-relevant="additions"`라 붙인 이 줄만 낭독된다 —
   * 말한 사람 이름이 줄 맨 앞이다. 떼어 내는 오래된 줄은 읽지 않는다. 포커스는 건드리지 않는다.
   * 차례를 기다리는 사이에 숨긴 사람의 말은 여기서 다시 거른다 (N06).
   */
  function writeChatLine(line: OnlineChatLine): void {
    const item = document.createElement('div');
    if (line.kind === 'chat') {
      if (line.playerId !== getPlayerId() && isChatHidden(line.playerId)) return;
      item.className = 'chat-log__line';
      const who = document.createElement('span');
      who.className = 'chat-log__who';
      who.textContent = line.nickname;
      item.append(who, ' ', line.text);
    } else {
      item.className = 'chat-log__line chat-log__line--notice';
      item.textContent = line.text;
    }
    el.chatLog.append(item);
    while (el.chatLog.children.length > CHAT_LINES) el.chatLog.firstElementChild!.remove();
    // 로그는 높이가 묶여 있다(style.css). 가장 새 줄이 칸 아래로 잘리지 않게 끝에 맞춘다 — 그 칸만 움직인다
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function chatNotice(text: string): void {
    chatLines.push({ kind: 'notice', text });
  }

  function updateChat(event: OnlineChatEvent): void {
    if (!presenceActive) return;
    // 내가 숨긴 사람의 말은 로그에도 말풍선에도 그리지 않는다 (N06). 내 말은 숨기지 않는다
    if (event.playerId !== getPlayerId() && isChatHidden(event.playerId)) return;
    // 로그 줄은 우선 낭독(새 문항·남은 5초 경고)이 막 나갔으면 잠깐 기다린다. 말풍선은 곧바로 띄운다
    chatLines.push({ kind: 'chat', playerId: event.playerId, nickname: event.nickname, text: event.text });
    chatBubbles.show(event.playerId, event.text);
    const bubble = chatBubbleNodes.get(event.playerId);
    if (bubble) fitChatBubble(bubble);
  }

  el.chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = el.chatInput.value;
    if (!canSendOnlineChat(presenceActive, chatSendPending, text)) return;
    const sendGeneration = presenceGeneration;
    chatSendPending = true;
    el.chatSubmit.disabled = true;
    try {
      const result = await onSendChat(text);
      if (!presenceActive || sendGeneration !== presenceGeneration) return;
      if (!result.ok) {
        chatNotice('메시지를 보내지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
        return;
      }
      if (el.chatInput.value === text) {
        el.chatInput.value = '';
        el.chatInput.blur();
      }
    } catch {
      if (!presenceActive || sendGeneration !== presenceGeneration) return;
      chatNotice('메시지를 보내지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
    } finally {
      if (presenceActive && sendGeneration === presenceGeneration) {
        chatSendPending = false;
        el.chatSubmit.disabled = false;
      }
    }
  });

  function setStatus(text: string): void {
    setTextIfChanged(el.status, text);
  }

  // ── 남은 시간 표시 (표시 전용) ──────────────────────────────────
  // 마감은 서버가 판정한다(CLAUDE.md «온라인 deadline 판정은 서버만 소유»). 여기서는 응답을
  // 받은 순간의 performance.now()에 서버가 잰 remainingMs를 더해 표시용 마감을 만들고,
  // 로컬 core/timer.ts처럼 매 프레임 «마감 − 지금»을 다시 계산한다. 기기 시계가 틀려도,
  // 탭이 숨었다 돌아와도 어긋나지 않는다. 0이 되어도 아무것도 제출하지 않는다.

  function stopCountdown(): void {
    if (countdownFrame !== null) cancelAnimationFrame(countdownFrame);
    countdownFrame = null;
    countdownKey = null;
  }

  /** 구버전 서버처럼 남은 시간이 없으면 막대를 채운 채 안내 문구만 둔다. */
  function renderTimeNotice(): void {
    stopCountdown();
    el.timer.classList.remove('timer--warning');
    el.timerFill.style.transform = 'scaleX(1)';
    setTextIfChanged(el.timerText, ONLINE_TIME_NOTICE);
  }

  function syncCountdown(active: OnlineActiveMatch): void {
    const remainingMs = active.remainingMs;
    if (remainingMs === undefined) {
      renderTimeNotice();
      return;
    }
    const key = `${active.matchId}:${active.question.position}:${active.state}`;
    const deadline = performance.now() + remainingMs;
    if (key !== countdownKey) {
      countdownKey = key;
      countdownDeadline = deadline;
      countdownSpan = onlineCountdownSpan(active.state, active.questionTimeMs, remainingMs, 0);
    } else {
      // 같은 phase의 응답은 같은 마감을 가리킨다. 늦게 도착한 응답일수록 마감이 뒤로 밀려
      // 보이므로 가장 이른 추정을 쓴다. 같은 snapshot을 다시 그려도 마감이 늘지 않는다.
      countdownDeadline = Math.min(countdownDeadline, deadline);
      countdownSpan = onlineCountdownSpan(
        active.state,
        active.questionTimeMs,
        remainingMs,
        countdownSpan,
      );
    }
    if (countdownFrame !== null) cancelAnimationFrame(countdownFrame);
    countdownFrame = null;
    tickCountdown();
  }

  function tickCountdown(): void {
    countdownFrame = null;
    const current = snapshot;
    if (current === null || current.state === 'finished' || countdownKey === null) return;
    const remaining = Math.max(countdownDeadline - performance.now(), 0);
    const view = onlineCountdownView(current.state, remaining, countdownSpan, {
      submitted: current.state === 'running'
        && (current.ownSubmission !== null || submissionGate.pendingFor(current)),
      lastQuestion: current.question.position >= current.question.total,
    });
    el.timerFill.style.transform = `scaleX(${view.fraction})`;
    el.timer.classList.toggle('timer--warning', view.warning);
    setTextIfChanged(el.timerText, view.text);

    // 남은 시간 글은 라이브 리전이 아닌 정적 글이다(막대·아이콘만 aria-hidden). 1초마다 바뀌는 값은
    // 낭독하지 않고, 남은 시간이 얼마 없다는 사실만 문항당 한 번 알린다 (로컬과 같은 규칙).
    const questionKey = `${current.matchId}:${current.question.position}`;
    if (view.warning && warnedQuestionKey !== questionKey) {
      warnedQuestionKey = questionKey;
      announce('시간이 얼마 남지 않았어요.');
      // 같은 순간에 온 채팅 줄은 이 경고 뒤에 선다 (U42) — 경고가 채팅 뒤로 밀리지 않는다
      chatLines.yieldTo();
    }
    if (remaining > 0) countdownFrame = requestAnimationFrame(tickCountdown);
  }

  async function submitChoice(index: number): Promise<void> {
    const current = snapshot;
    if (
      !current
      || current.state !== 'running'
      || current.ownSubmission !== null
      || submissionGate.pendingFor(current)
      || index < 0
      || index >= current.question.choices.length
    ) return;

    const owner = submissionGate.begin(current);
    render(current);
    try {
      await onSubmit({ ...owner, choiceIndex: index });
    } catch (error) {
      const latest = snapshot;
      if (!submissionGate.finish(owner, latest)) return;
      if (latest?.state === 'running' && latest.ownSubmission === null) {
        render(latest);
      }
      // 개발 상세는 콘솔에만 남기고 플레이어의 말로 알린다 (U40)
      setStatus(onlineErrorText(error, '답을 보내지 못했어요. 다시 골라 주세요.'));
      return;
    }

    const latest = snapshot;
    if (!submissionGate.finish(owner, latest)) return;
    // 전송이 성공했지만 authoritative snapshot에 제출이 없다면 다시 시도할 수 있다.
    if (latest?.state === 'running' && latest.ownSubmission === null) {
      render(latest);
    }
  }

  function renderChoices(view: OnlineQuizView, structureKey: string): void {
    const question = view.question;
    if (!question) {
      if (el.choices.childElementCount > 0) el.choices.replaceChildren();
      lastChoiceStructureKey = null;
      return;
    }

    const existing = Array.from(el.choices.querySelectorAll<HTMLButtonElement>('.choice'));
    const reconciliation = reconcileOnlineChoiceNodes(
      existing,
      lastChoiceStructureKey,
      structureKey,
      question.choices.length,
      (index) => {
        const text = question.choices[index]!;
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice';

        const key = document.createElement('span');
        key.className = 'choice__key';
        key.textContent = String(index + 1);
        key.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'choice__text';
        label.textContent = text;
        const mark = document.createElement('span');
        mark.className = 'choice__mark';

        button.append(key, label, mark);
        button.addEventListener('click', () => { void submitChoice(index); });
        item.append(button);
        return button;
      },
    );
    if (reconciliation.rebuilt) {
      const items = reconciliation.nodes.map((button) => {
        const item = button.parentElement;
        if (!(item instanceof HTMLLIElement)) throw new Error('online choice item is missing');
        return item;
      });
      el.choices.replaceChildren(...items);
      // 로컬 퀴즈와 같은 배치 표시다. 넷이 모두 짧으면 좁은 화면에서도 2×2
      el.choices.dataset.layout = choiceLayout(question.choices);
    }
    lastChoiceStructureKey = structureKey;
    const buttons = reconciliation.nodes;

    buttons.forEach((button, index) => {
      button.className = 'choice';
      button.disabled = !view.canSubmit || submissionGate.pendingFor(snapshot);
      const mark = button.querySelector<HTMLElement>('.choice__mark');
      if (!mark) throw new Error('online choice mark is missing');
      mark.textContent = '';
      if (view.phase === 'running' && view.selectedChoiceIndex === index) {
        button.classList.add('choice--submitted');
        mark.textContent = '제출됨';
      }
      if (view.reveal !== null) {
        // ✓ ✗ 표식은 디자인 층이 상태 클래스를 보고 아이콘으로 그린다
        if (index === view.reveal.answerIndex) {
          button.classList.add('choice--correct');
          mark.textContent = '정답';
        } else if (index === view.reveal.chosenChoiceIndex) {
          button.classList.add('choice--wrong');
          mark.textContent = '내 답';
        } else {
          button.classList.add('choice--muted');
        }
      }
    });
  }

  /** 로컬 피드백과 같은 «정답 / 내 답» 줄. 공유 마크업(feedback__answer)을 그대로 쓴다. */
  function createAnswerRow(kind: 'correct' | 'mine', label: string, text: string): HTMLElement {
    const row = document.createElement('p');
    row.className = 'feedback__answer-row';
    row.dataset.kind = kind;
    const labelNode = document.createElement('span');
    labelNode.className = 'feedback__answer-label';
    labelNode.textContent = label;
    const textNode = document.createElement('span');
    textNode.className = 'feedback__answer-text';
    textNode.textContent = text;
    row.append(labelNode, ' ', textNode);
    return row;
  }

  function renderRevealAnswer(question: OnlineMatchQuestion, reveal: OnlineQuizRevealView): void {
    const answer = onlineRevealAnswerText(question.choices, reveal);
    const key = answer === null ? null : JSON.stringify([question.id, question.position, answer]);
    if (key === revealAnswerKey) return;
    revealAnswerKey = key;
    if (answer === null) {
      el.revealAnswer.hidden = true;
      el.revealAnswer.replaceChildren();
      return;
    }
    // **먼저 펼치고 넣는다.** 줄을 새로 만들어 붙이므로 «정답 2번 · …»가 이름표째 낭독된다.
    // 같은 공개를 다시 그릴 때(재조회)는 위 key가 같아 다시 낭독하지 않는다.
    el.revealAnswer.hidden = false;
    el.revealAnswer.replaceChildren(
      createAnswerRow('correct', '정답', answer.correct),
      createAnswerRow('mine', '내 답', answer.mine),
    );
  }

  function renderReveal(view: OnlineQuizView): void {
    const reveal = view.reveal;
    el.reveal.hidden = reveal === null;
    // 로컬 피드백 시트와 같은 판정 배지·테두리를 쓰도록 결과를 클래스로도 남긴다
    el.reveal.classList.toggle('online-reveal--correct', reveal?.correct === true);
    el.reveal.classList.toggle('online-reveal--wrong', reveal !== null && !reveal.correct);
    if (reveal === null || view.question === null) {
      revealAnswerKey = null;
      el.revealAnswer.hidden = true;
      el.revealAnswer.replaceChildren();
      return;
    }
    const verdict = reveal.correct
      ? '정답이에요'
      : reveal.timedOut
        ? '시간 초과예요'
        : '아쉬워요, 오답이에요';
    setTextIfChanged(el.verdict, verdict);
    renderRevealAnswer(view.question, reveal);
    setTextIfChanged(el.explanation, reveal.explanation);
  }

  /**
   * 공개 카드 아래의 미니 점수판 (U30). 공개 카드(`aria-live`) 안이지만 순위 목록과 «그 밖에 N명»은
   * `aria-live="off"` 덩어리라 «정답 n/m명» 한 줄만 낭독된다 — 문항마다 순위를 다 읽어 주면 판정·해설을
   * 덮는다. 목록은 브라우즈 모드로 찾아 읽는다. 공개가 아니면 비우고 접는다(숨기기만 하지 않는다).
   */
  function renderStandings(active: OnlineActiveMatch, view: OnlineQuizView): void {
    const standings = view.reveal === null ? null : onlineRevealStandings(active, getPlayerId());
    revealResults = standings?.results ?? null;
    paintRemoteResults();
    // 혼자 판의 점수판은 «정답 1/1명»과 내 줄 하나뿐이다 — 공개 카드의 판정이 이미 말한다 (FR-7.13 3단계)
    if (solo) {
      standingsKey = null;
      el.standings.hidden = true;
      el.standings.replaceChildren();
      return;
    }
    const key = standings === null
      ? null
      : JSON.stringify([
        active.matchId,
        active.question.position,
        standings.rows,
        standings.correctCount,
        standings.hiddenCount,
      ]);
    if (key === standingsKey) return;
    standingsKey = key;
    if (standings === null) {
      el.standings.hidden = true;
      el.standings.replaceChildren();
      return;
    }
    // **먼저 펼치고 넣는다** (라이브 리전 규칙)
    el.standings.hidden = false;
    const children: HTMLElement[] = [];
    const tally = onlineRevealTally(standings);
    if (tally !== null) {
      const line = document.createElement('p');
      line.className = 'online-standings__tally';
      line.textContent = tally;
      children.push(line);
    }
    // 순위 목록과 «그 밖에 N명»은 한 덩어리로 라이브 리전에서 뺀다 — 목록 없이 낭독된 «그 밖에 2명»은
    // 무엇의 수인지 알 수 없다 (a11y-04). 줄 수가 달라지지 않게 «그 밖에»를 목록의 줄로 넣지는 않는다
    const board = document.createElement('div');
    board.className = 'online-standings__board';
    board.setAttribute('aria-live', 'off');
    const list = document.createElement('ol');
    list.className = 'online-standings__list';
    list.setAttribute('aria-label', '지금 순위');
    for (const row of standings.rows) list.append(createStandingRow(row));
    board.append(list);
    if (standings.hiddenCount > 0) {
      const more = document.createElement('p');
      more.className = 'online-standings__more';
      more.textContent = `그 밖에 ${standings.hiddenCount}명`;
      board.append(more);
    }
    children.push(board);
    el.standings.replaceChildren(...children);
  }

  function createStandingRow(row: OnlineRevealStandingRow): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'online-standings__item';
    item.classList.toggle('online-standings__item--mine', row.isMe);
    item.classList.toggle('online-standings__item--gap', row.afterGap);
    const place = document.createElement('span');
    place.className = 'online-standings__place';
    // 금·은·동 칸은 줄 순서가 아니라 표시 순위로 칠한다 (최종 순위와 같다)
    place.dataset.place = String(row.place);
    place.textContent = onlinePlaceLabel(row.place, row.tied);
    const name = document.createElement('span');
    name.className = 'online-standings__name';
    name.textContent = row.nickname;
    item.append(place, name);
    if (row.isMe) {
      // 내 줄은 바탕색만이 아니라 글자로도 짚는다
      const me = document.createElement('span');
      me.className = 'online-standings__me';
      me.textContent = '나';
      item.append(me);
    }
    if (row.correct !== null) {
      // ✓ ✗ 는 디자인 층이 상태 클래스를 보고 그린다. 뜻은 숨긴 글자가 말한다
      const result = document.createElement('span');
      result.className = `online-standings__result online-standings__result--${row.correct ? 'correct' : 'wrong'}`;
      const label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = row.correct ? '이번 문제 정답' : '이번 문제 오답';
      result.append(label);
      item.append(result);
    }
    const score = document.createElement('span');
    score.className = 'online-standings__score';
    score.textContent = `${row.score}점`;
    item.append(score);
    return item;
  }

  /** 내 결과를 소리로도 알린다 (N03, FR-4.5). 문항마다 처음 공개될 때 한 번, 소리 설정을 따른다 */
  function playRevealSound(active: OnlineActiveMatch, view: OnlineQuizView): void {
    if (active.state !== 'revealing' || view.reveal === null) return;
    const key = `${active.matchId}:${active.question.position}`;
    if (key === revealSoundKey) return;
    revealSoundKey = key;
    const cue = onlineRevealSound(view.reveal);
    if (cue === 'correct') playCorrect();
    else if (cue === 'timeout') playTimeout();
    else playWrong();
  }

  /**
   * 공개 카드는 arena 바로 뒤 문서 흐름에 있다. 문항마다 처음 공개될 때 한 번만 보이는 데까지
   * 옮긴다(`nearest` — 이미 보이면 움직이지 않는다). 채팅을 치는 중이면 화면을 옮기지 않는다 —
   * 쓰던 글과 caret을 빼앗지 않는다는 계약과 같다. fixed 캐릭터는 arena 안의 같은 자리로 되돌린다.
   */
  function revealIntoView(active: OnlineActiveMatch): void {
    if (active.state !== 'revealing' || active.reveal === null) return;
    const key = `${active.matchId}:${active.question.position}`;
    if (key === revealScrolledKey) return;
    revealScrolledKey = key;
    if (document.activeElement === el.chatInput) return;
    const anchor = arena.captureCharacterAnchor();
    el.reveal.scrollIntoView({ block: 'nearest' });
    arena.restoreCharacterAnchor(anchor);
    revealMovedPage = true;
  }

  /**
   * 공개 카드를 보려고 내려간 화면은 다음 문제에서 맨 위로 되돌린다. 새 HUD·남은 시간·질문부터
   * 보여야 한다(로컬 피드백을 닫을 때와 같은 규칙). 새 무대 자리를 재기 전에 부른다.
   */
  function returnFromReveal(view: OnlineQuizView): void {
    if (view.reveal !== null || !revealMovedPage) return;
    revealMovedPage = false;
    if (document.activeElement !== el.chatInput) window.scrollTo(0, 0);
  }

  /**
   * 답하는 규칙을 판마다 고른다 (U13). 시간이 끝나면 선 칸이 답인 판이면 무대 아래 규칙 줄과 조작법의
   * 그 문단을, 직접 낸 답만 세는 이전 API의 판이면 «선택을 눌러야 제출» 문단을 보인다.
   */
  function renderAnswerRule(standing: boolean): void {
    el.hintRule.hidden = !standing;
    el.helpRuleStanding.hidden = !standing;
    el.helpRuleSubmit.hidden = standing;
  }

  function render(nextSnapshot: OnlineMatchSnapshot): void {
    submissionGate.reconcile(nextSnapshot);
    snapshot = nextSnapshot;
    const view = onlineQuizView(nextSnapshot, { standingDeliverable });
    if (nextSnapshot.state === 'finished') {
      stopCountdown();
      arena.setEnabled(false);
      if (finishedMatchId !== nextSnapshot.matchId) {
        finishedMatchId = nextSnapshot.matchId;
        onFinished(nextSnapshot);
      }
      return;
    }

    const question = view.question!;
    el.category.textContent = question.categoryId
      ? categoryNames.get(question.categoryId) ?? question.categoryId
      : '전체 도전';
    el.position.textContent = `${question.position}/${question.total}`;
    el.position.setAttribute('aria-label', `전체 ${question.total}문제 중 ${question.position}번 문제`);
    const percent = Math.round((question.position / question.total) * 100);
    el.progressFill.style.width = `${percent}%`;
    el.progress.setAttribute('aria-valuenow', String(percent));
    el.question.textContent = question.question;
    syncCountdown(nextSnapshot);
    setStatus(view.status);
    ruleStatus = view.status;
    const isSubmitPending = submissionGate.pendingFor(nextSnapshot);
    const choiceStructureKey = onlineChoiceStructureKey(nextSnapshot);
    if (choiceStructureKey === null) throw new Error('active match choice key is missing');
    renderChoices(view, choiceStructureKey);
    renderReveal(view);
    returnFromReveal(view);
    renderStandings(nextSnapshot, view);
    playRevealSound(nextSnapshot, view);

    renderAnswerRule(nextSnapshot.standingAnswers === true);
    const arenaQuestionKey = `${nextSnapshot.matchId}:${question.position}`;
    if (arenaQuestionKey !== lastArenaQuestionKey) {
      lastArenaQuestionKey = arenaQuestionKey;
      // 새 문항은 다시 중립이다. 지난 문항에 보낸 초안의 기억을 들고 가지 않는다
      standingPublisher.reset();
      arena.setEnabled(true);
      arena.reset(question.choices.length);
    }
    arena.setSelectionEnabled(onlineArenaSelectionEnabled(view, isSubmitPending));
    // 공개로 넘어갔거나 답을 냈으면 초안은 끝이다. 아직 고르는 중이면 지금 선 칸을 다시 맞춘다
    syncStandingDraft(arena.standingIndex());
    if (view.reveal !== null) {
      arena.showOutcome({
        answerIndex: view.reveal.answerIndex,
        chosenIndex: view.reveal.chosenChoiceIndex,
        correct: view.reveal.correct,
      }, { lockMovement: false });
    }

    const questionKey = `${nextSnapshot.matchId}:${nextSnapshot.state}:${question.position}`;
    if (questionKey !== lastQuestionKey) {
      lastQuestionKey = questionKey;
      // 서버 phase가 바뀌어도 쓰던 메시지와 caret을 빼앗지 않는다.
      // 대화상자(조작법·나가기 확인·앱 바의 설정)가 열려 있으면 그 안에 가둔 포커스를 밖으로 빼지 않는다.
      if (shouldAutoFocusOnlineQuestion(
        anyDialogOpen(),
        document.activeElement === el.chatInput,
      )) {
        el.question.focus({ preventScroll: true });
        // 포커스가 새 문항(또는 공개된 문항)을 읽기 시작했다. 같은 순간에 온 채팅 줄은 그 뒤에 붙인다 (U42)
        chatLines.yieldTo();
      }
    }
    revealIntoView(nextSnapshot);
    // 보기 배치(grid·list)와 공개 카드가 바닥을 옮겼을 수 있다
    refreshStage();
  }

  // ── 매치 나가기 확인 ───────────────────────────────────────────
  // 로컬 퀴즈의 나가기 확인과 같은 인페이지 다이얼로그다(window.confirm 금지). 확인하는 동안에도
  // 매치는 서버에서 계속 흐른다. 떠나도 방에서 나간 것은 아니라 목록의 「들어가기」로 돌아온다.

  function openExitDialog(): void {
    exitDialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.exitDialog.hidden = false;
    el.exitCancel.focus();
  }

  function closeExitDialog(): void {
    if (el.exitDialog.hidden) return;
    el.exitDialog.hidden = true;
    // 열기 전에 있던 자리로 포커스를 돌려준다
    if (exitDialogOpener && document.contains(exitDialogOpener)) exitDialogOpener.focus();
    exitDialogOpener = null;
  }

  function confirmExit(): void {
    el.exitDialog.hidden = true;
    exitDialogOpener = null;
    onExit();
  }

  el.exit.addEventListener('click', openExitDialog);
  el.exitCancel.addEventListener('click', closeExitDialog);
  el.exitConfirm.addEventListener('click', confirmExit);
  document.addEventListener('keydown', (event) => {
    // **누르고 있는 Enter·Space의 자동 반복은 받지 않는다** (FR-4.4, 로컬 퀴즈·설정 대화상자와 같은
    // 규칙). 「나가기」를 Enter로 연 채 누르고 있으면 반복이 곧바로 포커스가 간 「계속 풀기」를 눌러
    // 확인창을 닫고, 다음 반복이 다시 연다. 조작법의 「닫기」도 같다. 기본 동작까지 막는다.
    if (!el.screen.hidden && isHeldButtonRepeat(event, document.activeElement)) {
      event.preventDefault();
      return;
    }
    // 나가기 확인이 열려 있으면 그 안에서만 움직인다. 숫자키·채팅 `/`가 뒤로 새지 않는다.
    if (!el.exitDialog.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeExitDialog();
      } else if (event.key === 'Tab') {
        trapFocus(el.exitDialog, event);
      }
      return;
    }
    if (arena.handleDialogKey(event)) return;
    if (el.screen.hidden || arena.isDialogOpen()) return;
    if (event.key === '/' && document.activeElement !== el.chatInput && presenceActive) {
      // 혼자 판은 채팅을 거둔다 (FR-7.13 3단계) — `/`는 브라우저 몫으로 둔다
      if (el.chatSection.hidden) return;
      event.preventDefault();
      el.chatInput.focus();
      return;
    }
    if (document.activeElement === el.chatInput) return;
    if (snapshot?.state === 'running') {
      const choiceIndex = ['1', '2', '3', '4'].indexOf(event.key);
      if (choiceIndex !== -1 && !document.activeElement?.closest('button')) {
        const button = el.choices.querySelectorAll<HTMLButtonElement>('.choice')[choiceIndex];
        if (button && !button.disabled) {
          event.preventDefault();
          button.click();
          return;
        }
      }
    }
    if (handleOnlineMovementKey(snapshot, event, arena)) event.preventDefault();
  });

  function setStandingDelivery(deliverable: boolean): void {
    if (!presenceActive || deliverable === standingDeliverable) return;
    standingDeliverable = deliverable;
    const current = snapshot;
    // 판의 규칙 줄이 보이는 동안만 고친다. 답을 보내지 못한 이유·다시 읽지 못한 이유는 그대로 둔다
    if (current === null || current.state !== 'running' || el.status.textContent !== ruleStatus) return;
    const status = onlineQuizView(current, { standingDeliverable }).status;
    setStatus(status);
    ruleStatus = status;
  }

  return {
    startPresence,
    setRoom,
    updateMovement,
    setStandingDelivery,
    updateChat,
    stopPresence,
    render,
    setCharacter(id) {
      arena.setCharacter(id);
    },
    setSolo(next) {
      solo = next;
      // 혼자 방에는 말을 받을 사람이 없다. 채팅 표면째 거두고, 그 자리의 손가락 조작부 비움은 상태 줄이
      // 이어 받는다(style.css 의 `[data-solo='true'] .online-match-status`)
      el.chatSection.hidden = next;
      el.screen.dataset.solo = String(next);
      el.exitTitle.textContent = next ? '혼자 판을 떠날까요?' : exitCopy.title;
      el.exitBody.textContent = next ? SOLO_EXIT_BODY : exitCopy.body;
      standingsKey = null;
    },
    setNotice(message) {
      setStatus(message);
    },
    // message는 controller가 이미 플레이어의 말로 옮겼다(onlineErrorText). «오류:» 머리말을 붙이지 않는다
    setRefreshError(message) {
      setStatus(message);
    },
    setSubmitError(message, owner) {
      const current = snapshot;
      if (!ownsOnlineSubmitError(current, owner) || !submissionGate.owns(owner)) return;
      const interrupted = submissionGate.pendingFor(current);
      submissionGate.invalidate(owner);
      if (interrupted && current.ownSubmission === null) {
        render(current);
      }
      setStatus(message);
    },
    hide() {
      // stopPresence가 표시 루프와 나가기 확인도 함께 접는다.
      stopPresence();
      arena.closeDialog();
      el.choices.replaceChildren();
    },
  };
}
