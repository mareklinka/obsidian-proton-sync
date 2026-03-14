import { Effect, Option } from 'effect';
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
  ProtonRequestCancelledError
} from './proton-drive-types';
import { ProtonFolderId, TreeEventScopeId } from './proton-drive-types';
import type { ProtonFile } from './ProtonDriveApi';
import { getProtonDriveApi } from './ProtonDriveApi';
import { createRemoteFileStateSnapshot, type RemoteFileStateSnapshot } from './RemoteFileStateSnapshot';
import { SyncAlreadyInProgressError, SyncCancelledError, VaultRootIdNotAvailableError } from './sync/SyncErrors';
import { applyPullOperations, applyPushOperations } from './sync/SyncExecutors';
import { buildRemoteTree, getRemoteRoot } from './sync/SyncTreeBuilder';
import type {
  ConflictActionResolver,
  LocalFileWrite,
  ProtonRecursiveFolder,
  PullCreationPlan,
  PullSyncOperation,
  PushSyncOperation,
  SyncConflictAction,
  SyncConflictResolver,
  SyncState
} from './sync/SyncTypes';
import {
  findConflictingLocalPruneFilePath,
  findConflictingRemotePruneFilePath,
  getSnapshotSha,
  hasGlobMeta,
  pathDepth
} from './sync/SyncUtils';

export {
  type ConfigSyncError,
  InvalidConfigPathError,
  SyncAlreadyInProgressError,
  SyncCancelledError,
  VaultRootIdNotAvailableError
} from './sync/SyncErrors';
export type {
  SyncConflict,
  SyncConflictAction,
  SyncConflictDecision,
  SyncConflictReason,
  SyncConflictResolver,
  SyncState,
  SyncSubstate
} from './sync/SyncTypes';

const EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH = '/plugins/proton-drive-sync';
const SYNC_TIMING_SCOPE = 'timing-metrics';

