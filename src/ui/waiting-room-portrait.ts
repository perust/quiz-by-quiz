// 대기실 참가자 액자에 필요한 표시 모델.
//
// 움직이는 캐릭터와 참가자 명단이 같은 전신 그림으로 겹쳐 보이지 않도록,
// 명단은 벽걸이 초상 액자로만 그린다. 참가자 배열은 방장 승계 순서라 첫 사람이
// 현재 방장이다(방장이 나가면 가장 먼저 들어온 남은 사람이, 오래 끊기면 가장 먼저 들어온
// 접속 중인 사람이 첫 자리로 승계된다).
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
