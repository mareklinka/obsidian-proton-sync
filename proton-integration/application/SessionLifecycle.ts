import type { ProtonSession } from "../../session-store";

const DEFAULT_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

export class SessionLifecycle {
  constructor(
    private readonly clock: { now(): number },
    private readonly refreshThresholdMs = DEFAULT_REFRESH_THRESHOLD_MS,
  ) {}

  shouldRefresh(session: ProtonSession, force: boolean): boolean {
    if (force) {
      return true;
    }

    const expiresAt = new Date(session.expiresAt).getTime();
    const timeToExpiry = expiresAt - this.clock.now();

    return timeToExpiry <= this.refreshThresholdMs;
  }

  timeToExpiryMs(session: ProtonSession): number {
    return new Date(session.expiresAt).getTime() - this.clock.now();
  }
}
