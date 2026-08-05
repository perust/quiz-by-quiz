// 화면 전환
// 단일 HTML 안의 <section data-screen="..."> 를 hidden 속성으로 토글한다.
// 해시 라우팅을 쓰지 않으므로 새로고침하면 항상 홈에서 시작한다.

import { all, maybe } from '../dom.js';

/** index.html 의 `data-screen` 값. 화면이 늘면 여기와 HTML 을 함께 고친다 */
export type ScreenName = 'home' | 'quiz' | 'characters' | 'online' | 'waiting' | 'result' | 'ranking';

/** @param name 보여줄 화면 이름 */
export function showScreen(name: ScreenName): void {
  let target: HTMLElement | null = null;

  for (const section of all<HTMLElement>('[data-screen]')) {
    const isTarget = section.dataset.screen === name;
    section.hidden = !isTarget;
    if (isTarget) target = section;
  }

  window.scrollTo(0, 0);

  // 숨긴 화면에 포커스가 남으면 키보드 사용자가 갈 곳을 잃는다.
  // 새 화면으로 옮기면 aria-labelledby가 가리키는 제목부터 낭독된다.
  // 그래서 여기서 따로 안내 문구를 내보내지 않는다 (두 번 읽히는 것을 피한다).
  if (target) target.focus({ preventScroll: true });
}

/**
 * 스크린리더에 한 번만 알린다. 시각적으로는 보이지 않는다.
 * 타이머 숫자처럼 계속 바뀌는 값에는 쓰지 않는다 — 낭독이 끊이지 않는다.
 */
export function announce(message: string): void {
  const region = maybe('announcer');
  if (!region) return;
  region.textContent = message;
}
