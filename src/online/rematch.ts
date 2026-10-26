// «한 판 더» (U38)
//
// 온라인 최종 순위에서 같은 방의 다음 판으로 돌아가는 길이다. 방장이 아니면 대기실을 열기 전에 준비를
// 켜 둔다 — 재대결이 «참가자의 「한 판 더」 한 번 + 방장의 「게임 시작」 한 번»으로 끝난다. 방장은 시작
// 요청이 곧 준비라(U28) 따로 준비하지 않고 대기실의 「게임 시작」만 보면 된다.
//
// **준비를 켜지 못해도 막지 않는다.** 연결이 끊겼거나 요청 한도에 걸렸거나 방이 사라졌으면 대기실이
// 그 방을 다시 읽어 보이고(사라졌으면 이유와 함께 로비로 간다), 거기의 「준비 완료」를 다시 누르면 된다.
// 대기실을 열기 **전에** 켜 두므로 대기실은 처음부터 «준비 취소»로 그려지고 토글이 깜빡이지 않는다.

import type { RoomStore } from './adapter.js';

export type RematchReadiness = 'readied' | 'host' | 'already-ready' | 'skipped';

export async function readyForRematch(
  store: Pick<RoomStore, 'getRoom' | 'setReady' | 'me'>,
  code: string,
): Promise<RematchReadiness> {
  try {
    const room = await store.getRoom(code);
    const me = room?.players.find((player) => player.id === store.me());
    if (!room || !me) return 'skipped';
    if (room.isMine) return 'host';
    if (me.isReady) return 'already-ready';
    const result = await store.setReady({ code, isReady: true });
    return result.ok ? 'readied' : 'skipped';
  } catch (error) {
    // 개발 상세는 콘솔에만 남긴다. 대기실의 준비 토글이 다시 누를 길이다
    console.warn('[한 판 더] 준비를 켜 두지 못했습니다', error);
    return 'skipped';
  }
}
