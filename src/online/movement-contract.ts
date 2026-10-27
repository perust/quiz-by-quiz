// 실시간 이동 payload에서 공유하는 viewport 계약.
//
// 좌표는 0~1 비율로 남겨 구형 client와 호환하고, 신형 client는 이 크기로 원래
// CSS-pixel 이동량을 복원한다. 비정상적으로 큰 값은 다른 참가자의 transform에
// 그대로 들어가지 않도록 browser와 server 양쪽에서 같은 범위로 제한한다.

export const MAX_MOVEMENT_VIEWPORT_DIMENSION = 8192;
export const MOVEMENT_VIEWPORT_CAPABILITY = 'sender-css-pixels-v1';
export const WAITING_ROOM_SEAT_CAPABILITY = 'waiting-room-seat-v1';
/**
 * 방 소켓이 발밑 칸 초안(`standing-answer`, U13)을 받는다는 ws-ticket의 표시. 이 값을 주지 않는 이전
 * API는 모르는 메시지를 버리기만 하지만, 그래도 보내지 않는다 — 소켓을 다시 열 때마다 다시 묻는다.
 */
export const STANDING_ANSWER_CAPABILITY = 'standing-answer-v1';
/** 초안의 문항 순서 한도. 서버의 답안 제출(1~25)과 같다 */
export const MAX_STANDING_ANSWER_POSITION = 25;

/** 서버가 relay할 수 있는 논리 좌석. 테이블처럼 앉지 않는 가구는 포함하지 않는다. */
export const WAITING_ROOM_SEAT_IDS = [
  'chair-left',
  'sofa-left',
  'sofa-right',
  'chair-right',
] as const;

export type WaitingRoomSeatId = typeof WAITING_ROOM_SEAT_IDS[number];

export function isWaitingRoomSeatId(value: unknown): value is WaitingRoomSeatId {
  return typeof value === 'string'
    && (WAITING_ROOM_SEAT_IDS as readonly string[]).includes(value);
}

export interface MovementViewport {
  viewportWidth: number;
  viewportHeight: number;
}

export function validMovementViewportDimension(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_MOVEMENT_VIEWPORT_DIMENSION;
}
