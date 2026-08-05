// DOM 을 집어 오는 자리.
//
// `document.getElementById` 는 «없을 수도 있다»고 답한다. 이 앱의 화면은 index.html 에
// 통째로 박혀 있어 **없으면 HTML 을 잘못 고친 것**이지 다뤄야 할 상황이 아니다.
// 그래서 `need` 는 못 찾으면 던진다 — 조용히 넘어가면 한참 뒤 엉뚱한 자리에서
// «왜 안 눌리지»로 나타난다.
//
// 던지면 app.ts 가 멈추고 `markBooted()` 가 불리지 않아 **index.html 의 부팅 감지가
// 안내 화면을 띄운다.** 손쓸 수 없는 상황을 화면으로 알리는 길이 이미 있다.

/** 반드시 있어야 하는 요소. 없으면 던진다 */
export function need<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`화면 요소를 찾을 수 없습니다: #${id}`);
  return element as T;
}

/**
 * 있을 수도 없을 수도 있는 요소.
 *
 * 손가락 조작부(스틱·확정 버튼)처럼 **없어도 앱이 도는 것**에만 쓴다.
 * 부르는 쪽이 없을 때를 다뤄야 한다.
 */
export function maybe<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** 선택자로 하나. 없으면 던진다 */
export function needOne<T extends Element = Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`화면 요소를 찾을 수 없습니다: ${selector}`);
  return element;
}

/** 선택자로 여럿. 없으면 빈 배열이라 훑기만 하는 쪽은 그대로 돈다 */
export function all<T extends Element = Element>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}
