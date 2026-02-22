import { toCanonicalPathKey } from './path-utils';

const DEFAULT_LOCAL_SUPPRESSION_TTL_MS = 5000;

export type LocalChangeSuppressionServiceOptions = {
  localSuppressionTtlMs?: number;
  now?: () => number;
};

export class LocalChangeSuppressionService {
  private readonly suppressedLocalPathsUntil = new Map<string, number>();
  private readonly localSuppressionTtlMs: number;
  private readonly now: () => number;
  private applyingRemoteChanges = false;

  constructor(options: LocalChangeSuppressionServiceOptions = {}) {
    this.localSuppressionTtlMs = options.localSuppressionTtlMs ?? DEFAULT_LOCAL_SUPPRESSION_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  beginRemoteApply(): void {
    this.applyingRemoteChanges = true;
  }

  endRemoteApply(): void {
    this.applyingRemoteChanges = false;
  }

  shouldSuppress(path: string, oldPath?: string): boolean {
    if (this.applyingRemoteChanges) {
      return true;
    }

    this.pruneExpiredSuppressions();

    const canonicalPath = toCanonicalPathKey(path);
    if (this.suppressedLocalPathsUntil.has(canonicalPath)) {
      return true;
    }

    if (oldPath) {
      const canonicalOldPath = toCanonicalPathKey(oldPath);
      if (this.suppressedLocalPathsUntil.has(canonicalOldPath)) {
        return true;
      }
    }

    return false;
  }

  markSuppressedPaths(paths: string[]): void {
    if (paths.length === 0) {
      return;
    }

    const until = this.now() + this.localSuppressionTtlMs;
    for (const path of paths) {
      this.suppressedLocalPathsUntil.set(path, until);
    }
  }

  reset(): void {
    this.suppressedLocalPathsUntil.clear();
    this.applyingRemoteChanges = false;
  }

  private pruneExpiredSuppressions(): void {
    const now = this.now();
    for (const [path, until] of this.suppressedLocalPathsUntil.entries()) {
      if (until <= now) {
        this.suppressedLocalPathsUntil.delete(path);
      }
    }
  }
}
