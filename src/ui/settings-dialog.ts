// 설정 대화상자 (FR-3.7, FR-4.5 / U42·U54·U55)
//
// 앱 바의 「설정」이 연다. 소리·문항 시간·움직임 줄이기를 한 자리에 모은다 — 상시 HUD 를
// 늘리지 않으려고 예전 소리 버튼 자리 하나를 그대로 쓴다.
//
// **고르는 순간 적용하고 저장한다.** 따로 「저장」을 누르지 않는다. 저장과 적용은 app.ts 가
// 콜백으로 맡는다 — ui/ 는 저장소를 모른다.
//
// 인페이지 대화상자 계약(CLAUDE.md «모달 금지»)을 따른다. Tab 은 안에서 맴돌고, Esc 로 닫히며,
// 닫으면 연 자리로 포커스를 돌려준다. 열려 있는 동안 워커는 키를 받지 않는다 — `walker.ts` 의
// `isBlocked` 가 `.dialog-backdrop:not([hidden])` 을 본다.
//
// 모든 설정은 «누르면 바뀌는 버튼»이다. `select` 는 캐릭터가 밟아도 목록이 열리지 않는다.

import { TIME_LIMIT_CHOICES, TIME_LIMIT_MS } from '../constants.js';
import { all, need, needOne } from '../dom.js';
import { trapFocus } from './quiz.js';
import type { Settings, TimeLimitChoice } from '../types.js';

/** 이 대화상자가 다루는 설정. 캐릭터는 「내 캐릭터」 화면이 맡는다 */
export type DialogSettings = Pick<Settings, 'soundEnabled' | 'timeLimitMs' | 'reduceMotion'>;

export interface SettingsDialogDeps {
  /** 바뀐 값 하나. 적용(소리·움직임)과 저장은 app.ts 가 한다 */
  onChange: (patch: Partial<DialogSettings>) => void;
  /**
   * 사용자가 닫은 직후. **참을 돌려주면 포커스를 이미 옮겼다는 뜻**이라 연 자리로 돌려주지 않는다 —
   * 대화상자 뒤에서 퀴즈 시간이 끝났으면 「다음 문제」로 이어 가야 한다 (quiz.ts 의 resumeAfterDialog).
   */
  onClose?: () => boolean;
}

export interface SettingsDialog {
  /** 저장된 값을 화면에 얹는다. **onChange 를 부르지 않는다** */
  set(values: DialogSettings): void;

  /**
   * 화면을 옮길 때 접는다 (app.ts 의 goTo). 포커스는 새 화면이 갖고 onClose 도 부르지 않는다 —
   * 대기실에서 열어 둔 채 매치가 시작되면 새 화면 위에 남아 포커스를 가두면 안 된다.
   */
  dismiss(): void;
}

/** `data-time-limit` 의 글. 제한 없음은 'none' 이다 */
function attrOf(choice: TimeLimitChoice): string {
  return choice === null ? 'none' : String(choice);
}

/** 버튼의 `data-time-limit` → 설정 값. 목록에 없으면 undefined (null 은 «제한 없음»이라는 값이다) */
export function timeLimitFromAttr(raw: string | undefined): TimeLimitChoice | undefined {
  return TIME_LIMIT_CHOICES.find((choice) => attrOf(choice) === raw);
}

/**
 * 움직임 줄이기 (U55). `css/voxel-theme.css` 가 이 표시에 prefers-reduced-motion 과 **같은 규칙**을
 * 건다 — 화면 애니메이션·전환과 캐릭터의 제자리 뛰기·걷기 튐이 함께 멈춘다. 기기 설정은 이것과
 * 따로 늘 따른다(끄더라도 기기가 줄이라고 하면 줄인다).
 */
export function applyMotionPreference(reduce: boolean): void {
  const root = document.documentElement;
  if (reduce) root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
}

