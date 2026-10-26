// 홈의 «「방」 방에 아직 있어요» 줄 (U35) — 언제 묻고 무엇을 보일지.
//
// 홈으로 와도 방에서 나간 것은 아니다. 새로고침했거나 매치에서 빠져나온 사람이 돌아갈 방을
// 잃지 않게, 아직 들어가 있는 방을 방 저장소에 묻는다. 이 파일은 DOM도 저장소도 모르고
// app.ts가 넘긴 것만 부른다 — 그래서 화면 없이 실제 순서 그대로 돌려 볼 수 있다
// (`tests/home-room-note.test.mjs`).
//
// **주기적으로 묻지 않는다** — 같은 와이파이의 여럿이 IP당 요청 한도를 나눠 쓴다 (N01).
// 온라인(로비·대기실)을 다녀온 뒤 홈에 오면 한 번 묻고, 그 사이에는 마지막 답을 둔다.
//
// **부팅 직후에는 흔적이 있을 때만 묻는다** (server-5). 묻는 순간 서버 세션을 만들고 로비 전체를
// 읽으므로, 로컬 퀴즈만 하러 온 사람까지 매번 그 값을 치르게 하지 않는다. 흔적은 이 브라우저가
// 마지막으로 들어간 방 코드(`preferences`의 lastRoomCode)다. 방에 들어가면 남기고, 그 방에서
// 나오거나 방이 사라졌거나 물어보니 들어간 방이 하나도 없으면 지운다. 방의 권위는 언제나 서버이고
// 이것은 «물어볼 만한가»만 정한다.

/** 홈에서 돌아갈 수 있는 방. 이름은 화면에 보이고 코드는 돌아갈 때 쓴다 */
export interface HomeRoomNoteRoom {
  code: string;
  name: string;
}

export interface HomeRoomNoteDeps {
  /** 서버 권위 방이 있는가. 이 브라우저 안의 방(로컬 구현)이면 묻지 않는다 */
  isNetworked: boolean;
  /** 부팅 때 읽어 둔 흔적. 없으면 null */
  lastRoomCode: string | null;
  /** 흔적을 고쳐 쓴다. null 이면 지운다 */
  saveLastRoomCode: (code: string | null) => void;
  /** 아직 들어가 있는 방들 */
  myRooms: () => Promise<readonly HomeRoomNoteRoom[]>;
  /** 지금 들어가 있다고 아는 방. 여럿이면 이 방을 먼저 보인다 */
  activeRoomCode: () => string | null;
  /** 지금의 화면 이동 세대. 묻는 사이 바뀌면 그 답은 지난 화면의 것이다 */
  navigation: () => number;
  /** 홈의 줄을 그린다. null 이면 거둔다 */
  show: (room: HomeRoomNoteRoom | null) => void;
}

export interface HomeRoomNote {
  /** 방에 들어간다(대기실을 연다). 흔적을 남기고, 다음 홈에서 다시 묻는다 */
  enter(code: string): void;
  /** 그 방에서 나왔다 — 스스로 나왔거나 방이 사라졌다. 그 방의 흔적과 줄을 거둔다 */
  leave(code: string): void;
  /** 로비를 다녀왔다. 다음 홈에서 한 번 다시 묻는다 */
  visitOnline(): void;
  /**
   * 홈이 보인 **직후**(`goTo('home')` 뒤)에 부른다. 부르는 순간의 화면 세대를 쥐고, 답이 오기 전에
   * 화면을 옮겼으면 그 답으로 그리지 않고 다음 홈에서 다시 묻는다.
   *
   * 세대를 부르는 쪽이 넘기지 않는 이유가 있다 — 한때 `goTo` 가 세대를 올리기 **전의** 값을 넘겨,
   * 답이 늘 «지난 화면»으로 읽혀 줄이 한 번도 뜨지 않았고 홈에 올 때마다 목록 GET만 버렸다.
   */
  refresh(): Promise<void>;
}

export function createHomeRoomNote(deps: HomeRoomNoteDeps): HomeRoomNote {
  const { isNetworked, saveLastRoomCode, myRooms, activeRoomCode, navigation, show } = deps;
  let lastRoomCode = deps.lastRoomCode;
  /** 다음 홈에서 물어야 하는가. 처음(부팅 직후)에는 묻는다 — 흔적이 있을 때만 */
  let stale = true;
  /** 이번에 로비·대기실을 다녀왔는가. 그랬으면 흔적이 없어도 묻는다(로비에서 나간 방 등) */
  let wentOnline = false;
  /** 지금 홈에 보이는 방 */
  let shownCode: string | null = null;

  function remember(code: string | null): void {
    if (lastRoomCode === code) return;
    lastRoomCode = code;
    saveLastRoomCode(code);
  }

  function display(room: HomeRoomNoteRoom | null): void {
    shownCode = room?.code ?? null;
    show(room ? { code: room.code, name: room.name } : null);
  }

  return {
    enter(code) {
      wentOnline = true;
      stale = true;
      if (isNetworked) remember(code);
    },

    leave(code) {
      if (lastRoomCode === code) remember(null);
      if (shownCode === code) display(null);
    },

    visitOnline() {
      wentOnline = true;
      stale = true;
    },

    async refresh() {
      if (!isNetworked || !stale) return;
      stale = false;
      // 방에 들어갔던 흔적도, 이번에 온라인을 다녀온 적도 없다 — 들어가 있는 방이 있을 수 없다
      if (lastRoomCode === null && !wentOnline) return;
      const generation = navigation();
      try {
        const rooms = await myRooms();
        if (navigation() !== generation) {
          // 묻는 사이 홈을 떠났다. 지난 화면의 답으로 그리거나 흔적을 고치지 않고 다음 홈에서 다시 묻는다
          stale = true;
          return;
        }
        const active = activeRoomCode();
        const room = rooms.find(({ code }) => code === active) ?? rooms[0] ?? null;
        display(room);
        remember(room?.code ?? null);
      } catch {
        // 안내일 뿐이다. 서버가 안 되면 홈은 그대로 돌고, 온라인을 다녀오면 다시 묻는다
      }
    },
  };
}
