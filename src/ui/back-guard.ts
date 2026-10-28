// 브라우저 «뒤로»·새로고침의 안전망
//
// 이 앱에는 화면마다 주소가 없다. 해시 라우팅을 쓰지 않으므로 새로고침하면 언제나 홈이다 —
// 그 계약은 그대로 두고 **히스토리 상태만** 남긴다. 주소(URL)는 바꾸지 않는다.
// 진행 중인 판을 어딘가에 저장해 새로고침 뒤 이어 풀게 하지도 않는다(중간 저장 없음).
//
// 홈이 아닌 화면에 있는 동안에는 앱이 남긴 항목(guard)이 하나 위에 있어, 시스템 「뒤로」나
// 뒤로 스와이프가 앱 밖(이전 사이트·빈 탭)으로 나가지 않고 `popstate` 로 돌아온다.
// 돌아온 뒤 무엇을 할지는 `backStepFor` 가 지금 화면을 보고 정한다.
//
// **화면을 옮길 때마다 쌓지 않는다.** 앱이 남기는 항목은 많아야 둘 — 페이지를 연 자리(base)와
// 그 위의 guard 하나다. 쌓으면 홈에서 앱을 나가는 데 들른 화면 수만큼 「뒤로」를 눌러야 한다.
// 히스토리에는 항목을 지우는 API 가 없어 홈으로 돌아올 때는 guard 를 홈 표시로 바꿔 둔다.
// 그 자리에서 「뒤로」를 누르면 base 에 닿는데, 사용자는 앱을 나가려던 것이므로 한 번 더
// 뒤로 보내 준다(`leave`).

import { maybe } from '../dom.js';
import type { ScreenName } from './screens.js';

/** 테스트가 가짜를 넣을 수 있게 필요한 것만 받는다 */
export type HistoryLike = Pick<History, 'state' | 'pushState' | 'replaceState'>;

/** 이 앱이 남긴 상태라는 표시. 다른 코드가 남긴 값과 섞여도 알아보게 한다 */
type GuardKind = 'base' | 'guard';

function kindOf(state: unknown): GuardKind | null {
  if (typeof state !== 'object' || state === null || !('qbq' in state)) return null;
  return state.qbq === 'base' || state.qbq === 'guard' ? state.qbq : null;
}

/** 앱이 얹은 guard 항목인가. 아니면 페이지를 연 자리(또는 남이 남긴 상태)다 */
export function isGuardState(state: unknown): boolean {
  return kindOf(state) === 'guard';
}

/** 다른 코드가 같은 항목에 남긴 값이 있으면 지우지 않고 그 위에 표시만 더한다 */
function mark(state: unknown, kind: GuardKind, screen: ScreenName): Record<string, unknown> {
  const base = typeof state === 'object' && state !== null && !Array.isArray(state) ? state : {};
  return { ...base, qbq: kind, screen };
}

export interface BackGuard {
  /** `goTo` 가 화면을 옮길 때마다 부른다. 홈이 아니면 guard 를 하나 얹어 둔다 */
  enter(screen: ScreenName): void;

  /** `popstate` 로 guard 아래로 내려온 뒤, 지금 화면을 계속 지키려면 다시 얹는다 */
  rearm(screen: ScreenName): void;
}

export function createBackGuard(history: HistoryLike): BackGuard {
  return {
    enter(screen) {
      // 이미 guard 위에 있으면 그 자리를 새 화면으로 바꿀 뿐 하나 더 쌓지 않는다.
      // 홈으로 돌아올 때도 같다 — 지울 수 없으니 홈 표시로 바꿔 둔다
      if (isGuardState(history.state)) {
        history.replaceState(mark(history.state, 'guard', screen), '');
        return;
      }
      // 페이지를 연 자리. 주소는 넘기지 않는다 — 넘기지 않으면 지금 주소 그대로다
      history.replaceState(mark(history.state, 'base', 'home'), '');
      if (screen !== 'home') history.pushState(mark(null, 'guard', screen), '');
    },

    rearm(screen) {
      history.pushState(mark(null, 'guard', screen), '');
    },
  };
}

