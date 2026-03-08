import { type UploadMetadata } from '@protontech/drive-sdk';
import { Data, Effect, Option } from 'effect';
import { normalizePath, type Vault } from 'obsidian';
import picomatch from 'picomatch';
import { BehaviorSubject } from 'rxjs';

import { getLogger } from './ConsoleLogger';
import type { VaultFolder } from './ObsidianFileApi';
import { canonicalizePath, getObsidianFileApi } from './ObsidianFileApi';
import { getObsidianSettingsStore } from './ObsidianSettingsStore';
import type {
  FileUploadError,
  GenericProtonDriveError,
  InvalidNameError,
  ItemAlreadyExistsError,
  NotAFolderError,
  PermissionError,
  ProtonApiError,
  ProtonFileId,
  ProtonRequestCancelledError
} from './proton-drive-types';
import { ProtonFolderId, TreeEventScopeId } from './proton-drive-types';
import type { ProtonFile, ProtonFolder } from './ProtonDriveApi';
import { getProtonDriveApi } from './ProtonDriveApi';

const EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH = '/plugins/proton-drive-sync';
const SYNC_TIMING_SCOPE = 'timing-metrics';

type TimingLogger = Pick<ReturnType<typeof getLogger>, 'debug'>;

type ProtonRecursiveFolder = ProtonFolder & {
  children: Array<ProtonRecursiveFolder | ProtonFile>;
};

export type SyncSubstate = 'localTreeBuild' | 'remoteTreeBuild' | 'diffComputation' | 'applyingChanges';

export type SyncState =
  | { state: 'idle' }
  | { state: 'auth' }
  | {
      state: 'pushing';
      subState: SyncSubstate;
      totalItems: number;
      processedItems: number;
    }
  | {
      state: 'pulling';
      subState: SyncSubstate;
      totalItems: number;
      processedItems: number;
    };

export const { init: initSyncService, get: getSyncService } = (function (): {
  init: (this: void, vault: Vault) => SyncService;
  get: (this: void) => SyncService;
} {
  let instance: SyncService | null = null;

  return {
    init: function (this: void, vault: Vault): SyncService {
      return (instance ??= new SyncService(vault));
    },
    get: function (this: void): SyncService {
      if (!instance) {
        throw new Error('SyncService has not been initialized. Please call initSyncService first.');
      }
      return instance;
    }
  };
})();

interface FolderCreate {
  id: ProtonFolderId;
  name: string;
  parentId: ProtonFolderId;
}

interface FileUpload {
  name: string;
  parentId: ProtonFolderId;
  rawPath: string;
  modifiedAt: Date;
  sha1: string;
}

interface FileUpdate {
  id: ProtonFileId;
  rawPath: string;
  modifiedAt: Date;
  sha1: string;
}

interface FileDelete {
  id: ProtonFileId;
}

interface FolderDelete {
  id: ProtonFolderId;
}

interface LocalFolderCreate {
  rawPath: string;
}

interface LocalFileWrite {
  rawPath: string;
  remoteId: ProtonFileId;
  remoteModifiedAt: Date;
}

interface LocalFileDelete {
  rawPath: string;
}

interface LocalFolderDelete {
  rawPath: string;
}

type PushSyncOperation =
  | { type: 'createFolder'; details: FolderCreate }
  | { type: 'uploadFile'; details: FileUpload }
  | { type: 'updateFile'; details: FileUpdate }
  | { type: 'deleteFile'; details: FileDelete }
  | { type: 'deleteFolder'; details: FolderDelete };

type PullSyncOperation =
  | { type: 'createLocalFolder'; details: LocalFolderCreate }
  | { type: 'writeLocalFile'; details: LocalFileWrite }
  | { type: 'deleteLocalFile'; details: LocalFileDelete }
  | { type: 'deleteLocalFolder'; details: LocalFolderDelete };

class SyncService {
  readonly #logger = getLogger('SyncService');
  readonly #stateSubject = new BehaviorSubject<SyncState>({ state: 'idle' });
  public readonly state$ = this.#stateSubject.asObservable();

  public constructor(private readonly vault: Vault) {}

  public getState(): SyncState {
    return this.#stateSubject.value;
  }

