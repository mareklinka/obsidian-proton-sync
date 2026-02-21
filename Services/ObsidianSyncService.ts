import {
  BehaviorSubject,
  Observable,
  Subject,
  Subscription,
  SchedulerLike,
  asyncScheduler,
  concatMap,
  from,
  observeOn,
  timer,
  distinctUntilChanged
} from 'rxjs';
import { getBaseName, getParentPath, normalizePath, toCanonicalPathKey } from './path-utils';
import { EntityType, FileDescriptor, FileSystemChangeType, FolderDescriptor } from './ObsidianVaultFileSystemReader';

export interface SyncChangeBase {
  type: FileSystemChangeType;
  entityType: EntityType;
  path: string;
  oldPath?: string;
  occurredAt?: number;
  correlationId?: string;
}

export interface QueuedChange extends SyncChangeBase {
  id: string;
  enqueuedAt: number;
  availableAt: number;
  attempt: number;
}

export interface SyncIndexEntry {
  cloudId: string;
  path: string;
  entityType: EntityType;
  updatedAt: number;
}

export interface SyncIndexSnapshot {
  byPath: Record<string, SyncIndexEntry>;
  byCloudId: Record<string, SyncIndexEntry>;
}

export interface SyncIndexSnapshotEvent {
  seq: number;
  at: number;
  reason: FileSystemChangeType | 'init' | 'manual';
  snapshot: SyncIndexSnapshot;
}

export interface IFileSystemReader {
  readFile(path: string): Promise<FileDescriptor | null>;
  readFolder(path: string): Promise<FolderDescriptor | null>;
  exists(path: string, entityType: EntityType): Promise<boolean>;
}

export interface CloudUpsertResult {
  cloudId: string;
  path: string;
  entityType: EntityType;
}

export interface ICloudStorageApi {
  createFile(input: FileDescriptor, parentPath?: string): Promise<CloudUpsertResult>;
  updateFile(cloudId: string, input: FileDescriptor): Promise<CloudUpsertResult>;
  deleteFile(cloudId: string): Promise<void>;
  moveFile(cloudId: string, newPath: string, oldPath?: string): Promise<CloudUpsertResult>;

  createFolder(input: FolderDescriptor, parentPath?: string): Promise<CloudUpsertResult>;
  renameFolder(cloudId: string, newName: string, newPath: string): Promise<CloudUpsertResult>;
  deleteFolder(cloudId: string): Promise<void>;
  moveFolder(cloudId: string, newPath: string, oldPath?: string): Promise<CloudUpsertResult>;
}

export interface SyncQueueStats {
  totalPending: number;
  queueCount: number;
  inFlight: boolean;
  droppedByCompaction: number;
  retried: number;
  failedTerminal: number;
}

export interface SyncDispatchResult {
  changeId: string;
  success: boolean;
  retryScheduled: boolean;
  errorMessage?: string;
  retryable?: boolean;
}

export type SyncEngineState = 'idle' | 'syncing' | 'retrying' | 'error';

export interface SyncServiceOptions {
  debounceMs?: number;
  sendIntervalMs?: number;
  maxOpsPerTick?: number;
  upToDateToleranceMs?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  jitterRatio?: number;
  maxPendingTotal?: number;
  maxPendingPerEntity?: number;
  now?: () => number;
  classifyError?: (error: unknown) => 'retryable' | 'non-retryable';
}

export interface ISyncService {
  initializeIndex(snapshot: SyncIndexSnapshot): void;
  start(): void;
  stop(): void;
  dispose(): void;

  enqueueChange(change: SyncChangeBase): string;
  clearPending(entityKey?: string): void;

  readonly mapChanges$: Observable<SyncIndexSnapshotEvent>;
  readonly dispatchResults$: Observable<SyncDispatchResult>;
  readonly syncState$: Observable<SyncEngineState>;
}

type LifecycleState = 'idle' | 'initialized' | 'running' | 'stopped' | 'disposed';

type QueueRecord = {
  entityKey: string;
  items: QueuedChange[];
};

type EngineCommandReason = 'start' | 'enqueue' | 'dispatch-complete' | 'retry-due' | 'clear-pending';

