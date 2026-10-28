// 홈 화면 렌더링
// 카테고리 카드(FR-2.1), 최고 점수(FR-2.3), 전체 도전(FR-2.2), 내 캐릭터, 랭킹 입구.
//
// 분야 칸·전체 도전이 무엇을 여는지는 app.ts 가 정해 알린다(`setPlayMode`, FR-7.13 3단계) — 혼자 푸는 온라인
// 판, 이 기능을 모르는 이전 API의 혼자 하기(로컬), 서버에 닿지 않을 때의 연습(기록 안 남음). 이 화면은 그 말과
// 별 점수만 바꾸고 칸을 다시 만들지 않는다 — 캐릭터가 밟고 있는 칸·포커스가 그대로 남는다.
//
// 캐릭터가 이 화면을 걸어 다니며 메뉴를 고른다. 버튼은 그대로 눌러도 되므로
// 걷기와 직접 누르기는 항상 함께 제공되는 두 입력 경로다.

import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from '../constants.js';
import { need } from '../dom.js';
import { createWalker } from './walker.js';
import { shortHomeStartPoint } from './walker-geometry.js';
import { trapFocus } from './quiz.js';
import { paintCharacter } from './sprite.js';
import { allRoundLength, categoryDockCaption } from './round-rules.js';
import { onlineEntryCopy, SOLO_ONLINE_ENTRY } from '../online/rules.js';
import { soloRoomNoteText } from '../online/solo-play.js';
import { NICKNAME_PROBLEM_MESSAGES, nicknameProblem } from '../online/nickname-rules.js';
import type { Category, CategoryId, Question } from '../types.js';

/** app.ts가 넘겨주는 콜백 뭉치 */
export interface HomeScreenDeps {
  onSelectCategory: (categoryId: CategoryId) => void;
  onStartAll: () => void;
  onOpenRanking: () => void;
  onOpenCharacters: () => void;
  onOpenOnline: () => void;
  /**
   * 「아직 방에 있어요」 줄을 눌렀을 때. 그 방의 대기실로 간다 (U35). 혼자 푸는 온라인 판의 방(`solo`)이면
   * 대기실이 아니라 그 판으로 돌아간다
   */
  onReturnToRoom: (code: string, solo: boolean) => void;
  /** 연습 안내 줄(서버에 닿지 않는다)의 «다시 연결». 온라인을 다시 묻는다 (FR-7.13 3단계) */
  onRetryOnline: () => void;
  /** 닉네임을 바꿨을 때 */
  onNickname: (nickname: string) => void;
  /** 문제 은행 알림의 「다시 불러오기」 (U06). 페이지를 새로 읽어 문제를 다시 받는다 */
  onReload: () => void;
}

/** 홈에서 돌아갈 수 있는 방. 이름은 화면에 보이고 코드는 돌아갈 때 쓴다 */
export interface HomeRoomNote {
  code: string;
  name: string;
  /** 혼자 푸는 온라인 판의 방이면 «풀던 «과학» 판이 아직 진행 중이에요 · 이어 풀기»다 (FR-7.13 3단계) */
  solo?: boolean;
  /** 혼자 판의 이름(분야·전체 도전). 없으면 «풀던 혼자 판이 있어요»다 */
  label?: string;
}

/**
 * 분야 칸·전체 도전이 여는 것 (FR-7.13 3단계). `practice`면 연습(기록 안 남음)이라 별 점수가 없고 칸의 이름이
 * «연습하기»이며, `note`가 있으면 dock 맨 위 안내 줄이 까닭과 다시 할 일을 말한다(복귀 줄 자리를 쓴다). 연습이 아닌데
 * `note`가 있으면 잠시 띄우는 알림이다(요청 한도에 걸린 혼자 판·사라진 혼자 판, `data-kind="notice"`).
 * `online`·`local`·`checking`은 이름이 같다 — 기록이 어디에 남는지는 「게임 방법」과 결과 화면이 말한다
 */
