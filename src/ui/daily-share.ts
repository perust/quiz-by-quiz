// 오늘의 퀴즈 결과 공유의 입구·효과·대화상자 (daily share). 글은 `core/daily-share.ts` 가 만들고 여기는 보내기만 한다.
//
// - **누른 그 클릭 안에서** 부른다. Web Share 가 있으면 앞에서 아무것도 기다리지 않고 `navigator.share` 를,
//   없으면 같은 클릭에서 클립보드를 부른다 — 브라우저는 사용자의 누름(활성화) 안에서만 공유 창을 연다.
// - 공유 창이 답한 것은 «글을 넘겼다»일 뿐 게시가 아니다. 그렇게만 말한다.
// - 공유 창을 닫은 것(`AbortError`)은 취소다. 실패·성공을 말하지 않고 클립보드로 내려가지도 않는다.
//   그 밖의 공유 실패만 클립보드로 내려간다(대기실 초대 링크와 같은 길). 클립보드는 끝난 뒤에만 «복사했어요».
// - 복사가 되든 안 되든 「공유 글 보기」(읽기 전용 글 칸의 대화상자)로 직접 골라 복사할 수 있다. 골라 둔 것만으로
//   복사했다고 하지 않는다.
// - 한 번에 하나만 보낸다(`inflight`). 화면을 떠나거나 다른 결과를 그리면 세대(`epoch`)가 바뀌어 늦게 온 답은
//   아무 말도 남기지 않고, 떠난 화면의 실패로 복사하지도 않는다.
// - 기록·저장소·랭킹·온라인을 모른다. 상태 줄은 처음부터 보이는 라이브 리전이다(숨긴 채로 채우지 않는다).
//
// 대화상자 계약(CLAUDE.md «모달 금지»)은 「게임 방법」과 같다 — 캡처 단계 키·Tab 가두기·Esc·연 자리로 돌려주기,
// 화면을 떠나면 조용히 접기(`hide`).

import { need } from '../dom.js';
import { trapFocus } from './accessibility.js';

/** 상태 줄의 말. 공유 창이 답했다 — 게시가 아니라 공유 창에 넘긴 것이다 */
export const DAILY_SHARE_HANDED_OFF = '공유 창에 결과를 넘겼어요.';
export const DAILY_SHARE_COPIED = '결과를 복사했어요. 원하는 곳에 붙여 넣어 주세요.';
export const DAILY_SHARE_COPY_FAILED = '복사하지 못했어요. 「공유 글 보기」에서 직접 골라 복사해 주세요.';

export interface DailySharePanel {
  /** 끝낸 오늘의 퀴즈의 글이면 입구를 보이고, null 이면 거둔다. 앞 결과의 늦은 답은 버린다 */
  show(text: string | null): void;
  /** 화면을 떠난다. 대화상자를 조용히 접고 늦은 답을 버린다 */
  hide(): void;
}

