// 대기실 화면
//
// 방에 들어오면 여기로 온다. 참가자 명단은 벽걸이 액자로 보여 주고, 내 캐릭터와
// 원격 캐릭터는 그 아래 공간을 걸어 다닌다. 한마디 적으면 캐릭터 위에 말풍선이 뜬다.
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
  waitingRoomChangeNotices,
  waitingRoomControls,
  waitingRoomInviteLink,
  waitingRoomNicknameNotice,
  waitingRoomStartStatus,
} from './waiting-room-action.js';
import { waitingRoomPortraits } from './waiting-room-portrait.js';
import {
  createWaitingRoomSeatLeaseController,
  isWaitingRoomSeatId,
  nextWaitingRoomSeat,
  waitingRoomSeatPoint,
  waitingRoomSeatWinner,
  type WaitingRoomSeatId,
} from './waiting-room-seating.js';
import { createBody } from './sprite.js';
import type {
  MatchSetup, PlayerInfo, PublicRoom, RoomEvent, RoomPatch, RoomStore,
} from '../online/adapter.js';
import { LEAVE_MESSAGES, LeaveRoomRejected } from '../online/rules.js';
import type { CategoryId } from '../types.js';

/** 말풍선이 떠 있는 시간. 짧으면 못 읽고 길면 얼굴을 가린다 */
const BUBBLE_MS = 3200;

/** 화면에 남겨 둘 대화 줄 수. 말풍선이 사라진 뒤에도 이만큼은 다시 볼 수 있다 */
const CHAT_LINES = 4;

/** 2초 heartbeat가 tab 종료로 끊겨도 background timer throttling을 오인하지 않는 여유. */
const REMOTE_SEAT_STALE_MS = 70_000;

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
  /** app이 실제로 waiting 화면을 연 직후, 숨은 DOM에서 미룬 좌표를 확정한다. */
  activate(): void;
  hide(): void;
}

