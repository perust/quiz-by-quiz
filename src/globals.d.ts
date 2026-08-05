// index.html 의 인라인 스크립트가 만드는 전역.
//
// 모듈이 아닌 일반 스크립트라 어떤 환경에서도 실행된다. 3초 타이머를 걸어 두고,
// app.ts 가 뜨면 `markBooted()` 가 그것을 끈다. 타이머가 살아 있으면 스크립트
// 자체가 막힌 것이라(file:// 로 열었을 때가 대표적) 안내 화면이 뜬다.

declare global {
  interface Window {
    __bootTimer: number | undefined;
  }
}

export {};