type TimingLogger = Pick<ReturnType<typeof getLogger>, 'debug'>;

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
    signal: AbortSignal,
    conflictResolver?: SyncConflictResolver
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

      yield* this.#pushImpl(prune, signal, conflictResolver).pipe(
        Effect.catchTag('ProtonRequestCancelledError', error =>
          Effect.fail(new SyncCancelledError({ reason: error.reason }))
        ),
        Effect.tapBoth({ onSuccess: () => idleEffect, onFailure: () => idleEffect })
      );
    });
  }

  public pull(
    prune: boolean,
    signal: AbortSignal,
    conflictResolver?: SyncConflictResolver
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

      yield* this.#pullImpl(prune, signal, conflictResolver).pipe(
        Effect.catchTag('ProtonRequestCancelledError', error =>
          Effect.fail(new SyncCancelledError({ reason: error.reason }))
        ),
        Effect.tapBoth({ onSuccess: () => idleEffect, onFailure: () => idleEffect })
      );
    });
  }

  #pushImpl(
    prune: boolean,
    signal: AbortSignal,
    conflictResolver?: SyncConflictResolver
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
      const resolveConflict = this.#createConflictResolver('push', conflictResolver, logger);
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
          const remoteConfigRootFolder = yield* getRemoteRoot(vaultRootNodeId.value, signal);

          if (Option.isNone(remoteConfigRootFolder)) {
            return yield* new VaultRootIdNotAvailableError();
          }

          return yield* buildRemoteTree(
            remoteConfigRootFolder.value,
            signal,
            this.#isExcluded.bind(this),
            this.#ensureNotCancelled.bind(this)
          );
        })
      );
      yield* this.#ensureNotCancelled(signal);

      const remoteFileStateSnapshot = createRemoteFileStateSnapshot(remoteRoot);

      yield* Effect.gen(this, function* () {
        this.#stateSubject.next({ state: 'pushing', subState: 'diffComputation', totalItems: 0, processedItems: 0 });
        const storedRemoteFileStateSnapshot = getObsidianSettingsStore().getRemoteFileStateSnapshot();

        const syncOps = yield* this.#withTiming(
          timingLogger,
          'Computed push creation operations',
          this.#computePushCreationOperations(
            localRoot,
            remoteRoot,
            storedRemoteFileStateSnapshot,
            logger,
            resolveConflict
          )
        );
        yield* this.#ensureNotCancelled(signal);

        if (prune) {
          const pruneOps = yield* this.#withTiming(
            timingLogger,
            'Computed push prune operations',
            this.#computePushPruneOperations(
              localRoot,
              remoteRoot,
              storedRemoteFileStateSnapshot,
              logger,
              resolveConflict
            )
          );
          syncOps.push(...pruneOps);
          yield* this.#ensureNotCancelled(signal);
        }

        yield* this.#withTiming(
          timingLogger,
          'Applied operations',
          applyPushOperations(
            syncOps,
            logger,
            driveApi,
            fileApi,
            remoteFileStateSnapshot,
            signal,
            this.#ensureNotCancelled.bind(this),
            (processedItems, totalItems) => {
              this.#stateSubject.next({
                state: 'pushing',
                subState: 'applyingChanges',
                totalItems,
                processedItems
              });
            }
          )
        );

        this.setIdleState();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => getObsidianSettingsStore().setRemoteFileStateSnapshot(remoteFileStateSnapshot))
        )
      );
    });
  }

  #pullImpl(
    prune: boolean,
    signal: AbortSignal,
    conflictResolver?: SyncConflictResolver
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
      const resolveConflict = this.#createConflictResolver('pull', conflictResolver, logger);
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
          const remoteConfigRootFolder = yield* getRemoteRoot(vaultRootNodeId.value, signal);

          if (Option.isNone(remoteConfigRootFolder)) {
            return yield* new VaultRootIdNotAvailableError();
          }

          return yield* buildRemoteTree(
            remoteConfigRootFolder.value,
            signal,
            this.#isExcluded.bind(this),
            this.#ensureNotCancelled.bind(this)
          );
        })
      );
      yield* this.#ensureNotCancelled(signal);

      const remoteFileStateSnapshot = createRemoteFileStateSnapshot(remoteRoot);

      yield* Effect.gen(this, function* () {
        this.#stateSubject.next({ state: 'pulling', subState: 'diffComputation', totalItems: 0, processedItems: 0 });
        const storedRemoteFileStateSnapshot = getObsidianSettingsStore().getRemoteFileStateSnapshot();

        const { localFolderCreatePaths, localFileWrites, replacementFileDeletePaths, replacementFolderDeletePaths } =
          yield* this.#withTiming(
            timingLogger,
            'Computed pull creation operations',
            this.#computePullCreationOperations(
              localRoot,
              remoteRoot,
              storedRemoteFileStateSnapshot,
              logger,
              resolveConflict
            )
          );
        yield* this.#ensureNotCancelled(signal);

        const { localFileDeletePaths, localFolderDeletePaths } = yield* this.#withTiming(
          timingLogger,
          'Computed pull prune operations',
          this.#computePullPruneOperations(
            localRoot,
            remoteRoot,
            prune,
            storedRemoteFileStateSnapshot,
            logger,
            resolveConflict
          )
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

        for (const folderPath of Array.from(replacementFolderDeletePaths).sort((a, b) => pathDepth(b) - pathDepth(a))) {
          pullOps.push({ type: 'deleteLocalFolder', details: { rawPath: folderPath } });
        }

        for (const filePath of replacementFileDeletePaths) {
          pullOps.push({ type: 'deleteLocalFile', details: { rawPath: filePath } });
        }

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
          applyPullOperations(
            pullOps,
            logger,
            getProtonDriveApi(),
            fileApi,
            signal,
            this.#ensureNotCancelled.bind(this),
            (processedItems, totalItems) => {
              this.#stateSubject.next({
                state: 'pulling',
                subState: 'applyingChanges',
                totalItems,
                processedItems
              });
            }
          )
        );

        this.setIdleState();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => getObsidianSettingsStore().setRemoteFileStateSnapshot(remoteFileStateSnapshot))
        )
      );
    });
  }

  #computePushPruneOperations(
    localRoot: VaultFolder,
    remoteRoot: ProtonRecursiveFolder,
    storedRemoteFileStateSnapshot: RemoteFileStateSnapshot | null,
    logger: ReturnType<typeof getLogger>,
    resolveConflict: ConflictActionResolver
  ): Effect.Effect<Array<PushSyncOperation>, never, never> {
    return Effect.gen(this, function* () {
      const syncOps: Array<PushSyncOperation> = [];

      const q: Array<{ local: VaultFolder; remote: ProtonRecursiveFolder; relativePath: string }> = [
        { local: localRoot, remote: remoteRoot, relativePath: '' }
      ];
      while (q.length > 0) {
        const item = q.shift();
        if (!item) {
          continue;
        }

        for (const remoteChild of item.remote.children) {
          const remoteChildPath = normalizePath(
            item.relativePath ? `${item.relativePath}/${remoteChild.name}` : remoteChild.name
          );
          if (!remoteChildPath) {
            continue;
          }

          if (remoteChild._tag === 'folder') {
            const localFolder = item.local.children.find(
              child => child._type === 'folder' && child.name === remoteChild.name
            ) as VaultFolder | undefined;

            if (!localFolder) {
              const conflictingRemoteFilePath = findConflictingRemotePruneFilePath(
                remoteChild,
                remoteChildPath,
                storedRemoteFileStateSnapshot
              );

              if (conflictingRemoteFilePath) {
                logger.warn('Detected push conflict while pruning remote folder', {
                  path: remoteChildPath,
                  conflictingPath: conflictingRemoteFilePath
                });
                const action = yield* resolveConflict({
                  reason: 'pruneFolderChanged',
                  path: remoteChildPath,
                  conflictingPath: conflictingRemoteFilePath
                });

                if (action === 'skip') {
                  continue;
                }
              }

              syncOps.push({
                type: 'deleteFolder',
                details: { id: remoteChild.id, rawPath: remoteChildPath, applyMode: 'deferred' }
              });
              continue;
            }

            q.push({ local: localFolder, remote: remoteChild, relativePath: remoteChildPath });
            continue;
          }

          const localFile = item.local.children.find(
            child => child._type === 'file' && child.name === remoteChild.name
          );

          if (!localFile) {
            const remoteSha = Option.isSome(remoteChild.sha1) ? remoteChild.sha1.value : null;
            const snapshotSha = getSnapshotSha(storedRemoteFileStateSnapshot, remoteChildPath);

            if (remoteSha === null || snapshotSha === null || snapshotSha === undefined) {
              logger.warn('Detected push conflict while pruning remote file without a usable snapshot baseline', {
                path: remoteChildPath,
                remoteSha1: remoteSha,
                snapshotSha1: snapshotSha
              });
              const action = yield* resolveConflict({
                reason: 'pruneFileMissingSnapshotBaseline',
                path: remoteChildPath
              });

              if (action === 'skip') {
                continue;
              }
            } else if (remoteSha !== snapshotSha) {
              logger.warn('Detected push conflict while pruning remote file', {
                path: remoteChildPath,
                remoteSha1: remoteSha,
                snapshotSha1: snapshotSha
              });
              const action = yield* resolveConflict({ reason: 'pruneFileChanged', path: remoteChildPath });

              if (action === 'skip') {
                continue;
              }
            }

            syncOps.push({
              type: 'deleteFile',
              details: { id: remoteChild.id, rawPath: remoteChildPath, applyMode: 'deferred' }
            });
          }
        }
      }

      return syncOps;
    });
  }

  #computePushCreationOperations(
    localRoot: VaultFolder,
    remoteRoot: ProtonRecursiveFolder,
    storedRemoteFileStateSnapshot: RemoteFileStateSnapshot | null,
    logger: ReturnType<typeof getLogger>,
    resolveConflict: ConflictActionResolver
  ): Effect.Effect<Array<PushSyncOperation>, never, never> {
    return Effect.gen(this, function* () {
      const syncOps: Array<PushSyncOperation> = [];

      const q: Array<{ local: VaultFolder; remote: ProtonRecursiveFolder }> = [
        { local: localRoot, remote: remoteRoot }
      ];
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
            const remoteFile = item.remote.children.find(c => c._tag === 'file' && c.name === child.name) as
              | ProtonFile
              | undefined;

            if (remoteFile) {
              logger.warn('Detected push conflict due to local folder and remote file type mismatch', {
                path: child.rawPath
              });
              const action = yield* resolveConflict({
                reason: 'localFolderRemoteFileTypeMismatch',
                path: child.rawPath
              });

              if (action === 'skip') {
                continue;
              }

              syncOps.push({
                type: 'deleteFile',
                details: { id: remoteFile.id, rawPath: child.rawPath, applyMode: 'immediate' }
              });
              item.remote.children = item.remote.children.filter(candidate => candidate !== remoteFile);
            }

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
            const remoteFolder = item.remote.children.find(c => c._tag === 'folder' && c.name === child.name) as
              | ProtonRecursiveFolder
              | undefined;

            if (remoteFolder) {
              logger.warn('Detected push conflict due to local file and remote folder type mismatch', {
                path: child.rawPath
              });
              const action = yield* resolveConflict({
                reason: 'localFileRemoteFolderTypeMismatch',
                path: child.rawPath
              });

              if (action === 'skip') {
                continue;
              }

              syncOps.push({
                type: 'deleteFolder',
                details: { id: remoteFolder.id, rawPath: child.rawPath, applyMode: 'immediate' }
              });
              item.remote.children = item.remote.children.filter(candidate => candidate !== remoteFolder);
            }

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
              const remoteSha = Option.isSome(remoteFile.sha1) ? remoteFile.sha1.value : null;
              const snapshotSha = getSnapshotSha(storedRemoteFileStateSnapshot, child.rawPath);

              if (
                remoteSha !== null &&
                snapshotSha !== null &&
                snapshotSha !== undefined &&
                remoteSha === snapshotSha
              ) {
                syncOps.push({
                  type: 'updateFile',
                  details: {
                    id: remoteFile.id,
                    rawPath: child.rawPath,
                    modifiedAt: child.modifiedAt,
                    sha1: child.sha1
                  }
                });
                continue;
              }

              if (remoteSha === null || snapshotSha === null || snapshotSha === undefined) {
                logger.warn('Detected push conflict without a usable remote snapshot baseline', {
                  path: child.rawPath,
                  localSha1: child.sha1,
                  remoteSha1: remoteSha,
                  snapshotSha1: snapshotSha
                });
                const action = yield* resolveConflict({
                  reason: 'missingSnapshotBaseline',
                  path: child.rawPath
                });

                if (action === 'skip') {
                  continue;
                }
              } else {
                logger.warn('Detected push conflict', {
                  path: child.rawPath,
                  localSha1: child.sha1,
                  remoteSha1: remoteSha,
                  snapshotSha1: snapshotSha
                });
                const action = yield* resolveConflict({ reason: 'contentChanged', path: child.rawPath });

                if (action === 'skip') {
                  continue;
                }
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
              continue;
            }

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

      return syncOps;
    });
  }

  #computePullCreationOperations(
    localRoot: VaultFolder,
    remoteRoot: ProtonRecursiveFolder,
    storedRemoteFileStateSnapshot: RemoteFileStateSnapshot | null,
    logger: ReturnType<typeof getLogger>,
    resolveConflict: ConflictActionResolver
  ): Effect.Effect<PullCreationPlan, never, never> {
    return Effect.gen(this, function* () {
      const localFolderCreatePaths = new Set<string>();
      const localFileWrites = new Map<string, LocalFileWrite>();
      const replacementFileDeletePaths = new Set<string>();
      const replacementFolderDeletePaths = new Set<string>();

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
            const localFile = localFilesByName.get(remoteChild.name);

            if (localFile && localFile._type === 'file') {
              logger.warn('Detected pull conflict due to remote folder and local file type mismatch', {
                path: localPath
              });
              const action = yield* resolveConflict({
                reason: 'remoteFolderLocalFileTypeMismatch',
                path: localPath
              });

              if (action === 'skip') {
                continue;
              }

              replacementFileDeletePaths.add(localPath);
            }

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
            const localFolder = localFoldersByName.get(remoteChild.name);

            if (localFolder) {
              logger.warn('Detected pull conflict due to remote file and local folder type mismatch', {
                path: localPath
              });
              const action = yield* resolveConflict({
                reason: 'remoteFileLocalFolderTypeMismatch',
                path: localPath
              });

              if (action === 'skip') {
                continue;
              }

              replacementFolderDeletePaths.add(localPath);
            }

            const localFile = localFilesByName.get(remoteChild.name);

            if (!localFile || localFile._type !== 'file' || replacementFolderDeletePaths.has(localPath)) {
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

            const remoteSha = Option.isSome(remoteChild.sha1) ? remoteChild.sha1.value : null;
            const snapshotSha = getSnapshotSha(storedRemoteFileStateSnapshot, localPath);

            if (remoteSha === null || snapshotSha === null || snapshotSha === undefined) {
              logger.warn('Detected pull conflict without a usable remote snapshot baseline', {
                path: localFile.rawPath,
                localSha1: localFile.sha1,
                remoteSha1: remoteSha,
                snapshotSha1: snapshotSha
              });
              const action = yield* resolveConflict({
                reason: 'missingSnapshotBaseline',
                path: localPath
              });

              if (action === 'skip') {
                continue;
              }
            } else if (localFile.sha1 !== snapshotSha) {
              logger.warn('Detected pull conflict', {
                path: localFile.rawPath,
                localSha1: localFile.sha1,
                remoteSha1: remoteSha,
                snapshotSha1: snapshotSha
              });
              const action = yield* resolveConflict({ reason: 'contentChanged', path: localPath });

              if (action === 'skip') {
                continue;
              }
            }

            localFileWrites.set(localPath, {
              rawPath: localPath,
              remoteId: remoteChild.id,
              remoteModifiedAt: remoteChild.modifiedAt
            });
          }
        }
      }

      return {
        localFolderCreatePaths,
        localFileWrites,
        replacementFileDeletePaths,
        replacementFolderDeletePaths
      };
    });
  }

  #computePullPruneOperations(
    localRoot: VaultFolder,
    remoteRoot: ProtonRecursiveFolder,
    prune: boolean,
    storedRemoteFileStateSnapshot: RemoteFileStateSnapshot | null,
    logger: ReturnType<typeof getLogger>,
    resolveConflict: ConflictActionResolver
  ): Effect.Effect<{ localFileDeletePaths: Set<string>; localFolderDeletePaths: Set<string> }, never, never> {
    return Effect.gen(this, function* () {
      const localFileDeletePaths = new Set<string>();
      const localFolderDeletePaths = new Set<string>();

      if (!prune) {
        return { localFileDeletePaths, localFolderDeletePaths };
      }

      const q: Array<{ local: VaultFolder; remote: ProtonRecursiveFolder }> = [
        { local: localRoot, remote: remoteRoot }
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
          if (remoteChild._tag === 'folder') {
            const matchingLocalFolder = localFoldersByName.get(remoteChild.name);
            const localFile = localFilesByName.get(remoteChild.name);

            if (localFile && localFile._type === 'file') {
              logger.warn('Detected pull conflict due to remote folder and local file type mismatch while pruning', {
                path: localFile.rawPath
              });
              const action = yield* resolveConflict({
                reason: 'pruneRemoteFolderLocalFileTypeMismatch',
                path: localFile.rawPath
              });

              if (action === 'overwrite') {
                localFileDeletePaths.add(localFile.rawPath);
              }
            }

            if (matchingLocalFolder) {
              q.push({ local: matchingLocalFolder, remote: remoteChild });
            }

            continue;
          }

          const localFolder = localFoldersByName.get(remoteChild.name);
          if (localFolder) {
            logger.warn('Detected pull conflict due to remote file and local folder type mismatch while pruning', {
              path: localFolder.rawPath
            });
            const action = yield* resolveConflict({
              reason: 'pruneRemoteFileLocalFolderTypeMismatch',
              path: localFolder.rawPath
            });

            if (action === 'overwrite') {
              localFolderDeletePaths.add(localFolder.rawPath);
            }
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
            const conflictingLocalFilePath = findConflictingLocalPruneFilePath(
              localChild,
              storedRemoteFileStateSnapshot
            );

            if (conflictingLocalFilePath) {
              logger.warn('Detected pull conflict while pruning local folder', {
                path: localChild.rawPath,
                conflictingPath: conflictingLocalFilePath
              });
              const action = yield* resolveConflict({
                reason: 'pruneFolderChanged',
                path: localChild.rawPath,
                conflictingPath: conflictingLocalFilePath
              });

              if (action === 'skip') {
                continue;
              }
            }

            localFolderDeletePaths.add(localChild.rawPath);
          } else {
            const snapshotSha = getSnapshotSha(storedRemoteFileStateSnapshot, localChild.rawPath);

            if (snapshotSha === null || snapshotSha === undefined) {
              logger.warn('Detected pull conflict while pruning local file without a usable snapshot baseline', {
                path: localChild.rawPath,
                localSha1: localChild.sha1,
                snapshotSha1: snapshotSha
              });
              const action = yield* resolveConflict({
                reason: 'pruneFileMissingSnapshotBaseline',
                path: localChild.rawPath
              });

              if (action === 'skip') {
                continue;
              }
            } else if (localChild.sha1 !== snapshotSha) {
              logger.warn('Detected pull conflict while pruning local file', {
                path: localChild.rawPath,
                localSha1: localChild.sha1,
                snapshotSha1: snapshotSha
              });
              const action = yield* resolveConflict({ reason: 'pruneFileChanged', path: localChild.rawPath });

              if (action === 'skip') {
                continue;
              }
            }

            localFileDeletePaths.add(localChild.rawPath);
          }
        }
      }

      return { localFileDeletePaths, localFolderDeletePaths };
    });
  }

  #createConflictResolver(
    direction: 'push' | 'pull',
    conflictResolver: SyncConflictResolver | undefined,
    logger: ReturnType<typeof getLogger>
  ): ConflictActionResolver {
    let rememberedAction: SyncConflictAction | null = null;

    return conflict =>
      Effect.gen(function* () {
        if (rememberedAction) {
          logger.info('Reusing remembered conflict resolution', {
            direction,
            path: conflict.path,
            action: rememberedAction
          });
          return rememberedAction;
        }

        if (!conflictResolver) {
          return 'skip';
        }

        const decision = yield* conflictResolver({ direction, ...conflict });
        if (decision.applyToAll === true) {
          rememberedAction = decision.action;
        }

        return decision.action;
      });
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
