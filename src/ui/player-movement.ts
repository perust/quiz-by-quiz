// 다른 참가자의 화면 좌표와 내 이동 전송 빈도를 관리한다.
//
// 좌표는 viewport 비율(0~1)이라 화면 크기가 달라도 같은 상대 위치에 보인다.
// 서버 sequence는 한 연결에서 뒤늦게 온 event를 버리고, connection generation이
// 바뀌면 서버 재시작·재연결 뒤 낮아진 sequence도 새 흐름으로 받아들인다.

export interface MovementSample {
  x: number;
  y: number;
  moving: boolean;
}

export interface RemoteMovement extends MovementSample {
  playerId: string;
  sequence: number;
  connectionGeneration: number;
}

interface MovementState extends MovementSample {
  sequence: number;
  connectionGeneration: number;
}

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

function project(node: HTMLElement, state: MovementState): void {
  node.style.transform = `translate(${state.x * 100}vw, ${state.y * 100}vh) translate(-50%, -100%)`;
  node.classList.toggle('walker--walking', state.moving);
  node.classList.toggle('walker--idle', !state.moving);
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
      if (
        !movement.playerId
        || !validUnit(movement.x)
        || !validUnit(movement.y)
        || typeof movement.moving !== 'boolean'
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