  public setAuthenticationState(): void {
    this.#stateSubject.next({ state: 'auth' });
  }

  public setIdleState(): void {
    this.#stateSubject.next({ state: 'idle' });
  }

  public push(
    prune: boolean,
    signal: AbortSignal
  ): Effect.Effect<
    void,
    | SyncAlreadyInProgressError
    | VaultRootIdNotAvailableError
    | SyncCancelledError
    | GenericProtonDriveError
    | InvalidNameError
    | ItemAlreadyExistsError
    | ProtonApiError
    | NotAFolderError
    | PermissionError
    | FileUploadError,
    never
  > {
    return Effect.gen(this, function* () {
      if (this.#stateSubject.value.state !== 'idle' && this.#stateSubject.value.state !== 'auth') {
        yield* new SyncAlreadyInProgressError();
      }

      const idleEffect = Effect.sync(() => {
        this.setIdleState();
      });

      yield* this.#pushImpl(prune, signal).pipe(
        Effect.catchTag('ProtonRequestCancelledError', error =>
          Effect.fail(new SyncCancelledError({ reason: error.reason }))
        ),
        Effect.tapBoth({ onSuccess: () => idleEffect, onFailure: () => idleEffect })
      );
    });
  }

  public pull(
    prune: boolean,
    signal: AbortSignal
  ): Effect.Effect<
    void,
    | SyncAlreadyInProgressError
    | VaultRootIdNotAvailableError
    | SyncCancelledError
    | GenericProtonDriveError
    | InvalidNameError
    | ItemAlreadyExistsError
    | ProtonApiError
    | NotAFolderError,
    never
  > {
    return Effect.gen(this, function* () {
      if (this.#stateSubject.value.state !== 'idle' && this.#stateSubject.value.state !== 'auth') {
        yield* new SyncAlreadyInProgressError();
      }

      const idleEffect = Effect.sync(() => {
        this.setIdleState();
      });

      yield* this.#pullImpl(prune, signal).pipe(
        Effect.catchTag('ProtonRequestCancelledError', error =>
          Effect.fail(new SyncCancelledError({ reason: error.reason }))
        ),
        Effect.tapBoth({ onSuccess: () => idleEffect, onFailure: () => idleEffect })
      );
    });
  }

  #pushImpl(
    prune: boolean,
    signal: AbortSignal
  ): Effect.Effect<
    undefined,
    | VaultRootIdNotAvailableError
    | SyncCancelledError
    | GenericProtonDriveError
    | InvalidNameError
    | ItemAlreadyExistsError
    | ProtonApiError
    | NotAFolderError
    | PermissionError
    | FileUploadError
    | ProtonRequestCancelledError,
    never
  > {
    return Effect.gen(this, function* () {
      const logger = this.#logger.withScope('push');
      const timingLogger = logger.withScope(SYNC_TIMING_SCOPE);
      logger.info('Starting config push');

      yield* this.#ensureNotCancelled(signal);

      const vaultRootNodeId = getObsidianSettingsStore().get('vaultRootNodeUid');

      if (Option.isNone(vaultRootNodeId)) {
        return yield* new VaultRootIdNotAvailableError();
      }

      this.#stateSubject.next({ state: 'pushing', subState: 'localTreeBuild', totalItems: 0, processedItems: 0 });

      const fileApi = getObsidianFileApi();
      const localRoot = yield* this.#withTiming(timingLogger, 'Computed local file tree', fileApi.getFileTree());
      yield* this.#ensureNotCancelled(signal);

      this.#stateSubject.next({ state: 'pushing', subState: 'remoteTreeBuild', totalItems: 0, processedItems: 0 });

      const driveApi = getProtonDriveApi();

      const remoteRoot = yield* this.#withTiming(
        timingLogger,
        'Computed remote file tree',
        Effect.gen(this, function* () {
          const remoteConfigRootFolder = yield* this.#getOrCreateRemoteRoot('/', vaultRootNodeId.value, signal);
          return yield* this.#buildRemoteTree(remoteConfigRootFolder, signal);
        })
      );
      yield* this.#ensureNotCancelled(signal);

      this.#stateSubject.next({ state: 'pushing', subState: 'diffComputation', totalItems: 0, processedItems: 0 });

      const syncOps = yield* this.#withTiming(
        timingLogger,
        'Computed push creation operations',
        Effect.sync(() => this.#computePushCreationOperations(localRoot, remoteRoot, logger))
      );
      yield* this.#ensureNotCancelled(signal);

      if (prune) {
        yield* this.#withTiming(
          timingLogger,
          'Computed push prune operations',
          Effect.sync(() => {
            syncOps.push(...this.#computePushPruneOperations(localRoot, remoteRoot));
          })
        );
        yield* this.#ensureNotCancelled(signal);
      }

      yield* this.#withTiming(
        timingLogger,
        'Applied operations',
        this.#applyPushOperations(syncOps, logger, driveApi, fileApi, signal)
      );

      this.setIdleState();
    });
  }

  #pullImpl(
    prune: boolean,
    signal: AbortSignal
  ): Effect.Effect<
    undefined,
    | VaultRootIdNotAvailableError
    | SyncCancelledError
    | GenericProtonDriveError
    | InvalidNameError
    | ItemAlreadyExistsError
    | ProtonApiError
    | NotAFolderError
    | ProtonRequestCancelledError,
    never
  > {
    return Effect.gen(this, function* () {
      const logger = this.#logger.withScope('pull');
      const timingLogger = logger.withScope(SYNC_TIMING_SCOPE);
      logger.info('Starting config pull', { deleteLocalOrphans: prune });

      yield* this.#ensureNotCancelled(signal);

      const vaultRootNodeId = getObsidianSettingsStore().get('vaultRootNodeUid');

      if (Option.isNone(vaultRootNodeId)) {
        return yield* new VaultRootIdNotAvailableError();
      }

      this.#stateSubject.next({ state: 'pulling', subState: 'localTreeBuild', totalItems: 0, processedItems: 0 });
      const fileApi = getObsidianFileApi();
      const localRoot = yield* this.#withTiming(timingLogger, 'Computed local file tree', fileApi.getFileTree());
      yield* this.#ensureNotCancelled(signal);

      this.#stateSubject.next({ state: 'pulling', subState: 'remoteTreeBuild', totalItems: 0, processedItems: 0 });

      const remoteRoot = yield* this.#withTiming(
        timingLogger,
        'Computed remote file tree',
        Effect.gen(this, function* () {
          const remoteConfigRootFolder = yield* this.#getOrCreateRemoteRoot('/', vaultRootNodeId.value, signal);
          return yield* this.#buildRemoteTree(remoteConfigRootFolder, signal);
        })
      );
      yield* this.#ensureNotCancelled(signal);

      this.#stateSubject.next({ state: 'pulling', subState: 'diffComputation', totalItems: 0, processedItems: 0 });

      const { localFolderCreatePaths, localFileWrites } = yield* this.#withTiming(
        timingLogger,
        'Computed pull creation operations',
        Effect.sync(() => this.#computePullCreationOperations(localRoot, remoteRoot, logger))
      );
      yield* this.#ensureNotCancelled(signal);

      const { localFileDeletePaths, localFolderDeletePaths } = yield* this.#withTiming(
        timingLogger,
        'Computed pull prune operations',
        Effect.sync(() => this.#computePullPruneOperations(localRoot, remoteRoot, prune))
      );
      yield* this.#ensureNotCancelled(signal);

      const keptFolderDeletes: Array<string> = [];
      for (const folderPath of Array.from(localFolderDeletePaths).sort((a, b) => pathDepth(a) - pathDepth(b))) {
        if (
          !keptFolderDeletes.some(parentPath => folderPath === parentPath || folderPath.startsWith(`${parentPath}/`))
        ) {
          keptFolderDeletes.push(folderPath);
        }
      }

      const keptFileDeletes = Array.from(localFileDeletePaths).filter(
        filePath =>
          !keptFolderDeletes.some(folderPath => filePath === folderPath || filePath.startsWith(`${folderPath}/`))
      );

      const pullOps: Array<PullSyncOperation> = [];

      for (const folderPath of Array.from(localFolderCreatePaths).sort((a, b) => pathDepth(a) - pathDepth(b))) {
        pullOps.push({ type: 'createLocalFolder', details: { rawPath: folderPath } });
      }

      for (const writeOp of localFileWrites.values()) {
        pullOps.push({ type: 'writeLocalFile', details: writeOp });
      }

      for (const filePath of keptFileDeletes) {
        pullOps.push({ type: 'deleteLocalFile', details: { rawPath: filePath } });
      }

      for (const folderPath of keptFolderDeletes.sort((a, b) => pathDepth(b) - pathDepth(a))) {
        pullOps.push({ type: 'deleteLocalFolder', details: { rawPath: folderPath } });
      }

      yield* this.#withTiming(
        timingLogger,
        'Applied operations',
        this.#applyPullOperations(pullOps, logger, getProtonDriveApi(), fileApi, signal)
      );

      this.setIdleState();
    });
  }

  #applyPullOperations(
    pullOps: Array<PullSyncOperation>,
    logger: ReturnType<typeof getLogger>,
    driveApi: ReturnType<typeof getProtonDriveApi>,
    fileApi: ReturnType<typeof getObsidianFileApi>,
    signal: AbortSignal
  ): Effect.Effect<void, SyncCancelledError | GenericProtonDriveError | ProtonRequestCancelledError, never> {
    return Effect.gen(this, function* () {
      const totalOps = pullOps.length;
      let processedOps = 0;

      for (const op of pullOps) {
        yield* this.#ensureNotCancelled(signal);

        this.#stateSubject.next({
          state: 'pulling',
          subState: 'applyingChanges',
          totalItems: totalOps,
          processedItems: processedOps
        });

        switch (op.type) {
          case 'createLocalFolder':
            {
              logger.debug('Creating local folder', { path: op.details.rawPath });
              yield* fileApi.ensureFolder(op.details.rawPath);
            }
            break;
          case 'writeLocalFile':
            {
              logger.debug('Writing local file', {
                path: op.details.rawPath,
                remoteModifiedAt: op.details.remoteModifiedAt
              });
              const parentPath = getParentPath(op.details.rawPath);
              if (parentPath) {
                yield* fileApi.ensureFolder(parentPath);
              }

              const data = yield* driveApi.downloadFile(op.details.remoteId, signal);
              yield* fileApi.writeFileContent(op.details.rawPath, data, op.details.remoteModifiedAt);
            }
            break;
          case 'deleteLocalFile':
            {
              logger.debug('Deleting local file', { path: op.details.rawPath });
              yield* fileApi.deleteFile(op.details.rawPath);
            }
            break;
          case 'deleteLocalFolder':
            {
              logger.debug('Deleting local folder', { path: op.details.rawPath });
              yield* fileApi.deleteFolder(op.details.rawPath);
            }
            break;
        }

        processedOps += 1;
      }
    });
  }

  #applyPushOperations(
    syncOps: Array<PushSyncOperation>,
    logger: ReturnType<typeof getLogger>,
    driveApi: ReturnType<typeof getProtonDriveApi>,
    fileApi: ReturnType<typeof getObsidianFileApi>,
    signal: AbortSignal
  ): Effect.Effect<
    void,
    | SyncCancelledError
    | GenericProtonDriveError
    | InvalidNameError
    | ItemAlreadyExistsError
    | ProtonApiError
    | ProtonRequestCancelledError
    | PermissionError
    | FileUploadError,
    never
  > {
    return Effect.gen(this, function* () {
      const totalOps = syncOps.length;
      let processedOps = 0;
      const deleteNodeIds: Array<ProtonFileId | ProtonFolderId> = [];

      while (syncOps.length > 0) {
        yield* this.#ensureNotCancelled(signal);

        const op = syncOps.shift();
        if (!op) {
          continue;
        }

        if (op.type === 'deleteFile' || op.type === 'deleteFolder') {
          deleteNodeIds.push(op.details.id);
          continue;
        }

        this.#stateSubject.next({
          state: 'pushing',
          subState: 'applyingChanges',
          totalItems: totalOps,
          processedItems: processedOps++
        });

        switch (op.type) {
          case 'createFolder':
            {
              logger.debug('Creating folder', { name: op.details.name, parentId: op.details.parentId.uid });
              const newRemoteFolder = yield* driveApi.createFolder(op.details.name, op.details.parentId, signal);
              for (const item of syncOps) {
                if ('parentId' in item.details && item.details.parentId.equals(op.details.id)) {
                  item.details.parentId = newRemoteFolder.id;
                }
              }
            }
            break;
          case 'uploadFile':
            {
              logger.debug('Uploading file', { path: op.details.rawPath, modifiedAt: op.details.modifiedAt });
              const data = yield* fileApi.readFileContent(op.details.rawPath);
              const metadata = this.#buildUploadMetadata(
                op.details.rawPath,
                op.details.modifiedAt.getTime(),
                data.byteLength,
                op.details.sha1
              );

              yield* driveApi.uploadFile(op.details.name, data, metadata, op.details.parentId, signal);
            }
            break;
          case 'updateFile':
            {
              logger.debug('Updating file', { path: op.details.rawPath, modifiedAt: op.details.modifiedAt });
              const data = yield* fileApi.readFileContent(op.details.rawPath);
              const metadata = this.#buildUploadMetadata(
                op.details.rawPath,
                op.details.modifiedAt.getTime(),
                data.byteLength,
                op.details.sha1
              );
              yield* driveApi.uploadRevision(op.details.id, data, metadata, signal);
            }
            break;
        }
      }

      if (deleteNodeIds.length > 0) {
        yield* this.#ensureNotCancelled(signal);

        this.#stateSubject.next({
          state: 'pushing',
          subState: 'applyingChanges',
          totalItems: totalOps,
          processedItems: processedOps
        });

        yield* driveApi.trashNodes(deleteNodeIds, signal);
      }
    });
  }

  #computePushPruneOperations(localRoot: VaultFolder, remoteRoot: ProtonRecursiveFolder): Array<PushSyncOperation> {
    const syncOps: Array<PushSyncOperation> = [];

    const q: Array<{ local: VaultFolder; remote: ProtonRecursiveFolder }> = [{ local: localRoot, remote: remoteRoot }];
    while (q.length > 0) {
      const item = q.shift();
      if (!item) {
        continue;
      }

      for (const remoteChild of item.remote.children) {
        if (remoteChild._tag === 'folder') {
          const localFolder = item.local.children.find(
            child => child._type === 'folder' && child.name === remoteChild.name
          ) as VaultFolder | undefined;

          if (!localFolder) {
            syncOps.push({ type: 'deleteFolder', details: { id: remoteChild.id } });
            continue;
          }

          q.push({ local: localFolder, remote: remoteChild });
          continue;
        } else {
          const localFile = item.local.children.find(
            child => child._type === 'file' && child.name === remoteChild.name
          );

          if (!localFile) {
            syncOps.push({ type: 'deleteFile', details: { id: remoteChild.id } });
          }
        }
      }
    }

    return syncOps;
  }

  #computePushCreationOperations(
    localRoot: VaultFolder,
    remoteRoot: ProtonRecursiveFolder,
    logger: ReturnType<typeof getLogger>
  ): Array<PushSyncOperation> {
    const syncOps: Array<PushSyncOperation> = [];

    const q: Array<{ local: VaultFolder; remote: ProtonRecursiveFolder }> = [{ local: localRoot, remote: remoteRoot }];
    while (q.length > 0) {
      const item = q.shift();

      if (!item) {
        continue;
      }

      for (const child of item.local.children) {
        if (this.#isExcluded(child.rawPath)) {
          continue;
        }

        if (child._type === 'folder') {
          let remoteFolder = item.remote.children.find(c => c._tag === 'folder' && c.name === child.name) as
            | ProtonRecursiveFolder
            | undefined;

          if (!remoteFolder) {
            const id = new ProtonFolderId('temp-id-' + Math.random().toString(16).slice(2));
            syncOps.push({ type: 'createFolder', details: { id, name: child.name, parentId: item.remote.id } });

            remoteFolder = {
              id,
              name: child.name,
              parentId: Option.some(item.remote.id),
              treeEventScopeId: new TreeEventScopeId('temp-scope-' + Math.random().toString(16).slice(2)),
              _tag: 'folder',
              children: []
            };

            item.remote.children.push(remoteFolder);
          }

          q.push({ local: child, remote: remoteFolder });
        } else {
          const remoteFile = item.remote.children.find(c => c._tag === 'file' && c.name === child.name) as
            | ProtonFile
            | undefined;

          if (remoteFile && Option.isSome(remoteFile.sha1) && remoteFile.sha1.value === child.sha1) {
            logger.debug('Skipping upload for same file', {
              path: child.rawPath,
              localModifiedAt: child.modifiedAt,
              remoteModifiedAt: remoteFile?.modifiedAt
            });

            continue;
          }

          if (remoteFile) {
            if (remoteFile.modifiedAt.getTime() > child.modifiedAt.getTime()) {
              logger.debug('Remote file is newer than local, skipping update', {
                path: child.rawPath,
                localModifiedAt: child.modifiedAt,
                remoteModifiedAt: remoteFile.modifiedAt
              });

              continue;
            }
            syncOps.push({
              type: 'updateFile',
              details: {
                id: remoteFile.id,
                rawPath: child.rawPath,
                modifiedAt: child.modifiedAt,
                sha1: child.sha1
              }
            });
          } else {
            syncOps.push({
              type: 'uploadFile',
              details: {
                name: child.name,
                rawPath: child.rawPath,
                parentId: item.remote.id,
                modifiedAt: child.modifiedAt,
                sha1: child.sha1
              }
            });
          }
        }
      }
    }

    return syncOps;
  }

  #computePullCreationOperations(
    localRoot: VaultFolder,
    remoteRoot: ProtonRecursiveFolder,
    logger: ReturnType<typeof getLogger>
  ): { localFolderCreatePaths: Set<string>; localFileWrites: Map<string, LocalFileWrite> } {
    const localFolderCreatePaths = new Set<string>();
    const localFileWrites = new Map<string, LocalFileWrite>();

    const q: Array<{ local: VaultFolder; remote: ProtonRecursiveFolder; relativePath: string }> = [
      { local: localRoot, remote: remoteRoot, relativePath: '' }
    ];

    while (q.length > 0) {
      const item = q.shift();
      if (!item) {
        continue;
      }

      const localChildren = item.local.children.filter(child => !this.#isExcluded(child.rawPath));
      const localFoldersByName = new Map<string, VaultFolder>();
      const localFilesByName = new Map<string, (typeof localChildren)[number]>();

      for (const child of localChildren) {
        if (child._type === 'folder') {
          localFoldersByName.set(child.name, child);
        } else {
          localFilesByName.set(child.name, child);
        }
      }

      for (const remoteChild of item.remote.children) {
        const localPath = normalizePath(
          item.relativePath ? `${item.relativePath}/${remoteChild.name}` : remoteChild.name
        );
        if (!localPath) {
          continue;
        }

        if (remoteChild._tag === 'folder') {
          const localFolder = localFoldersByName.get(remoteChild.name);

          if (!localFolder) {
            localFolderCreatePaths.add(localPath);
            q.push({
              local: {
                _type: 'folder',
                name: remoteChild.name,
                rawPath: localPath,
                path: canonicalizePath(localPath),
                children: []
              },
              remote: remoteChild,
              relativePath: localPath
            });
          } else {
            q.push({ local: localFolder, remote: remoteChild, relativePath: localPath });
          }
        } else {
          const localFile = localFilesByName.get(remoteChild.name);

          if (!localFile || localFile._type !== 'file') {
            localFileWrites.set(localPath, {
              rawPath: localPath,
              remoteId: remoteChild.id,
              remoteModifiedAt: remoteChild.modifiedAt
            });
            continue;
          }

          if (Option.isSome(remoteChild.sha1) && remoteChild.sha1.value === localFile.sha1) {
            logger.debug('Local file is identical by SHA1, skipping download', { path: localFile.rawPath });
            continue;
          }

          if (localFile.modifiedAt.getTime() >= remoteChild.modifiedAt.getTime()) {
            logger.debug('Local file is newer than remote, skipping download', {
              path: localFile.rawPath,
              localModifiedAt: localFile.modifiedAt,
              remoteModifiedAt: remoteChild.modifiedAt
            });
          }

          localFileWrites.set(localPath, {
            rawPath: localPath,
            remoteId: remoteChild.id,
            remoteModifiedAt: remoteChild.modifiedAt
          });
        }
      }
    }

    return { localFolderCreatePaths, localFileWrites };
  }

  #computePullPruneOperations(
    localRoot: VaultFolder,
    remoteRoot: ProtonRecursiveFolder,
    prune: boolean
  ): { localFileDeletePaths: Set<string>; localFolderDeletePaths: Set<string> } {
    const localFileDeletePaths = new Set<string>();
    const localFolderDeletePaths = new Set<string>();

    if (!prune) {
      return { localFileDeletePaths, localFolderDeletePaths };
    }

    const q: Array<{ local: VaultFolder; remote: ProtonRecursiveFolder }> = [{ local: localRoot, remote: remoteRoot }];

    while (q.length > 0) {
      const item = q.shift();
      if (!item) {
        continue;
      }

      const localChildren = item.local.children.filter(child => !this.#isExcluded(child.rawPath));
      const localFoldersByName = new Map<string, VaultFolder>();
      const localFilesByName = new Map<string, (typeof localChildren)[number]>();

      for (const child of localChildren) {
        if (child._type === 'folder') {
          localFoldersByName.set(child.name, child);
        } else {
          localFilesByName.set(child.name, child);
        }
      }

      for (const remoteChild of item.remote.children) {
        if (remoteChild._tag === 'folder') {
          const matchingLocalFolder = localFoldersByName.get(remoteChild.name);
          const localFile = localFilesByName.get(remoteChild.name);

          if (localFile && localFile._type === 'file') {
            localFileDeletePaths.add(localFile.rawPath);
          }

          if (matchingLocalFolder) {
            q.push({ local: matchingLocalFolder, remote: remoteChild });
          }

          continue;
        }

        const localFolder = localFoldersByName.get(remoteChild.name);
        if (localFolder) {
          localFolderDeletePaths.add(localFolder.rawPath);
        }
      }

      for (const localChild of localChildren) {
        const remoteMatch = item.remote.children.find(
          remoteChild =>
            remoteChild.name === localChild.name &&
            ((remoteChild._tag === 'folder' && localChild._type === 'folder') ||
              (remoteChild._tag === 'file' && localChild._type === 'file'))
        );

        if (remoteMatch) {
          continue;
        }

        if (localChild._type === 'folder') {
          localFolderDeletePaths.add(localChild.rawPath);
        } else {
          localFileDeletePaths.add(localChild.rawPath);
        }
      }
    }

    return { localFileDeletePaths, localFolderDeletePaths };
  }

  #buildRemoteTree(
    remoteConfigRoot: ProtonFolder,
    signal: AbortSignal
  ): Effect.Effect<
    ProtonRecursiveFolder,
    SyncCancelledError | GenericProtonDriveError | NotAFolderError | ProtonRequestCancelledError,
    never
  > {
    return Effect.gen(this, function* () {
      const driveApi = getProtonDriveApi();

      const root: ProtonRecursiveFolder = {
        ...remoteConfigRoot,
        children: []
      };

      const queue: Array<{ folder: ProtonRecursiveFolder; relativePath: string }> = [
        { folder: root, relativePath: '' }
      ];

      while (queue.length > 0) {
        yield* this.#ensureNotCancelled(signal);

        const current = queue.shift();
        if (!current) {
          continue;
        }

        for (const child of yield* driveApi.getChildren(current.folder.id, signal)) {
          const relativePath = normalizePath(
            current.relativePath ? `${current.relativePath}/${child.name}` : child.name
          );
          if (!relativePath || this.#isExcluded(relativePath)) {
            continue;
          }

          if (child._tag === 'folder') {
            const folderNode: ProtonRecursiveFolder = {
              ...child,
              children: []
            };
            current.folder.children.push(folderNode);
            queue.push({ folder: folderNode, relativePath });
          } else if (child._tag === 'file') {
            current.folder.children.push(child);
          }
        }
      }

      return root;
    });
  }

  #getOrCreateRemoteRoot(
    configDir: string,
    vaultRootId: ProtonFolderId,
    signal?: AbortSignal
  ): Effect.Effect<
    ProtonFolder,
    GenericProtonDriveError | InvalidNameError | ItemAlreadyExistsError | ProtonApiError | ProtonRequestCancelledError
  > {
    return Effect.gen(this, function* () {
      let currentFolder: ProtonFolder = {
        id: vaultRootId,
        name: '',
        _tag: 'folder',
        parentId: Option.none(),
        treeEventScopeId: new TreeEventScopeId('')
      };
      const driveApi = getProtonDriveApi();

      for (const segment of configDir.split('/').filter(Boolean)) {
        const remoteFolder = yield* driveApi.getFolderByName(segment, currentFolder.id, signal);

        if (Option.isSome(remoteFolder)) {
          return remoteFolder.value;
        }

        const created = yield* driveApi.createFolder(segment, currentFolder.id, signal);
        currentFolder = created;
      }

      return currentFolder;
    });
  }

  #buildUploadMetadata(
    relativePath: string,
    modifiedAt: number,
    expectedSize: number,
    expectedSha1: string
  ): UploadMetadata {
    return {
      mediaType: inferMediaType(relativePath),
      expectedSize,
      modificationTime: new Date(modifiedAt),
      expectedSha1
    };
  }

  #isExcluded(relativePath: string): boolean {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return false;
    }

    const canonical = canonicalizePath(normalized);
    const excluded = canonicalizePath(this.vault.configDir + EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH);
    if (canonical.path === excluded.path || canonical.path.startsWith(`${excluded.path}/`)) {
      return true;
    }

    const ignoredPaths = getObsidianSettingsStore().get('ignoredPaths');
    for (const pattern of ignoredPaths) {
      const normalizedPattern = normalizePath(pattern?.trim() ?? '');
      if (!normalizedPattern) {
        continue;
      }

      const canonicalPattern = canonicalizePath(normalizedPattern).path;

      if (picomatch.isMatch(canonical.path, canonicalPattern, { nocase: true, dot: true })) {
        return true;
      }

      if (!hasGlobMeta(canonicalPattern) && canonical.path.startsWith(`${canonicalPattern}/`)) {
        return true;
      }
    }

    return false;
  }

  #withTiming<A, E, R>(
    timingLogger: TimingLogger,
    operationName: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> {
    return Effect.gen(function* () {
      const startedAt = Date.now();
      const result = yield* effect;

      timingLogger.debug(operationName, {
        durationMs: Date.now() - startedAt
      });

      return result;
    });
  }

  #ensureNotCancelled(signal: AbortSignal): Effect.Effect<void, SyncCancelledError> {
    if (signal.aborted) {
      return Effect.fail(new SyncCancelledError({ reason: signal.reason }));
    }

    return Effect.void;
  }
}

