// 온라인 로비 화면
//
// 공개방을 보고, 코드와 비밀번호로 비공개 방에 들어가고, 방을 만든다.
//
// **방을 어디에 두는지 이 파일은 모른다.** `online/adapter.js`의 `roomStore`만
// 부르고, 그 구현이 브라우저 안이든 서버든 화면은 그대로다. 랭킹 화면이 저장소를
// 모르는 것과 같은 경계다.
//
// **비밀번호가 맞는지도 여기서 견주지 않는다.** 입력한 값을 그대로 넘기고 결과만
// 받는다 — 서버 구현이 되면 그 검사가 자연히 서버에서 일어난다.

import { CATEGORIES, ROOM_CAPACITY_CHOICES } from '../constants.js';
import { JOIN_MESSAGES, isValidCode, normalizeCode } from '../online/rules.js';
import { createScreenWalker } from './screen-walker.js';

const ALL_CATEGORY = '전체 도전';

/**
 * @param {{
 *   roomStore: object,                방 저장소 어댑터
 *   onHome: () => void,
 *   getPlayer: () => {nickname: string, characterId: string}
 * }} deps
 */
export function createOnlineScreen({ roomStore, onHome, getPlayer }) {
  const el = {
    screen: document.querySelector('[data-screen="online"]'),
    note: document.getElementById('online-note'),
    home: document.getElementById('online-home'),
    list: document.getElementById('room-list'),
    empty: document.getElementById('room-empty'),
    refresh: document.getElementById('room-refresh'),
    joinForm: document.getElementById('join-form'),
    joinCode: document.getElementById('join-code'),
    joinPassword: document.getElementById('join-password'),
    joinMessage: document.getElementById('join-message'),
    createForm: document.getElementById('create-form'),
    createName: document.getElementById('create-name'),
    createCategory: document.getElementById('create-category'),
    createCapacity: document.getElementById('create-capacity'),
    createPrivate: document.getElementById('create-private'),
    createPasswordRow: document.getElementById('create-password-row'),
    createPassword: document.getElementById('create-password'),
    createMessage: document.getElementById('create-message'),
    character: document.getElementById('online-character'),
  };

  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    startAt: () => el.home,
  });

  // ── 안내 ───────────────────────────────────────────────────────
  // 진짜로 이어지는지 아닌지를 숨기지 않는다. 친구를 불렀는데 아무도 못 들어오면
  // 그게 더 나쁘다. 어댑터가 스스로 밝히므로 화면은 물어보기만 한다.
  el.note.textContent = roomStore.isNetworked
    ? '방을 만들어 코드를 알려주면 친구가 들어올 수 있어요.'
    : '아직 서버가 없어 방이 이 브라우저 안에만 만들어져요. 화면과 흐름을 먼저 갖춰 둔 단계입니다.';

  // ── 방 만들기 폼 채우기 ────────────────────────────────────────

  function fillOptions() {
    el.createCategory.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = ALL_CATEGORY;
    el.createCategory.append(all);
    for (const category of CATEGORIES) {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.name;
      el.createCategory.append(option);
    }

    el.createCapacity.replaceChildren();
    for (const size of ROOM_CAPACITY_CHOICES) {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = `${size}명`;
      el.createCapacity.append(option);
    }
  }

  // 비공개일 때만 비밀번호 칸을 연다. 늘 열어 두면 공개방에도 적어야 하나 헷갈린다
  el.createPrivate.addEventListener('change', () => {
    el.createPasswordRow.hidden = !el.createPrivate.checked;
  });

  // ── 목록 ───────────────────────────────────────────────────────

  function categoryName(id) {
    return CATEGORIES.find((category) => category.id === id)?.name ?? ALL_CATEGORY;
  }

  function createItem(room) {
    const item = document.createElement('li');
    item.className = 'room-item';

    const body = document.createElement('div');
    body.className = 'room-item__body';

    const name = document.createElement('span');
    name.className = 'room-item__name';
    name.textContent = room.name;
    // 잠긴 방은 색이 아닌 것으로도 구분한다 (FR-4.1과 같은 이유)
    if (room.hasPassword) {
      const lock = document.createElement('span');
      lock.className = 'room-item__lock';
      lock.textContent = '🔒';
      lock.title = '비밀번호가 필요한 방';
      name.append(' ', lock);
    }

    const meta = document.createElement('span');
    meta.className = 'room-item__meta';
    meta.textContent = `${categoryName(room.categoryId)} · ${room.players.length}/${room.capacity}명 · ${room.code}`;

    body.append(name, meta);

    // 들어가 있는 방에는 나갈 길을 준다. 없으면 내가 만든 빈 방이 목록에 쌓이고
    // (서버가 붙으면 남들 목록까지 지저분해진다) 다시 들어갈 수도 없다
    const button = document.createElement('button');
    button.type = 'button';
    const full = room.players.length >= room.capacity;

    if (room.joined) {
      button.className = 'button button--ghost button--small';
      button.textContent = '나가기';
      button.addEventListener('click', () => leave(room.code));
    } else {
      button.className = 'button button--primary button--small';
      button.textContent = full ? '가득 참' : '참가';
      button.disabled = full;
      button.addEventListener('click', () => joinByCode(room.code, ''));
    }

    item.append(body, button);
    return item;
  }

  async function renderList() {
    const rooms = await roomStore.listRooms();
    el.list.replaceChildren();

    if (rooms.length === 0) {
      // 가상의 방을 심지 않고 빈 상태를 그대로 안내한다 (랭킹과 같은 원칙)
      el.empty.textContent = '아직 열린 공개방이 없어요. 아래에서 하나 만들어 보세요.';
      el.empty.hidden = false;
      el.list.hidden = true;
      return;
    }

    el.empty.hidden = true;
    el.list.hidden = false;
    rooms.forEach((room) => el.list.append(createItem(room)));
  }

  // ── 참가 ───────────────────────────────────────────────────────

  /**
   * 메시지 문단은 `role="status"`라 그 자체가 라이브 리전이다.
   * `announce()`까지 부르면 **같은 말이 두 번 낭독된다.**
   *
   * 숨긴 채로 글을 넣으면 낭독되지 않으므로 먼저 펼치고 넣는다.
   */
  function say(node, message, tone) {
    node.hidden = !message;
    node.textContent = message;
    node.classList.toggle('room-message--bad', tone === 'bad');
  }

  /**
   * 방에서 나온다. 마지막 사람이 나가면 저장소가 방을 지운다 —
   * 그래서 목록에서 사라지는 것 자체가 «나왔다»는 표시가 된다.
   */
  async function leave(code) {
    await roomStore.leaveRoom({ code });
    await renderList();
  }

  async function joinByCode(code, password) {
    const result = await roomStore.joinRoom({ code, password, player: getPlayer() });

    if (!result.ok) {
      say(el.joinMessage, JOIN_MESSAGES[result.reason] ?? '들어가지 못했어요.', 'bad');
      return;
    }

    say(el.joinMessage, `«${result.room.name}» 방에 들어왔어요. 코드는 ${result.room.code} 입니다.`);
    el.joinForm.reset();
    await renderList();
  }

  el.joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = normalizeCode(el.joinCode.value);
    if (!isValidCode(code)) {
      say(el.joinMessage, '방 코드는 여섯 글자예요.', 'bad');
      el.joinCode.focus();
      return;
    }
    await joinByCode(code, el.joinPassword.value);
  });

  // ── 만들기 ─────────────────────────────────────────────────────

  el.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const isPublic = !el.createPrivate.checked;

    const result = await roomStore.createRoom({
      name: el.createName.value,
      categoryId: el.createCategory.value,
      capacity: el.createCapacity.value,
      isPublic,
      password: el.createPassword.value,
      player: getPlayer(),
    });

    if (!result.ok) {
      say(el.createMessage, result.message, 'bad');
      return;
    }

    const how = result.room.isPublic
      ? '공개방으로 열렸어요.'
      : '비공개 방이에요. 코드와 비밀번호를 함께 알려주세요.';
    say(el.createMessage, `방을 만들었어요. 코드는 ${result.room.code} — ${how}`);
    el.createForm.reset();
    el.createPasswordRow.hidden = true;
    await renderList();
  });

  el.refresh.addEventListener('click', () => renderList());
  el.home.addEventListener('click', () => onHome());

  document.addEventListener('keydown', (event) => {
    if (el.screen.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onHome();
    }
  });

  fillOptions();

  return {
    async show(characterId) {
      say(el.joinMessage, '');
      say(el.createMessage, '');
      await renderList();
      walker.show(characterId);
    },

    hide() {
      walker.hide();
    },
  };
}
