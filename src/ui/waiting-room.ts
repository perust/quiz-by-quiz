// 대기실 화면
//
// 방에 들어오면 여기로 온다. 참가자가 바닥에 서 있고, 내 캐릭터가 그 사이를
// 걸어 다닌다. 한마디 적으면 캐릭터 위에 말풍선이 뜬다.
//
// **설정은 «누르면 다음 값으로 도는» 버튼이다.** `select`로 두면 캐릭터가 밟아도
// 목록이 열리지 않아 «걸어가서 고른다»가 성립하지 않는다. 분야·인원·모드·시작·나가기가
// 모두 그냥 버튼이라 발밑에 두고 Enter만 누르면 된다.
//
// **방이 어디에 있는지 이 파일은 모른다.** `roomStore`만 부르고, 무슨 일이 있었는지는
// `subscribe`로 듣는다 — 서버 구현이 되면 남의 말도 같은 길로 들어온다.

import { CATEGORIES, ROOM_CAPACITY_CHOICES } from '../constants.js';
import { need, needOne } from '../dom.js';
import { createScreenWalker } from './screen-walker.js';
import { createBody } from './sprite.js';
import type {
  MatchSetup, PlayerInfo, PublicRoom, RoomEvent, RoomPatch, RoomStore,
} from '../online/adapter.js';
import type { CategoryId } from '../types.js';

/** 말풍선이 떠 있는 시간. 짧으면 못 읽고 길면 얼굴을 가린다 */
const BUBBLE_MS = 3200;

/** 화면에 남겨 둘 대화 줄 수. 말풍선이 사라진 뒤에도 이만큼은 다시 볼 수 있다 */
const CHAT_LINES = 4;

/** 이만큼 위가 비어 있지 않으면 말풍선을 캐릭터 아래에 띄운다 */
const BUBBLE_ROOM = 52;

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
  onLeave: (reason?: string) => void;
  /** 방 설정으로 여는 한 판. «시작됐다»는 이벤트가 이 값을 싣고 온다 */
  onStart: (setup: MatchSetup) => void;
  getPlayer: () => PlayerInfo;
}

export interface WaitingRoom {
  /** @param code 들어온 방 */
  show(code: string, characterId: string): Promise<void>;
  hide(): void;
}

