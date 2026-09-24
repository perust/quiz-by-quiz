// Server-authoritative online match screen.
//
// This module intentionally does not import core/session, core/sampler, or scoring.
// Its inputs are validated REST snapshots; its only output is a position + choice index
// submission through the controller supplied by app.ts.

import { CATEGORIES } from '../constants.js';
import { need, needOne } from '../dom.js';
import type {
  OnlineMatchQuestion,
  OnlineMatchSnapshot,
  PublicRoom,
  RoomEvent,
} from '../online/adapter.js';
import type { Arena, ArenaDeps } from './arena.js';
import {
  createPlayerBubbleController,
  shouldPlacePlayerBubbleBelow,
} from './player-bubbles.js';
import {
  createMovementPublisher,
  createPlayerMovementController,
  normalizeViewportMovement,
  type MovementSample,
} from './player-movement.js';
import { createBody } from './sprite.js';

type OnlineMovementEvent = Extract<RoomEvent, { type: 'movement' }>;
type OnlineChatEvent = Extract<RoomEvent, { type: 'chat' }>;

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

/** Pure projection: hidden match data has no path into a running UI. */
export function onlineQuizView(snapshot: OnlineMatchSnapshot): OnlineQuizView {
  if (snapshot.state === 'running') {
    const submission = snapshot.ownSubmission;
    return {
      phase: 'running',
      question: snapshot.question,
      canSubmit: canAttemptOnlineSubmission(snapshot),
      selectedChoiceIndex: submission?.choiceIndex ?? null,
      reveal: null,
      status: submission === null
        ? '캐릭터로 답을 고르면 서버에 제출합니다.'
        : '답안을 제출했습니다. 서버 결과를 기다려 주세요.',
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
      status: '서버가 이번 문제의 결과를 공개했습니다.',
      showFinalResult: false,
    };
  }
  return {
    phase: 'finished',
    question: null,
    canSubmit: false,
    selectedChoiceIndex: null,
    reveal: null,
    status: '서버가 최종 순위를 확정했습니다.',
    showFinalResult: true,
  };
}