export function createSettingsDialog({ onChange, onClose }: SettingsDialogDeps): SettingsDialog {
  const el = {
    opener: need<HTMLButtonElement>('open-settings'),
    dialog: need('settings-dialog'),
    panel: needOne<HTMLElement>('#settings-dialog [role="dialog"]'),
    close: need<HTMLButtonElement>('settings-close'),
    sound: need<HTMLButtonElement>('setting-sound'),
    soundIcon: need('setting-sound-icon'),
    soundState: need('setting-sound-state'),
    motion: need<HTMLButtonElement>('setting-motion'),
    motionState: need('setting-motion-state'),
    times: all<HTMLButtonElement>('#settings-dialog [data-time-limit]'),
  };

  let values: DialogSettings = { soundEnabled: true, timeLimitMs: TIME_LIMIT_MS, reduceMotion: false };
  /** 대화상자를 연 자리. 닫을 때 포커스를 돌려준다 */
  let opener: HTMLElement | null = null;

  /**
   * 이름은 바꾸지 않는다 (U54). «소리»·«움직임 줄이기»가 버튼 이름이고 켜짐/꺼짐은 `aria-pressed`
   * 가 낭독한다. 이름까지 «소리 꺼짐»으로 바꾸면 «소리 꺼짐, 눌리지 않음»처럼 부정이 겹쳐 읽힌다.
   * 눈으로 보는 켜짐/꺼짐 글과 아이콘은 `aria-hidden` 이다.
   */
  function render(): void {
    el.sound.setAttribute('aria-pressed', String(values.soundEnabled));
    el.soundIcon.dataset.icon = values.soundEnabled ? 'sound-on' : 'sound-off';
    el.soundState.textContent = values.soundEnabled ? '켜짐' : '꺼짐';
    el.motion.setAttribute('aria-pressed', String(values.reduceMotion));
    el.motionState.textContent = values.reduceMotion ? '켜짐' : '꺼짐';
    // 셋 가운데 하나만 눌려 있다. 고른 칸은 ✓ 와 들린 흰 칸으로도 보인다 (디자인 층)
    for (const button of el.times) {
      button.setAttribute('aria-pressed', String(timeLimitFromAttr(button.dataset.timeLimit) === values.timeLimitMs));
    }
  }

  function change(patch: Partial<DialogSettings>): void {
    values = { ...values, ...patch };
    render();
    onChange(patch);
  }

  function open(): void {
    if (!el.dialog.hidden) return;
    // 걸어가서 눌렀으면(워커는 걷기 시작할 때 포커스를 놓는다) 포커스가 body 에 있다.
    // 그때는 이 버튼으로 돌아온다 — 키보드로 이어 쓰는 사람이 자리를 잃지 않게
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
    if (onClose?.()) return;
    (back?.isConnected ? back : el.opener).focus();
  }

  el.opener.addEventListener('click', open);
  el.close.addEventListener('click', close);
  el.sound.addEventListener('click', () => change({ soundEnabled: !values.soundEnabled }));
  el.motion.addEventListener('click', () => change({ reduceMotion: !values.reduceMotion }));
  for (const button of el.times) {
    button.addEventListener('click', () => {
      const choice = timeLimitFromAttr(button.dataset.timeLimit);
      if (choice === undefined || choice === values.timeLimitMs) return;
      change({ timeLimitMs: choice });
    });
  }

  /**
   * **캡처 단계에서 받아 화면 쪽으로 넘기지 않는다.** 이 대화상자는 어느 화면에서나 열린다.
   * 로비·내 캐릭터의 `Esc`(«뒤로»), 퀴즈의 숫자키(답 제출), 대기실의 `/`(채팅)가 뒤에서 함께
   * 움직이면 갇혀 있어야 할 조작이 밖으로 샌다. 기본 동작(포커스된 버튼 누르기, Tab 이동)은
   * 막지 않는다 — 전파만 멈춘다.
   */
  document.addEventListener('keydown', (event) => {
    if (el.dialog.hidden) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      trapFocus(el.dialog, event);
    } else if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      // 누르고 있는 키의 자동 반복으로 토글이 켜졌다 꺼졌다 되풀이되지 않게 한다 (FR-4.4 와 같은 규칙)
      event.preventDefault();
    }
  }, true);

  return {
    set(next) {
      values = { ...next };
      render();
    },

    dismiss() {
      el.dialog.hidden = true;
      opener = null;
    },
  };
}
