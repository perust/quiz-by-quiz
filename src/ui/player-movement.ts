// 다른 참가자의 화면 좌표와 내 이동 전송 빈도를 관리한다.
//
// 좌표는 viewport 비율(0~1)과 송신 viewport 크기를 함께 보낸다. 수신 화면은
// 중심 기준 CSS-pixel offset을 복원하므로 작은 화면에서 보낸 이동이 큰 화면에서
// 과장되지 않는다. 크기가 없는 구형 event만 기존 viewport 비율로 그린다.
// 서버 sequence는 한 연결에서 뒤늦게 온 event를 버리고, connection generation이
// 바뀌면 서버 재시작·재연결 뒤 낮아진 sequence도 새 흐름으로 받아들인다.

import {
  type MovementViewport,
  validMovementViewportDimension,
} from '../online/movement-contract.js';

interface MovementPosition {
  x: number;
  y: number;
  moving: boolean;
}

export interface MovementSample extends MovementPosition, MovementViewport {}

/** 화면별 워커 좌표를 공통 0~1 viewport 좌표로 바꾼다. */
export function normalizeViewportMovement(
  point: Readonly<{ x: number; y: number }>,
  moving: boolean,
  viewport: Readonly<{ width: number; height: number }>,
): MovementSample | null {
  const viewportWidth = Math.round(viewport.width);
  const viewportHeight = Math.round(viewport.height);
  if (
    !Number.isFinite(point.x)
    || !Number.isFinite(point.y)
    || !validMovementViewportDimension(viewportWidth)
    || !validMovementViewportDimension(viewportHeight)
    || typeof moving !== 'boolean'
  ) return null;
  return {
    x: Number(Math.min(1, Math.max(0, point.x / viewportWidth)).toFixed(4)),
    y: Number(Math.min(1, Math.max(0, point.y / viewportHeight)).toFixed(4)),
    moving,
    viewportWidth,
    viewportHeight,
  };
}

export interface RemoteMovement extends MovementPosition, Partial<MovementViewport> {
  playerId: string;
  sequence: number;
  connectionGeneration: number;
}

interface MovementState extends MovementPosition, Partial<MovementViewport> {
  sequence: number;
  connectionGeneration: number;
}

const NAME_ABOVE_THRESHOLD = 0.9;
const NAME_SIDE_THRESHOLD = 0.2;

export interface PlayerMovementController {
  /** 현재 room snapshot에 실제로 남아 있는 상대만 표시한다. */
  reconcile(playerIds: readonly string[]): void;
  /** snapshot rerender로 새로 만든 캐릭터 DOM을 연결한다. */
  bind(playerId: string, node: HTMLElement): void;
  /** DOM만 떼고 좌표는 보존한다. */
  unbindAll(): void;
  /** 인증된 server event를 적용한다. 아직 snapshot에 없으면 좌표만 잠시 보존한다. */
  update(movement: RemoteMovement): void;
  /** 방을 떠날 때 이전 방의 node·좌표·sequence를 모두 지운다. */
  reset(): void;
}

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * 송신 화면 중심에서 실제로 움직인 CSS-pixel offset을 복원한다.
 *
 * 390px 화면에서 80px 움직이면 1440px 수신 화면에서도 80px만 움직인다. 화면
 * 중심은 서로 맞추므로 반응형 UI의 가운데 무대도 대체로 같은 자리에 겹친다.
 */
export function remoteMovementOffset(
  movement: Readonly<MovementPosition & Partial<MovementViewport>>,
): Readonly<{ x: number; y: number }> | null {
  if (
    !validUnit(movement.x)
    || !validUnit(movement.y)
    || !validMovementViewportDimension(movement.viewportWidth)
    || !validMovementViewportDimension(movement.viewportHeight)
  ) return null;
  return {
    x: (movement.x - 0.5) * movement.viewportWidth,
    y: (movement.y - 0.5) * movement.viewportHeight,
  };
}

function cssNumber(value: number): string {
  return String(Number(Math.abs(value).toFixed(4)));
}

function centeredAxis(center: '50vw' | '50vh', limit: '100vw' | '100vh', offset: number): string {
  if (Math.abs(offset) < 0.00005) return `clamp(0px, ${center}, ${limit})`;
  const operator = offset < 0 ? '-' : '+';
  return `clamp(0px, calc(${center} ${operator} ${cssNumber(offset)}px), ${limit})`;
}

function projectedUnitPosition(
  node: HTMLElement,
  state: MovementState,
  offset: Readonly<{ x: number; y: number }> | null,
): Readonly<{ x: number; y: number }> {
  const view = node.ownerDocument?.defaultView;
  if (
    !offset
    || !view
    || !Number.isFinite(view.innerWidth)
    || !Number.isFinite(view.innerHeight)
    || view.innerWidth <= 0
    || view.innerHeight <= 0
  ) return state;
  return {
    x: Math.min(1, Math.max(0, (view.innerWidth / 2 + offset.x) / view.innerWidth)),
    y: Math.min(1, Math.max(0, (view.innerHeight / 2 + offset.y) / view.innerHeight)),
  };
}