type EngineCommand = {
  type: 'evaluate';
  reason: EngineCommandReason;
};

export const DEFAULT_DEBOUNCE_MS = 10000;
export const DEFAULT_SEND_INTERVAL_MS = 500;
export const DEFAULT_MAX_OPS_PER_TICK = 1;
export const DEFAULT_UP_TO_DATE_TOLERANCE_MS = 3000;
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
export const DEFAULT_JITTER_RATIO = 0.2;
export const DEFAULT_MAX_PENDING_TOTAL = 5000;
export const DEFAULT_MAX_PENDING_PER_ENTITY = 500;

export class ObsidianSyncService implements ISyncService {
  public readonly mapChanges$: Observable<SyncIndexSnapshotEvent>;
  public readonly dispatchResults$: Observable<SyncDispatchResult>;
  public readonly syncState$: Observable<SyncEngineState>;

  private readonly mapChangesSubject = new Subject<SyncIndexSnapshotEvent>();
  private readonly dispatchResultsSubject = new Subject<SyncDispatchResult>();
  private readonly syncStateSubject = new BehaviorSubject<SyncEngineState>('idle');

  private readonly byPath = new Map<string, SyncIndexEntry>();
  private readonly byCloudId = new Map<string, SyncIndexEntry>();
  private readonly queueMap = new Map<string, QueueRecord>();
  private readonly scheduler: SchedulerLike;
  private readonly engineCommands = new Subject<EngineCommand>();
  private readonly engineSub: Subscription;

  private state: LifecycleState = 'idle';
  private isInitialized = false;
  private isInFlight = false;
  private wakeSub: Subscription | null = null;
  private wakeAt: number | null = null;
  private nextDispatchAt = 0;

  private seq = 0;
  private droppedByCompaction = 0;
  private retried = 0;
  private failedTerminal = 0;
  private idCounter = 0;

  private readonly debounceMs: number;
  private readonly sendIntervalMs: number;
  private readonly maxOpsPerTick: number;
  private readonly upToDateToleranceMs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly jitterRatio: number;
  private readonly maxPendingTotal: number;
  private readonly maxPendingPerEntity: number;
  private readonly now: () => number;
  private readonly classifyError: (error: unknown) => 'retryable' | 'non-retryable';

  constructor(
    private readonly fsReader: IFileSystemReader,
    private readonly cloudApi: ICloudStorageApi,
    options: SyncServiceOptions = {},
    scheduler?: SchedulerLike
  ) {
    this.scheduler = scheduler ?? asyncScheduler;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.sendIntervalMs = options.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS;
    this.maxOpsPerTick = options.maxOpsPerTick ?? DEFAULT_MAX_OPS_PER_TICK;
    this.upToDateToleranceMs = options.upToDateToleranceMs ?? DEFAULT_UP_TO_DATE_TOLERANCE_MS;
    this.retryMaxAttempts = options.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.maxPendingTotal = options.maxPendingTotal ?? DEFAULT_MAX_PENDING_TOTAL;
    this.maxPendingPerEntity = options.maxPendingPerEntity ?? DEFAULT_MAX_PENDING_PER_ENTITY;
    this.now = options.now ?? (() => Date.now());
    this.classifyError = options.classifyError ?? defaultClassifyError;

    this.engineSub = this.engineCommands
      .pipe(
        observeOn(this.scheduler),
        concatMap(command => from(this.handleEngineCommand(command)))
      )
      .subscribe();

    this.mapChanges$ = this.mapChangesSubject.asObservable();
    this.dispatchResults$ = this.dispatchResultsSubject.asObservable();
    this.syncState$ = this.syncStateSubject.pipe(distinctUntilChanged());
  }

