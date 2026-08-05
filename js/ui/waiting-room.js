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
import { createScreenWalker } from './screen-walker.js';
import { createBody } from './sprite.js';

/** 말풍선이 떠 있는 시간. 짧으면 못 읽고 길면 얼굴을 가린다 */
const BUBBLE_MS = 3200;

const ALL_CATEGORY = { id: null, name: '전체 도전' };

/**
 * @param {{
 *   roomStore: object,
 *   onLeave: () => void,
 *   onStart: (setup: {categoryId: string|null, gameMode: boolean}) => void,
 *   getPlayer: () => {nickname: string, characterId: string}
 * }} deps
 */
export function createWaitingRoom({ roomStore, onLeave, onStart, getPlayer }) {
  const el = {
    screen: document.querySelector('[data-screen="waiting"]'),
    title: document.getElementById('waiting-title'),
    lead: document.getElementById('waiting-lead'),
    leave: document.getElementById('waiting-leave'),
    start: document.getElementById('waiting-start'),
    category: document.getElementById('setting-category'),
    categoryValue: document.getElementById('setting-category-value'),
    capacity: document.getElementById('setting-capacity'),
    capacityValue: document.getElementById('setting-capacity-value'),
    mode: document.getElementById('setting-mode'),
    modeValue: document.getElementById('setting-mode-value'),
    players: document.getElementById('lounge-players'),
    character: document.getElementById('waiting-character'),
    bubble: document.getElementById('waiting-bubble'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    chatLog: document.getElementById('chat-log'),
  };

  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    // 라운지 바닥 한가운데에서 시작한다. 버튼 곁에 세우면 대기실 밖에 선 것처럼 보인다
    startPoint: () => {
      const box = document.getElementById('lounge').getBoundingClientRect();
      if (box.width === 0) return null;
      return { x: box.left + box.width / 2, y: box.bottom - 18 };
    },
  });

  /** 지금 있는 방. 화면을 떠나면 비운다 */
  let room = null;
  /** 구독을 끊는 함수 */
  let unsubscribe = null;
  let bubbleTimer = null;

  // ── 그리기 ─────────────────────────────────────────────────────

  const categories = [ALL_CATEGORY, ...CATEGORIES];

  function render() {
    if (!room) return;

    el.title.textContent = room.name;
    el.lead.textContent = `방 코드 ${room.code} · ${room.players.length}/${room.capacity}명`
      + (room.isMine ? ' · 내가 만든 방' : '');

    const category = categories.find((item) => item.id === room.categoryId) ?? ALL_CATEGORY;
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

  function showBubble(text) {
    el.bubble.textContent = text;
    el.bubble.hidden = false;
    clearTimeout(bubbleTimer);
    // 얼굴을 오래 가리지 않게 스스로 사라진다
    bubbleTimer = setTimeout(() => { el.bubble.hidden = true; }, BUBBLE_MS);
  }

  /**
   * 말풍선은 눈으로 보는 장치라 스크린리더에는 닿지 않는다.
   * 들은 말을 로그에 남겨 낭독되게 한다.
   */
  function logChat({ nickname, text }) {
    el.chatLog.textContent = `${nickname}: ${text}`;
  }

  function onEvent(event) {
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

  // ── 설정 바꾸기 ────────────────────────────────────────────────
  // 누를 때마다 다음 값으로 돈다. 캐릭터가 밟고 Enter만 눌러도 바뀐다

  async function patch(change) {
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
    const index = ROOM_CAPACITY_CHOICES.indexOf(room?.capacity);
    patch({ capacity: ROOM_CAPACITY_CHOICES[(index + 1) % ROOM_CAPACITY_CHOICES.length] });
  });

  el.mode.addEventListener('click', () => patch({ gameMode: !room?.gameMode }));

  // 여기서 판을 열지 않는다. 저장소에 «열어 달라»고 하고, 열렸다는 이벤트를
  // 받아서 움직인다 (onEvent 참고). 그래야 서버가 붙었을 때 방에 있는 모두가
  // 같은 순간에 같은 길로 시작한다
  el.start.addEventListener('click', async () => {
    if (!room) return;
    const result = await roomStore.startGame({ code: room.code });
    if (!result.ok) {
      el.chatLog.textContent = result.reason === 'not-host'
        ? '방장만 판을 시작할 수 있어요.'
        : '판을 시작하지 못했어요.';
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
   */
  document.addEventListener('keydown', (event) => {
    if (el.screen.hidden) return;

    if (event.key === 'Escape' && document.activeElement === el.chatInput) {
      event.preventDefault();
      el.chatInput.blur();
      return;
    }
    if (event.key === '/' && document.activeElement !== el.chatInput) {
      event.preventDefault(); // 브라우저의 «페이지에서 찾기»가 열리지 않게
      el.chatInput.focus();
    }
  });

  return {
    /** @param {string} code 들어온 방 */
    async show(code, characterId) {
      room = await roomStore.getRoom(code);
      if (!room) {
        onLeave();
        return;
      }

      unsubscribe?.();
      unsubscribe = roomStore.subscribe(code, onEvent);

      el.bubble.hidden = true;
      el.chatInput.value = '';
      el.chatLog.textContent = '';
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
