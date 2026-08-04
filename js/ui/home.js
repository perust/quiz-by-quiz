// 홈 화면 렌더링
// 카테고리 카드(FR-2.1), 최고 점수(FR-2.3), 전체 도전(FR-2.2), 랭킹 입구.

/**
 * @param {{
 *   onSelectCategory: (categoryId: string) => void,
 *   onStartAll: () => void,
 *   onOpenRanking: () => void
 * }} callbacks
 */
export function createHomeScreen({ onSelectCategory, onStartAll, onOpenRanking }) {
  const el = {
    grid: document.getElementById('category-grid'),
    startAll: document.getElementById('start-all'),
    startAllMeta: document.getElementById('start-all-meta'),
    openRanking: document.getElementById('open-ranking'),
    note: document.getElementById('home-note'),
  };

  el.startAll.addEventListener('click', () => onStartAll());
  el.openRanking.addEventListener('click', () => onOpenRanking());

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
     *   allCount: number
     * }} view bestScores는 카테고리 id와 'all' 키를 갖는다
     */
    render({ categories, banks, bestScores, allCount, questionsPerRound }) {
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
    },

    /** 홈 하단 안내 문구. 문구가 없으면 숨긴다 */
    setNote(message) {
      el.note.textContent = message ?? '';
      el.note.hidden = !message;
    },
  };
}