export interface HomePlayView {
  practice: boolean;
  note: { text: string; action: string } | null;
  /** 홈의 분야 칸이 혼자 온라인 판을 여는가. 그러면 온라인 입구는 «친구와 함께»만 말한다 */
  soloOnline: boolean;
}

/**
 * bestScores는 카테고리 id와 'all' 키를 갖는다.
 *
 * 둘 다 «없을 수도 있는 키»로 적었다 — 코드가 이미 `bestScore === undefined`를
 * 검사하고 있어서, 다 채워져 있다고 적으면 그 검사가 죽은 코드처럼 보인다.
 */
export interface HomeView {
  categories: Category[];
  banks: Partial<Record<CategoryId, Question[]>>;
  bestScores: Partial<Record<CategoryId | 'all', number | null>>;
  allCount: number;
  characterId: string;
  nickname: string;
}

export interface HomeScreen {
  render(view: HomeView): void;

  /** 홈을 떠날 때. 캐릭터가 다른 화면에서 계속 뛰지 않게 한다 */
  hide(): void;

  /**
   * 문제 은행 오류·문항 부족 알림. 문구가 없으면 숨긴다. 보이는 동안 캐릭터와 조작부를 거두고,
   * 알림의 「닫기」가 이것을 null 로 불러 다시 켠다 (U06)
   */
  setNote(message: string | null | undefined): void;

  /**
   * 온라인 입구의 바쁨 표시 (U34). 로비는 목록을 받아 그린 뒤에야 열리므로 그동안
   * 「연결 중…」을 보이고, 다시 눌러도 요청을 겹쳐 보내지 않는다.
   */
  setOnlineBusy(busy: boolean): void;

  /**
   * 온라인 입구 보조 줄이 말할 시작 인원. 세션을 연 뒤에야 안다 — 묻기 전(null)에는 어느 API든 맞는
   * 말(«방을 만들거나 참가해요»)이고, 방장 혼자서도 여는 API면 «혼자서도 · 친구와 함께», 둘부터인 이전
   * API면 «친구와 함께 · 2명부터»다. 버튼 이름도 같이 바꾼다. 바쁨 표시 중이면 거둘 때 쓴다.
   */
  setOnlineMinPlayers(minPlayers: number | null): void;

  /** 아직 들어가 있는 방이 있으면 dock 맨 위에 복귀 줄을 띄운다. null 이면 거둔다 (U35) */
  setRoomNote(room: HomeRoomNote | null): void;

  /** 분야 칸이 여는 것과 연습 안내 줄 (FR-7.13 3단계). 칸을 다시 만들지 않고 이름·캡션·줄만 고친다 */
  setPlayMode(view: HomePlayView): void;

  /**
   * 별 점수만 바꾼다 (FR-2.3). 서버의 내 최고 기록은 홈을 그린 뒤에 오므로 칸을 다시 만들지 않는다 —
   * 캐릭터가 밟고 있는 칸·포커스가 그대로다
   */
  setBestScores(bestScores: HomeView['bestScores']): void;

  /** 혼자 판을 여는 중 (FR-7.13 3단계). 캡션이 «연결 중…»이고 그동안 누른 칸은 겹쳐 보내지 않는다 */
  setPlayBusy(busy: boolean): void;

  /** 「혼자 연습하기」로 왔을 때. 분야 dock의 첫 칸에 포커스를 둔다 (U29) */
  focusPractice(): void;
}

/** 320px의 다섯 칸 dock에서도 서로 붙지 않는 시각용 짧은 이름. 접근 가능한 이름은 전체 이름을 쓴다. */
const COMPACT_CATEGORY_NAMES: Partial<Record<CategoryId, string>> = {
  general: '상식',
  art: '예술',
};

