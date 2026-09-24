// 실시간 이동 payload에서 공유하는 viewport 계약.
//
// 좌표는 0~1 비율로 남겨 구형 client와 호환하고, 신형 client는 이 크기로 원래
// CSS-pixel 이동량을 복원한다. 비정상적으로 큰 값은 다른 참가자의 transform에
// 그대로 들어가지 않도록 browser와 server 양쪽에서 같은 범위로 제한한다.

export const MAX_MOVEMENT_VIEWPORT_DIMENSION = 8192;
export const MOVEMENT_VIEWPORT_CAPABILITY = 'sender-css-pixels-v1';

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
