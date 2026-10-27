// 매치 중 채팅 낭독의 차례 (U42, 소유자 결정: 화면 낭독기는 매치 중에도 채팅을 읽는다)
//
// 온라인 퀴즈의 대화 로그(`#online-chat-log`)는 `role="log"`·`aria-live="polite"`·`aria-relevant="additions"`다.
// 줄을 하나씩 **붙이기만** 하므로 낭독기는 새 줄(말한 사람 이름 + 말)만 읽고 로그 전체를 다시 읽지 않으며,
// 오래된 줄을 떼어 내는 것(`CHAT_LINES`)은 읽지 않는다. 포커스도 옮기지 않는다.
//
// 다만 같은 순간의 두 낭독은 먼저 DOM에 닿은 쪽이 먼저 나간다. 새 문항(질문 제목으로 포커스)·정답 공개나 남은 5초
// 경고와 같은 순간에 채팅 줄이 먼저 붙으면, 낭독기가 채팅을 읽기 시작하고 곧이어 온 포커스가 그 말을 끊거나
// 경고가 채팅 뒤로 밀렸다. 그래서 우선 낭독이 나간 뒤 `holdMs` 동안 온 줄은 로그에 붙이지 않고 기다렸다가
// 온 차례대로 붙인다 — 그때는 낭독기가 이미 우선 낭독을 읽는 중이라 polite 줄은 그 뒤에 선다.
// 말풍선(눈으로 보는 것)은 기다리지 않는다. 기다리는 동안 숨긴 사람의 말은 `append`가 다시 걸러 낸다.
//
// DOM을 모른다. 무엇을 붙일지는 부르는 쪽이 `append`로 정한다.

/** 우선 낭독(새 문항·공개·남은 5초 경고) 뒤에 채팅 줄을 붙이지 않고 기다리는 시간 */
export const CHAT_PRIORITY_HOLD_MS = 1_500;

export interface ChatQueueTimers {
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface ChatLineQueueOptions<T> {
  /** 로그에 실제로 한 줄 붙인다 */
  append: (line: T) => void;
  /** 기다리는 줄의 최대 수. 넘치면 가장 오래된 것부터 버린다 — 붙였어도 로그 한도로 곧 밀려날 줄이다 */
  limit: number;
  holdMs?: number;
  timers?: ChatQueueTimers;
}

export interface ChatLineQueue<T> {
  /** 새 줄. 우선 낭독을 기다리는 중이 아니면 곧바로 붙인다 */
  push(line: T): void;
  /** 우선 낭독이 막 나갔다. 지금부터 `holdMs` 동안 온 줄은 그 뒤에 차례대로 붙인다(다시 부르면 늘어난다) */
  yieldTo(): void;
  /** 기다리는 중인가 */
  readonly holding: boolean;
  /** 기다리던 줄을 버리고 시계를 끈다 (매치를 떠날 때) */
  reset(): void;
}

const browserTimers: ChatQueueTimers = {
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export function createChatLineQueue<T>(
  { append, limit, holdMs = CHAT_PRIORITY_HOLD_MS, timers = browserTimers }: ChatLineQueueOptions<T>,
): ChatLineQueue<T> {
  const waiting: T[] = [];
  let timer: number | null = null;

  function release(): void {
    timer = null;
    // 기다린 줄을 온 차례대로 한 줄씩 붙인다. 로그를 다시 그리지 않으므로 낭독기는 새 줄만 읽는다
    for (const line of waiting.splice(0)) append(line);
  }

  return {
    push(line) {
      if (timer === null) {
        append(line);
        return;
      }
      waiting.push(line);
      while (waiting.length > limit) waiting.shift();
    },
    yieldTo() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(release, holdMs);
    },
    get holding() {
      return timer !== null;
    },
    reset() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      waiting.length = 0;
    },
  };
}
