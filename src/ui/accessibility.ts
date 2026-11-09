// 여러 화면의 인페이지 대화상자가 함께 쓰는 접근성 동작

/** 다이얼로그 안에서 Tab이 맴돌게 할 대상 */
const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])";

/**
 * Tab이 다이얼로그 밖으로 새어 나가지 않게 막는다.
 * 뒤 화면 요소로 포커스가 가면 무엇을 조작하는지 알 수 없다.
 */
export function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => !node.hidden);
  if (items.length === 0) return;

  const first = items[0];
  const last = items[items.length - 1];

  // 조작법처럼 읽기 시작점인 패널(tabindex=-1)에 포커스를 둔 경우도 있다.
  // 그 자리에서 Tab/Shift+Tab을 누르면 각각 첫/마지막 조작부로 들여보낸다.
  if (!items.includes(document.activeElement as HTMLElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
