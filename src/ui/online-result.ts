// Server-authoritative final ranking screen.
// The score list has already been ordered by PostgreSQL; never sort it in a browser.

import { playFinish } from '../audio.js';
import { need } from '../dom.js';
import type { OnlineFinishedMatch, OnlineReviewItem, OnlineScore } from '../online/adapter.js';
import { onlinePlaceLabel, onlinePlaces } from './online-standings.js';
import { createQuestionReportLink, onlineQuestionReportUrl, questionReportLabel } from './report-link.js';
import { bestComparisonText } from './best-score.js';
import { createBody } from './sprite.js';
import type { RankingTarget } from '../types.js';

// 화면과 테스트가 이 이름으로 불러 왔다. 규칙은 공개 단계 점수판과 함께 online-standings.ts에 있다.
export { onlinePlaceLabel };

export interface OnlineFinalEntry extends OnlineScore {
  /**
   * Display-only place. 앞 사람과 점수가 같으면 같은 순위를 받는다(1, 1, 3).
   * 서버 정렬은 동점을 닉네임 순으로 늘어놓을 뿐이라, 이름이 순위를 정하게 두지 않는다.
   */
  place: number;
  /** 같은 점수의 참가자와 순위를 나눠 가졌는가 */
  tied: boolean;
  isMe: boolean;
}

export interface OnlineFinalResultView {
  matchId: string;
  entries: OnlineFinalEntry[];
  myPlace: number | null;
  myTied: boolean;
}

export function onlineFinalResultView(
  snapshot: OnlineFinishedMatch,
  playerId: string,
): OnlineFinalResultView {
  const places = onlinePlaces(snapshot.scores);
  let myPlace: number | null = null;
  let myTied = false;
  // 배열 순서는 서버가 정한 그대로 둔다 (online-standings.ts)
  const entries = snapshot.scores.map((score, index) => {
    const { place, tied } = places[index];
    const isMe = score.playerId === playerId;
    if (isMe) {
      myPlace = place;
      myTied = tied;
    }
    return { ...score, place, tied, isMe };
  });
  return { matchId: snapshot.matchId, entries, myPlace, myTied };
}

/** 내 결과 한 줄. 플레이어에게 의미 없는 «서버» 같은 말을 쓰지 않는다. */
export function onlineFinalSummary(view: OnlineFinalResultView, totalQuestions: number): string {
  const me = view.entries.find(({ isMe }) => isMe);
  if (!me || view.myPlace === null) return '최종 순위가 나왔어요.';
  // 방장 혼자 연 판(혼자 여는 온라인 방). 혼자서 «최종 1위»는 순위가 아니다 — 푼 결과만 말한다
  if (view.entries.length === 1) return `혼자 푼 판 · ${me.score}점 · ${me.correctCount}/${totalQuestions} 정답`;
  const place = view.myTied ? onlinePlaceLabel(view.myPlace, true) : `최종 ${view.myPlace}위`;
  return `${place} · ${me.score}점 · ${me.correctCount}/${totalQuestions} 정답`;
}

/**
 * 내 자리에 짧은 축하를 붙이는가 (U38). 1~3위(공동 포함)이고 한 문제라도 맞혔을 때만이다 —
 * 모두 0점이라 다 같이 «공동 1위»인 판을 축하하지 않는다. 움직임은 한 번뿐이고 움직임 줄이기를 따른다.
 */
export function onlineFinalCelebrates(view: OnlineFinalResultView): boolean {
  const me = view.entries.find(({ isMe }) => isMe);
  return me !== undefined && me.place <= 3 && me.score > 0;
}

export interface OnlineReviewRow {
  position: number;
  question: string;
  result: 'correct' | 'wrong' | 'timeout';
  /** 내 답 줄. 맞혔으면 정답 줄 하나로 충분해 null */
  mine: string | null;
  answer: string;
  explanation: string;
  /**
   * «이 문제 이상해요» 신고 주소 (FR-5.8). 온라인 은행은 비공개라 **문제 번호와 분야만** 싣는다 —
   * 질문·보기·정답·해설은 이 화면에만 보이고 공개 이슈로 나가지 않는다
   */
  reportUrl: string;
}

