// 대기실 참가자 액자에 필요한 표시 모델.
//
// 움직이는 캐릭터와 참가자 명단이 같은 전신 그림으로 겹쳐 보이지 않도록,
// 명단은 벽걸이 초상 액자로만 그린다. 참가자 배열은 방장 승계 순서라 첫 사람이
// 현재 방장이다(방장이 나가거나 오래 끊기면 가장 먼저 들어온 접속 중인 사람이 첫 자리로
// 승계된다).
//
// 방장은 시작 요청이 곧 준비라 언제나 «준비»로 보인다. 연결이 오래 끊긴 사람은 준비
// 여부보다 «연결 끊김»이 먼저다 — 시작 판정이 그 사람을 기다리지 않기 때문이다.

import type { PublicPlayer } from '../online/adapter.js';

export interface WaitingRoomPortrait {
  id: string;
  nickname: string;
  characterId: string;
  isHost: boolean;
  isMe: boolean;
  isReady: boolean;
  connected: boolean;
  statusLabel: '대기' | '준비' | '연결 끊김';
}

export function waitingRoomPortraits(
  players: readonly PublicPlayer[],
  localPlayerId: string,
): WaitingRoomPortrait[] {
  return players.map((player, index) => {
    const isHost = index === 0;
    const isReady = player.connected && (isHost || player.isReady);
    return {
      id: player.id,
      nickname: player.nickname,
      characterId: player.characterId,
      isHost,
      isMe: player.id === localPlayerId,
      isReady,
      connected: player.connected,
      statusLabel: !player.connected ? '연결 끊김' : isReady ? '준비' : '대기',
    };
  });
}

/**
 * 액자에 붙는 작은 버튼 둘 (N06·U24).
 *
 * - **말 숨기기**는 내 액자 말고 모든 액자에 있다. 내 화면에서만 그 사람의 말을 그리지 않는 장치라
 *   권한이 필요 없다. 이름은 바뀌지 않고 숨김 여부는 `aria-pressed`가 말한다 (U54와 같은 이유)
 * - **내보내기**는 방장에게만, 내 액자 말고 모든 액자에 있다(소유자 결정). 언제나 인페이지 확인을
 *   거치고, 확인창이 접속 중인지 끊겼는지에 따라 무엇이 일어나는지 다르게 말한다
 *   (`waitingRoomRemoveDialogText`). 도는 판의 참가자는 판이 끝난 뒤에 — 판정은 저장소가 한다
 */
export interface WaitingRoomPortraitActions {
  mute: boolean;
  /** 지금 그 사람의 말을 숨겼는가 (`aria-pressed`) */
  muted: boolean;
  remove: boolean;
}

export function waitingRoomPortraitActions(
  portrait: Pick<WaitingRoomPortrait, 'isMe' | 'connected'>,
  viewer: { isHost: boolean; muted: boolean },
): WaitingRoomPortraitActions {
  return {
    mute: !portrait.isMe,
    muted: !portrait.isMe && viewer.muted,
    remove: viewer.isHost && !portrait.isMe,
  };
}

/** 말 숨기기 버튼의 이름. 숨겨도 이름은 그대로고 `aria-pressed`가 바뀐다 */
export function waitingRoomMuteLabel(nickname: string): string {
  return `${nickname} 님 말 숨기기`;
}

/** 내보내기 버튼의 이름. 보이는 글자 «내보내기»를 품어 음성 조작으로도 부를 수 있다 */
export function waitingRoomRemoveLabel(nickname: string): string {
  return `${nickname} 님 내보내기`;
}

/**
 * 내보내기 확인창의 제목과 설명. **무엇이 일어나는지를 상태마다 다르게 말한다.**
 *
 * - 접속 중인 사람: 그 사람의 화면이 로비로 돌아가고 잠시 이 방에 다시 들어올 수 없다(서버가 막는다)
 * - 유예를 넘겨 끊긴 사람: 떠난 자리를 비울 뿐이라 돌아오면 같은 코드로 다시 참가할 수 있다
 *
 * 확인한 상태가 곧 요청의 `connected`다 — 끊긴 사람으로 보고 확인한 사이 그 사람이 다시 붙었으면
 * 서버가 거절하고(`member-connected`), 확인창이 말하지 않은 «잠시 들어올 수 없어요»를 걸지 않는다.
 */
export function waitingRoomRemoveDialogText(
  nickname: string,
  connected: boolean,
): { title: string; body: string } {
  return connected
    ? {
      title: `${nickname} 님을 방에서 내보낼까요?`,
      body: `잠시 다시 들어올 수 없어요. ${nickname} 님의 화면은 온라인 로비로 돌아가요.`,
    }
    : {
      title: `${nickname} 님을 내보낼까요?`,
      body: '연결이 끊긴 지 1분이 넘었어요. 내보내면 참가자 목록에서 빠지고, 돌아오면 방 코드로 다시 참가할 수 있어요.',
    };
}
