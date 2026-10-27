// 다른 참가자의 화면 좌표와 내 이동 전송 빈도를 관리한다.
//
// 좌표는 viewport 비율(0~1)과 송신 viewport 크기를 함께 보낸다. 수신 화면은
// 중심 기준 CSS-pixel offset을 복원하므로 작은 화면에서 보낸 이동이 큰 화면에서
// 과장되지 않는다. 크기가 없는 구형 event만 기존 viewport 비율로 그린다.
// 서버 sequence는 한 연결에서 뒤늦게 온 event를 버리고, connection generation이
// 바뀌면 서버 재시작·재연결 뒤 낮아진 sequence도 새 흐름으로 받아들인다.
//
// **공유 무대 좌표가 먼저다** (U31). 화면 중심에서의 px만으로는 휴대폰에서 3번 칸에 선 사람이
// 데스크톱에서는 질문 위에, 다른 칸 위에 보였다 — 화면마다 무대가 중심에서 다른 자리에 있다. 그래서
// 발이 무대(대기실 라운지·온라인 퀴즈의 2×2 바닥) 안에 있으면 무대에 맞춘 0~1 좌표(`stageX`·`stageY`)를
// 함께 보내고, 같은 무대를 가진 수신 화면은 제 무대의 같은 자리에 세운다. 무대 밖(설정 칸·채팅칸·보기
// 버튼 위)이거나 무대 좌표를 모르는 이전 화면의 이동, 또는 지금 그 무대를 보이지 않는 화면은 예전대로
// 화면 중심의 px로 그린다. 무대가 스크롤과 함께 움직이므로 무대 좌표는 보낼 때 다시 잰다(`restage`).
//
// **배치가 바뀌어 다시 세운 자리는 보간하지 않는다.** 125ms마다 오는 이동 사이는 CSS 전환(145ms)이 잇지만,
// 무대에 맞춘 자리는 스크롤·크기가 바뀔 때마다 px가 바뀐다. 그때도 전환하면 캐릭터가 바닥·칸을 늦게 따라
// 미끄러지고(빠르게 스크롤하면 바닥에서 80px 남짓 떨어진다), 공개 카드로 한 번에 스크롤하면 질문이나 다른
// 칸 위를 지나 제 칸으로 간다. 그래서 `refresh`·`reconcile`·`bind`가 바꾼 자리는 `walker--relayout`을 달아
// 곧바로 옮기고, 다음 이동(`update`·`clearSeat`)이 그것을 뗀다. 좌석에 앉은 사람과 같은 까닭이다.

import {
  isMovementStageId,
  isWaitingRoomSeatId,
  type MovementStage,
  type MovementStageId,
  type MovementViewport,
  type WaitingRoomSeatId,
  validMovementStageUnit,
  validMovementViewportDimension,
} from '../online/movement-contract.js';

interface MovementPosition {
  x: number;
  y: number;
  moving: boolean;
  /** 없으면 서 있거나 걷는 중, 있으면 수신 화면의 같은 논리 좌석에 앉는다. */
  seatId?: WaitingRoomSeatId;
}

export interface MovementSample extends MovementPosition, MovementViewport, Partial<MovementStage> {}

/**
 * 한 화면이 잰 공유 무대의 자리(viewport 기준 CSS px). `floorTop`이 있으면 무대가 벽과 바닥 두 띠다 —
 * 단위 y의 [0, 0.5)가 벽(위 끝 ~ 바닥 시작), [0.5, 1]이 바닥(바닥 시작 ~ 아래 끝)이다. 대기실은 벽이
 * 액자 줄 수와 화면 높이에 따라 늘지만 바닥은 어느 화면이든 같은 높이라, 한 줄로 늘이면 가구 앞에 선
 * 사람이 다른 화면에서 소파 위로 올라갔다.
 */
