// 퀴즈 화면 렌더링
// 게임 규칙은 core/session.js가, 시간 계산은 core/timer.js가 갖고 있다.
// 이 파일은 그 값들을 화면에 그리고 사용자 입력을 로직으로 넘기는 일만 한다.

import { WARNING_THRESHOLD_MS } from '../constants.js';
import { createQuestionTimer } from '../core/timer.js';
import { playCorrect, playTimeout, playWrong } from '../audio.js';
import { need, needOne } from '../dom.js';
import { announce } from './screens.js';
import { createArena } from './arena.js';
import type { Point } from './walker.js';
import type { QuizSession } from '../core/session.js';
import type { AnswerRecord, Question } from '../types.js';

/** 키보드로 보기를 선택할 때 쓰는 키 (FR-3.5) */
const CHOICE_KEYS = ['1', '2', '3', '4'];

/** 채점 뒤 다음 문제로 넘어가는 키. 캐릭터 조작 안내와 같아야 한다. */
const NEXT_KEYS = ['Enter', ' '];

/** 다이얼로그 안에서 Tab이 맴돌게 할 대상 */
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** app.ts가 넘겨주는 콜백 뭉치 */
export interface QuizScreenDeps {
  onExit: () => void;
  onComplete: (session: QuizSession) => void;
}

export interface QuizScreen {
  /**
   * 새 판을 화면에 올린다.
   * @param newSession core/session.js가 만든 세션
   */
  start(newSession: QuizSession, view: { categoryLabel: string }): void;

  /** 무대에서 쓸 캐릭터를 갈아 끼운다. 홈에서 고른 것이 여기로 온다 */
  setCharacter(id: string): void;


  /**
   * 판을 접고 화면을 정리한다.
   *
   * **다른 화면으로 옮길 때 반드시 부른다.** 퀴즈는 제 안에서 나가는 길
   * (나가기·완주)만 정리했는데, 그 길을 거치지 않고 화면이 바뀌면 **세션과
   * 타이머가 살아남는다.** 그러면 로비에서 방 이름을 적는 중에 「시간 초과입니다」가
   * 뜨고, 피드백 시트는 `<main>` 밖이라 어느 화면에서든 보인다.
   *
   * 이미 접혀 있으면 아무 일도 하지 않으므로 어디서 불러도 안전하다.
   */
  hide(): void;
}

