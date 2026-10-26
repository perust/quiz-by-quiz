// index.html 의 인라인 스크립트가 만드는 전역.
//
// 모듈이 아닌 일반 스크립트라 어떤 환경에서도 실행된다. 타이머를 걸어 두고, app.ts 가
// 문제를 받아 홈을 그리기 직전에 `markBooted()` 가 그것을 끈다 (U05). 살아 있으면 아직 뜨지
// 못한 것이다 — file:// 이면 3초에 개발자 안내, 그 밖에는 3초에 «느려요», 15초에 실패 안내.
// 두 번째 타이머도 같은 자리에 담겨 clearTimeout 하나로 꺼진다.

declare global {
  interface Window {
    __bootTimer: number | undefined;
  }
}

export {};
