// 대기실 화면
//
// 방에 들어오면 여기로 온다. 참가자가 바닥에 서 있고, 내 캐릭터가 그 사이를
// 걸어 다닌다. 한마디 적으면 캐릭터 위에 말풍선이 뜬다.
//
// **설정은 «누르면 다음 값으로 도는» 버튼이다.** `select`로 두면 캐릭터가 밟아도
// 목록이 열리지 않아 «걸어가서 고른다»가 성립하지 않는다. 분야·인원·시작·나가기가
// 모두 그냥 버튼이라 캐릭터를 겹치고 Enter만 누르면 된다.
//
// **방이 어디에 있는지 이 파일은 모른다.** `roomStore`만 부르고, 무슨 일이 있었는지는
// `subscribe`로 듣는다 — 서버에서 온 남의 말도 같은 길로 들어온다.

import { CATEGORIES, ROOM_CAPACITY_CHOICES } from '../constants.js';
import { need, needOne } from '../dom.js';
import { createScreenWalker } from './screen-walker.js';
import { createLatestRequestGuard } from './latest-request.js';
import {
  createPlayerBubbleController,
  shouldPlacePlayerBubbleBelow,
} from './player-bubbles.js';
import {
  createMovementPublisher,
  createPlayerMovementController,
  normalizeViewportMovement,
} from './player-movement.js';
import {
  isCurrentWaitingRoomAction,
  type WaitingRoomActionOwnership,
} from './waiting-room-action.js';
import { createBody } from './sprite.js';
import type {
  MatchSetup, PlayerInfo, PublicRoom, RoomEvent, RoomPatch, RoomStore,
} from '../online/adapter.js';
import type { CategoryId } from '../types.js';

/** 말풍선이 떠 있는 시간. 짧으면 못 읽고 길면 얼굴을 가린다 */
const BUBBLE_MS = 3200;

/** 화면에 남겨 둘 대화 줄 수. 말풍선이 사라진 뒤에도 이만큼은 다시 볼 수 있다 */
const CHAT_LINES = 4;

/** 설정 버튼이 도는 값. 카테고리 정의와 달리 아이콘·설명이 없다 */
interface RoundCategory {
  id: CategoryId | null;
  name: string;
}

const ALL_CATEGORY: RoundCategory = { id: null, name: '전체 도전' };

export interface WaitingRoomDeps {
  roomStore: RoomStore;
  /**
   * 대기실을 떠난다.
   *
   * `reason` 이 있으면 **내가 나간 것이 아니라 들어갈 수 없어서 되돌아간 것**이다.
   * 로비가 그 말을 띄운다 — 조용히 되돌리면 「들어가기를 눌렀는데 아무 일도
   * 없다」로 보인다.
   */
  onLeave: (code: string, entryGeneration: number, reason?: string) => void;
  /** 방 설정으로 여는 한 판. 방 진입 소유권을 함께 넘겨 늦은 socket event를 가둔다. */
  onStart: (code: string, setup: MatchSetup, entryGeneration: number) => void;
  /** Socket은 invalidation만 알린다. app.ts가 REST snapshot으로 복구 여부를 판정한다. */
  onMatchInvalidated: (code: string, entryGeneration: number) => void;
  getPlayer: () => PlayerInfo;
}

export interface WaitingRoom {
  /** @param code 들어온 방 */
  show(code: string, characterId: string, entryGeneration: number): Promise<void>;
  hide(): void;
}

