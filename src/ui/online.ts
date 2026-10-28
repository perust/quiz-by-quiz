// 온라인 로비 화면
//
// 처음 들어오면 공개방과 비밀번호로 잠긴 방을 한 목록에서 보고, 필터로 좁히거나 코드와
// 비밀번호로 바로 참가하고, 새 방을 만든다. 잠긴 방도 목록에 보인다 — «숨김»이 아니라
// «잠금»이다 (U36).
//
// **방을 어디에 두는지 이 파일은 모른다.** `online/adapter.js`의 `roomStore`만
// 부르고, 그 구현이 브라우저 안이든 서버든 화면은 그대로다. 랭킹 화면이 저장소를
// 모르는 것과 같은 경계다.
//
// **비밀번호가 맞는지도 여기서 견주지 않는다.** 입력한 값을 그대로 넘기고 결과만
// 받는다 — 서버 구현이 되면 그 검사가 자연히 서버에서 일어난다.

import {
  CATEGORIES, ONLINE_QUESTION_TIME_CHOICES, ROOM_CAPACITY_CHOICES, ROOM_NAME_MAX_LENGTH, TIME_LIMIT_MS,
} from '../constants.js';
import { need, needOne } from '../dom.js';
import type { PlayerInfo, PublicRoom, RoomStore } from '../online/adapter.js';
import {
  DEFAULT_ROOM_FILTERS,
  filterAndSortRooms,
  isRoomPlaying,
  roomListAction,
  roomListChanged,
  type RoomAvailabilityFilter,
  type RoomCategoryFilter,
  type RoomListFilters,
  type RoomVisibilityFilter,
} from '../online/room-list.js';
import {
  CODE_MESSAGES,
  JOIN_MESSAGES,
  LEAVE_MESSAGES,
  LeaveRoomRejected,
  capacityHelpText,
  checkCodeInput,
  checkRoomName,
  hasHangul,
  isValidCode,
  lobbyEmptyCopy,
  normalizeCode,
  onlineErrorText,
  onlineQuestionTimeLabel,
  onlineQuestionTimeOrDefault,
} from '../online/rules.js';
import type { CategoryId } from '../types.js';
import { createLatestRequestGuard } from './latest-request.js';
import { browserClock, createLobbyRefresh, type LobbyRefreshClock } from './lobby-refresh.js';
import { scrollBehavior } from './motion.js';
import {
  isCurrentOnlineScreenAction,
  type OnlineScreenActionOwnership,
} from './online-action.js';
import { createScreenWalker, pointBelowRightEdge } from './screen-walker.js';

const ALL_CATEGORY = '전체 도전';
type OnlinePanel = 'rooms' | 'join' | 'create';

/**
 * 손가락·마우스가 방 목록을 떠나거나 화면을 민 뒤에도 이만큼은 «고르는 중»으로 본다 (WP-E). 손가락은 닿기 전에는
 * 목록 위에 있지 않아 — 목록을 밀어 읽은 손가락은 관성 스크롤이 멎고 겨눈 뒤에 누른다 — 위에 있는 동안만 보면
 * 누르기 직전에 줄이 움직인다. 이 동안 건너뛴 차례는 다음 30초에 다시 온다
 */
export const ROOM_LIST_SETTLE_MS = 5_000;

export interface OnlineScreenDeps {
  /** 방 저장소 어댑터 */
  roomStore: RoomStore;
  onHome: () => void;
  /** 빈 목록의 「혼자 연습하기」. 홈으로 돌아가 분야 dock에 포커스를 둔다 (U29) */
  onPractice: () => void;
  /** 방에 들어가면 대기실로 넘긴다 */
  onEnterRoom: (code: string) => void;
  /** 방에 들고 들어가는 나. 저장소가 이 값을 그대로 참가자로 삼는다 */
  getPlayer: () => PlayerInfo;
  /** 목록 주기 새로고침의 시계 (WP-E). 기본은 브라우저 시계이고 테스트가 가짜 시계를 넘긴다 */
  refreshClock?: LobbyRefreshClock;
}

export interface OnlineScreen {
  /**
   * notice 가 있으면 맨 위 알림 자리에 띄운다. 대기실에서 되돌아온 이유가 들어온다. 글은 `activate`가
   * 화면이 보인 뒤에 넣는다 — 숨은 화면의 role=status 문단은 바뀌어도 낭독되지 않는다
   */
  show(characterId: string, notice?: string): Promise<void>;
  /** app이 로비를 실제로 연 직후 부른다. `show`가 받아 둔 알림을 그때 넣는다(먼저 펼치고 넣는다) */
  activate(): void;
  /**
   * 초대 링크로 들어왔을 때 (U27). `show` 다음, 화면이 보인 뒤에 부른다 — 포커스를
   * 옮겨야 하기 때문이다. 공개방이면 바로 들어가고, 잠긴 방이면 비밀번호 칸에 선다.
   */
  acceptInvite(code: string): void;
  hide(): void;
}

