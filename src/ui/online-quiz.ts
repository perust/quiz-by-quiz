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
        ? '답을 고르면 서버에 제출합니다.'
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
}

export interface OnlineQuizScreen {
  render(snapshot: OnlineMatchSnapshot): void;
  /** 오류가 아닌 안내용 transport/state 문구. */
  setNotice(message: string): void;
  setError(message: string): void;
  hide(): void;
}

export function createOnlineQuizScreen(
  { onSubmit, onExit, onFinished }: OnlineQuizScreenDeps,
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
  let submissionPending = false;
  let lastQuestionKey: string | null = null;
  let finishedMatchId: string | null = null;

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
      button.disabled = !view.canSubmit || submissionPending;

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
      button.addEventListener('click', () => {
        if (!snapshot || snapshot.state !== 'running' || !view.canSubmit || submissionPending) return;
        submissionPending = true;
        render(snapshot);
        void onSubmit({ position: question.position, choiceIndex: index }).finally(() => {
          submissionPending = false;
          if (snapshot) render(snapshot);
        });
      });
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
    snapshot = nextSnapshot;
    const view = onlineQuizView(nextSnapshot);
    if (nextSnapshot.state === 'finished') {
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

    const questionKey = `${nextSnapshot.matchId}:${nextSnapshot.state}:${question.position}`;
    if (questionKey !== lastQuestionKey) {
      lastQuestionKey = questionKey;
      el.question.focus({ preventScroll: true });
    }
  }

  el.exit.addEventListener('click', onExit);
  document.addEventListener('keydown', (event) => {
    if (el.screen.hidden || !snapshot || snapshot.state !== 'running') return;
    const choiceIndex = ['1', '2', '3', '4'].indexOf(event.key);
    if (choiceIndex === -1 || document.activeElement?.closest('button')) return;
    const button = el.choices.querySelectorAll<HTMLButtonElement>('.choice')[choiceIndex];
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  });

  return {
    render,
    setNotice(message) {
      setStatus(message);
    },
    setError(message) {
      setStatus(`온라인 매치 오류: ${message}`);
    },
    hide() {
      snapshot = null;
      submissionPending = false;
      lastQuestionKey = null;
      el.reveal.hidden = true;
      el.choices.replaceChildren();
    },
  };
}
