// 결과 화면 렌더링 (FR-5.2 ~ FR-5.7, FR-6.1)
// 점수 계산은 core/scoring.js가 끝내고 오고, 저장은 app.js가 어댑터로 넘긴다.
// 이 파일은 값을 그리고 닉네임 입력을 검사하는 일, 그리고 **화면을 떠날 때 아직 남기지 않은
// 기록을 남기는 일**(FR-6.1)을 한다.

import { DEFAULT_NICKNAME, NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from '../constants.js';
import { need, needOne } from '../dom.js';
import { createScreenWalker } from './screen-walker.js';
import { formatDuration, formatPercent } from './format.js';
import { announce } from './screens.js';
import type { RoundSummary } from '../types.js';

/** 랭킹에 등록한 결과. app.ts의 어댑터 호출이 이 모양으로 답한다 */
export interface RegisterOutcome {
  rank: number;
  /** 상위 10개 안에 남았는가 (FR-6.4) */
  kept: boolean;
  /** 저장 자체가 됐는가. 저장 공간이 막히면 false */
  stored: boolean;
}

/**
 * 화면을 옮기는 콜백. 옮기기를 마칠 때까지 기다릴 수 있게 Promise를 돌려줘도 된다 —
 * 자동 저장이 실패했다는 말은 **옮긴 뒤의 화면에서** 한 번 알린다.
 *
 * 기다리는 동안 다른 행동을 누르면 그 콜백도 곧바로 불린다. 먼저 부른 이동을 버리는 것은
 * 부르는 쪽(app.ts 의 navigation 세대)의 몫이다 — 나중에 누른 것이 이긴다.
 */
type Leave = () => void | Promise<void>;

/** app.ts가 넘겨주는 콜백 뭉치 */
export interface ResultScreenDeps {
  onRetry: Leave;
  onHome: Leave;
  /** 방에서 시작한 판이면 대기실로 되돌아간다 */
  onRoom: Leave;
  onRanking: Leave;
  onRegister: (nickname: string) => Promise<RegisterOutcome>;
}

/** bestScore는 이번 기록을 저장하기 전의 최고 점수다 */
export interface ResultView {
  summary: RoundSummary;
  modeLabel: string;
  bestScore: number | null;
  /** 등록 칸에 미리 채울 이름. 저장된 닉네임이고, 없으면 기본 닉네임이다 (FR-6.11) */
  nickname: string;
  characterId: string;
  /** 방에 들어가 있는가. 「대기실로」를 그릴지 정한다 */
  inRoom: boolean;
}

export interface ResultScreen {
  /** 결과를 화면에 올린다 */
  show(view: ResultView): void;

  /** 화면을 떠난다. 캐릭터와 손가락 조작부를 함께 거둔다 */
  hide(): void;

  /**
   * 버튼을 거치지 않고 페이지를 떠날 때(탭 닫기·새로고침) 아직 남기지 않은 기록을 곧바로 남긴다.
   * 로컬 저장소는 부르는 자리에서 동기로 써지므로 `pagehide` 안에서도 끝난다.
   */
  flush(): void;
}

function isValidNickname(value: string): boolean {
  return value.length >= NICKNAME_MIN_LENGTH && value.length <= NICKNAME_MAX_LENGTH;
}

/**
 * 화면을 떠날 때 자동 저장에 쓸 이름 (FR-6.1).
 *
 * 칸의 값이 규칙(2~10자)에 맞으면 그것을 쓴다. 비웠거나 한 글자만 적다 떠났으면 **막지 않고**
 * 저장된 이름으로 대신한다 — 떠나는 사람을 붙잡고 이름을 고치라고 할 일이 아니다.
 * 저장된 이름마저 규칙 밖이면(예전 판이 남긴 값) 기본 닉네임을 쓴다.
 */
export function autoSaveNickname(typed: string, saved: string): string {
  const value = typed.trim();
  if (isValidNickname(value)) return value;
  const fallback = saved.trim();
  return isValidNickname(fallback) ? fallback : DEFAULT_NICKNAME;
}

const SAVE_FAILED = '기록을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.';

/**
 * 저장 결과를 한 줄로. 직접 등록과 자동 저장이 같은 말을 쓴다.
 * 순위는 **이 브라우저 안의** 순위다 — 다른 사람과 겨룬 순위로 읽히지 않게 범위를 붙인다 (PRD 9.1).
 */
export function describeOutcome(
  { rank, kept, stored }: RegisterOutcome,
): { text: string; tone: MessageTone } {
  if (!stored) return { text: SAVE_FAILED, tone: 'error' };
  if (kept) return { text: `이 브라우저 기록 중 ${rank}위로 저장했어요.`, tone: 'done' };
  // 상위 10개만 보관하므로 밀려난 기록은 남지 않는다 (FR-6.4)
  return { text: '상위 10위 밖이라 랭킹 목록에는 남지 않았어요.', tone: null };
}

/** 자동 저장이 끝난 모양. round는 어느 판의 결과였는지다 */
type Settled = { round: number } & ({ outcome: RegisterOutcome } | { error: string });

/** 메시지의 결. null이면 아무 색도 입히지 않는다 */
type MessageTone = 'error' | 'done' | null;

/** 결과 헤더 안의 글자 없는 왼쪽 위를 워커의 안전한 시작점으로 잡는다. */
export function resultWalkerStart(
  header: HTMLElement,
  character: HTMLElement,
): { x: number; y: number } | null {
  const box = header.getBoundingClientRect();
  if (box.width === 0) return null;

  const inset = 12;
  return {
    x: box.left + character.offsetWidth / 2 + inset,
    y: box.top + character.offsetHeight + inset,
  };
}

export function createResultScreen(
  { onRetry, onHome, onRoom, onRanking, onRegister }: ResultScreenDeps,
): ResultScreen {
  const el = {
    header: needOne<HTMLElement>('[data-screen="result"] .result-header'),
    character: need('result-character'),
    mode: need('result-mode'),
    score: need('result-score'),
    max: need('result-max'),
    grade: need('result-grade'),
    gradeMessage: need('result-grade-message'),
    best: need('result-best'),
    correct: need('result-correct'),
    accuracy: need('result-accuracy'),
    duration: need('result-duration'),
    categoryBlock: need('result-category-block'),
    categoryList: need('result-category-list'),
    reviewBlock: need('result-review-block'),
    reviewTitle: need('result-review-title'),
    review: need('result-review'),
    reviewJump: need('result-review-jump'),
    reviewLink: need<HTMLAnchorElement>('result-review-link'),
    form: need<HTMLFormElement>('register-form'),
    input: need<HTMLInputElement>('nickname-input'),
    registerButton: need<HTMLButtonElement>('register-button'),
    message: need('register-message'),
    retryButton: need<HTMLButtonElement>('result-retry'),
    rankingButton: need<HTMLButtonElement>('result-ranking'),
    homeButton: need<HTMLButtonElement>('result-home'),
    roomButton: need<HTMLButtonElement>('result-room'),
  };

  // 걸어 다니며 버튼을 고를 수 있다. 닉네임 칸에 커서가 있으면 방향키는 그쪽 것이다.
  //
  // 점수 헤더의 왼쪽 위 빈 공간에서 시작한다. 버튼 위에는 세우지 않는다 —
  // 이 화면에 들어오면 포커스가 화면 자체에 있어 발밑의 버튼을 Enter 가 그대로 누른다.
  // 한가운데에서 시작하던 때는 1280×900 에서 그 자리가 「랭킹 보기」 위라,
  // 「결과 보기」를 누르던 Enter 가 이어지면 기록을 등록하기도 전에 랭킹으로 넘어갔다.
  // 헤더 아래 가운데에 세우면 좁은 화면에서 캐릭터가 통계의 「정답률」을 가리므로,
  // 글자가 없는 모서리 안쪽을 명시적으로 고른다.
  const walker = createScreenWalker({
    screen: needOne<HTMLElement>('[data-screen="result"]'),
    character: el.character,
    startPoint: () => resultWalkerStart(el.header, el.character),
  });

  /** 한 판에 한 번만 등록할 수 있다 */
  let registered = false;
  /**
   * 이번 판의 저장. **직접 등록과 자동 저장이 이 하나를 나눠 쓴다** — 「등록」을 누르고
   * 곧바로 「다시 하기」를 눌러도 같은 저장을 기다릴 뿐 두 번 저장하지 않는다.
   */
  let saving: Promise<RegisterOutcome> | null = null;
  /** 몇 번째로 올린 결과인가. 늦게 끝난 저장이 다음 판의 화면을 건드리지 않게 한다 */
  let round = 0;
  /**
   * 떠나며 저장하는 중이다. 같은 틱에 행동 버튼을 연달아 눌러도 한 번만 저장하고 옮긴다.
   * **저장하는 동안만 선다** — 옮기기까지 붙들면 느린 「대기실로」(네트워크를 기다린다)가
   * 끝날 때까지 홈·다시 하기·랭킹·브라우저 «뒤로»가 모두 삼켜졌다
   */
  let leaving = false;
  /**
   * 몇 번째로 떠났는가. 옮기기를 기다리는 동안 다른 행동을 누르면 그쪽이 이긴다 — 늦게 끝난
   * 이동은 app.ts 의 navigation 세대가 버리고, 여기서는 바쁨 표시·등록 칸·알림을 건드리지 않는다
   */
  let departure = 0;
  /** 아직 등록 칸에 옮기지 않은 자동 저장 결과. 마지막으로 옮긴 쪽이 한 번만 반영하고 알린다 */
  let unsettled: Settled | null = null;
  /** 옮기기를 기다리는 버튼과 원래 글자. 네트워크를 기다리는 「대기실로」만 단다 */
  let busy: { button: HTMLButtonElement; label: string | null } | null = null;
  /** 칸이 규칙에 맞지 않을 때 대신 쓸 이름. show()가 받은 저장된 닉네임이다 */
  let fallbackNickname = DEFAULT_NICKNAME;

  // ── 점수와 지표 ────────────────────────────────────────────────

  function renderScore(summary: RoundSummary, modeLabel: string): void {
    el.mode.textContent = modeLabel;
    el.score.textContent = String(summary.score);
    el.max.textContent = ` / ${summary.maxScore}점`;
    el.grade.textContent = summary.grade.label;
    el.gradeMessage.textContent = summary.grade.message;

    el.correct.textContent = `${summary.correctCount} / ${summary.totalCount}문제`;
    el.accuracy.textContent = formatPercent(summary.accuracy);
    el.duration.textContent = formatDuration(summary.durationMs);
  }

  /** 기존 최고 점수와 비교 (FR-5.7). 이번 기록을 저장하기 전 값을 받는다 */
  function renderBest(summary: RoundSummary, bestScore: number | null): void {
    const isRecord = bestScore !== null && summary.score > bestScore;
    el.best.classList.toggle('result-best--new', isRecord || bestScore === null);

    if (bestScore === null) {
      el.best.textContent = '첫 기록이에요.';
    } else if (isRecord) {
      el.best.textContent = `신기록 · 이전 최고 ${bestScore}점`;
    } else if (summary.score === bestScore) {
      el.best.textContent = `최고 기록과 같은 ${bestScore}점`;
    } else {
      el.best.textContent = `최고 기록 ${bestScore}점`;
    }
  }

  /** 카테고리별 정답 개수. 전체 모드에서만 보여준다 (FR-5.6) */
  function renderByCategory(summary: RoundSummary): void {
    const show = summary.mode === 'all' && summary.byCategory.length > 1;
    el.categoryBlock.hidden = !show;
    if (!show) return;

    el.categoryList.replaceChildren();

    for (const category of summary.byCategory) {
      const item = document.createElement('li');
      item.className = 'category-score__item';

      const name = document.createElement('span');
      name.className = 'category-score__name';
      name.textContent = category.name;

      const count = document.createElement('span');
      count.className = 'category-score__count';
      count.textContent = `${category.correct} / ${category.total}`;

      item.append(name, count);
      el.categoryList.append(item);
    }
  }

  // text가 null일 수 있는 것은 시간 초과 때문이다. 그때는 이 함수를 부르는 쪽이
  // '시간 초과'를 대신 넣으므로 실제로 null이 오지는 않지만, textContent가 그대로
  // 받는 값이라 좁히지 않고 둔다.
  function createReviewRow(tag: string, text: string | null, modifier: string): HTMLParagraphElement {
    const row = document.createElement('p');
    row.className = `review__row review__row--${modifier}`;

    const label = document.createElement('span');
    label.className = 'review__tag';
    label.textContent = tag;

    const value = document.createElement('span');
    value.textContent = text;

    row.append(label, value);
    return row;
  }

  /** 틀린 문제를 정답·해설과 함께 (FR-5.4) */
  function renderReview(summary: RoundSummary): void {
    el.reviewBlock.hidden = summary.review.length === 0;
    // 풀이는 등록 뒤 맨 아래라 「다시 하기」를 누르는 사람은 있는 줄도 모르고 지나간다.
    // 요약 칩 아래에 그리로 건너가는 글자 링크를 둔다 — 버튼이 아니라 결과 행동의 무게는 그대로다
    el.reviewJump.hidden = summary.review.length === 0;
    el.reviewLink.textContent = `틀린 문제 ${summary.review.length}개 해설 보기`;
    if (summary.review.length === 0) return;

    el.review.replaceChildren();

    for (const item of summary.review) {
      const entry = document.createElement('li');
      entry.className = 'review__item';

      const question = document.createElement('p');
      question.className = 'review__question';
      question.textContent = item.question;

      const explanation = document.createElement('p');
      explanation.className = 'review__explanation';
      explanation.textContent = item.explanation;

      entry.append(
        question,
        // 시간 초과는 고른 보기가 없다. ✓ ✗ 표식은 디자인 층이 줄의 종류를 보고 그린다
        createReviewRow('내 답', item.timedOut ? '시간 초과' : item.chosenChoice, 'mine'),
        createReviewRow('정답', item.correctChoice, 'answer'),
        explanation
      );

      el.review.append(entry);
    }
  }

  // ── 랭킹 등록 (FR-6.1) ─────────────────────────────────────────

  /**
   * `#register-message`는 `role="status"`다. **숨긴 채로 글을 넣으면 낭독되지 않으므로
   * 먼저 펼치고 넣는다** — 로비의 `say()`와 같은 규칙이다.
   */
  function setMessage(text: string | null, tone: MessageTone): void {
    el.message.hidden = !text;
    el.message.textContent = text ?? '';
    el.message.classList.toggle('register__message--error', tone === 'error');
    el.message.classList.toggle('register__message--done', tone === 'done');
  }

  /**
   * 잠근 **뒤에** 포커스가 살아 있는지 보고 옮긴다.
   *
   * 입력칸과 버튼을 `disabled`로 만들면 거기 있던 포커스가 `<body>`로 떨어져 Tab
   * 자리를 잃는다. 되돌릴 수 없는 조작이라 그다음에 갈 곳이 없으면 안 된다.
   *
   * **잠그기 전에 «어디 있을 것»이라고 넘겨짚지 않는다.** 폼 제출은 브라우저가
   * 포커스를 옮길 수도 있어, 미리 검사하면 맞지 않는다 — 실제로 그래서 한 번
   * 놓쳤다. 잠근 뒤의 실제 상태만 본다.
   *
   * 떠나는 길에서 잠글 때는 포커스를 옮기지 않는다(`rescueFocus` false). 누른 자리에 두어야
   * 옮기기를 기다리는 동안 걷던 사람의 다음 Enter 가 엉뚱한 「다시 하기」를 누르지 않는다.
   */
  function lockForm(rescueFocus = true): void {
    registered = true;
    el.input.disabled = true;
    el.registerButton.disabled = true;
    el.registerButton.textContent = '등록 완료';
    if (!rescueFocus) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body) el.retryButton.focus();
  }

  /**
   * 이번 판을 남긴다. 이미 남기는 중이면 그 저장을 같이 기다린다 — 두 번 저장하지 않는다.
   *
   * **`onRegister`는 아무것도 기다리지 않고 곧바로 부른다.** 로컬 저장소는 그 호출 안에서
   * 동기로 써지므로, `pagehide`처럼 기다릴 수 없는 자리에서도 기록이 남는다.
   */
  function save(nickname: string): Promise<RegisterOutcome> {
    if (saving) return saving;
    const mine = round;
    const attempt = onRegister(nickname);
    saving = attempt;
    attempt.then(
      () => {
        if (mine === round) registered = true;
      },
      () => {
        // 실패한 저장은 다시 시도할 수 있게 비운다. 실패를 알리는 것은 기다린 쪽의 몫이다
        if (mine === round && saving === attempt) saving = null;
      },
    );
    return attempt;
  }

  async function submitNickname(event: Event): Promise<void> {
    event.preventDefault();
    if (registered || saving) return;

    const nickname = el.input.value.trim();
    if (!isValidNickname(nickname)) {
      setMessage(
        `닉네임은 ${NICKNAME_MIN_LENGTH}~${NICKNAME_MAX_LENGTH}자로 입력해 주세요.`,
        'error'
      );
      el.input.focus();
      return;
    }

    el.registerButton.disabled = true;
    setMessage('저장하는 중이에요…', null);

    try {
      const outcome = await save(nickname);
      lockForm();
      const { text, tone } = describeOutcome(outcome);
      setMessage(text, tone);
    } catch (error) {
      el.registerButton.disabled = false;
      // catch로 잡히는 값은 TS에서 unknown이다. 던지는 쪽(저장소 어댑터)이
      // Error만 던지므로 지금까지처럼 message를 그대로 읽는다.
      setMessage(`기록을 저장하지 못했어요: ${(error as Error).message}`, 'error');
    }
  }

  // ── 떠날 때 자동 저장 (FR-6.1) ─────────────────────────────────
  //
  // 「등록」을 누르지 않고 「다시 하기」·「홈으로」를 누르면 기록이 조용히 사라졌고, 다음 판의
  // 최고 기록 비교와 홈의 별 점수도 그 판을 몰랐다. 그래서 결과 화면을 떠나는 모든 길이 저장을
  // 거친다 — 행동 버튼 넷, 브라우저 «뒤로»(「홈으로」를 누른다), 탭 닫기·새로고침(`flush`).

  /**
   * 아직 남기지 않았으면 칸의 이름으로 남긴다. **실패해도 던지지 않는다** —
   * 저장 실패가 이동을 막으면 안 된다. 무엇이 됐는지만 돌려준다.
   */
  async function commitIfNeeded(): Promise<Settled | null> {
    if (registered) return null;
    const mine = round;
    try {
      const outcome = await save(autoSaveNickname(el.input.value, fallbackNickname));
      return { round: mine, outcome };
    } catch (error) {
      // 위 submitNickname과 같은 이유로 message를 그대로 읽는다
      return { round: mine, error: (error as Error).message };
    }
  }

  /** 자동 저장의 결과를 등록 칸에 남긴다. 직접 등록했을 때와 같은 모양이 된다 */
  function applySettled(settled: Settled): void {
    if (settled.round !== round) return;
    if ('outcome' in settled) {
      lockForm();
      const { text, tone } = describeOutcome(settled.outcome);
      setMessage(text, tone);
    } else {
      setMessage(`기록을 저장하지 못했어요: ${settled.error}`, 'error');
    }
  }

  /**
   * 옮기기를 기다리는 버튼에 바쁨을 단다 (`aria-busy` + 글자). null 이면 걷는다.
   * 잠그지는 않는다 — 잠그면 포커스가 떨어지고, 다른 행동으로 갈아타는 길은 열려 있어야 한다.
   */
  function markBusy(button: HTMLButtonElement | null, busyLabel?: string): void {
    if (busy) {
      if (busy.label !== null) busy.button.textContent = busy.label;
      busy.button.removeAttribute('aria-busy');
      busy = null;
    }
    if (!button || !busyLabel) return;
    busy = { button, label: button.textContent };
    button.textContent = busyLabel;
    button.setAttribute('aria-busy', 'true');
  }

  async function leave(next: Leave, button: HTMLButtonElement, busyLabel?: string): Promise<void> {
    // 같은 틱에 연달아 누른 것은 한 번만 받는다. 기다리는 이동을 같은 버튼으로 겹쳐 보내지도 않는다
    if (leaving || busy?.button === button) return;
    leaving = true;
    // commitIfNeeded 는 실패해도 던지지 않는다. 잠금은 저장까지만 — 옮기는 동안에는 풀어 둔다
    const settled = await commitIfNeeded();
    leaving = false;
    if (settled) {
      // 남겼으면 등록 칸부터 잠근다. 옮기기를 기다리는 동안 「등록」이 살아 있는 것처럼 보이면
      // 눌러도 아무 일이 없다(이미 남긴 판이다). 문구는 아래에서 옮긴 뒤에 넣는다
      if ('outcome' in settled && settled.round === round) lockForm(false);
      unsettled = settled;
    }

    const mine = ++departure;
    markBusy(button, busyLabel);
    try {
      await next();
    } finally {
      if (mine === departure) markBusy(null);
    }
    // 그사이 다른 행동이 옮기기를 넘겨받았다. 등록 칸과 알림도 그쪽이 맡는다
    if (mine !== departure || !unsettled) return;
    const done = unsettled;
    unsettled = null;
    // 등록 칸 문구는 화면을 옮긴 뒤에 고친다. 숨은 status는 낭독되지 않으므로,
    // 저장하지 못했다는 말은 옮겨 간 화면에서 `announce`로 **한 번만** 알린다
    applySettled(done);
    const failure = 'error' in done
      ? `기록을 저장하지 못했어요: ${done.error}`
      : (done.outcome.stored ? null : SAVE_FAILED);
    if (failure) announce(failure);
  }

  el.form.addEventListener('submit', submitNickname);
  el.retryButton.addEventListener('click', () => { void leave(onRetry, el.retryButton); });
  el.rankingButton.addEventListener('click', () => { void leave(onRanking, el.rankingButton); });
  el.homeButton.addEventListener('click', () => { void leave(onHome, el.homeButton); });
  // 대기실은 방 정보를 받아 그린 뒤에 열린다(네트워크). 기다리는 동안 홈의 온라인 입구처럼 글자로 말한다
  el.roomButton.addEventListener('click', () => { void leave(onRoom, el.roomButton, '연결 중…'); });

  // 주소에 «#»을 붙이지 않는다 — 해시 라우팅을 쓰지 않고, 붙이면 히스토리에 항목이 하나 더 쌓인다.
  // 제목으로 포커스를 옮겨 스크린리더도 거기서부터 읽게 한다
  el.reviewLink.addEventListener('click', (event) => {
    event.preventDefault();
    el.reviewTitle.scrollIntoView({ block: 'start' });
    el.reviewTitle.focus({ preventScroll: true });
  });

  return {
    hide() {
      walker.hide();
    },

    flush() {
      if (registered || saving) return;
      void commitIfNeeded().then((settled) => {
        if (settled) applySettled(settled);
      });
    },

    show({ summary, modeLabel, bestScore, nickname, characterId, inRoom }) {
      walker.show(characterId);
      // 방에서 시작한 판이면 돌아갈 길을 준다. 홈으로 가는 길도 그대로 둔다 —
      // 방을 떠나고 싶을 수도 있고, 방은 로비에서 코드로 다시 찾을 수 있다
      el.roomButton.hidden = !inRoom;
      round += 1;
      registered = false;
      saving = null;
      leaving = false;
      // 앞 판에서 아직 끝나지 않은 이동은 이 판의 바쁨 표시·등록 칸·알림을 건드리지 않는다
      departure += 1;
      unsettled = null;
      markBusy(null);
      el.input.disabled = false;
      el.registerButton.disabled = false;
      el.registerButton.textContent = '등록';
      // 마지막에 쓴 닉네임(없으면 기본 닉네임)을 채운다 (FR-6.11). 홈 HUD와 같은 이름이다
      fallbackNickname = nickname;
      el.input.value = nickname;
      setMessage(null, null);

      renderScore(summary, modeLabel);
      renderBest(summary, bestScore);
      renderByCategory(summary);
      renderReview(summary);
    },
  };
}
