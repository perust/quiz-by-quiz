// 온라인 로비 화면
//
// 처음 들어오면 공개방과 비공개방을 한 목록에서 보고, 필터로 좁히거나 코드와
// 비밀번호로 바로 참가하고, 새 방을 만든다.
//
// **방을 어디에 두는지 이 파일은 모른다.** `online/adapter.js`의 `roomStore`만
// 부르고, 그 구현이 브라우저 안이든 서버든 화면은 그대로다. 랭킹 화면이 저장소를
// 모르는 것과 같은 경계다.
//
// **비밀번호가 맞는지도 여기서 견주지 않는다.** 입력한 값을 그대로 넘기고 결과만
// 받는다 — 서버 구현이 되면 그 검사가 자연히 서버에서 일어난다.

import { CATEGORIES, ROOM_CAPACITY_CHOICES } from '../constants.js';
import { need, needOne } from '../dom.js';
import type { PlayerInfo, PublicRoom, RoomStore } from '../online/adapter.js';
import {
  DEFAULT_ROOM_FILTERS,
  filterAndSortRooms,
  roomListAction,
  type RoomAvailabilityFilter,
  type RoomCategoryFilter,
  type RoomListFilters,
  type RoomVisibilityFilter,
} from '../online/room-list.js';
import { JOIN_MESSAGES, isValidCode, normalizeCode } from '../online/rules.js';
import type { CategoryId } from '../types.js';
import { createLatestRequestGuard } from './latest-request.js';
import {
  isCurrentOnlineScreenAction,
  type OnlineScreenActionOwnership,
} from './online-action.js';
import { createScreenWalker } from './screen-walker.js';

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
  /** notice 가 있으면 맨 위 알림 자리에 띄운다. 대기실에서 되돌아온 이유가 들어온다 */
  show(characterId: string, notice?: string): Promise<void>;
  hide(): void;
}