export function createWaitingRoom(
  { roomStore, onLeave, onStart, onMatchInvalidated, getPlayer }: WaitingRoomDeps,
): WaitingRoom {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="waiting"]'),
    title: need('waiting-title'),
    lead: need('waiting-lead'),
    leave: need<HTMLButtonElement>('waiting-leave'),
    start: need<HTMLButtonElement>('waiting-start'),
    ready: need<HTMLButtonElement>('waiting-ready'),
    category: need<HTMLButtonElement>('setting-category'),
    categoryValue: need('setting-category-value'),
    capacity: need<HTMLButtonElement>('setting-capacity'),
    capacityValue: need('setting-capacity-value'),
    lounge: need('lounge'),
    players: need('lounge-players'),
    remoteCharacters: need('waiting-remote-characters'),
    character: need('waiting-character'),
    bubble: need('waiting-bubble'),
    chatForm: need<HTMLFormElement>('chat-form'),
    chatInput: need<HTMLInputElement>('chat-input'),
    chatSubmit: need<HTMLButtonElement>('chat-submit'),
    chatLog: need('chat-log'),
  };

  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    // 라운지 바닥 한가운데에서 시작한다. 버튼 곁에 세우면 대기실 밖에 선 것처럼 보인다
    startPoint: () => {
      const box = el.lounge.getBoundingClientRect();
      if (box.width === 0) return null;
      return { x: box.left + box.width / 2, y: box.bottom - 18 };
    },
    onMove: (point, moving) => {
      const sample = normalizeViewportMovement(point, moving, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      if (sample) movementPublisher.update(sample);
    },
  });

  /** 지금 있는 방. 화면을 떠나면 비운다 */
  let room: PublicRoom | null = null;
  /** 구독을 끊는 함수 */
  let unsubscribe: (() => void) | null = null;
  /** 늦게 도착한 이전 방 조회/이벤트가 현재 대기실을 덮지 못하게 한다 */
  const showGuard = createLatestRequestGuard();
  /** 현재 화면을 소유한 show 요청. hide/new show에서 즉시 바뀐다. */
  let visibleRequest: number | null = null;
  /** 이 show를 연 앱 navigation generation. 앱의 mutable 현재값을 다시 읽지 않는다. */
  let visibleEntry: { code: string; entryGeneration: number } | null = null;
  /** 같은 composer에서 앞선 POST가 끝나기 전 중복 submit을 막는다. */
  let chatSendPending = false;
  /** 말풍선을 스스로 지우는 타이머. 없으면 undefined — clearTimeout이 그대로 받는다 */
  let bubbleTimer: number | undefined;
  /** room snapshot이 참가자 DOM을 다시 만들어도 아직 살아 있는 남의 말은 유지한다. */
  const remoteBubbles = createPlayerBubbleController({ durationMs: BUBBLE_MS });
  /** room snapshot rerender와 socket reconnect를 건너서 상대 좌표를 보존한다. */
  const remoteMovements = createPlayerMovementController();
  /** 걷는 frame은 125ms(초당 8회)로 합치고, stop은 즉시 보낸다. */
  const movementPublisher = createMovementPublisher({
    send: (sample) => {
      if (!visibleEntry) return;
      roomStore.sendMovement({ code: visibleEntry.code, ...sample });
    },
  });
  /** reconnect한 상대도 정지 위치를 복구할 수 있게 마지막 좌표를 다시 보내는 timer. */
  let movementHeartbeat: number | undefined;
  /** 화면 가장자리 안으로 말풍선을 맞추기 위한 현재 player figure lookup. */
  const remoteBubbleNodes = new Map<string, HTMLElement>();

  // ── 그리기 ─────────────────────────────────────────────────────

  const categories: RoundCategory[] = [ALL_CATEGORY, ...CATEGORIES];

  function render(): void {
    if (!room) return;

    el.title.textContent = room.name;
    el.lead.textContent = `방 코드 ${room.code} · ${room.players.length}/${room.capacity}명`
      + (room.isMine ? ' · 내가 만든 방' : '');

    const category = categories.find((item) => item.id === room!.categoryId) ?? ALL_CATEGORY;
    el.categoryValue.textContent = category.name;
    el.capacityValue.textContent = `${room.capacity}명`;

    const me = room.players.find((player) => player.id === roomStore.me()) ?? null;
    el.ready.disabled = !room.joined || me === null;
    el.ready.textContent = me?.isReady ? '준비 취소' : '준비 완료';
    el.ready.setAttribute('aria-pressed', String(Boolean(me?.isReady)));

    // 방장만 설정을 바꾼다. 판정은 저장소가 하고 화면은 미리 알려 줄 뿐이다
    for (const button of [el.category, el.capacity]) {
      button.disabled = !room.isMine;
    }

    const remotePlayers = room.players.filter((player) => player.id !== roomStore.me());
    remoteMovements.unbindAll();
    remoteMovements.reconcile(remotePlayers.map((player) => player.id));
    remoteBubbles.unbindAll();
    remoteBubbleNodes.clear();
    el.players.replaceChildren();
    el.remoteCharacters.replaceChildren();
    for (const player of room.players) {
      const item = document.createElement('li');
      item.className = 'lounge__player';
      item.dataset.playerId = player.id;

      const figure = document.createElement('span');
      figure.className = 'lounge__figure';
      figure.append(createBody(player.characterId));

      const name = document.createElement('span');
      name.className = 'lounge__name';
      name.textContent = player.nickname;

      const readiness = document.createElement('span');
      readiness.className = 'lounge__ready';
      readiness.textContent = player.isReady ? '준비' : '대기';

      item.append(figure, name, readiness);
      el.players.append(item);

      if (player.id === roomStore.me()) continue;
      const remoteCharacter = document.createElement('div');
      remoteCharacter.className = 'walker walker--home walker--remote';
      remoteCharacter.dataset.movingPlayerId = player.id;
      remoteCharacter.hidden = true;

      // 채팅 로그가 접근성용 live region이므로 시각 말풍선은 중복 낭독하지 않는다.
      const bubble = document.createElement('span');
      bubble.className = 'walker__bubble';
      bubble.setAttribute('aria-hidden', 'true');
      bubble.hidden = true;
      const shadow = document.createElement('span');
      shadow.className = 'walker__shadow';
      const movingName = document.createElement('span');
      movingName.className = 'walker__name';
      movingName.textContent = player.nickname;
      remoteCharacter.append(bubble, shadow, createBody(player.characterId), movingName);
      el.remoteCharacters.append(remoteCharacter);

      remoteBubbleNodes.set(player.id, bubble);
      remoteMovements.bind(player.id, remoteCharacter);
      remoteBubbles.bind(player.id, bubble);
      if (!bubble.hidden) fitChatBubble(bubble);
    }
    movementPublisher.resend();
  }

  // ── 말풍선 ─────────────────────────────────────────────────────

  function showBubble(text: string): void {
    el.bubble.textContent = text;
    // 캐릭터는 화면 맨 위까지 갈 수 있다(앱 바 버튼을 밟으려고 위쪽 한계를 풀었다).
    // 그대로 두면 말풍선이 화면 밖으로 나가 말을 해도 보이지 않는다
    el.bubble.hidden = false;
    fitChatBubble(el.bubble);
    clearTimeout(bubbleTimer);
    // 얼굴을 오래 가리지 않게 스스로 사라진다
    bubbleTimer = setTimeout(() => { el.bubble.hidden = true; }, BUBBLE_MS);
  }

  /** 움직이는 상대 위에 두되 viewport 밖으로 나간 만큼만 안쪽으로 민다. */
  function fitChatBubble(bubble: HTMLElement): void {
    bubble.style.removeProperty('--bubble-shift');
    if (bubble.hidden) return;
    const characterBox = bubble.parentElement?.getBoundingClientRect();
    bubble.classList.remove('walker__bubble--below');
    let bubbleBox = bubble.getBoundingClientRect();
    if (characterBox) {
      bubble.classList.toggle(
        'walker__bubble--below',
        shouldPlacePlayerBubbleBelow(
          bubbleBox.height,
          characterBox.top,
          characterBox.bottom,
          window.innerHeight,
        ),
      );
      bubbleBox = bubble.getBoundingClientRect();
    }
    if (bubbleBox.width === 0) return;
    const inset = 6;
    let shift = 0;
    if (bubbleBox.left < inset) {
      shift = inset - bubbleBox.left;
    } else if (bubbleBox.right > window.innerWidth - inset) {
      shift = window.innerWidth - inset - bubbleBox.right;
    }
    if (shift !== 0) bubble.style.setProperty('--bubble-shift', `${Math.round(shift)}px`);
  }

  /**
   * 대화를 몇 줄 남긴다.
   *
   * 말풍선은 몇 초 뒤 사라지므로 놓친 말을 다시 볼 길이 있어야 한다.
   * `role="log"`라 이 목록이 곧 라이브 리전이고, 말풍선을 볼 수 없는 사람에게는
   * 여기가 대화 그 자체다 — 눈으로도 보이게 두는 이유다.
   */
  function logChat({ nickname, text }: { nickname: string; text: string }): void {
    const line = document.createElement('li');
    line.className = 'chat-log__line';

    const who = document.createElement('span');
    who.className = 'chat-log__who';
    who.textContent = nickname;

    line.append(who, ' ', text);
    el.chatLog.append(line);

    while (el.chatLog.children.length > CHAT_LINES) el.chatLog.firstElementChild!.remove();
  }

  function onEvent(
    event: RoomEvent,
    owner: { code: string; entryGeneration: number },
  ): void {
    if (event.type === 'room') {
      room = event.room;
      render();
      return;
    }
    if (event.type === 'movement') {
      if (event.playerId !== roomStore.me()) {
        remoteMovements.update(event);
        const bubble = remoteBubbleNodes.get(event.playerId);
        if (bubble && !bubble.hidden) fitChatBubble(bubble);
      }
      return;
    }
    // 판이 열렸다. room code도 함께 건넨다. 나간 방의 늦은 event가 지금 방을 열면 안 된다.
    if (event.type === 'match' && event.phase === 'started') {
      if (room) onStart(owner.code, event.setup, owner.entryGeneration);
      return;
    }
    if (event.type === 'match' && event.phase === 'invalidated') {
      // socket payload로 match state를 정하지 않는다. 아직 보이는 이 방의 인증된
      // REST snapshot을 app.ts가 다시 읽어야 한다.
      if (room) onMatchInvalidated(owner.code, owner.entryGeneration);
      return;
    }
    if (event.type !== 'chat') return;

    logChat(event);
    if (event.playerId === roomStore.me()) {
      showBubble(event.text);
    } else {
      remoteBubbles.show(event.playerId, event.text);
      const bubble = remoteBubbleNodes.get(event.playerId);
      if (bubble) fitChatBubble(bubble);
    }
  }

  /** 대화가 아닌 안내. 대화 줄과 결을 달리해 섞이지 않게 한다 */
  function notice(text: string): void {
    const line = document.createElement('li');
    line.className = 'chat-log__line chat-log__line--notice';
    line.textContent = text;
    el.chatLog.append(line);
    while (el.chatLog.children.length > CHAT_LINES) el.chatLog.firstElementChild!.remove();
  }

  // ── 설정 바꾸기 ────────────────────────────────────────────────
  // 누를 때마다 다음 값으로 돈다. 캐릭터가 밟고 Enter만 눌러도 바뀐다

  function captureAction(): WaitingRoomActionOwnership | null {
    if (visibleRequest === null || !room) return null;
    return { request: visibleRequest, code: room.code, snapshot: room };
  }

  function ownsAction(
    action: WaitingRoomActionOwnership,
    requireSameSnapshot = true,
  ): boolean {
    return showGuard.isCurrent(action.request)
      && isCurrentWaitingRoomAction(
        action,
        { request: visibleRequest, room },
        requireSameSnapshot,
      );
  }

  async function patch(change: RoomPatch): Promise<void> {
    const action = captureAction();
    if (!action) return;
    try {
      const result = await roomStore.updateRoom({ code: action.code, patch: change });
      if (!ownsAction(action)) return;
      if (result.ok) {
        room = result.room;
        render();
        return;
      }
      // **실패를 삼키지 않는다.** 바로 아래 「게임 시작」이 이미 이렇게 하는데
      // 설정만 조용하면 눌러도 아무 일이 없어 버튼이 고장 난 것처럼 보인다.
      // 방장이 아닌 경우는 `render` 가 버튼을 잠가 두므로 실제로 여기 오는 것은
      // 대기실에 있는 사이 방이 사라진 때다.
      notice(result.reason === 'not-host'
        ? '방장만 방 설정을 바꿀 수 있어요.'
        : '그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.');
    } catch {
      if (!ownsAction(action)) return;
      notice('방 설정을 바꾸지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
    }
  }

  el.category.addEventListener('click', () => {
    const index = categories.findIndex((item) => item.id === room?.categoryId);
    patch({ categoryId: categories[(index + 1) % categories.length].id });
  });

  el.capacity.addEventListener('click', () => {
    if (!room) return;
    // 지금 있는 사람보다 작게는 줄일 수 없다. 그런 값을 건너뛰지 않으면
    // 눌러도 아무 일이 없어 버튼이 고장 난 것처럼 보인다
    const usable = ROOM_CAPACITY_CHOICES.filter((size) => size >= room!.players.length);
    if (usable.length <= 1) {
      notice(`지금 ${room.players.length}명이 있어 인원을 더 줄일 수 없어요.`);
      return;
    }
    const index = usable.indexOf(room.capacity);
    patch({ capacity: usable[(index + 1) % usable.length] });
  });


  el.ready.addEventListener('click', async () => {
    const action = captureAction();
    if (!action) return;
    const me = action.snapshot.players.find((player) => player.id === roomStore.me());
    if (!me) {
      notice('이 방의 참가자 정보가 갱신됐어요. 방 목록으로 돌아가 다시 참가해 주세요.');
      return;
    }
    try {
      const result = await roomStore.setReady({ code: action.code, isReady: !me.isReady });
      if (!ownsAction(action)) return;
      if (result.ok) {
        room = result.room;
        render();
        return;
      }
      notice(result.reason === 'game-in-progress'
        ? '이미 게임이 진행 중이라 준비 상태를 바꿀 수 없어요.'
        : result.reason === 'not-member'
          ? '먼저 이 방에 참가해 주세요.'
          : '그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.');
    } catch {
      if (!ownsAction(action)) return;
      notice('준비 상태를 바꾸지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
    }
  });

  // 여기서 판을 열지 않는다. 저장소에 «열어 달라»고 하고, 열렸다는 이벤트를
  // 받아서 움직인다 (onEvent 참고). 그래야 서버가 붙었을 때 방에 있는 모두가
  // 같은 순간에 같은 길로 시작한다
  el.start.addEventListener('click', async () => {
    const action = captureAction();
    if (!action) return;
    try {
      const result = await roomStore.startGame({ code: action.code });
      if (!ownsAction(action)) return;
      if (!result.ok) {
        notice(result.reason === 'not-host'
          ? '방장만 판을 시작할 수 있어요.'
          : result.reason === 'not-ready'
            ? '참가자가 두 명 이상이고 모두 준비해야 시작할 수 있어요.'
            : result.reason === 'game-in-progress'
              ? '이미 게임이 진행 중이에요.'
              : '그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.');
      }
    } catch {
      if (!ownsAction(action)) return;
      notice('판을 시작하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
    }
  });

  el.leave.addEventListener('click', async () => {
    const action = captureAction();
    const entryGeneration = visibleEntry?.entryGeneration;
    if (!action) {
      if (visibleEntry) onLeave(visibleEntry.code, visibleEntry.entryGeneration);
      return;
    }
    if (entryGeneration === undefined) return;
    try {
      await roomStore.leaveRoom({ code: action.code });
      if (!ownsAction(action, false)) return;
      onLeave(action.code, entryGeneration);
    } catch {
      if (!ownsAction(action, false)) return;
      notice('방에서 나오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
    }
  });

  // ── 채팅 ───────────────────────────────────────────────────────

  el.chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = el.chatInput.value;
    const action = captureAction();
    if (!action) return;
    if (chatSendPending || !text.trim()) return;
    chatSendPending = true;
    el.chatSubmit.disabled = true;
    try {
      const result = await roomStore.sendChat({ code: action.code, text, player: getPlayer() });
      if (!ownsAction(action, false)) return;
      if (!result.ok) {
        notice('메시지를 보내지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
        return;
      }
      if (el.chatInput.value === text) {
        el.chatInput.value = '';
        // 보내고 나면 곧바로 다시 걸어 다닐 수 있게 손을 뗀다
        el.chatInput.blur();
      }
    } catch {
      if (!ownsAction(action, false)) return;
      notice('메시지를 보내지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
    } finally {
      if (ownsAction(action, false)) {
        chatSendPending = false;
        el.chatSubmit.disabled = false;
      }
    }
  });

  /**
   * 채팅칸과 걷기를 오간다.
   *
   * **Tab을 가로채지 않는다.** 대기실의 버튼은 캐릭터로 밟아 누를 수 있지만,
   * 키보드만 쓰는 사람에게 Tab으로 버튼에 닿는 길까지 막으면 안 된다.
   * 그래서 전용 키를 따로 둔다 — 걷는 중 `/`, 채팅칸에서 `Esc`.
   *
   * 나가는 `Esc`는 여기 없다. 어느 화면의 입력칸에서든 같은 일이 일어나야 해서
   * `ui/walker.js`가 맡는다. 여기 두면 대기실만 규칙이 다른 화면이 된다.
   */
  document.addEventListener('keydown', (event) => {
    if (el.screen.hidden) return;

    if (event.key === '/' && document.activeElement !== el.chatInput) {
      event.preventDefault(); // 브라우저의 «페이지에서 찾기»가 열리지 않게
      el.chatInput.focus();
    }
  });

  return {
    async show(code, characterId, entryGeneration) {
      const request = showGuard.begin();
      visibleRequest = request;
      const nextEntry = { code, entryGeneration };
      // 새 방을 읽는 동안 이전 방을 계속 조작할 수 있으면 activeRoomCode와 화면이
      // 갈라진다. 먼저 끊고 비워 둔다; 새 응답만 아래에서 다시 붙인다.
      visibleEntry = null;
      unsubscribe?.();
      unsubscribe = null;
      clearInterval(movementHeartbeat);
      movementHeartbeat = undefined;
      walker.hide();
      movementPublisher.reset();
      room = null;
      chatSendPending = false;
      el.chatSubmit.disabled = true;
      clearTimeout(bubbleTimer);
      bubbleTimer = undefined;
      el.bubble.hidden = true;
      el.bubble.textContent = '';
      remoteBubbles.reset();
      remoteMovements.reset();
      remoteBubbleNodes.clear();
      el.remoteCharacters.replaceChildren();

      const loadedRoom = await roomStore.getRoom(code);
      if (!showGuard.isCurrent(request)) return;

      room = loadedRoom;
      if (!room) {
        // 목록을 보는 사이 사라졌을 수 있다. 마지막 사람이 나가면 방이 지워진다.
        // **왜 되돌아왔는지 말해 준다** — 공개방의 「참가」는 이미 그렇게 하는데
        // 여기만 조용하면 같은 일에 두 가지 얼굴이 된다
        onLeave(code, entryGeneration, '그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.');
        return;
      }

      visibleEntry = nextEntry;
      unsubscribe = roomStore.subscribe(code, (event) => {
        if (showGuard.isCurrent(request)) onEvent(event, { code, entryGeneration });
      });

      el.chatInput.value = '';
      el.chatLog.replaceChildren();
      el.chatSubmit.disabled = false;
      render();
      walker.show(characterId);
      movementHeartbeat = window.setInterval(() => movementPublisher.resend(), 2000);
    },

    hide() {
      showGuard.invalidate();
      visibleRequest = null;
      visibleEntry = null;
      unsubscribe?.();
      unsubscribe = null;
      clearInterval(movementHeartbeat);
      movementHeartbeat = undefined;
      walker.hide();
      movementPublisher.reset();
      room = null;
      chatSendPending = false;
      el.chatSubmit.disabled = true;
      clearTimeout(bubbleTimer);
      bubbleTimer = undefined;
      el.bubble.hidden = true;
      el.bubble.textContent = '';
      remoteBubbles.reset();
      remoteMovements.reset();
      remoteBubbleNodes.clear();
      el.remoteCharacters.replaceChildren();
    },
  };
}
