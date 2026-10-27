// 중간에 나온 판의 «푼 문제» 화면 (N04, FR-3.6)
//
// 나가기 확인의 «나가고 푼 문제 해설 보기»가 여기로 온다. 25문제 전체 도전의 24번에서 나가도
// 남는 것이 없었다 — 이제 답한 문제를 정답·해설과 함께 다시 볼 수 있다.
//
// **결과 화면이 아니다.** 끝까지 풀지 않은 판은 기록되지 않으므로(FR-3.6) 점수·등급·최고 기록 비교·
// 랭킹 등록 칸이 없고, 떠날 때 자동 저장(FR-6.1)도 없다 — 그래서 결과 화면(`result.ts`)에 «부분 모드»를
// 더하지 않고 화면을 따로 두었다. 저장소도 저장 콜백도 받지 않는다. 풀이 한 문제와 분야 묶음의 모양은
// 결과 화면의 것(`createReviewItem`·`createReviewGroup`)을 그대로 쓴다.

import { need, needOne } from '../dom.js';
import { createScreenWalker, pointBelowRightEdge } from './screen-walker.js';
import { createReviewGroup, createReviewItem, groupReviewByCategory, type ReviewGroupCount } from './result.js';
import type { AnsweredReview, ReviewItem } from '../types.js';

/** app.ts 가 넘겨주는 콜백 */
export interface QuizReviewScreenDeps {
  /** 이 화면을 떠난다. 나가기 확인의 「나가기」와 같은 곳(방에서 연 판이면 대기실, 아니면 홈)으로 간다 */
  onLeave: () => void;
}

export interface QuizReviewView {
  review: AnsweredReview;
  /** 분야 판이면 분야 이름, 전체 도전이면 «전체 도전» */
  modeLabel: string;
  characterId: string;
  /** 방에 들어가 있는가. 떠나는 버튼의 이름이 «대기실»이 된다 */
  inRoom: boolean;
}

export interface QuizReviewScreen {
  show(view: QuizReviewView): void;
  /** 화면을 떠난다. 캐릭터와 손가락 조작부를 함께 거둔다 */
  hide(): void;
}

/** 머리 아래 한 줄. 몇 문제 가운데 몇을 풀었는지와 맞힌 수를 말한다 — 점수(10점 단위)는 쓰지 않는다 */
export function answeredReviewSummary(review: AnsweredReview, modeLabel: string): string {
  const head = modeLabel ? `${modeLabel} · ` : '';
  return `${head}${review.totalCount}문제 중 ${review.answeredCount}문제를 풀었어요 · 맞힌 문제 ${review.correctCount}개`;
}

/** 분야 묶음 펼침 줄의 개수 알약. 틀린 문제가 없으면 정답 색으로 «모두 정답»이다 */
export function answeredGroupCount(items: readonly ReviewItem[]): ReviewGroupCount {
  const missed = items.filter((item) => !item.correct).length;
  return missed > 0
    ? { text: `${items.length}문제 중 ${missed}개 틀림` }
    : { text: `${items.length}문제 모두 정답`, clear: true };
}

export function createQuizReviewScreen({ onLeave }: QuizReviewScreenDeps): QuizReviewScreen {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="quiz-review"]'),
    header: needOne<HTMLElement>('[data-screen="quiz-review"] .ranking-header'),
    character: need('quiz-review-character'),
    leave: need<HTMLButtonElement>('quiz-review-leave'),
    leaveLabel: need('quiz-review-leave-label'),
    summary: need('quiz-review-summary'),
    list: need('quiz-review-list'),
  };

  // 걸어가 버튼·펼침 줄·신고 링크를 누른다. 랭킹처럼 머리말 오른쪽 아래 빈 가장자리에서 시작한다 —
  // 머리말의 「홈」 위에 세우면 나가기 확인에서 누르던 Enter 가 이어져 그대로 떠난다
  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    startPoint: () => pointBelowRightEdge(el.header, el.character),
  });

  el.leave.addEventListener('click', () => onLeave());

  function renderList(review: AnsweredReview): void {
    el.list.replaceChildren();
    // 전체 도전은 결과의 오답 풀이처럼 분야별로 접어 묶는다 (N04). 묶음이 하나뿐이면 펼쳐 둔다
    const grouped = review.mode === 'all';
    el.list.classList.toggle('review--grouped', grouped);
    if (!grouped) {
      for (const item of review.items) el.list.append(createReviewItem(item));
      return;
    }
    const groups = groupReviewByCategory(review.items);
    for (const group of groups) {
      el.list.append(createReviewGroup(group, groups.length === 1, answeredGroupCount(group.items)));
    }
  }

  return {
    show({ review, modeLabel, characterId, inRoom }) {
      walker.show(characterId);
      el.leaveLabel.textContent = inRoom ? '대기실' : '홈';
      el.summary.textContent = answeredReviewSummary(review, modeLabel);
      renderList(review);
    },

    hide() {
      walker.hide();
    },
  };
}