  initializeIndex(snapshot: SyncIndexSnapshot): void {
    if (this.state === 'running') {
      throw new Error('Cannot initialize index while service is running.');
    }
    if (this.state === 'disposed') {
      throw new Error('Service is disposed.');
    }

    this.byPath.clear();
    this.byCloudId.clear();

    for (const entry of Object.values(snapshot.byPath ?? {})) {
      const normalized = normalizePath(entry.path);
      const canonical = toCanonicalPathKey(normalized);
      const normalizedEntry: SyncIndexEntry = {
        cloudId: entry.cloudId,
        path: normalized,
        entityType: entry.entityType,
        updatedAt: entry.updatedAt
      };
      this.byPath.set(canonical, normalizedEntry);
      this.byCloudId.set(entry.cloudId, normalizedEntry);
    }

    for (const entry of Object.values(snapshot.byCloudId ?? {})) {
      if (!this.byCloudId.has(entry.cloudId)) {
        const normalized = normalizePath(entry.path);
        const canonical = toCanonicalPathKey(normalized);
        const normalizedEntry: SyncIndexEntry = {
          cloudId: entry.cloudId,
          path: normalized,
          entityType: entry.entityType,
          updatedAt: entry.updatedAt
        };
        this.byPath.set(canonical, normalizedEntry);
        this.byCloudId.set(entry.cloudId, normalizedEntry);
      }
    }

    this.isInitialized = true;
    this.state = 'initialized';
    this.emitSnapshot('init');
  }

  start(): void {
    if (this.state === 'disposed') {
      throw new Error('Service is disposed.');
    }
    if (!this.isInitialized) {
      throw new Error('Index must be initialized before start().');
    }
    if (this.state === 'running') {
      return;
    }

    this.state = 'running';
    this.setSyncState('idle');
    this.nextDispatchAt = this.now() + this.sendIntervalMs;
    this.requestEngineEvaluation('start');
  }

  stop(): void {
    if (this.state === 'disposed') {
      return;
    }

    this.cancelWake();

    if (this.state !== 'idle') {
      this.state = 'stopped';
    }

    this.setSyncState('idle');
  }

  dispose(): void {
    if (this.state === 'disposed') {
      return;
    }

    this.stop();
    this.queueMap.clear();
    this.byPath.clear();
    this.byCloudId.clear();

    this.state = 'disposed';
    this.cancelWake();
    this.engineSub.unsubscribe();
    this.engineCommands.complete();

    this.mapChangesSubject.complete();
    this.dispatchResultsSubject.complete();
    this.syncStateSubject.complete();
  }

  enqueueChange(change: SyncChangeBase): string {
    if (this.state === 'disposed') {
      throw new Error('Cannot enqueue into a disposed service.');
    }

    const now = this.now();
    const normalized = this.normalizeAndValidate(change);
    const hadPending = this.getTotalPending() > 0;
    const queued: QueuedChange = {
      ...normalized,
      id: this.nextChangeId(),
      enqueuedAt: now,
      availableAt: this.computeInitialAvailableAt(normalized.type, now),
      attempt: 0
    };

    const entityKey = this.resolveEntityKey(queued);
    const queue = this.getOrCreateQueue(entityKey);

    if (this.getTotalPending() >= this.maxPendingTotal) {
      this.dispatchResultsSubject.next({
        changeId: queued.id,
        success: false,
        retryScheduled: false,
        errorMessage: `Max pending total (${this.maxPendingTotal}) exceeded.`,
        retryable: false
      });
      return queued.id;
    }

    if (queue.items.length >= this.maxPendingPerEntity) {
      this.dispatchResultsSubject.next({
        changeId: queued.id,
        success: false,
        retryScheduled: false,
        errorMessage: `Max pending per entity (${this.maxPendingPerEntity}) exceeded.`,
        retryable: false
      });
      return queued.id;
    }

    this.insertWithCompaction(queue, queued);

    if (this.state === 'running' && !hadPending) {
      this.nextDispatchAt = this.now() + this.sendIntervalMs;
    }

    if (this.state === 'running') {
      this.requestEngineEvaluation('enqueue');
    }

    return queued.id;
  }

  clearPending(entityKey?: string): void {
    if (typeof entityKey === 'string' && entityKey.length > 0) {
      this.queueMap.delete(entityKey);
      if (this.state === 'running') {
        this.requestEngineEvaluation('clear-pending');
      }

      if (!this.hasPendingChanges()) {
        this.setSyncState('idle');
      }

      return;
    }

    this.queueMap.clear();
    this.setSyncState('idle');
    if (this.state === 'running') {
      this.requestEngineEvaluation('clear-pending');
    }
  }

