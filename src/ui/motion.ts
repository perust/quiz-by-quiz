// 움직임 줄이기 (U55) — 스크립트가 직접 움직이는 것도 CSS 와 같은 두 신호를 본다.
//
// `css/voxel-theme.css` 는 기기의 `prefers-reduced-motion` 과 설정의 `html[data-motion='reduce']`
// (`settings-dialog.ts` 의 `applyMotionPreference`)에 같은 규칙을 건다. 그런데 `scrollIntoView` 에
// `behavior: 'smooth'` 를 넘기면 CSS 의 `scroll-behavior: auto` 를 건너뛰고 부드럽게 흘러간다 —
// 움직임을 줄였는데 로비의 동작 카드를 누를 때마다 화면이 미끄러졌다.

/** 설정이나 기기가 움직임을 줄이라고 하는가. 둘 중 하나면 줄인다 */
export function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.motion === 'reduce') return true;
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `scrollIntoView` 의 `behavior`. 움직임을 줄이면 곧바로 옮긴다 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
