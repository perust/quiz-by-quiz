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
} from '../online/adapter.js';
import type { Arena, ArenaDeps } from './arena.js';

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
  finish(owner: OnlineSubmissionOwner, snapshot: OnlineMatchSnapshot | null): boolean;
  invalidate(owner?: OnlineSubmissionOwner): void;
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
    finish(owner, snapshot) {
      if (pending !== owner || !ownsQuestion(owner, snapshot)) return false;
      pending = null;
      return true;
    },
    invalidate(owner) {
      if (!owner || pending === owner) pending = null;
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
  onSubmit: (spec: { position: number; choiceIndex: number }) => Promise<void>;
  onExit: () => void;
  onFinished: (snapshot: Extract<OnlineMatchSnapshot, { state: 'finished' }>) => void;
  createCharacterArena: (deps: ArenaDeps) => Arena;
  trapFocus: (container: HTMLElement, event: KeyboardEvent) => void;
}

export interface OnlineQuizScreen {
  render(snapshot: OnlineMatchSnapshot): void;
  /** 홈에서 고른 캐릭터를 온라인 문제 무대에도 적용한다. */
  setCharacter(id: string): void;
  /** 오류가 아닌 안내용 transport/state 문구. */
  setNotice(message: string): void;
  setError(message: string): void;
  hide(): void;
}

export function createOnlineQuizScreen(
  { onSubmit, onExit, onFinished, createCharacterArena, trapFocus }: OnlineQuizScreenDeps,
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
    status: need('online-match-status'),
    reveal: need('online-reveal'),
    verdict: need('online-reveal-verdict'),
    explanation: need('online-reveal-explanation'),
    exit: need<HTMLButtonElement>('online-quiz-exit'),
  };
  const categoryNames = new Map(CATEGORIES.map((category) => [category.id, category.name]));
  let snapshot: OnlineMatchSnapshot | null = null;
  const submissionGate = createOnlineSubmissionGate();
  let lastQuestionKey: string | null = null;
  let lastArenaQuestionKey: string | null = null;
  let finishedMatchId: string | null = null;

  const arena = createCharacterArena({
    onChoose: (index) => { void submitChoice(index); },
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

  function setStatus(text: string): void {
    el.status.textContent = text;
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
      await onSubmit({ position: current.question.position, choiceIndex: index });
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

  function renderChoices(view: OnlineQuizView): void {
    const question = view.question;
    if (!question) {
      el.choices.replaceChildren();
      return;
    }
    el.choices.replaceChildren();
    question.choices.forEach((text, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice';
      button.disabled = !view.canSubmit || submissionGate.pendingFor(snapshot);

      const key = document.createElement('span');
      key.className = 'choice__key';
      key.textContent = String(index + 1);
      key.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'choice__text';
      label.textContent = text;
      const mark = document.createElement('span');
      mark.className = 'choice__mark';

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
      button.append(key, label, mark);
      button.addEventListener('click', () => { void submitChoice(index); });
      item.append(button);
      el.choices.append(item);
    });
  }

  function renderReveal(view: OnlineQuizView): void {
    const reveal = view.reveal;
    el.reveal.hidden = reveal === null;
    if (reveal === null) return;
    if (reveal.correct) el.verdict.textContent = '정답입니다';
    else if (reveal.timedOut) el.verdict.textContent = '시간 초과입니다';
    else el.verdict.textContent = '아쉽네요, 오답입니다';
    el.explanation.textContent = reveal.explanation;
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
    renderChoices(view);
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
      if (!arena.isDialogOpen()) el.question.focus({ preventScroll: true });
    }
  }

  el.exit.addEventListener('click', onExit);
  document.addEventListener('keydown', (event) => {
    if (arena.handleDialogKey(event)) return;
    if (el.screen.hidden || !snapshot || snapshot.state !== 'running') return;
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
    render,
    setCharacter(id) {
      arena.setCharacter(id);
    },
    setNotice(message) {
      setStatus(message);
    },
    setError(message) {
      const current = snapshot;
      const interrupted = submissionGate.pendingFor(current);
      submissionGate.invalidate();
      if (interrupted && current?.state === 'running' && current.ownSubmission === null) {
        lastArenaQuestionKey = null;
        render(current);
      }
      setStatus(`온라인 매치 오류: ${message}`);
    },
    hide() {
      arena.setEnabled(false);
      arena.closeDialog();
      submissionGate.invalidate();
      snapshot = null;
      lastQuestionKey = null;
      lastArenaQuestionKey = null;
      el.reveal.hidden = true;
      el.choices.replaceChildren();
    },
  };
}