  private requestEngineEvaluation(reason: EngineCommandReason): void {
    if (this.state !== 'running') {
      return;
    }

    this.engineCommands.next({
      type: 'evaluate',
      reason
    });
  }

  private async handleEngineCommand(command: EngineCommand): Promise<void> {
    if (this.state !== 'running' || this.isInFlight || command.type !== 'evaluate') {
      return;
    }

    if (!this.hasPendingChanges()) {
      this.setSyncState('idle');
      this.cancelWake();
      return;
    }

    const now = this.now();
    const earliestAvailableAt = this.findEarliestAvailableAt();
    if (earliestAvailableAt === null) {
      this.cancelWake();
      return;
    }

    const dueAt = Math.max(this.nextDispatchAt, earliestAvailableAt);
    if (dueAt > now) {
      this.scheduleWake(dueAt);
      return;
    }

    this.cancelWake();
    await this.processTurn();

    if (this.state !== 'running') {
      return;
    }

    if (this.hasPendingChanges()) {
      this.nextDispatchAt = this.now() + this.sendIntervalMs;
      this.requestEngineEvaluation('dispatch-complete');
      return;
    }

    this.cancelWake();
  }

  private async processTurn(): Promise<void> {
    if (this.state !== 'running' || this.isInFlight) {
      return;
    }

    this.setSyncState('syncing');
    this.isInFlight = true;

    try {
      for (let i = 0; i < this.maxOpsPerTick; i += 1) {
        const selected = this.selectNextQueue();
        if (!selected) {
          break;
        }

        const change = selected.items.shift();
        if (!change) {
          this.deleteQueueIfEmpty(selected.entityKey);
          continue;
        }

        const result = await this.dispatchChange(change);

        if (!result.success && result.retryScheduled) {
          selected.items.unshift(change);
        }

        this.deleteQueueIfEmpty(selected.entityKey);
      }
    } finally {
      this.isInFlight = false;

      if (!this.hasPendingChanges()) {
        this.setSyncState('idle');
      }
    }
  }

  private hasPendingChanges(): boolean {
    for (const queue of this.queueMap.values()) {
      if (queue.items.length > 0) {
        return true;
      }
    }
    return false;
  }

  private findEarliestAvailableAt(): number | null {
    let minAvailableAt: number | null = null;
    for (const queue of this.queueMap.values()) {
      if (queue.items.length === 0) {
        continue;
      }

      const head = queue.items[0];
      if (minAvailableAt === null || head.availableAt < minAvailableAt) {
        minAvailableAt = head.availableAt;
      }
    }

    return minAvailableAt;
  }

  private scheduleWake(at: number): void {
    if (this.state !== 'running') {
      return;
    }

    if (this.wakeAt !== null && this.wakeAt <= at) {
      return;
    }

    this.cancelWake();

    const delay = Math.max(0, at - this.now());
    this.wakeAt = at;
    this.wakeSub = timer(delay, this.scheduler).subscribe(() => {
      this.wakeAt = null;
      this.wakeSub = null;
      this.requestEngineEvaluation('retry-due');
    });
  }

  private cancelWake(): void {
    this.wakeSub?.unsubscribe();
    this.wakeSub = null;
    this.wakeAt = null;
  }

  private async dispatchChange(change: QueuedChange): Promise<SyncDispatchResult> {
    try {
      await this.executeChange(change);
      const success: SyncDispatchResult = {
        changeId: change.id,
        success: true,
        retryScheduled: false
      };
      this.dispatchResultsSubject.next(success);
      return success;
    } catch (error) {
      const classification = this.classifyError(error);
      const retryable = classification === 'retryable';

      if (retryable && change.attempt < this.retryMaxAttempts) {
        change.attempt += 1;
        change.availableAt = this.now() + this.computeBackoffMs(change.attempt);
        this.retried += 1;

        const retryResult: SyncDispatchResult = {
          changeId: change.id,
          success: false,
          retryScheduled: true,
          retryable: true,
          errorMessage: this.toErrorMessage(error)
        };
        this.setSyncState('retrying');
        this.dispatchResultsSubject.next(retryResult);
        return retryResult;
      }

      this.failedTerminal += 1;
      const failure: SyncDispatchResult = {
        changeId: change.id,
        success: false,
        retryScheduled: false,
        retryable,
        errorMessage: this.toErrorMessage(error)
      };
      this.setSyncState('error');
      this.dispatchResultsSubject.next(failure);
      return failure;
    }
  }

