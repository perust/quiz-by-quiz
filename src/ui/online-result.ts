// Server-authoritative final ranking screen.
// The score list has already been ordered by PostgreSQL; never sort it in a browser.

import { playFinish } from '../audio.js';
import { need } from '../dom.js';
import type { OnlineFinishedMatch, OnlineReviewItem, OnlineScore } from '../online/adapter.js';
import { onlinePlaceLabel, onlinePlaces } from './online-standings.js';
import { createBody } from './sprite.js';

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
}

/**
 * «문제 다시 보기» 한 줄씩 (U38). 로컬 결과의 오답 복습과 같은 «내 답 ✗ / 정답 ✓» 문법이고,
 * 맞힌 문제는 «내 답 · 정답» 한 줄이다. 판이 끝난 뒤에만 오는 서버 풀이가 없으면 아무것도 만들지 않는다.
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
  /** 「한 판 더」 (U38). 대기실로 돌아가며, 방장이 아니면 준비를 켜 둔다. 옮기기를 마칠 때까지 기다린다 */
  onAgain: () => Promise<void>;
  onRoom: () => void;
  onHome: () => void;
  getPlayerId: () => string;
}

export interface OnlineResultScreen {
  /** @param options.inRoom 아직 그 방에 들어가 있는가. 아니면 「한 판 더」를 그리지 않는다 */
  show(snapshot: OnlineFinishedMatch, options?: { inRoom: boolean }): void;
  hide(): void;
}

export function createOnlineResultScreen(
  { onAgain, onRoom, onHome, getPlayerId }: OnlineResultScreenDeps,
): OnlineResultScreen {
  const el = {
    summary: need('online-final-summary'),
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

  function setAgainBusy(busy: boolean): void {
    againPending = busy;
    // 홈의 온라인 입구·결과의 「대기실로」와 같은 말이다. 잠그지 않는다 — 다른 행동이 이긴다
    el.again.textContent = busy ? '연결 중…' : '한 판 더';
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
      item.append(question, ...answerRows, explanation);
      return item;
    }));
  }

  return {
    show(snapshot, options = { inRoom: true }) {
      const view = onlineFinalResultView(snapshot, getPlayerId());
      el.summary.textContent = onlineFinalSummary(view, snapshot.totalQuestions);
      setAgainBusy(false);
      el.again.hidden = !options.inRoom;
      // 방 밖이면 이 버튼은 로비를 연다 (app.ts) — 그 말을 그대로 쓴다
      el.room.textContent = options.inRoom ? '대기실로' : '온라인 로비로';
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
    hide() {
      el.list.replaceChildren();
      el.summary.textContent = '';
      setAgainBusy(false);
      setReviewExpanded(false);
      el.review.replaceChildren();
    },
  };
}
