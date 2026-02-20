import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ICloudStorageApi,
  IFileSystemReader,
  RxSyncService,
  SyncIndexSnapshot,
  SyncIndexSnapshotEvent
} from './RxSyncService';

class Deferred<T> {
  public readonly promise: Promise<T>;
  private _resolve!: (value: T | PromiseLike<T>) => void;
  private _reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolve(value: T): void {
    this._resolve(value);
  }

  reject(reason?: unknown): void {
    this._reject(reason);
  }
}

function createFsMock(): IFileSystemReader {
  return {
    readFile: vi.fn(async (path: string) => ({
      name: path.split('/').pop() ?? 'file.txt',
      path,
      modifiedAt: Date.now(),
      content: new Blob(['content'])
    })),
    readFolder: vi.fn(async (path: string) => ({
      name: path.split('/').pop() ?? 'folder',
      path
    })),
    exists: vi.fn(async () => true)
  };
}

function createCloudMock(callOrder: string[]): ICloudStorageApi {
  return {
    createFile: vi.fn(async input => {
      callOrder.push(`createFile:${input.path}`);
      return { cloudId: `cf-${input.path}`, path: input.path, entityType: 'file' as const };
    }),
    updateFile: vi.fn(async (cloudId, input) => {
      callOrder.push(`updateFile:${cloudId}:${input.path}`);
      return { cloudId, path: input.path, entityType: 'file' as const };
    }),
    deleteFile: vi.fn(async cloudId => {
      callOrder.push(`deleteFile:${cloudId}`);
    }),
    moveFile: vi.fn(async (cloudId, newPath) => {
      callOrder.push(`moveFile:${cloudId}:${newPath}`);
      return { cloudId, path: newPath, entityType: 'file' as const };
    }),
    createFolder: vi.fn(async input => {
      callOrder.push(`createFolder:${input.path}`);
      return { cloudId: `cd-${input.path}`, path: input.path, entityType: 'folder' as const };
    }),
    renameFolder: vi.fn(async (cloudId, _newName, newPath) => {
      callOrder.push(`renameFolder:${cloudId}:${newPath}`);
      return { cloudId, path: newPath, entityType: 'folder' as const };
    }),
    deleteFolder: vi.fn(async cloudId => {
      callOrder.push(`deleteFolder:${cloudId}`);
    }),
    moveFolder: vi.fn(async (cloudId, newPath) => {
      callOrder.push(`moveFolder:${cloudId}:${newPath}`);
      return { cloudId, path: newPath, entityType: 'folder' as const };
    })
  };
}

function emptySnapshot(): SyncIndexSnapshot {
  return { byPath: {}, byCloudId: {} };
}