  private setSyncState(next: SyncEngineState): void {
    this.syncStateSubject.next(next);
  }

  private async executeChange(change: QueuedChange): Promise<void> {
    switch (change.type) {
      case 'file-created':
      case 'file-edited': {
        const descriptor = await this.fsReader.readFile(change.path);
        if (!descriptor) {
          throw new Error(`File not found: ${change.path}`);
        }

        const known = this.lookupByPath(change.path);
        if (known && descriptor.modifiedAt <= known.updatedAt + this.upToDateToleranceMs) {
          return;
        }

        const result = known
          ? await this.cloudApi.updateFile(known.cloudId, descriptor)
          : await this.cloudApi.createFile(descriptor, getParentPath(change.path));
        this.upsertIndex(result, change.type);
        return;
      }

      case 'file-deleted': {
        const cloudId = this.resolveCloudId(change.path, change.oldPath);
        if (cloudId) {
          await this.cloudApi.deleteFile(cloudId);
          this.removeIndexByCloudId(cloudId, change.type);
        }
        return;
      }

      case 'file-moved': {
        if (!change.oldPath) {
          throw new Error('file-moved requires oldPath');
        }
        const cloudId = this.resolveCloudId(change.oldPath, change.path);
        if (!cloudId) {
          throw new Error(`Unknown cloud ID for moved file: ${change.oldPath}`);
        }
        const result = await this.cloudApi.moveFile(cloudId, change.path, change.oldPath);
        this.upsertIndex(result, change.type, change.oldPath);
        return;
      }

      case 'folder-created': {
        const descriptor = await this.fsReader.readFolder(change.path);
        if (!descriptor) {
          throw new Error(`Folder not found: ${change.path}`);
        }

        const known = this.lookupByPath(change.path);
        if (known && known.cloudId) {
          return;
        }

        const result = await this.cloudApi.createFolder(descriptor, getParentPath(change.path));
        this.upsertIndex(result, change.type);
        return;
      }

      case 'folder-renamed': {
        if (!change.oldPath) {
          throw new Error('folder-renamed requires oldPath');
        }
        const cloudId = this.resolveCloudId(change.oldPath, change.path);
        if (!cloudId) {
          throw new Error(`Unknown cloud ID for renamed folder: ${change.oldPath}`);
        }
        const newName = getBaseName(change.path);
        const result = await this.cloudApi.renameFolder(cloudId, newName, change.path);
        this.upsertIndex(result, change.type, change.oldPath, false);
        this.rebaseDescendantPaths(change.oldPath, change.path);
        this.emitSnapshot(change.type);
        return;
      }

      case 'folder-deleted': {
        const cloudId = this.resolveCloudId(change.path, change.oldPath);
        if (cloudId) {
          await this.cloudApi.deleteFolder(cloudId);
          this.removeIndexByCloudId(cloudId, change.type);
        }
        return;
      }

      case 'folder-moved': {
        if (!change.oldPath) {
          throw new Error('folder-moved requires oldPath');
        }
        const cloudId = this.resolveCloudId(change.oldPath, change.path);
        if (!cloudId) {
          throw new Error(`Unknown cloud ID for moved folder: ${change.oldPath}`);
        }
        const result = await this.cloudApi.moveFolder(cloudId, change.path, change.oldPath);
        this.upsertIndex(result, change.type, change.oldPath, false);
        this.rebaseDescendantPaths(change.oldPath, change.path);
        this.emitSnapshot(change.type);
        return;
      }

      default:
        throw new Error(`Unsupported change type: ${(change as { type: string }).type}`);
    }
  }

