// 「게임 방법」 대화상자 (U01)
//
// 홈의 `?`(#open-rules)가 연다. 처음 온 사람이 **판을 열기 전에** 몇 문제인지, 몇 초인지, 속도 점수가
// 없다는 것, 무엇이 답이 되는지, 기록이 어디에 남는지를 읽게 한다. 퀴즈의 `?`(조작법)는 판이 도는
// 동안 열려 그 시간도 흐른다(FR-3.12 일시정지 없음) — 여기서는 아무 시간도 흐르지 않는다.
// 시작 시트·카운트다운·코치마크는 두지 않는다. 판마다 행동이 하나 늘어난다 (design-system §1).
//
// 용어 목록은 **혼자 하기** 규칙이고, 온라인은 아래 한 줄로 따로 말한다 (local-ux-1). 그 줄은 세션을 열 때
// 서버가 알려 준 규칙(`getOnlineRules`)을 따른다 — 지금 API는 답하기가 혼자 하기와 같고(U13) 방장 혼자서도
// 열며, 이전 API는 «서 있기만 해서는 제출되지 않아요»다. 아직 묻지 않았으면 어느 쪽이든 맞는 말만 한다.
//
// 숫자는 `round-rules.ts` 가 상수에서 만든다. 문항 시간은 **열 때마다** 지금 고른 값으로 다시 쓴다 —
// 설정에서 40초로 바꾸고 다시 열면 40초라고 말해야 한다.
//
// 인페이지 대화상자 계약(CLAUDE.md «모달 금지»)은 설정 대화상자와 같다. 패널에 먼저 포커스를 두고,
// Tab 은 안에서 맴돌고, Esc 로 닫히며, 닫으면 연 자리로 돌려준다. 키는 문서의 캡처 단계에서 받아
// 전파를 멈춘다 — 홈 워커와 화면 쪽 키가 뒤에서 움직이지 않는다. 워커는 `isBlocked` 로 이미 멈춘다.

import { need, needOne } from '../dom.js';
import type { OnlineRules } from '../online/adapter.js';
import { trapFocus } from './quiz.js';
import { RECORD_RULE, answerRule, onlineRule, roundLengthRule, scoreRule, timeRule } from './round-rules.js';

export interface RulesDialogDeps {
  /** 새로 여는 로컬 판의 문항 시간 (FR-3.7). null 이면 제한 없음 */
  getTimeLimit: () => number | null;
  /** 세션을 열 때 서버가 알려 준 온라인 규칙. 묻기 전이면 null. 넘기지 않으면 이전 API의 규칙이다 */
  getOnlineRules?: () => OnlineRules | null;
}

export interface RulesDialog {
  /** 화면을 옮길 때 접는다 (app.ts 의 goTo). 포커스는 새 화면 것이다 */
  dismiss(): void;
}

export function createRulesDialog({ getTimeLimit, getOnlineRules }: RulesDialogDeps): RulesDialog {
  const el = {
    opener: need<HTMLButtonElement>('open-rules'),
    dialog: need('rules-dialog'),
    panel: needOne<HTMLElement>('#rules-dialog [role="dialog"]'),
    close: need<HTMLButtonElement>('rules-close'),
    length: need('rules-length'),
    time: need('rules-time'),
    score: need('rules-score'),
    answer: need('rules-answer'),
    record: need('rules-record'),
    online: need('rules-online'),
  };

  /** 대화상자를 연 자리. 닫을 때 포커스를 돌려준다 */
  let opener: HTMLElement | null = null;

  function render(): void {
    const limitMs = getTimeLimit();
    el.length.textContent = roundLengthRule();
    el.time.textContent = timeRule(limitMs);
    el.score.textContent = scoreRule();
    el.answer.textContent = answerRule(limitMs);
    el.record.textContent = RECORD_RULE;
    el.online.textContent = getOnlineRules ? onlineRule(getOnlineRules()) : onlineRule();
  }

  function open(): void {
    if (!el.dialog.hidden) return;
    render();
    // 걸어가서 눌렀으면(워커는 걷기 시작할 때 포커스를 놓는다) 포커스가 body 에 있다.
    // 그때는 이 버튼으로 돌아온다 — 설정 대화상자와 같다
    const active = document.activeElement as HTMLElement | null;
    opener = active && active !== document.body ? active : el.opener;
    el.dialog.hidden = false;
    // 200% 확대에서는 대화상자가 화면보다 길다. 제목부터 보이게 패널에 먼저 포커스를 둔다
    el.dialog.scrollTop = 0;
    el.panel.focus({ preventScroll: true });
  }

  function close(): void {
    if (el.dialog.hidden) return;
    el.dialog.hidden = true;
    const back = opener;
    opener = null;
    (back?.isConnected ? back : el.opener).focus();
  }

  el.opener.addEventListener('click', open);
  el.close.addEventListener('click', close);

  // 캡처 단계에서 받아 화면 쪽으로 넘기지 않는다 (settings-dialog.ts 와 같은 이유). 기본 동작
  // (포커스된 버튼 누르기, Tab 이동)은 막지 않고, 길게 누른 Enter·Space 의 반복만 막는다
  document.addEventListener('keydown', (event) => {
    if (el.dialog.hidden) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      trapFocus(el.dialog, event);
    } else if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
    }
  }, true);

  render();

  return {
    dismiss() {
      el.dialog.hidden = true;
      opener = null;
    },
  };
}
