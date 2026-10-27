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
import { reviewAnswered, summarizeRound } from './core/scoring.js';
import {
  buildOnlineRecordsExport,
  buildRecordsExport,
  recordsExportFileName,
} from './core/records-export.js';
import { preferences, rankingStore } from './storage/adapter.js';
import { playToggleOn, setEnabled as setSoundEnabled } from './audio.js';
import { announce, showScreen, type ScreenName } from './ui/screens.js';
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
import {
  roomStore,
  type OnlineBestScores,
  type OnlineFinishedMatch,
  type OnlineRankingPeriod,
} from './online/adapter.js';
import { createHomeRoomNote } from './online/home-room-note.js';
import { createOnlineMatchController } from './online/match-controller.js';
import { isCurrentWaitingRoomEntry, recoverActiveNetworkMatch } from './online/match-recovery.js';
import { playAgainInRoom } from './online/rematch.js';
import { createRoomKeepalive } from './online/room-keepalive.js';
import { nicknameProblem } from './online/nickname-rules.js';
import { isNicknameRejection, normalizeCode, onlineErrorText, REMOVED_BY_HOST_MESSAGES } from './online/rules.js';
import {
  dockNoticeNote,
  OFFLINE_NO_PRACTICE_MESSAGE,
  OFFLINE_PRACTICE,
  practiceNote,
  practiceRetryDelay,
  practiceStillMessage,
  probeResult,
  soloQuestionTime,
  soloStillRunningMessage,
  type DockNoticeKind,
  type HomePlayMode,
  type PlayProbe,
  type PracticeReason,
} from './online/solo-play.js';
import { createOnlineQuizScreen } from './ui/online-quiz.js';
import { createOnlineResultScreen } from './ui/online-result.js';
import { createQuizScreen, trapFocus } from './ui/quiz.js';
import { createArena } from './ui/arena.js';
import { createResultScreen } from './ui/result.js';
import { createQuizReviewScreen } from './ui/quiz-review.js';
import { createRankingScreen, type RankingScope } from './ui/ranking.js';
import { createCharactersScreen } from './ui/characters-screen.js';
import { withTopic } from './ui/korean.js';
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
  // 모듈이 15초 넘게 걸려 실패 카드가 먼저 떴어도 늦게 뜬 앱이 그 흔적을 거둔다 (local-ux-3)
  document.body.classList.remove('is-boot-slow', 'is-boot-failed');
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
  // 모듈이 다 왔다 — 실패 안내의 15초를 여기서 다시 센다. 문제 JSON 은 10초에 끊기므로 아직 받는 중인데
  // «불러오지 못했어요»가 뜨지 않고, 끝은 markBooted·showFatalError 가 낸다 (local-ux-3)
  window.__bootProgress?.();
  const { banks, failedCategories } = await loadQuestionBanks();
  const categoryNames = new Map(CATEGORIES.map((category) => [category.id, category.name]));

  // 카테고리가 모두 비면 할 수 있는 게 없다. 이유를 화면으로 알린다 (상세는 loader 가 콘솔에 남겼다)
  if (CATEGORIES.every((category) => (banks[category.id] ?? []).length === 0)) {
    showFatalError('문제를 불러오지 못했어요', '연결을 확인하고 다시 시도해 주세요.');
    return;
  }

  const settings = await preferences.getSettings();

  // ── 혼자 푸는 온라인 판 (FR-7.13 3단계, 소유자 방향: 혼자 하기를 없애고 온라인에서 혼자 푼다) ──
  // 홈의 분야 칸·전체 도전이 무엇을 여는지. 세션의 `soloPlay`를 아는 API면 혼자 온라인 판, 모르는 이전 API면
  // 예전 혼자 하기(로컬), 서버에 닿지 않으면 연습(기록 안 남음, PRD 10.2 #1의 기본값)이다. 아직 묻지 않았으면
  // `checking` — 누르면 답을 기다렸다 고른다. 「게임 방법」이 만들어지며 곧바로 읽으므로 대화상자들보다 먼저 둔다
  let playMode: HomePlayMode = roomStore.isNetworked ? 'checking' : 'practice';
  let practiceReason: PracticeReason | null = roomStore.isNetworked ? null : 'no-server';
  /** 서버의 내 판마다 최고 기록 (홈의 별 점수, FR-2.3). 혼자 온라인 판을 아는 API에서만 채운다 */
  let serverBest: OnlineBestScores = {};
  /** 묻는 중인 요청과 그 답. 겹쳐 보내지 않는다 */
  let probing: Promise<{ probe: PlayProbe; wasPractice: boolean }> | null = null;
  /** 연습 중 다시 연결을 묻는 시계와 그 차례 (30초 → 1분 → 2분) */
  let practiceRetryTimer: number | undefined;
  let practiceRetryAttempt = 0;
  /** 지금 들어가 있는 혼자 방. 대기실이 없는 방이라 `activeRoomCode`와 따로 둔다 */
  let soloRoomCode: string | null = null;
  /**
   * 결과 화면이 **지금 보이는** 혼자 판의 방과 그 판 종류. 「다시 하기」·「홈으로」·「온라인 랭킹 보기」가 쓴다.
   * 그 화면의 것이다 — 친구와 푼 판의 결과를 보이거나 결과 화면을 떠나면(closers) 비운다. 남아 있으면 다음 친구 방
   * 결과의 「한 판 더」가 혼자 판을 열었다
   */
  let soloResult: { code: string; round: Round } | null = null;
  /** 홈 dock 줄에 잠시 띄운 알림 (요청 한도에 걸린 혼자 판·사라진 혼자 판). 연습 안내가 있으면 그것이 먼저다 */
  let dockNotice: { kind: DockNoticeKind; round: Round | null } | null = null;
  /** 혼자 판을 여는 중이다. 겹쳐 열지 않는다 */
  let soloStarting = false;
  /** 나가는 중인 혼자 방. 그 사이 홈이 목록을 읽어도 다시 나가거나 «풀던 혼자 판»으로 보이지 않는다 */
  const leavingSolo = new Set<string>();

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
  // 온라인 한 줄은 세션을 열 때 서버가 알려 준 규칙을 말한다. 묻기 전이면 어느 API든 맞는 말이다 (U13)
  const rulesDialog = createRulesDialog({
    getTimeLimit: () => timeLimitMs,
    getOnlineRules: () => roomStore.onlineRules(),
    // 「혼자 하기」 줄들은 분야 칸이 지금 여는 판의 규칙이다 (FR-7.13 3단계). 아직 묻는 중이면 예전 말이다
    getPlayMode: () => (playMode === 'online' ? 'online' : playMode === 'practice' ? 'practice' : 'local'),
  });

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
  /** 그 판이 연습(기록 안 남음)이었는가. 결과 화면이 기록하지 않는다 (FR-7.13 3단계) */
  let lastRoundPractice = false;

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
  /** 마지막으로 연 대기실. 그 세대가 아직 이기고 있으면 그 방의 대기실에 있거나 들어가는 중이다 */
  let waitingRoomEntry: { code: string; generation: number } | null = null;
  /** 방금 등록한 기록 ID. 랭킹 화면에서 강조한다 (FR-6.5) */
  let registeredId: string | null = null;

  // ── 화면 ───────────────────────────────────────────────────────

  // 쓰고 있는 캐릭터. 없는 id가 저장돼 있어도 findCharacter가 기본값으로 되돌린다
  let characterId = findCharacter(settings.characterId ?? DEFAULT_CHARACTER_ID).id;
  const currentPlayer = () => ({ nickname: savedNickname, characterId });
  const syncRoomPlayer = (): void => { roomStore.setPlayer(currentPlayer()); };
  syncRoomPlayer();

  const homeScreen = createHomeScreen({
    // 분야 칸·전체 도전 (FR-7.13 3단계): 혼자 온라인 판·예전 혼자 하기·연습 가운데 지금의 것을 연다
    onSelectCategory: (categoryId) => playRound({ mode: 'category', categoryId }),
    onStartAll: () => playRound({ mode: 'all', categoryId: null }),
    onOpenRanking: () => openRanking(),
    onOpenCharacters: () => openCharacters(),
    onOpenOnline: () => openOnline(),
    onReturnToRoom: (code, solo) => {
      // 풀던 혼자 판은 대기실이 아니라 그 판으로 돌아간다. 끝났으면 결과, 없으면 홈이 그렇다고 말한다
      if (solo) void resumeSolo(code);
      else void openWaitingRoom(code);
    },
    // 안내 줄의 행동: 연습이면 다시 묻고(«다시 연결»·«다시 확인»·«다시 시도»), 알림이면 그 알림의 일이다
    onRetryOnline: () => { void pressDockNote(); },
    onNickname: (value) => {
      savedNickname = value;
      syncRoomPlayer();
      preferences.setNickname(value);
      // 닉네임 때문에 연습이었으면 새 이름으로 다시 묻는다
      if (playMode === 'practice' && practiceReason === 'nickname') void probePlayMode();
    },
    // 문제 은행 알림의 「다시 불러오기」 (U06). 분야 하나만 다시 받는 길은 두지 않는다 — 새로 읽는다
    onReload: () => window.location.reload(),
  });

  // 홈의 «「방」 방에 아직 있어요» 줄 (U35). 언제 묻는지는 online/home-room-note.ts 가 정한다
  const homeRoomNote = createHomeRoomNote({
    isNetworked: roomStore.isNetworked,
    lastRoomCode,
    saveLastRoomCode: (code) => { void preferences.setLastRoomCode(code); },
    // 혼자 방(FR-7.13 3단계)은 판이 도는 동안만 «풀던 혼자 판»이다. 판이 끝난 혼자 방은 돌아갈 까닭이 없어 조용히
    // 나간다(방이 지워진다) — 결과 화면을 닫거나 새로고침해 「홈으로」를 거치지 않은 방이다
    myRooms: async () => {
      const rooms = await roomStore.myRooms();
      const kept: Array<{ code: string; name: string; solo?: boolean; label?: string }> = [];
      for (const room of rooms) {
        if (room.solo !== true) {
          kept.push({ code: room.code, name: room.name });
        } else if (leavingSolo.has(room.code)) {
          // 「홈으로」가 이미 나가는 중이다
        } else if (room.status === 'playing' && room.inMatch) {
          // 판 이름(분야·전체 도전)을 함께 말한다 — 고른 칸과 다른 판이 도는 까닭이 보인다
          kept.push({
            code: room.code,
            name: room.name,
            solo: true,
            label: labelFor(room.categoryId === null
              ? { mode: 'all', categoryId: null }
              : { mode: 'category', categoryId: room.categoryId }),
          });
        } else if (room.code !== onlineMatchRoomCode && soloResult?.code !== room.code) {
          void leaveSoloRoom(room.code);
        }
      }
      return kept;
    },
    activeRoomCode: () => activeRoomCode ?? soloRoomCode,
    navigation: () => waitingRoomEntryGeneration,
    show: (room) => {
      homeScreen.setRoomNote(room);
      // 방을 물으며 세션을 열었다. 이제 이 API가 몇 명부터 여는지 안다
      homeScreen.setOnlineMinPlayers(roomStore.onlineRules()?.minPlayers ?? null);
    },
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
        // 서버 없이 연 화면의 로컬 방이다 — 연습(기록 안 남음)이면 그 판도 연습이다 (FR-7.13 3단계)
        { practice: playMode === 'practice' },
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

  /** 판을 그만두고 나가는 곳. 방에서 시작한 판이면 그만둘 때도 대기실로 돌아간다 */
  const leaveRound = (): void => {
    if (activeRoomCode) void openWaitingRoom(activeRoomCode);
    else void goHome();
  };

  const quizScreen = createQuizScreen({
    onExit: leaveRound,
    onComplete: showResult,
    // 나가기 확인의 «나가고 푼 문제 해설 보기» (N04). 기록하지 않는다 (FR-3.6)
    onReview: showAnsweredReview,
  });

  quizScreen.setCharacter(characterId);

  // 중간에 나온 판의 «푼 문제» (N04). 떠나는 곳은 나가기와 같다
  const quizReviewScreen = createQuizReviewScreen({ onLeave: leaveRound });

  // 결과 화면은 아직 남기지 않은 기록을 저장한 **뒤에** 이 콜백들을 부른다 (FR-6.1).
  // 옮기기를 마칠 때까지 기다릴 수 있게 Promise를 돌려준다
  const resultScreen = createResultScreen({
    // 연습 판의 「다시 하기」는 지금의 판 종류를 다시 고른다 — 그사이 서버가 다시 답하면 혼자 온라인 판이다
    onRetry: () => (lastRound ? (lastRoundPractice ? playRound(lastRound) : startRound(lastRound)) : goHome()),
    onHome: goHome,
    onRoom: () => (activeRoomCode ? openWaitingRoom(activeRoomCode) : goHome()),
    // 방금 남긴 이 브라우저의 기록을 짚어 보인다 — 온라인 랭킹이 아니라 이 브라우저의 기록 범위다
    onRanking: () => openRanking(pending?.target ?? null, { scope: 'local' }),
    onRegister: registerRecord,
  });

  const rankingScreen = createRankingScreen({
    onHome: goHome,
    // 빈 탭에서 그 탭의 판을 곧바로 연다 (FR-6.12). 홈의 분야 칸과 같은 판이다(혼자 온라인 판·예전 혼자 하기·연습)
    onStart: (target) => playRound(
      target.mode === 'all'
        ? { mode: 'all', categoryId: null }
        : { mode: 'category', categoryId: target.category },
    ),
    // 홈의 분야 칸(`card.disabled`)·전체 도전(`startAll.disabled`)과 같은 규칙이다
    canStart: (target) => (target.mode === 'all'
      ? allModeCount() > 0
      : (target.category ? banks[target.category]?.length ?? 0 : 0) > 0),
    // 지금 분야 칸이 연습(기록 안 남음)을 연다 — 빈 탭이 «시작하면 기록이 남는다»고 약속하지 않는다
    isPractice: () => playMode === 'practice',
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
    // 온라인 랭킹 (FR-7.13 2단계). 서버가 채점한 온라인 판의 기록이다 — 저장소는 여기서만 부르고 화면은 보일 말만
    // 받는다. 랭킹을 모르는 이전 API(세션에 `rankings: true`가 없다)와 로컬 방이면 화면이 온라인 랭킹을 숨긴다
    online: {
      available: () => (roomStore.isNetworked ? roomStore.onlineRules()?.rankings ?? null : false),
      load: async (target, period) => {
        try {
          const result = await roomStore.getOnlineRankings({ target, period });
          return result.supported ? { status: 'ok', board: result.board } : { status: 'unsupported' };
        } catch (error) {
          return {
            status: 'error',
            message: onlineErrorText(error, '연결을 확인하고 다시 시도해 주세요.'),
            // 저장된 닉네임이 금칙 규칙에 걸려 세션을 열지 못했다. 다시 시도해도 같으니 닉네임을 고칠 홈으로 보낸다
            action: isNicknameRejection(error) ? 'home' : 'retry',
          };
        }
      },
      onOpenOnline: () => { void openOnline(); },
      // 혼자 하기가 온라인으로 옮겼다 (FR-7.13 3단계). 이 브라우저의 기록은 «예전 기록»이 되고 내보내기는 서버 기록이다
      onlineOnly: () => roomStore.onlineRules()?.soloPlay === true,
      exportRecords: async () => {
        const result = await roomStore.getMyOnlineRecords();
        if (!result.supported || result.records.length === 0) return null;
        const now = new Date();
        return {
          fileName: recordsExportFileName(savedNickname, now),
          data: buildOnlineRecordsExport({
            records: result.records.map((record) => ({
              mode: record.target.mode,
              category: record.target.category,
              score: record.score,
              correctCount: record.correctCount,
              totalCount: record.totalCount,
              questionTimeMs: record.questionTimeMs,
              nickname: record.nickname,
              recordedAt: record.recordedAt,
            })),
            nickname: savedNickname,
            now,
            limit: result.limit,
            truncated: result.truncated,
          }),
        };
      },
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
    // 시간이 끝나면 답이 될 발밑 칸 (U13). 저장소가 그 소켓의 서버가 받는지 다시 보고 보낸다
    onStandingAnswer: (draft) => {
      const code = onlineMatchRoomCode;
      if (!code || !ownsOnlineMatchNavigation()) return;
      roomStore.sendStandingAnswer({ code, ...draft });
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
      const code = onlineMatchRoomCode;
      stopOnlineMatch();
      // 혼자 판은 로비 목록에 없다. 홈의 «이어 풀기» 줄이 그 판으로 돌아가는 길이다 — 판은 서버에서 계속된다
      if (code !== null && code === soloRoomCode) {
        void goHome();
        return;
      }
      onlineQuizScreen.setNotice('온라인 로비를 불러오는 중이에요.');
      void openOnline('매치는 계속 진행돼요. 목록의 「들어가기」로 다시 돌아올 수 있어요.');
    },
    onFinished: showOnlineFinal,
  });
  onlineQuizScreen.setCharacter(characterId);

  const onlineResultScreen = createOnlineResultScreen({
    // 혼자 푼 판의 «다시 하기»는 같은 혼자 방에서 곧바로 새 판을 연다(대기실이 없다). `soloResult`는 지금 보이는
    // 결과가 혼자 판일 때만 있다 — 친구와 푼 판의 「한 판 더」는 언제나 그 방의 대기실이다
    onAgain: () => (soloResult ? startSoloOnline(soloResult.round) : playAgain()),
    onRoom: () => {
      if (activeRoomCode) void openWaitingRoom(activeRoomCode);
      else void openOnline();
    },
    // 혼자 푼 판의 «홈으로»는 혼자 방을 나간다 — 마지막 사람이 나가 방이 지워진다. 친구와 푼 판은 예전처럼 방에 남는다
    onHome: () => {
      leaveSoloResult();
      void goHome();
    },
    getPlayerId: () => roomStore.me(),
    // 이 판이 남은 이번 주 랭킹을 연다 (FR-7.13 2단계). 결과 화면을 떠나므로 방 소켓은 closers가 놓는다. 혼자 판의
    // 결과에서 떠나면 «홈으로»와 같이 혼자 방을 나간다 — 돌아올 결과 화면이 없다
    onOpenRanking: (target) => {
      leaveSoloResult();
      void openRanking(target, { scope: 'online', period: 'week' });
    },
  });

  /** 혼자 판의 결과 화면을 떠난다 — 그 혼자 방을 나가 지운다(«홈으로»·«온라인 랭킹 보기») */
  function leaveSoloResult(): void {
    const solo = soloResult;
    soloResult = null;
    if (solo) void leaveSoloRoom(solo.code);
  }
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
      // 풀던 혼자 판이 없다(오래 비워 정리됐다). 방을 나가고 홈에서 그렇다고 말한다 — 눈으로도(dock 알림) 낭독으로도
      if (code !== null && code === soloRoomCode) {
        void leaveSoloRoom(code);
        void goHome().then(() => {
          if (currentScreen !== 'home') return;
          setDockNotice({ kind: 'missing', round: null });
          announce('풀던 혼자 판을 찾지 못했어요. 다시 골라 시작해 주세요.');
        });
        return;
      }
      if (code && activeRoomCode === code) void openWaitingRoom(code);
      else void openOnline('진행 중인 온라인 매치를 찾지 못했어요.');
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
      // 발밑 칸 초안이 지금 닿는지 (U13). 끊긴 동안 상태 줄이 «서 있는 칸이 답»을 그대로 약속하지 않게
      else if (event.type === 'standing-delivery') onlineQuizScreen.setStandingDelivery(event.deliverable);
      else onlineQuizScreen.updateChat(event);
    },
  });

  /** finished ranking 역시 server snapshot만 받는다. local ranking store에 쓰지 않는다. */
  function showOnlineFinal(snapshot: OnlineFinishedMatch): void {
    const code = onlineMatchRoomCode;
    stopOnlineMatch();
    if (code !== null && code === soloRoomCode) {
      // 혼자 푼 판 (FR-7.13 3단계): «다시 하기»(같은 혼자 방의 새 판)·«홈으로»(방을 나가 지운다). 대기실이 없고 방 소켓을
      // 붙들 까닭도 없다(남이 들어와 판을 열 수 없다). 최고 기록 비교는 서버가 이 판을 빼고 센 값이 오면 채운다
      soloResult = {
        code,
        round: snapshot.categoryId === null
          ? { mode: 'all', categoryId: null }
          : { mode: 'category', categoryId: snapshot.categoryId },
      };
      onlineResultScreen.show(snapshot, { inRoom: true, solo: true });
      goTo('online-result');
      if (snapshot.rankingRecorded === true) void showSoloBest(snapshot);
      return;
    }
    // 「한 판 더」·「대기실로」는 아직 들어가 있는 방으로 돌아간다. 방 밖이면 「한 판 더」를 그리지 않는다.
    // 이 결과는 혼자 판이 아니다 — 앞서 본 혼자 판의 결과가 「한 판 더」를 가로채지 않게 비운다
    soloResult = null;
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
   * 혼자 푼 판의 최고 기록 비교 (FR-5.7). 서버가 이 판의 기록을 빼고 센 내 최고 점수와 견준다 — 이 판은 이미 기록됐다.
   * 홈의 별 점수도 그 자리에서 이 판까지 넣어 둔다. 읽지 못하면 줄을 두지 않는다(지어내지 않는다)
   */
  async function showSoloBest(snapshot: OnlineFinishedMatch): Promise<void> {
    const board = snapshot.categoryId ?? 'all';
    try {
      const result = await roomStore.getMyBestScores({ excludeMatchId: snapshot.matchId });
      if (!result.supported) return;
      const previous = result.best[board];
      onlineResultScreen.setBest(snapshot.matchId, previous ? previous.score : null);
      const mine = snapshot.scores.find(({ playerId }) => playerId === roomStore.me());
      if (mine && (!previous || mine.score > previous.score)) {
        serverBest = {
          ...serverBest,
          [board]: {
            score: mine.score,
            correctCount: mine.correctCount,
            totalCount: snapshot.totalQuestions,
            recordedAt: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      console.warn('[혼자 판] 최고 기록을 읽지 못했습니다', error);
    }
  }

  /**
   * 「한 판 더」 (U38). 방장이 아니면 대기실을 열기 전에 준비를 켜 둔다(`online/rematch.ts`). 기다리는
   * 사이 홈·대기실로 등 다른 행동을 눌렀으면 그쪽이 이긴다 — 늦게 끝난 준비가 화면을 옮기지 않고, 그 방의
   * 대기실로 간 것이 아니면 서버에 닿은 준비도 되돌린다(online-flow-1).
   */
  async function playAgain(): Promise<void> {
    const code = activeRoomCode;
    if (!code) {
      await openOnline();
      return;
    }
    const navigation = waitingRoomEntryGeneration;
    await playAgainInRoom({
      store: roomStore,
      code,
      isStillCurrent: () => isCurrentNavigation(navigation) && activeRoomCode === code,
      isInWaitingRoom: () => waitingRoomEntry?.code === code
        && isCurrentNavigation(waitingRoomEntry.generation) && activeRoomCode === code,
      openWaitingRoom: () => openWaitingRoom(code),
    });
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
  async function openOnlineMatch(code: string, { notice }: { notice?: string } = {}): Promise<void> {
    if (!roomStore.isNetworked) return;
    if (onlineMatchRoomCode === code && ownsOnlineMatchNavigation()) return;
    stopOnlineMatch();
    onlineMatchRoomCode = code;
    // 혼자 판이면 채팅과 혼자인 점수판을 거둔다 (FR-7.13 3단계)
    onlineQuizScreen.setSolo(code === soloRoomCode);
    onlineQuizScreen.startPresence();
    onlineQuizScreen.setNotice('매치를 불러오는 중이에요.');
    goTo('online-quiz');
    onlineMatchNavigationGeneration = waitingRoomEntryGeneration;
    await onlineMatchController?.open(code);
    // 보인 뒤에 알린다 — 숨은 화면의 상태 줄은 낭독되지 않는다 (이어 푸는 혼자 판)
    if (notice && ownsOnlineMatchNavigation()) announce(notice);
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
    'quiz-review': () => quizReviewScreen.hide(),
    'online-result': () => {
      resultKeepalive.release();
      // 혼자 판의 결과는 이 화면의 것이다. 떠나면(다시 하기가 다른 화면으로 옮김·뒤로·연결 실패) 비운다 — 판이 끝난
      // 혼자 방은 다음 홈이 조용히 나간다(homeRoomNote의 myRooms)
      soloResult = null;
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
    // 분야 칸이 무엇을 여는지 다시 묻는다 (FR-7.13 3단계). 혼자 온라인 판이면 별 점수(내 최고 기록)를 새로 읽고,
    // 연습 중이면 서버가 다시 답하는지 본다
    void probePlayMode();
  }

  /** 지금의 판 종류로 홈의 별 점수 (FR-2.3). 혼자 온라인 판은 서버의 내 최고 기록, 예전 혼자 하기는 이 브라우저의 기록 */
  async function homeBestScores(): Promise<Partial<Record<CategoryId | 'all', number | null>>> {
    if (playMode === 'local') return loadBestScores();
    if (playMode !== 'online') return {};
    const scores: Partial<Record<CategoryId | 'all', number | null>> = {};
    for (const [board, best] of Object.entries(serverBest) as Array<[CategoryId | 'all', OnlineBestScores[CategoryId]]>) {
      scores[board] = best ? best.score : null;
    }
    return scores;
  }

  /**
   * 분야 칸이 여는 것을 바꾼다 (FR-7.13 3단계). 홈의 이름·캡션·안내 줄·별 점수, 설정의 문항 시간 도움말이 함께
   * 따른다. 연습이고 다시 연결할 길이 있으면 홈이 보이는 동안 물러서며 다시 묻는다
   */
  function setPlayMode(mode: HomePlayMode, reason: PracticeReason | null = null): void {
    playMode = mode;
    practiceReason = mode === 'practice' ? reason : null;
    // 연습이면 그 안내가 먼저다. 알림(요청 한도·사라진 판)은 연습과 함께 두지 않는다 — 까닭이 달라졌다
    if (mode === 'practice') dockNotice = null;
    renderPlayView();
    settingsDialog.setOnlineSolo(roomStore.onlineRules()?.soloPlay === true);
    void homeBestScores().then((scores) => {
      if (playMode === mode) homeScreen.setBestScores(scores);
    });
    clearTimeout(practiceRetryTimer);
    practiceRetryTimer = undefined;
    if (mode !== 'practice') {
      practiceRetryAttempt = 0;
      return;
    }
    if (reason !== 'offline' && reason !== 'full') return;
    // 서버가 다시 답하면 온라인으로 돌아온다. 홈이 보이고 탭이 보일 때만 묻는다 (30초 → 1분 → 2분)
    const delay = practiceRetryDelay(practiceRetryAttempt);
    practiceRetryAttempt += 1;
    practiceRetryTimer = window.setTimeout(() => {
      practiceRetryTimer = undefined;
      if (currentScreen === 'home' && document.visibilityState !== 'hidden') void probePlayMode();
      else setPlayMode('practice', reason);
    }, delay);
  }

  /** 홈의 판 종류·dock 안내 줄을 그린다. 연습 안내가 있으면 그것, 없으면 잠시 띄운 알림이다 */
  function renderPlayView(): void {
    const practice = playMode === 'practice' && practiceReason !== null ? practiceNote(practiceReason) : null;
    const note = practice && practice.action !== null
      ? { text: practice.text, action: practice.action }
      : (playMode !== 'practice' && dockNotice ? dockNoticeNote(dockNotice.kind) : null);
    homeScreen.setPlayMode({
      practice: playMode === 'practice' && OFFLINE_PRACTICE,
      note,
      soloOnline: playMode === 'online',
    });
  }

  /** dock 알림을 띄우거나(null이면) 거둔다. 누른 줄이 사라지면 홈이 포커스를 분야 dock으로 옮긴다 */
  function setDockNotice(notice: typeof dockNotice): void {
    dockNotice = notice;
    renderPlayView();
  }

  /** dock 안내 줄을 눌렀다. 연습이면 다시 묻고, 요청 한도 알림이면 같은 판을 다시 열고, 사라진 판 알림이면 거둔다 */
  async function pressDockNote(): Promise<void> {
    if (playMode === 'practice') {
      await probePlayMode({ busy: true });
      return;
    }
    const notice = dockNotice;
    if (notice?.kind === 'limited' && notice.round) {
      await playRound(notice.round);
      return;
    }
    setDockNotice(null);
  }

  /**
   * 이 API가 혼자 온라인 판을 아는지·서버에 닿는지 묻는다 (FR-7.13 3단계). 내 최고 기록 요청 하나가 세션을 열어 규칙을
   * 배우고(`soloPlay`) 별 점수도 받는다. 서버 없이 연 화면은 묻지 않는다(늘 연습). 겹쳐 묻지 않는다
   */
  async function probePlayMode({ busy = false }: { busy?: boolean } = {}): Promise<void> {
    if (!roomStore.isNetworked) return;
    if (!probing) {
      probing = (async () => {
        let probe: PlayProbe;
        try {
          const result = await roomStore.getMyBestScores();
          if (result.supported) serverBest = result.best;
          probe = probeResult({ supported: result.supported });
        } catch (error) {
          console.warn('[혼자 판] 온라인을 확인하지 못했습니다', error);
          // 앞서 배운 규칙으로 정한다. 모르면(요청 한도·규칙 전에 지은 닉네임으로 세션을 열지 못했다) 오늘의 혼자
          // 하기다 — 이 기능을 모르는 API일 수 있다. 판 종류는 언제나 정해진다(`checking`에 남지 않는다)
          probe = probeResult({ error }, roomStore.onlineRules());
        }
        const wasPractice = playMode === 'practice';
        setPlayMode(probe.mode, probe.mode === 'practice' ? probe.reason : null);
        return { probe, wasPractice };
      })();
    }
    if (busy) homeScreen.setPlayBusy(true);
    try {
      const { probe, wasPractice } = await probing;
      // 누른 사람에게 결과를 말한다 — 다시 물어도 연습이면 눈으로 보는 줄이 그대로라 아무 일도 없어 보였다.
      // 이미 돌던 물음(물러서는 재시도)에 얹혀도 누른 사람은 듣는다
      if (busy) {
        if (probe.mode === 'practice') announce(practiceStillMessage(probe.reason));
        else if (probe.refused) announce(probe.refused);
        else if (wasPractice) announce('온라인에 다시 연결됐어요.');
      }
    } finally {
      probing = null;
      if (busy) homeScreen.setPlayBusy(false);
    }
  }

  /**
   * 홈의 분야 칸·전체 도전·빈 랭킹 탭이 여는 판 (FR-7.13 3단계). 아직 묻는 중이면 답을 기다린다. 혼자 온라인 판을 아는
   * API면 그 판, 모르는 이전 API면 예전 혼자 하기(로컬, 기록), 서버에 닿지 않으면 연습(기록 안 남음)이다
   */
  async function playRound(round: Round): Promise<void> {
    if (playMode === 'checking') await probePlayMode({ busy: true });
    if (playMode === 'online') {
      await startSoloOnline(round);
      return;
    }
    if (playMode === 'practice') {
      // 결정 #1의 다른 길(연습을 열지 않는다)이면 알리기만 한다
      if (!OFFLINE_PRACTICE && practiceReason !== 'no-server') {
        announce(OFFLINE_NO_PRACTICE_MESSAGE);
        return;
      }
      await startRound(round, undefined, { practice: true });
      return;
    }
    // `local`이다. 물음은 언제나 판 종류를 정하므로 `checking`이 남을 수 없지만, 남았다면 이 API가 아는지 모르는 것이라
    // 오늘의 혼자 하기를 연다 — 분야 칸이 아무 일도 하지 않는 일은 없다
    await startRound(round);
  }

  /**
   * 혼자 푸는 온라인 판을 곧바로 연다 (FR-7.13 3단계). 대기실을 거치지 않는다 — 서버가 그 사람의 혼자 방을 다시 쓰거나
   * 만들고 판을 연다(POST /v1/solo). 문항 시간은 설정의 20초·40초이고 «제한 없음»이면 20초다(PRD 10.2 #2). 이미 판이
   * 돌고 있으면 그 판을 잇는다. 서버에 닿지 않으면 홈을 연습으로 바꾸고 그렇다고 말한다(PRD 10.2 #1)
   */
  async function startSoloOnline(round: Round): Promise<void> {
    if (soloStarting) return;
    soloStarting = true;
    const navigation = invalidateWaitingRoomEntry();
    homeScreen.setPlayBusy(true);
    try {
      let result;
      try {
        result = await roomStore.startSolo({
          categoryId: round.categoryId,
          questionTimeMs: soloQuestionTime(timeLimitMs),
        });
      } catch (error) {
        console.warn('[혼자 판] 판을 열지 못했습니다', error);
        const probe = probeResult({ error }, roomStore.onlineRules());
        if (probe.mode === 'practice') {
          setPlayMode('practice', probe.reason);
          const message = probe.reason === 'nickname'
            ? onlineErrorText(error, '홈에서 닉네임을 바꿔 주세요.')
            : !OFFLINE_PRACTICE
              ? OFFLINE_NO_PRACTICE_MESSAGE
              : probe.reason === 'full'
                ? '지금은 혼자 판 자리가 모두 찼어요. 연습(기록 안 남음)은 할 수 있어요.'
                : '온라인에 연결할 수 없어요. 연습(기록 안 남음)은 할 수 있어요.';
          if (currentScreen !== 'home' && isCurrentNavigation(navigation)) await goHome();
          announce(message);
        } else if (probe.mode === 'local') {
          // 이 API가 혼자 판을 아는지 모른다(세션을 열지 못했다) — 오늘의 혼자 하기로 연다
          setPlayMode('local');
          if (isCurrentNavigation(navigation)) await startRound(round);
        } else {
          // 서버가 지금은 거절했다(요청 한도). 홈의 dock 줄이 눈으로도 말하고 «다시 시도»가 같은 판을 다시 연다 —
          // 결과·랭킹 화면에서 눌렀으면 홈으로 가서 보인다(그 화면에는 말할 자리가 없다)
          if (currentScreen !== 'home' && isCurrentNavigation(navigation)) await goHome();
          if (currentScreen === 'home') setDockNotice({ kind: 'limited', round });
          announce(probe.refused ?? '잠시 후 다시 시도해 주세요.');
        }
        return;
      }
      if (!result.ok) {
        // 이 API는 혼자 온라인 판을 모른다 — 예전 혼자 하기로 돌아간다
        setPlayMode('local');
        if (isCurrentNavigation(navigation)) await startRound(round);
        return;
      }
      const { code } = result.room;
      // 판은 서버에서 돈다. 새로고침한 뒤의 홈이 «이어 풀기»를 물을 수 있게 흔적을 남긴다 (server-5)
      homeRoomNote.enter(code);
      soloRoomCode = code;
      soloResult = null;
      if (dockNotice) setDockNotice(null);
      // 그사이 다른 화면으로 옮겼으면 그 화면을 빼앗지 않는다. 판은 홈의 «이어 풀기»로 돌아올 수 있다
      if (!isCurrentNavigation(navigation)) return;
      if (result.resumed && result.room.categoryId !== round.categoryId) {
        // 풀던 혼자 판이 아직 돈다 — 고른 것과 다른 판이다. 말없이 그 판을 열면 «한국사»를 누른 사람이 까닭 없이
        // «과학» 판에 들어간다. 홈에 남아 그 판으로 돌아갈 줄을 보이고 까닭을 말한다(판은 마감까지 계속된다)
        await showSoloStillRunning(code, result.room.name, result.room.categoryId);
        return;
      }
      await openOnlineMatch(code, {
        notice: result.resumed ? '진행 중이던 혼자 판을 이어서 풀어요.' : undefined,
      });
    } finally {
      soloStarting = false;
      homeScreen.setPlayBusy(false);
    }
  }

  /**
   * 고른 판과 다른 혼자 판이 아직 돈다 (`resumed`). 홈에 그 판의 «이어 풀기» 줄을 곧바로 보이고(다시 묻지 않는다) 까닭을
   * 알린다. 결과·랭킹 화면에서 눌렀으면 홈으로 간다 — 그 화면에는 그 줄이 없다
   */
  async function showSoloStillRunning(code: string, name: string, categoryId: CategoryId | null): Promise<void> {
    const label = labelFor(categoryId === null ? { mode: 'all', categoryId: null } : { mode: 'category', categoryId });
    if (currentScreen !== 'home') await goHome();
    if (currentScreen !== 'home') return;
    homeRoomNote.present({ code, name, solo: true, label });
    announce(soloStillRunningMessage(label));
  }

  /** 홈의 «풀던 혼자 판» 줄 (FR-7.13 3단계). 그 판으로 돌아간다 — 그사이 끝났으면 결과, 없으면 홈이 말한다 */
  async function resumeSolo(code: string): Promise<void> {
    soloRoomCode = code;
    soloResult = null;
    homeRoomNote.enter(code);
    await openOnlineMatch(code);
  }

  /**
   * 혼자 방을 나간다(«홈으로», 끝난 혼자 방 정리). 마지막 사람이 나가 방이 지워지고 서버의 표시도 함께 사라진다. 못 나가도
   * 막지 않는다 — 30분 정리가 지우고, 다음 홈이 다시 나간다
   */
  async function leaveSoloRoom(code: string): Promise<void> {
    if (soloRoomCode === code) soloRoomCode = null;
    homeRoomNote.leave(code);
    if (leavingSolo.has(code)) return;
    leavingSolo.add(code);
    try {
      await roomStore.leaveRoom({ code });
    } catch (error) {
      console.warn('[혼자 판] 혼자 방을 나가지 못했습니다', error);
    } finally {
      leavingSolo.delete(code);
    }
  }

  /** 홈을 그려 연다. 그리는 사이 다른 화면으로 옮겼으면 false */
  async function showHome(): Promise<boolean> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    // 홈으로 가도 방에서 나가지는 않는다. 다만 매치 socket은 닫아 재접속 경계를 분명히 한다.
    stopOnlineMatch();
    const bestScores = await homeBestScores();
    if (!isCurrentNavigation(navigationGeneration)) return false;
    // 지난 홈에 띄운 알림은 그때의 것이다. 새 홈에서 다시 띄울 까닭이 있으면 부른 쪽이 그 뒤에 띄운다
    dockNotice = null;
    renderPlayView();
    // 온라인 입구의 보조 줄: 혼자서도 여는 API인지는 세션을 연 뒤에야 안다(묻기 전이면 어느 쪽이든 맞는 말)
    homeScreen.setOnlineMinPlayers(roomStore.onlineRules()?.minPlayers ?? null);
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
    { practice = false }: { practice?: boolean } = {},
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
      homeScreen.setNote('이 카테고리에는 출제할 문제가 없어요.');
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
    lastRoundPractice = practice;
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
    // 연습 판은 HUD의 분야 칩이 그렇다고 말한다 — 기록이 남지 않는다 (FR-7.13 3단계)
    quizScreen.start(session, { categoryLabel: practiceLabel(labelFor(round), practice), pinRules });
  }

  /** 연습 판의 이름표: «연습 · 과학». 퀴즈 HUD·결과·«푼 문제»가 같은 말을 쓴다 */
  function practiceLabel(label: string, practice: boolean): string {
    return practice ? `연습 · ${label}` : label;
  }

  function labelFor({ mode, categoryId }: Round): string {
    return mode === 'all' ? ALL_MODE_LABEL : (categoryId ? categoryNames.get(categoryId) ?? '' : '');
  }

  // ── 중간에 나온 판의 푼 문제 (N04) ──────────────────────────────

  /**
   * 나가기 확인의 «나가고 푼 문제 해설 보기». **기록하지 않는다** (FR-3.6) — 끝까지 풀지 않은 판이라
   * `pending` 을 만들지 않고 `registerRecord`·`getBestScore` 를 부르지 않는다. 결과 화면이 아니므로
   * 떠날 때의 자동 저장(FR-6.1, `pagehide` 의 `flush` 포함)도 타지 않는다. 최근 출제 기록(FR-1.4)은
   * 판을 열 때 이미 남았다 — 나가기와 같다.
   */
  function showAnsweredReview(session: QuizSession): void {
    const review = reviewAnswered({
      questions: session.getQuestions(),
      answers: session.getAnswers(),
      mode: session.mode,
      categoryId: session.categoryId,
    });
    quizReviewScreen.show({
      review,
      modeLabel: practiceLabel(labelFor({ mode: session.mode, categoryId: session.categoryId }), lastRoundPractice),
      characterId,
      inRoom: Boolean(activeRoomCode),
    });
    goTo('quiz-review');
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
    const modeLabel = labelFor({ mode: summary.mode, categoryId: summary.categoryId });

    // 연습 판 (FR-7.13 3단계, PRD 10.2 #1의 기본값)은 기록하지 않는다 — 최고 점수를 읽지도, 등록할 판을 들지도 않는다
    if (lastRoundPractice) {
      pending = null;
      registeredId = null;
      resultScreen.show({
        summary,
        modeLabel: practiceLabel(modeLabel, true),
        bestScore: null,
        nickname: savedNickname,
        characterId,
        inRoom: Boolean(activeRoomCode),
        practice: true,
      });
      goTo('result');
      return;
    }

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
      modeLabel,
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
    if (!pending) throw new Error('등록할 기록이 없어요');

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

    // 이 브라우저의 기록은 적은 이름 그대로 남긴다. 다만 홈의 닉네임(온라인 프로필·다음 판 기본값, FR-6.11)으로
    // 올리는 것은 금칙 규칙(PRD 12.1)을 지나는 이름뿐이다 — 홈의 대화상자가 막는 이름이 이 길로 온라인 닉네임이
    // 되면 온라인의 모든 길이 «홈에서 닉네임을 바꿔 주세요»로 막혔다. 결과 화면이 그렇다고 말한다
    if (nicknameProblem(nickname) === null) {
      savedNickname = nickname;
      syncRoomPlayer();
      await preferences.setNickname(nickname);
    }
    registeredId = outcome.kept ? outcome.record.id : null;
    pending = { summary, target, playedAt, timeLimitMs: roundLimit };

    return outcome;
  }

  // ── 랭킹 ───────────────────────────────────────────────────────

  /**
   * 랭킹을 연다. scope를 주면 그 범위(온라인 랭킹·이 브라우저의 기록)이고, 없으면 이 페이지에서 마지막으로 본
   * 범위(처음이면 온라인 랭킹이 있을 때 온라인)다. 온라인 랭킹은 불러오는 중인 상태를 그린 뒤 곧바로 연다 —
   * 응답을 기다리느라 홈의 입구가 멈춘 것처럼 보이지 않게
   */
  async function openRanking(
    target: RankingTarget | null = null,
    { scope, period }: { scope?: RankingScope; period?: OnlineRankingPeriod } = {},
  ): Promise<void> {
    const navigationGeneration = invalidateWaitingRoomEntry();
    await rankingScreen.show({ target, highlightId: registeredId, characterId, scope, period });
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
    waitingRoomEntry = { code, generation: entryGeneration };
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
    notes.push(`문제를 불러오지 못한 카테고리가 있어요: ${names}`);
  }

  // 은행이 출제 수보다 적으면 그만큼만 낸다. 짧은 판이 버그로 보이지 않게 미리 알린다
  const short = CATEGORIES.filter((category) => {
    const size = banks[category.id]?.length ?? 0;
    return size > 0 && size < QUESTIONS_PER_ROUND;
  });
  if (short.length > 0) {
    const names = short.map((category) => category.name).join(', ');
    // 조사는 마지막 이름의 받침으로 고른다 — «과학는»이 아니라 «과학은»
    notes.push(`${withTopic(names)} 문제가 ${QUESTIONS_PER_ROUND}개보다 적어 있는 만큼만 출제돼요.`);
  }

  if (notes.length > 0) homeScreen.setNote(notes.join(' '));

  // 분야 칸이 무엇을 여는지 처음 그려 두고 서버에 묻는다 (FR-7.13 3단계). 서버 없이 연 화면은 늘 연습이다. 답을
  // 기다리지 않는다 — 부팅이 늦지 않게, 홈은 답이 오면 이름·별 점수만 고친다(goHome도 같은 물음을 기다린다)
  setPlayMode(playMode, practiceReason);
  void probePlayMode();

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