  private upsertIndex(result: CloudUpsertResult, reason: FileSystemChangeType, oldPath?: string, emit = true): void {
    const normalizedPath = normalizePath(result.path);
    const canonicalPath = toCanonicalPathKey(normalizedPath);

    const existing = this.byCloudId.get(result.cloudId);
    if (existing && toCanonicalPathKey(existing.path) !== canonicalPath) {
      this.byPath.delete(toCanonicalPathKey(existing.path));
    }

    if (oldPath) {
      this.byPath.delete(toCanonicalPathKey(oldPath));
    }

    const next: SyncIndexEntry = {
      cloudId: result.cloudId,
      path: normalizedPath,
      entityType: result.entityType,
      updatedAt: this.now()
    };

    this.byPath.set(canonicalPath, next);
    this.byCloudId.set(result.cloudId, next);

    if (emit) {
      this.emitSnapshot(reason);
    }
  }

  private rebaseDescendantPaths(oldFolderPath: string, newFolderPath: string): void {
    const normalizedOld = normalizePath(oldFolderPath);
    const normalizedNew = normalizePath(newFolderPath);
    if (!normalizedOld || !normalizedNew) {
      return;
    }

    const oldPrefix = `${normalizedOld}/`;
    const rebasedEntries: SyncIndexEntry[] = [];

    for (const entry of this.byCloudId.values()) {
      if (!entry.path.startsWith(oldPrefix)) {
        continue;
      }

      const suffix = entry.path.slice(normalizedOld.length);
      const nextPath = normalizePath(`${normalizedNew}${suffix}`);
      if (!nextPath) {
        continue;
      }

      rebasedEntries.push({
        ...entry,
        path: nextPath,
        updatedAt: this.now()
      });
    }

    for (const entry of rebasedEntries) {
      const current = this.byCloudId.get(entry.cloudId);
      if (!current) {
        continue;
      }

      this.byPath.delete(toCanonicalPathKey(current.path));
      this.byPath.set(toCanonicalPathKey(entry.path), entry);
      this.byCloudId.set(entry.cloudId, entry);
    }
  }

  private removeIndexByCloudId(cloudId: string, reason: FileSystemChangeType): void {
    const existing = this.byCloudId.get(cloudId);
    if (!existing) {
      return;
    }

    this.byCloudId.delete(cloudId);
    this.byPath.delete(toCanonicalPathKey(existing.path));
    this.emitSnapshot(reason);
  }

  private emitSnapshot(reason: SyncIndexSnapshotEvent['reason']): void {
    this.seq += 1;
    this.mapChangesSubject.next({
      seq: this.seq,
      at: this.now(),
      reason,
      snapshot: this.snapshot()
    });
  }

  private snapshot(): SyncIndexSnapshot {
    const byPath: Record<string, SyncIndexEntry> = {};
    const byCloudId: Record<string, SyncIndexEntry> = {};

    for (const entry of this.byPath.values()) {
      byPath[entry.path] = { ...entry };
    }

    for (const entry of this.byCloudId.values()) {
      byCloudId[entry.cloudId] = { ...entry };
    }

    return { byPath, byCloudId };
  }

  private normalizeAndValidate(change: SyncChangeBase): SyncChangeBase {
    const path = normalizePath(change.path);
    if (!path) {
      throw new Error('Path must not be empty.');
    }

    const oldPath = change.oldPath ? normalizePath(change.oldPath) : undefined;

    if (requiresOldPath(change.type) && !oldPath) {
      throw new Error(`${change.type} requires oldPath.`);
    }

    return {
      ...change,
      path,
      oldPath
    };
  }

  private resolveEntityKey(change: SyncChangeBase): string {
    const byPath = this.lookupByPath(change.path);
    if (byPath) {
      return `cloud:${byPath.cloudId}`;
    }

    if (change.oldPath) {
      const byOldPath = this.lookupByPath(change.oldPath);
      if (byOldPath) {
        return `cloud:${byOldPath.cloudId}`;
      }
      return `path:${toCanonicalPathKey(change.oldPath)}`;
    }

    return `path:${toCanonicalPathKey(change.path)}`;
  }

  private resolveCloudId(path: string, oldPath?: string): string | null {
    const current = this.lookupByPath(path);
    if (current) {
      return current.cloudId;
    }
    if (oldPath) {
      const previous = this.lookupByPath(oldPath);
      if (previous) {
        return previous.cloudId;
      }
    }
    return null;
  }

