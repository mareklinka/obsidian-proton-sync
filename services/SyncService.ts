import { type UploadMetadata } from '@protontech/drive-sdk';
import { Data, Effect, Option } from 'effect';
import { normalizePath, type Vault } from 'obsidian';
import { BehaviorSubject } from 'rxjs';

import { canonicalizePath, getObsidianFileApi } from './ObsidianFileApi';
import { getObsidianSettingsStore } from './ObsidianSettingsStore';
import { getLogger } from './ObsidianSyncLogger';
import { ProtonFolderId, TreeEventScopeId } from './proton-drive-types';
import { getProtonDriveApi } from './ProtonDriveApi';

import type { VaultFolder } from './ObsidianFileApi';
import type {
  GenericProtonDriveError,
  InvalidNameError,
  ItemAlreadyExistsError,
  ProtonApiError,
  ProtonFileId
} from './proton-drive-types';
import type { ProtonFile, ProtonFolder } from './ProtonDriveApi';

const EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH = '/plugins/proton-drive-sync';

type ProtonRecursiveFolder = ProtonFolder & {
  children: (ProtonRecursiveFolder | ProtonFile)[];
};

export type SyncSubstate = 'localTreeBuild' | 'remoteTreeBuild' | 'diffComputation' | 'applyingChanges';

export type SyncState =
  | { state: 'idle' }
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