/** `popstate` 를 받았을 때 할 일 */
export type BackStep =
  /** 열린 대화상자만 닫는다. 화면은 그대로다 */
  | { kind: 'close-dialog' }
  /** 그 화면이 가진 뒤로·나가기 버튼을 그대로 누른다. 확인·정리·저장을 그 버튼이 맡는다 */
  | { kind: 'control'; id: string }
  /** 대기실: 방에서 나가지 않고 로비로 간다 */
  | { kind: 'lobby' }
  /** 홈으로 간다 */
  | { kind: 'home' }
  /** 홈에서 base 에 닿았다. 사용자는 앱을 나가려던 것이다 */
  | { kind: 'leave' }
  /** 홈에서 앞으로 가기로 guard 에 닿았다. 아무 데도 가지 않는다 */
  | { kind: 'stay' };

/**
 * 화면마다 「뒤로」에 쓰는 그 화면의 버튼.
 *
 * 따로 길을 만들지 않고 버튼을 누르는 것은 **확인 절차를 두 벌 두지 않기 위해서다.**
 * 나가기 확인·자동 저장·연결 정리는 버튼에 이미 달려 있고, 버튼이 바뀌면 «뒤로»도 따라간다.
 */
const BACK_CONTROLS: Partial<Record<ScreenName, string>> = {
  // 로컬 퀴즈: 나가기 확인(#exit-dialog)을 연다 (FR-3.6). 「계속 풀기」면 판이 그대로 이어진다
  quiz: 'quiz-exit',
  // 온라인 퀴즈·로비: 그 화면의 나가기·홈 버튼이 가진 확인과 정리를 그대로 탄다
  'online-quiz': 'online-quiz-exit',
  online: 'online-home',
  // 결과: 「홈으로」가 아직 남기지 않은 기록을 자동 저장한 뒤 홈으로 간다 (FR-6.1)
  result: 'result-home',
  // 중간에 나온 판의 «푼 문제» (N04): 나가기와 같은 곳(방에서 연 판이면 대기실)으로 간다. 저장하지 않는다
  'quiz-review': 'quiz-review-leave',
};

export function backStepFor(
  screen: ScreenName,
  { dialogOpen, landedOnGuard }: { dialogOpen: boolean; landedOnGuard: boolean },
): BackStep {
  if (dialogOpen) return { kind: 'close-dialog' };
  if (screen === 'home') return landedOnGuard ? { kind: 'stay' } : { kind: 'leave' };
  // 대기실의 «뒤로»는 방을 떠나는 것이 아니다. 방을 떠나는 길은 「나가기」 하나뿐이고,
  // 홈이나 로비로 가도 방에는 남아 「내가 있는 방」에서 다시 들어갈 수 있다
  if (screen === 'waiting') return { kind: 'lobby' };
  const id = BACK_CONTROLS[screen];
  return id ? { kind: 'control', id } : { kind: 'home' };
}

/** 지금 열려 있는 인페이지 대화상자. 없으면 null */
export function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.dialog-backdrop:not([hidden])');
}

/**
 * 대화상자를 닫는다. **각 대화상자가 가진 `Esc` 처리를 그대로 탄다** — 모든 대화상자는
 * `Esc` 로 닫히고 열었던 자리로 포커스를 돌려준다는 계약이 있어, 닫는 길을 따로 두지 않는다.
 */
export function closeDialog(dialog: HTMLElement): void {
  const target = dialog.querySelector<HTMLElement>('.dialog') ?? dialog;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

/** 그 화면의 버튼을 누른다. 없거나 꺼져 있으면 아무것도 하지 않고 false */
export function pressControl(id: string): boolean {
  const control = maybe<HTMLButtonElement>(id);
  if (!control || control.disabled || control.hidden) return false;
  control.click();
  return true;
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // 오래된 브라우저는 returnValue 가 있어야 묻는다. 묻는 문구는 브라우저가 정한다
  event.returnValue = '';
}

let unloadWarning = false;

/**
 * 새로고침·탭 닫기 전에 한 번 묻는다. **로컬 판이 진행 중일 때만 켠다** — 판은 메모리에만
 * 있어 새로고침하면 통째로 사라지고 기록도 남지 않는다 (FR-3.6). 다른 화면에서 켜 두면
 * 지킬 것이 없는데 묻게 되고, 일부 브라우저는 이 리스너가 있는 동안 뒤로/앞으로 캐시를 쓰지 않는다.
 *
 * 결과 화면은 묻지 않는다 — 떠나는 순간 기록을 자동 저장하므로 잃을 것이 없다.
 */
export function setUnloadWarning(on: boolean): void {
  if (on === unloadWarning) return;
  unloadWarning = on;
  if (on) window.addEventListener('beforeunload', warnBeforeUnload);
  else window.removeEventListener('beforeunload', warnBeforeUnload);
}
