// 홈 화면 렌더링
// 카테고리 카드(FR-2.1), 최고 점수(FR-2.3), 전체 도전(FR-2.2), 내 캐릭터, 랭킹 입구.
//
// 캐릭터가 이 화면을 걸어 다니며 메뉴를 고른다. 버튼은 그대로 눌러도 되므로
// 걷기는 «또 하나의 길»이고, 게임 모드 조작을 미리 익히는 자리이기도 하다.
// 그래서 게임 모드가 꺼져 있어도 홈에서는 늘 걸어 다닌다.

import { createWalker } from './walker.js';
import { paintCharacter, createBody } from './sprite.js';
import { findCharacter } from '../characters.js';

/**
 * @param {{
 *   onSelectCategory: (categoryId: string) => void,
 *   onStartAll: () => void,
 *   onOpenRanking: () => void,
 *   onOpenCharacters: () => void
 * }} callbacks
 */
export function createHomeScreen({
  onSelectCategory, onStartAll, onOpenRanking, onOpenCharacters,
}) {
  const el = {
    stage: document.getElementById('home-stage'),
    grid: document.getElementById('category-grid'),
    startAll: document.getElementById('start-all'),
    startAllMeta: document.getElementById('start-all-meta'),
    openRanking: document.getElementById('open-ranking'),
    openCharacters: document.getElementById('open-characters'),
    characterFigure: document.getElementById('my-character-figure'),
    characterName: document.getElementById('my-character-name'),
    walker: document.getElementById('home-character'),
    note: document.getElementById('home-note'),
  };

  /** 걸어서 밟을 수 있는 칸과 그 칸을 밟았을 때 할 일 */
  let zones = [];

  function collectZones(categories) {
    zones = [
      ...[...el.grid.children].map((node, index) => ({
        node,
        run: () => onSelectCategory(categories[index].id),
      })),
      { node: el.startAll, run: () => onStartAll() },
      { node: el.openCharacters, run: () => onOpenCharacters() },
      { node: el.openRanking, run: () => onOpenRanking() },
    // 아직 못 쓰는 메뉴(문제가 없는 카테고리 등)에는 올라가지 않는다
    ].filter(({ node }) => !node.disabled);
  }

  const walker = createWalker({
    stage: el.stage,
    character: el.walker,
    getZones: () => zones.map(({ node }) => node),
    onZoneChange: (index, previous) => {
      zones[previous]?.node.classList.remove('is-standing');
      if (index !== null) zones[index].node.classList.add('is-standing');
    },
    onPick: (index) => zones[index]?.run(),
    // 처음에는 「내 캐릭터」 위에 선다. 무엇을 할 수 있는지 눈이 먼저 간다
    startAt: () => {
      const base = el.stage.getBoundingClientRect();
      const box = el.openCharacters.getBoundingClientRect();
      if (box.width === 0) return null;
      return {
        // 카드 오른쪽 끝에 세운다. 가운데면 이름을 가린다
        x: box.right - base.left - 26,
        y: box.bottom - base.top - 10,
      };
    },
  });

  el.startAll.addEventListener('click', () => onStartAll());
  el.openRanking.addEventListener('click', () => onOpenRanking());
  el.openCharacters.addEventListener('click', () => onOpenCharacters());

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
    render({ categories, banks, bestScores, allCount, questionsPerRound, characterId }) {
      renderCategories({
        categories, banks, bestScores, questionsPerRound, onSelect: onSelectCategory,
      });

      // 정적 버튼은 HTML에서 disabled로 시작한다. 리스너가 달린 지금 열어준다
      el.openRanking.disabled = false;
      el.startAll.disabled = allCount === 0;

      const best = bestScores.all;
      const parts = [allCount === 0 ? '문제 없음' : `${allCount}문제`];
      if (best !== null && best !== undefined) parts.push(`최고 ${best}점`);
      el.startAllMeta.textContent = parts.join(' · ');

      // 내 캐릭터 칸의 미리보기와 걸어 다닐 캐릭터
      el.characterFigure.replaceChildren(createBody(characterId));
      el.characterName.textContent = findCharacter(characterId).name;
      paintCharacter(el.walker, characterId);

      collectZones(categories);
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