  private lookupByPath(path: string): SyncIndexEntry | null {
    return this.byPath.get(toCanonicalPathKey(path)) ?? null;
  }

  private insertWithCompaction(queue: QueueRecord, incoming: QueuedChange): void {
    const items = queue.items;
    const last = items[items.length - 1];

    if (last) {
      if (
        incoming.type === 'file-edited' &&
        last.type === 'file-edited' &&
        incoming.enqueuedAt - last.enqueuedAt <= this.debounceMs
      ) {
        items[items.length - 1] = incoming;
        this.droppedByCompaction += 1;
        return;
      }

      if (last.type === 'file-created' && incoming.type === 'file-edited') {
        last.availableAt = Math.max(last.availableAt, incoming.availableAt);
        this.droppedByCompaction += 1;
        return;
      }

      if (last.type === 'file-created' && incoming.type === 'file-deleted') {
        items.pop();
        this.droppedByCompaction += 1;
        return;
      }

      if (
        (last.type === 'file-moved' && incoming.type === 'file-moved') ||
        (last.type === 'folder-moved' && incoming.type === 'folder-moved') ||
        (last.type === 'folder-renamed' && incoming.type === 'folder-renamed')
      ) {
        const merged: QueuedChange = {
          ...incoming,
          oldPath: last.oldPath ?? incoming.oldPath,
          enqueuedAt: last.enqueuedAt
        };
        items[items.length - 1] = merged;
        this.droppedByCompaction += 1;
        return;
      }

      if ((incoming.type === 'file-deleted' || incoming.type === 'folder-deleted') && items.length > 0) {
        queue.items = [incoming];
        this.droppedByCompaction += items.length;
        return;
      }
    }

    items.push(incoming);
  }

  private selectNextQueue(): QueueRecord | null {
    const now = this.now();
    const eligible: QueueRecord[] = [];

    for (const queue of this.queueMap.values()) {
      if (queue.items.length === 0) {
        continue;
      }

      const head = queue.items[0];
      if (head.availableAt <= now) {
        eligible.push(queue);
      }
    }

    if (eligible.length === 0) {
      return null;
    }

    eligible.sort((a, b) => {
      const aHead = a.items[0];
      const bHead = b.items[0];
      if (aHead.enqueuedAt !== bHead.enqueuedAt) {
        return aHead.enqueuedAt - bHead.enqueuedAt;
      }
      return a.entityKey.localeCompare(b.entityKey);
    });

    return eligible[0];
  }

  private getOrCreateQueue(entityKey: string): QueueRecord {
    const existing = this.queueMap.get(entityKey);
    if (existing) {
      return existing;
    }

    const created: QueueRecord = {
      entityKey,
      items: []
    };
    this.queueMap.set(entityKey, created);
    return created;
  }

  private deleteQueueIfEmpty(entityKey: string): void {
    const queue = this.queueMap.get(entityKey);
    if (queue && queue.items.length === 0) {
      this.queueMap.delete(entityKey);
    }
  }

  private getTotalPending(): number {
    let total = 0;
    for (const queue of this.queueMap.values()) {
      total += queue.items.length;
    }
    return total;
  }

  private computeBackoffMs(attempt: number): number {
    const base = this.retryBaseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const jitterMultiplier = 1 + this.randomInRange(-this.jitterRatio, this.jitterRatio);
    return Math.max(0, Math.round(base * jitterMultiplier));
  }

  private randomInRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private nextChangeId(): string {
    this.idCounter += 1;
    return `chg_${this.idCounter}`;
  }

  private computeInitialAvailableAt(type: FileSystemChangeType, enqueuedAt: number): number {
    if (type === 'file-created' || type === 'file-edited') {
      return enqueuedAt + this.debounceMs;
    }

    return enqueuedAt;
  }
}

function requiresOldPath(type: FileSystemChangeType): boolean {
  return type === 'file-moved' || type === 'folder-moved' || type === 'folder-renamed';
}

function defaultClassifyError(error: unknown): 'retryable' | 'non-retryable' {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('temporar') ||
    message.includes('429') ||
    message.includes('5xx')
  ) {
    return 'retryable';
  }

  return 'non-retryable';
}
