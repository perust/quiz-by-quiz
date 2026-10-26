// 진입점. 데이터 로딩과 화면 흐름을 연결한다.
// 게임 규칙은 core/, 그리기는 ui/, 저장은 storage/ 가 맡고 여기서는 셋을 잇기만 한다.

import {
  CATEGORIES,
  DEFAULT_NICKNAME,
  QUESTIONS_PER_CATEGORY_IN_ALL,
  QUESTIONS_PER_ROUND,
  RECENT_QUESTION_MEMORY,
  RULE_HINT_ROUNDS,
  TIME_LIMIT_MS,
} from './constants.js';
import { loadQuestionBanks } from './data/loader.js';
import { buildAllRound, buildRound } from './core/sampler.js';
import { createSession, type QuizSession } from './core/session.js';
import { summarizeRound } from './core/scoring.js';
import { buildRecordsExport, recordsExportFileName } from './core/records-export.js';
import { preferences, rankingStore } from './storage/adapter.js';
import { playToggleOn, setEnabled as setSoundEnabled } from './audio.js';
import { showScreen, type ScreenName } from './ui/screens.js';
import {
  backStepFor,
  closeDialog,
  createBackGuard,
  isGuardState,
  openDialog,
  pressControl,
  setUnloadWarning,
} from './ui/back-guard.js';
import { createHomeScreen } from './ui/home.js';
import { createOnlineScreen } from './ui/online.js';
import { createWaitingRoom } from './ui/waiting-room.js';
import { createChatMutes } from './ui/chat-mutes.js';
import { roomStore, type OnlineFinishedMatch } from './online/adapter.js';
import { createHomeRoomNote } from './online/home-room-note.js';
import { createOnlineMatchController } from './online/match-controller.js';
import { isCurrentWaitingRoomEntry, recoverActiveNetworkMatch } from './online/match-recovery.js';
import { readyForRematch } from './online/rematch.js';
import { createRoomKeepalive } from './online/room-keepalive.js';
import { normalizeCode, REMOVED_BY_HOST_MESSAGES } from './online/rules.js';
import { createOnlineQuizScreen } from './ui/online-quiz.js';
import { createOnlineResultScreen } from './ui/online-result.js';
import { createQuizScreen, trapFocus } from './ui/quiz.js';
import { createArena } from './ui/arena.js';
import { createResultScreen } from './ui/result.js';
import { createRankingScreen } from './ui/ranking.js';
import { createCharactersScreen } from './ui/characters-screen.js';
import { applyMotionPreference, createSettingsDialog } from './ui/settings-dialog.js';
import { createRulesDialog } from './ui/rules-dialog.js';
import { DEFAULT_CHARACTER_ID, findCharacter } from './characters.js';
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
  /** 그 판의 문항 시간. 기본(20초)이 아니면 기록에 함께 남긴다 (FR-3.7) */
  timeLimitMs: number | null;
}

/**
 * index.html의 인라인 스크립트가 걸어둔 타이머를 끄고 앱을 보인다.
 * **문제를 받고 홈을 그리기 직전에 부른다** (U05) — 일찍 보이면 문제를 받는 동안 빈 dock과
 * 눌러도 아무 일 없는 버튼이 보였다. 그동안은 부팅 화면의 «불러오는 중…»이 자리를 지킨다.
 * 이 함수가 불리지 못하면(모듈 로드 실패·느린 망) 인라인 스크립트의 안내가 뜬다.
 */
function markBooted(): void {
  clearTimeout(window.__bootTimer);
  document.body.classList.remove('is-boot-slow');
  document.body.classList.add('is-booted');
}

/**
 * 앱을 띄울 수 없을 때. 콘솔에만 남기지 않고 화면으로 알린다 (U05).
 *
 * **플레이어의 말로 쓴다.** 예전에는 «data 폴더의 JSON 파일»과 오류 message를 그대로 보였다 —
 * 개발 상세는 콘솔에만 남긴다. 부팅 화면의 실패 카드(`.boot__error--net`)가 「다시 시도」를 이미
 * 갖고 있어 제목과 이유만 고쳐 쓴다. file:// 의 개발자 안내는 인라인 스크립트만 띄운다.
 */
