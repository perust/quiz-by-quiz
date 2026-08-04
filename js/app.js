// 진입점. 데이터 로딩과 화면 흐름을 연결한다.
// 게임 규칙은 core/, 그리기는 ui/, 저장은 storage/ 가 맡고 여기서는 셋을 잇기만 한다.

import { CATEGORIES, QUESTIONS_PER_ROUND } from './constants.js';
import { loadQuestionBanks } from './data/loader.js';
import { buildAllRound, buildRound } from './core/sampler.js';
import { createSession } from './core/session.js';
import { summarizeRound } from './core/scoring.js';
import { preferences, rankingStore } from './storage/adapter.js';
import { setEnabled as setSoundEnabled } from './audio.js';
import { showScreen } from './ui/screens.js';
import { createHomeScreen } from './ui/home.js';
import { createQuizScreen } from './ui/quiz.js';
import { createResultScreen } from './ui/result.js';
import { createRankingScreen } from './ui/ranking.js';

const ALL_MODE_LABEL = '전체 도전';

/**
 * index.html의 인라인 스크립트가 걸어둔 타이머를 끈다.
 * 이 함수가 불리지 못하면(모듈 로드 실패) 화면에 안내가 뜬다.
 */
function markBooted() {
  clearTimeout(window.__bootTimer);
  document.body.classList.add('is-booted');
}

/** 앱을 띄울 수 없을 때. 콘솔에만 남기지 않고 화면으로 알린다 */
function showFatalError(message) {
  clearTimeout(window.__bootTimer);
  document.body.classList.remove('is-booted');
  document.body.classList.add('is-boot-failed');

  const box = document.querySelector('.boot__error');
  if (box) {
    box.replaceChildren();
    const title = document.createElement('h1');
    title.className = 'boot__title';
    title.textContent = '게임을 시작할 수 없습니다';
    const body = document.createElement('p');
    body.className = 'boot__body';
    body.textContent = message;
    box.append(title, body);
  }
}

// ── 소리 설정 ────────────────────────────────────────────────────

/**
 * 앱 바의 켬/끔 버튼 한 쌍. 소리와 게임 모드가 같은 모양을 쓴다.
 *
 * @param {{ ids: {button: string, icon: string, label: string},
 *           on: {icon: string, label: string},
 *           off: {icon: string, label: string},
 *           apply: (value: boolean) => void,
 *           onChange: (value: boolean) => void }} spec
 */
function createToggle({ ids, on, off, apply, onChange }) {
  const button = document.getElementById(ids.button);
  const icon = document.getElementById(ids.icon);
  const label = document.getElementById(ids.label);
  let enabled = false;

  function render() {
    apply(enabled);
    button.setAttribute('aria-pressed', String(enabled));
    icon.textContent = enabled ? on.icon : off.icon;
    label.textContent = enabled ? on.label : off.label;
  }

  button.addEventListener('click', () => {
    enabled = !enabled;
    render();
    onChange(enabled);
  });

  return {
    set(value) {
      enabled = Boolean(value);
      render();
    },
  };
}