function hasGlobMeta(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) {
    return '';
  }

  return normalized.slice(0, idx);
}

function pathDepth(path: string): number {
  const normalized = normalizePath(path);
  if (!normalized) {
    return 0;
  }

  return normalized.split('/').filter(Boolean).length;
}

function inferMediaType(path: string): string {
  const normalized = canonicalizePath(normalizePath(path));

  const index = normalized.path.lastIndexOf('/');
  if (index >= 0) {
    const extension = normalized.path.slice(index + 1);

    if (extension.endsWith('.md')) {
      return 'text/markdown';
    }

    if (extension.endsWith('.json')) {
      return 'application/json';
    }
  }

  return 'application/octet-stream';
}

export type ConfigSyncError =
  | InvalidConfigPathError
  | VaultRootIdNotAvailableError
  | SyncAlreadyInProgressError
  | SyncCancelledError;

export class InvalidConfigPathError extends Data.TaggedError('InvalidConfigPathError') {}
export class VaultRootIdNotAvailableError extends Data.TaggedError('VaultRootIdNotAvailableError') {}
export class SyncAlreadyInProgressError extends Data.TaggedError('SyncAlreadyInProgressError') {}
export class SyncCancelledError extends Data.TaggedError('SyncCancelledError')<{ reason?: unknown }> {}
