// index.html 의 인라인 스크립트가 만드는 전역.
//
// 모듈이 아닌 일반 스크립트라 어떤 환경에서도 실행된다. 타이머를 걸어 두고, app.ts 가
// 문제를 받아 홈을 그리기 직전에 `markBooted()` 가 그것을 끈다 (U05). 살아 있으면 아직 뜨지
// 못한 것이다 — file:// 이면 3초에 개발자 안내, 그 밖에는 3초에 «느려요», 15초에 실패 안내.
// 이어지는 타이머도 같은 자리에 담겨 clearTimeout 하나로 꺼진다.
//
// `__bootProgress()` 는 실패 안내의 15초를 지금부터 다시 세게 한다 (local-ux-3). app.ts 가 모듈이 다 와서
// 문제를 받기 시작할 때 부른다 — 받는 동안은 10초(`BANK_FETCH_TIMEOUT_MS`)가 기다림을 끊는다.

declare global {
  interface Window {
    __bootTimer: number | undefined;
    __bootProgress: (() => void) | undefined;
  }
}

export {};
