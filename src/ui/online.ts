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
import { need, needOne } from '../dom.js';
import { createScreenWalker } from './screen-walker.js';
import type { PlayerInfo, PublicRoom, RoomStore } from '../online/adapter.js';
import type { CategoryId } from '../types.js';

const ALL_CATEGORY = '전체 도전';

export interface OnlineScreenDeps {
  /** 방 저장소 어댑터 */
  roomStore: RoomStore;
  onHome: () => void;
  /** 방에 들어가면 대기실로 넘긴다 */
  onEnterRoom: (code: string) => void;
  /** 방에 들고 들어가는 나. 저장소가 이 값을 그대로 참가자로 삼는다 */
  getPlayer: () => PlayerInfo;
}

export interface OnlineScreen {
  show(characterId: string): Promise<void>;
  hide(): void;
}

export function createOnlineScreen(
  { roomStore, onHome, onEnterRoom, getPlayer }: OnlineScreenDeps,
): OnlineScreen {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="online"]'),
    note: need('online-note'),
    home: need<HTMLButtonElement>('online-home'),
    list: need('room-list'),
    empty: need('room-empty'),
    refresh: need<HTMLButtonElement>('room-refresh'),
    mineBlock: need('my-rooms-block'),
    mineList: need('my-room-list'),
    joinForm: need<HTMLFormElement>('join-form'),
    joinCode: need<HTMLInputElement>('join-code'),
    joinPassword: need<HTMLInputElement>('join-password'),
    joinMessage: need('join-message'),
    createForm: need<HTMLFormElement>('create-form'),
    createName: need<HTMLInputElement>('create-name'),
    createCategory: need<HTMLSelectElement>('create-category'),
    createCapacity: need<HTMLSelectElement>('create-capacity'),
    createPrivate: need<HTMLInputElement>('create-private'),
    createPasswordRow: need('create-password-row'),
    createPassword: need<HTMLInputElement>('create-password'),
    createMessage: need('create-message'),
    character: need('online-character'),
  };

  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    startAt: () => el.home,
  });

  // ── 안내 ───────────────────────────────────────────────────────
  // 진짜로 이어지는지 아닌지를 숨기지 않는다. 친구를 불렀는데 아무도 못 들어오면
  // 그게 더 나쁘다. 어댑터가 스스로 밝히므로 화면은 물어보기만 한다.
  //
  // 저장이 막힌 브라우저(사생활 보호 모드)도 마찬가지다. 방은 만들어지지만
  // 새로고침하면 사라지므로, 코드를 알려 주기 전에 알아야 한다.
  el.note.textContent = roomStore.isNetworked
    ? '방을 만들어 코드를 알려주면 친구가 들어올 수 있어요.'
    : roomStore.isPersistent === false
      ? '이 브라우저에서 저장이 막혀 있어 새로고침하면 방이 사라져요. 아직 서버도 없어 방은 이 브라우저 안에만 만들어집니다.'
      : '아직 서버가 없어 방이 이 브라우저 안에만 만들어져요. 화면과 흐름을 먼저 갖춰 둔 단계입니다.';

  // ── 방 만들기 폼 채우기 ────────────────────────────────────────

  function fillOptions(): void {
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
    // 가장 큰 값으로 연다. 좁게 열어 두면 친구를 더 부르려 할 때 방을 다시
    // 만들어야 하지만, 넓게 열어 둔 것은 대기실에서 언제든 줄일 수 있다
    el.createCapacity.value = String(ROOM_CAPACITY_CHOICES[ROOM_CAPACITY_CHOICES.length - 1]);
  }

  // 비공개일 때만 비밀번호 칸을 연다. 늘 열어 두면 공개방에도 적어야 하나 헷갈린다
  el.createPrivate.addEventListener('change', () => {
    el.createPasswordRow.hidden = !el.createPrivate.checked;
  });

  // ── 목록 ───────────────────────────────────────────────────────

  function categoryName(id: CategoryId | null): string {
    return CATEGORIES.find((category) => category.id === id)?.name ?? ALL_CATEGORY;
  }

  /**
   * @param subject 무엇에 대한 버튼인지. 스크린리더에만 덧붙는다.
   *
   * **목록에서는 글자만으로 부족하다.** 방이 셋이면 Tab으로 「참가, 참가, 참가」만
   * 들리고, 「내가 있는 방」과 공개방이 위아래로 놓이면 어느 방을 누르는지 알 수 없다.
   * 눈으로 보는 사람에게는 버튼 글자가 그대로라 잃는 것이 없다.
   */
  function makeButton(
    label: string,
    variant: string,
    run: () => void,
    subject?: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button ${variant} button--small`;
    button.textContent = label;
    if (subject) button.setAttribute('aria-label', `${subject} ${label}`);
    button.addEventListener('click', run);
    return button;
  }

  function createItem(room: PublicRoom): HTMLLIElement {
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

    const actions = document.createElement('div');
    actions.className = 'room-item__actions';
    const full = room.players.length >= room.capacity;

    if (room.joined) {
      // **들어가 있는 방에는 «다시 들어갈» 길이 있어야 한다.** 새로고침하거나
      // 홈에 다녀오면 대기실을 떠나 있을 뿐 방에서 나간 것은 아니다.
      // 나갈 길도 함께 준다 — 없으면 빈 방이 목록에 쌓인다
      actions.append(
        makeButton('들어가기', 'button--primary', () => onEnterRoom(room.code), room.name),
        makeButton('나가기', 'button--ghost', () => leave(room.code), room.name)
      );
    } else {
      const join = makeButton(full ? '가득 참' : '참가', 'button--primary',
        () => joinByCode(room.code, ''), room.name);
      join.disabled = full;
      actions.append(join);
    }

    item.append(body, actions);
    return item;
  }

  /**
   * 두 목록을 함께 그린다.
   *
   * **들어가 있는 방은 위로 올리고 공개방 목록에서는 뺀다.** 같은 방이 두 번
   * 나오면 다른 방인가 싶고, «참가»와 «들어가기»가 나란히 놓여 뜻이 흐려진다.
   *
   * `myRooms()`가 아니면 **비공개 방으로 돌아갈 길이 없다.** 공개방 목록에는
   * 나오지 않으므로, 코드를 적어 두지 않은 사람은 제가 만든 방을 다시 찾지 못한다.
   */
  async function renderList(): Promise<void> {
    const [mine, rooms] = await Promise.all([roomStore.myRooms(), roomStore.listRooms()]);
    const joined = new Set(mine.map((room) => room.code));

    el.mineList.replaceChildren();
    // 하나도 없는 것이 보통이다. 빈 안내를 두지 않고 묶음째 감춘다
    el.mineBlock.hidden = mine.length === 0;
    mine.forEach((room) => el.mineList.append(createItem(room)));

    const others = rooms.filter((room) => !joined.has(room.code));
    el.list.replaceChildren();

    if (others.length === 0) {
      // 가상의 방을 심지 않고 빈 상태를 그대로 안내한다 (랭킹과 같은 원칙)
      el.empty.textContent = mine.length > 0
        ? '들어갈 수 있는 다른 공개방이 없어요.'
        : '아직 열린 공개방이 없어요. 아래에서 하나 만들어 보세요.';
      el.empty.hidden = false;
      el.list.hidden = true;
      return;
    }

    el.empty.hidden = true;
    el.list.hidden = false;
    others.forEach((room) => el.list.append(createItem(room)));
  }

  // ── 참가 ───────────────────────────────────────────────────────

  /**
   * 메시지 문단은 `role="status"`라 그 자체가 라이브 리전이다.
   * `announce()`까지 부르면 **같은 말이 두 번 낭독된다.**
   *
   * 숨긴 채로 글을 넣으면 낭독되지 않으므로 먼저 펼치고 넣는다.
   */
  function say(node: HTMLElement, message: string, tone?: 'bad'): void {
    node.hidden = !message;
    node.textContent = message;
    node.classList.toggle('room-message--bad', tone === 'bad');
  }

  /**
   * 방에서 나온다. 마지막 사람이 나가면 저장소가 방을 지운다 —
   * 그래서 목록에서 사라지는 것 자체가 «나왔다»는 표시가 된다.
   */
  async function leave(code: string): Promise<void> {
    await roomStore.leaveRoom({ code });
    await renderList();
  }

  async function joinByCode(code: string, password: string): Promise<void> {
    const result = await roomStore.joinRoom({ code, password, player: getPlayer() });

    if (!result.ok) {
      say(el.joinMessage, JOIN_MESSAGES[result.reason] ?? '들어가지 못했어요.', 'bad');
      return;
    }

    el.joinForm.reset();
    onEnterRoom(result.room.code);
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

    // 폼이 주는 것은 글자다. **값으로 바꾸는 것은 화면의 일이다** — 저장소에
    // 글자를 넘기면 서버 구현이 그 변환까지 떠안게 된다. 목록에 없는 값이 오면
    // 「전체 도전」으로 본다 (option을 CATEGORIES로 그렸으니 그럴 일은 없지만,
    // 그렇게 두면 이 자리가 무엇을 받는지가 코드로 드러난다).
    const selected = CATEGORIES.find((category) => category.id === el.createCategory.value);

    const result = await roomStore.createRoom({
      name: el.createName.value,
      categoryId: selected ? selected.id : null,
      capacity: Number(el.createCapacity.value),
      isPublic,
      password: el.createPassword.value,
      player: getPlayer(),
    });

    if (!result.ok) {
      say(el.createMessage, result.message, 'bad');
      return;
    }

    el.createForm.reset();
    el.createPasswordRow.hidden = true;
    // 만들자마자 대기실로 들어간다. 목록으로 돌아가 다시 찾을 이유가 없다
    onEnterRoom(result.room.code);
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