export interface MovementStageFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 무대 위 끝에서 바닥이 시작하는 곳까지(px). 0보다 크고 높이보다 작아야 쓴다 */
  floorTop?: number;
}

/** 무대 경계에서 벽 띠가 끝나는 단위 y. 보내는 쪽과 받는 쪽이 같은 값을 써야 하는 계약이다 */
export const MOVEMENT_STAGE_FLOOR_UNIT = 0.5;

function usableStageFrame(frame: MovementStageFrame | null | undefined): frame is MovementStageFrame {
  if (
    !frame
    || ![frame.left, frame.top, frame.width, frame.height].every(Number.isFinite)
    || frame.width <= 0
    || frame.height <= 0
  ) return false;
  if (frame.floorTop === undefined) return true;
  return Number.isFinite(frame.floorTop) && frame.floorTop > 0 && frame.floorTop < frame.height;
}

function roundUnit(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

/** viewport 자리를 무대 좌표로. 발이 무대 밖이거나 무대를 잴 수 없으면 null */
export function movementStageUnit(
  frame: MovementStageFrame | null | undefined,
  point: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> | null {
  if (!usableStageFrame(frame) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const dx = point.x - frame.left;
  const dy = point.y - frame.top;
  if (dx < 0 || dx > frame.width || dy < 0 || dy > frame.height) return null;
  let unitY = dy / frame.height;
  if (frame.floorTop !== undefined) {
    unitY = dy < frame.floorTop
      ? MOVEMENT_STAGE_FLOOR_UNIT * (dy / frame.floorTop)
      : MOVEMENT_STAGE_FLOOR_UNIT
        + (1 - MOVEMENT_STAGE_FLOOR_UNIT) * ((dy - frame.floorTop) / (frame.height - frame.floorTop));
  }
  return { x: roundUnit(dx / frame.width), y: roundUnit(unitY) };
}

/** 무대 좌표를 이 화면의 viewport 자리로. 무대를 잴 수 없으면 null */
export function movementStagePoint(
  frame: MovementStageFrame | null | undefined,
  unit: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> | null {
  if (!usableStageFrame(frame) || !validMovementStageUnit(unit.x) || !validMovementStageUnit(unit.y)) {
    return null;
  }
  let dy = unit.y * frame.height;
  if (frame.floorTop !== undefined) {
    dy = unit.y < MOVEMENT_STAGE_FLOOR_UNIT
      ? (unit.y / MOVEMENT_STAGE_FLOOR_UNIT) * frame.floorTop
      : frame.floorTop
        + ((unit.y - MOVEMENT_STAGE_FLOOR_UNIT) / (1 - MOVEMENT_STAGE_FLOOR_UNIT))
          * (frame.height - frame.floorTop);
  }
  return { x: frame.left + unit.x * frame.width, y: frame.top + dy };
}

/**
 * 화면에 그려진 캐릭터의 발끝(viewport px). `.walker`는 발끝을 기준으로 옮기므로 상자의 아래 가운데다.
 * 그려지지 않았으면(숨은 화면) null.
 */
export function walkerFootPoint(node: Element): Readonly<{ x: number; y: number }> | null {
  const box = node.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return { x: box.left + box.width / 2, y: box.bottom };
}

/**
 * 보낼 표본의 무대 좌표를 지금 배치로 다시 맞춘다. 무대 안이면 `stage`·`stageX`·`stageY`를 달고, 무대
 * 밖이거나 무대를 보이지 않으면 셋 다 뗀다. 발의 자리는 지금 그려진 캐릭터(`foot`)가 먼저다 — 공개 카드로
 * 스크롤한 뒤 무대 안의 같은 자리로 옮겨 놓은 캐릭터(`restoreCharacterAnchor`)나 좌석에 맞춘 캐릭터는
 * 이동을 알리지 않아 표본이 옛 자리다. 잴 수 없으면 표본의 viewport 비율에서 되살린다.
 */
export function withMovementStage(
  sample: MovementSample,
  stage: Readonly<{
    id: MovementStageId;
    frame: MovementStageFrame | null;
    foot?: Readonly<{ x: number; y: number }> | null;
  }> | null,
): MovementSample {
  const base: MovementSample = { ...sample };
  delete base.stage;
  delete base.stageX;
  delete base.stageY;
  if (!stage || !isMovementStageId(stage.id)) return base;
  const foot = stage.foot && Number.isFinite(stage.foot.x) && Number.isFinite(stage.foot.y)
    ? stage.foot
    : { x: sample.x * sample.viewportWidth, y: sample.y * sample.viewportHeight };
  const unit = movementStageUnit(stage.frame, foot);
  return unit ? { ...base, stage: stage.id, stageX: unit.x, stageY: unit.y } : base;
}

/** 화면별 워커 좌표를 공통 0~1 viewport 좌표로 바꾼다. */
export function normalizeViewportMovement(
  point: Readonly<{ x: number; y: number }>,
  moving: boolean,
  viewport: Readonly<{ width: number; height: number }>,
  seatId?: unknown,
): MovementSample | null {
  const viewportWidth = Math.round(viewport.width);
  const viewportHeight = Math.round(viewport.height);
  if (
    !Number.isFinite(point.x)
    || !Number.isFinite(point.y)
    || !validMovementViewportDimension(viewportWidth)
    || !validMovementViewportDimension(viewportHeight)
    || typeof moving !== 'boolean'
    || (seatId !== undefined && !isWaitingRoomSeatId(seatId))
    || (moving && seatId !== undefined)
  ) return null;
  return {
    x: Number(Math.min(1, Math.max(0, point.x / viewportWidth)).toFixed(4)),
    y: Number(Math.min(1, Math.max(0, point.y / viewportHeight)).toFixed(4)),
    moving,
    viewportWidth,
    viewportHeight,
    ...(seatId !== undefined ? { seatId } : {}),
  };
}

export interface RemoteMovement extends MovementPosition, Partial<MovementViewport>, Partial<MovementStage> {
  playerId: string;
  sequence: number;
  connectionGeneration: number;
}

interface MovementState extends MovementPosition, Partial<MovementViewport>, Partial<MovementStage> {
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
  /**
   * 스크롤·resize 뒤 논리 좌석·공유 무대의 현재 client 좌표로 다시 맞춘다. 이동이 아니라 배치가 바뀐 것이라
   * 전환 없이 옮긴다(`walker--relayout`, U31).
   */
  refresh(): void;
  /** 인증된 server event를 적용한다. invalid/stale이면 false다. 앞 자리에서 전환으로 잇는다. */
  update(movement: RemoteMovement): boolean;
  /** heartbeat lease가 끝난 좌석만 지우고 좌표·sequence는 보존한다. */
  clearSeat(playerId: string): void;
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
  return String(Number(value.toFixed(4)));
}

function centeredAxis(center: '50vw' | '50vh', limit: '100vw' | '100vh', offset: number): string {
  if (Math.abs(offset) < 0.00005) return `clamp(0px, ${center}, ${limit})`;
  const operator = offset < 0 ? '-' : '+';
  return `clamp(0px, calc(${center} ${operator} ${cssNumber(Math.abs(offset))}px), ${limit})`;
}

function projectedUnitPosition(
  node: HTMLElement,
  state: MovementState,
  offset: Readonly<{ x: number; y: number }> | null,
  stagePoint: Readonly<{ x: number; y: number }> | null = null,
): Readonly<{ x: number; y: number }> {
  const view = node.ownerDocument?.defaultView;
  if (
    (!offset && !stagePoint)
    || !view
    || !Number.isFinite(view.innerWidth)
    || !Number.isFinite(view.innerHeight)
    || view.innerWidth <= 0
    || view.innerHeight <= 0
  ) return state;
  if (stagePoint) {
    return {
      x: Math.min(1, Math.max(0, stagePoint.x / view.innerWidth)),
      y: Math.min(1, Math.max(0, stagePoint.y / view.innerHeight)),
    };
  }
  // 위에서 offset과 stagePoint가 함께 없으면 돌아갔다
  const centered = offset as Readonly<{ x: number; y: number }>;
  return {
    x: Math.min(1, Math.max(0, (view.innerWidth / 2 + centered.x) / view.innerWidth)),
    y: Math.min(1, Math.max(0, (view.innerHeight / 2 + centered.y) / view.innerHeight)),
  };
}

interface PlayerMovementControllerOptions {
  /** 논리 좌석을 이 client DOM의 정확한 발끝 좌표로 바꾼다. */
  seatPoint?: (
    seatId: WaitingRoomSeatId,
    node: HTMLElement,
  ) => Readonly<{ x: number; y: number }> | null;
  /**
   * 이 화면이 지금 보이는 공유 무대의 자리 (U31). 그 무대를 보이지 않거나 잴 수 없으면 null —
   * 그러면 무대 좌표가 와도 예전처럼 화면 중심의 px로 그린다.
   */
  stageFrame?: (stage: MovementStageId) => MovementStageFrame | null;
}

/** 한 번 그리는 동안 같은 무대를 여러 캐릭터가 다시 재지 않게 한다 (쓰기 사이의 레이아웃 읽기를 줄인다) */
type StageFrameResolver = (stage: MovementStageId) => MovementStageFrame | null;

function stageFrameResolver(
  stageFrame: PlayerMovementControllerOptions['stageFrame'],
): StageFrameResolver {
  const measured = new Map<MovementStageId, MovementStageFrame | null>();
  return (stage) => {
    if (!stageFrame) return null;
    if (!measured.has(stage)) measured.set(stage, stageFrame(stage));
    return measured.get(stage) ?? null;
  };
}

function remoteStagePoint(
  state: MovementState,
  frameFor: StageFrameResolver,
): Readonly<{ x: number; y: number }> | null {
  if (
    state.stage === undefined
    || state.stageX === undefined
    || state.stageY === undefined
  ) return null;
  return movementStagePoint(frameFor(state.stage), { x: state.stageX, y: state.stageY });
}

function validSeatPoint(
  point: Readonly<{ x: number; y: number }> | null | undefined,
): point is Readonly<{ x: number; y: number }> {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function clampSeatPoint(
  node: HTMLElement,
  point: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> {
  const view = node.ownerDocument?.defaultView;
  if (!view || view.innerWidth <= 0 || view.innerHeight <= 0) return point;
  return {
    x: Math.min(view.innerWidth, Math.max(0, point.x)),
    y: Math.min(view.innerHeight, Math.max(0, point.y)),
  };
}

/** 이동이 아니라 배치가 바뀌어 다시 세운 자리. CSS가 이 동안 전환을 끈다 (`.walker--remote.walker--relayout`) */
const RELAYOUT_CLASS = 'walker--relayout';

/**
 * 왜 다시 세우는가. `movement`는 새 이동이나 좌석 lease 만료라 전환이 앞 자리에서 잇는다. `relayout`은 이 화면의
 * 배치(스크롤·크기·다시 그린 DOM)가 바뀐 것이라 전환 없이 옮긴다.
 */
type ProjectionCause = 'movement' | 'relayout';

/**
 * 캐릭터마다 마지막으로 쓴 transform. 배치가 바뀌어도 쓸 값이 같으면(화면 중심의 px 자리는 스크롤해도 같다)
 * 전환을 끄지 않는다 — 걷는 frame 사이를 잇던 전환이 중간에 끊겨 튀지 않게 한다. `style.transform`을 다시 읽어
 * 견주지 않는 것은 브라우저가 `calc`·`clamp`를 다르게 적어 돌려주기 때문이다.
 */
const writtenTransforms = new WeakMap<HTMLElement, string>();

function project(
  node: HTMLElement,
  state: MovementState,
  seatPoint: PlayerMovementControllerOptions['seatPoint'],
  frameFor: StageFrameResolver,
  cause: ProjectionCause,
): void {
  // 새로 bind된 remote walker는 hidden 상태다. 먼저 표시해야 offsetHeight를 쓰는
  // 좌석 좌표 계산이 0이 아닌 실제 캐릭터 높이를 읽는다. 같은 task 안에서
  // transform까지 설정되므로 기본 위치가 중간 frame에 노출되지는 않는다.
  node.hidden = false;
  const rawSeatAnchor = state.seatId ? seatPoint?.(state.seatId, node) : null;
  const seatAnchor = validSeatPoint(rawSeatAnchor)
    ? clampSeatPoint(node, rawSeatAnchor)
    : null;
  // 좌석 다음은 공유 무대다 (U31). 무대는 문서와 함께 스크롤되므로 화면 밖으로 밀려난 무대의
  // 자리는 화면 밖에 둔다 — 가장자리로 당기면 질문이나 다른 칸 위에 선 것처럼 보인다
  const stagePoint = seatAnchor ? null : remoteStagePoint(state, frameFor);
  const offset = remoteMovementOffset(state);
  const projected = projectedUnitPosition(node, state, offset, stagePoint);
  const transform = validSeatPoint(seatAnchor)
    ? `translate(${cssNumber(seatAnchor.x)}px, ${cssNumber(seatAnchor.y)}px) translate(-50%, -100%)`
    : stagePoint
      ? `translate(${cssNumber(stagePoint.x)}px, ${cssNumber(stagePoint.y)}px) translate(-50%, -100%)`
      : offset
        ? `translate(${centeredAxis('50vw', '100vw', offset.x)}, ${centeredAxis('50vh', '100vh', offset.y)}) translate(-50%, -100%)`
        : `translate(${state.x * 100}vw, ${state.y * 100}vh) translate(-50%, -100%)`;
  if (cause === 'movement') {
    // 같은 task 안에서 떼고 쓰므로 새 자리로 가는 전환은 그대로 돈다(전환은 바뀐 뒤의 스타일을 따른다)
    node.classList.toggle(RELAYOUT_CLASS, false);
    node.style.transform = transform;
    writtenTransforms.set(node, transform);
  } else if (writtenTransforms.get(node) !== transform) {
    node.classList.toggle(RELAYOUT_CLASS, true);
    node.style.transform = transform;
    writtenTransforms.set(node, transform);
  }
  const seated = state.seatId !== undefined && seatAnchor !== null;
  node.classList.toggle('walker--seated', seated);
  node.classList.toggle('walker--walking', state.moving && !seated);
  node.classList.toggle('walker--idle', !state.moving && !seated);
  node.classList.toggle('walker--name-above', projected.y >= NAME_ABOVE_THRESHOLD);
  node.classList.toggle('walker--name-left', projected.x <= NAME_SIDE_THRESHOLD);
  node.classList.toggle('walker--name-right', projected.x >= 1 - NAME_SIDE_THRESHOLD);
}

export function createPlayerMovementController(
  { seatPoint, stageFrame }: PlayerMovementControllerOptions = {},
): PlayerMovementController {
  let allowed = new Set<string>();
  const states = new Map<string, MovementState>();
  const nodes = new Map<string, HTMLElement>();

  function hideNodes(): void {
    for (const node of nodes.values()) node.hidden = true;
  }

  return {
    reconcile(playerIds) {
      allowed = new Set(playerIds);
      const frameFor = stageFrameResolver(stageFrame);
      for (const [playerId, state] of states) {
        if (!allowed.has(playerId)) states.delete(playerId);
        else {
          const node = nodes.get(playerId);
          if (node) project(node, state, seatPoint, frameFor, 'relayout');
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
      if (state) project(node, state, seatPoint, stageFrameResolver(stageFrame), 'relayout');
      else node.hidden = true;
    },

    unbindAll() {
      hideNodes();
      nodes.clear();
    },

    refresh() {
      const frameFor = stageFrameResolver(stageFrame);
      for (const [playerId, node] of nodes) {
        const state = states.get(playerId);
        if (state && allowed.has(playerId)) project(node, state, seatPoint, frameFor, 'relayout');
      }
    },

    update(movement) {
      const hasViewportWidth = movement.viewportWidth !== undefined;
      const hasViewportHeight = movement.viewportHeight !== undefined;
      const hasSeat = movement.seatId !== undefined;
      // 무대 좌표는 셋이 함께 맞아야 믿는다. 어긋나면 이동 전체를 버리지 않고 무대만 버린다 —
      // 화면 중심의 px(예전 길)로는 여전히 그릴 수 있다
      const hasStage = isMovementStageId(movement.stage)
        && validMovementStageUnit(movement.stageX)
        && validMovementStageUnit(movement.stageY);
      if (
        !movement.playerId
        || !validUnit(movement.x)
        || !validUnit(movement.y)
        || typeof movement.moving !== 'boolean'
        || (hasSeat && (!isWaitingRoomSeatId(movement.seatId) || movement.moving))
        || hasViewportWidth !== hasViewportHeight
        || (hasViewportWidth && (
          !validMovementViewportDimension(movement.viewportWidth)
          || !validMovementViewportDimension(movement.viewportHeight)
        ))
        || !Number.isSafeInteger(movement.sequence)
        || movement.sequence <= 0
        || !Number.isSafeInteger(movement.connectionGeneration)
        || movement.connectionGeneration < 0
      ) return false;

      const previous = states.get(movement.playerId);
      if (previous) {
        if (movement.connectionGeneration < previous.connectionGeneration) return false;
        if (
          movement.connectionGeneration === previous.connectionGeneration
          && movement.sequence <= previous.sequence
        ) return false;
      }

      const state: MovementState = {
        x: movement.x,
        y: movement.y,
        moving: movement.moving,
        ...(hasViewportWidth ? {
          viewportWidth: movement.viewportWidth,
          viewportHeight: movement.viewportHeight,
        } : {}),
        ...(hasSeat ? { seatId: movement.seatId } : {}),
        ...(hasStage ? {
          stage: movement.stage,
          stageX: movement.stageX,
          stageY: movement.stageY,
        } : {}),
        sequence: movement.sequence,
        connectionGeneration: movement.connectionGeneration,
      };
      states.set(movement.playerId, state);
      if (!allowed.has(movement.playerId)) return true;
      const node = nodes.get(movement.playerId);
      if (node) project(node, state, seatPoint, stageFrameResolver(stageFrame), 'movement');
      return true;
    },

    clearSeat(playerId) {
      const current = states.get(playerId);
      if (!current?.seatId) return;
      const standing: MovementState = { ...current };
      delete standing.seatId;
      states.set(playerId, standing);
      if (!allowed.has(playerId)) return;
      const node = nodes.get(playerId);
      if (node) project(node, standing, seatPoint, stageFrameResolver(stageFrame), 'movement');
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
  /** 마지막 착석 frame을 같은 좌표의 standing frame으로 즉시 바꿔 보낸다. */
  clearSeat(): void;
  /** reconnect·room snapshot·heartbeat에서 마지막 좌표를 즉시 다시 보낸다. */
  resend(): void;
  /**
   * 캐릭터는 그대로인데 무대가 움직였다(스크롤·배치 변화, U31). 다시 잰 무대 좌표가 마지막으로 보낸
   * 것과 다를 때만, 걷는 frame과 같은 간격(`intervalMs`)으로 묶어 보낸다 — 스크롤 이벤트마다 보내면
   * 서버의 소켓 수신 한도(초당 30)를 넘겨 소켓이 닫힌다. 이렇게 보내는 것에는 `onlyIfChanged`를 달아,
   * 무대 좌표를 싣지 않는 소켓(#106의 API)이면 저장소가 같은 줄을 다시 보내지 않게 한다.
   */
  refresh(): void;
  reset(): void;
}

/** 보내는 까닭. `onlyIfChanged`면 무대가 움직였을 뿐이라, 소켓에 실을 줄이 지난번과 같으면 보내지 않아도 된다 */
export interface MovementSendOptions {
  onlyIfChanged?: true;
}

interface MovementPublisherDeps {
  send: (sample: MovementSample, options?: MovementSendOptions) => void;
  /**
   * 보내기 직전에 표본의 무대 좌표를 지금 배치로 다시 맞춘다 (U31, `withMovementStage`). 없으면 표본을
   * 그대로 보낸다.
   */
  restage?: (sample: MovementSample) => MovementSample;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
}

function sameMovementSample(left: MovementSample, right: MovementSample): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.moving === right.moving
    && left.viewportWidth === right.viewportWidth
    && left.viewportHeight === right.viewportHeight
    && left.seatId === right.seatId
    && left.stage === right.stage
    && left.stageX === right.stageX
    && left.stageY === right.stageY;
}

export function createMovementPublisher({
  send,
  restage,
  intervalMs = 125,
  now = () => performance.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (timer) => window.clearTimeout(timer),
}: MovementPublisherDeps): MovementPublisher {
  let latest: MovementSample | null = null;
  /** 마지막으로 보낸 것(무대를 다시 잰 뒤). `refresh`는 바뀐 것이 없으면 보내지 않는다 */
  let lastSent: MovementSample | null = null;
  let lastSentAt: number | null = null;
  let timer: number | null = null;
  /** 잡아 둔 차례가 무대가 움직인 것뿐인가(`refresh`). 그사이 캐릭터가 움직이면(`update`) 거둔다 */
  let refreshOnly = false;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function outgoing(sample: MovementSample): MovementSample {
    return restage ? restage(sample) : sample;
  }

  function sendLatest(): void {
    const onlyIfChanged = refreshOnly;
    refreshOnly = false;
    cancelTimer();
    if (!latest) return;
    const sample = outgoing(latest);
    if (onlyIfChanged) send(sample, { onlyIfChanged: true });
    else send(sample);
    lastSent = sample;
    lastSentAt = now();
  }

  function schedule(delay: number): void {
    if (timer !== null) return;
    timer = setTimer(sendLatest, Math.max(0, delay));
  }

  return {
    update(sample) {
      refreshOnly = false;
      latest = { ...sample };
      if (!sample.moving || lastSentAt === null) {
        sendLatest();
        return;
      }
      const elapsed = now() - lastSentAt;
      if (elapsed >= intervalMs) sendLatest();
      else schedule(intervalMs - elapsed);
    },

    clearSeat() {
      if (!latest?.seatId) return;
      const standing = { ...latest };
      delete standing.seatId;
      latest = standing;
      refreshOnly = false;
      sendLatest();
    },

    resend() {
      refreshOnly = false;
      sendLatest();
    },

    refresh() {
      // 이미 보낼 차례가 잡혀 있으면 그때 다시 잰다
      if (!latest || !restage || timer !== null) return;
      if (lastSent && sameMovementSample(outgoing(latest), lastSent)) return;
      refreshOnly = true;
      const elapsed = lastSentAt === null ? intervalMs : now() - lastSentAt;
      if (elapsed >= intervalMs) sendLatest();
      else schedule(intervalMs - elapsed);
    },

    reset() {
      cancelTimer();
      refreshOnly = false;
      latest = null;
      lastSent = null;
      lastSentAt = null;
    },
  };
}