export function createOnlineScreen(
  { roomStore, onHome, onPractice, onEnterRoom, getPlayer, refreshClock }: OnlineScreenDeps,
): OnlineScreen {
  const el = {
    screen: needOne<HTMLElement>('[data-screen="online"]'),
    header: needOne<HTMLElement>('[data-screen="online"] .online-hero__header'),
    note: need('online-note'),
    // 로비 전체에 걸리는 알림. 목록에서 참가 실패나 대기실에서 돌아온 이유가 뜬다
    message: need('online-message'),
    home: need<HTMLButtonElement>('online-home'),
    openPublic: need<HTMLButtonElement>('open-public-rooms'),
    openPrivate: need<HTMLButtonElement>('open-private-join'),
    openCreate: need<HTMLButtonElement>('open-create-room'),
    roomBrowser: need('room-browser'),
    list: need('room-list'),
    empty: need('room-empty'),
    emptyTitle: need('room-empty-title'),
    emptyCopy: need('room-empty-copy'),
    emptyAction: need<HTMLButtonElement>('room-empty-action'),
    emptySecondary: need<HTMLButtonElement>('room-empty-secondary'),
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
    joinSubmit: need<HTMLButtonElement>('join-submit'),
    joinMessage: need('join-message'),
    createBlock: need('create-room-block'),
    createForm: need<HTMLFormElement>('create-form'),
    createName: need<HTMLInputElement>('create-name'),
    createCategory: need<HTMLSelectElement>('create-category'),
    createCapacity: need<HTMLSelectElement>('create-capacity'),
    createCapacityHelp: need('create-capacity-help'),
    createQuestionTime: need<HTMLSelectElement>('create-question-time'),
    createPrivate: need<HTMLInputElement>('create-private'),
    createPasswordRow: need('create-password-row'),
    createPassword: need<HTMLInputElement>('create-password'),
    createSubmit: need<HTMLButtonElement>('create-submit'),
    createMessage: need('create-message'),
    character: need('online-character'),
  };

  const walker = createScreenWalker({
    screen: el.screen,
    character: el.character,
    // 좁은 화면에서도 바로 아래 안내문을 덮지 않는 머리말 오른쪽 빈자리에 선다.
    startPoint: () => pointBelowRightEdge(el.header, el.character),
  });

  /** 저장소에서 마지막으로 읽은 원본. 필터를 바꿀 때 네트워크를 다시 부르지 않는다 */
  let rooms: PublicRoom[] = [];
  /** 늦은 lobby fetch/action이 새 화면 navigation을 덮지 못하게 하는 화면 owner. */
  const screenGuard = createLatestRequestGuard();
  let visibleRequest: number | null = null;
  /** show가 받아 두고 activate가 화면이 보인 뒤에 넣는 알림. 숨은 role=status는 낭독되지 않는다 */
  let pendingNotice: string | null = null;
  /** join/create/direct-enter/home 중 가장 최근 navigation intent만 commit한다. */
  let navigationActionGeneration = 0;
  /** 겹친 목록 조회는 가장 늦게 시작한 결과만 그린다. */
  let listRequestGeneration = 0;
  /** 지금 도는 목록 요청 수 (사람이 누른 조회와 주기 새로고침 모두). 주기 새로고침은 하나라도 돌면 건너뛴다 */
  let listFetches = 0;
  /**
   * 주기 새로고침이 보낸 요청이 끝나는 때 (실패해도 이룬다). 사람이 누른 조회는 이것이 끝난 뒤에 보낸다 —
   * 같은 화면이 목록 요청을 겹쳐 보내지 않는다. 그 결과는 사람이 누른 조회가 올린 세대가 버린다
   */
  let quietFetch: Promise<void> | null = null;
  /** 주기 새로고침의 시계. «방금 목록을 만졌는가»도 같은 시계로 잰다 */
  const clock = refreshClock ?? browserClock;
  /**
   * 지금 방 목록·빈 칸 위에 있는 포인터(마우스·펜·손가락)의 `pointerId`. 마우스 클릭(Safari)·손가락 탭은 누르기 전에
   * 포커스를 옮기지 않아 포커스로는 «겨누는 중»을 알 수 없다. 손가락은 닿은 동안만 들어 있다
   */
  const listPointers = new Set<number>();
  /** 포인터가 방 목록·빈 칸을 마지막으로 떠난 때, 또는 로비를 마지막으로 민 때 (`ROOM_LIST_SETTLE_MS`) */
  let listTouchedAt = Number.NEGATIVE_INFINITY;

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
    pendingNotice = null;
    // 로비를 떠난다(closers → hide, 대기실·홈으로 가는 길). 주기 새로고침도 여기서 멈춘다
    refresher.stop();
    // 숨은 화면의 목록에는 pointerleave가 오지 않을 수 있다. 다음 로비가 남은 포인터에 묶이지 않게 비운다
    listPointers.clear();
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

  /** 「혼자 연습하기」. 홈으로 나가는 길과 같은 소유권 규칙을 따른다 */
  function leaveForPractice(): void {
    const owner = captureNavigationAction();
    if (!owner || !ownsNavigationAction(owner)) return;
    invalidateScreenOwnership();
    walker.hide();
    onPractice();
  }

  /**
   * 요청이 도는 동안 버튼을 잠그고 `aria-busy`를 단다 (U34). 다시 눌러 같은 요청이 겹치지
   * 않게 하고, 무엇을 기다리는지는 글자로도 알린다(`busyLabel`, 색만으로 알리지 않는다).
   *
   * 잠그는 순간 버튼에 있던 포커스는 브라우저가 떨어뜨린다. 풀 때 갈 곳을 잃었으면
   * 그 버튼으로 되돌린다 — 실패한 뒤 Tab 자리를 잃지 않게 한다.
   */
  const busyButtons = new WeakMap<HTMLButtonElement, { label: string | null; hadFocus: boolean }>();
  /** 지금 잠근 버튼 수 — 누른 일(조회·참가·만들기·나가기)이 도는 동안에는 주기 새로고침이 목록을 다시 그리지 않는다 */
  let busyCount = 0;
  function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel?: string): void {
    if (busy) {
      if (!busyButtons.has(button)) busyCount += 1;
      busyButtons.set(button, {
        label: busyLabel ? button.textContent : null,
        hadFocus: document.activeElement === button,
      });
      if (busyLabel) button.textContent = busyLabel;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      return;
    }
    const before = busyButtons.get(button);
    if (before) busyCount -= 1;
    busyButtons.delete(button);
    if (before && before.label !== null) button.textContent = before.label;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (before?.hadFocus && button.isConnected && !el.screen.hidden
        && (document.activeElement === null || document.activeElement === document.body)) {
      button.focus({ preventScroll: true });
    }
  }

  // ── 안내 ───────────────────────────────────────────────────────
  // 진짜로 이어지는지 아닌지를 숨기지 않는다. 친구를 불렀는데 아무도 못 들어오면
  // 그게 더 나쁘다. 어댑터가 스스로 밝히므로 화면은 물어보기만 한다.
  //
  // 저장이 막힌 브라우저(사생활 보호 모드)도 마찬가지다. 방은 만들어지지만
  // 새로고침하면 사라지므로, 코드를 알려 주기 전에 알아야 한다.
  el.note.textContent = roomStore.isNetworked
    ? '열린 방을 모두 보여 줘요. 잠긴 방은 비밀번호를 아는 사람만 들어올 수 있어요.'
    : roomStore.isPersistent === false
      ? '이 브라우저에서 저장이 막혀 있어 새로고침하면 방이 사라져요. 온라인 연결도 없어 방은 이 브라우저 안에만 만들어져요.'
      : '지금은 온라인 연결이 없어 방이 이 브라우저 안에만 만들어져요. 다른 기기의 친구는 들어올 수 없어요.';

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

    // 방장이 고르는 문항 시간 (20초 기본 · 40초). 대기실 설정 칸에서도 바꿀 수 있다
    el.createQuestionTime.replaceChildren();
    for (const time of ONLINE_QUESTION_TIME_CHOICES) {
      appendOption(el.createQuestionTime, String(time), onlineQuestionTimeLabel(time));
    }
    el.createQuestionTime.value = String(TIME_LIMIT_MS);

    el.categoryFilter.replaceChildren();
    appendOption(el.categoryFilter, 'any', '전체 형식');
    appendOption(el.categoryFilter, 'all', ALL_CATEGORY);
    for (const category of CATEGORIES) {
      appendOption(el.categoryFilter, category.id, category.name);
    }
  }

  /**
   * 방 이름을 «{닉네임}의 방»으로 미리 채운다 (U41). 기본값처럼 보이는 placeholder는
   * 비워 둔 채 만들면 거절됐다. 사용자가 고친 이름은 덮지 않는다.
   */
  let suggestedRoomName = '';
  function suggestRoomName(): void {
    const current = el.createName.value;
    if (current.trim() !== '' && current !== suggestedRoomName) return;
    suggestedRoomName = `${getPlayer().nickname}의 방`.slice(0, ROOM_NAME_MAX_LENGTH);
    el.createName.value = suggestedRoomName;
  }

  // 잠글 때만 비밀번호 칸을 연다. 늘 열어 두면 공개방에도 적어야 하나 헷갈린다
  function syncPrivatePassword(): void {
    el.createPasswordRow.hidden = !el.createPrivate.checked;
    el.createPassword.required = el.createPrivate.checked;
    if (!el.createPrivate.checked) el.createPassword.value = '';
  }
  el.createPrivate.addEventListener('change', syncPrivatePassword);

  // 방 목록은 로비의 기본 표면이다. 동작 카드는 탭처럼 한 본문만 열어, 코드 참가를
  // 골랐는데 그 앞에 필터 결과 없음이 끼거나 만들기 폼이 목록 아래로 밀리지 않게 한다.
  function showPanel(panel: OnlinePanel): void {
    el.roomBrowser.hidden = panel !== 'rooms';
    el.joinBlock.hidden = panel !== 'join';
    el.createBlock.hidden = panel !== 'create';
    el.openPublic.setAttribute('aria-pressed', String(panel === 'rooms'));
    el.openPrivate.setAttribute('aria-pressed', String(panel === 'join'));
    el.openCreate.setAttribute('aria-pressed', String(panel === 'create'));
  }

  // ── 목록 ───────────────────────────────────────────────────────

  function categoryName(id: CategoryId | null): string {
    return CATEGORIES.find((category) => category.id === id)?.name ?? ALL_CATEGORY;
  }

  /** 디자인 시스템 아이콘 이름. 전체 도전 방은 여러 분야를 묶는 grid 아이콘이다 */
  function categoryIcon(id: CategoryId | null): string {
    return CATEGORIES.find((category) => category.id === id)?.icon ?? 'grid';
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
    run: (button: HTMLButtonElement) => void,
    subject?: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button ${variant} button--small`;
    button.textContent = label;
    if (subject) button.setAttribute('aria-label', `${subject} ${label}`);
    button.addEventListener('click', () => run(button));
    return button;
  }

  function preparePrivateJoin(room: PublicRoom): void {
    el.joinCode.value = room.code;
    el.joinPassword.value = '';
    say(el.joinMessage, `${room.name}의 비밀번호를 입력해 주세요.`);
    showPanel('join');
    el.joinBlock.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
    el.joinPassword.focus({ preventScroll: true });
  }

  function createItem(room: PublicRoom): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'room-item';
    // 홈의 분야 칸과 같은 식별 색을 아이콘 칸에 쓴다
    item.dataset.category = room.categoryId ?? 'all';
    if (!room.isPublic) item.classList.add('room-item--private');
    if (room.players.length >= room.capacity) item.classList.add('room-item--full');

    const icon = document.createElement('span');
    icon.className = 'room-item__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.dataset.icon = categoryIcon(room.categoryId);

    const body = document.createElement('div');
    body.className = 'room-item__body';

    const titleLine = document.createElement('span');
    titleLine.className = 'room-item__title-line';

    const name = document.createElement('span');
    name.className = 'room-item__name';
    name.textContent = room.name;

    // 잠긴 방도 목록에 보인다. «비공개»라 부르면 숨는 줄 알므로 «잠김»이라 쓰고,
    // 디자인 층이 자물쇠 아이콘을 함께 단다 (U36)
    const visibility = document.createElement('span');
    visibility.className = `room-item__visibility ${room.isPublic ? 'room-item__visibility--public' : 'room-item__visibility--private'}`;
    visibility.textContent = room.isPublic ? '공개' : '잠김';

    titleLine.append(name, visibility);

    // 판이 도는 방은 새로 들어갈 수 없다. 누르고 나서 거절당하기 전에 먼저 알린다 (U33)
    if (isRoomPlaying(room)) {
      const status = document.createElement('span');
      status.className = 'room-item__status';
      status.textContent = '게임 중';
      titleLine.append(status);
    }

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
        makeButton('나가기', 'button--ghost', (button) => leave(room.code, button), room.name),
      );
    } else if (action === 'join') {
      actions.append(makeButton(
        '참가',
        'button--primary',
        (button) => joinByCode(room.code, '', el.message, button),
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
      // 누를 수 없는 이유를 버튼 글자가 말한다. 게임 중인 방은 끝나면 다시 「참가」가 된다
      const blocked = makeButton(
        action === 'playing' ? '끝나면 참가' : '가득 참',
        'button--ghost',
        () => undefined,
        room.name,
      );
      blocked.disabled = true;
      actions.append(blocked);
    }

    item.append(icon, body, actions);
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

  /**
   * 마지막 목록 조회가 실패했으면 플레이어에게 보일 그 사연(`onlineErrorText`), 아니면 null.
   * «방이 없다»와 «모른다»를 가른다 — 서버가 안 되는데 첫 방을 만들라고 하면 눌러도
   * 또 실패한다 (U34).
   */
  let listError: string | null = null;

  type EmptyAction = 'create' | 'reset' | 'retry';

  function showEmptyState(
    { title, copy, action, label, practice }:
    { title: string; copy: string; action: EmptyAction; label: string; practice: boolean },
  ): void {
    el.emptyTitle.textContent = title;
    el.emptyCopy.textContent = copy;
    el.emptyAction.textContent = label;
    el.emptyAction.dataset.action = action;
    el.emptySecondary.hidden = !practice;
    el.empty.hidden = false;
    el.list.hidden = true;
  }

  /**
   * 요약 줄(`role="status"`)에 쓴다. 주기 새로고침(`quiet`)은 글이 같으면 건드리지 않는다 — 같은 말로 다시 써도
   * 낭독기가 다시 읽을 수 있어, 30초마다 «전체 3개 중 3개 방»을 듣게 된다. 방 수가 바뀔 때만 말한다
   */
  function setSummary(text: string, quiet: boolean): void {
    if (quiet && el.summary.textContent === text) return;
    el.summary.textContent = text;
  }

  function renderList({ quiet = false }: { quiet?: boolean } = {}): void {
    const filters = currentFilters();
    syncFilterToggle(filters);
    // 만들기 폼의 시작 인원. 세션을 연 뒤에야 안다(목록을 읽으며 연다). 모르면(목록을 읽지 못했다) 어느
    // API든 맞는 말만 한다 — 그래도 만들기 폼은 열린다
    el.createCapacityHelp.textContent = capacityHelpText(roomStore.onlineRules()?.minPlayers ?? null);

    if (listError !== null) {
      el.list.replaceChildren();
      // 낭독은 라이브 리전인 요약 줄이 맡는다. 맨 위 알림에 같은 말을 겹쳐 띄우지 않는다
      setSummary('방 목록을 불러오지 못했어요.', quiet);
      showEmptyState({
        title: '온라인에 연결할 수 없어요',
        copy: listError,
        action: 'retry',
        label: '다시 시도',
        practice: false,
      });
      return;
    }

    const visible = filterAndSortRooms(rooms, filters);
    el.list.replaceChildren();
    visible.forEach((room) => el.list.append(createItem(room)));

    setSummary(`전체 ${rooms.length}개 중 ${visible.length}개 방`, quiet);
    if (visible.length === 0) {
      if (rooms.length > 0) {
        showEmptyState({
          title: '조건에 맞는 방이 없어요',
          copy: '필터를 초기화하면 다른 방을 다시 볼 수 있어요.',
          action: 'reset',
          label: '필터 초기화',
          practice: false,
        });
        return;
      }
      // 혼자 온 사람에게 막다른 길이 되지 않게 한다. 가짜 대기 인원이나 봇으로 메우지 않는다 (U29).
      // 방장 혼자서도 여는 API면 «혼자서도 바로 시작»을 먼저 말하고 만들기로 잇는다. 둘부터인
      // 이전 API면 «친구를 불러야 (2명부터)»와 홈의 「혼자 연습하기」다 — 세션이 알려 준 규칙을 따른다.
      showEmptyState({ ...lobbyEmptyCopy(roomStore.onlineRules()?.minPlayers ?? null), action: 'create' });
      return;
    }

    el.empty.hidden = true;
    el.list.hidden = false;
  }

  /** 목록 요청 하나. 도는 동안 `listFetches`가 센다 — 주기 새로고침은 그동안 차례를 건너뛴다 */
  async function fetchRooms(): Promise<PublicRoom[]> {
    listFetches += 1;
    try {
      return await roomStore.listRooms();
    } finally {
      listFetches -= 1;
    }
  }

  /**
   * 목록을 다시 읽는다. 도는 동안 새로고침·다시 시도를 잠가 같은 요청이 쌓이지 않게 한다 —
   * 같은 와이파이의 여럿이 IP당 한도를 함께 쓴다 (N01). 주기 새로고침(`refreshQuietly`)이 도는 중이면
   * 그것이 끝난 뒤에 보낸다(겹쳐 보내지 않는다). 끝나면 주기 새로고침이 여기서부터 다시 센다.
   */
  async function loadRooms(request: number): Promise<void> {
    const listRequest = ++listRequestGeneration;
    const retry = el.emptyAction.dataset.action === 'retry' ? el.emptyAction : null;
    const retryHadFocus = retry !== null && document.activeElement === retry;
    setBusy(el.refresh, true);
    if (retry) setBusy(retry, true);
    let loaded = false;
    try {
      // 그 결과는 위에서 올린 세대가 버린다. 나가기 뒤의 조회처럼 그 뒤의 상태를 읽어야 하므로 새로 보낸다
      if (quietFetch) await quietFetch;
      const loadedRooms = await fetchRooms();
      loaded = true;
      if (!ownsScreen(request) || listRequest !== listRequestGeneration) return;
      rooms = loadedRooms;
      listError = null;
      renderList();
    } catch (error) {
      if (!ownsScreen(request) || listRequest !== listRequestGeneration) return;
      // 개발 상세(«서버 방 응답이…», «Failed to fetch»)는 콘솔에만 남긴다 (U40)
      rooms = [];
      listError = onlineErrorText(error, '잠시 후 다시 시도해 주세요.');
      renderList();
    } finally {
      // 더 늦게 시작한 조회가 있으면 그쪽이 푼다. 화면을 떠났으면 다음 진입의 조회가 푼다
      if (listRequest === listRequestGeneration) {
        setBusy(el.refresh, false);
        if (retry) setBusy(retry, false);
        // 다시 시도가 통해 오류 칸이 접혔으면 그 버튼으로는 포커스를 돌려줄 수 없다 (a11y-ux-07)
        if (retryHadFocus) focusRevealedList();
        refresher.loaded(loaded);
      }
    }
  }

  /**
   * 캐릭터가 목록 쪽에 있는가 — 보이는 목록(없으면 빈 칸)과 가로로 겹치고 그 위 끝보다 아래다. 다시 그리면 그 아래의
   * 줄이 모두 움직일 수 있어(새 방은 제 무리의 맨 앞에 들고, 가득 차거나 판을 연 방은 자리를 옮긴다) 줄 사이나 목록 아래
   * 빈자리에 서 있어도 발밑에 다른 방이 들어온다
   */
  function walkerNearList(): boolean {
    const zone = (el.list.hidden ? el.empty : el.list).getBoundingClientRect();
    const body = el.character.getBoundingClientRect();
    if (zone.width === 0 || body.width === 0) return false;
    return body.right >= zone.left && body.left <= zone.right && body.bottom >= zone.top;
  }

  /**
   * 사람이 목록에서 무엇을 고르는 중인가. 그때 목록을 다시 그리면 포커스가 `<body>`로 떨어지고(낭독기는 자리를 잃는다),
   * 순서가 바뀌면 같은 자리를 누른 클릭·탭·Enter가 다른 방에 들어간다 — 공개방의 「참가」는 묻지 않고 바로 들어간다.
   * 그래서 주기 새로고침은 그동안 기다린다
   * - 포커스가 방 목록·빈 칸 안에 있다(Tab)
   * - 마우스·펜·손가락이 그 위에 있거나, 떠나거나 로비를 민 지 `ROOM_LIST_SETTLE_MS`가 안 됐다 — 누르기 전에 포커스를
   *   옮기지 않는 클릭·탭은 포커스로 알 수 없다
   * - 캐릭터가 그 안의 버튼을 밟고 있거나(`.is-standing`), 걷는 중이거나, 목록 쪽에 서 있다(`walkerNearList`)
   */
  function choosingFromList(): boolean {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body
        && (el.list.contains(active) || el.empty.contains(active))) {
      return true;
    }
    if (listPointers.size > 0 || clock.now() - listTouchedAt < ROOM_LIST_SETTLE_MS) return true;
    if (el.list.querySelector('.is-standing') !== null || el.empty.querySelector('.is-standing') !== null) return true;
    return el.character.classList.contains('walker--walking') || walkerNearList();
  }

  for (const zone of [el.list, el.empty]) {
    zone.addEventListener('pointerenter', (event) => { listPointers.add(event.pointerId); });
    // 손가락은 떼거나 스크롤로 넘어갈 때(pointercancel) 여기로 온다
    zone.addEventListener('pointerleave', (event) => {
      listPointers.delete(event.pointerId);
      listTouchedAt = clock.now();
    });
  }
  // 휴대폰은 목록이 접힘 아래라 머리말을 밀어 내려온다. 민 직후에 겨눈 탭도 고르는 중이다
  window.addEventListener('scroll', () => {
    if (!el.screen.hidden) listTouchedAt = clock.now();
  }, { passive: true });

  /** 주기 새로고침이 지금 목록을 읽어도 되는가 (`ui/lobby-refresh.ts`의 `canRefresh`) */
  function canRefreshQuietly(): boolean {
    if (visibleRequest === null || !ownsScreen(visibleRequest)) return false;
    // 로비와 방 목록 칸이 보일 때만. 코드 참가·방 만들기를 연 동안에는 목록이 숨어 있다
    if (el.screen.hidden || el.roomBrowser.hidden) return false;
    // 목록 요청이나 누른 일(참가·만들기·나가기)이 도는 중이면 겹쳐 보내지도, 그 버튼을 다시 그리지도 않는다
    if (listFetches > 0 || busyCount > 0) return false;
    return !choosingFromList();
  }

  /**
   * 주기 새로고침 한 번 (WP-E). 사람이 누른 새로고침과 달리 **조용하다** — 새로고침·다시 시도 버튼을 잠그지 않는다
   * (잠그면 그 버튼의 포커스가 떨어졌다 돌아오며 다시 낭독된다). 실패해도 화면을 «연결할 수 없어요»로 바꾸지 않고
   * 마지막 목록을 둔 채 간격만 늘린다(오류는 콘솔에만). 바뀐 것이 없으면 다시 그리지 않고, 바뀌어도 요약 줄은 글이
   * 달라질 때만 고친다 — 낭독되는 것은 방 수가 바뀐 때뿐이다. 포커스는 옮기지 않는다.
   */
  async function refreshQuietly(): Promise<boolean> {
    const request = visibleRequest;
    if (request === null || !ownsScreen(request)) return true;
    const listRequest = ++listRequestGeneration;
    const pending = fetchRooms();
    const settled = pending.then(() => undefined, () => undefined);
    quietFetch = settled;
    try {
      const loadedRooms = await pending;
      if (!ownsScreen(request) || listRequest !== listRequestGeneration) return true;
      // 기다리는 사이 사람이 목록을 고르기 시작했으면 그리지 않는다. 다음 차례에 다시 읽는다
      if (choosingFromList() || busyCount > 0) return true;
      if (listError === null && !roomListChanged(rooms, loadedRooms)) return true;
      rooms = loadedRooms;
      listError = null;
      renderList({ quiet: true });
      // 목록이 바뀌어 캐릭터 발밑에 다른 것이 왔을 수 있다. 밟은 표시를 지금 화면으로 다시 잰다
      walker.refresh();
      return true;
    } catch (error) {
      console.warn('[로비] 방 목록을 조용히 다시 읽지 못했습니다. 마지막 목록을 그대로 둡니다', error);
      return false;
    } finally {
      if (quietFetch === settled) quietFetch = null;
    }
  }

  const refresher = createLobbyRefresh({
    refresh: refreshQuietly,
    canRefresh: canRefreshQuietly,
    documentHidden: () => document.visibilityState === 'hidden',
    clock,
  });
  // 다른 탭·앱으로 가면 시계를 끄고, 돌아오면 밀린 차례를 곧바로 한 번 읽는다
  document.addEventListener('visibilitychange', () => refresher.visibilityChanged());

  /**
   * 빈 상태의 버튼을 눌렀더니 그 칸이 접혔다(다시 시도가 통했거나 필터를 풀었다). 누른 버튼이 숨어
   * 포커스가 `<body>`로 떨어지면 다음 Tab이 페이지 맨 위에서 시작하고, 방금 나타난 방들을 지나친다.
   * 그래서 목록의 첫 버튼(없으면 늘 보이는 새로고침)으로 옮긴다. 빈 상태가 그대로면(방이 여전히
   * 없거나 다시 실패했다) 같은 버튼이 보이므로 `setBusy`가 돌려준 자리를 둔다.
   */
  function focusRevealedList(): void {
    if (el.screen.hidden || !el.empty.hidden) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== el.emptyAction) return;
    const first = el.list.querySelector<HTMLButtonElement>('button:not([disabled])');
    (first ?? el.refresh).focus({ preventScroll: true });
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
  async function leave(code: string, trigger?: HTMLButtonElement): Promise<void> {
    const request = visibleRequest;
    if (request === null || !ownsScreen(request)) return;
    if (trigger) setBusy(trigger, true);
    try {
      await roomStore.leaveRoom({ code });
      if (!ownsScreen(request)) return;
      await loadRooms(request);
    } catch (error) {
      if (!ownsScreen(request)) return;
      // 거절과 연결 실패를 가른다. 판이 도는 방은 연결이 아니라 언제 되는지를 말한다 (U32)
      say(
        el.message,
        error instanceof LeaveRoomRejected
          ? LEAVE_MESSAGES[error.reason]
          : `방에서 나오지 못했어요. ${onlineErrorText(error, '연결을 확인한 뒤 다시 시도해 주세요.')}`,
        'bad',
      );
    } finally {
      if (trigger) setBusy(trigger, false);
    }
  }

  /**
   * @param trigger 요청이 도는 동안 잠글 버튼. 목록의 「참가」면 그 버튼, 아니면 폼의 제출 버튼
   */
  async function joinByCode(
    code: string,
    password: string,
    messageNode: HTMLElement = el.joinMessage,
    trigger: HTMLButtonElement = el.joinSubmit,
  ): Promise<void> {
    // 이미 도는 참가 요청이 있다. 소유권을 잡기 전에 돌려보낸다 — 먼저 잡으면 도는 요청의
    // 결과가 «더 새 동작에 밀렸다»며 버려져, 들어가 놓고도 대기실로 넘어가지 않는다
    if (trigger.disabled) return;
    const owner = captureNavigationAction();
    if (!owner) return;
    setBusy(trigger, true, trigger === el.joinSubmit ? '참가하는 중…' : undefined);
    try {
      const result = await roomStore.joinRoom({ code, password, player: getPlayer() });
      if (!ownsNavigationAction(owner)) return;
      if (!result.ok) {
        say(messageNode, JOIN_MESSAGES[result.reason] ?? '들어가지 못했어요.', 'bad');
        // 잠긴 방이면 비밀번호 칸으로 데려간다. 초대 링크로 곧장 들어오려던 사람도 이 길을 탄다
        if (messageNode === el.joinMessage
            && (result.reason === 'need-password' || result.reason === 'wrong-password')) {
          el.joinPassword.focus({ preventScroll: true });
        }
        return;
      }

      el.joinForm.reset();
      commitEnterRoom(result.room.code, owner);
    } catch (error) {
      if (!ownsNavigationAction(owner)) return;
      say(messageNode, `방에 들어가지 못했어요. ${onlineErrorText(error, '네트워크 상태를 확인해 주세요.')}`, 'bad');
    } finally {
      setBusy(trigger, false);
    }
  }

  el.joinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const checked = checkCodeInput(el.joinCode.value);
    if (!checked.ok) {
      say(el.joinMessage, checked.message, 'bad');
      el.joinCode.focus();
      return;
    }
    await joinByCode(checked.value, el.joinPassword.value);
  });

  // 한글 자판 그대로 치면 글자를 지우지 않고 이유를 바로 알린다. 제출해서야 «여섯 글자가
  // 아니다»를 들으면 무엇이 틀렸는지 알 수 없다 (U27). 같은 말을 되풀이해 낭독하지 않게
  // 상태가 바뀔 때만 고친다.
  el.joinCode.addEventListener('input', () => {
    const showing = !el.joinMessage.hidden && el.joinMessage.textContent === CODE_MESSAGES.hangul;
    if (hasHangul(el.joinCode.value)) {
      if (!showing) say(el.joinMessage, CODE_MESSAGES.hangul, 'bad');
    } else if (showing) {
      say(el.joinMessage, '');
    }
  });

  // 칸은 코드 길이까지만 받아 붙여 넣은 초대 링크가 잘린다. 붙여 넣는 순간 코드만 뽑아 넣는다
  el.joinCode.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    const code = normalizeCode(text);
    if (!isValidCode(code) || code === text) return;
    event.preventDefault();
    el.joinCode.value = code;
    el.joinCode.dispatchEvent(new Event('input'));
  });

  // ── 만들기 ─────────────────────────────────────────────────────

  el.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    // 이미 만드는 중이다. 두 번 누르면 방이 둘 생긴다
    if (el.createSubmit.disabled) return;
    // 서버와 같은 규칙으로 먼저 본다. 비워 둔 채 보내 거절당하는 길을 막는다 (U41)
    const name = checkRoomName(el.createName.value);
    if (!name.ok) {
      say(el.createMessage, name.message, 'bad');
      el.createName.focus();
      return;
    }
    const isPublic = !el.createPrivate.checked;
    const selected = CATEGORIES.find((category) => category.id === el.createCategory.value);
    const owner = captureNavigationAction();
    if (!owner) return;

    setBusy(el.createSubmit, true, '만드는 중…');
    try {
      const result = await roomStore.createRoom({
        name: name.value,
        categoryId: selected ? selected.id : null,
        capacity: Number(el.createCapacity.value),
        questionTimeMs: onlineQuestionTimeOrDefault(Number(el.createQuestionTime.value)),
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
      el.createQuestionTime.value = String(TIME_LIMIT_MS);
      syncPrivatePassword();
      suggestRoomName();
      // 만들자마자 대기실로 들어간다. 목록으로 돌아가 다시 찾을 이유가 없다
      commitEnterRoom(result.room.code, owner);
    } catch (error) {
      if (!ownsNavigationAction(owner)) return;
      say(el.createMessage, `방을 만들지 못했어요. ${onlineErrorText(error, '네트워크 상태를 확인해 주세요.')}`, 'bad');
    } finally {
      setBusy(el.createSubmit, false);
    }
  });

  // ── 목록 필터와 주요 동작 ───────────────────────────────────────

  el.filterToggle.addEventListener('click', () => setFiltersExpanded(Boolean(el.filters.hidden)));
  el.search.addEventListener('input', () => renderList());
  for (const select of [el.visibility, el.availability, el.categoryFilter]) {
    select.addEventListener('change', () => renderList());
  }

  function resetRoomFilters(): void {
    el.search.value = DEFAULT_ROOM_FILTERS.query;
    el.visibility.value = DEFAULT_ROOM_FILTERS.visibility;
    el.availability.value = DEFAULT_ROOM_FILTERS.availability;
    el.categoryFilter.value = DEFAULT_ROOM_FILTERS.categoryId;
    setFiltersExpanded(false);
    renderList();
  }

  // reset 이벤트 시점에는 입력값이 아직 이전 값이다. 한 작업 뒤에 다시 그린다.
  el.filters.addEventListener('reset', () => setTimeout(resetRoomFilters, 0));

  el.emptyAction.addEventListener('click', () => {
    const action = el.emptyAction.dataset.action;
    if (action === 'create') {
      showPanel('create');
      el.createBlock.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
      el.createName.focus({ preventScroll: true });
      return;
    }
    if (action === 'retry') {
      if (visibleRequest !== null) void loadRooms(visibleRequest);
      return;
    }
    // 그 버튼에 포커스가 있던 때만 옮긴다. 캐릭터가 밟아 누른(click) 것이면 포커스를 주지 않는다 —
    // 버튼에 포커스가 생기면 다음 Enter가 발밑이 아니라 그 버튼을 누른다(walker의 «비켜난다» 규칙)
    const hadFocus = document.activeElement === el.emptyAction;
    resetRoomFilters();
    if (hadFocus) focusRevealedList();
  });
  el.emptySecondary.addEventListener('click', leaveForPractice);

  el.openPublic.addEventListener('click', () => {
    showPanel('rooms');
    el.summary.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
  });

  el.openPrivate.addEventListener('click', () => {
    showPanel('join');
    el.joinBlock.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
    el.joinCode.focus({ preventScroll: true });
  });

  el.openCreate.addEventListener('click', () => {
    showPanel('create');
    el.createBlock.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
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
  showPanel('rooms');

  return {
    async show(characterId, notice) {
      const request = screenGuard.begin();
      visibleRequest = request;
      navigationActionGeneration += 1;
      listRequestGeneration += 1;
      // 아직 숨은 화면이다. 주기 새로고침은 화면이 보인 뒤 activate()가 켠다 — 아래 조회부터 센다
      refresher.stop();
      say(el.joinMessage, '');
      say(el.createMessage, '');
      // 화면이 아직 숨어 있다. 지금 넣으면 낭독되지 않으므로 activate()가 보인 뒤에 넣는다
      say(el.message, '');
      pendingNotice = notice ?? null;
      suggestRoomName();
      // 이전 방문에서 코드 참가/공개방 찾기가 바꾼 필터를 새 진입까지 끌고 오면
      // '방 찾기'가 선택됐는데 잠긴 방만 보이는 모순이 생긴다. 로비는 매번 기본 목록으로 연다.
      resetRoomFilters();
      showPanel('rooms');
      await loadRooms(request);
      if (!ownsScreen(request)) return;
      walker.show(characterId);
    },

    activate() {
      const notice = pendingNotice;
      pendingNotice = null;
      if (visibleRequest === null || !ownsScreen(visibleRequest)) return;
      // 로비가 보인다. 이제부터 목록을 30초마다 조용히 다시 읽는다 (WP-E). 떠나면 hide()가 멈춘다
      refresher.start();
      if (notice) say(el.message, notice, 'bad');
    },

    acceptInvite(rawCode) {
      if (visibleRequest === null || !ownsScreen(visibleRequest)) return;
      const code = normalizeCode(rawCode);
      if (!isValidCode(code)) {
        showPanel('join');
        el.joinCode.value = code;
        el.joinPassword.value = '';
        say(el.joinMessage, '초대 링크의 방 코드가 올바르지 않아요. 받은 코드를 직접 적어 주세요.', 'bad');
        el.joinBlock.scrollIntoView({ block: 'nearest' });
        el.joinCode.focus({ preventScroll: true });
        return;
      }

      const room = rooms.find((item) => item.code === code);
      // 이미 들어가 있는 방이면 다시 참가할 것 없이 들어간다. 대기실이 진행 중인 판으로 이어 준다
      if (room?.joined) {
        enterRoom(code);
        return;
      }
      // 잠긴 방은 비밀번호를 링크에 싣지 않는다. 코드를 채워 두고 비밀번호 칸에 선다
      if (room && !room.isPublic) {
        preparePrivateJoin(room);
        return;
      }

      showPanel('join');
      el.joinCode.value = code;
      el.joinPassword.value = '';
      el.joinBlock.scrollIntoView({ block: 'nearest' });
      if (room && isRoomPlaying(room)) {
        say(el.joinMessage, JOIN_MESSAGES['game-in-progress'], 'bad');
        el.joinCode.focus({ preventScroll: true });
        return;
      }
      // 공개방이거나 목록에 없는 방(목록은 최근 100개까지다). 바로 참가해 보고, 잠겨
      // 있으면 저장소의 need-password 를 받아 비밀번호 칸으로 데려간다
      say(el.joinMessage, '');
      void joinByCode(code, '');
    },

    hide() {
      invalidateScreenOwnership();
      walker.hide();
    },
  };
}
