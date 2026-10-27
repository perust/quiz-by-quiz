// Server-authoritative final ranking screen.
// The score list has already been ordered by PostgreSQL; never sort it in a browser.

import { need } from '../dom.js';
import type { OnlineFinishedMatch, OnlineScore } from '../online/adapter.js';

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
  const scores = snapshot.scores;
  let myPlace: number | null = null;
  let myTied = false;
  let previousPlace = 0;
  // 배열 순서는 서버가 정한 그대로 둔다. 점수(맞힌 개수 × 10)만 순위를 나눈다 —
  // 빨리 낸 사람이나 이름이 앞선 사람에게 더 높은 순위를 주지 않는다 (PRD 2.1).
  const entries = scores.map((score, index) => {
    const sharesWithPrevious = index > 0 && scores[index - 1].score === score.score;
    const sharesWithNext = index + 1 < scores.length && scores[index + 1].score === score.score;
    const place = sharesWithPrevious ? previousPlace : index + 1;
    previousPlace = place;
    const tied = sharesWithPrevious || sharesWithNext;
    const isMe = score.playerId === playerId;
    if (isMe) {
      myPlace = place;
      myTied = tied;
    }
    return { ...score, place, tied, isMe };
  });
  return { matchId: snapshot.matchId, entries, myPlace, myTied };
}

/** 순위 표시. 동점이면 «공동»을 글자로 붙인다 — 색이나 줄 순서만으로 알리지 않는다. */
export function onlinePlaceLabel(place: number, tied: boolean): string {
  return tied ? `공동 ${place}위` : `${place}위`;
}

/** 내 결과 한 줄. 플레이어에게 의미 없는 «서버» 같은 말을 쓰지 않는다. */
export function onlineFinalSummary(view: OnlineFinalResultView, totalQuestions: number): string {
  const me = view.entries.find(({ isMe }) => isMe);
  if (!me || view.myPlace === null) return '최종 순위가 나왔어요.';
  const place = view.myTied ? onlinePlaceLabel(view.myPlace, true) : `최종 ${view.myPlace}위`;
  return `${place} · ${me.score}점 · ${me.correctCount}/${totalQuestions} 정답`;
}

export interface OnlineResultScreenDeps {
  onRoom: () => void;
  onHome: () => void;
  getPlayerId: () => string;
}

export interface OnlineResultScreen {
  show(snapshot: OnlineFinishedMatch): void;
  hide(): void;
}

export function createOnlineResultScreen(
  { onRoom, onHome, getPlayerId }: OnlineResultScreenDeps,
): OnlineResultScreen {
  const el = {
    summary: need('online-final-summary'),
    list: need<HTMLOListElement>('online-final-ranking'),
    room: need<HTMLButtonElement>('online-final-room'),
    home: need<HTMLButtonElement>('online-final-home'),
  };

  el.room.addEventListener('click', onRoom);
  el.home.addEventListener('click', onHome);

  return {
    show(snapshot) {
      const view = onlineFinalResultView(snapshot, getPlayerId());
      el.summary.textContent = onlineFinalSummary(view, snapshot.totalQuestions);
      el.list.replaceChildren();
      for (const entry of view.entries) {
        const item = document.createElement('li');
        item.className = 'online-final-ranking__item';
        item.classList.toggle('online-final-ranking__item--mine', entry.isMe);

        const place = document.createElement('span');
        place.className = 'online-final-ranking__place';
        // 금색 칸은 줄 순서가 아니라 이 값을 보고 칠한다 (공동 1위는 모두 금색)
        place.dataset.place = String(entry.place);
        place.textContent = onlinePlaceLabel(entry.place, entry.tied);
        const name = document.createElement('span');
        name.className = 'online-final-ranking__name';
        name.textContent = entry.nickname;
        const score = document.createElement('span');
        score.className = 'online-final-ranking__score';
        score.textContent = `${entry.score}점 · ${entry.correctCount}정답`;
        item.append(place, name, score);
        el.list.append(item);
      }
    },
    hide() {
      el.list.replaceChildren();
      el.summary.textContent = '';
    },
  };
}
