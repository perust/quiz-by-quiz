// 문항 타이머 (FR-3.7, FR-3.8, FR-3.11, FR-3.12)
//
// 핵심: setInterval로 1초씩 빼는 카운트다운이 아니라, 시작 시각을 기록해 두고
// 물어볼 때마다 "지금 - 시작 시각"을 계산한다. 그래서 탭이 백그라운드로 내려가
// 타이머 콜백이 스로틀링되어도 남은 시간이 어긋나지 않는다.
//
// 정지 역시 무언가를 멈추는 게 아니라 "멈춘 시각"을 찍는 것이다.
// 해설을 읽는 동안 시간이 흐르지 않는 이유가 여기에 있다.
//
// 이 모듈은 DOM을 모른다. 화면 갱신은 ui/quiz.js가 맡는다.

import { TIME_LIMIT_MS } from '../constants.js';

/**
 * @param {{ limitMs?: number, now?: () => number }} options
 *   now는 기본이 performance.now다. Date.now와 달리 시스템 시계가 바뀌어도 영향받지 않는다.
 */
export function createQuestionTimer({ limitMs = TIME_LIMIT_MS, now = () => performance.now() } = {}) {
  let startedAt = null;
  let stoppedAt = null;

  return {
    limitMs,

    /** 문제가 화면에 표시되는 시점에 호출한다 */
    start() {
      startedAt = now();
      stoppedAt = null;
    },

    /** 보기를 선택하거나 시간이 다 된 순간 호출한다. 두 번 불러도 처음 시각을 유지한다 */
    stop() {
      if (startedAt !== null && stoppedAt === null) {
        stoppedAt = now();
      }
    },

    /** 시작했고 아직 멈추지 않았는가 */
    isRunning() {
      return startedAt !== null && stoppedAt === null;
    },

    /** 이 문항에 쓴 시간. 제한 시간을 넘지 않도록 잘라낸다 (FR-5.3의 계산 기준) */
    elapsedMs() {
      if (startedAt === null) return 0;
      const end = stoppedAt ?? now();
      return Math.min(Math.max(end - startedAt, 0), limitMs);
    },

    /** 남은 시간 (0 미만으로 내려가지 않음) */
    remainingMs() {
      return limitMs - this.elapsedMs();
    },

    /** 제한 시간을 다 썼는가 */
    isExpired() {
      return this.remainingMs() <= 0;
    },
  };
}