describe('RxSyncService (isolated)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires initializeIndex before start', () => {
    const calls: string[] = [];
    const service = new RxSyncService(createFsMock(), createCloudMock(calls));
    expect(() => service.start()).toThrowError(/initialized/i);
  });

  it('accepts enqueue before start and processes after start', async () => {
    const calls: string[] = [];
    const service = new RxSyncService(createFsMock(), createCloudMock(calls), {
      sendIntervalMs: 50,
      debounceMs: 0
    });

    service.initializeIndex(emptySnapshot());
    service.enqueueChange({
      type: 'file-created',
      entityType: 'file',
      path: 'notes/a.md'
    });

    expect(calls).toEqual([]);

    service.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(calls).toEqual(['createFile:notes/a.md']);
  });

  it('debounces consecutive file-edited changes for same entity', async () => {
    const calls: string[] = [];
    const fs = createFsMock();
    const cloud = createCloudMock(calls);

    const service = new RxSyncService(fs, cloud, {
      sendIntervalMs: 100,
      debounceMs: 1500
    });

    service.initializeIndex(emptySnapshot());
    service.enqueueChange({ type: 'file-edited', entityType: 'file', path: 'notes/a.md' });
    await vi.advanceTimersByTimeAsync(10);
    service.enqueueChange({ type: 'file-edited', entityType: 'file', path: 'notes/a.md' });
    await vi.advanceTimersByTimeAsync(10);
    service.enqueueChange({ type: 'file-edited', entityType: 'file', path: 'notes/a.md' });

    service.start();
    await vi.advanceTimersByTimeAsync(1700);

    expect((cloud.createFile as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    expect(calls).toEqual(['createFile:notes/a.md']);
  });

  it('processes oldest queue head first across entities', async () => {
    const calls: string[] = [];
    const service = new RxSyncService(createFsMock(), createCloudMock(calls), {
      sendIntervalMs: 20,
      maxOpsPerTick: 1,
      debounceMs: 0
    });

    service.initializeIndex(emptySnapshot());

    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'notes/old.md' });
    await vi.advanceTimersByTimeAsync(2);
    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'notes/new.md' });

    service.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(calls[0]).toBe('createFile:notes/old.md');
    expect(calls[1]).toBe('createFile:notes/new.md');
  });

  it('enforces single in-flight sender', async () => {
    const calls: string[] = [];
    const deferred = new Deferred<{ cloudId: string; path: string; entityType: 'file' }>();
    const cloud = createCloudMock(calls);
    cloud.createFile = vi.fn(async input => {
      calls.push(`createFile:${input.path}`);
      return deferred.promise;
    });

    const service = new RxSyncService(createFsMock(), cloud, {
      sendIntervalMs: 10,
      maxOpsPerTick: 1,
      debounceMs: 0
    });

    service.initializeIndex(emptySnapshot());
    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'a.md' });
    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'b.md' });

    service.start();

    await vi.advanceTimersByTimeAsync(30);
    expect((cloud.createFile as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);

    deferred.resolve({ cloudId: 'id-a', path: 'a.md', entityType: 'file' });
    await vi.advanceTimersByTimeAsync(30);

    expect((cloud.createFile as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it('retries retryable errors with backoff', async () => {
    const calls: string[] = [];
    const cloud = createCloudMock(calls);
    let attempts = 0;
    cloud.createFile = vi.fn(async input => {
      attempts += 1;
      calls.push(`createFile:${input.path}:attempt-${attempts}`);
      if (attempts === 1) {
        throw new Error('network timeout');
      }
      return { cloudId: 'id-1', path: input.path, entityType: 'file' as const };
    });

    const service = new RxSyncService(createFsMock(), cloud, {
      sendIntervalMs: 50,
      retryBaseDelayMs: 100,
      jitterRatio: 0,
      retryMaxAttempts: 2,
      debounceMs: 0
    });

    const results: { success: boolean; retryScheduled: boolean }[] = [];
    service.dispatchResults$.subscribe(r => {
      results.push({ success: r.success, retryScheduled: r.retryScheduled });
    });

    service.initializeIndex(emptySnapshot());
    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'retry.md' });
    service.start();

    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(80);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(attempts).toBe(2);
    expect(results.some(r => !r.success && r.retryScheduled)).toBe(true);
    expect(results.some(r => r.success)).toBe(true);
  });

  it('emits full snapshot on init and each map mutation', async () => {
    const calls: string[] = [];
    const service = new RxSyncService(createFsMock(), createCloudMock(calls), {
      sendIntervalMs: 20,
      debounceMs: 0
    });

    const snapshots: SyncIndexSnapshotEvent[] = [];
    service.mapChanges$.subscribe(e => snapshots.push(e));

    service.initializeIndex(emptySnapshot());
    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'notes/new.md' });
    service.start();

    await vi.advanceTimersByTimeAsync(30);

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0].reason).toBe('init');

    const last = snapshots[snapshots.length - 1];
    expect(last.snapshot.byPath['notes/new.md']?.cloudId).toBe('cf-notes/new.md');
    expect(last.seq).toBeGreaterThan(snapshots[0].seq);
  });

  it('validates oldPath for move/rename events', () => {
    const service = new RxSyncService(createFsMock(), createCloudMock([]));
    service.initializeIndex(emptySnapshot());

    expect(() => service.enqueueChange({ type: 'file-moved', entityType: 'file', path: 'new.md' })).toThrowError(
      /oldPath/i
    );
  });

  it('uses case-insensitive canonical path keys', async () => {
    const calls: string[] = [];
    const service = new RxSyncService(createFsMock(), createCloudMock(calls), {
      sendIntervalMs: 20,
      debounceMs: 0
    });

    service.initializeIndex({
      byPath: {
        'Notes/Doc.md': {
          cloudId: 'cloud-1',
          path: 'Notes/Doc.md',
          entityType: 'file',
          updatedAt: Date.now() - 10000
        }
      },
      byCloudId: {}
    });

    service.enqueueChange({ type: 'file-edited', entityType: 'file', path: 'notes/doc.md' });
    service.start();

    await vi.advanceTimersByTimeAsync(30);

    expect(calls).toEqual(['updateFile:cloud-1:notes/doc.md']);
  });

  it('stop pauses and restart resumes processing', async () => {
    const calls: string[] = [];
    const service = new RxSyncService(createFsMock(), createCloudMock(calls), {
      sendIntervalMs: 20,
      debounceMs: 0
    });

    service.initializeIndex(emptySnapshot());
    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'one.md' });

    service.start();
    await vi.advanceTimersByTimeAsync(25);

    service.stop();
    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'two.md' });
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toEqual(['createFile:one.md']);

    service.start();
    await vi.advanceTimersByTimeAsync(30);

    expect(calls).toEqual(['createFile:one.md', 'createFile:two.md']);
  });

  it('dispose is terminal', () => {
    const service = new RxSyncService(createFsMock(), createCloudMock([]));
    service.initializeIndex(emptySnapshot());
    service.dispose();

    expect(() => service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'x.md' })).toThrowError(
      /disposed/i
    );
  });

  it('extends file-created dispatch window when a file-edited event is compacted into it', async () => {
    const calls: string[] = [];
    const service = new RxSyncService(createFsMock(), createCloudMock(calls), {
      sendIntervalMs: 10,
      debounceMs: 100
    });

    service.initializeIndex(emptySnapshot());
    service.start();

    service.enqueueChange({ type: 'file-created', entityType: 'file', path: 'notes/a.md' });
    await vi.advanceTimersByTimeAsync(50);
    service.enqueueChange({ type: 'file-edited', entityType: 'file', path: 'notes/a.md' });

    await vi.advanceTimersByTimeAsync(90);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toEqual(['createFile:notes/a.md']);
  });

  it('skips cloud update when local file is already up-to-date', async () => {
    const calls: string[] = [];
    const fs = createFsMock();
    const cloud = createCloudMock(calls);

    (
      fs.readFile as unknown as { mockImplementation: (fn: (path: string) => Promise<unknown>) => void }
    ).mockImplementation(async (path: string) => ({
      name: path.split('/').pop() ?? 'file.txt',
      path,
      modifiedAt: Date.now() - 2000,
      content: new Blob(['content'])
    }));

    const service = new RxSyncService(fs, cloud, {
      sendIntervalMs: 20,
      debounceMs: 0,
      upToDateToleranceMs: 3000
    });

    service.initializeIndex({
      byPath: {
        'notes/a.md': {
          cloudId: 'cloud-1',
          path: 'notes/a.md',
          entityType: 'file',
          updatedAt: Date.now()
        }
      },
      byCloudId: {}
    });

    service.enqueueChange({ type: 'file-edited', entityType: 'file', path: 'notes/a.md' });
    service.start();
    await vi.advanceTimersByTimeAsync(30);

    expect(calls).toEqual([]);
  });
});