/**
 * «문제 다시 보기» 한 줄씩 (U38). 로컬 결과의 오답 복습과 같은 «내 답 ✗ / 정답 ✓» 문법이고,
 * 맞힌 문제는 «내 답 · 정답» 한 줄이다. 판이 끝난 뒤에만 오는 서버 풀이가 없으면 아무것도 만들지 않는다.
 * 맞힌 문제도 신고할 수 있다 — 정답이 틀린 문제는 오히려 «맞힌» 쪽에 숨는다.
 */
export function onlineReviewRows(review: readonly OnlineReviewItem[] | undefined): OnlineReviewRow[] {
  return (review ?? []).map((item) => ({
    position: item.position,
    question: item.question,
    result: item.correct ? 'correct' : item.timedOut ? 'timeout' : 'wrong',
    mine: item.correct
      ? null
      : item.choiceIndex === null ? '시간 초과' : item.choices[item.choiceIndex],
    answer: item.choices[item.answerIndex],
    explanation: item.explanation,
    reportUrl: onlineQuestionReportUrl({ id: item.id, category: item.categoryId }),
  }));
}

/** 접힌 «문제 다시 보기» 버튼 이름. 몇 문제인지와 틀린 수를 펴기 전에 알린다 */
export function onlineReviewToggleLabel(rows: readonly OnlineReviewRow[]): string {
  const missed = rows.filter(({ result }) => result !== 'correct').length;
  return missed > 0
    ? `문제 다시 보기 · ${rows.length}문제 중 ${missed}개 놓침`
    : `문제 다시 보기 · ${rows.length}문제 모두 정답`;
}

export interface OnlineResultScreenDeps {
  /**
   * 「한 판 더」 (U38). 대기실로 돌아가며, 방장이 아니면 준비를 켜 둔다. 옮기기를 마칠 때까지 기다린다.
   * 혼자 푼 판(FR-7.13 3단계)이면 «다시 하기»이고 같은 혼자 방에서 곧바로 새 판을 연다
   */
  onAgain: () => Promise<void>;
  onRoom: () => void;
  onHome: () => void;
  getPlayerId: () => string;
  /**
   * 「온라인 랭킹 보기」 (FR-7.13 2단계). 이 판의 분야(전체 도전이면 전체) 이번 주 랭킹을 연다. 없으면 그 버튼을
   * 그리지 않는다
   */
  onOpenRanking?: (target: RankingTarget) => void;
}

/** 이 판이 쌓이는 랭킹. 분야가 없는 판은 전체 도전이다 */
export function onlineMatchRankingTarget(snapshot: Pick<OnlineFinishedMatch, 'categoryId'>): RankingTarget {
  return snapshot.categoryId === null
    ? { mode: 'all', category: null }
    : { mode: 'category', category: snapshot.categoryId };
}

/** 결과 화면의 갈래. `solo`는 홈의 분야 칸이 연 혼자 푸는 온라인 판이다 (FR-7.13 3단계) */
export interface OnlineResultOptions {
  /** 아직 그 방에 들어가 있는가. 아니면 「한 판 더」를 그리지 않는다 */
  inRoom: boolean;
  /**
   * 혼자 푼 온라인 판인가. 행동 줄이 «다시 하기»(같은 혼자 방의 새 판)·«홈으로»(방을 나가 지운다)이고 대기실로 가는
   * 길이 없다. 최고 기록 비교(FR-5.7)는 `setBest`가 채운다
   */
  solo?: boolean;
}

export interface OnlineResultScreen {
  show(snapshot: OnlineFinishedMatch, options?: OnlineResultOptions): void;
  /**
   * 혼자 푼 판의 최고 기록 비교 (FR-5.7). `previous`는 서버가 이 판의 기록을 빼고 센 내 최고 점수이고 기록이 없으면
   * null이다. 읽지 못했으면(undefined) 줄을 두지 않는다 — 지어내지 않는다
   */
  setBest(matchId: string, previous: number | null | undefined): void;
  hide(): void;
}

/** 혼자 푼 판의 «다시 하기». 새 판을 여는 행동이라 골드 주 행동이다(로컬 결과의 「다시 하기」와 같다) */
export const SOLO_AGAIN_LABEL = '다시 하기';

