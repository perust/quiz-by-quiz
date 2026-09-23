// 진입점. 데이터 로딩과 화면 흐름을 연결한다.
// 게임 규칙은 core/, 그리기는 ui/, 저장은 storage/ 가 맡고 여기서는 셋을 잇기만 한다.

import {
  CATEGORIES,
  DEFAULT_NICKNAME,
  QUESTIONS_PER_CATEGORY_IN_ALL,
  QUESTIONS_PER_ROUND,
  RECENT_QUESTION_MEMORY,
} from './constants.js';
import { loadQuestionBanks } from './data/loader.js';
import { buildAllRound, buildRound } from './core/sampler.js';
import { createSession, type QuizSession } from './core/session.js';
import { summarizeRound } from './core/scoring.js';
import { preferences, rankingStore } from './storage/adapter.js';
import { setEnabled as setSoundEnabled } from './audio.js';
import { showScreen, type ScreenName } from './ui/screens.js';
import { createHomeScreen } from './ui/home.js';
import { createOnlineScreen } from './ui/online.js';
import { createWaitingRoom } from './ui/waiting-room.js';
import { roomStore, type OnlineFinishedMatch } from './online/adapter.js';
import { createOnlineMatchController } from './online/match-controller.js';
import { isCurrentWaitingRoomEntry, recoverActiveNetworkMatch } from './online/match-recovery.js';
import { createOnlineQuizScreen } from './ui/online-quiz.js';
import { createOnlineResultScreen } from './ui/online-result.js';
import { createQuizScreen, trapFocus } from './ui/quiz.js';
import { createArena } from './ui/arena.js';
import { createResultScreen } from './ui/result.js';
import { createRankingScreen } from './ui/ranking.js';
import { createCharactersScreen } from './ui/characters-screen.js';
import { DEFAULT_CHARACTER_ID, findCharacter } from './characters.js';
import { need } from './dom.js';
import type { CategoryId, RankingTarget, RoundMode, RoundSummary } from './types.js';

const ALL_MODE_LABEL = '전체 도전';

/** 한 판의 종류. 홈에서 고르든 방에서 시작하든 이 모양으로 모인다 */
interface Round {
  mode: RoundMode;
  categoryId: CategoryId | null;
}

/** 결과 화면이 들고 있는 이번 판. 랭킹 등록에 쓴다 */
interface PendingResult {
  summary: RoundSummary;
  target: RankingTarget;
  /** 판이 끝난 시각. 닉네임을 입력한 시각이 아니다 */
  playedAt: string;
}

/**
 * index.html의 인라인 스크립트가 걸어둔 타이머를 끈다.
 * 이 함수가 불리지 못하면(모듈 로드 실패) 화면에 안내가 뜬다.
 */
function markBooted(): void {
  clearTimeout(window.__bootTimer);
  document.body.classList.add('is-booted');
}

