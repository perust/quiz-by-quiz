// 발밑 칸 초안 (U13). 혼자 하기와 같은 규칙 — 시간이 끝나면 캐릭터가 서 있는 칸이 답이다.
//
// 서버 권위는 그대로다. 화면은 실제로 움직인 뒤 선 칸이 바뀔 때만 그 칸을 방 소켓으로 «초안»으로
// 알리고, 칸에서 내려서면 지운다. 서버는 초안을 «모두 답했다»에 세지 않고(앞당긴 공개는 여전히 직접
// 낸 답만 기다린다), 마감이 빈 답을 채울 때만 그 칸을 보통 답으로 남긴다. 그래서 여기에는 채점도
// 마감 판정도 없다 — 무엇을 언제 보낼지만 정한다.
//
// - 판이 그 규칙일 때만(snapshot의 `standingAnswers`) 보낸다. 그 필드가 없는 이전 API는 직접 낸 답만
//   센다. 소켓의 서버가 초안을 받는다고 알렸는지는 저장소가 다시 본다(ws-ticket capability)
// - 칸 위를 스쳐 지나갈 때마다 보내지 않게 잠깐(`settleMs`) 멈춘 뒤 보낸다. 캐릭터가 멈춰 서면 곧바로
//   보낸다(`flush`) — 마감 직전에 선 칸도 늦지 않게
// - 같은 말은 되풀이하지 않는다. 문항이 바뀌면(`reset`) 처음부터 센다

import type { OnlineMatchSnapshot, StandingAnswerDraft } from './adapter.js';

/** 칸을 바꾼 뒤 이만큼 그대로면 보낸다. 스쳐 지나간 칸은 보내지 않는다 */
export const STANDING_ANSWER_SETTLE_MS = 150;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StandingAnswerTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const BROWSER_TIMERS: StandingAnswerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * 지금 보낼 초안의 자리. 초안을 쓰지 않는 때면 null이다 — 이전 API의 판, 문항이 돌지 않을 때,
 * 이미 답을 냈거나 내는 중일 때. `standingIndex`는 arena가 실제로 움직인 뒤에만 준 발밑 칸이다.
 */
export function onlineStandingDraft(
  snapshot: OnlineMatchSnapshot | null,
  standingIndex: number | null,
  submitPending: boolean,
): StandingAnswerDraft | null {
  if (
    snapshot === null
    || snapshot.state !== 'running'
    || snapshot.standingAnswers !== true
    || snapshot.ownSubmission !== null
    || submitPending
  ) return null;
  return {
    matchId: snapshot.matchId,
    position: snapshot.question.position,
    choiceIndex: standingIndex,
  };
}

export interface StandingAnswerPublisher {
  /** 지금의 초안. 바뀌었으면 잠깐 뒤에 보낸다. null이면 초안을 쓰지 않는 때라 기다리던 것도 버린다 */
  update(draft: StandingAnswerDraft | null): void;
  /** 기다리던 초안을 곧바로 보낸다. 캐릭터가 멈춰 섰을 때 */
  flush(): void;
  /** 새 문항·새 판. 보낸 기억과 기다리던 초안을 모두 버린다 */
  reset(): void;
}

function sameDraft(left: StandingAnswerDraft | null, right: StandingAnswerDraft | null): boolean {
  return left?.matchId === right?.matchId
    && left?.position === right?.position
    && left?.choiceIndex === right?.choiceIndex;
}

export function createStandingAnswerPublisher(
  {
    send,
    settleMs = STANDING_ANSWER_SETTLE_MS,
    timers = BROWSER_TIMERS,
  }: {
    send: (draft: StandingAnswerDraft) => void;
    settleMs?: number;
    timers?: StandingAnswerTimers;
  },
): StandingAnswerPublisher {
  /** 서버가 이 문항에 대해 가진 것(마지막으로 보낸 초안). 보내지 않았으면 null */
  let sent: StandingAnswerDraft | null = null;
  let pending: StandingAnswerDraft | null = null;
  let timer: TimerHandle | null = null;

  function cancel(): void {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  /** 서버가 이미 아는 것과 같은가. 아무것도 보내지 않은 문항의 «내려섰다»는 보낼 것이 없다 */
  function alreadyKnown(draft: StandingAnswerDraft): boolean {
    if (sent === null) return draft.choiceIndex === null;
    if (sent.matchId !== draft.matchId || sent.position !== draft.position) return draft.choiceIndex === null;
    return sent.choiceIndex === draft.choiceIndex;
  }

  function sendPending(): void {
    cancel();
    const draft = pending;
    pending = null;
    if (draft === null || alreadyKnown(draft)) return;
    sent = draft;
    send(draft);
  }

  return {
    update(draft) {
      if (draft === null) {
        cancel();
        pending = null;
        return;
      }
      if (sameDraft(draft, pending)) return;
      pending = draft;
      cancel();
      if (alreadyKnown(draft)) {
        pending = null;
        return;
      }
      timer = timers.setTimeout(sendPending, settleMs);
    },
    flush() {
      if (pending !== null) sendPending();
    },
    reset() {
      cancel();
      pending = null;
      sent = null;
    },
  };
}
