/* eslint-disable @typescript-eslint/naming-convention */
import { Effect, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProtonFileId,
  ProtonFolderId,
  ProtonRequestCancelledError,
  TreeEventScopeId
} from '../services/proton-drive-types';

const getLoggerMock = vi.hoisted(() => vi.fn());
const getObsidianFileApiMock = vi.hoisted(() => vi.fn());
const getObsidianSettingsStoreMock = vi.hoisted(() => vi.fn());
const getProtonDriveApiMock = vi.hoisted(() => vi.fn());

const loggerInfoMock = vi.hoisted(() => vi.fn());
const loggerDebugMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('../services/ConsoleLogger', () => ({
  getLogger: getLoggerMock
}));

vi.mock('../services/ObsidianSettingsStore', () => ({
  getObsidianSettingsStore: getObsidianSettingsStoreMock
}));

vi.mock('../services/ObsidianFileApi', () => ({
  getObsidianFileApi: getObsidianFileApiMock,
  canonicalizePath: (path: string): { path: string; equals(other: { path: string }): boolean } => {
    const cleaned = path
      .trim()
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .toLocaleLowerCase();

    return {
      path: cleaned,
      equals(other: { path: string }): boolean {
        return cleaned === other.path;
      }
    };
  }
}));

vi.mock('../services/ProtonDriveApi', () => ({
  getProtonDriveApi: getProtonDriveApiMock
}));

function canonicalPath(path: string): { path: string; equals(other: { path: string }): boolean } {
  const cleaned = path
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLocaleLowerCase();

  return {
    path: cleaned,
    equals(other: { path: string }): boolean {
      return cleaned === other.path;
    }
  };
}

function vaultFile(
  rawPath: string,
  sha1: string,
  modifiedAt: Date
): {
  _type: 'file';
  name: string;
  rawPath: string;
  path: { path: string; equals(other: { path: string }): boolean };
  createdAt: Date;
  modifiedAt: Date;
  sha1: string;
} {
  const normalized = rawPath
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  const name = parts[parts.length - 1] ?? normalized;

  return {
    _type: 'file' as const,
    name,
    rawPath: normalized,
    path: canonicalPath(normalized),
    createdAt: new Date(modifiedAt.getTime() - 1_000),
    modifiedAt,
    sha1
  };
}

function vaultFolder(
  rawPath: string,
  children: Array<unknown> = []
): {
  _type: 'folder';
  name: string;
  rawPath: string;
  path: { path: string; equals(other: { path: string }): boolean };
  children: Array<unknown>;
} {
  const normalized = rawPath
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const name = normalized === '' ? '' : (normalized.split('/').at(-1) ?? normalized);

  return {
    _type: 'folder' as const,
    name,
    rawPath: normalized,
    path: canonicalPath(normalized),
    children
  };
}

function protonFolder(
  uid: string,
  name: string,
  parentId?: ProtonFolderId
): {
  _tag: 'folder';
  id: ProtonFolderId;
  parentId: Option.None<ProtonFolderId> | Option.Some<ProtonFolderId>;
  treeEventScopeId: TreeEventScopeId;
  name: string;
} {
  return {
    _tag: 'folder' as const,
    id: new ProtonFolderId(uid),
    parentId: parentId ? Option.some(parentId) : Option.none(),
    treeEventScopeId: new TreeEventScopeId(`scope-${uid}`),
    name
  };
}

function protonFile(
  uid: string,
  name: string,
  modifiedAt: Date,
  sha1?: string,
  parentId?: ProtonFolderId
): {
  _tag: 'file';
  id: ProtonFileId;
  parentId: Option.None<ProtonFolderId> | Option.Some<ProtonFolderId>;
  modifiedAt: Date;
  name: string;
  sha1: Option.None<string> | Option.Some<string>;
} {
  return {
    _tag: 'file' as const,
    id: new ProtonFileId(uid),
    parentId: parentId ? Option.some(parentId) : Option.none(),
    modifiedAt,
    name,
    sha1: typeof sha1 === 'string' ? Option.some(sha1) : Option.none()
  };
}

function createSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('SyncService', () => {
  const vault = { configDir: '.obsidian' };

  const settingsGetMock = vi.fn();
  const settingsGetRemoteFileStateSnapshotMock = vi.fn();
  const settingsSetRemoteFileStateSnapshotMock = vi.fn();

  const getFileTreeMock = vi.fn();
  const readFileContentMock = vi.fn();
  const ensureFolderMock = vi.fn();
  const writeFileContentMock = vi.fn();
  const deleteFileMock = vi.fn();
  const deleteFolderMock = vi.fn();

  const getFolderMock = vi.fn();
  const getFolderByNameMock = vi.fn();
  const createFolderMock = vi.fn();
  const getChildrenMock = vi.fn();
  const uploadFileMock = vi.fn();
  const uploadRevisionMock = vi.fn();
  const trashNodesMock = vi.fn();
  const downloadFileMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    settingsGetMock.mockReset();
    settingsGetRemoteFileStateSnapshotMock.mockReset();
    settingsSetRemoteFileStateSnapshotMock.mockReset();
    getFileTreeMock.mockReset();
    readFileContentMock.mockReset();
    ensureFolderMock.mockReset();
    writeFileContentMock.mockReset();
    deleteFileMock.mockReset();
    deleteFolderMock.mockReset();
    getFolderMock.mockReset();
    getFolderByNameMock.mockReset();
    createFolderMock.mockReset();
    getChildrenMock.mockReset();
    uploadFileMock.mockReset();
    uploadRevisionMock.mockReset();
    trashNodesMock.mockReset();
    downloadFileMock.mockReset();

    loggerInfoMock.mockReset();
    loggerDebugMock.mockReset();
    loggerWarnMock.mockReset();

    const logger = {
      info: loggerInfoMock,
      debug: loggerDebugMock,
      warn: loggerWarnMock,
      withScope: vi.fn()
    };
    logger.withScope.mockReturnValue(logger);
    getLoggerMock.mockReturnValue(logger);

    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'vaultRootNodeUid') {
        return Option.some(new ProtonFolderId('vault-root'));
      }

      if (key === 'ignoredPaths') {
        return [];
      }

      return undefined;
    });

    getObsidianSettingsStoreMock.mockReturnValue({
      get: settingsGetMock,
      getRemoteFileStateSnapshot: settingsGetRemoteFileStateSnapshotMock,
      setRemoteFileStateSnapshot: settingsSetRemoteFileStateSnapshotMock
    });

    settingsGetRemoteFileStateSnapshotMock.mockReturnValue(null);

    getObsidianFileApiMock.mockReturnValue({
      getFileTree: getFileTreeMock,
      readFileContent: readFileContentMock,
      ensureFolder: ensureFolderMock,
      writeFileContent: writeFileContentMock,
      deleteFile: deleteFileMock,
      deleteFolder: deleteFolderMock
    });

    getProtonDriveApiMock.mockReturnValue({
      getFolder: getFolderMock,
      getFolderByName: getFolderByNameMock,
      createFolder: createFolderMock,
      getChildren: getChildrenMock,
      uploadFile: uploadFileMock,
      uploadRevision: uploadRevisionMock,
      trashNodes: trashNodesMock,
      downloadFile: downloadFileMock
    });

    getFolderMock.mockImplementation((folderId: ProtonFolderId) =>
      Effect.succeed(Option.some(protonFolder(folderId.uid, 'root')))
    );
    getFolderByNameMock.mockImplementation(() => Effect.succeed(Option.none()));
    createFolderMock.mockImplementation((_name: string, parentId: ProtonFolderId) =>
      Effect.succeed(protonFolder(`created-${parentId.uid}`, 'created', parentId))
    );

    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [])));
    readFileContentMock.mockImplementation(() => Effect.succeed(new TextEncoder().encode('data').buffer));
    ensureFolderMock.mockImplementation(() => Effect.void);
    writeFileContentMock.mockImplementation(() => Effect.void);
    deleteFileMock.mockImplementation(() => Effect.void);
    deleteFolderMock.mockImplementation(() => Effect.void);

    getChildrenMock.mockImplementation(() => Effect.succeed([]));
    uploadFileMock.mockImplementation(() => Effect.void);
    uploadRevisionMock.mockImplementation(() => Effect.void);
    trashNodesMock.mockImplementation(() => Effect.void);
    downloadFileMock.mockImplementation(() => Effect.succeed(new TextEncoder().encode('remote').buffer));
  });

  it('throws when getting service before initialization', async () => {
    const mod = await import('../services/SyncService');

    expect(() => mod.getSyncService()).toThrowError(/has not been initialized/i);
  });

  it('returns singleton instance from init/get', async () => {
    const mod = await import('../services/SyncService');

    const first = mod.initSyncService(vault as never);
    const second = mod.initSyncService({ configDir: '.obsidian-2' } as never);
    const fromGet = mod.getSyncService();

    expect(first).toBe(second);
    expect(fromGet).toBe(first);
  });

  it('fails push when vault root id is missing', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'vaultRootNodeUid') {
        return Option.none();
      }
      if (key === 'ignoredPaths') {
        return [];
      }

      return undefined;
    });

    const result = await Effect.runPromise(Effect.either(sync.push(false, createSignal())));

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'VaultRootIdNotAvailableError' });
    }

    expect(sync.getState()).toEqual({ state: 'idle' });
  });

  it('pushes uploads/updates and batches prune deletes', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    const older = new Date('2026-03-06T11:00:00.000Z');

    const localTree = vaultFolder('', [
      vaultFolder('docs', [vaultFile('docs/new.md', 'sha-new', now), vaultFile('docs/keep.md', 'sha-keep', now)]),
      vaultFile('update.md', 'sha-update-local', now)
    ]);

    const remoteDocsId = new ProtonFolderId('remote-docs');
    const remoteOldFolderId = new ProtonFolderId('remote-old-folder');

    getFileTreeMock.mockImplementation(() => Effect.succeed(localTree));

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFolder('remote-docs', 'docs', new ProtonFolderId('vault-root')),
          protonFile('remote-update', 'update.md', older, 'sha-update-remote', new ProtonFolderId('vault-root')),
          protonFile('remote-stale-file', 'stale.md', older, 'sha-stale', new ProtonFolderId('vault-root')),
          protonFolder('remote-old-folder', 'old-folder', new ProtonFolderId('vault-root'))
        ]);
      }

      if (folderId.uid === remoteDocsId.uid) {
        return Effect.succeed([
          protonFile('remote-keep', 'keep.md', older, 'sha-keep', remoteDocsId),
          protonFile('remote-ghost', 'ghost.md', older, 'sha-ghost', remoteDocsId)
        ]);
      }

      if (folderId.uid === remoteOldFolderId.uid) {
        return Effect.succeed([]);
      }

      return Effect.succeed([]);
    });

    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'docs/ghost.md': 'sha-ghost',
      'stale.md': 'sha-stale',
      'update.md': 'sha-update-remote'
    });

    await Effect.runPromise(sync.push(true, createSignal()));

    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock.mock.calls[0]?.[0]).toBe('new.md');
    expect(uploadFileMock.mock.calls[0]?.[3].uid).toBe('remote-docs');

    expect(uploadRevisionMock).toHaveBeenCalledTimes(1);
    expect(uploadRevisionMock.mock.calls[0]?.[0].uid).toBe('remote-update');

    expect(trashNodesMock).toHaveBeenCalledTimes(1);
    const deleteIds = trashNodesMock.mock.calls[0]?.[0] as Array<{ uid: string }>;
    expect(deleteIds.map(id => id.uid).sort()).toEqual(['remote-ghost', 'remote-old-folder', 'remote-stale-file']);

    expect(readFileContentMock).toHaveBeenCalledWith('docs/new.md');
    expect(readFileContentMock).toHaveBeenCalledWith('update.md');
    expect(settingsSetRemoteFileStateSnapshotMock).toHaveBeenCalledWith({
      'docs/keep.md': 'sha-keep',
      'docs/new.md': 'sha-new',
      'update.md': 'sha-update-local'
    });

    expect(sync.getState()).toEqual({ state: 'idle' });
  });

  it('pulls remote changes and prunes local orphans when enabled', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    const newer = new Date('2026-03-06T13:00:00.000Z');

    const localTree = vaultFolder('', [
      vaultFolder('docs', [vaultFile('docs/keep.md', 'sha-keep', now)]),
      vaultFile('local-only.md', 'sha-local-only', now),
      vaultFolder('local-only-folder', [vaultFile('local-only-folder/a.txt', 'sha-a', now)])
    ]);

    const remoteDocsId = new ProtonFolderId('remote-docs');
    const remoteNewFolderId = new ProtonFolderId('remote-new-folder');

    getFileTreeMock.mockImplementation(() => Effect.succeed(localTree));

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFolder('remote-docs', 'docs', new ProtonFolderId('vault-root')),
          protonFolder('remote-new-folder', 'remote-folder', new ProtonFolderId('vault-root')),
          protonFile('remote-root-new', 'root-new.md', newer, undefined, new ProtonFolderId('vault-root'))
        ]);
      }

      if (folderId.uid === remoteDocsId.uid) {
        return Effect.succeed([
          protonFile('remote-keep', 'keep.md', newer, 'sha-keep', remoteDocsId),
          protonFile('remote-doc-new', 'remote-new.md', newer, 'sha-doc-new', remoteDocsId)
        ]);
      }

      if (folderId.uid === remoteNewFolderId.uid) {
        return Effect.succeed([protonFile('remote-nested', 'nested.md', newer, 'sha-nested', remoteNewFolderId)]);
      }

      return Effect.succeed([]);
    });

    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'local-only-folder/a.txt': 'sha-a',
      'local-only.md': 'sha-local-only'
    });

    await Effect.runPromise(sync.pull(true, createSignal()));

    expect(writeFileContentMock).toHaveBeenCalledWith('root-new.md', expect.any(ArrayBuffer), newer);
    expect(writeFileContentMock).toHaveBeenCalledWith('docs/remote-new.md', expect.any(ArrayBuffer), newer);
    expect(writeFileContentMock).toHaveBeenCalledWith('remote-folder/nested.md', expect.any(ArrayBuffer), newer);

    expect(downloadFileMock).toHaveBeenCalledTimes(3);
    expect(settingsSetRemoteFileStateSnapshotMock).toHaveBeenCalledWith({
      'docs/keep.md': 'sha-keep',
      'docs/remote-new.md': 'sha-doc-new',
      'remote-folder/nested.md': 'sha-nested',
      'root-new.md': null
    });

    expect(deleteFileMock).toHaveBeenCalledWith('local-only.md');
    expect(deleteFolderMock).toHaveBeenCalledWith('local-only-folder');

    expect(sync.getState()).toEqual({ state: 'idle' });
  });

  it('logs and skips push conflicts when remote file diverged from snapshot', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    const older = new Date('2026-03-06T11:00:00.000Z');

    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [vaultFile('note.md', 'sha-local', now)])));
    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFile('remote-note', 'note.md', older, 'sha-remote', new ProtonFolderId('vault-root'))
        ]);
      }

      return Effect.succeed([]);
    });
    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'note.md': 'sha-snapshot'
    });

    await Effect.runPromise(sync.push(false, createSignal()));

    expect(uploadRevisionMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith('Detected push conflict, skipping file', {
      path: 'note.md',
      localSha1: 'sha-local',
      remoteSha1: 'sha-remote',
      snapshotSha1: 'sha-snapshot'
    });
  });

  it('logs and skips push prune conflicts when remote file diverged from snapshot', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');

    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [vaultFile('keep.md', 'sha-keep', now)])));
    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFile('remote-keep', 'keep.md', now, 'sha-keep', new ProtonFolderId('vault-root')),
          protonFile('remote-stale', 'stale.md', now, 'sha-remote', new ProtonFolderId('vault-root'))
        ]);
      }

      return Effect.succeed([]);
    });
    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'stale.md': 'sha-snapshot'
    });

    await Effect.runPromise(sync.push(true, createSignal()));

    expect(trashNodesMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith('Detected push conflict while pruning remote file, skipping file', {
      path: 'stale.md',
      remoteSha1: 'sha-remote',
      snapshotSha1: 'sha-snapshot'
    });
  });

  it('logs and skips push prune conflicts when a remote folder subtree diverged from snapshot', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    const remoteFolderId = new ProtonFolderId('remote-orphan-folder');

    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [vaultFile('keep.md', 'sha-keep', now)])));
    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFile('remote-keep', 'keep.md', now, 'sha-keep', new ProtonFolderId('vault-root')),
          protonFolder('remote-orphan-folder', 'orphan-folder', new ProtonFolderId('vault-root'))
        ]);
      }

      if (folderId.uid === remoteFolderId.uid) {
        return Effect.succeed([protonFile('remote-child', 'child.md', now, 'sha-remote', remoteFolderId)]);
      }

      return Effect.succeed([]);
    });
    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'orphan-folder/child.md': 'sha-snapshot'
    });

    await Effect.runPromise(sync.push(true, createSignal()));

    expect(trashNodesMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith('Detected push conflict while pruning remote folder, skipping folder', {
      path: 'orphan-folder',
      conflictingPath: 'orphan-folder/child.md'
    });
  });

  it('maps ProtonRequestCancelledError to SyncCancelledError', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    getChildrenMock.mockImplementation(() => Effect.fail(new ProtonRequestCancelledError({ reason: 'stop' })));

    const result = await Effect.runPromise(Effect.either(sync.push(false, createSignal())));

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'SyncCancelledError', reason: 'stop' });
    }

    expect(sync.getState()).toEqual({ state: 'idle' });
  });

  it('persists partially updated push snapshot when a later operation is cancelled', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');

    getFileTreeMock.mockImplementation(() =>
      Effect.succeed(vaultFolder('', [vaultFile('a.md', 'sha-a', now), vaultFile('b.md', 'sha-b', now)]))
    );

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([]);
      }

      return Effect.succeed([]);
    });

    let uploadCount = 0;
    uploadFileMock.mockImplementation(() => {
      uploadCount += 1;
      if (uploadCount === 1) {
        return Effect.void;
      }

      return Effect.fail(new ProtonRequestCancelledError({ reason: 'stop' }));
    });

    const result = await Effect.runPromise(Effect.either(sync.push(false, createSignal())));

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'SyncCancelledError', reason: 'stop' });
    }

    expect(settingsSetRemoteFileStateSnapshotMock).toHaveBeenCalledWith({
      'a.md': 'sha-a'
    });
  });

  it('blocks concurrent operations and allows cancelling through external signal', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const localTree = vaultFolder('', []);

    let resolveTree: (value: unknown) => void = () => undefined;
    const pendingTree = new Promise<unknown>(resolve => {
      resolveTree = resolve;
    });

    getFileTreeMock.mockImplementation(() => Effect.promise(() => pendingTree as Promise<unknown>));

    const controller = new AbortController();
    const firstPushPromise = Effect.runPromise(Effect.either(sync.push(false, controller.signal)));

    await Promise.resolve();

    const secondPushResult = await Effect.runPromise(Effect.either(sync.push(false, createSignal())));
    expect(secondPushResult._tag).toBe('Left');
    if (secondPushResult._tag === 'Left') {
      expect(secondPushResult.left).toMatchObject({ _tag: 'SyncAlreadyInProgressError' });
    }

    controller.abort('manual-stop');

    resolveTree(localTree);

    const firstPushResult = await firstPushPromise;
    expect(firstPushResult._tag).toBe('Left');
    if (firstPushResult._tag === 'Left') {
      expect(firstPushResult.left).toMatchObject({ _tag: 'SyncCancelledError', reason: 'manual-stop' });
    }

    expect(sync.getState()).toEqual({ state: 'idle' });
  });

  it('emits push state transitions through all substates', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [vaultFile('a.md', 'sha-a', now)])));

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([]);
      }

      return Effect.succeed([]);
    });

    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'a.md': 'sha-a'
    });

    const observed: Array<{ state: string; subState?: string }> = [];
    const sub = sync.state$.subscribe(state => {
      observed.push({ state: state.state, subState: 'subState' in state ? state.subState : undefined });
    });

    await Effect.runPromise(sync.push(false, createSignal()));
    sub.unsubscribe();

    const pushSubstatesInOrder = observed
      .filter(s => s.state === 'pushing' && typeof s.subState === 'string')
      .map(s => s.subState as string)
      .filter((state, index, arr) => arr.indexOf(state) === index);

    expect(pushSubstatesInOrder).toEqual(['localTreeBuild', 'remoteTreeBuild', 'diffComputation', 'applyingChanges']);
    expect(observed.at(-1)).toEqual({ state: 'idle', subState: undefined });
  });

  it('does not prune remote nodes when push prune flag is false', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [vaultFile('same.md', 'sha-same', now)])));

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFile('remote-extra', 'extra.md', now, 'sha-extra', new ProtonFolderId('vault-root')),
          protonFile('remote-same', 'same.md', now, 'sha-same', new ProtonFolderId('vault-root'))
        ]);
      }

      return Effect.succeed([]);
    });

    await Effect.runPromise(sync.push(false, createSignal()));

    expect(trashNodesMock).not.toHaveBeenCalled();
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(uploadRevisionMock).not.toHaveBeenCalled();
  });

  it('excludes plugin config and ignored paths from push upload operations', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');

    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'vaultRootNodeUid') {
        return Option.some(new ProtonFolderId('vault-root'));
      }

      if (key === 'ignoredPaths') {
        return ['secret/**'];
      }

      return undefined;
    });

    getFileTreeMock.mockImplementation(() =>
      Effect.succeed(
        vaultFolder('', [
          vaultFile('.obsidian/plugins/proton-drive-sync/internal.json', 'sha-internal', now),
          vaultFile('secret/token.txt', 'sha-secret', now),
          vaultFile('normal.md', 'sha-normal', now)
        ])
      )
    );

    getChildrenMock.mockImplementation(() => Effect.succeed([]));

    await Effect.runPromise(sync.push(false, createSignal()));

    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock.mock.calls[0]?.[0]).toBe('normal.md');
    expect(readFileContentMock).toHaveBeenCalledTimes(1);
    expect(readFileContentMock).toHaveBeenCalledWith('normal.md');
  });

  it('maps already-aborted external signal to SyncCancelledError with reason', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const controller = new AbortController();
    controller.abort('external-abort');

    const result = await Effect.runPromise(Effect.either(sync.push(false, controller.signal)));

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'SyncCancelledError', reason: 'external-abort' });
    }
  });

  it('emits pull state transitions through all substates', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    const newer = new Date('2026-03-06T13:00:00.000Z');

    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [vaultFile('a.md', 'sha-a', now)])));

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFile('remote-a', 'a.md', newer, 'sha-remote-a', new ProtonFolderId('vault-root'))
        ]);
      }

      return Effect.succeed([]);
    });

    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'a.md': 'sha-a'
    });

    const observed: Array<{ state: string; subState?: string }> = [];
    const sub = sync.state$.subscribe(state => {
      observed.push({ state: state.state, subState: 'subState' in state ? state.subState : undefined });
    });

    await Effect.runPromise(sync.pull(false, createSignal()));
    sub.unsubscribe();

    const pullSubstatesInOrder = observed
      .filter(s => s.state === 'pulling' && typeof s.subState === 'string')
      .map(s => s.subState as string)
      .filter((state, index, arr) => arr.indexOf(state) === index);

    expect(pullSubstatesInOrder).toEqual(['localTreeBuild', 'remoteTreeBuild', 'diffComputation', 'applyingChanges']);
    expect(observed.at(-1)).toEqual({ state: 'idle', subState: undefined });
  });

  it('reports pull applyingChanges progress counters while executing operations', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    const newer = new Date('2026-03-06T13:00:00.000Z');

    getFileTreeMock.mockImplementation(() =>
      Effect.succeed(
        vaultFolder('', [
          vaultFile('orphan.md', 'sha-orphan', now),
          vaultFolder('orphan-folder', [vaultFile('orphan-folder/a.md', 'sha-a', now)])
        ])
      )
    );

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFile('remote-write', 'from-remote.md', newer, 'sha-remote-write', new ProtonFolderId('vault-root'))
        ]);
      }

      return Effect.succeed([]);
    });

    const applyingSnapshots: Array<{ totalItems: number; processedItems: number }> = [];
    const sub = sync.state$.subscribe(state => {
      if (state.state === 'pulling' && state.subState === 'applyingChanges') {
        applyingSnapshots.push({ totalItems: state.totalItems, processedItems: state.processedItems });
      }
    });

    await Effect.runPromise(sync.pull(true, createSignal()));
    sub.unsubscribe();

    expect(applyingSnapshots.length).toBeGreaterThanOrEqual(1);
    const processedValues = applyingSnapshots.map(s => s.processedItems);
    expect(processedValues[0]).toBe(0);
    expect(processedValues).toEqual([...processedValues].sort((a, b) => a - b));
    expect(new Set(applyingSnapshots.map(s => s.totalItems)).size).toBe(1);
    expect(applyingSnapshots[0]?.totalItems).toBeGreaterThan(0);
  });

  it('logs and skips pull conflicts when local file diverged from snapshot', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');
    const newer = new Date('2026-03-06T13:00:00.000Z');

    getFileTreeMock.mockImplementation(() => Effect.succeed(vaultFolder('', [vaultFile('note.md', 'sha-local', now)])));
    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([
          protonFile('remote-note', 'note.md', newer, 'sha-remote', new ProtonFolderId('vault-root'))
        ]);
      }

      return Effect.succeed([]);
    });
    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'note.md': 'sha-snapshot'
    });

    await Effect.runPromise(sync.pull(false, createSignal()));

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith('Detected pull conflict, skipping file', {
      path: 'note.md',
      localSha1: 'sha-local',
      remoteSha1: 'sha-remote',
      snapshotSha1: 'sha-snapshot'
    });
  });

  it('logs and skips pull prune conflicts when local file diverged from snapshot', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');

    getFileTreeMock.mockImplementation(() =>
      Effect.succeed(vaultFolder('', [vaultFile('stale.md', 'sha-local', now)]))
    );
    getChildrenMock.mockImplementation(() => Effect.succeed([]));
    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'stale.md': 'sha-snapshot'
    });

    await Effect.runPromise(sync.pull(true, createSignal()));

    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith('Detected pull conflict while pruning local file, skipping file', {
      path: 'stale.md',
      localSha1: 'sha-local',
      snapshotSha1: 'sha-snapshot'
    });
  });

  it('logs and skips pull prune conflicts when a local folder subtree diverged from snapshot', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');

    getFileTreeMock.mockImplementation(() =>
      Effect.succeed(
        vaultFolder('', [vaultFolder('orphan-folder', [vaultFile('orphan-folder/child.md', 'sha-local', now)])])
      )
    );
    getChildrenMock.mockImplementation(() => Effect.succeed([]));
    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'orphan-folder/child.md': 'sha-snapshot'
    });

    await Effect.runPromise(sync.pull(true, createSignal()));

    expect(deleteFolderMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith('Detected pull conflict while pruning local folder, skipping folder', {
      path: 'orphan-folder',
      conflictingPath: 'orphan-folder/child.md'
    });
  });

  it('prunes using top-level folder delete without redundant nested deletes', async () => {
    const mod = await import('../services/SyncService');
    const sync = mod.initSyncService(vault as never);

    const now = new Date('2026-03-06T12:00:00.000Z');

    getFileTreeMock.mockImplementation(() =>
      Effect.succeed(
        vaultFolder('', [
          vaultFolder('orphan-folder', [
            vaultFile('orphan-folder/a.md', 'sha-a', now),
            vaultFolder('orphan-folder/nested', [vaultFile('orphan-folder/nested/b.md', 'sha-b', now)])
          ]),
          vaultFile('orphan-file.md', 'sha-orphan-file', now)
        ])
      )
    );

    getChildrenMock.mockImplementation((folderId: ProtonFolderId) => {
      if (folderId.uid === 'vault-root') {
        return Effect.succeed([]);
      }

      return Effect.succeed([]);
    });

    settingsGetRemoteFileStateSnapshotMock.mockReturnValue({
      'orphan-file.md': 'sha-orphan-file',
      'orphan-folder/a.md': 'sha-a',
      'orphan-folder/nested/b.md': 'sha-b'
    });

    await Effect.runPromise(sync.pull(true, createSignal()));

    expect(deleteFolderMock).toHaveBeenCalledTimes(1);
    expect(deleteFolderMock).toHaveBeenCalledWith('orphan-folder');

    expect(deleteFileMock).toHaveBeenCalledTimes(1);
    expect(deleteFileMock).toHaveBeenCalledWith('orphan-file.md');
  });
});
