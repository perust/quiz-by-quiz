// 퀴즈 화면 렌더링
// 게임 규칙은 core/session.js가, 시간 계산은 core/timer.js가 갖고 있다.
// 이 파일은 그 값들을 화면에 그리고 사용자 입력을 로직으로 넘기는 일만 한다.

import { WARNING_THRESHOLD_MS } from '../constants.js';
import { createQuestionTimer } from '../core/timer.js';
import { playCorrect, playTimeout, playWrong } from '../audio.js';
import { announce } from './screens.js';
import { createArena } from './arena.js';

/** 키보드로 보기를 선택할 때 쓰는 키 (FR-3.5) */
const CHOICE_KEYS = ['1', '2', '3', '4'];

/** 채점 뒤 다음 문제로 넘어가는 키. 게임 모드 버튼에 적어둔 것과 같아야 한다 */
const NEXT_KEYS = ['Enter', ' '];

/** 다이얼로그 안에서 Tab이 맴돌게 할 대상 */
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * @param {{ onExit: () => void, onComplete: (session: object) => void }} callbacks
 */
export function createQuizScreen({ onExit, onComplete }) {
  const el = {
    screen: document.querySelector('[data-screen="quiz"]'),
    category: document.getElementById('quiz-category'),
    position: document.getElementById('quiz-position'),
    progress: document.getElementById('progress'),
    progressFill: document.getElementById('progress-fill'),
    timer: document.getElementById('timer'),
    timerFill: document.getElementById('timer-fill'),
    timerIcon: document.getElementById('timer-icon'),
    timerText: document.getElementById('timer-text'),
    question: document.getElementById('question-text'),
    choices: document.getElementById('choices'),
    feedback: document.getElementById('feedback'),
    verdict: document.getElementById('feedback-verdict'),
    explanation: document.getElementById('feedback-explanation'),
    nextButton: document.getElementById('next-button'),
    nextLabel: document.getElementById('next-label'),
    exitButton: document.getElementById('quiz-exit'),
    dialog: document.getElementById('exit-dialog'),
    dialogCancel: document.getElementById('exit-cancel'),
    dialogConfirm: document.getElementById('exit-confirm'),
  };

  const timer = createQuestionTimer();

  // 게임 모드 무대. 고른 번호를 넘겨줄 뿐이고 채점에는 관여하지 않는다.
  // 조작법 대화상자도 여기와 같은 포커스 가두기를 쓰라고 trapFocus를 넘긴다.
  const arena = createArena({ onChoose: (index) => selectChoice(index), trapFocus });

  let session = null;
  let categoryLabel = '';
  let frameId = null;
  /** 초 단위 표시가 바뀔 때만 텍스트를 고쳐 쓰기 위한 기억값 */
  let lastShownSeconds = null;
  /** 문항마다 시간 경고를 한 번만 알리기 위한 표시 */
  let warned = false;
  /** 다이얼로그를 연 버튼. 닫을 때 포커스를 되돌려 준다 */
  let dialogOpener = null;

  // ── 타이머 표시 ────────────────────────────────────────────────

  function renderTimer(remainingMs) {
    const remaining = Math.max(remainingMs, 0);
    el.timerFill.style.transform = `scaleX(${remaining / timer.limitMs})`;

    const seconds = Math.ceil(remaining / 1000);
    if (seconds === lastShownSeconds) return;
    lastShownSeconds = seconds;

    // 경고는 색상뿐 아니라 아이콘·문구로도 알린다 (FR-3.9)
    const isWarning = remaining <= WARNING_THRESHOLD_MS;
    el.timer.classList.toggle('timer--warning', isWarning);
    el.timerIcon.textContent = isWarning ? '⚠' : '⏱';
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
  function startTicking() {
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

  function stopTicking() {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  }

  // ── 문제 렌더링 ────────────────────────────────────────────────

  function renderChoices(question) {
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

  function updateProgress() {
    const percent = Math.round(session.progressRatio * 100);
    el.progressFill.style.width = `${percent}%`;
    el.progress.setAttribute('aria-valuenow', String(percent));
  }

  function renderQuestion() {
    const question = session.currentQuestion();

    el.category.textContent = categoryLabel;
    el.position.textContent = `${session.position} / ${session.total}`;
    el.question.textContent = question.question;

    updateProgress();
    renderChoices(question);
    arena.reset(question.choices.length);

    el.feedback.hidden = true;
    el.feedback.classList.remove('feedback--correct', 'feedback--wrong');

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

  function selectChoice(index) {
    if (!session || session.isAnswered()) return;
    timer.stop();
    showFeedback(session.submit({ choiceIndex: index, elapsedMs: timer.elapsedMs() }));
  }

  function handleTimeout() {
    if (!session || session.isAnswered()) return;
    timer.stop();

    // 게임 모드에서는 시간이 다 됐을 때 «밟고 있는 칸»이 답이다.
    // 십자 한가운데에서 시작하므로, 움직이지 않았으면 밟은 칸이 없어 null이 된다.
    // 즉 가만히 있으면 보통 모드와 똑같이 시간 초과 오답이다.
    const standing = arena.standingIndex();

    // choiceIndex가 null이면 시간 초과다. 오답과 똑같이 정답과 해설을 보여준다 (FR-3.10)
    showFeedback(session.submit({ choiceIndex: standing, elapsedMs: timer.limitMs }));
  }

  function showFeedback(record) {
    stopTicking();
    renderTimer(timer.remainingMs()); // 멈춘 시점의 남은 시간으로 고정

    const question = session.currentQuestion();
    const buttons = el.choices.querySelectorAll('.choice');

    buttons.forEach((button, index) => {
      button.disabled = true; // 같은 문제를 다시 풀 수 없다 (FR-3.3)
      const mark = button.querySelector('.choice__mark');

      if (index === question.answerIndex) {
        button.classList.add('choice--correct');
        mark.textContent = '✓ 정답';
      } else if (index === record.choiceIndex) {
        button.classList.add('choice--wrong');
        mark.textContent = '✗ 오답';
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
    el.nextLabel.textContent = session.hasNext() ? '다음 문제' : '결과 보기';

    // 자동 전환 없이 "다음 문제" 버튼을 눌러야 넘어간다 (FR-4.4)
    el.feedback.hidden = false;

    // 다이얼로그가 열려 있으면 포커스를 가져오지 않는다.
    // 시간 초과는 다이얼로그 뒤에서도 일어나는데, 그때 포커스를 옮기면
    // 갇혀 있어야 할 포커스가 밖으로 새고 Tab이 다이얼로그를 벗어난다.
    if (el.dialog.hidden && !arena.isDialogOpen()) el.nextButton.focus();
  }

  function goNext() {
    if (!session || !session.isAnswered()) return;

    if (session.hasNext()) {
      session.goNext();
      renderQuestion();
      return;
    }

    const finished = session;
    session = null;
    stopTicking();
    // 화면을 떠나므로 조작법 대화상자도 함께 닫는다.
    // 열어 둔 채 나가면 다음 화면 위에 남아 화면을 덮고 포커스를 가둔다.
    arena.closeDialog();
    onComplete(finished);
  }

  // ── 나가기 확인 (FR-3.6) ───────────────────────────────────────
  // window.confirm 대신 페이지 안 다이얼로그를 쓴다. 확인하는 동안에도
  // 타이머는 계속 흐른다. 일시정지는 제공하지 않는다 (FR-3.12).

  function openExitDialog() {
    dialogOpener = document.activeElement;
    el.dialog.hidden = false;
    el.dialogCancel.focus();
  }

  function closeExitDialog() {
    if (el.dialog.hidden) return;
    el.dialog.hidden = true;
    // 열기 전에 있던 자리로 포커스를 돌려준다
    if (dialogOpener && document.contains(dialogOpener)) dialogOpener.focus();
    dialogOpener = null;
  }

  function confirmExit() {
    el.dialog.hidden = true;
    dialogOpener = null;
    stopTicking();
    session = null;
    arena.closeDialog(); // 같은 이유로 여기서도 닫는다
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

    // 게임 모드는 «다음 문제» 버튼에 Space/Enter라고 적어 두었으므로,
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

    // 게임 모드가 꺼져 있으면 무대는 아무 키도 가져가지 않는다
    if (arena.handleKey(event)) event.preventDefault();
  });

  return {
    /**
     * 새 판을 화면에 올린다.
     * @param {object} newSession core/session.js가 만든 세션
     * @param {{ categoryLabel: string }} view
     */
    start(newSession, { categoryLabel: label }) {
      session = newSession;
      categoryLabel = label;
      el.dialog.hidden = true;
      dialogOpener = null;
      renderQuestion();
    },

    /** 무대에서 쓸 캐릭터를 갈아 끼운다. 홈에서 고른 것이 여기로 온다 */
    setCharacter(id) {
      arena.setCharacter(id);
    },

    /**
     * 게임 모드를 켜고 끈다. 판 도중에 바꿔도 세션은 그대로다 —
     * 무대는 보기 버튼을 대신 눌러줄 뿐이라 게임 상태를 갖지 않는다.
     */
    setGameMode(value) {
      arena.setEnabled(value);
      el.screen.classList.toggle('quiz--game', Boolean(value));
      if (!value || !session) return;

      if (session.isAnswered()) {
        // 이미 답을 낸 문항이다. setEnabled가 잠금을 풀어 놓으므로 다시 잠근다 —
        // 안 그러면 조작부가 «다음 문제» 버튼을 가리고, 채점이 끝난 바닥 위를
        // 캐릭터가 다시 걸어 다닌다. 칸에 칠한 정답·오답은 그대로 두므로
        // reset은 부르지 않는다.
        arena.lock();
        return;
      }
      arena.reset(session.currentQuestion().choices.length);
    },
  };
}

/**
 * Tab이 다이얼로그 밖으로 새어 나가지 않게 막는다.
 * 뒤 화면 요소로 포커스가 가면 무엇을 조작하는지 알 수 없다.
 *
 * @param {HTMLElement} container
 * @param {KeyboardEvent} event
 */
export function trapFocus(container, event) {
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((node) => !node.hidden);
  if (items.length === 0) return;

  const first = items[0];
  const last = items[items.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