export interface OnlineQuizScreenDeps {
  onSubmit: (spec: OnlineSubmissionOwner & { choiceIndex: number }) => Promise<void>;
  onMovement: (sample: MovementSample) => void;
  onSendChat: (text: string) => Promise<{ ok: boolean }>;
  onExit: () => void;
  onFinished: (snapshot: Extract<OnlineMatchSnapshot, { state: 'finished' }>) => void;
  getPlayerId: () => string;
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
  /** 같은 match socket에서 온 인증된 채팅을 로그와 캐릭터 말풍선에 반영한다. */
  updateChat(event: OnlineChatEvent): void;
  /** socket을 닫기 전에 마지막 정지 좌표를 보내고 presence를 정리한다. */
  stopPresence(): void;
  render(snapshot: OnlineMatchSnapshot): void;
  /** 홈에서 고른 캐릭터를 온라인 문제 무대에도 적용한다. */
  setCharacter(id: string): void;
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
    onSendChat,
    onExit,
    onFinished,
    getPlayerId,
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
    timerIcon: need('online-timer-icon'),
    timerText: need('online-timer-text'),
    question: need<HTMLHeadingElement>('online-question-text'),
    choices: need('online-choices'),
    presenceStatus: need('online-presence-status'),
    status: need('online-match-status'),
    reveal: need('online-reveal'),
    verdict: need('online-reveal-verdict'),
    explanation: need('online-reveal-explanation'),
    remoteCharacters: need('online-remote-characters'),
    bubble: need('online-bubble'),
    chatForm: need<HTMLFormElement>('online-chat-form'),
    chatInput: need<HTMLInputElement>('online-chat-input'),
    chatSubmit: need<HTMLButtonElement>('online-chat-submit'),
    chatLog: need('online-chat-log'),
    exit: need<HTMLButtonElement>('online-quiz-exit'),
  };
  const categoryNames = new Map(CATEGORIES.map((category) => [category.id, category.name]));
  let snapshot: OnlineMatchSnapshot | null = null;
  const submissionGate = createOnlineSubmissionGate();
  let lastQuestionKey: string | null = null;
  let lastArenaQuestionKey: string | null = null;
  let lastChoiceStructureKey: string | null = null;
  let finishedMatchId: string | null = null;
  let presenceActive = false;
  /** Chat POST completion from an exited/replaced match must not mutate the next screen. */
  let presenceGeneration = 0;
  let chatSendPending = false;
  let movementHeartbeat: number | undefined;
  const remoteMovements = createPlayerMovementController();
  const chatBubbles = createPlayerBubbleController({ durationMs: BUBBLE_MS });
  const chatBubbleNodes = new Map<string, HTMLElement>();
  const movementPublisher = createMovementPublisher({
    send: (sample) => {
      if (presenceActive) onMovement(sample);
    },
  });

  const arena = createCharacterArena({
    onChoose: (index) => { void submitChoice(index); },
    onMove: (point, moving) => {
      const sample = normalizeViewportMovement(point, moving, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      if (sample) movementPublisher.update(sample);
      if (!el.bubble.hidden) fitChatBubble(el.bubble);
    },
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
    el.chatLog.replaceChildren();
    // 로비 fetch를 기다리는 동안 문제 화면이 잠시 남아도 새 제출이나 늦은 완료가
    // 이 lifecycle을 다시 그릴 수 없어야 한다.
    submissionGate.invalidate();
    snapshot = null;
    lastQuestionKey = null;
    lastArenaQuestionKey = null;
    lastChoiceStructureKey = null;
    el.reveal.hidden = true;
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
    movementPublisher.resend();
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

  function appendChatLine(nickname: string, text: string): void {
    const line = document.createElement('li');
    line.className = 'chat-log__line';
    const who = document.createElement('span');
    who.className = 'chat-log__who';
    who.textContent = nickname;
    line.append(who, ' ', text);
    el.chatLog.append(line);
    while (el.chatLog.children.length > CHAT_LINES) el.chatLog.firstElementChild!.remove();
  }

  function chatNotice(text: string): void {
    const line = document.createElement('li');
    line.className = 'chat-log__line chat-log__line--notice';
    line.textContent = text;
    el.chatLog.append(line);
    while (el.chatLog.children.length > CHAT_LINES) el.chatLog.firstElementChild!.remove();
  }

  function updateChat(event: OnlineChatEvent): void {
    if (!presenceActive) return;
    appendChatLine(event.nickname, event.text);
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

  /** The server owns expiry. This is an informational label, not a local countdown. */
  function renderServerTimeNotice(): void {
    el.timer.classList.remove('timer--warning');
    el.timerFill.style.transform = 'scaleX(1)';
    el.timerIcon.textContent = '⏱';
    el.timerText.textContent = '제출 시간은 서버가 관리합니다.';
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
    arena.lock();
    render(current);
    try {
      await onSubmit({ ...owner, choiceIndex: index });
    } catch (error) {
      const latest = snapshot;
      if (!submissionGate.finish(owner, latest)) return;
      if (latest?.state === 'running' && latest.ownSubmission === null) {
        lastArenaQuestionKey = null;
        render(latest);
      }
      const message = error instanceof Error ? error.message : '답안을 제출하지 못했습니다.';
      setStatus(`온라인 매치 오류: ${message}`);
      return;
    }

    const latest = snapshot;
    if (!submissionGate.finish(owner, latest)) return;
    // 전송이 성공했지만 authoritative snapshot에 제출이 없다면 다시 시도할 수 있다.
    if (latest?.state === 'running' && latest.ownSubmission === null) {
      lastArenaQuestionKey = null;
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
        if (index === view.reveal.answerIndex) {
          button.classList.add('choice--correct');
          mark.textContent = '✓ 정답';
        } else if (index === view.reveal.chosenChoiceIndex) {
          button.classList.add('choice--wrong');
          mark.textContent = '✗ 내 답';
        } else {
          button.classList.add('choice--muted');
        }
      }
    });
  }

  function renderReveal(view: OnlineQuizView): void {
    const reveal = view.reveal;
    el.reveal.hidden = reveal === null;
    if (reveal === null) return;
    const verdict = reveal.correct
      ? '정답입니다'
      : reveal.timedOut
        ? '시간 초과입니다'
        : '아쉽네요, 오답입니다';
    setTextIfChanged(el.verdict, verdict);
    setTextIfChanged(el.explanation, reveal.explanation);
  }

  function render(nextSnapshot: OnlineMatchSnapshot): void {
    submissionGate.reconcile(nextSnapshot);
    snapshot = nextSnapshot;
    const view = onlineQuizView(nextSnapshot);
    if (nextSnapshot.state === 'finished') {
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
    el.position.textContent = `${question.position} / ${question.total}`;
    const percent = Math.round((question.position / question.total) * 100);
    el.progressFill.style.width = `${percent}%`;
    el.progress.setAttribute('aria-valuenow', String(percent));
    el.question.textContent = question.question;
    renderServerTimeNotice();
    setStatus(view.status);
    const choiceStructureKey = onlineChoiceStructureKey(nextSnapshot);
    if (choiceStructureKey === null) throw new Error('active match choice key is missing');
    renderChoices(view, choiceStructureKey);
    renderReveal(view);

    const arenaQuestionKey = `${nextSnapshot.matchId}:${question.position}`;
    if (arenaQuestionKey !== lastArenaQuestionKey) {
      lastArenaQuestionKey = arenaQuestionKey;
      arena.setEnabled(true);
      arena.reset(question.choices.length);
    }
    if (view.reveal !== null) {
      arena.showOutcome({
        answerIndex: view.reveal.answerIndex,
        chosenIndex: view.reveal.chosenChoiceIndex,
        correct: view.reveal.correct,
      });
    } else if (!view.canSubmit || submissionGate.pendingFor(nextSnapshot)) {
      arena.lock();
    }

    const questionKey = `${nextSnapshot.matchId}:${nextSnapshot.state}:${question.position}`;
    if (questionKey !== lastQuestionKey) {
      lastQuestionKey = questionKey;
      // 서버 phase가 바뀌어도 쓰던 메시지와 caret을 빼앗지 않는다.
      if (shouldAutoFocusOnlineQuestion(
        arena.isDialogOpen(),
        document.activeElement === el.chatInput,
      )) {
        el.question.focus({ preventScroll: true });
      }
    }
  }

  el.exit.addEventListener('click', onExit);
  document.addEventListener('keydown', (event) => {
    if (arena.handleDialogKey(event)) return;
    if (el.screen.hidden || arena.isDialogOpen()) return;
    if (event.key === '/' && document.activeElement !== el.chatInput && presenceActive) {
      event.preventDefault();
      el.chatInput.focus();
      return;
    }
    if (document.activeElement === el.chatInput) return;
    if (!snapshot || snapshot.state !== 'running') return;
    const choiceIndex = ['1', '2', '3', '4'].indexOf(event.key);
    if (choiceIndex !== -1 && !document.activeElement?.closest('button')) {
      const button = el.choices.querySelectorAll<HTMLButtonElement>('.choice')[choiceIndex];
      if (button && !button.disabled) {
        event.preventDefault();
        button.click();
        return;
      }
    }
    if (arena.handleKey(event)) event.preventDefault();
  });

  return {
    startPresence,
    setRoom,
    updateMovement,
    updateChat,
    stopPresence,
    render,
    setCharacter(id) {
      arena.setCharacter(id);
    },
    setNotice(message) {
      setStatus(message);
    },
    setRefreshError(message) {
      setStatus(`온라인 매치 오류: ${message}`);
    },
    setSubmitError(message, owner) {
      const current = snapshot;
      if (!ownsOnlineSubmitError(current, owner) || !submissionGate.owns(owner)) return;
      const interrupted = submissionGate.pendingFor(current);
      submissionGate.invalidate(owner);
      if (interrupted && current.ownSubmission === null) {
        lastArenaQuestionKey = null;
        render(current);
      }
      setStatus(`온라인 매치 오류: ${message}`);
    },
    hide() {
      stopPresence();
      arena.closeDialog();
      el.choices.replaceChildren();
    },
  };
}