export function createWaitingRoom(
  { roomStore, onLeave, onStart, getPlayer }: WaitingRoomDeps,
): WaitingRoom {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="waiting"]'),
    title: need('waiting-title'),
    lead: need('waiting-lead'),
    leave: need<HTMLButtonElement>('waiting-leave'),
    start: need<HTMLButtonElement>('waiting-start'),
    category: need<HTMLButtonElement>('setting-category'),
    categoryValue: need('setting-category-value'),
    capacity: need<HTMLButtonElement>('setting-capacity'),
    capacityValue: need('setting-capacity-value'),
    mode: need<HTMLButtonElement>('setting-mode'),
    modeValue: need('setting-mode-value'),
    players: need('lounge-players'),
    character: need('waiting-character'),
    bubble: need('waiting-bubble'),
    chatForm: need<HTMLFormElement>('chat-form'),
    chatInput: need<HTMLInputElement>('chat-input'),
    chatLog: need('chat-log'),
  };

  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    // 라운지 바닥 한가운데에서 시작한다. 버튼 곁에 세우면 대기실 밖에 선 것처럼 보인다
    startPoint: () => {
      const box = need('lounge').getBoundingClientRect();
      if (box.width === 0) return null;
      return { x: box.left + box.width / 2, y: box.bottom - 18 };
    },
  });

  /** 지금 있는 방. 화면을 떠나면 비운다 */
  let room: PublicRoom | null = null;
  /** 구독을 끊는 함수 */
  let unsubscribe: (() => void) | null = null;
  /** 말풍선을 스스로 지우는 타이머. 없으면 undefined — clearTimeout이 그대로 받는다 */
  let bubbleTimer: number | undefined;

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
    el.modeValue.textContent = room.gameMode ? '게임 모드' : '보통 모드';

    // 방장만 설정을 바꾼다. 판정은 저장소가 하고 화면은 미리 알려 줄 뿐이다
    for (const button of [el.category, el.capacity, el.mode]) {
      button.disabled = !room.isMine;
    }

    el.players.replaceChildren();
    for (const player of room.players) {
      const item = document.createElement('li');
      item.className = 'lounge__player';

      const figure = document.createElement('span');
      figure.className = 'lounge__figure';
      figure.append(createBody(player.characterId));

      const name = document.createElement('span');
      name.className = 'lounge__name';
      name.textContent = player.nickname;

      item.append(figure, name);
      el.players.append(item);
    }
  }

  // ── 말풍선 ─────────────────────────────────────────────────────

  function showBubble(text: string): void {
    el.bubble.textContent = text;
    // 캐릭터는 화면 맨 위까지 갈 수 있다(앱 바 버튼을 밟으려고 위쪽 한계를 풀었다).
    // 그대로 두면 말풍선이 화면 밖으로 나가 말을 해도 보이지 않는다
    const top = el.character.getBoundingClientRect().top;
    el.bubble.classList.toggle('walker__bubble--below', top < BUBBLE_ROOM);
    el.bubble.hidden = false;
    clearTimeout(bubbleTimer);
    // 얼굴을 오래 가리지 않게 스스로 사라진다
    bubbleTimer = setTimeout(() => { el.bubble.hidden = true; }, BUBBLE_MS);
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

  function onEvent(event: RoomEvent): void {
    if (event.type === 'room') {
      room = event.room;
      render();
      return;
    }
    // 판이 열렸다. **내가 눌렀는지 묻지 않는다** — 서버가 붙으면 방장이 누른 시작이
    // 모두에게 같은 이벤트로 오고, 그때도 이 줄이 그대로 판을 연다
    if (event.type === 'match' && event.phase === 'started') {
      onStart(event.setup);
      return;
    }
    if (event.type !== 'chat') return;

    logChat(event);
    // 내 말만 내 캐릭터 위에 띄운다. 남의 말은 그 사람 캐릭터 위에 떠야 하는데,
    // 지금은 남이 어디 서 있는지 알 길이 없다 — 서버가 붙을 때 함께 정한다
    if (event.playerId === roomStore.me()) showBubble(event.text);
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

  async function patch(change: RoomPatch): Promise<void> {
    if (!room) return;
    const result = await roomStore.updateRoom({ code: room.code, patch: change });
    if (result.ok) {
      room = result.room;
      render();
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

  el.mode.addEventListener('click', () => patch({ gameMode: !room?.gameMode }));

  // 여기서 판을 열지 않는다. 저장소에 «열어 달라»고 하고, 열렸다는 이벤트를
  // 받아서 움직인다 (onEvent 참고). 그래야 서버가 붙었을 때 방에 있는 모두가
  // 같은 순간에 같은 길로 시작한다
  el.start.addEventListener('click', async () => {
    if (!room) return;
    const result = await roomStore.startGame({ code: room.code });
    if (!result.ok) {
      notice(result.reason === 'not-host'
        ? '방장만 판을 시작할 수 있어요.'
        : '판을 시작하지 못했어요.');
    }
  });

  el.leave.addEventListener('click', async () => {
    if (room) await roomStore.leaveRoom({ code: room.code });
    onLeave();
  });

  // ── 채팅 ───────────────────────────────────────────────────────

  el.chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = el.chatInput.value;
    el.chatInput.value = '';
    if (!room) return;
    await roomStore.sendChat({ code: room.code, text, player: getPlayer() });
    // 보내고 나면 곧바로 다시 걸어 다닐 수 있게 손을 뗀다
    el.chatInput.blur();
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
    async show(code, characterId) {
      room = await roomStore.getRoom(code);
      if (!room) {
        // 목록을 보는 사이 사라졌을 수 있다. 마지막 사람이 나가면 방이 지워진다.
        // **왜 되돌아왔는지 말해 준다** — 공개방의 「참가」는 이미 그렇게 하는데
        // 여기만 조용하면 같은 일에 두 가지 얼굴이 된다
        onLeave('그 방은 이미 사라졌어요. 마지막 사람이 나가면 방이 지워집니다.');
        return;
      }

      unsubscribe?.();
      unsubscribe = roomStore.subscribe(code, onEvent);

      el.bubble.hidden = true;
      el.chatInput.value = '';
      el.chatLog.replaceChildren();
      render();
      walker.show(characterId);
    },

    hide() {
      unsubscribe?.();
      unsubscribe = null;
      room = null;
      clearTimeout(bubbleTimer);
      el.bubble.hidden = true;
      walker.hide();
    },
  };
}