function showFatalError(title: string, message: string): void {
  clearTimeout(window.__bootTimer);
  const body = document.body.classList;
  body.remove('is-booted', 'is-boot-slow', 'is-boot-file');
  // 먼저 펼치고 넣는다 — 숨긴 채로 채운 role="alert" 는 낭독되지 않는다
  body.add('is-boot-failed');
  const heading = document.getElementById('boot-error-title');
  const reason = document.getElementById('boot-error-body');
  if (heading) heading.textContent = title;
  if (reason) reason.textContent = message;
}

/**
 * 초대 링크(`?room=CODE`)의 코드 (U27). **부팅 때 한 번만** 읽고 주소에서 지운다 —
 * 남겨 두면 새로고침할 때마다 같은 방에 다시 들어가려 한다. 해시 라우팅은 두지 않으며
 * (새로고침하면 홈), 비밀번호는 링크에 싣지 않는다.
 */
function takeInviteCode(): string | null {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('room');
  if (raw === null) return null;
  url.searchParams.delete('room');
  try {
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // 주소를 못 고쳐도 초대는 받는다. 새로고침하면 한 번 더 열릴 뿐이다
  }
  return normalizeCode(raw) || null;
}

async function main(): Promise<void> {
  const inviteCode = takeInviteCode();

  // 이 동안은 부팅 화면이 보인다. 앱은 홈을 그리기 직전에 연다(markBooted, U05)
  const { banks, failedCategories } = await loadQuestionBanks();
  const categoryNames = new Map(CATEGORIES.map((category) => [category.id, category.name]));

  // 카테고리가 모두 비면 할 수 있는 게 없다. 이유를 화면으로 알린다 (상세는 loader 가 콘솔에 남겼다)
  if (CATEGORIES.every((category) => (banks[category.id] ?? []).length === 0)) {
    showFatalError('문제를 불러오지 못했어요', '연결을 확인하고 다시 시도해 주세요.');
    return;
  }

  const settings = await preferences.getSettings();

  // ── 설정 (U42·U54·U55) ─────────────────────────────────────────
  // 앱 바의 「설정」 대화상자. 고르는 순간 적용하고 저장한다.
  /** 새로 여는 로컬 판의 문항 시간 (FR-3.7). 도는 판은 연 순간의 값을 지킨다. 온라인은 방장이 방에 고른 20초·40초다 */
  let timeLimitMs = settings.timeLimitMs;
  setSoundEnabled(settings.soundEnabled);
  applyMotionPreference(settings.reduceMotion);
  const settingsDialog = createSettingsDialog({
    onChange: (patch) => {
      if (patch.soundEnabled !== undefined) {
        setSoundEnabled(patch.soundEnabled);
        // 켰으면 그 자리에서 한 음 들려준다 (U54). 클릭 안이라 브라우저가 소리를 막지 않는다
        if (patch.soundEnabled) playToggleOn();
      }
      if (patch.timeLimitMs !== undefined) timeLimitMs = patch.timeLimitMs;
      if (patch.reduceMotion !== undefined) applyMotionPreference(patch.reduceMotion);
      void preferences.setSettings(patch);
    },
    // 대화상자 뒤에서 퀴즈 시간이 끝났으면 퀴즈가 「다음 문제」로 포커스를 이어 간다
    onClose: () => quizScreen.resumeAfterDialog(),
  });
  settingsDialog.set(settings);

  // 「게임 방법」 (U01). 홈에서 판을 열기 전에 읽는다 — 시간이 흐르지 않는다. 문항 시간은 지금 고른 값이다
  const rulesDialog = createRulesDialog({ getTimeLimit: () => timeLimitMs });

  // 직전 판 문제 ID (FR-1.4). 1단계의 메모리 변수에서 저장소로 옮겼다
  let recentQuestionIds = await preferences.getRecentQuestionIds();
  /** 무대 아래 규칙 줄을 접지 않고 보인 로컬 판 수 (U01). 처음 RULE_HINT_ROUNDS 판만 짧은 화면에서도 남긴다 */
  let ruleHintRounds = await preferences.getRuleHintRounds();

  // 랭킹에 쓰던 닉네임을 온라인 방에서도 그대로 쓴다. 이름을 두 번 묻지 않는다
  const storedNickname = await preferences.getNickname();
  let savedNickname = storedNickname || DEFAULT_NICKNAME;
  // 저장된 이름이 없으면 기본 이름을 한 번 저장해 둔다. 홈 HUD·결과 등록 칸·온라인 프로필이
  // 모두 같은 값을 읽는다 — 전에는 홈에 «퀴즈왕»이 보이는데 등록 칸은 비어 있었다 (FR-6.11)
  if (!storedNickname) await preferences.setNickname(savedNickname);
  /** 마지막으로 들어간 온라인 방. 부팅 때 홈의 «아직 방에 있어요»를 물어볼지 정한다 (server-5) */
  const lastRoomCode = await preferences.getLastRoomCode();

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
  const currentPlayer = () => ({ nickname: savedNickname, characterId });
  const syncRoomPlayer = (): void => { roomStore.setPlayer(currentPlayer()); };
  syncRoomPlayer();

  const homeScreen = createHomeScreen({
    onSelectCategory: (categoryId) => startRound({ mode: 'category', categoryId }),
    onStartAll: () => startRound({ mode: 'all', categoryId: null }),
    onOpenRanking: () => openRanking(),
    onOpenCharacters: () => openCharacters(),
    onOpenOnline: () => openOnline(),
    onReturnToRoom: (code) => { void openWaitingRoom(code); },
    onNickname: (value) => {
      savedNickname = value;
      syncRoomPlayer();
      preferences.setNickname(value);
    },
    // 문제 은행 알림의 「다시 불러오기」 (U06). 분야 하나만 다시 받는 길은 두지 않는다 — 새로 읽는다
    onReload: () => window.location.reload(),
  });

  // 홈의 «「방」 방에 아직 있어요» 줄 (U35). 언제 묻는지는 online/home-room-note.ts 가 정한다
  const homeRoomNote = createHomeRoomNote({
    isNetworked: roomStore.isNetworked,
    lastRoomCode,
    saveLastRoomCode: (code) => { void preferences.setLastRoomCode(code); },
    myRooms: () => roomStore.myRooms(),
    activeRoomCode: () => activeRoomCode,
    navigation: () => waitingRoomEntryGeneration,
    show: (room) => homeScreen.setRoomNote(room),
  });

  // 온라인 로비. 방을 어디에 두는지는 어댑터가 정하고 화면은 모른다
  const onlineScreen = createOnlineScreen({
    roomStore,
    onHome: goHome,
    onPractice: () => { void practiceAlone(); },
    onEnterRoom: (code) => openWaitingRoom(code),
    getPlayer: () => ({ nickname: savedNickname, characterId }),
  });

  // «이 사람 말 숨기기» (N06). 대기실과 그 방의 온라인 퀴즈가 같은 목록을 본다. 이 페이지의
  // 메모리에만 있고 서버에도 저장소에도 가지 않는다
  const chatMutes = createChatMutes();

  // 대기실. server-authoritative event로 시작을 알리고, 독립 개발 문서에서는
  // 동일한 adapter contract를 따르는 local implementation이 한 판을 연다.
  const waitingRoom = createWaitingRoom({
    chatMutes,
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
      // 스스로 나왔든 방이 사라졌든 그 방은 이제 돌아갈 곳이 아니다. 홈의 줄과 부팅 흔적을 거둔다 (U35)
      homeRoomNote.leave(code);
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

  // 결과 화면은 아직 남기지 않은 기록을 저장한 **뒤에** 이 콜백들을 부른다 (FR-6.1).
  // 옮기기를 마칠 때까지 기다릴 수 있게 Promise를 돌려준다
  const resultScreen = createResultScreen({
    onRetry: () => (lastRound ? startRound(lastRound) : goHome()),
    onHome: goHome,
    onRoom: () => (activeRoomCode ? openWaitingRoom(activeRoomCode) : goHome()),
    onRanking: () => openRanking(pending?.target ?? null),
    onRegister: registerRecord,
  });

  const rankingScreen = createRankingScreen({
    onHome: goHome,
    // 빈 탭에서 그 탭의 판을 곧바로 연다 (FR-6.12)
    onStart: (target) => startRound(
      target.mode === 'all'
        ? { mode: 'all', categoryId: null }
        : { mode: 'category', categoryId: target.category },
    ),
    // 홈의 분야 칸(`card.disabled`)·전체 도전(`startAll.disabled`)과 같은 규칙이다
    canStart: (target) => (target.mode === 'all'
      ? allModeCount() > 0
      : (target.category ? banks[target.category]?.length ?? 0 : 0) > 0),
    loadRankings: (target) => rankingStore.getRankings(target),
    clearRankings: () => rankingStore.clearAll(),
    // 선생님께 낼 기록 파일 (N02). 저장소는 여기서만 부른다 — 화면은 받은 파일을 내려받기만 한다
    exportRecords: async () => {
      const targets: RankingTarget[] = [
        { mode: 'all', category: null },
        ...CATEGORIES.map((category) => ({ mode: 'category' as const, category: category.id })),
      ];
      const lists = await Promise.all(targets.map((target) => rankingStore.getRankings(target)));
      const now = new Date();
      return {
        fileName: recordsExportFileName(savedNickname, now),
        data: buildRecordsExport({ records: lists.flat(), nickname: savedNickname, now }),
      };
    },
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
    onMovement: (sample) => {
      const code = onlineMatchRoomCode;
      if (!code || !ownsOnlineMatchNavigation()) return;
      roomStore.sendMovement({ code, ...sample });
    },
    onSendChat: async (text) => {
      const code = onlineMatchRoomCode;
      if (!code || !ownsOnlineMatchNavigation()) return { ok: false };
      const result = await roomStore.sendChat({ code, text, player: currentPlayer() });
      if (code !== onlineMatchRoomCode || !ownsOnlineMatchNavigation()) return { ok: false };
      return result;
    },
    getPlayerId: () => roomStore.me(),
    // 대기실에서 숨긴 사람의 말은 매치 중에도 그리지 않는다 (N06)
    isChatHidden: (playerId) => onlineMatchRoomCode !== null
      && chatMutes.isMuted(onlineMatchRoomCode, playerId),
    onExit: () => {
      stopOnlineMatch();
      onlineQuizScreen.setNotice('온라인 로비를 불러오는 중입니다.');
      void openOnline('매치는 계속 진행돼요. 목록의 「들어가기」로 다시 돌아올 수 있어요.');
    },
    onFinished: showOnlineFinal,
  });
  onlineQuizScreen.setCharacter(characterId);

  const onlineResultScreen = createOnlineResultScreen({
    onAgain: () => playAgain(),
    onRoom: () => {
      if (activeRoomCode) void openWaitingRoom(activeRoomCode);
      else void openOnline();
    },
    onHome: () => { void goHome(); },
    getPlayerId: () => roomStore.me(),
  });
  /** 최종 순위를 읽는 동안 방 소켓을 붙든다. 1분 넘게 읽어도 «연결 끊김»이 되지 않게 (U24) */
  const resultKeepalive = createRoomKeepalive(roomStore);

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
    onPresenceEvent: (event) => {
      if (!ownsOnlineMatchNavigation()) return;
      if (event.type === 'room') onlineQuizScreen.setRoom(event.room);
      else if (event.type === 'movement') onlineQuizScreen.updateMovement(event);
      else onlineQuizScreen.updateChat(event);
    },
  });

  /** finished ranking 역시 server snapshot만 받는다. local ranking store에 쓰지 않는다. */
  function showOnlineFinal(snapshot: OnlineFinishedMatch): void {
    const code = onlineMatchRoomCode;
    stopOnlineMatch();
    // 「한 판 더」·「대기실로」는 아직 들어가 있는 방으로 돌아간다. 방 밖이면 「한 판 더」를 그리지 않는다
    onlineResultScreen.show(snapshot, { inRoom: activeRoomCode !== null });
    goTo('online-result');
    // 아직 그 방에 있으면 소켓을 이어 붙든다. 화면을 떠나면 closers가 놓는다 — 대기실로 가면
    // 대기실이 제 구독을 연 뒤에 놓는다(다시 붙는 잠깐은 60초 유예 안이다). 홈·로비로 가면
    // 방에 남아 있어도 놓는다 — 홈은 방 밖이라는 기존 계약 그대로다
    if (!roomStore.isNetworked || !code || code !== activeRoomCode) return;
    resultKeepalive.hold(code, () => {
      // 결과를 보는 사이 그 방에서 새 판이 열렸다. 그 판에 넣어졌는지는 서버 snapshot만
      // 판정한다 — 대기실 복구와 같은 길이다. 넣어지지 않았으면 결과 화면에 그대로 남는다
      void recoverActiveNetworkMatch(code, {
        getMatch: (roomCode) => roomStore.getMatch(roomCode),
        isStillCurrent: () => currentScreen === 'online-result'
          && activeRoomCode === code && resultKeepalive.heldCode() === code,
        hasOpenMatch: () => onlineMatchRoomCode === code,
        openMatch: openOnlineMatch,
      });
    }, (kind) => {
      // 결과를 보는 사이 방장이 나를 내보냈다. 대기실에서 내보내진 것과 같은 길이다 — 홈의 줄과
      // 부팅 흔적을 거두고 로비에서 이유를 말한다(「한 판 더」·「대기실로」는 이제 갈 곳이 없다)
      if (currentScreen !== 'online-result' || activeRoomCode !== code) return;
      activeRoomCode = null;
      homeRoomNote.leave(code);
      void openOnline(REMOVED_BY_HOST_MESSAGES[kind]);
    });
  }

  /**
   * 「한 판 더」 (U38). 방장이 아니면 대기실을 열기 전에 준비를 켜 둔다(`online/rematch.ts`). 기다리는
   * 사이 홈·대기실로 등 다른 행동을 눌렀으면 그쪽이 이긴다 — 늦게 끝난 준비가 화면을 옮기지 않는다.
   */
  async function playAgain(): Promise<void> {
    const code = activeRoomCode;
    if (!code) {
      await openOnline();
      return;
    }
    const navigation = waitingRoomEntryGeneration;
    await readyForRematch(roomStore, code);
    if (!isCurrentNavigation(navigation) || activeRoomCode !== code) return;
    await openWaitingRoom(code);
  }

  function stopOnlineMatch(): void {
    // 마지막 정지 좌표는 controller가 socket을 닫기 전에 보낸다.
    onlineQuizScreen.stopPresence();
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
    onlineQuizScreen.startPresence();
    onlineQuizScreen.setNotice('매치를 불러오는 중이에요.');
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
    'online-result': () => {
      resultKeepalive.release();
      onlineResultScreen.hide();
    },
    ranking: () => rankingScreen.hide(),
    online: () => onlineScreen.hide(),
    waiting: () => waitingRoom.hide(),
    characters: () => charactersScreen.hide(),
  };

  /** 지금 보이는 화면. goTo 만 바꾼다 */
  let currentScreen: ScreenName = 'home';
  /** 브라우저 «뒤로»의 안전망. 화면을 옮길 때마다 goTo 가 알린다 */
  const backGuard = createBackGuard(window.history);

  function goTo(name: ScreenName): void {
    if (name !== 'waiting') invalidateWaitingRoomEntry();
    for (const [key, close] of Object.entries(closers)) {
      if (key !== name) close();
    }
    // 설정은 어느 화면에서나 열린다. 화면이 바뀌면(매치 시작 등) 새 화면 위에 남기지 않는다.
    // 「게임 방법」은 홈에서만 열리지만 같은 이유로 접는다
    settingsDialog.dismiss();
    rulesDialog.dismiss();
    showScreen(name);
    currentScreen = name;
    // 브라우저 «뒤로»가 앱 밖으로 나가지 않게 히스토리 상태만 남긴다. 주소는 그대로다
    backGuard.enter(name);
    // 새로고침·탭 닫기 확인은 로컬 판이 진행 중일 때만 (FR-3.6)
    setUnloadWarning(name === 'quiz');
  }

  // ── 뒤로 가기 ──────────────────────────────────────────────────
  //
  // 홈이 아닌 화면에서 시스템 「뒤로」나 뒤로 스와이프를 하면 앱 밖으로 나가 풀던 판과
  // 결과가 통째로 사라졌다. 이제는 popstate 로 돌아와 그 화면의 뒤로·나가기 버튼을
  // 누른 것과 같이 움직인다 — 퀴즈는 나가기 확인, 결과는 자동 저장 뒤 홈.

  window.addEventListener('popstate', (event) => {
    const dialog = openDialog();
    const step = backStepFor(currentScreen, {
      dialogOpen: dialog !== null,
      landedOnGuard: isGuardState(event.state),
    });

    if (step.kind === 'leave') {
      // 홈에 남아 있던 guard 를 지나 페이지를 연 자리에 닿았다. 사용자는 앱을 나가려던 것이다
      history.back();
      return;
    }
    if (step.kind === 'stay') {
      backGuard.enter(currentScreen);
      return;
    }
    // 그 밖에는 이 화면을 계속 지키며 시작한다. 확인을 무르거나 옮기는 중에 또 「뒤로」를
    // 눌러도 앱 밖으로 나가지 않는다. 다른 화면으로 옮기면 goTo 가 이 자리를 바꿔 쓴다
    if (currentScreen !== 'home') backGuard.rearm(currentScreen);

    switch (step.kind) {
      case 'close-dialog':
        if (dialog) closeDialog(dialog);
        break;
      case 'control':
        pressControl(step.id);
        break;
      case 'lobby':
        void openOnline();
        break;
      case 'home':
        void goHome();
        break;
    }
  });

  // 결과 화면에서 탭을 닫거나 새로고침해도 기록을 남긴다 (FR-6.1). 로컬 저장소는 부르는
  // 자리에서 동기로 써지므로 여기서 끝난다 — 서버 구현으로 바꾸면 다른 길이 필요하다
  window.addEventListener('pagehide', () => {
    if (currentScreen === 'result') resultScreen.flush();
  });

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
    if (!(await showHome())) return;
    // 아직 들어가 있는 방을 묻는다 (U35). goTo('home')이 화면 세대를 올린 **뒤에** 불러야 한다 —
    // 그 전의 세대를 쥐면 답이 늘 «지난 화면»으로 읽혀 줄이 한 번도 뜨지 않았다 (online-client-1)
    void homeRoomNote.refresh();
  }

  /** 홈을 그려 연다. 그리는 사이 다른 화면으로 옮겼으면 false */
  async function showHome(): Promise<boolean> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    // 홈으로 가도 방에서 나가지는 않는다. 다만 매치 socket은 닫아 재접속 경계를 분명히 한다.
    stopOnlineMatch();
    const bestScores = await loadBestScores();
    if (!isCurrentNavigation(navigationGeneration)) return false;
    homeScreen.render({
      categories: CATEGORIES,
      banks,
      bestScores,
      allCount: allModeCount(),
      characterId,
      nickname: savedNickname,
    });
    goTo('home');
    return true;
  }

  /** 빈 로비의 「혼자 연습하기」 (U29). 홈으로 가서 분야 dock에 선다 */
  async function practiceAlone(): Promise<void> {
    await goHome();
    homeScreen.focusPractice();
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
      // 설정에서 고른 문항 시간 (FR-3.7). 판이 도는 동안에 바꿔도 다음 판부터 쓴다
      timeLimitMs,
    });

    // 처음 몇 판은 무대 아래 규칙 한 줄을 짧은 화면에서도 접지 않는다 (U01). 판을 여는 순간 센다 —
    // 저장이 막혀도 이 세션 안에서는 세어 둔 값으로 접는다
    const pinRules = ruleHintRounds < RULE_HINT_ROUNDS;
    if (pinRules) {
      ruleHintRounds += 1;
      void preferences.setRuleHintRounds(ruleHintRounds);
    }

    goTo('quiz');
    quizScreen.start(session, { categoryLabel: labelFor(round), pinRules });
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

    // 최고 점수는 이번 기록을 저장하기 전에 읽어야 비교가 성립한다 (FR-5.7).
    // 앞 판을 등록하지 않고 떠났어도 결과 화면이 자동 저장했으므로 그 판까지 들어 있다
    const [bestScore, nickname] = await Promise.all([
      rankingStore.getBestScore(target),
      preferences.getNickname(),
    ]);
    if (!isCurrentNavigation(navigationGeneration)) return;

    // playedAt은 판이 끝난 시각이다. 닉네임을 입력한 시각이 아니다
    pending = { summary, target, playedAt: new Date().toISOString(), timeLimitMs: session.timeLimitMs };
    registeredId = null;

    resultScreen.show({
      summary,
      modeLabel: labelFor({ mode: summary.mode, categoryId: summary.categoryId }),
      bestScore,
      // 등록 칸은 홈 HUD와 같은 이름으로 채운다. 비워 두면 매번 새로 지어야 한다 (FR-6.11)
      nickname: nickname || savedNickname,
      characterId,
      inRoom: Boolean(activeRoomCode),
    });
    goTo('result');
  }

  /**
   * 랭킹 등록 (FR-6.1). 저장은 어댑터를 통해서만 한다 (FR-6.8).
   * nickname은 결과 화면이 길이를 검사한 값이다. 「등록」을 눌렀을 때도, 등록하지 않고
   * 결과 화면을 떠날 때(자동 저장)도 이 한 길로 온다 — 문항별 정오까지 똑같이 남는다.
   * 한 판을 두 번 남기지 않는 것은 결과 화면이 지킨다(저장 하나를 나눠 쓴다).
   *
   * **`saveRecord`까지 기다리는 것이 없다.** 로컬 저장소는 이 호출 안에서 동기로 써져
   * `pagehide`에서 불러도 기록이 남는다. 앞에 await를 넣으면 그 보장이 깨진다.
   */
  async function registerRecord(nickname: string) {
    if (!pending) throw new Error('등록할 기록이 없습니다');

    const { summary, target, playedAt, timeLimitMs: roundLimit } = pending;
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
      // 기본(20초)이 아닌 판만 문항 시간을 남긴다. 랭킹은 나누지 않는다 (점수에 속도가 없다)
      ...(roundLimit === TIME_LIMIT_MS ? {} : { timeLimitMs: roundLimit }),
    });

    savedNickname = nickname;
    syncRoomPlayer();
    await preferences.setNickname(nickname); // 다음 판 기본값 (FR-6.11)
    registeredId = outcome.kept ? outcome.record.id : null;
    pending = { summary, target, playedAt, timeLimitMs: roundLimit };

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

  async function openOnline(notice?: string, invite?: string): Promise<void> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    homeRoomNote.visitOnline();
    // 로비는 목록을 받아 그린 뒤에 연다(내용을 그린 뒤 goTo). 그동안 홈의 입구가 아무
    // 반응이 없어 보이지 않게 바로 바쁨 표시를 단다 (U34)
    homeScreen.setOnlineBusy(true);
    try {
      await onlineScreen.show(characterId, notice);
    } finally {
      homeScreen.setOnlineBusy(false);
    }
    if (!isCurrentNavigation(navigationGeneration)) return;
    goTo('online');
    // 되돌아온 이유(«방장이 방에서 내보냈어요» 등)는 화면이 보인 뒤에 넣어야 낭독된다
    onlineScreen.activate();
    // 화면이 보인 뒤에 넘긴다. 포커스를 비밀번호 칸으로 옮길 수 있어야 한다 (U27)
    if (invite) onlineScreen.acceptInvite(invite);
  }

  async function openWaitingRoom(code: string): Promise<void> {
    const entryGeneration = invalidateWaitingRoomEntry();
    // 방에 들어간다는 흔적을 남긴다. 새로고침한 뒤의 홈이 이것을 보고 돌아갈 방을 묻는다 (server-5)
    homeRoomNote.enter(code);
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
    // show() 동안에는 active-match 복구 요청 때문에 화면이 계속 hidden일 수 있다.
    // 실제 표시 뒤에 미뤄 둔 local/remote walker 좌표를 DOM 기준으로 확정한다.
    waitingRoom.activate();
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

  // 문제를 받았고 화면이 모두 준비됐다. 여기서 앱을 보인다 (U05) — 아래 홈 그리기는 같은 태스크
  // 안에서 끝나 빈 dock이 한 번도 칠해지지 않는다. 보인 뒤에 그려야 홈 워커가 시작 자리를 잰다
  markBooted();

  if (inviteCode) {
    // 초대 링크로 왔으면 홈을 그려 둔 뒤 곧장 로비의 코드 참가로 간다 (U27). 홈의 온라인 입구가
    // «연결 중…»으로 그 사이를 알린다. «아직 방에 있어요»는 여기서 묻지 않는다 — 곧 로비가
    // 목록을 읽고, 로비를 다녀온 뒤의 홈이 다시 묻는다 (server-5)
    await showHome();
    await openOnline(undefined, inviteCode);
  } else {
    await goHome();
  }
}

main().catch((error: unknown) => {
  // 상세는 콘솔에만 남긴다. 화면은 플레이어의 말로 다시 시도를 권한다 (U05)
  console.error('[앱 시작 실패]', error);
  showFatalError('게임을 시작하지 못했어요', '잠시 뒤 다시 시도해 주세요.');
});
