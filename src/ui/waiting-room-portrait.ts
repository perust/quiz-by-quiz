// 대기실 참가자 액자에 필요한 표시 모델.
//
// 움직이는 캐릭터와 참가자 명단이 같은 전신 그림으로 겹쳐 보이지 않도록,
// 명단은 벽걸이 초상 액자로만 그린다. 참가자 배열은 방장 승계 순서라 첫 사람이
// 현재 방장이다(방장이 나가면 가장 먼저 들어온 남은 사람이 첫 자리로 승계된다).

import type { PublicPlayer } from '../online/adapter.js';

export interface WaitingRoomPortrait {
  id: string;
  nickname: string;
  characterId: string;
  isHost: boolean;
  isMe: boolean;
  isReady: boolean;
  statusLabel: '대기' | '준비';
}

export function waitingRoomPortraits(
  players: readonly PublicPlayer[],
  localPlayerId: string,
): WaitingRoomPortrait[] {
  return players.map((player, index) => ({
    id: player.id,
    nickname: player.nickname,
    characterId: player.characterId,
    isHost: index === 0,
    isMe: player.id === localPlayerId,
    isReady: player.isReady,
    statusLabel: player.isReady ? '준비' : '대기',
  }));
}
