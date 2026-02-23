import { toCanonicalPathKey } from './path-utils';

const DEFAULT_LOCAL_SUPPRESSION_TTL_MS = 5000;

export type LocalChangeSuppressionServiceOptions = {
  localSuppressionTtlMs?: number;
  now?: () => number;
};

export type LocalSuppressionLock = {
  id: number;
  release: () => void;
};

export type LocalSuppressionLockOptions = {
  subtree?: boolean;
  aliasPaths?: string[];
};

type LockEntry = {
  id: number;
  canonicalPath: string;
  subtree: boolean;
  aliases: Set<string>;
};

export class LocalChangeSuppressionService {
  private readonly suppressedLocalPathsUntil = new Map<string, number>();
  private readonly localSuppressionTtlMs: number;
  private readonly now: () => number;
  private readonly locks = new Map<number, LockEntry>();
  private nextLockId = 0;

  constructor(options: LocalChangeSuppressionServiceOptions = {}) {
    this.localSuppressionTtlMs = options.localSuppressionTtlMs ?? DEFAULT_LOCAL_SUPPRESSION_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  acquirePathLock(path: string, options: LocalSuppressionLockOptions = {}): LocalSuppressionLock {
    const canonicalPath = toCanonicalPathKey(path);
    const id = this.nextLockId + 1;
    this.nextLockId = id;

    const aliases = new Set<string>();
    for (const aliasPath of options.aliasPaths ?? []) {
      aliases.add(toCanonicalPathKey(aliasPath));
    }

    this.locks.set(id, {
      id,
      canonicalPath,
      subtree: options.subtree ?? false,
      aliases
    });

    return {
      id,
      release: () => {
        this.releaseLock(id);
      }
    };
  }

  releaseLock(id: number): void {
    this.locks.delete(id);
  }

  shouldSuppress(path: string, oldPath?: string): boolean {
    if (this.matchesActiveLock(path, oldPath)) {
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

  getActiveLockCount(): number {
    return this.locks.size;
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
    this.locks.clear();
  }

  private matchesActiveLock(path: string, oldPath?: string): boolean {
    const canonicalPath = toCanonicalPathKey(path);
    const canonicalOldPath = oldPath ? toCanonicalPathKey(oldPath) : null;

    for (const lock of this.locks.values()) {
      if (this.matchesLock(lock, canonicalPath)) {
        return true;
      }

      if (canonicalOldPath && this.matchesLock(lock, canonicalOldPath)) {
        return true;
      }
    }

    return false;
  }

  private matchesLock(lock: LockEntry, candidatePath: string): boolean {
    if (!candidatePath) {
      return false;
    }

    if (candidatePath === lock.canonicalPath || lock.aliases.has(candidatePath)) {
      return true;
    }

    if (lock.subtree) {
      const prefix = `${lock.canonicalPath}/`;
      if (candidatePath.startsWith(prefix)) {
        return true;
      }

      for (const alias of lock.aliases) {
        if (candidatePath.startsWith(`${alias}/`)) {
          return true;
        }
      }
    }

    return false;
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