function project(node: HTMLElement, state: MovementState): void {
  const offset = remoteMovementOffset(state);
  const projected = projectedUnitPosition(node, state, offset);
  node.style.transform = offset
    ? `translate(${centeredAxis('50vw', '100vw', offset.x)}, ${centeredAxis('50vh', '100vh', offset.y)}) translate(-50%, -100%)`
    : `translate(${state.x * 100}vw, ${state.y * 100}vh) translate(-50%, -100%)`;
  node.classList.toggle('walker--walking', state.moving);
  node.classList.toggle('walker--idle', !state.moving);
  node.classList.toggle('walker--name-above', projected.y >= NAME_ABOVE_THRESHOLD);
  node.classList.toggle('walker--name-left', projected.x <= NAME_SIDE_THRESHOLD);
  node.classList.toggle('walker--name-right', projected.x >= 1 - NAME_SIDE_THRESHOLD);
  node.hidden = false;
}

export function createPlayerMovementController(): PlayerMovementController {
  let allowed = new Set<string>();
  const states = new Map<string, MovementState>();
  const nodes = new Map<string, HTMLElement>();

  function hideNodes(): void {
    for (const node of nodes.values()) node.hidden = true;
  }

  return {
    reconcile(playerIds) {
      allowed = new Set(playerIds);
      for (const [playerId, state] of states) {
        if (!allowed.has(playerId)) states.delete(playerId);
        else {
          const node = nodes.get(playerId);
          if (node) project(node, state);
        }
      }
      for (const [playerId, node] of nodes) {
        if (allowed.has(playerId)) continue;
        node.hidden = true;
        nodes.delete(playerId);
      }
    },

    bind(playerId, node) {
      if (!allowed.has(playerId)) {
        node.hidden = true;
        return;
      }
      nodes.set(playerId, node);
      const state = states.get(playerId);
      if (state) project(node, state);
      else node.hidden = true;
    },

    unbindAll() {
      hideNodes();
      nodes.clear();
    },

    update(movement) {
      const hasViewportWidth = movement.viewportWidth !== undefined;
      const hasViewportHeight = movement.viewportHeight !== undefined;
      if (
        !movement.playerId
        || !validUnit(movement.x)
        || !validUnit(movement.y)
        || typeof movement.moving !== 'boolean'
        || hasViewportWidth !== hasViewportHeight
        || (hasViewportWidth && (
          !validMovementViewportDimension(movement.viewportWidth)
          || !validMovementViewportDimension(movement.viewportHeight)
        ))
        || !Number.isSafeInteger(movement.sequence)
        || movement.sequence <= 0
        || !Number.isSafeInteger(movement.connectionGeneration)
        || movement.connectionGeneration < 0
      ) return;

      const previous = states.get(movement.playerId);
      if (previous) {
        if (movement.connectionGeneration < previous.connectionGeneration) return;
        if (
          movement.connectionGeneration === previous.connectionGeneration
          && movement.sequence <= previous.sequence
        ) return;
      }

      const state: MovementState = {
        x: movement.x,
        y: movement.y,
        moving: movement.moving,
        ...(hasViewportWidth ? {
          viewportWidth: movement.viewportWidth,
          viewportHeight: movement.viewportHeight,
        } : {}),
        sequence: movement.sequence,
        connectionGeneration: movement.connectionGeneration,
      };
      states.set(movement.playerId, state);
      if (!allowed.has(movement.playerId)) return;
      const node = nodes.get(movement.playerId);
      if (node) project(node, state);
    },

    reset() {
      hideNodes();
      nodes.clear();
      states.clear();
      allowed.clear();
    },
  };
}

export interface MovementPublisher {
  update(sample: MovementSample): void;
  /** reconnect·room snapshot·heartbeat에서 마지막 좌표를 즉시 다시 보낸다. */
  resend(): void;
  reset(): void;
}

interface MovementPublisherDeps {
  send: (sample: MovementSample) => void;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
}

export function createMovementPublisher({
  send,
  intervalMs = 125,
  now = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (timer) => window.clearTimeout(timer),
}: MovementPublisherDeps): MovementPublisher {
  let latest: MovementSample | null = null;
  let lastSentAt: number | null = null;
  let timer: number | null = null;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function sendLatest(): void {
    cancelTimer();
    if (!latest) return;
    send(latest);
    lastSentAt = now();
  }

  function schedule(delay: number): void {
    if (timer !== null) return;
    timer = setTimer(sendLatest, Math.max(0, delay));
  }

  return {
    update(sample) {
      latest = { ...sample };
      if (!sample.moving || lastSentAt === null) {
        sendLatest();
        return;
      }
      const elapsed = now() - lastSentAt;
      if (elapsed >= intervalMs) sendLatest();
      else schedule(intervalMs - elapsed);
    },

    resend() {
      sendLatest();
    },

    reset() {
      cancelTimer();
      latest = null;
      lastSentAt = null;
    },
  };
}