export function createQuizScreen({ onExit, onComplete }: QuizScreenDeps): QuizScreen {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="quiz"]'),
    category: need('quiz-category'),
    position: need('quiz-position'),
    progress: need('progress'),
    progressFill: need('progress-fill'),
    timer: need('timer'),
    timerFill: need('timer-fill'),
    timerText: need('timer-text'),
    question: need('question-text'),
    choices: need('choices'),
    feedback: need('feedback'),
    verdict: need('feedback-verdict'),
    explanation: need('feedback-explanation'),
    nextButton: need('next-button'),
    nextLabel: need('next-label'),
    exitButton: need('quiz-exit'),
    dialog: need('exit-dialog'),
    dialogCancel: need('exit-cancel'),
    dialogConfirm: need('exit-confirm'),
  };

  const timer = createQuestionTimer();

  // 캐릭터 무대. 고른 번호를 넘겨줄 뿐이고 채점에는 관여하지 않는다.
  // 조작법 대화상자도 여기와 같은 포커스 가두기를 쓰라고 trapFocus를 넘긴다.
  const arena = createArena({
    onChoose: (index) => selectChoice(index),
    // 캐릭터가 위 보기 버튼 위에 서도 같은 번호로 본다
    getChoiceNodes: () => el.choices.querySelectorAll('.choice'),
    trapFocus,
    // 도움말을 보는 동안 시간이 끝났다면 닫는 즉시 결과 패널로 이어 간다.
    onDialogClose: () => {
      if (!el.feedback.hidden && feedbackWaitingForDialogClose) {
        feedbackWaitingForDialogClose = false;
        revealFeedback();
      }
    },
  });

  /**
   * 지금 돌고 있는 판. 화면을 떠나면 null이다.
   *
   * 아래 그리기 함수들은 «판이 있을 때만» 불린다 — 들어오는 길목(selectChoice·
   * handleTimeout·goNext)이 모두 `if (!session) return`으로 막고, renderQuestion은
   * start와 goNext에서만 불린다. TS는 클로저 변수를 그만큼 좁혀 주지 못하므로
   * 그 안에서는 `!`로 «여기서는 반드시 있다»를 적는다.
   */
  let session: QuizSession | null = null;
  let categoryLabel = '';
  let frameId: number | null = null;
  /** 초 단위 표시가 바뀔 때만 텍스트를 고쳐 쓰기 위한 기억값 */
  let lastShownSeconds: number | null = null;
  /** 문항마다 시간 경고를 한 번만 알리기 위한 표시 */
  let warned = false;
  /** 다이얼로그를 연 버튼. 닫을 때 포커스를 되돌려 준다 */
  let dialogOpener: HTMLElement | null = null;
  /** 피드백 레이아웃 전 캐릭터 발의 arena 내부 상대 좌표 */
  let feedbackCharacterAnchor: Point | null = null;
  /** 열린 dialog 뒤에서 timeout 결과가 나와, 닫을 때 다음 버튼으로 이어야 하는가 */
  let feedbackWaitingForDialogClose = false;

  // ── 타이머 표시 ────────────────────────────────────────────────

  function renderTimer(remainingMs: number): void {
    const remaining = Math.max(remainingMs, 0);
    el.timerFill.style.transform = `scaleX(${remaining / timer.limitMs})`;

    const seconds = Math.ceil(remaining / 1000);
    if (seconds === lastShownSeconds) return;
    lastShownSeconds = seconds;

    // 경고는 색상뿐 아니라 아이콘·문구로도 알린다 (FR-3.9).
    // 아이콘(시계 → 경고 삼각형)은 디자인 층이 timer--warning 을 보고 바꿔 그린다
    const isWarning = remaining <= WARNING_THRESHOLD_MS;
    el.timer.classList.toggle('timer--warning', isWarning);
    el.timerText.textContent = isWarning ? `서두르세요 · ${seconds}초 남음` : `남은 시간 ${seconds}초`;

    // 타이머 영역은 aria-hidden이라 낭독되지 않는다.
    // 남은 시간이 얼마 없다는 사실만 문항당 한 번 알린다.
    if (isWarning && !warned) {
      warned = true;
      announce('시간이 얼마 남지 않았습니다.');
    }
  }

  // 매 프레임 남은 시간을 "다시 계산"한다. 프레임이 밀리거나 탭이 백그라운드로
  // 내려갔다 와도 timer가 시작 시각 기준으로 답하므로 시간이 어긋나지 않는다.
  function startTicking(): void {
    stopTicking();
    const tick = () => {
      const remaining = timer.remainingMs();
      renderTimer(remaining);
      if (remaining <= 0) {
        frameId = null;
        handleTimeout();
        return;
      }
      frameId = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopTicking(): void {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  }

  // ── 문제 렌더링 ────────────────────────────────────────────────

  function renderChoices(question: Question): void {
    el.choices.replaceChildren();

    question.choices.forEach((text, index) => {
      const item = document.createElement('li');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice';

      const key = document.createElement('span');
      key.className = 'choice__key';
      key.textContent = String(index + 1);
      key.setAttribute('aria-hidden', 'true'); // 번호는 시각·단축키용 표시다

      const label = document.createElement('span');
      label.className = 'choice__text';
      label.textContent = text;

      const mark = document.createElement('span');
      mark.className = 'choice__mark';

      button.append(key, label, mark);
      button.addEventListener('click', () => selectChoice(index));

      item.append(button);
      el.choices.append(item);
    });
  }

  function updateProgress(): void {
    const percent = Math.round(session!.progressRatio * 100);
    el.progressFill.style.width = `${percent}%`;
    el.progress.setAttribute('aria-valuenow', String(percent));
  }

  /**
   * 피드백 시트를 닫고, 그만큼 두었던 아래 여백도 거둔다.
   *
   * **화면을 떠날 때는 반드시 부른다.** 시트는 `<main>` 밖에 있어(그래야 z-index 없이
   * 위에 온다) 퀴즈 화면이 숨겨져도 따라 사라지지 않는다 — 조작법 대화상자와 같은
   * 이유이고, 놓치면 결과 화면이나 홈 위에 그대로 남는다.
   */
  function hideFeedback(): void {
    const wasVisible = !el.feedback.hidden;
    el.feedback.hidden = true;
    el.feedback.classList.remove('feedback--correct', 'feedback--wrong');
    feedbackCharacterAnchor = null;
    feedbackWaitingForDialogClose = false;
    // 피드백은 문서 흐름에서 화면 뒤에 이어진다. 다음 문제·결과로 갈 때 그 위치에
    // 스크롤이 남으면 새 화면의 머리말을 건너뛰므로 맨 위로 되돌린다.
    if (wasVisible) window.scrollTo(0, 0);
  }

  /** 결과 패널까지 문서를 옮기고 새 arena의 같은 상대 위치에 fixed 캐릭터를 복원한다. */
  function revealFeedback(focusNext = true): void {
    if (focusNext && el.dialog.hidden && !arena.isDialogOpen()) {
      el.nextButton.focus({ preventScroll: true });
    }
    el.feedback.scrollIntoView({ block: 'end' });
    if (feedbackCharacterAnchor) arena.restoreCharacterAnchor(feedbackCharacterAnchor);
  }

  function renderQuestion(): void {
    const question = session!.currentQuestion();

    el.category.textContent = categoryLabel;
    el.position.textContent = `${session!.position}/${session!.total}`;
    el.position.setAttribute('aria-label', `전체 ${session!.total}문제 중 ${session!.position}번 문제`);
    el.question.textContent = question.question;

    updateProgress();
    renderChoices(question);
    arena.reset(question.choices.length);

    hideFeedback();

    // 문제가 화면에 나타나는 지금이 타이머 시작 시점이다 (FR-3.8)
    lastShownSeconds = null;
    warned = false;
    timer.start();
    startTicking();

    // 문제로 포커스를 옮겨 스크린리더가 새 문항을 읽게 한다.
    // 여기서 Tab을 누르면 곧바로 첫 보기로 간다.
    el.question.focus({ preventScroll: true });
  }

  // ── 응답 처리 ──────────────────────────────────────────────────

  function selectChoice(index: number): void {
    if (!session || session.isAnswered()) return;
    timer.stop();
    showFeedback(session.submit({ choiceIndex: index, elapsedMs: timer.elapsedMs() }));
  }

  function handleTimeout(): void {
    if (!session || session.isAnswered()) return;
    timer.stop();

    // 시간이 다 됐을 때 «밟고 있는 칸»이 답이다.
    // 십자 한가운데에서 시작하므로, 움직이지 않았으면 밟은 칸이 없어 null이 된다.
    // 즉 가만히 있으면 시간 초과 오답이다.
    const standing = arena.standingIndex();

    // choiceIndex가 null이면 시간 초과다. 오답과 똑같이 정답과 해설을 보여준다 (FR-3.10)
    showFeedback(session.submit({ choiceIndex: standing, elapsedMs: timer.limitMs }));
  }

  function showFeedback(record: AnswerRecord): void {
    stopTicking();
    renderTimer(timer.remainingMs()); // 멈춘 시점의 남은 시간으로 고정
    feedbackCharacterAnchor = arena.captureCharacterAnchor();

    const question = session!.currentQuestion();
    const buttons = el.choices.querySelectorAll<HTMLButtonElement>('.choice');

    buttons.forEach((button, index) => {
      button.disabled = true; // 같은 문제를 다시 풀 수 없다 (FR-3.3)
      const mark = button.querySelector('.choice__mark')!;

      // ✓ ✗ 표식은 디자인 층이 상태 클래스를 보고 아이콘으로 그린다. 글에는 뜻만 남긴다
      if (index === question.answerIndex) {
        button.classList.add('choice--correct');
        mark.textContent = '정답';
      } else if (index === record.choiceIndex) {
        button.classList.add('choice--wrong');
        mark.textContent = '오답';
      } else {
        button.classList.add('choice--muted');
      }
    });

    updateProgress();

    // 무대에도 같은 결과를 칠한다. 정답이 몇 번인지는 여기서 알려준다
    arena.showOutcome({
      answerIndex: question.answerIndex,
      chosenIndex: record.choiceIndex,
      correct: record.correct,
    });

    el.feedback.classList.add(record.correct ? 'feedback--correct' : 'feedback--wrong');

    // **먼저 펼치고 넣는다.** 숨긴 채로 라이브 리전을 채우면 낭독되지 않는다.
    // 같은 태스크 안에서 내용까지 채우므로 이전 문항의 피드백이 비치지는 않는다.
    // 자동 전환 없이 「다음 문제」를 눌러야 넘어간다 (FR-4.4)
    el.feedback.hidden = false;

    if (record.correct) {
      el.verdict.textContent = '정답입니다';
      playCorrect();
    } else if (record.timedOut) {
      el.verdict.textContent = '시간 초과입니다';
      playTimeout();
    } else {
      el.verdict.textContent = '아쉽네요, 오답입니다';
      playWrong();
    }
    el.explanation.textContent = question.explanation;

    // 버튼이 아니라 글자 span만 바꾼다. 버튼째 갈아치우면 Enter 표시가 지워진다
    el.nextLabel.textContent = session!.hasNext() ? '다음 문제' : '결과 보기';

    // 열린 dialog의 focus trap은 건드리지 않는다. timeout이 뒤에서 났을 때만
    // dialog가 닫히는 순간 다음 버튼으로 이어 간다.
    feedbackWaitingForDialogClose = !el.dialog.hidden || arena.isDialogOpen();
    revealFeedback(!feedbackWaitingForDialogClose);
  }

  function goNext(): void {
    if (!session || !session.isAnswered()) return;

    if (session.hasNext()) {
      session.goNext();
      renderQuestion();
      return;
    }

    const finished = session;
    session = null;
    stopTicking();
    hideFeedback();
    // 화면을 떠나므로 조작법 대화상자도 함께 닫는다.
    // 열어 둔 채 나가면 다음 화면 위에 남아 화면을 덮고 포커스를 가둔다.
    arena.closeDialog();
    arena.setEnabled(false);
    onComplete(finished);
  }

  // ── 나가기 확인 (FR-3.6) ───────────────────────────────────────
  // window.confirm 대신 페이지 안 다이얼로그를 쓴다. 확인하는 동안에도
  // 타이머는 계속 흐른다. 일시정지는 제공하지 않는다 (FR-3.12).

  function openExitDialog(): void {
    dialogOpener = document.activeElement as HTMLElement | null;
    el.dialog.hidden = false;
    el.dialogCancel.focus();
  }

  function closeExitDialog(): void {
    if (el.dialog.hidden) return;
    el.dialog.hidden = true;
    if (!el.feedback.hidden && feedbackWaitingForDialogClose) {
      feedbackWaitingForDialogClose = false;
      revealFeedback();
    } else if (dialogOpener && document.contains(dialogOpener)) {
      // 답을 낸 뒤 사용자가 새로 연 dialog는 원래 opener로 돌아간다.
      dialogOpener.focus();
    }
    dialogOpener = null;
  }

  function confirmExit(): void {
    el.dialog.hidden = true;
    dialogOpener = null;
    stopTicking();
    session = null;
    hideFeedback();
    arena.closeDialog(); // 같은 이유로 여기서도 닫는다
    arena.setEnabled(false);
    onExit();
  }

  el.exitButton.addEventListener('click', openExitDialog);
  el.dialogCancel.addEventListener('click', closeExitDialog);
  el.dialogConfirm.addEventListener('click', confirmExit);
  el.nextButton.addEventListener('click', goNext);

  document.addEventListener('keydown', (event) => {
    // 다이얼로그가 열려 있으면 그 안에서만 움직인다
    if (!el.dialog.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeExitDialog();
      } else if (event.key === 'Tab') {
        trapFocus(el.dialog, event);
      }
      return;
    }

    // 조작법 대화상자가 열려 있으면 게임 입력을 받지 않는다.
    // 여기서 멈추지 않으면 대화상자를 읽는 중에 숫자키로 답이 제출된다.
    if (arena.handleDialogKey(event)) return;

    if (el.screen.hidden || !session) return;

    // 캐릭터 조작 안내에는 «다음 문제»가 Space/Enter로 된다고 적어 두었으므로,
    // 포커스가 버튼에서 벗어나 있어도 그 말이 참이어야 한다.
    // 어떤 버튼에든 포커스가 있으면 건드리지 않는다 — 그건 브라우저가 알아서 누른다.
    // Space는 preventDefault가 없으면 화면이 한 판 스크롤된다.
    if (
      arena.isEnabled()
      && NEXT_KEYS.includes(event.key)
      && !el.feedback.hidden
      && !document.activeElement?.closest('button')
    ) {
      event.preventDefault();
      goNext();
      return;
    }

    const index = CHOICE_KEYS.indexOf(event.key);
    if (index !== -1 && index < session.currentQuestion().choices.length) {
      event.preventDefault();
      selectChoice(index);
      return;
    }

    // 다른 화면에서는 무대가 아무 키도 가져가지 않는다.
    if (arena.handleKey(event)) event.preventDefault();
  });

  return {
    start(newSession, { categoryLabel: label }) {
      session = newSession;
      categoryLabel = label;
      el.dialog.hidden = true;
      dialogOpener = null;
      arena.setEnabled(true);
      renderQuestion();
    },

    setCharacter(id) {
      arena.setCharacter(id);
    },

    hide() {
      arena.setEnabled(false);
      if (!session && el.feedback.hidden && el.dialog.hidden) return;
      session = null;
      stopTicking();
      hideFeedback();
      // 닫기만 한다. `closeExitDialog` 는 열기 전 자리로 포커스를 돌려주는데,
      // 화면을 떠나는 중이라 그 자리는 이미 숨겨져 있다
      el.dialog.hidden = true;
      dialogOpener = null;
      arena.closeDialog();
    },
  };
}

/**
 * Tab이 다이얼로그 밖으로 새어 나가지 않게 막는다.
 * 뒤 화면 요소로 포커스가 가면 무엇을 조작하는지 알 수 없다.
 */
export function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => !node.hidden);
  if (items.length === 0) return;

  const first = items[0];
  const last = items[items.length - 1];

  // 조작법처럼 읽기 시작점인 패널(tabindex=-1)에 포커스를 둔 경우도 있다.
  // 그 자리에서 Tab/Shift+Tab을 누르면 각각 첫/마지막 조작부로 들여보낸다.
  if (!items.includes(document.activeElement as HTMLElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