export function createOnlineResultScreen(
  { onAgain, onRoom, onHome, getPlayerId, onOpenRanking }: OnlineResultScreenDeps,
): OnlineResultScreen {
  const el = {
    summary: need('online-final-summary'),
    best: need('online-final-best'),
    recorded: need('online-final-recorded'),
    openRanking: need<HTMLButtonElement>('online-final-open-ranking'),
    list: need<HTMLOListElement>('online-final-ranking'),
    again: need<HTMLButtonElement>('online-final-again'),
    room: need<HTMLButtonElement>('online-final-room'),
    home: need<HTMLButtonElement>('online-final-home'),
    reviewToggle: need<HTMLButtonElement>('online-final-review-toggle'),
    reviewBlock: need('online-final-review-block'),
    review: need<HTMLOListElement>('online-final-review'),
  };
  /** 「한 판 더」가 대기실을 여는 중인가. 다시 눌러도 겹쳐 보내지 않는다 */
  let againPending = false;
  /** 지금 보이는 판. 늦게 온 최고 기록이 다음 판의 화면을 고치지 않게 한다 */
  let shownMatchId: string | null = null;
  /** 지금 보이는 판의 내 점수 (혼자 판의 최고 기록 비교) */
  let shownScore: number | null = null;
  /** 혼자 푼 판이면 «다시 하기», 아니면 «한 판 더» */
  let againLabel = '한 판 더';

  function setAgainBusy(busy: boolean): void {
    againPending = busy;
    // 홈의 온라인 입구·결과의 「대기실로」와 같은 말이다. 잠그지 않는다 — 다른 행동이 이긴다
    el.again.textContent = busy ? '연결 중…' : againLabel;
    if (busy) el.again.setAttribute('aria-busy', 'true');
    else el.again.removeAttribute('aria-busy');
  }

  el.again.addEventListener('click', async () => {
    if (againPending) return;
    setAgainBusy(true);
    try {
      await onAgain();
    } finally {
      setAgainBusy(false);
    }
  });
  el.room.addEventListener('click', onRoom);
  el.home.addEventListener('click', onHome);
  /** 지금 보이는 판의 랭킹. 「온라인 랭킹 보기」가 그 분야를 연다 */
  let rankingTarget: RankingTarget | null = null;
  el.openRanking.addEventListener('click', () => {
    if (rankingTarget && onOpenRanking) onOpenRanking(rankingTarget);
  });

  function setReviewExpanded(expanded: boolean): void {
    el.reviewBlock.hidden = !expanded;
    el.reviewToggle.setAttribute('aria-expanded', String(expanded));
  }
  el.reviewToggle.addEventListener('click', () => setReviewExpanded(Boolean(el.reviewBlock.hidden)));

  function createReviewRow(tag: string, text: string, modifier: 'mine' | 'answer' | 'mine-correct'): HTMLParagraphElement {
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

  function renderReview(snapshot: OnlineFinishedMatch): void {
    const rows = onlineReviewRows(snapshot.review);
    setReviewExpanded(false);
    el.reviewToggle.hidden = rows.length === 0;
    el.reviewToggle.textContent = onlineReviewToggleLabel(rows);
    el.review.replaceChildren(...rows.map((row) => {
      const item = document.createElement('li');
      item.className = 'review__item';
      item.dataset.result = row.result;
      const question = document.createElement('p');
      question.className = 'review__question';
      question.textContent = `${row.position}. ${row.question}`;
      const explanation = document.createElement('p');
      explanation.className = 'review__explanation';
      explanation.textContent = row.explanation;
      // ✓ ✗ 표식은 디자인 층이 줄의 종류를 보고 그린다
      const answerRows = row.mine === null
        ? [createReviewRow('내 답 · 정답', row.answer, 'mine-correct')]
        : [createReviewRow('내 답', row.mine, 'mine'), createReviewRow('정답', row.answer, 'answer')];
      // 신고 주소에는 번호와 분야만 있다(reportUrl). 이름은 보이는 문항 번호로 어느 문제인지 말한다
      const report = createQuestionReportLink(row.reportUrl, questionReportLabel(`${row.position}번 문제`));
      item.append(question, ...answerRows, explanation, report);
      return item;
    }));
  }

  return {
    show(snapshot, options = { inRoom: true }) {
      const solo = options.solo === true;
      const view = onlineFinalResultView(snapshot, getPlayerId());
      el.summary.textContent = onlineFinalSummary(view, snapshot.totalQuestions);
      shownMatchId = snapshot.matchId;
      shownScore = view.entries.find(({ isMe }) => isMe)?.score ?? null;
      // 최고 기록 비교는 서버의 답이 오면 setBest가 채운다. 그 전에는 줄을 두지 않는다
      el.best.hidden = true;
      el.best.textContent = '';
      againLabel = solo ? SOLO_AGAIN_LABEL : '한 판 더';
      // 서버가 이 판을 닫으며 내 결과를 랭킹에 남겼을 때만 그렇다고 말한다 (FR-7.13 2단계). 이 필드가 없는
      // 이전 API의 판이면 아무 말도 하지 않는다 — 남지 않은 기록을 남았다고 하지 않는다
      const recorded = snapshot.rankingRecorded === true;
      rankingTarget = recorded ? onlineMatchRankingTarget(snapshot) : null;
      el.recorded.hidden = !recorded;
      el.openRanking.hidden = !recorded || onOpenRanking === undefined;
      setAgainBusy(false);
      el.again.hidden = !options.inRoom;
      // 방 밖이면 이 버튼은 로비를 연다 (app.ts) — 그 말을 그대로 쓴다. 혼자 판은 돌아갈 대기실이 없다
      el.room.textContent = options.inRoom ? '대기실로' : '온라인 로비로';
      el.room.hidden = solo;
      const celebrate = onlineFinalCelebrates(view);
      el.list.replaceChildren();
      for (const entry of view.entries) {
        const item = document.createElement('li');
        item.className = 'online-final-ranking__item';
        item.classList.toggle('online-final-ranking__item--mine', entry.isMe);
        // 한 번만 도는 축하. 움직임 줄이기(기기·앱 설정)에서는 디자인 층이 움직임을 끈다
        item.classList.toggle('online-final-ranking__item--celebrate', entry.isMe && celebrate);

        const place = document.createElement('span');
        place.className = 'online-final-ranking__place';
        // 금·은·동 칸은 줄 순서가 아니라 이 값을 보고 칠한다 (공동 1위는 모두 금색)
        place.dataset.place = String(entry.place);
        place.textContent = onlinePlaceLabel(entry.place, entry.tied);
        // 캐릭터는 그림이다. 이름은 바로 옆 글자가 말한다
        const figure = document.createElement('span');
        figure.className = 'online-final-ranking__figure';
        figure.setAttribute('aria-hidden', 'true');
        figure.append(createBody(entry.characterId));
        const name = document.createElement('span');
        name.className = 'online-final-ranking__name';
        name.textContent = entry.nickname;
        const score = document.createElement('span');
        score.className = 'online-final-ranking__score';
        if (entry.isMe && celebrate) {
          // 골드 별은 장식이다. 순위는 칸의 글자가 말한다
          const star = document.createElement('span');
          star.className = 'online-final-ranking__star';
          star.setAttribute('aria-hidden', 'true');
          score.append(star);
        }
        score.append(`${entry.score}점 · ${entry.correctCount}정답`);
        item.append(place, figure, name, score);
        el.list.append(item);
      }
      renderReview(snapshot);
      // 끝났다는 것을 짧은 차임으로도 알린다 (N03). 소리 설정을 따른다
      playFinish();
    },
    setBest(matchId, previous) {
      if (matchId !== shownMatchId || shownScore === null || previous === undefined) return;
      const { text, isNew } = bestComparisonText(shownScore, previous);
      el.best.classList.toggle('result-best--new', isNew);
      el.best.textContent = text;
      el.best.hidden = false;
    },
    hide() {
      el.list.replaceChildren();
      el.summary.textContent = '';
      shownMatchId = null;
      shownScore = null;
      el.best.hidden = true;
      el.best.textContent = '';
      rankingTarget = null;
      el.recorded.hidden = true;
      el.openRanking.hidden = true;
      setAgainBusy(false);
      setReviewExpanded(false);
      el.review.replaceChildren();
    },
  };
}