async function main() {
  markBooted();

  const { banks, failedCategories } = await loadQuestionBanks();
  const categoryNames = new Map(CATEGORIES.map((category) => [category.id, category.name]));

  // 카테고리가 모두 비면 할 수 있는 게 없다. 이유를 화면으로 알린다
  if (CATEGORIES.every((category) => (banks[category.id] ?? []).length === 0)) {
    showFatalError('문제 데이터를 하나도 불러오지 못했습니다. data 폴더의 JSON 파일과 네트워크 상태를 확인해 주세요.');
    return;
  }

  const settings = await preferences.getSettings();

  const soundToggle = createToggle({
    ids: { button: 'sound-toggle', icon: 'sound-icon', label: 'sound-label' },
    on: { icon: '🔊', label: '소리 켜짐' },
    off: { icon: '🔇', label: '소리 꺼짐' },
    apply: setSoundEnabled,
    onChange: (enabled) => preferences.setSettings({ soundEnabled: enabled }),
  });
  soundToggle.set(settings.soundEnabled);

  // 직전 판 문제 ID (FR-1.4). 1단계의 메모리 변수에서 저장소로 옮겼다
  let recentQuestionIds = await preferences.getRecentQuestionIds();

  /** 다시 하기가 되풀이할 판 종류 */
  let lastRound = null;
  /** 결과 화면이 들고 있는 이번 판 정보. 랭킹 등록에 쓴다 */
  let pending = null;
  /** 방금 등록한 기록 ID. 랭킹 화면에서 강조한다 (FR-6.5) */
  let registeredId = null;

  // ── 화면 ───────────────────────────────────────────────────────

  const homeScreen = createHomeScreen({
    onSelectCategory: (categoryId) => startRound({ mode: 'category', categoryId }),
    onStartAll: () => startRound({ mode: 'all', categoryId: null }),
    onOpenRanking: () => openRanking(),
  });

  const quizScreen = createQuizScreen({
    onExit: goHome,
    onComplete: showResult,
  });

  // 게임 모드는 화면을 바꿀 뿐 출제·채점·점수에는 영향을 주지 않는다.
  // 판 도중에 켜고 꺼도 세션이 유지되므로 언제 눌러도 안전하다.
  const gameModeToggle = createToggle({
    ids: { button: 'game-mode-toggle', icon: 'game-mode-icon', label: 'game-mode-label' },
    on: { icon: '🕹️', label: '게임 모드' },
    off: { icon: '📋', label: '보통 모드' },
    apply: (enabled) => quizScreen.setGameMode(enabled),
    onChange: (enabled) => preferences.setSettings({ gameMode: enabled }),
  });
  gameModeToggle.set(settings.gameMode);

  const resultScreen = createResultScreen({
    onRetry: () => (lastRound ? startRound(lastRound) : goHome()),
    onHome: goHome,
    onRanking: () => openRanking(pending?.target ?? null),
    onRegister: registerRecord,
  });

  const rankingScreen = createRankingScreen({
    onHome: goHome,
    loadRankings: (target) => rankingStore.getRankings(target),
    clearRankings: () => rankingStore.clearAll(),
  });

  // ── 홈 ─────────────────────────────────────────────────────────

  /** 전체 도전에 실제로 나갈 문항 수. 은행이 적으면 있는 만큼만 나간다 */
  function allModeCount() {
    return CATEGORIES.reduce(
      (sum, category) => sum + Math.min(QUESTIONS_PER_ROUND, banks[category.id]?.length ?? 0),
      0
    );
  }

  /**
   * 최고 점수는 어댑터로만 읽는다 (FR-2.3).
   * 인터페이스를 넓히지 않으려고 배치 조회 대신 다섯 번 호출한다.
   * 로컬 구현은 동기라 비용이 없고, 서버 구현으로 바뀌면 어댑터 안에서 묶으면 된다.
   */
  async function loadBestScores() {
    const scores = await Promise.all([
      ...CATEGORIES.map((category) =>
        rankingStore.getBestScore({ mode: 'category', category: category.id })
      ),
      rankingStore.getBestScore({ mode: 'all', category: null }),
    ]);

    const bestScores = { all: scores[scores.length - 1] };
    CATEGORIES.forEach((category, index) => {
      bestScores[category.id] = scores[index];
    });
    return bestScores;
  }

  async function goHome() {
    homeScreen.render({
      categories: CATEGORIES,
      banks,
      bestScores: await loadBestScores(),
      allCount: allModeCount(),
      questionsPerRound: QUESTIONS_PER_ROUND,
    });
    showScreen('home');
  }

  // ── 퀴즈 ───────────────────────────────────────────────────────

  /**
   * @param {{ mode: 'category'|'all', categoryId: string|null }} round
   */
  async function startRound(round) {
    const questions =
      round.mode === 'all'
        ? buildAllRound({
            banks: CATEGORIES.map((category) => banks[category.id] ?? []),
            countPerCategory: QUESTIONS_PER_ROUND,
            recentIds: recentQuestionIds,
          })
        : buildRound({
            bank: banks[round.categoryId] ?? [],
            count: QUESTIONS_PER_ROUND,
            recentIds: recentQuestionIds,
          });

    if (questions.length === 0) {
      homeScreen.setNote('이 카테고리에는 출제할 문제가 없습니다.');
      return;
    }

    // 이번 판에 낸 문제는 다음 판에서 후순위가 된다. 중간에 나가도 마찬가지다
    recentQuestionIds = questions.map((question) => question.id);
    await preferences.setRecentQuestionIds(recentQuestionIds);

    lastRound = round;
    registeredId = null;

    const session = createSession({
      questions,
      mode: round.mode,
      categoryId: round.categoryId,
    });

    showScreen('quiz');
    quizScreen.start(session, { categoryLabel: labelFor(round) });
  }

  function labelFor({ mode, categoryId }) {
    return mode === 'all' ? ALL_MODE_LABEL : (categoryNames.get(categoryId) ?? '');
  }

  // ── 결과 ───────────────────────────────────────────────────────

  async function showResult(session) {
    const summary = summarizeRound({
      questions: session.getQuestions(),
      answers: session.getAnswers(),
      mode: session.mode,
      categoryId: session.categoryId,
    });

    const target = { mode: summary.mode, category: summary.categoryId };

    // 최고 점수는 이번 기록을 저장하기 전에 읽어야 비교가 성립한다 (FR-5.7)
    const [bestScore, nickname] = await Promise.all([
      rankingStore.getBestScore(target),
      preferences.getNickname(),
    ]);

    // playedAt은 판이 끝난 시각이다. 닉네임을 입력한 시각이 아니다
    pending = { summary, target, playedAt: new Date().toISOString() };
    registeredId = null;

    resultScreen.show({
      summary,
      modeLabel: labelFor({ mode: summary.mode, categoryId: summary.categoryId }),
      bestScore,
      nickname,
    });
    showScreen('result');
  }

  /**
   * 랭킹 등록 (FR-6.1). 저장은 어댑터를 통해서만 한다 (FR-6.8).
   * @param {string} nickname 결과 화면이 길이를 검사한 값
   */
  async function registerRecord(nickname) {
    if (!pending) throw new Error('등록할 기록이 없습니다');

    const { summary, target, playedAt } = pending;
    const outcome = await rankingStore.saveRecord({
      nickname,
      mode: summary.mode,
      category: summary.categoryId,
      score: summary.score,
      correctCount: summary.correctCount,
      totalCount: summary.totalCount,
      durationMs: summary.durationMs,
      playedAt,
      // 문항별 정오. 선생님 모드가 문항 단위 정답률을 내는 근거다
      questionResults: summary.questionResults,
    });

    await preferences.setNickname(nickname); // 다음 판 기본값 (FR-6.11)
    registeredId = outcome.kept ? outcome.record.id : null;
    pending = { summary, target, playedAt };

    return outcome;
  }

  // ── 랭킹 ───────────────────────────────────────────────────────

  async function openRanking(target = null) {
    await rankingScreen.show({ target, highlightId: registeredId });
    showScreen('ranking');
  }

  // ── 시작 ───────────────────────────────────────────────────────

  const notes = [];
  if (failedCategories.length > 0) {
    const names = failedCategories.map(({ id }) => categoryNames.get(id) ?? id).join(', ');
    notes.push(`문제를 불러오지 못한 카테고리가 있습니다: ${names}`);
  }

  // 은행이 출제 수보다 적으면 그만큼만 낸다. 짧은 판이 버그로 보이지 않게 미리 알린다
  const short = CATEGORIES.filter((category) => {
    const size = banks[category.id]?.length ?? 0;
    return size > 0 && size < QUESTIONS_PER_ROUND;
  });
  if (short.length > 0) {
    const names = short.map((category) => category.name).join(', ');
    notes.push(`${names}는 문제가 ${QUESTIONS_PER_ROUND}개보다 적어 있는 만큼만 출제됩니다.`);
  }

  if (notes.length > 0) homeScreen.setNote(notes.join(' '));

  await goHome();
}

main().catch((error) => {
  console.error('[앱 시작 실패]', error);
  showFatalError(`예상치 못한 오류로 게임을 시작하지 못했습니다: ${error.message}`);
});
