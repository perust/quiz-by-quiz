// 홈 화면 렌더링
// 카테고리 카드(FR-2.1), 최고 점수(FR-2.3), 전체 도전(FR-2.2), 내 캐릭터, 랭킹 입구.
//
// 캐릭터가 이 화면을 걸어 다니며 메뉴를 고른다. 버튼은 그대로 눌러도 되므로
// 걷기는 «또 하나의 길»이고, 게임 모드 조작을 미리 익히는 자리이기도 하다.
// 그래서 게임 모드가 꺼져 있어도 홈에서는 늘 걸어 다닌다.

import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH } from '../constants.js';
import { createWalker } from './walker.js';
import { trapFocus } from './quiz.js';
import { paintCharacter, createBody } from './sprite.js';

/**
 * @param {{
 *   onSelectCategory: (categoryId: string) => void,
 *   onStartAll: () => void,
 *   onOpenRanking: () => void,
 *   onOpenCharacters: () => void,
 *   onOpenOnline: () => void,
 *   onNickname: (nickname: string) => void   닉네임을 바꿨을 때
 * }} callbacks
 */
export function createHomeScreen({
  onSelectCategory, onStartAll, onOpenRanking, onOpenCharacters, onOpenOnline, onNickname,
}) {
  const el = {
    stage: document.getElementById('home-stage'),
    grid: document.getElementById('category-grid'),
    startAll: document.getElementById('start-all'),
    startAllMeta: document.getElementById('start-all-meta'),
    openRanking: document.getElementById('open-ranking'),
    openCharacters: document.getElementById('open-characters'),
    openOnline: document.getElementById('open-online'),
    nicknameCard: document.getElementById('open-nickname'),
    nicknameValue: document.getElementById('nickname-value'),
    dialog: document.getElementById('nickname-dialog'),
    dialogForm: document.getElementById('nickname-form'),
    dialogInput: document.getElementById('nickname-edit'),
    dialogMessage: document.getElementById('nickname-message'),
    dialogCancel: document.getElementById('nickname-cancel'),
    characterFigure: document.getElementById('my-character-figure'),
    walker: document.getElementById('home-character'),
    note: document.getElementById('home-note'),
  };

  // 화면 전체를 걸어 다닌다. 칸 목록을 따로 만들지 않고 발밑에 실제로 무엇이
  // 있는지 그때그때 보므로, 카드를 더하거나 빼도 여기를 고칠 일이 없다.
  // 고르는 것도 워커가 그 자리를 진짜로 누르는 것이라, 버튼에 달린 리스너가
  // 마우스로 눌렀을 때와 똑같이 움직인다 — 아래 세 줄이 그대로 쓰인다.
  const walker = createWalker({
    character: el.walker,
    // 처음에는 「내 캐릭터」 위에 선다. 무엇을 할 수 있는지 눈이 먼저 간다
    startAt: () => {
      const box = el.openCharacters.getBoundingClientRect();
      if (box.width === 0) return null;
      return {
        // 카드 오른쪽 끝에 세운다. 가운데면 이름을 가린다
        x: box.right - 26,
        y: box.bottom - 10,
      };
    },
  });

  el.startAll.addEventListener('click', () => onStartAll());
  el.openRanking.addEventListener('click', () => onOpenRanking());
  el.openCharacters.addEventListener('click', () => onOpenCharacters());
  el.openOnline.addEventListener('click', () => onOpenOnline());

  // ── 닉네임 바꾸기 ──────────────────────────────────────────────
  // window.prompt 대신 페이지 안 다이얼로그를 쓴다. 열려 있는 동안에는
  // 워커가 키를 받지 않으므로(isBlocked) 캐릭터가 뒤에서 걸어 다니지 않는다.

  /** 다이얼로그를 연 자리. 닫을 때 포커스를 되돌린다 */
  let nickname = '';

  function closeNicknameDialog() {
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
    const screen = el.stage.closest('[data-screen]');
    if (screen.hidden) return;
    if (walker.handleKey(event)) event.preventDefault();
  });

  /** 카드 아래에 붙는 "10문제 · 최고 30점" 줄 */
  function appendMeta(card, count, bestScore, questionsPerRound) {
    const countLabel = document.createElement('span');
    countLabel.className = 'category-card__count';
    countLabel.textContent = count === 0 ? '문제 없음' : `${count}문제`;
    // 은행이 출제 수보다 적으면 그 판은 짧아진다. 눈에 띄게 표시한다
    if (count > 0 && count < questionsPerRound) {
      countLabel.classList.add('category-card__count--short');
    }
    card.append(countLabel);

    // 기록이 없으면 아무것도 붙이지 않는다. 0점으로 보이면 오해를 부른다
    if (bestScore === null || bestScore === undefined) return;

    const best = document.createElement('span');
    best.className = 'category-card__best';
    best.textContent = `최고 ${bestScore}점`;
    card.append(best);
  }

  function renderCategories({ categories, banks, bestScores, questionsPerRound, onSelect }) {
    el.grid.replaceChildren();

    for (const category of categories) {
      const count = banks[category.id]?.length ?? 0;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'category-card';
      card.disabled = count === 0;

      const icon = document.createElement('span');
      icon.className = 'category-card__icon';
      icon.textContent = category.icon;

      const name = document.createElement('span');
      name.className = 'category-card__name';
      name.textContent = category.name;

      const description = document.createElement('span');
      description.className = 'category-card__desc';
      description.textContent = category.description;

      card.append(icon, name, description);
      appendMeta(card, count, bestScores[category.id], questionsPerRound);

      card.addEventListener('click', () => onSelect(category.id));
      el.grid.append(card);
    }
  }

  return {
    /**
     * @param {{
     *   categories: object[],
     *   banks: Record<string, object[]>,
     *   bestScores: Record<string, number|null>,
     *   allCount: number,
     *   characterId: string
     * }} view bestScores는 카테고리 id와 'all' 키를 갖는다
     */
    render({
      categories, banks, bestScores, allCount, questionsPerRound, characterId,
      nickname: currentNickname,
    }) {
      nickname = currentNickname;
      el.nicknameValue.textContent = nickname;
      renderCategories({
        categories, banks, bestScores, questionsPerRound, onSelect: onSelectCategory,
      });

      // 정적 버튼은 HTML에서 disabled로 시작한다. 리스너가 달린 지금 열어준다
      el.openRanking.disabled = false;
      el.openOnline.disabled = false;
      el.startAll.disabled = allCount === 0;

      const best = bestScores.all;
      const parts = [allCount === 0 ? '문제 없음' : `${allCount}문제`];
      if (best !== null && best !== undefined) parts.push(`최고 ${best}점`);
      el.startAllMeta.textContent = parts.join(' · ');

      // 내 캐릭터 칸의 미리보기와 걸어 다닐 캐릭터.
      // 이름은 쓰지 않는다 — 무엇으로 보이는지는 보는 사람이 정한다
      el.characterFigure.replaceChildren(createBody(characterId));
      paintCharacter(el.walker, characterId);

      walker.setEnabled(true);
    },

    /** 홈을 떠날 때. 캐릭터가 다른 화면에서 계속 뛰지 않게 한다 */
    hide() {
      walker.setEnabled(false);
    },

    /** 홈 하단 안내 문구. 문구가 없으면 숨긴다 */
    setNote(message) {
      el.note.textContent = message ?? '';
      el.note.hidden = !message;
    },
  };
}
