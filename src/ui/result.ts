// 결과 화면 렌더링 (FR-5.2 ~ FR-5.7, FR-6.1)
// 점수 계산은 core/scoring.js가 끝내고 오고, 저장은 app.js가 어댑터로 넘긴다.
// 이 파일은 값을 그리고 닉네임 입력을 검사하는 일만 한다.

import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from '../constants.js';
import { need, needOne } from '../dom.js';
import { createScreenWalker } from './screen-walker.js';
import { formatDuration, formatPercent } from './format.js';
import type { RoundSummary } from '../types.js';

/** 랭킹에 등록한 결과. app.ts의 어댑터 호출이 이 모양으로 답한다 */
export interface RegisterOutcome {
  rank: number;
  /** 상위 10개 안에 남았는가 (FR-6.4) */
  kept: boolean;
  /** 저장 자체가 됐는가. 저장 공간이 막히면 false */
  stored: boolean;
}

/** app.ts가 넘겨주는 콜백 뭉치 */
export interface ResultScreenDeps {
  onRetry: () => void;
  onHome: () => void;
  /** 방에서 시작한 판이면 대기실로 되돌아간다 */
  onRoom: () => void;
  onRanking: () => void;
  onRegister: (nickname: string) => Promise<RegisterOutcome>;
}

/** bestScore는 이번 기록을 저장하기 전의 최고 점수다 */
export interface ResultView {
  summary: RoundSummary;
  modeLabel: string;
  bestScore: number | null;
  nickname: string;
  characterId: string;
  /** 방에 들어가 있는가. 「대기실로」를 그릴지 정한다 */
  inRoom: boolean;
}

export interface ResultScreen {
  /** 결과를 화면에 올린다 */
  show(view: ResultView): void;
}

/** 메시지의 결. null이면 아무 색도 입히지 않는다 */
type MessageTone = 'error' | 'done' | null;

export function createResultScreen(
  { onRetry, onHome, onRoom, onRanking, onRegister }: ResultScreenDeps,
): ResultScreen {
  const el = {
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
    review: need('result-review'),
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
  // 처음 설 자리를 지정하지 않아 화면 한가운데에서 시작한다. 결과 화면은 세로로 길어
  // 버튼이 접힌 자리 밖에 있는데, 거기를 시작점으로 잡으면 점수와 해설을 지나쳐
  // 아래로 끌려 내려간다 — 결과는 위에서부터 읽어야 한다.
  const walker = createScreenWalker({
    screen: needOne<HTMLElement>('[data-screen="result"]'),
    character: need('result-character'),
  });

  /** 한 판에 한 번만 등록할 수 있다 */
  let registered = false;

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
      el.best.textContent = '첫 기록입니다. 다음 판부터 이 점수와 비교해 드릴게요.';
    } else if (isRecord) {
      el.best.textContent = `신기록입니다. 이전 최고 ${bestScore}점을 넘었어요.`;
    } else if (summary.score === bestScore) {
      el.best.textContent = `최고 기록과 같은 ${bestScore}점입니다.`;
    } else {
      el.best.textContent = `최고 기록은 ${bestScore}점입니다.`;
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
        // 시간 초과는 고른 보기가 없다
        createReviewRow('✗ 내 답', item.timedOut ? '시간 초과' : item.chosenChoice, 'mine'),
        createReviewRow('✓ 정답', item.correctChoice, 'answer'),
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
   */
  function lockForm(): void {
    registered = true;
    el.input.disabled = true;
    el.registerButton.disabled = true;
    el.registerButton.textContent = '등록 완료';
    const focused = document.activeElement;
    if (!focused || focused === document.body) el.retryButton.focus();
  }

  async function submitNickname(event: Event): Promise<void> {
    event.preventDefault();
    if (registered) return;

    const nickname = el.input.value.trim();
    if (nickname.length < NICKNAME_MIN_LENGTH || nickname.length > NICKNAME_MAX_LENGTH) {
      setMessage(
        `닉네임은 ${NICKNAME_MIN_LENGTH}~${NICKNAME_MAX_LENGTH}자로 입력해 주세요.`,
        'error'
      );
      el.input.focus();
      return;
    }

    el.registerButton.disabled = true;
    setMessage('등록 중입니다…', null);

    try {
      const { rank, kept, stored } = await onRegister(nickname);
      lockForm();

      if (!stored) {
        setMessage('기록을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.', 'error');
      } else if (kept) {
        setMessage(`${rank}위로 등록했습니다.`, 'done');
      } else {
        // 상위 10개만 보관하므로 밀려난 기록은 남지 않는다 (FR-6.4)
        setMessage('상위 10위 밖이라 랭킹 목록에는 남지 않았습니다.', null);
      }
    } catch (error) {
      el.registerButton.disabled = false;
      // catch로 잡히는 값은 TS에서 unknown이다. 던지는 쪽(저장소 어댑터)이
      // Error만 던지므로 지금까지처럼 message를 그대로 읽는다.
      setMessage(`등록에 실패했습니다: ${(error as Error).message}`, 'error');
    }
  }

  el.form.addEventListener('submit', submitNickname);
  el.retryButton.addEventListener('click', () => onRetry());
  el.rankingButton.addEventListener('click', () => onRanking());
  el.homeButton.addEventListener('click', () => onHome());
  el.roomButton.addEventListener('click', () => onRoom());

  return {
    show({ summary, modeLabel, bestScore, nickname, characterId, inRoom }) {
      walker.show(characterId);
      // 방에서 시작한 판이면 돌아갈 길을 준다. 홈으로 가는 길도 그대로 둔다 —
      // 방을 떠나고 싶을 수도 있고, 방은 로비에서 코드로 다시 찾을 수 있다
      el.roomButton.hidden = !inRoom;
      registered = false;
      el.input.disabled = false;
      el.registerButton.disabled = false;
      el.registerButton.textContent = '등록';
      // 마지막에 쓴 닉네임을 기본값으로 채운다 (FR-6.11)
      el.input.value = nickname ?? '';
      setMessage(null, null);

      renderScore(summary, modeLabel);
      renderBest(summary, bestScore);
      renderByCategory(summary);
      renderReview(summary);
    },
  };
}