/** 앱을 띄울 수 없을 때. 콘솔에만 남기지 않고 화면으로 알린다 */
function showFatalError(message: string): void {
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

interface ToggleFace {
  icon: string;
  label: string;
}

interface ToggleSpec {
  ids: { button: string; icon: string; label: string };
  on: ToggleFace;
  off: ToggleFace;
  apply: (value: boolean) => void;
  onChange: (value: boolean) => void;
}

interface Toggle {
  /** **onChange를 부르지 않는다.** 저장된 값을 화면에 얹기만 한다 */
  set(value: boolean): void;
}

/**
 * 앱 바의 소리 켬/끔 버튼.
 */
function createToggle({ ids, on, off, apply, onChange }: ToggleSpec): Toggle {
  const button = need(ids.button);
  const icon = need(ids.icon);
  const label = need(ids.label);
  let enabled = false;

  function render(): void {
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
    set(value: boolean) {
      enabled = Boolean(value);
      render();
    },
  };
}

async function main(): Promise<void> {
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

  // 랭킹에 쓰던 닉네임을 온라인 방에서도 그대로 쓴다. 이름을 두 번 묻지 않는다
  let savedNickname = (await preferences.getNickname()) || DEFAULT_NICKNAME;

  /** 다시 하기가 되풀이할 판 종류 */
  let lastRound: Round | null = null;
  /** 결과 화면이 들고 있는 이번 판 정보. 랭킹 등록에 쓴다 */
  let pending: PendingResult | null = null;
  /**
   * 지금 들어가 있는 방. 방에서 시작한 판은 끝나거나 그만두면 대기실로 돌아간다.
   * 방을 나가면 비운다 — 그때부터는 홈이 돌아갈 곳이다.
   */
  let activeRoomCode: string | null = null;
  /** 서버 권위 매치 controller가 붙어 있는 방. 대기실 socket과 분리한다. */
  let onlineMatchRoomCode: string | null = null;
  /** controller callback이 현재 앱 navigation을 소유하는지 확인하는 세대. */
  let onlineMatchNavigationGeneration: number | null = null;
  /** 늦게 끝난 REST/저장소 요청이 더 새 화면 전환을 덮지 못하게 하는 소유권 세대. */
  let waitingRoomEntryGeneration = 0;
  /** 방금 등록한 기록 ID. 랭킹 화면에서 강조한다 (FR-6.5) */
  let registeredId: string | null = null;

  // ── 화면 ───────────────────────────────────────────────────────

  // 쓰고 있는 캐릭터. 없는 id가 저장돼 있어도 findCharacter가 기본값으로 되돌린다
  let characterId = findCharacter(settings.characterId ?? DEFAULT_CHARACTER_ID).id;
  const syncRoomPlayer = (): void => {
    roomStore.setPlayer({ nickname: savedNickname, characterId });
  };
  syncRoomPlayer();

  const homeScreen = createHomeScreen({
    onSelectCategory: (categoryId) => startRound({ mode: 'category', categoryId }),
    onStartAll: () => startRound({ mode: 'all', categoryId: null }),
    onOpenRanking: () => openRanking(),
    onOpenCharacters: () => openCharacters(),
    onOpenOnline: () => openOnline(),
    onNickname: (value) => {
      savedNickname = value;
      syncRoomPlayer();
      preferences.setNickname(value);
    },
  });

  // 온라인 로비. 방을 어디에 두는지는 어댑터가 정하고 화면은 모른다
  const onlineScreen = createOnlineScreen({
    roomStore,
    onHome: goHome,
    onEnterRoom: (code) => openWaitingRoom(code),
    getPlayer: () => ({ nickname: savedNickname, characterId }),
  });

  // 대기실. server-authoritative event로 시작을 알리고, 독립 개발 문서에서는
  // 동일한 adapter contract를 따르는 local implementation이 한 판을 연다.
  const waitingRoom = createWaitingRoom({
    roomStore,
    onLeave: (code, entryGeneration, reason) => {
      if (!isCurrentWaitingRoomEntry({
        code,
        activeRoomCode,
        onlineMatchRoomCode,
        entryGeneration,
        currentGeneration: waitingRoomEntryGeneration,
      })) return;
      stopOnlineMatch();
      activeRoomCode = null;
      // reason 이 있으면 내가 나간 것이 아니라 들어갈 수 없어서 되돌아온 것이다
      void openOnline(reason);
    },
    onStart: (code, { categoryId }, entryGeneration) => {
      // **나간 방의 판은 열지 않는다.** 「게임 시작」은 저장소에 알리고 되돌아온
      // 이벤트를 보고 움직이므로, 그 사이에 대기실을 떠났으면 여기 늦게 도착한다.
      // 그대로 열면 로비에 있는 사람 앞에서 판이 시작된다.
      const ownsStartedEntry = () => isCurrentWaitingRoomEntry({
        code,
        activeRoomCode,
        onlineMatchRoomCode,
        entryGeneration,
        currentGeneration: waitingRoomEntryGeneration,
      });
      if (!ownsStartedEntry()) return;
      if (roomStore.isNetworked) {
        void openOnlineMatch(code);
        return;
      }
      void startRound(
        categoryId ? { mode: 'category', categoryId } : { mode: 'all', categoryId: null },
        ownsStartedEntry,
      );
    },
    onMatchInvalidated: (code, entryGeneration) => {
      void resumeActiveNetworkMatch(code, entryGeneration);
    },
    getPlayer: () => ({ nickname: savedNickname, characterId }),
  });

  const charactersScreen = createCharactersScreen({
    // 칸에 올라선 것만으로 바뀐다. 고르는 순간이 곧 미리보기다
    onSelect: (id) => {
      characterId = id;
      quizScreen.setCharacter(id);
      onlineQuizScreen.setCharacter(id);
      syncRoomPlayer();
      preferences.setSettings({ characterId: id });
    },
    onBack: goHome,
  });

  const quizScreen = createQuizScreen({
    // 방에서 시작한 판이면 그만둘 때도 대기실로 돌아간다
    onExit: () => {
      if (activeRoomCode) openWaitingRoom(activeRoomCode);
      else goHome();
    },
    onComplete: showResult,
  });

  quizScreen.setCharacter(characterId);

  const resultScreen = createResultScreen({
    onRetry: () => {
      if (lastRound) startRound(lastRound);
      else goHome();
    },
    onHome: goHome,
    onRoom: () => {
      if (activeRoomCode) openWaitingRoom(activeRoomCode);
      else goHome();
    },
    onRanking: () => openRanking(pending?.target ?? null),
    onRegister: registerRecord,
  });

  const rankingScreen = createRankingScreen({
    onHome: goHome,
    loadRankings: (target) => rankingStore.getRankings(target),
    clearRankings: () => rankingStore.clearAll(),
  });

  // ── 서버 권위 온라인 매치 ──────────────────────────────────────
  //
  // 대기실의 subscription은 화면이 바뀌면 정리된다. 따라서 active match는 별도
  // controller가 socket invalidation → authenticated snapshot 재조회만 맡는다.
  let onlineMatchController: ReturnType<typeof createOnlineMatchController> | null = null;

  const onlineQuizScreen = createOnlineQuizScreen({
    createCharacterArena: createArena,
    trapFocus,
    onSubmit: async (spec) => {
      if (!onlineMatchController) return;
      await onlineMatchController.submit(spec);
    },
    onExit: () => {
      stopOnlineMatch();
      void openOnline('매치는 서버에서 계속 진행됩니다. 방에 다시 들어가 이어서 풀 수 있어요.');
    },
    onFinished: showOnlineFinal,
  });
  onlineQuizScreen.setCharacter(characterId);

  const onlineResultScreen = createOnlineResultScreen({
    onRoom: () => {
      if (activeRoomCode) void openWaitingRoom(activeRoomCode);
      else void openOnline();
    },
    onHome: () => { void goHome(); },
    getPlayerId: () => roomStore.me(),
  });

  onlineMatchController = createOnlineMatchController({
    gateway: roomStore,
    onSnapshot: (snapshot) => {
      if (!ownsOnlineMatchNavigation()) return;
      onlineQuizScreen.render(snapshot);
    },
    onMissing: () => {
      if (!ownsOnlineMatchNavigation()) return;
      const code = onlineMatchRoomCode;
      stopOnlineMatch();
      if (code && activeRoomCode === code) void openWaitingRoom(code);
      else void openOnline('진행 중인 온라인 매치를 찾지 못했습니다.');
    },
    onError: (message, context) => {
      if (!ownsOnlineMatchNavigation()) return;
      if (context.source === 'refresh') onlineQuizScreen.setRefreshError(message);
      else onlineQuizScreen.setSubmitError(message, context);
    },
  });

  /** finished ranking 역시 server snapshot만 받는다. local ranking store에 쓰지 않는다. */
  function showOnlineFinal(snapshot: OnlineFinishedMatch): void {
    stopOnlineMatch();
    onlineResultScreen.show(snapshot);
    goTo('online-result');
  }

  function stopOnlineMatch(): void {
    onlineMatchNavigationGeneration = null;
    onlineMatchController?.close();
    onlineMatchRoomCode = null;
  }

  function invalidateWaitingRoomEntry(): number {
    waitingRoomEntryGeneration += 1;
    return waitingRoomEntryGeneration;
  }

  function isCurrentNavigation(generation: number): boolean {
    return generation === waitingRoomEntryGeneration;
  }

  function ownsOnlineMatchNavigation(): boolean {
    return onlineMatchRoomCode !== null
      && onlineMatchNavigationGeneration !== null
      && isCurrentNavigation(onlineMatchNavigationGeneration);
  }

  /** start event/reconnect 직후 이 controller가 room socket을 독립적으로 소유한다. */
  async function openOnlineMatch(code: string): Promise<void> {
    if (!roomStore.isNetworked) return;
    if (onlineMatchRoomCode === code && ownsOnlineMatchNavigation()) return;
    stopOnlineMatch();
    onlineMatchRoomCode = code;
    onlineQuizScreen.setNotice('서버 매치 상태를 불러오는 중입니다.');
    goTo('online-quiz');
    onlineMatchNavigationGeneration = waitingRoomEntryGeneration;
    await onlineMatchController?.open(code);
  }

  /**
   * 대기실 socket은 «무효화됐다»만 알려 준다. 실제로 판을 열지는 REST snapshot으로
   * 다시 판정한다. 이미 끝난 판·다른 방으로 옮긴 판·통신 실패는 대기실에 남긴다.
   */
  async function resumeActiveNetworkMatch(code: string, entryGeneration: number): Promise<boolean> {
    if (!roomStore.isNetworked || activeRoomCode !== code || onlineMatchRoomCode === code) return false;
    return recoverActiveNetworkMatch(code, {
      getMatch: (roomCode) => roomStore.getMatch(roomCode),
      isStillCurrent: () => isCurrentWaitingRoomEntry({
        code,
        activeRoomCode,
        onlineMatchRoomCode,
        entryGeneration,
        currentGeneration: waitingRoomEntryGeneration,
      }),
      hasOpenMatch: () => onlineMatchRoomCode === code,
      openMatch: openOnlineMatch,
    });
  }

  /**
   * 화면을 옮긴다. **가는 곳만 남기고 나머지는 모두 접는다.**
   *
   * 전에는 옮기는 함수마다 손으로 `hide()` 를 나열했다. 그러면 **하나씩 빠뜨린다** —
   * 실제로 퀴즈가 빠져 세션과 타이머가 살아남았고(로비에서 방 이름을 적는 중에
   * 「시간 초과입니다」가 떴다), 결과·랭킹은 `hide` 자체가 없어 손가락 조작부가
   * 다음 화면까지 따라갔다.
   *
   * 화면이 늘어도 아래 표에 한 줄만 더하면 된다. **접는 것을 잊을 자리가 없다.**
   * 각 `hide()` 는 이미 접혀 있으면 아무 일도 하지 않으므로 몇 번 불러도 안전하다.
   *
   * **내용을 그린 뒤에 부른다.** 먼저 부르면 아직 비어 있는 화면이 한 번 스친다 —
   * 랭킹이나 대기실처럼 저장소를 기다리는 화면에서 눈에 띈다.
   */
  const closers: Record<ScreenName, () => void> = {
    home: () => homeScreen.hide(),
    quiz: () => quizScreen.hide(),
    'online-quiz': () => onlineQuizScreen.hide(),
    result: () => resultScreen.hide(),
    'online-result': () => onlineResultScreen.hide(),
    ranking: () => rankingScreen.hide(),
    online: () => onlineScreen.hide(),
    waiting: () => waitingRoom.hide(),
    characters: () => charactersScreen.hide(),
  };

  function goTo(name: ScreenName): void {
    if (name !== 'waiting') invalidateWaitingRoomEntry();
    for (const [key, close] of Object.entries(closers)) {
      if (key !== name) close();
    }
    showScreen(name);
  }

  // ── 홈 ─────────────────────────────────────────────────────────

  /** 전체 도전에 실제로 나갈 문항 수. 은행이 적으면 있는 만큼만 나간다 */
  function allModeCount(): number {
    return CATEGORIES.reduce(
      (sum, category) =>
        sum + Math.min(QUESTIONS_PER_CATEGORY_IN_ALL, banks[category.id]?.length ?? 0),
      0
    );
  }

  /**
   * 최고 점수는 어댑터로만 읽는다 (FR-2.3).
   * 인터페이스를 넓히지 않으려고 배치 조회 대신 다섯 번 호출한다.
   * 로컬 구현은 동기라 비용이 없고, 서버 구현으로 바뀌면 어댑터 안에서 묶으면 된다.
   */
  async function loadBestScores(): Promise<Partial<Record<CategoryId | 'all', number | null>>> {
    const scores = await Promise.all([
      ...CATEGORIES.map((category) =>
        rankingStore.getBestScore({ mode: 'category', category: category.id })
      ),
      rankingStore.getBestScore({ mode: 'all', category: null }),
    ]);

    const bestScores: Partial<Record<CategoryId | 'all', number | null>> = {
      all: scores[scores.length - 1] ?? null,
    };
    CATEGORIES.forEach((category, index) => {
      bestScores[category.id] = scores[index] ?? null;
    });
    return bestScores;
  }

  async function goHome(): Promise<void> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    // 홈으로 가도 방에서 나가지는 않는다. 다만 매치 socket은 닫아 재접속 경계를 분명히 한다.
    stopOnlineMatch();
    const bestScores = await loadBestScores();
    if (!isCurrentNavigation(navigationGeneration)) return;
    homeScreen.render({
      categories: CATEGORIES,
      banks,
      bestScores,
      allCount: allModeCount(),
      questionsPerRound: QUESTIONS_PER_ROUND,
      characterId,
      nickname: savedNickname,
    });
    goTo('home');
  }

  // ── 퀴즈 ───────────────────────────────────────────────────────

  async function startRound(
    round: Round,
    ownsEntry?: () => boolean,
  ): Promise<void> {
    if (ownsEntry && !ownsEntry()) return;
    // 대기실 event의 owner는 여기서 일반 navigation owner로 인계한다. 그 뒤에는
    // 원래 entry generation이 아니라 이 요청의 generation만 commit 권한을 가진다.
    const navigationGeneration = invalidateWaitingRoomEntry();
    if (ownsEntry) waitingRoom.hide();
    const questions =
      round.mode === 'all'
        ? buildAllRound({
            banks: CATEGORIES.map((category) => banks[category.id] ?? []),
            countPerCategory: QUESTIONS_PER_CATEGORY_IN_ALL,
            recentIds: recentQuestionIds,
          })
        : buildRound({
            bank: (round.categoryId ? banks[round.categoryId] : undefined) ?? [],
            count: QUESTIONS_PER_ROUND,
            recentIds: recentQuestionIds,
          });

    if (questions.length === 0) {
      homeScreen.setNote('이 카테고리에는 출제할 문제가 없습니다.');
      goTo('home');
      return;
    }

    // 이번 판에 낸 문제는 다음 판에서 후순위가 된다. 중간에 나가도 마찬가지다.
    // 한 판만 기억하면 은행이 커져도 같은 문제가 금방 되돌아오므로 여러 판을
    // 쌓아 두되, 오래된 것부터 잘라 낸다. 새 문제가 앞에 오게 이어 붙인다.
    const nextRecentQuestionIds = [
      ...new Set([...questions.map((question) => question.id), ...recentQuestionIds]),
    ].slice(0, RECENT_QUESTION_MEMORY);
    try {
      await preferences.setRecentQuestionIds(nextRecentQuestionIds);
    } catch {
      // 최근 출제 기록은 중복 완화용일 뿐 판의 권위가 아니다. 저장 실패가
      // 이미 인계받은 화면을 멈추게 하지 않고, 현재 세션에서는 계속 기억한다.
    }
    if (!isCurrentNavigation(navigationGeneration)) return;
    recentQuestionIds = nextRecentQuestionIds;

    lastRound = round;
    registeredId = null;

    const session = createSession({
      questions,
      mode: round.mode,
      categoryId: round.categoryId,
    });

    goTo('quiz');
    quizScreen.start(session, { categoryLabel: labelFor(round) });
  }

  function labelFor({ mode, categoryId }: Round): string {
    return mode === 'all' ? ALL_MODE_LABEL : (categoryId ? categoryNames.get(categoryId) ?? '' : '');
  }

  // ── 결과 ───────────────────────────────────────────────────────

  async function showResult(session: QuizSession): Promise<void> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    const summary = summarizeRound({
      questions: session.getQuestions(),
      answers: session.getAnswers(),
      mode: session.mode,
      categoryId: session.categoryId,
    });

    const target: RankingTarget = { mode: summary.mode, category: summary.categoryId };

    // 최고 점수는 이번 기록을 저장하기 전에 읽어야 비교가 성립한다 (FR-5.7)
    const [bestScore, nickname] = await Promise.all([
      rankingStore.getBestScore(target),
      preferences.getNickname(),
    ]);
    if (!isCurrentNavigation(navigationGeneration)) return;

    // playedAt은 판이 끝난 시각이다. 닉네임을 입력한 시각이 아니다
    pending = { summary, target, playedAt: new Date().toISOString() };
    registeredId = null;

    resultScreen.show({
      summary,
      modeLabel: labelFor({ mode: summary.mode, categoryId: summary.categoryId }),
      bestScore,
      nickname,
      characterId,
      inRoom: Boolean(activeRoomCode),
    });
    goTo('result');
  }

  /**
   * 랭킹 등록 (FR-6.1). 저장은 어댑터를 통해서만 한다 (FR-6.8).
   * nickname은 결과 화면이 길이를 검사한 값이다.
   */
  async function registerRecord(nickname: string) {
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

    savedNickname = nickname;
    syncRoomPlayer();
    await preferences.setNickname(nickname); // 다음 판 기본값 (FR-6.11)
    registeredId = outcome.kept ? outcome.record.id : null;
    pending = { summary, target, playedAt };

    return outcome;
  }

  // ── 랭킹 ───────────────────────────────────────────────────────

  async function openRanking(target: RankingTarget | null = null): Promise<void> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    await rankingScreen.show({ target, highlightId: registeredId, characterId });
    if (!isCurrentNavigation(navigationGeneration)) return;
    goTo('ranking');
  }

  // ── 온라인 ─────────────────────────────────────────────────────

  async function openOnline(notice?: string): Promise<void> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    await onlineScreen.show(characterId, notice);
    if (!isCurrentNavigation(navigationGeneration)) return;
    goTo('online');
  }

  async function openWaitingRoom(code: string): Promise<void> {
    const entryGeneration = invalidateWaitingRoomEntry();
    if (onlineMatchRoomCode) stopOnlineMatch();
    activeRoomCode = code;
    try {
      await waitingRoom.show(code, characterId, entryGeneration);
    } catch {
      // 방 정보를 받기 전에 network fetch가 거절될 수 있다. 클릭 handler까지 Promise를
      // 흘리거나 임의의 로컬 방을 만들지 말고, 이유를 보이는 온라인 로비로 돌아간다.
      if (!isCurrentWaitingRoomEntry({
        code,
        activeRoomCode,
        onlineMatchRoomCode,
        entryGeneration,
        currentGeneration: waitingRoomEntryGeneration,
      })) return;
      if (activeRoomCode === code) activeRoomCode = null;
      await openOnline('방 정보를 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
      return;
    }
    // 방이 사라졌으면 `show` 가 `onLeave` 로 로비에 되돌려 놓고 activeRoomCode 를
    // 비운다. 그때 대기실로 옮기면 방금 되돌아온 것을 무르는 셈이다
    if (!isCurrentWaitingRoomEntry({
      code,
      activeRoomCode,
      onlineMatchRoomCode,
      entryGeneration,
      currentGeneration: waitingRoomEntryGeneration,
    })) return;

    // 새로고침/재접속한 참가자는 start event를 못 봤을 수 있다. Socket event는
    // invalidation일 뿐이므로 동일한 REST snapshot recovery로만 active match를 연다.
    const recovered = await resumeActiveNetworkMatch(code, entryGeneration);
    if (recovered || !isCurrentWaitingRoomEntry({
      code,
      activeRoomCode,
      onlineMatchRoomCode,
      entryGeneration,
      currentGeneration: waitingRoomEntryGeneration,
    })) return;
    goTo('waiting');
  }

  // ── 내 캐릭터 ──────────────────────────────────────────────────

  function openCharacters(): void {
    charactersScreen.show(characterId);
    goTo('characters');
  }

  // ── 시작 ───────────────────────────────────────────────────────

  const notes: string[] = [];
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

main().catch((error: unknown) => {
  console.error('[앱 시작 실패]', error);
  const message = error instanceof Error ? error.message : String(error);
  showFatalError(`예상치 못한 오류로 게임을 시작하지 못했습니다: ${message}`);
});
