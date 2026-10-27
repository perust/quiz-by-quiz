// «한 판 더» (U38)
//
// 온라인 최종 순위에서 같은 방의 다음 판으로 돌아가는 길이다. 방장이 아니면 대기실을 열기 전에 준비를
// 켜 둔다 — 재대결이 «참가자의 「한 판 더」 한 번 + 방장의 「게임 시작」 한 번»으로 끝난다. 방장은 시작
// 요청이 곧 준비라(U28) 따로 준비하지 않고 대기실의 「게임 시작」만 보면 된다.
//
// **준비를 켜지 못해도 막지 않는다.** 연결이 끊겼거나 요청 한도에 걸렸거나 방이 사라졌으면 대기실이
// 그 방을 다시 읽어 보이고(사라졌으면 이유와 함께 로비로 간다), 거기의 「준비 완료」를 다시 누르면 된다.
// 대기실을 열기 **전에** 켜 두므로 대기실은 처음부터 «준비 취소»로 그려지고 토글이 깜빡이지 않는다.
//
// **기다리는 사이 다른 행동(홈·대기실로)을 눌렀으면 그쪽이 이긴다 — 화면에서도, 서버에서도** (online-flow-1).
// 화면만 이기고 준비가 서버에 남으면, 대기실을 보지도 못한 사람이 홈에 있는 동안(소켓을 놓아도 60초 유예
// 안이라 «접속 중»이다) 방장의 다음 시작에 끌려 들어가 문항마다 마감을 기다리게 하고 0점으로 순위에 남는다.
// 그래서 방을 읽은 뒤 준비를 보내기 전에 한 번 더 묻고, 이미 보낸 준비는 되돌린다.

import type { RoomStore } from './adapter.js';

export type RematchReadiness = 'readied' | 'host' | 'already-ready' | 'skipped';

type RematchStore = Pick<RoomStore, 'getRoom' | 'setReady' | 'me'>;

/**
 * @param isStillCurrent 「한 판 더」를 누른 화면이 아직 이기고 있는가. 방을 읽는 사이 다른 행동을
 *   눌렀으면 준비를 보내지 않는다
 */
export async function readyForRematch(
  store: RematchStore,
  code: string,
  isStillCurrent: () => boolean = () => true,
): Promise<RematchReadiness> {
  try {
    const room = await store.getRoom(code);
    if (!isStillCurrent()) return 'skipped';
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

export interface RematchFlow {
  store: RematchStore;
  code: string;
  /** 「한 판 더」를 누른 화면이 아직 이기고 있는가 (app.ts 의 navigation 세대와 그 방) */
  isStillCurrent: () => boolean;
  /**
   * 그 방의 대기실에 있거나 들어가는 중인가. 그러면 켜 둔 준비를 그대로 둔다 — 대기실이 «준비 취소»로
   * 보여 주고 거기서 무를 수 있다
   */
  isInWaitingRoom: () => boolean;
  openWaitingRoom: () => Promise<void>;
}

/**
 * 「한 판 더」의 흐름 전체. 준비를 켜 두고 대기실을 연다. 기다리는 사이 다른 행동이 이겼으면 대기실을
 * 열지 않고, 그사이 서버에 닿은 준비는 (그 방의 대기실로 간 것이 아니면) 되돌린다.
 */
export async function playAgainInRoom(flow: RematchFlow): Promise<RematchReadiness> {
  const readiness = await readyForRematch(flow.store, flow.code, flow.isStillCurrent);
  if (!flow.isStillCurrent()) {
    // 화면을 붙들지 않는다 — 옮긴 화면은 이미 그려졌다. 되돌리지 못하면 대기실의 토글이 남는 길이다
    if (readiness === 'readied' && !flow.isInWaitingRoom()) void undoReady(flow.store, flow.code);
    return readiness;
  }
  await flow.openWaitingRoom();
  return readiness;
}

async function undoReady(store: RematchStore, code: string): Promise<void> {
  try {
    await store.setReady({ code, isReady: false });
  } catch (error) {
    console.warn('[한 판 더] 켜 둔 준비를 되돌리지 못했습니다', error);
  }
}
