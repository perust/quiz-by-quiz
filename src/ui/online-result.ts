// Server-authoritative final ranking screen.
// The score list has already been ordered by PostgreSQL; never sort it in a browser.

import { need } from '../dom.js';
import type { OnlineFinishedMatch, OnlineScore } from '../online/adapter.js';

export interface OnlineFinalEntry extends OnlineScore {
  /** Display-only ordinal of the server-provided array. */
  place: number;
  isMe: boolean;
}

export interface OnlineFinalResultView {
  matchId: string;
  entries: OnlineFinalEntry[];
  myPlace: number | null;
}

export function onlineFinalResultView(
  snapshot: OnlineFinishedMatch,
  playerId: string,
): OnlineFinalResultView {
  let myPlace: number | null = null;
  const entries = snapshot.scores.map((score, index) => {
    const place = index + 1;
    const isMe = score.playerId === playerId;
    if (isMe) myPlace = place;
    return { ...score, place, isMe };
  });
  return { matchId: snapshot.matchId, entries, myPlace };
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
      const me = view.entries.find(({ isMe }) => isMe);
      el.summary.textContent = me
        ? `서버 최종 순위: ${view.myPlace}위 · ${me.score}점 · ${me.correctCount}/${snapshot.totalQuestions} 정답`
        : '서버가 최종 순위를 확정했습니다.';
      el.list.replaceChildren();
      for (const entry of view.entries) {
        const item = document.createElement('li');
        item.className = 'online-final-ranking__item';
        item.classList.toggle('online-final-ranking__item--mine', entry.isMe);

        const place = document.createElement('span');
        place.className = 'online-final-ranking__place';
        place.textContent = `${entry.place}위`;
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
