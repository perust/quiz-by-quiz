export interface OnlineScreenActionOwnership {
  screenRequest: number;
  actionRequest: number;
}

export function isCurrentOnlineScreenAction(
  owner: OnlineScreenActionOwnership,
  current: { screenRequest: number | null; actionRequest: number },
): boolean {
  return current.screenRequest !== null
    && owner.screenRequest === current.screenRequest
    && owner.actionRequest === current.actionRequest;
}