/** 공유 창을 닫은 것인가 (취소) */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export function createDailySharePanel(): DailySharePanel {
  const el = {
    area: need('quiz-review-share'),
    share: need<HTMLButtonElement>('quiz-review-share-button'),
    openText: need<HTMLButtonElement>('quiz-review-share-text-open'),
    status: need('quiz-review-share-status'),
    dialog: need('daily-share-dialog'),
    text: need<HTMLTextAreaElement>('daily-share-text'),
    close: need<HTMLButtonElement>('daily-share-close'),
  };

  /** 지금 보이는 결과의 글. 없으면 입구가 없다 */
  let text: string | null = null;
  /** 보이는 결과의 세대. 다시 그리거나 떠나면 오른다 — 늦은 답이 새 화면을 덮지 않는다 */
  let epoch = 0;
  /** 공유·복사가 도는 중. 끝날 때까지 다시 누른 것은 받지 않는다(공유 창이 겹치지 않는다) */
  let inflight = false;
  /** 대화상자를 연 자리 */
  let opener: HTMLElement | null = null;

  function setStatus(message: string): void {
    el.status.textContent = message;
  }

  /** 도는 일 하나를 붙든다. 끝나면(늦게 끝나도) 다시 누를 수 있다 */
  function hold(pending: Promise<void>): void {
    inflight = true;
    el.share.setAttribute('aria-busy', 'true');
    void pending.finally(() => {
      inflight = false;
      el.share.removeAttribute('aria-busy');
    });
  }

  /** 클립보드에 쓴다. 끝난 뒤, 그 결과가 아직 보일 때만 말한다 */
  function copy(payload: string, token: number): Promise<void> {
    let pending: Promise<void>;
    try {
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      pending = clipboard.writeText(payload);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      () => { if (token === epoch) setStatus(DAILY_SHARE_COPIED); },
      () => { if (token === epoch) setStatus(DAILY_SHARE_COPY_FAILED); },
    );
  }

  function share(): void {
    const payload = text;
    if (payload === null || inflight) return;
    const token = epoch;
    setStatus('');
    if (typeof navigator.share !== 'function') {
      hold(copy(payload, token));
      return;
    }
    let pending: Promise<void>;
    try {
      // 이 앞에서 아무것도 기다리지 않는다 — 누름의 활성화 안에서 공유 창을 연다
      pending = navigator.share({ text: payload });
    } catch (error) {
      pending = Promise.reject(error);
    }
    hold(pending.then(
      () => { if (token === epoch) setStatus(DAILY_SHARE_HANDED_OFF); },
      (error: unknown) => {
        if (token !== epoch || isAbort(error)) return undefined;
        return copy(payload, token);
      },
    ));
  }

  function openText(): void {
    if (text === null || !el.dialog.hidden) return;
    // 걸어가서 눌렀으면 포커스가 body 에 있다. 그때는 이 버튼으로 돌아온다 (rules-dialog.ts 와 같다)
    const active = document.activeElement as HTMLElement | null;
    opener = active && active !== document.body ? active : el.openText;
    el.text.value = text;
    el.dialog.hidden = false;
    el.dialog.scrollTop = 0;
    fitText();
    el.text.focus({ preventScroll: true });
    el.text.select();
  }

  /**
   * 글 칸을 글 높이에 맞춘다. 320px 폭에서는 첫 줄(날짜)이 두 줄로 접혀 네 줄 칸 안에서 공식 주소가 잘렸다 —
   * 칸 안 스크롤로 숨기지 않고 다 보인다. 보인 뒤에 잰다(숨은 칸은 높이가 0 이다)
   */
  function fitText(): void {
    el.text.style.height = '';
    const frame = el.text.offsetHeight - el.text.clientHeight;
    const needed = el.text.scrollHeight + frame;
    if (Number.isFinite(needed) && needed > el.text.offsetHeight) el.text.style.height = `${needed}px`;
  }

  function closeText(): void {
    if (el.dialog.hidden) return;
    el.dialog.hidden = true;
    const back = opener;
    opener = null;
    (back?.isConnected ? back : el.openText).focus();
  }

  function dismiss(): void {
    el.dialog.hidden = true;
    opener = null;
  }

  el.share.addEventListener('click', share);
  el.openText.addEventListener('click', openText);
  el.close.addEventListener('click', closeText);

  // 캡처 단계에서 받아 화면 쪽(워커·«뒤로»)으로 넘기지 않는다. 기본 동작(버튼 누르기·Tab·글 고르기)은 막지 않고,
  // 길게 누른 Enter·Space 의 반복만 막는다
  document.addEventListener('keydown', (event) => {
    if (el.dialog.hidden) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeText();
    } else if (event.key === 'Tab') {
      trapFocus(el.dialog, event);
    } else if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
    }
  }, true);

  return {
    show(next) {
      epoch += 1;
      text = next;
      dismiss();
      setStatus('');
      el.text.value = next ?? '';
      el.area.hidden = next === null;
    },
    hide() {
      epoch += 1;
      text = null;
      dismiss();
      setStatus('');
      el.text.value = '';
      el.area.hidden = true;
    },
  };
}
