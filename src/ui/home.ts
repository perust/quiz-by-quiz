// 홈 화면 렌더링
// 카테고리 카드(FR-2.1), 최고 점수(FR-2.3), 전체 도전(FR-2.2), 내 캐릭터, 랭킹 입구.
//
// 캐릭터가 이 화면을 걸어 다니며 메뉴를 고른다. 버튼은 그대로 눌러도 되므로
// 걷기와 직접 누르기는 항상 함께 제공되는 두 입력 경로다.

import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from '../constants.js';
import { need } from '../dom.js';
import { createWalker } from './walker.js';
import { trapFocus } from './quiz.js';
import { paintCharacter } from './sprite.js';
import type { Category, CategoryId, Question } from '../types.js';

/** app.ts가 넘겨주는 콜백 뭉치 */
export interface HomeScreenDeps {
  onSelectCategory: (categoryId: CategoryId) => void;
  onStartAll: () => void;
  onOpenRanking: () => void;
  onOpenCharacters: () => void;
  onOpenOnline: () => void;
  /** 닉네임을 바꿨을 때 */
  onNickname: (nickname: string) => void;
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

  /** 홈 하단 안내 문구. 문구가 없으면 숨긴다 */
  setNote(message: string | null | undefined): void;
}

/** 320px의 다섯 칸 dock에서도 서로 붙지 않는 시각용 짧은 이름. 접근 가능한 이름은 전체 이름을 쓴다. */
const COMPACT_CATEGORY_NAMES: Partial<Record<CategoryId, string>> = {
  general: '상식',
  art: '예술',
};

export function createHomeScreen({
  onSelectCategory, onStartAll, onOpenRanking, onOpenCharacters, onOpenOnline, onNickname,
}: HomeScreenDeps): HomeScreen {
  const el = {
    stage: need('home-stage'),
    quests: need('home-quests'),
    grid: need('category-grid'),
    startAll: need<HTMLButtonElement>('start-all'),
    startAllMeta: need('start-all-meta'),
    openRanking: need<HTMLButtonElement>('open-ranking'),
    openCharacters: need<HTMLButtonElement>('open-characters'),
    openOnline: need<HTMLButtonElement>('open-online'),
    nicknameCard: need<HTMLButtonElement>('open-nickname'),
    nicknameValue: need('nickname-value'),
    dialog: need('nickname-dialog'),
    dialogForm: need<HTMLFormElement>('nickname-form'),
    dialogInput: need<HTMLInputElement>('nickname-edit'),
    dialogMessage: need('nickname-message'),
    dialogCancel: need<HTMLButtonElement>('nickname-cancel'),
    walker: need('home-character'),
    note: need('home-note'),
  };

  // 하단 dock은 최고 기록 유무·번역 길이에 따라 높이가 달라진다. 고정 조작부가 그 높이를
  // 추측하지 않고 실제 값을 따라가게 해, 저장 기록이 생긴 뒤에도 버튼을 덮지 않는다.
  const syncDockHeight = (): void => {
    const height = Math.ceil(el.quests.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty('--home-dock-h', `${height}px`);
  };
  const dockObserver = new ResizeObserver(syncDockHeight);
  dockObserver.observe(el.quests);
  requestAnimationFrame(syncDockHeight);

  // 화면 전체를 걸어 다닌다. 칸 목록을 따로 만들지 않고 발밑에 실제로 무엇이
  // 있는지 그때그때 보므로, 카드를 더하거나 빼도 여기를 고칠 일이 없다.
  // 고르는 것도 워커가 그 자리를 진짜로 누르는 것이라, 버튼에 달린 리스너가
  // 마우스로 눌렀을 때와 똑같이 움직인다 — 아래 세 줄이 그대로 쓰인다.
  const walker = createWalker({
    character: el.walker,
    // 공용 조작부의 모양은 다른 화면과 같고, 하단 dock을 피하는 배치만 선언한다.
    controls: { placement: 'home-dock' },
    // 처음에는 「내 캐릭터」 입구 바로 아래의 월드 바닥에 선다.
    // HUD 글자를 덮지 않으면서도 한 번 위로 걸으면 바로 입구를 고를 수 있다.
    startAt: () => {
      // 200% 확대나 가로 화면에서는 두 보조 입구가 dock 위 양쪽으로 이동한다.
      // 그때는 가운데 위의 빈 하늘에서 시작해 어느 입구도 가리지 않는다.
      if (window.innerHeight <= 700) {
        const entry = el.openRanking.getBoundingClientRect();
        return {
          x: window.innerWidth / 2,
          y: Math.max(
            el.walker.offsetHeight,
            Math.min(el.walker.offsetHeight + 48, entry.top - 8),
          ),
        };
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

  el.startAll.addEventListener('click', () => onStartAll());
  el.openRanking.addEventListener('click', () => onOpenRanking());
  el.openCharacters.addEventListener('click', () => onOpenCharacters());
  el.openOnline.addEventListener('click', () => onOpenOnline());

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

  /** 기록이 있는 카드에만 최고 점수를 붙인다. */
  function appendBestScore(
    card: HTMLElement,
    bestScore: number | null | undefined,
  ): void {
    // 기록이 없으면 아무것도 붙이지 않는다. 0점으로 보이면 오해를 부른다
    if (bestScore === null || bestScore === undefined) return;

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
      card.setAttribute(
        'aria-label',
        bestScore === null || bestScore === undefined
          ? `${category.name} 문제 풀기`
          : `${category.name} 문제 풀기, 최고 ${bestScore}점`,
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

      card.addEventListener('click', () => onSelect(category.id));
      el.grid.append(card);
    }
  }

  return {
    render({
      categories, banks, bestScores, allCount, characterId,
      nickname: currentNickname,
    }) {
      nickname = currentNickname;
      el.nicknameValue.textContent = nickname;
      renderCategories({
        categories, banks, bestScores, onSelect: onSelectCategory,
      });

      // 정적 버튼은 HTML에서 disabled로 시작한다. 리스너가 달린 지금 열어준다
      el.openRanking.disabled = false;
      el.openOnline.disabled = false;
      el.startAll.disabled = allCount === 0;

      const best = bestScores.all;
      el.startAllMeta.hidden = best === null || best === undefined;
      el.startAllMeta.textContent = best === null || best === undefined ? '' : `최고 ${best}점`;
      el.startAll.setAttribute(
        'aria-label',
        best === null || best === undefined ? '전체 도전' : `전체 도전, 최고 ${best}점`,
      );

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

    setNote(message) {
      noteVisible = Boolean(message);
      el.note.textContent = message ?? '';
      el.note.hidden = !noteVisible;

      if (noteVisible) {
        walker.setEnabled(false);
      } else {
        const screen = el.stage.closest<HTMLElement>('[data-screen]');
        if (screen && !screen.hidden) walker.setEnabled(true);
      }
    },
  };
}