export function createWaitingRoom(
  { roomStore, onLeave, onStart, onMatchInvalidated, getPlayer }: WaitingRoomDeps,
): WaitingRoom {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="waiting"]'),
    title: need('waiting-title'),
    code: need('waiting-code'),
    invite: need<HTMLButtonElement>('waiting-invite'),
    inviteLink: need<HTMLInputElement>('waiting-invite-link'),
    lead: need('waiting-lead'),
    leave: need<HTMLButtonElement>('waiting-leave'),
    start: need<HTMLButtonElement>('waiting-start'),
    startStatus: need('waiting-start-status'),
    ready: need<HTMLButtonElement>('waiting-ready'),
    category: need<HTMLButtonElement>('setting-category'),
    categoryValue: need('setting-category-value'),
    capacity: need<HTMLButtonElement>('setting-capacity'),
    capacityValue: need('setting-capacity-value'),
    lounge: need('lounge'),
    players: need('lounge-players'),
    furniture: need('waiting-furniture'),
    remoteCharacters: need('waiting-remote-characters'),
    character: need('waiting-character'),
    bubble: need('waiting-bubble'),
    chatForm: need<HTMLFormElement>('chat-form'),
    chatInput: need<HTMLInputElement>('chat-input'),
    chatSubmit: need<HTMLButtonElement>('chat-submit'),
    chatLog: need('chat-log'),
  };

  /** 착석은 대기실 화면 수명에만 속한다. 방 snapshot이나 저장소에는 넣지 않는다. */
  let seatedSeatId: WaitingRoomSeatId | null = null;

  function waitingRoomStartPoint(): { x: number; y: number } | null {
    const box = el.lounge.getBoundingClientRect();
    // show()는 방을 먼저 읽고 앱이 그 뒤에 화면을 연다. 숨은 동안 좌표를 확정하면
    // 0,0이 화면 가장자리로 clamp되어 캐릭터가 좌상단에 잘린 채 남는다.
    if (el.screen.hidden || box.width === 0 || box.height === 0) return null;
    return { x: box.left + 40, y: box.bottom - 90 };
  }

  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    // 중앙의 소파·테이블과 겹치지 않는 왼쪽 바닥에서 시작한다.
    startPoint: waitingRoomStartPoint,
    onMove: (point, moving) => {
      // 앉아 있다가 방향 입력을 시작하면 먼저 일어난다. 이 frame에는 seatId가
      // 빠지므로 다른 browser도 즉시 standing pose로 돌아간다.
      if (moving && seatedSeatId) standUp();
      const sample = normalizeViewportMovement(point, moving, {
        width: window.innerWidth,
        height: window.innerHeight,
      }, seatedSeatId ?? undefined);
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
  /**
   * 방이 붙여 준 내 이름은 방·이름마다 한 번만 알린다. 판을 마치고 같은 방에 돌아올
   * 때마다 같은 말을 되풀이하면 몇 줄짜리 대화 로그를 밀어낸다.
   */
  const nicknameNoticed = new Set<string>();
  /** 초대 버튼 글자를 잠깐 «복사했어요»로 바꿨다가 되돌리는 타이머. */
  let inviteLabelTimer: number | undefined;
  /** 말풍선을 스스로 지우는 타이머. 없으면 undefined — clearTimeout이 그대로 받는다 */
  let bubbleTimer: number | undefined;
  /** room snapshot이 참가자 DOM을 다시 만들어도 아직 살아 있는 남의 말은 유지한다. */
  const remoteBubbles = createPlayerBubbleController({ durationMs: BUBBLE_MS });
  /** room snapshot rerender와 socket reconnect를 건너서 상대 좌표·좌석을 보존한다. */
  const remoteMovements = createPlayerMovementController({
    seatPoint: pointForRemoteSeat,
  });
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
  /** 정적 HTML의 좌석 버튼. 테이블은 장식이라 이 목록에 들어오지 않는다. */
  const seatButtons = new Map<WaitingRoomSeatId, HTMLButtonElement>();
  const seatNames = new Map<WaitingRoomSeatId, string>();
  /** 최신 remote movement가 주장한 좌석. room snapshot에서 사라지면 즉시 지운다. */
  const remoteSeats = new Map<string, WaitingRoomSeatId>();
  /** 종료 frame 없는 tab crash도 유령 착석으로 좌석을 계속 막지 못하게 한다. */
  const remoteSeatLeases = createWaitingRoomSeatLeaseController({
    staleMs: REMOTE_SEAT_STALE_MS,
    onExpire: (playerId) => {
      if (!remoteSeats.delete(playerId)) return;
      remoteMovements.clearSeat(playerId);
      paintSeating();
    },
  });
  for (const button of el.furniture.querySelectorAll<HTMLButtonElement>('[data-waiting-seat]')) {
    const seatId = button.dataset.waitingSeat;
    if (!isWaitingRoomSeatId(seatId)) continue;
    seatButtons.set(seatId, button);
    seatNames.set(
      seatId,
      (button.getAttribute('aria-label') ?? '좌석에 앉기').replace(/에 앉기$/, ''),
    );
  }

  function paintSeating(): void {
    const me = roomStore.me();
    el.character.classList.toggle('walker--seated', seatedSeatId !== null);
    for (const [seatId, button] of seatButtons) {
      const owner = seatOwner(seatId);
      const selected = seatId === seatedSeatId && owner === me;
      const occupiedByOther = owner !== null && owner !== me;
      const name = seatNames.get(seatId) ?? '좌석';
      button.disabled = occupiedByOther;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute(
        'aria-label',
        selected
          ? `${name}에서 일어나기`
          : occupiedByOther ? `${name} 사용 중` : `${name}에 앉기`,
      );
    }
  }

  function pointForSeat(seatId: WaitingRoomSeatId): { x: number; y: number } | null {
    const button = seatButtons.get(seatId);
    if (!button) return null;
    return waitingRoomSeatPoint(button.getBoundingClientRect(), el.character.offsetHeight);
  }

  function pointForRemoteSeat(
    seatId: WaitingRoomSeatId,
    node: HTMLElement,
  ): { x: number; y: number } | null {
    const button = seatButtons.get(seatId);
    if (!button) return null;
    return waitingRoomSeatPoint(button.getBoundingClientRect(), node.offsetHeight);
  }

  function seatClaims(): Array<{ playerId: string; seatId: WaitingRoomSeatId }> {
    const claims = [...remoteSeats].map(([playerId, seatId]) => ({ playerId, seatId }));
    if (seatedSeatId) claims.push({ playerId: roomStore.me(), seatId: seatedSeatId });
    return claims;
  }

  function seatOwner(seatId: WaitingRoomSeatId): string | null {
    return waitingRoomSeatWinner(seatId, seatClaims());
  }

  /** 움직여 일어날 때. 현재 좌표는 walker가 바로 이어서 보고한다. */
  function standUp(): void {
    if (!seatedSeatId) return;
    seatedSeatId = null;
    paintSeating();
  }

  /** 방을 바꾸거나 화면을 떠날 때 좌석 표시가 다음 입장에 새지 않게 비운다. */
  function resetSeating(): void {
    seatedSeatId = null;
    remoteSeatLeases.reset();
    remoteSeats.clear();
    paintSeating();
  }

  function chooseSeat(requested: WaitingRoomSeatId): void {
    const owner = seatOwner(requested);
    if (owner !== null && owner !== roomStore.me()) return;
    const point = pointForSeat(requested);
    if (!point) return;
    const next = nextWaitingRoomSeat(seatedSeatId, requested);
    if (next === null) {
      standUp();
      el.character.classList.add('walker--idle');
      // 같은 자리를 다시 골라 일어선 사실도 정지 좌표로 즉시 공유한다.
      walker.placeAt(point);
      return;
    }
    seatedSeatId = next;
    el.character.classList.remove('walker--hop', 'walker--idle');
    paintSeating();
    walker.placeAt(point);
  }

  /** fixed walker와 문서 안 가구가 스크롤·resize 뒤에도 같은 자리에 보이게 맞춘다. */
  function alignSeatedWalkers(): void {
    if (el.screen.hidden) return;
    if (seatedSeatId) {
      const point = pointForSeat(seatedSeatId);
      if (point) walker.placeAt(point, false);
    }
    remoteMovements.refresh();
  }

  for (const [seatId, button] of seatButtons) {
    button.addEventListener('click', () => chooseSeat(seatId));
  }
  window.addEventListener('scroll', alignSeatedWalkers, { passive: true });
  window.addEventListener('resize', alignSeatedWalkers);

  function applyRemoteSeat(playerId: string, seatId: WaitingRoomSeatId | undefined): void {
    if (seatId) {
      remoteSeats.set(playerId, seatId);
      remoteSeatLeases.refresh(playerId);
    } else {
      remoteSeats.delete(playerId);
      remoteSeatLeases.clear(playerId);
    }

    if (seatedSeatId && seatId === seatedSeatId) {
      const winner = seatOwner(seatedSeatId);
      if (winner !== roomStore.me()) {
        const point = pointForSeat(seatedSeatId);
        standUp();
        el.character.classList.add('walker--idle');
        // 모든 client가 같은 player-id tie-break를 써서 진 쪽이 standing frame을 알린다.
        // 좌석 DOM을 잠깐 잴 수 없어도 publisher의 마지막 좌표에서 seatId를 제거해야
        // heartbeat가 패배한 좌석을 다시 주장하지 않는다.
        movementPublisher.clearSeat();
        if (point) walker.placeAt(point, false);
        return;
      }
    }
    paintSeating();
    walker.refresh();
  }

  // ── 그리기 ─────────────────────────────────────────────────────

  const categories: RoundCategory[] = [ALL_CATEGORY, ...CATEGORIES];

  function render(): void {
    if (!room) return;

    el.title.textContent = room.name;
    // 방 코드는 불러 주고 받아 적는 값이라 글 사이에 묻지 않고 따로 크게 보인다 (U27).
    // 이 브라우저 안의 방(로컬)은 링크를 받아도 들어올 길이 없어 초대를 내놓지 않는다.
    el.code.textContent = room.code;
    el.invite.hidden = !roomStore.isNetworked;
    el.lead.textContent = `참가 ${room.players.length}명 · 최대 ${room.capacity}명`
      + (room.isMine ? ' · 내가 방장' : '');

    const category = categories.find((item) => item.id === room!.categoryId) ?? ALL_CATEGORY;
    el.categoryValue.textContent = category.name;
    el.capacityValue.textContent = `${room.capacity}명`;

    const me = room.players.find((player) => player.id === roomStore.me()) ?? null;
    const controls = waitingRoomControls(room, roomStore.me());
    // 방장은 시작 요청이 곧 준비다. 따로 누를 「준비 완료」를 두지 않는다 (서버와 같은 규칙)
    el.ready.hidden = controls.readyHidden;
    el.ready.disabled = controls.readyDisabled;
    el.ready.textContent = me?.isReady ? '준비 취소' : '준비 완료';
    el.ready.setAttribute('aria-pressed', String(Boolean(me?.isReady)));
    el.start.hidden = controls.startHidden;
    el.start.disabled = controls.startDisabled;
    // 꺼진 「게임 시작」은 눌러도 click이 나지 않는다. 이유는 버튼 밖 상태 줄이 말한다.
    // 같은 글을 다시 넣으면 낭독이 되풀이될 수 있어 바뀔 때만 쓴다.
    setStartStatus(waitingRoomStartStatus(room, roomStore.me(), {
      canInvite: roomStore.isNetworked,
    }));

    // 방장만 설정을 바꾼다. 판정은 저장소가 하고 화면은 미리 알려 줄 뿐이다
    for (const button of [el.category, el.capacity]) {
      button.disabled = !room.isMine;
    }

    const remotePlayers = room.players.filter((player) => player.id !== roomStore.me());
    const remotePlayerIds = new Set(remotePlayers.map((player) => player.id));
    remoteSeatLeases.retain(remotePlayerIds);
    for (const playerId of remoteSeats.keys()) {
      if (!remotePlayerIds.has(playerId)) remoteSeats.delete(playerId);
    }
    paintSeating();
    remoteMovements.unbindAll();
    remoteMovements.reconcile([...remotePlayerIds]);
    remoteBubbles.unbindAll();
    remoteBubbleNodes.clear();
    el.players.replaceChildren();
    el.remoteCharacters.replaceChildren();
    for (const player of waitingRoomPortraits(room.players, roomStore.me())) {
      const item = document.createElement('li');
      item.className = 'lounge__player';
      item.classList.toggle('lounge__player--me', player.isMe);
      item.classList.toggle('lounge__player--ready', player.isReady);
      item.classList.toggle('lounge__player--offline', !player.connected);
      item.dataset.playerId = player.id;
      item.setAttribute('aria-label', [
        player.nickname,
        player.isHost ? '방장' : '',
        player.isMe ? '나' : '',
        player.statusLabel,
      ].filter(Boolean).join(', '));

      const portrait = document.createElement('span');
      portrait.className = 'lounge__portrait';
      portrait.setAttribute('aria-hidden', 'true');
      const portraitCrop = document.createElement('span');
      portraitCrop.className = 'lounge__portrait-crop';
      portraitCrop.append(createBody(player.characterId));
      portrait.append(portraitCrop);

      const identity = document.createElement('span');
      identity.className = 'lounge__identity';

      const name = document.createElement('span');
      name.className = 'lounge__name';
      name.textContent = player.nickname;
      identity.append(name);

      if (player.isHost) {
        // 왕관은 디자인 층의 crown 아이콘이다. 번들 픽셀 글꼴에 없는 글리프를 쓰지 않는다
        const host = document.createElement('span');
        host.className = 'lounge__host';
        host.title = '방장';
        host.setAttribute('aria-hidden', 'true');
        identity.append(host);
      }

      if (player.isMe) {
        const meBadge = document.createElement('span');
        meBadge.className = 'lounge__me';
        meBadge.textContent = '나';
        meBadge.setAttribute('aria-hidden', 'true');
        identity.append(meBadge);
      }

      const readiness = document.createElement('span');
      readiness.className = 'lounge__ready';
      readiness.classList.toggle('lounge__ready--on', player.isReady);
      // 색만이 아니라 경고 표식과 «연결 끊김» 글자로 알린다 (디자인 시스템 §6, FR-4.1·4.2의 비색 단서)
      readiness.classList.toggle('lounge__ready--offline', !player.connected);
      readiness.textContent = player.statusLabel;

      item.append(portrait, identity, readiness);
      el.players.append(item);

      // 오래 끊긴 사람의 캐릭터는 바닥에 세워 두지 않는다. 마지막 좌표는 movement
      // controller가 들고 있어 다시 붙으면 그 자리로 돌아온다.
      if (player.isMe || !player.connected) continue;
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

  function setStartStatus(text: string): void {
    if (el.startStatus.textContent !== text) el.startStatus.textContent = text;
  }

  /**
   * 새 snapshot으로 갈아 끼운다. 입장·퇴장·방장 승계처럼 드문 사건만 대화 로그에 한 줄씩
   * 남긴다 — 액자만 바뀌면 화면을 계속 보고 있지 않은 사람, 스크린리더 사용자는 모른다.
   * 준비 토글은 시작 상태 줄이 맡아 로그(CHAT_LINES)를 대화에 남긴다.
   */
  function applyRoom(next: PublicRoom): void {
    const previous = room;
    room = next;
    if (previous) {
      for (const line of waitingRoomChangeNotices(previous, next, roomStore.me())) notice(line);
    }
    render();
    noticeRoomNickname();
  }

  /** 서버가 겹친 이름 뒤에 숫자를 붙였으면 그 방에서 한 번 알린다 (U02) */
  function noticeRoomNickname(): void {
    if (!room) return;
    const me = room.players.find((player) => player.id === roomStore.me());
    if (!me) return;
    const key = `${room.code}
${me.nickname}`;
    if (nicknameNoticed.has(key)) return;
    const line = waitingRoomNicknameNotice(me.nickname, getPlayer().nickname);
    if (!line) return;
    nicknameNoticed.add(key);
    notice(line);
  }

  function onEvent(
    event: RoomEvent,
    owner: { code: string; entryGeneration: number },
  ): void {
    if (event.type === 'room') {
      applyRoom(event.room);
      return;
    }
    if (event.type === 'movement') {
      if (event.playerId !== roomStore.me()) {
        if (remoteMovements.update(event)) {
          applyRemoteSeat(event.playerId, event.seatId);
        }
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
        applyRoom(result.room);
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
        applyRoom(result.room);
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
      if (!result.ok && result.reason === 'not-ready') {
        // 버튼이 켜진 사이 누가 준비를 풀었다. 이유는 시작 상태 줄이 말하고, 방을 다시
        // 읽어 그 줄과 버튼을 서버가 본 상태로 맞춘다.
        setStartStatus('그 사이 준비 상태가 바뀌었어요. 다시 확인하는 중…');
        void reloadRoom(action);
        return;
      }
      if (!result.ok) {
        notice(result.reason === 'not-host'
          ? '방장만 판을 시작할 수 있어요.'
          : result.reason === 'game-in-progress'
            ? '이미 게임이 진행 중이에요.'
            : '그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.');
      }
    } catch {
      if (!ownsAction(action)) return;
      notice('판을 시작하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
    }
  });

  /** 거절당한 시작 뒤 서버가 본 방을 다시 읽는다. 그사이 화면이 바뀌었으면 버린다. */
  async function reloadRoom(action: WaitingRoomActionOwnership): Promise<void> {
    try {
      const fresh = await roomStore.getRoom(action.code);
      if (fresh && ownsAction(action)) applyRoom(fresh);
    } catch {
      // 다음 room-invalidated나 재연결이 다시 맞춘다.
    }
  }

  // ── 초대 (U27) ─────────────────────────────────────────────────
  // 공유 시트 → 클립보드 → 직접 복사할 수 있게 링크 글자를 골라 두기 순으로 내려간다.
  // **비밀번호는 링크에 싣지 않는다** (waitingRoomInviteLink).

  function flashInviteLabel(text: string): void {
    el.invite.textContent = text;
    clearTimeout(inviteLabelTimer);
    inviteLabelTimer = window.setTimeout(() => {
      el.invite.textContent = '초대 링크 복사';
    }, 2000);
  }

  function resetInvite(): void {
    clearTimeout(inviteLabelTimer);
    inviteLabelTimer = undefined;
    el.invite.textContent = '초대 링크 복사';
    el.inviteLink.hidden = true;
    el.inviteLink.value = '';
  }

  el.invite.addEventListener('click', async () => {
    const action = captureAction();
    if (!action) return;
    const link = waitingRoomInviteLink(window.location, action.code);
    const lockedNote = action.snapshot.hasPassword
      ? ' 비밀번호는 링크에 없으니 따로 알려 주세요.'
      : '';

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'quiz by quiz 초대',
          text: `「${action.snapshot.name}」 방에서 같이 퀴즈 풀어요! 방 코드 ${action.code}`,
          url: link,
        });
        if (!ownsAction(action, false)) return;
        notice(`초대 링크를 보냈어요.${lockedNote}`);
        return;
      } catch (error) {
        if (!ownsAction(action, false)) return;
        // 공유 시트를 닫은 것은 실패가 아니다. 그 밖의 거절만 클립보드로 내려간다.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }

    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(link);
      if (!ownsAction(action, false)) return;
      flashInviteLabel('링크를 복사했어요');
      notice(`초대 링크를 복사했어요. 친구에게 보내 주세요.${lockedNote}`);
    } catch {
      if (!ownsAction(action, false)) return;
      // 클립보드를 못 쓰는 브라우저(권한·비보안 문맥)는 링크를 펼쳐 골라 둔다.
      el.inviteLink.value = link;
      el.inviteLink.hidden = false;
      el.inviteLink.focus();
      el.inviteLink.select();
      notice(`초대 링크를 골라 두었어요. 복사해서 친구에게 보내 주세요.${lockedNote}`);
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
    } catch (error) {
      if (!ownsAction(action, false)) return;
      // 판이 도는 방(판에서 빠진 사람이 보는 대기실)의 거절은 연결 문제가 아니다.
      // 로비의 「나가기」와 같은 말로 언제 되는지를 말한다 (U32)
      notice(error instanceof LeaveRoomRejected
        ? LEAVE_MESSAGES[error.reason]
        : '방에서 나오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
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
      movementPublisher.clearSeat();
      visibleEntry = null;
      unsubscribe?.();
      unsubscribe = null;
      clearInterval(movementHeartbeat);
      movementHeartbeat = undefined;
      walker.hide();
      resetSeating();
      movementPublisher.reset();
      room = null;
      chatSendPending = false;
      resetInvite();
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
      noticeRoomNickname();
      walker.show(characterId);
      // 곧바로 화면이 열리는 경로를 먼저 맞춘다. match 복구로 늦게 열리면 activate()가
      // 보이는 DOM을 기준으로 local/remote 좌표를 다시 확정한다.
      window.requestAnimationFrame(() => alignSeatedWalkers());
      movementHeartbeat = window.setInterval(() => movementPublisher.resend(), 2000);
    },

    activate() {
      if (el.screen.hidden) return;
      const point = waitingRoomStartPoint();
      if (point) walker.placeAt(point);
      alignSeatedWalkers();
    },

    hide() {
      showGuard.invalidate();
      visibleRequest = null;
      movementPublisher.clearSeat();
      visibleEntry = null;
      unsubscribe?.();
      unsubscribe = null;
      clearInterval(movementHeartbeat);
      movementHeartbeat = undefined;
      walker.hide();
      resetSeating();
      movementPublisher.reset();
      room = null;
      chatSendPending = false;
      resetInvite();
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