export const { init: initSyncService, get: getSyncService } = (function () {
  let instance: SyncService | null = null;

  return {
    init: function initSyncService(vault: Vault): SyncService {
      return (instance ??= new SyncService(vault));
    },
    get: function getSyncService(): SyncService {
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

type SyncOperation =
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
  private readonly logger = getLogger('SyncService');
  private readonly stateSubject = new BehaviorSubject<SyncState>({ state: 'idle' });
  public readonly state$ = this.stateSubject.asObservable();

  constructor(private readonly vault: Vault) {}

  public push() {
    return Effect.gen(this, function* () {
      if (this.stateSubject.value.state !== 'idle') {
        yield* new SyncAlreadyInProgressError();
      }

      yield* this.pushImpl().pipe(
        Effect.catchAll(error =>
          Effect.gen(this, function* () {
            this.stateSubject.next({ state: 'idle' });
            yield* error;
          })
        )
      );
    });
  }

  private pushImpl() {
    return Effect.gen(this, function* () {
      const logger = this.logger.withScope('push');
      logger.info('Starting config push');

      const vaultRootNodeId = getObsidianSettingsStore().getVaultRootNodeUid();

      if (Option.isNone(vaultRootNodeId)) {
        return yield* new VaultRootIdNotAvailableError();
      }

      this.stateSubject.next({ state: 'pushing', subState: 'localTreeBuild', totalItems: 0, processedItems: 0 });

      const fileApi = getObsidianFileApi();
      const localRoot = yield* fileApi.getFileTree();

      this.stateSubject.next({ state: 'pushing', subState: 'remoteTreeBuild', totalItems: 0, processedItems: 0 });

      const driveApi = getProtonDriveApi();

      const remoteConfigRootFolder = yield* this.getOrCreateRemoteRoot('/', vaultRootNodeId.value);
      const remoteRoot = yield* this.buildRemoteTree(remoteConfigRootFolder);

      this.stateSubject.next({ state: 'pushing', subState: 'diffComputation', totalItems: 0, processedItems: 0 });
      const syncOps: SyncOperation[] = [];

      const q: { local: VaultFolder; remote: ProtonRecursiveFolder }[] = [{ local: localRoot, remote: remoteRoot }];
      while (q.length > 0) {
        const item = q.shift();

        if (!item) {
          continue;
        }

        for (const child of item.local.children) {
          if (this.isExcluded(child.rawPath)) {
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
                details: { id: remoteFile.id, rawPath: child.rawPath, modifiedAt: child.modifiedAt, sha1: child.sha1 }
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

      const pruneQ: { local: VaultFolder; remote: ProtonRecursiveFolder }[] = [
        { local: localRoot, remote: remoteRoot }
      ];
      while (pruneQ.length > 0) {
        const item = pruneQ.shift();
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

            pruneQ.push({ local: localFolder, remote: remoteChild });
            continue;
          }

          const localFile = item.local.children.find(
            child => child._type === 'file' && child.name === remoteChild.name
          );

          if (!localFile) {
            syncOps.push({ type: 'deleteFile', details: { id: remoteChild.id } });
          }
        }
      }

      const totalOps = syncOps.length;
      let processedOps = 0;
      const deleteNodeIds: Array<ProtonFileId | ProtonFolderId> = [];

      while (syncOps.length > 0) {
        const op = syncOps.shift();
        if (!op) {
          continue;
        }

        if (op.type === 'deleteFile' || op.type === 'deleteFolder') {
          deleteNodeIds.push(op.details.id);
          continue;
        }

        this.stateSubject.next({
          state: 'pushing',
          subState: 'applyingChanges',
          totalItems: totalOps,
          processedItems: processedOps++
        });

        switch (op.type) {
          case 'createFolder':
            {
              logger.debug('Creating folder', { name: op.details.name, parentId: op.details.parentId.uid });
              const newRemoteFolder = yield* driveApi.createFolder(op.details.name, op.details.parentId);
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
              const data = yield* fileApi.readConfigFileContent(op.details.rawPath);
              const metadata = this.buildUploadMetadata(
                op.details.rawPath,
                op.details.modifiedAt.getTime(),
                data.byteLength,
                op.details.sha1
              );

              yield* driveApi.uploadFile(op.details.name, data, metadata, op.details.parentId);
            }
            break;
          case 'updateFile':
            {
              logger.debug('Updating file', { path: op.details.rawPath, modifiedAt: op.details.modifiedAt });
              const data = yield* fileApi.readConfigFileContent(op.details.rawPath);
              const metadata = this.buildUploadMetadata(
                op.details.rawPath,
                op.details.modifiedAt.getTime(),
                data.byteLength,
                op.details.sha1
              );
              yield* driveApi.uploadRevision(op.details.id, data, metadata);
            }
            break;
        }
      }

      if (deleteNodeIds.length > 0) {
        this.stateSubject.next({
          state: 'pushing',
          subState: 'applyingChanges',
          totalItems: totalOps,
          processedItems: processedOps
        });

        yield* driveApi.trashNodes(deleteNodeIds);
        processedOps += deleteNodeIds.length;
      }

      this.stateSubject.next({ state: 'idle' });
    });
  }

  public pull(deleteLocalOrphans = false) {
    return Effect.gen(this, function* () {
      if (this.stateSubject.value.state !== 'idle') {
        yield* new SyncAlreadyInProgressError();
      }

      yield* this.pullImpl(deleteLocalOrphans).pipe(
        Effect.catchAll(error =>
          Effect.gen(this, function* () {
            this.stateSubject.next({ state: 'idle' });
            yield* error;
          })
        )
      );
    });
  }

  private pullImpl(deleteLocalOrphans: boolean) {
    return Effect.gen(this, function* () {
      const logger = this.logger.withScope('pull');
      logger.info('Starting config pull', { deleteLocalOrphans });

      const vaultRootNodeId = getObsidianSettingsStore().getVaultRootNodeUid();

      if (Option.isNone(vaultRootNodeId)) {
        return yield* new VaultRootIdNotAvailableError();
      }

      this.stateSubject.next({ state: 'pulling', subState: 'localTreeBuild', totalItems: 0, processedItems: 0 });
      const fileApi = getObsidianFileApi();
      const localRoot = yield* fileApi.getFileTree();

      this.stateSubject.next({ state: 'pulling', subState: 'remoteTreeBuild', totalItems: 0, processedItems: 0 });
      const driveApi = getProtonDriveApi();
      const remoteConfigRootFolder = yield* this.getOrCreateRemoteRoot('/', vaultRootNodeId.value);
      const remoteRoot = yield* this.buildRemoteTree(remoteConfigRootFolder);

      this.stateSubject.next({ state: 'pulling', subState: 'diffComputation', totalItems: 0, processedItems: 0 });

      const localFolderCreatePaths = new Set<string>();
      const localFileWrites = new Map<string, LocalFileWrite>();
      const localFileDeletePaths = new Set<string>();
      const localFolderDeletePaths = new Set<string>();

      const q: { local: VaultFolder; remote: ProtonRecursiveFolder; relativePath: string }[] = [
        { local: localRoot, remote: remoteRoot, relativePath: '' }
      ];

      while (q.length > 0) {
        const item = q.shift();
        if (!item) {
          continue;
        }

        const localChildren = item.local.children.filter(child => !this.isExcluded(child.rawPath));
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
            const localFile = localFilesByName.get(remoteChild.name);

            if (localFile && localFile._type === 'file') {
              localFileDeletePaths.add(localFile.rawPath);
            }

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
            const localFile = localFilesByName.get(remoteChild.name);

            if (localFolder) {
              localFolderDeletePaths.add(localFolder.rawPath);
            }

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

        if (deleteLocalOrphans) {
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
      }

      const keptFolderDeletes: string[] = [];
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

      const pullOps: PullSyncOperation[] = [];

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

      const totalOps = pullOps.length;
      let processedOps = 0;

      for (const op of pullOps) {
        this.stateSubject.next({
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

              const data = yield* driveApi.downloadFile(op.details.remoteId);
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

      this.stateSubject.next({ state: 'idle' });
    });
  }

  private buildRemoteTree(remoteConfigRoot: ProtonFolder) {
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
        const current = queue.shift();
        if (!current) {
          continue;
        }

        for (const child of yield* driveApi.getChildren(current.folder.id)) {
          const relativePath = normalizePath(
            current.relativePath ? `${current.relativePath}/${child.name}` : child.name
          );
          if (!relativePath || this.isExcluded(relativePath)) {
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

  private getOrCreateRemoteRoot(
    configDir: string,
    vaultRootId: ProtonFolderId
  ): Effect.Effect<ProtonFolder, GenericProtonDriveError | InvalidNameError | ItemAlreadyExistsError | ProtonApiError> {
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
        const remoteFolder = yield* driveApi.getFolderByName(segment, currentFolder.id);

        if (Option.isSome(remoteFolder)) {
          return remoteFolder.value;
        }

        const created = yield* driveApi.createFolder(segment, currentFolder.id);
        currentFolder = created;
      }

      return currentFolder;
    });
  }

  private buildUploadMetadata(
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

  private isExcluded(relativePath: string): boolean {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return false;
    }

    const canonical = canonicalizePath(normalized);
    const excluded = canonicalizePath(this.vault.configDir + EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH);
    return canonical.path === excluded.path || canonical.path.startsWith(`${excluded.path}/`);
  }
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

export type ConfigSyncError = InvalidConfigPathError | VaultRootIdNotAvailableError | SyncAlreadyInProgressError;

export class InvalidConfigPathError extends Data.TaggedError('InvalidConfigPathError') {}
export class VaultRootIdNotAvailableError extends Data.TaggedError('VaultRootIdNotAvailableError') {}
export class SyncAlreadyInProgressError extends Data.TaggedError('SyncAlreadyInProgressError') {}
