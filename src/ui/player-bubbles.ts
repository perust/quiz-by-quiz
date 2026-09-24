export interface PlayerBubbleTarget {
  /** HTMLElement.hidden also permits the modern `until-found` string state. */
  hidden: boolean | string;
  textContent: string | null;
}

export interface PlayerBubbleController {
  /** Attach the currently rendered figure for a player and restore any live bubble. */
  bind(playerId: string, target: PlayerBubbleTarget): void;
  /** Detach rendered figures without discarding still-live messages. */
  unbindAll(): void;
  /** Replace this player's bubble and give the newest message full lifetime ownership. */
  show(playerId: string, text: string): void;
  /** End the current room lifecycle, clearing messages, targets, and timers. */
  reset(): void;
}

export interface PlayerBubbleControllerDeps {
  durationMs: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** Put a bubble below only when it does not fit above and the lower side has more room. */
export function shouldPlacePlayerBubbleBelow(
  bubbleHeight: number,
  characterTop: number,
  characterBottom: number,
  viewportHeight: number,
  inset = 6,
): boolean {
  const roomAbove = Math.max(0, characterTop - inset);
  const roomBelow = Math.max(0, viewportHeight - characterBottom - inset);
  return bubbleHeight > roomAbove && roomBelow > roomAbove;
}

interface ActiveBubble {
  text: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

function hide(target: PlayerBubbleTarget): void {
  target.hidden = true;
  target.textContent = '';
}

/**
 * Keeps transient chat bubbles alive across room snapshot rerenders.
 *
 * Room snapshots rebuild the player figures, while chat events arrive independently over the
 * socket. Binding the message to player ID instead of a particular DOM node means an intervening
 * snapshot cannot erase a bubble early. Every timeout also owns one exact ActiveBubble object, so
 * an older message can never hide a newer one from the same player.
 */
export function createPlayerBubbleController({
  durationMs,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: PlayerBubbleControllerDeps): PlayerBubbleController {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('말풍선 표시 시간은 양수여야 합니다.');
  }

  const active = new Map<string, ActiveBubble>();
  const targets = new Map<string, PlayerBubbleTarget>();

  function clearActive(playerId: string, expected?: ActiveBubble): void {
    const current = active.get(playerId);
    if (!current || (expected && current !== expected)) return;
    active.delete(playerId);
    if (current.timer !== undefined) clearTimer(current.timer);
    const target = targets.get(playerId);
    if (target) hide(target);
  }

  function project(playerId: string, target: PlayerBubbleTarget): void {
    const bubble = active.get(playerId);
    if (!bubble) {
      hide(target);
      return;
    }
    if (bubble.expiresAt <= now()) {
      clearActive(playerId, bubble);
      hide(target);
      return;
    }
    target.textContent = bubble.text;
    target.hidden = false;
  }

  return {
    bind(playerId, target) {
      const previous = targets.get(playerId);
      if (previous && previous !== target) hide(previous);
      targets.set(playerId, target);
      project(playerId, target);
    },

    unbindAll() {
      for (const target of targets.values()) hide(target);
      targets.clear();
    },

    show(playerId, text) {
      clearActive(playerId);
      const bubble: ActiveBubble = {
        text,
        expiresAt: now() + durationMs,
      };
      active.set(playerId, bubble);
      bubble.timer = setTimer(() => clearActive(playerId, bubble), durationMs);
      const target = targets.get(playerId);
      if (target) project(playerId, target);
    },

    reset() {
      for (const [playerId] of active) clearActive(playerId);
      for (const target of targets.values()) hide(target);
      targets.clear();
    },
  };
}