export function createOnlineScreen(
  { roomStore, onHome, onEnterRoom, getPlayer }: OnlineScreenDeps,
): OnlineScreen {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="online"]'),
    note: need('online-note'),
    // 로비 전체에 걸리는 알림. 목록에서 참가 실패나 대기실에서 돌아온 이유가 뜬다
    message: need('online-message'),
    home: need<HTMLButtonElement>('online-home'),
    openPublic: need<HTMLButtonElement>('open-public-rooms'),
    openPrivate: need<HTMLButtonElement>('open-private-join'),
    openCreate: need<HTMLButtonElement>('open-create-room'),
    list: need('room-list'),
    empty: need('room-empty'),
    summary: need('room-list-summary'),
    refresh: need<HTMLButtonElement>('room-refresh'),
    filterToggle: need<HTMLButtonElement>('room-filter-toggle'),
    filters: need<HTMLFormElement>('room-filters'),
    search: need<HTMLInputElement>('room-search'),
    visibility: need<HTMLSelectElement>('room-visibility'),
    availability: need<HTMLSelectElement>('room-availability'),
    categoryFilter: need<HTMLSelectElement>('room-category-filter'),
    joinBlock: need('private-join-block'),
    joinForm: need<HTMLFormElement>('join-form'),
    joinCode: need<HTMLInputElement>('join-code'),
    joinPassword: need<HTMLInputElement>('join-password'),
    joinMessage: need('join-message'),
    createBlock: need('create-room-block'),
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

  /** 저장소에서 마지막으로 읽은 원본. 필터를 바꿀 때 네트워크를 다시 부르지 않는다 */
  let rooms: PublicRoom[] = [];
  /** 늦은 lobby fetch/action이 새 화면 navigation을 덮지 못하게 하는 화면 owner. */
  const screenGuard = createLatestRequestGuard();
  let visibleRequest: number | null = null;
  /** join/create/direct-enter/home 중 가장 최근 navigation intent만 commit한다. */
  let navigationActionGeneration = 0;
  /** 겹친 목록 조회는 가장 늦게 시작한 결과만 그린다. */
  let listRequestGeneration = 0;

  function ownsScreen(request: number): boolean {
    return visibleRequest === request && screenGuard.isCurrent(request);
  }

  function captureNavigationAction(): OnlineScreenActionOwnership | null {
    if (visibleRequest === null || !ownsScreen(visibleRequest)) return null;
    return {
      screenRequest: visibleRequest,
      actionRequest: ++navigationActionGeneration,
    };
  }

  function ownsNavigationAction(owner: OnlineScreenActionOwnership): boolean {
    return isCurrentOnlineScreenAction(owner, {
      screenRequest: visibleRequest,
      actionRequest: navigationActionGeneration,
    }) && screenGuard.isCurrent(owner.screenRequest);
  }

  function invalidateScreenOwnership(): void {
    screenGuard.invalidate();
    visibleRequest = null;
    navigationActionGeneration += 1;
    listRequestGeneration += 1;
  }

  function commitEnterRoom(code: string, owner: OnlineScreenActionOwnership): void {
    if (!ownsNavigationAction(owner)) return;
    invalidateScreenOwnership();
    walker.hide();
    onEnterRoom(code);
  }

  function enterRoom(code: string): void {
    const owner = captureNavigationAction();
    if (owner) commitEnterRoom(code, owner);
  }

  function leaveForHome(): void {
    const owner = captureNavigationAction();
    if (!owner || !ownsNavigationAction(owner)) return;
    invalidateScreenOwnership();
    walker.hide();
    onHome();
  }

  // ── 안내 ───────────────────────────────────────────────────────
  // 진짜로 이어지는지 아닌지를 숨기지 않는다. 친구를 불렀는데 아무도 못 들어오면
  // 그게 더 나쁘다. 어댑터가 스스로 밝히므로 화면은 물어보기만 한다.
  //
  // 저장이 막힌 브라우저(사생활 보호 모드)도 마찬가지다. 방은 만들어지지만
  // 새로고침하면 사라지므로, 코드를 알려 주기 전에 알아야 한다.
  el.note.textContent = roomStore.isNetworked
    ? '공개방과 비공개방을 함께 보여줘요. 비공개방은 참가할 때 비밀번호가 필요합니다.'
    : roomStore.isPersistent === false
      ? '이 브라우저에서 저장이 막혀 있어 새로고침하면 방이 사라져요. API 설정도 없어 방은 이 브라우저 안에만 만들어집니다.'
      : '이 독립 개발 문서에는 API 설정이 없어 방이 이 브라우저 안에만 만들어져요. 실제 온라인 연결 전 화면과 흐름을 확인하는 단계입니다.';

  // ── 선택지 채우기 ───────────────────────────────────────────────

  function appendOption(select: HTMLSelectElement, value: string, label: string): void {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  function fillOptions(): void {
    el.createCategory.replaceChildren();
    appendOption(el.createCategory, '', ALL_CATEGORY);
    for (const category of CATEGORIES) {
      appendOption(el.createCategory, category.id, category.name);
    }

    el.createCapacity.replaceChildren();
    for (const size of ROOM_CAPACITY_CHOICES) {
      appendOption(el.createCapacity, String(size), `${size}명`);
    }
    // 가장 큰 값으로 연다. 좁게 열어 두면 친구를 더 부르려 할 때 방을 다시
    // 만들어야 하지만, 넓게 열어 둔 것은 대기실에서 언제든 줄일 수 있다
    el.createCapacity.value = String(ROOM_CAPACITY_CHOICES[ROOM_CAPACITY_CHOICES.length - 1]);

    el.categoryFilter.replaceChildren();
    appendOption(el.categoryFilter, 'any', '전체 형식');
    appendOption(el.categoryFilter, 'all', ALL_CATEGORY);
    for (const category of CATEGORIES) {
      appendOption(el.categoryFilter, category.id, category.name);
    }
  }

  // 비공개일 때만 비밀번호 칸을 연다. 늘 열어 두면 공개방에도 적어야 하나 헷갈린다
  function syncPrivatePassword(): void {
    el.createPasswordRow.hidden = !el.createPrivate.checked;
    el.createPassword.required = el.createPrivate.checked;
    if (!el.createPrivate.checked) el.createPassword.value = '';
  }
  el.createPrivate.addEventListener('change', syncPrivatePassword);

  // ── 목록 ───────────────────────────────────────────────────────

  function categoryName(id: CategoryId | null): string {
    return CATEGORIES.find((category) => category.id === id)?.name ?? ALL_CATEGORY;
  }

  function gameFormat(room: PublicRoom): string {
    return categoryName(room.categoryId);
  }

  /**
   * @param subject 무엇에 대한 버튼인지. 스크린리더에만 덧붙는다.
   *
   * 목록에서는 글자만으로 부족하다. 방이 셋이면 Tab으로 「참가, 참가, 참가」만
   * 들리므로 방 이름을 aria-label에 붙인다.
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

  function preparePrivateJoin(room: PublicRoom): void {
    el.joinCode.value = room.code;
    el.joinPassword.value = '';
    say(el.joinMessage, `${room.name}의 비밀번호를 입력해 주세요.`);
    el.joinBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.joinPassword.focus({ preventScroll: true });
  }

  function createItem(room: PublicRoom): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'room-item';
    if (!room.isPublic) item.classList.add('room-item--private');
    if (room.players.length >= room.capacity) item.classList.add('room-item--full');

    const body = document.createElement('div');
    body.className = 'room-item__body';

    const titleLine = document.createElement('span');
    titleLine.className = 'room-item__title-line';

    const name = document.createElement('span');
    name.className = 'room-item__name';
    name.textContent = room.name;

    const visibility = document.createElement('span');
    visibility.className = `room-item__visibility ${room.isPublic ? 'room-item__visibility--public' : 'room-item__visibility--private'}`;
    visibility.textContent = room.isPublic ? '공개' : '비공개';

    titleLine.append(name, visibility);

    const meta = document.createElement('span');
    meta.className = 'room-item__meta';
    meta.textContent = `${gameFormat(room)} · ${room.players.length}/${room.capacity}명 · ${room.code}`;

    body.append(titleLine, meta);

    const actions = document.createElement('div');
    actions.className = 'room-item__actions';
    const action = roomListAction(room);

    if (action === 'enter') {
      actions.append(
        makeButton('들어가기', 'button--primary', () => enterRoom(room.code), room.name),
        makeButton('나가기', 'button--ghost', () => leave(room.code), room.name),
      );
    } else if (action === 'join') {
      actions.append(makeButton(
        '참가',
        'button--primary',
        () => joinByCode(room.code, '', el.message),
        room.name,
      ));
    } else if (action === 'password') {
      actions.append(makeButton(
        '비밀번호 입력',
        'button--primary',
        () => preparePrivateJoin(room),
        room.name,
      ));
    } else {
      const full = makeButton('가득 참', 'button--ghost', () => undefined, room.name);
      full.disabled = true;
      actions.append(full);
    }

    item.append(body, actions);
    return item;
  }

  function validVisibility(value: string): RoomVisibilityFilter {
    return value === 'public' || value === 'private' ? value : 'all';
  }

  function validAvailability(value: string): RoomAvailabilityFilter {
    return value === 'joinable' || value === 'full' ? value : 'all';
  }

  function validCategory(value: string): RoomCategoryFilter {
    if (value === 'all') return 'all';
    if (CATEGORIES.some(({ id }) => id === value)) return value as CategoryId;
    return 'any';
  }

  function currentFilters(): RoomListFilters {
    return {
      query: el.search.value,
      visibility: validVisibility(el.visibility.value),
      availability: validAvailability(el.availability.value),
      categoryId: validCategory(el.categoryFilter.value),
    };
  }

  function activeFilterCount(filters: RoomListFilters): number {
    return Number(Boolean(filters.query.trim()))
      + Number(filters.visibility !== DEFAULT_ROOM_FILTERS.visibility)
      + Number(filters.availability !== DEFAULT_ROOM_FILTERS.availability)
      + Number(filters.categoryId !== DEFAULT_ROOM_FILTERS.categoryId);
  }

  function syncFilterToggle(filters: RoomListFilters = currentFilters()): void {
    const expanded = !el.filters.hidden;
    const activeCount = activeFilterCount(filters);
    el.filterToggle.textContent = expanded
      ? '필터 접기'
      : activeCount > 0
        ? `필터 (${activeCount}개 적용)`
        : '필터';
    const action = expanded ? '접기' : '펼치기';
    el.filterToggle.setAttribute(
      'aria-label',
      activeCount > 0 ? `방 필터 ${action}, ${activeCount}개 적용 중` : `방 필터 ${action}`,
    );
  }

  function setFiltersExpanded(expanded: boolean): void {
    el.filters.hidden = !expanded;
    el.filterToggle.setAttribute('aria-expanded', String(expanded));
    syncFilterToggle();
  }

  function renderList(): void {
    const filters = currentFilters();
    const visible = filterAndSortRooms(rooms, filters);
    el.list.replaceChildren();
    visible.forEach((room) => el.list.append(createItem(room)));

    syncFilterToggle(filters);
    el.summary.textContent = `전체 ${rooms.length}개 중 ${visible.length}개 방`;
    if (visible.length === 0) {
      el.empty.textContent = rooms.length === 0
        ? '아직 열린 방이 없어요. 아래에서 하나 만들어 보세요.'
        : '현재 필터에 맞는 방이 없어요. 필터를 바꿔 보세요.';
      el.empty.hidden = false;
      el.list.hidden = true;
      return;
    }

    el.empty.hidden = true;
    el.list.hidden = false;
  }

  async function loadRooms(request: number): Promise<void> {
    const listRequest = ++listRequestGeneration;
    try {
      const loadedRooms = await roomStore.listRooms();
      if (!ownsScreen(request) || listRequest !== listRequestGeneration) return;
      rooms = loadedRooms;
      renderList();
    } catch (error) {
      if (!ownsScreen(request) || listRequest !== listRequestGeneration) return;
      rooms = [];
      renderList();
      const detail = error instanceof Error ? ` (${error.message})` : '';
      say(el.message, `방 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.${detail}`, 'bad');
    }
  }

  // ── 참가 ───────────────────────────────────────────────────────

  /**
   * 메시지 문단은 `role="status"`라 그 자체가 라이브 리전이다.
   * `announce()`까지 부르면 같은 말이 두 번 낭독된다.
   */
  function say(node: HTMLElement, message: string, tone?: 'bad'): void {
    node.hidden = !message;
    node.textContent = message;
    node.classList.toggle('room-message--bad', tone === 'bad');
  }

  /** 방에서 나온다. 마지막 사람이 나가면 저장소가 방을 지운다 */
  async function leave(code: string): Promise<void> {
    const request = visibleRequest;
    if (request === null || !ownsScreen(request)) return;
    try {
      await roomStore.leaveRoom({ code });
      if (!ownsScreen(request)) return;
      await loadRooms(request);
    } catch {
      if (!ownsScreen(request)) return;
      say(el.message, '방에서 나오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.', 'bad');
    }
  }

  async function joinByCode(
    code: string,
    password: string,
    messageNode: HTMLElement = el.joinMessage,
  ): Promise<void> {
    const owner = captureNavigationAction();
    if (!owner) return;
    try {
      const result = await roomStore.joinRoom({ code, password, player: getPlayer() });
      if (!ownsNavigationAction(owner)) return;
      if (!result.ok) {
        say(messageNode, JOIN_MESSAGES[result.reason] ?? '들어가지 못했어요.', 'bad');
        return;
      }

      el.joinForm.reset();
      commitEnterRoom(result.room.code, owner);
    } catch (error) {
      if (!ownsNavigationAction(owner)) return;
      const detail = error instanceof Error ? ` (${error.message})` : '';
      say(messageNode, `방에 들어가지 못했어요. 네트워크 상태를 확인해 주세요.${detail}`, 'bad');
    }
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
    const selected = CATEGORIES.find((category) => category.id === el.createCategory.value);
    const owner = captureNavigationAction();
    if (!owner) return;

    try {
      const result = await roomStore.createRoom({
        name: el.createName.value,
        categoryId: selected ? selected.id : null,
        capacity: Number(el.createCapacity.value),
        isPublic,
        password: el.createPassword.value,
        player: getPlayer(),
      });
      if (!ownsNavigationAction(owner)) return;

      if (!result.ok) {
        say(el.createMessage, result.message, 'bad');
        return;
      }

      el.createForm.reset();
      el.createCapacity.value = String(ROOM_CAPACITY_CHOICES[ROOM_CAPACITY_CHOICES.length - 1]);
      syncPrivatePassword();
      // 만들자마자 대기실로 들어간다. 목록으로 돌아가 다시 찾을 이유가 없다
      commitEnterRoom(result.room.code, owner);
    } catch (error) {
      if (!ownsNavigationAction(owner)) return;
      const detail = error instanceof Error ? ` (${error.message})` : '';
      say(el.createMessage, `방을 만들지 못했어요. 네트워크 상태를 확인해 주세요.${detail}`, 'bad');
    }
  });

  // ── 목록 필터와 주요 동작 ───────────────────────────────────────

  el.filterToggle.addEventListener('click', () => setFiltersExpanded(Boolean(el.filters.hidden)));
  el.search.addEventListener('input', renderList);
  for (const select of [el.visibility, el.availability, el.categoryFilter]) {
    select.addEventListener('change', renderList);
  }
  // reset 이벤트 시점에는 입력값이 아직 이전 값이다. 한 작업 뒤에 다시 그린다.
  el.filters.addEventListener('reset', () => setTimeout(renderList, 0));

  el.openPublic.addEventListener('click', () => {
    el.visibility.value = 'public';
    el.availability.value = 'joinable';
    renderList();
    el.summary.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  el.openPrivate.addEventListener('click', () => {
    el.visibility.value = 'private';
    renderList();
    el.joinBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.joinCode.focus({ preventScroll: true });
  });

  el.openCreate.addEventListener('click', () => {
    el.createBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.createName.focus({ preventScroll: true });
  });

  el.refresh.addEventListener('click', () => {
    if (visibleRequest !== null) void loadRooms(visibleRequest);
  });
  el.home.addEventListener('click', leaveForHome);

  document.addEventListener('keydown', (event) => {
    if (el.screen.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      leaveForHome();
    }
  });

  fillOptions();
  syncPrivatePassword();
  // HTML 값이 바뀌어도 첫 화면은 명시한 기본 필터로 시작한다.
  el.search.value = DEFAULT_ROOM_FILTERS.query;
  el.visibility.value = DEFAULT_ROOM_FILTERS.visibility;
  el.availability.value = DEFAULT_ROOM_FILTERS.availability;
  el.categoryFilter.value = DEFAULT_ROOM_FILTERS.categoryId;
  setFiltersExpanded(false);

  return {
    async show(characterId, notice) {
      const request = screenGuard.begin();
      visibleRequest = request;
      navigationActionGeneration += 1;
      listRequestGeneration += 1;
      say(el.joinMessage, '');
      say(el.createMessage, '');
      say(el.message, notice ?? '', notice ? 'bad' : undefined);
      setFiltersExpanded(false);
      await loadRooms(request);
      if (!ownsScreen(request)) return;
      walker.show(characterId);
    },

    hide() {
      invalidateScreenOwnership();
      walker.hide();
    },
  };
}