/** 분야 칸의 이름. 문제를 못 받은 칸은 왜 잠겼는지, 연습이면 기록이 남지 않는다는 것을 이름이 말한다 */
export function categoryCardLabel(
  category: Pick<Category, 'name'>,
  { count, bestScore, practice }: { count: number; bestScore: number | null | undefined; practice: boolean },
): string {
  if (count === 0) return `${category.name} 문제 풀기, 불러오지 못함`;
  if (practice) return `${category.name} 연습하기, 기록 안 남음`;
  return bestScore === null || bestScore === undefined
    ? `${category.name} 문제 풀기`
    : `${category.name} 문제 풀기, 최고 ${bestScore}점`;
}

/** 분야 dock 캡션. 연습이면 그렇다고 앞에서 말한다 */
export function homeDockCaption(practice: boolean): string {
  return practice ? `연습 · ${categoryDockCaption()} · 기록 안 남음` : categoryDockCaption();
}

export function createHomeScreen({
  onSelectCategory, onStartAll, onOpenRanking, onOpenCharacters, onOpenOnline, onReturnToRoom,
  onRetryOnline, onNickname, onReload,
}: HomeScreenDeps): HomeScreen {
  const el = {
    stage: need('home-stage'),
    quests: need('home-quests'),
    caption: need('category-caption'),
    grid: need('category-grid'),
    startAll: need<HTMLButtonElement>('start-all'),
    startAllMeta: need('start-all-meta'),
    openRanking: need<HTMLButtonElement>('open-ranking'),
    openCharacters: need<HTMLButtonElement>('open-characters'),
    openOnline: need<HTMLButtonElement>('open-online'),
    openOnlineDesc: need('open-online-desc'),
    roomNote: need<HTMLButtonElement>('home-room-note'),
    roomNoteText: need('home-room-note-text'),
    roomNoteAction: need('home-room-note-action'),
    nicknameCard: need<HTMLButtonElement>('open-nickname'),
    nicknameValue: need('nickname-value'),
    dialog: need('nickname-dialog'),
    dialogForm: need<HTMLFormElement>('nickname-form'),
    dialogInput: need<HTMLInputElement>('nickname-edit'),
    dialogMessage: need('nickname-message'),
    dialogCancel: need<HTMLButtonElement>('nickname-cancel'),
    walker: need('home-character'),
    title: need('home-title'),
    note: need('home-note'),
    noteText: need('home-note-text'),
    noteReload: need<HTMLButtonElement>('home-note-reload'),
    noteClose: need<HTMLButtonElement>('home-note-close'),
  };

  // 한 판의 길이를 시작 전에 말한다 (U04). 상수에서 오는 글이다 — 은행 크기는 쓰지 않는다. 연습이면
  // `setPlayMode`가 앞에 말을 붙인다(`homeDockCaption`)
  el.caption.textContent = categoryDockCaption();

  // 하단 dock은 최고 기록 유무·번역 길이에 따라 높이가 달라진다. 고정 조작부가 그 높이를
  // 추측하지 않고 실제 값을 따라가게 해, 저장 기록이 생긴 뒤에도 버튼을 덮지 않는다.
  // 숨은 화면(높이 0)에서는 맞추지 않는다 — 다시 보일 때 맞춘다
  const syncDockHeight = (): void => {
    const height = Math.ceil(el.quests.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty('--home-dock-h', `${height}px`);
  };
  // 화면 크기·글꼴로 바뀌는 높이는 ResizeObserver가 알린다. 다만 그것은 다음 프레임을 그리기 직전에야 오고,
  // 숨은 탭에서는 오지 않는다 — 그동안 조작부·두 입구는 낡은 높이(처음에는 대체값 148px)에 서서 자동 점검에서
  // 선택 원이 「게임 방법」을, 스틱이 dock을 덮었다 (layout-01). 그래서 dock 안의 DOM이 바뀌거나(방 복귀 줄·
  // 전체 도전 표식·분야 칸·바쁨 글) 홈이 다시 보일 때는 MutationObserver가 그 틱 안에서 맞춘다. 워커가
  // 첫 자리를 재는 rAF(입구 줄 위)도 그 뒤라 맞춘 값을 본다. 워커의 is-standing 같은 class는 보지 않는다
  const dockObserver = new ResizeObserver(syncDockHeight);
  dockObserver.observe(el.quests);
  const dockMutations = new MutationObserver(syncDockHeight);
  dockMutations.observe(el.quests, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'],
  });
  const homeSection = el.stage.closest<HTMLElement>('[data-screen]');
  if (homeSection) dockMutations.observe(homeSection, { attributes: true, attributeFilter: ['hidden'] });
  requestAnimationFrame(syncDockHeight);

  // 화면 전체를 걸어 다닌다. 칸 목록을 따로 만들지 않고 발밑에 실제로 무엇이
  // 있는지 그때그때 보므로, 카드를 더하거나 빼도 여기를 고칠 일이 없다.
  // 고르는 것도 워커가 그 자리를 진짜로 누르는 것이라, 버튼에 달린 리스너가
  // 마우스로 눌렀을 때와 똑같이 움직인다 — 아래 세 줄이 그대로 쓰인다.
  // 선택점은 넘기지 않는다 — 워커의 기본(몸통 가운데)이 모든 화면의 규칙이다 (U10)
  const walker = createWalker({
    character: el.walker,
    // 공용 조작부의 모양은 다른 화면과 같고, 하단 dock을 피하는 배치만 선언한다.
    controls: { placement: 'home-dock' },
    // 처음에는 「내 캐릭터」 입구 바로 아래의 월드 바닥에 선다.
    // HUD 글자를 덮지 않으면서도 한 번 위로 걸으면 바로 입구를 고를 수 있다.
    startAt: () => {
      // 200% 확대나 가로 화면에서는 두 보조 입구가 dock 위 양쪽으로 이동한다.
      // 그때는 가운데 위의 빈 하늘에서 시작해 어느 입구도 가리지 않는다.
      // 짧은 가로 화면(U07)은 접었던 브랜드를 위 가운데에 되살리므로 그 아래에 선다.
      // 브랜드가 접혀 있으면 머리말이 1px 칸이라 제목의 폭도 1px 이하다
      if (window.innerHeight <= 700) {
        const brand = el.title.getBoundingClientRect();
        return shortHomeStartPoint({
          viewportWidth: window.innerWidth,
          walkerHeight: el.walker.offsetHeight,
          entryTop: el.openRanking.getBoundingClientRect().top,
          brandBottom: brand.width > 1 ? brand.bottom : null,
        });
      }
      const box = el.openCharacters.getBoundingClientRect();
      if (box.width === 0) return null;
      return {
        x: box.left + box.width / 2,
        y: box.bottom + el.walker.offsetHeight + 6,
      };
    },
  });
  let noteVisible = false;
  /** 로비를 불러오는 중인가. 그동안의 클릭은 같은 요청을 겹쳐 보낼 뿐이다 */
  let onlineBusy = false;
  // 쉬는 상태의 이름과 보조 줄. HTML 은 서버에 묻기 전의 말이고, 세션이 알려 준 시작 인원으로 바뀐다.
  // 바쁨 표시를 거둘 때 이것으로 되돌린다
  let onlineEntry = onlineEntryCopy(null);
  /** 복귀 줄이 가리키는 방. 혼자 판의 방이면 대기실이 아니라 그 판으로 돌아간다 */
  let roomNote: HomeRoomNote | null = null;
  /** 분야 칸이 여는 것 (FR-7.13 3단계). 처음에는 아직 모른다 — 이름은 온라인·로컬과 같다 */
  let play: HomePlayView = { practice: false, note: null, soloOnline: false };
  /** 혼자 판을 여는 중이다. 그동안 누른 칸은 겹쳐 보내지 않는다 */
  let playBusy = false;
  /** 마지막으로 그린 칸들과 그 점수. 별 점수·이름은 이것을 제자리에서 고친다 */
  const cards = new Map<CategoryId, { card: HTMLButtonElement; category: Category; count: number }>();
  let bestScores: HomeView['bestScores'] = {};
  let allCount = 0;

  el.startAll.addEventListener('click', () => {
    if (playBusy) return;
    onStartAll();
  });

  /**
   * 온라인 입구가 지금 말할 것. 분야 칸이 혼자 온라인 판을 열면(FR-7.13 3단계) 입구는 친구와 함께 푸는 곳이라
   * 시작 인원을 말하지 않는다. 아니면 세션이 알려 준 시작 인원의 말이다(`onlineEntryCopy`)
   */
  function shownOnlineEntry(): { desc: string; label: string } {
    return play.soloOnline ? SOLO_ONLINE_ENTRY : onlineEntry;
  }

  function showOnlineEntry(): void {
    const entry = shownOnlineEntry();
    el.openOnlineDesc.textContent = entry.desc;
    el.openOnline.setAttribute('aria-label', entry.label);
  }
  el.openRanking.addEventListener('click', () => onOpenRanking());
  el.openCharacters.addEventListener('click', () => onOpenCharacters());
  el.openOnline.addEventListener('click', () => {
    if (onlineBusy) return;
    onOpenOnline();
  });
  el.roomNote.addEventListener('click', () => {
    // 다시 묻는 중이면 겹쳐 보내지 않는다 (줄이 «연결 중…»을 말하고 있다)
    if (playBusy) return;
    // 연습 안내·알림이 그 자리를 쓰는 동안은 «다시 연결»·«다시 시도»·«확인»이다 — 무엇을 할지는 app.ts가 안다
    if (play.note) {
      onRetryOnline();
      return;
    }
    if (roomNote) onReturnToRoom(roomNote.code, roomNote.solo === true);
  });

  /** 분야 dock에서 처음 누를 수 있는 칸 (없으면 전체 도전) */
  function focusFirstPlayable(): void {
    const first = el.grid.querySelector<HTMLButtonElement>('.category-card:not(:disabled)');
    (first ?? el.startAll).focus({ preventScroll: true });
  }

  /**
   * dock 맨 위 한 줄 (U35·FR-7.13 3단계). 연습 안내·알림이 있으면 그것이 먼저다 — 서버에 닿지 않는 동안에는 돌아갈 방을
   * 물을 수도 없다. 한 자리를 나눠 써서 짧은 화면의 dock 높이 계약(복귀 줄 자리)이 그대로다.
   *
   * 다시 묻는 동안(`playBusy`)은 그 줄의 행동 글이 «연결 중…»이고 `aria-busy`다 — 누른 줄 자신이 상태를 말한다.
   * **누른 줄이 사라지면 포커스를 분야 dock으로 옮긴다** — «다시 연결»이 통하거나 «확인»으로 거두면 그 버튼이 숨어
   * 포커스가 <body>로 떨어졌다. 캐릭터가 밟아 누른 것이면 포커스가 줄에 없으니 옮기지 않는다(다음 Enter는 발밑이다)
   */
  function renderDockNote(): void {
    const hadFocus = document.activeElement === el.roomNote;
    const note = play.note;
    el.roomNote.dataset.kind = note ? (play.practice ? 'practice' : 'notice') : 'room';
    if (note) {
      el.roomNoteText.textContent = note.text;
      el.roomNoteAction.textContent = playBusy ? '연결 중…' : note.action;
      if (playBusy) el.roomNote.setAttribute('aria-busy', 'true');
      else el.roomNote.removeAttribute('aria-busy');
      el.roomNote.hidden = false;
      return;
    }
    el.roomNote.removeAttribute('aria-busy');
    el.roomNoteText.textContent = roomNote
      ? (roomNote.solo ? soloRoomNoteText(roomNote.label) : `「${roomNote.name}」 방에 아직 있어요`)
      : '';
    el.roomNoteAction.textContent = roomNote?.solo ? '이어 풀기' : '돌아가기';
    el.roomNote.hidden = !roomNote;
    if (hadFocus && el.roomNote.hidden) focusFirstPlayable();
  }

  // ── 문제 은행 알림 (U06) ───────────────────────────────────────
  // 보이는 동안은 캐릭터와 조작부가 꺼져 있다(알림을 덮지 않게). 예전에는 닫을 길이 없어 분야
  // 하나만 못 받아도 세션 내내 홈에서 걸을 수 없었다. 닫으면 다시 걷고, 다시 불러오기는 새로 읽는다
  el.noteReload.addEventListener('click', () => onReload());
  el.noteClose.addEventListener('click', () => {
    const hadFocus = el.note.contains(document.activeElement);
    setNote(null);
    // 누른 버튼이 사라졌다. 포커스가 <body> 로 떨어지지 않게 홈 화면에 둔다 — 버튼이 아니라
    // 화면이라 다음 방향키·Enter 는 캐릭터가 받는다(워커가 비켜나지 않는다)
    const screen = el.stage.closest<HTMLElement>('[data-screen]');
    if (hadFocus) screen?.focus({ preventScroll: true });
  });

  function setNote(message: string | null | undefined): void {
    noteVisible = Boolean(message);
    // 먼저 펼치고 넣는다 — 숨긴 채로 채운 role="alert" 는 낭독되지 않는다
    el.note.hidden = !noteVisible;
    el.noteText.textContent = message ?? '';

    if (noteVisible) {
      walker.setEnabled(false);
    } else {
      const screen = el.stage.closest<HTMLElement>('[data-screen]');
      if (screen && !screen.hidden) walker.setEnabled(true);
    }
  }

  // ── 닉네임 바꾸기 ──────────────────────────────────────────────
  // window.prompt 대신 페이지 안 다이얼로그를 쓴다. 열려 있는 동안에는
  // 워커가 키를 받지 않으므로(isBlocked) 캐릭터가 뒤에서 걸어 다니지 않는다.

  /** 다이얼로그를 연 자리. 닫을 때 포커스를 되돌린다 */
  let nickname = '';

  function closeNicknameDialog(): void {
    if (el.dialog.hidden) return;
    el.dialog.hidden = true;
    el.dialogMessage.hidden = true;
    el.nicknameCard.focus();
  }

  el.nicknameCard.addEventListener('click', () => {
    el.dialogInput.value = nickname;
    el.dialogMessage.hidden = true;
    el.dialog.hidden = false;
    el.dialogInput.focus();
    el.dialogInput.select();
  });

  el.dialogCancel.addEventListener('click', closeNicknameDialog);

  el.dialogForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const wanted = el.dialogInput.value.trim();
    if (wanted.length < NICKNAME_MIN_LENGTH || wanted.length > NICKNAME_MAX_LENGTH) {
      el.dialogMessage.hidden = false;
      el.dialogMessage.textContent =
        `닉네임은 ${NICKNAME_MIN_LENGTH}~${NICKNAME_MAX_LENGTH}자로 적어주세요.`;
      el.dialogInput.focus();
      return;
    }
    // 온라인 랭킹은 모두에게 보인다 (PRD 12.1). 서버가 거절할 이름을 보내기 전에 같은 규칙·같은 말로
    // 막는다(online/nickname-rules.ts — 서버의 nickname_filter.py와 같은 값이다). 같은 이름은 막지 않는다.
    // role=status 문단은 먼저 펼치고 넣는다(«숨긴 채로 채우면 낭독되지 않는다»)
    const problem = nicknameProblem(wanted);
    if (problem !== null) {
      el.dialogMessage.hidden = false;
      el.dialogMessage.textContent = NICKNAME_PROBLEM_MESSAGES[problem];
      el.dialogInput.focus();
      return;
    }
    nickname = wanted;
    el.nicknameValue.textContent = nickname;
    closeNicknameDialog();
    onNickname(nickname);
  });

  document.addEventListener('keydown', (event) => {
    if (el.dialog.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNicknameDialog();
    } else if (event.key === 'Tab') {
      trapFocus(el.dialog, event);
    }
  });

  document.addEventListener('keydown', (event) => {
    const screen = el.stage.closest<HTMLElement>('[data-screen]');
    // closest는 «없을 수도 있다»고 답한다. 무대는 언제나 화면 안에 있으므로
    // 없으면 HTML을 잘못 고친 것이고, 그때는 키를 받지 않는 편이 안전하다.
    if (!screen || screen.hidden) return;
    if (walker.handleKey(event)) event.preventDefault();
  });

  /** 기록이 있는 카드에만 최고 점수를 붙인다. 연습이면 별 점수를 두지 않는다 — 기록이 남지 않는다 */
  function appendBestScore(
    card: HTMLElement,
    bestScore: number | null | undefined,
  ): void {
    card.querySelector('.category-card__best')?.remove();
    // 기록이 없으면 아무것도 붙이지 않는다. 0점으로 보이면 오해를 부른다
    if (bestScore === null || bestScore === undefined || play.practice) return;

    const best = document.createElement('span');
    best.className = 'category-card__best';
    best.textContent = String(bestScore);
    best.dataset.icon = 'star';
    best.setAttribute('aria-hidden', 'true');
    best.title = `최고 ${bestScore}점`;
    card.append(best);
  }

  function renderCategories(
    { categories, banks, bestScores, onSelect }:
    Pick<HomeView, 'categories' | 'banks' | 'bestScores'>
    & { onSelect: (categoryId: CategoryId) => void },
  ): void {
    el.grid.replaceChildren();

    for (const category of categories) {
      const count = banks[category.id]?.length ?? 0;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'category-card';
      card.dataset.category = category.id;
      const bestScore = bestScores[category.id];
      // 문제를 못 받은 칸은 흐리게 잠긴다. 알림을 닫은 뒤에도 왜 잠겼는지 이름이 말한다 (U06)
      card.setAttribute(
        'aria-label',
        categoryCardLabel(category, { count, bestScore, practice: play.practice }),
      );
      card.disabled = count === 0;

      // 아이콘 칸. 그림은 디자인 층이 data-icon 으로 그린다 — 글리프를 넣지 않는다
      const icon = document.createElement('span');
      icon.className = 'category-card__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.dataset.icon = category.icon;

      const name = document.createElement('span');
      name.className = 'category-card__name category-card__name--full';
      name.textContent = category.name;
      name.setAttribute('aria-hidden', 'true');

      const compactName = document.createElement('span');
      compactName.className = 'category-card__name category-card__name--compact';
      compactName.textContent = COMPACT_CATEGORY_NAMES[category.id] ?? category.name;
      compactName.setAttribute('aria-hidden', 'true');

      const description = document.createElement('span');
      description.className = 'category-card__desc';
      description.textContent = category.description;

      card.append(icon, name, compactName, description);
      appendBestScore(card, bestScore);

      card.addEventListener('click', () => {
        if (playBusy) return;
        onSelect(category.id);
      });
      cards.set(category.id, { card, category, count });
      el.grid.append(card);
    }
  }

  /** 전체 도전의 표식과 이름 (U04). 연습이면 «연습»이고, 기록이 있으면 최고 점수, 없으면 한 판의 길이다 */
  function renderStartAll(): void {
    const best = bestScores.all;
    const length = allRoundLength(allCount);
    if (play.practice) {
      el.startAllMeta.hidden = allCount === 0;
      el.startAllMeta.textContent = '연습';
      el.startAll.setAttribute('aria-label', `전체 도전 연습하기, ${length}, 기록 안 남음`);
      return;
    }
    const hasBest = best !== null && best !== undefined;
    el.startAllMeta.hidden = !hasBest && allCount === 0;
    el.startAllMeta.textContent = hasBest ? `최고 ${best}점` : length;
    el.startAll.setAttribute('aria-label', hasBest ? `전체 도전, 최고 ${best}점` : `전체 도전, ${length}`);
  }

  /** 그려 둔 칸의 이름·별 점수를 제자리에서 고친다 */
  function refreshCards(): void {
    for (const [id, { card, category, count }] of cards) {
      const bestScore = bestScores[id];
      card.setAttribute('aria-label', categoryCardLabel(category, { count, bestScore, practice: play.practice }));
      appendBestScore(card, bestScore);
    }
    renderStartAll();
  }

  return {
    render({
      categories, banks, bestScores: scores, allCount: nextAllCount, characterId,
      nickname: currentNickname,
    }) {
      nickname = currentNickname;
      el.nicknameValue.textContent = nickname;
      bestScores = scores;
      allCount = nextAllCount;
      cards.clear();
      renderCategories({
        categories, banks, bestScores: scores, onSelect: onSelectCategory,
      });

      // 정적 버튼은 HTML에서 disabled로 시작한다. 리스너가 달린 지금 열어준다
      el.openRanking.disabled = false;
      el.openOnline.disabled = false;
      el.startAll.disabled = allCount === 0;

      // 기록이 없으면 한 판의 길이(«25문제»)를, 있으면 최고 점수를 보인다 (U04). 길이는 은행 크기가
      // 아니라 실제로 나갈 문항 수다. 짧은 화면에서 표식이 접혀도 접근 가능한 이름에는 남는다
      renderStartAll();

      // 선택한 모습은 홈을 직접 걷는 캐릭터 하나로 보여 준다.
      // 카드에 같은 몸을 한 번 더 그리면 시작 자리에서 캐릭터가 겹쳐 보인다.
      paintCharacter(el.walker, characterId);

      // 문제 은행 오류 문구가 떠 있으면 캐릭터도 CSS로 숨는다. 보이지 않는 캐릭터를
      // 움직이는 조작부까지 남기면 문구를 덮으므로 정상 홈에서만 함께 켠다.
      walker.setEnabled(!noteVisible);
    },

    hide() {
      walker.setEnabled(false);
    },

    setNote,

    setOnlineBusy(busy) {
      onlineBusy = busy;
      // 색이 아니라 글자로 알린다. 버튼 이름도 함께 바꿔 스크린리더에도 같은 말이 간다
      const entry = shownOnlineEntry();
      el.openOnlineDesc.textContent = busy ? '연결 중…' : entry.desc;
      el.openOnline.setAttribute('aria-label', busy ? '온라인, 연결 중' : entry.label);
      if (busy) el.openOnline.setAttribute('aria-busy', 'true');
      else el.openOnline.removeAttribute('aria-busy');
    },

    setOnlineMinPlayers(minPlayers) {
      onlineEntry = onlineEntryCopy(minPlayers);
      if (onlineBusy) return;
      showOnlineEntry();
    },

    setRoomNote(room) {
      roomNote = room;
      renderDockNote();
    },

    setPlayMode(view) {
      const was = play;
      play = view;
      el.caption.textContent = homeDockCaption(view.practice);
      // 랭킹 입구는 혼자 판도 남는 온라인 랭킹부터 연다. 이 기능을 모르는 API면 예전 이름(정적 HTML) 그대로다
      el.openRanking.setAttribute(
        'aria-label',
        view.soloOnline ? '랭킹: 온라인 랭킹과 내 최고 기록 보기' : '랭킹: 이 브라우저의 최고 기록 보기',
      );
      if (was.practice !== view.practice) refreshCards();
      // 온라인 입구의 말도 바뀐다 — 분야 칸이 혼자 판을 열면 입구는 친구와 함께 푸는 곳이다
      if (was.soloOnline !== view.soloOnline && !onlineBusy) showOnlineEntry();
      renderDockNote();
    },

    setBestScores(scores) {
      bestScores = scores;
      refreshCards();
    },

    setPlayBusy(busy) {
      playBusy = busy;
      el.caption.textContent = busy ? '연결 중…' : homeDockCaption(play.practice);
      if (busy) el.quests.setAttribute('aria-busy', 'true');
      else el.quests.removeAttribute('aria-busy');
      // 안내 줄의 «다시 연결»을 눌렀으면 그 줄이 «연결 중…»을 말한다
      renderDockNote();
    },

    focusPractice: focusFirstPlayable,
  };
}
