// «이 사람 말 숨기기» (N06). **내 화면에서만** 그 사람의 말풍선과 대화 줄을 그리지 않는다.
//
// 서버에 보내지 않는다 — 남을 막는 장치가 아니라 내가 보지 않는 장치라 쓰는 사람이 늘어도 해칠
// 길이 없다. 그래서 상대는 숨겨진 줄 모르고, 방장 권한도 필요 없다. 방 코드마다 이 페이지의 메모리에만
// 둔다: 대기실과 그 방의 온라인 퀴즈가 같은 목록을 보고, 새로고침하면 처음으로 돌아간다(브라우저
// 저장소에 남기지 않는다 — 누구를 숨겼는지는 그 판 동안만의 일이다).
//
// DOM도 저장소도 모른다. `app.ts`가 하나 만들어 두 화면에 넘긴다.

export interface ChatMutes {
  /** 이 방에서 그 사람의 말을 숨겼는가 */
  isMuted(code: string, playerId: string): boolean;
  /** 숨김을 뒤집고 새 상태를 돌려준다 (true = 이제 숨김) */
  toggle(code: string, playerId: string): boolean;
}

export function createChatMutes(): ChatMutes {
  const rooms = new Map<string, Set<string>>();

  return {
    isMuted(code, playerId) {
      return rooms.get(code)?.has(playerId) ?? false;
    },

    toggle(code, playerId) {
      const muted = rooms.get(code) ?? new Set<string>();
      rooms.set(code, muted);
      if (muted.delete(playerId)) return false;
      muted.add(playerId);
      return true;
    },
  };
}

/** 숨김을 켜고 끌 때 대화 로그에 남기는 한 줄. 버튼의 `aria-pressed`와 함께 무엇이 바뀌었는지 말한다 */
export function chatMuteNotice(nickname: string, muted: boolean): string {
  return muted
    ? `${nickname} 님의 말을 숨겼어요. 내 화면에서만 숨겨져요.`
    : `${nickname} 님의 말을 다시 보여요.`;
}
