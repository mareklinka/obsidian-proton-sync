import { type UploadMetadata } from '@protontech/drive-sdk';
import { normalizePath, type Vault } from 'obsidian';

import { getBaseName, toCanonicalPathKey } from '../path-utils';
import { BehaviorSubject } from 'rxjs';
import { canonicalizePath, getObsidianFileApi, VaultFolder } from './ObsidianFileApi';
import { Data, Effect, Option } from 'effect';
import { getObsidianSettingsStore } from './ObsidianSettingsStore';
import {
  GenericProtonDriveError,
  InvalidNameError,
  ItemAlreadyExistsError,
  NotAFolderError,
  ProtonFileId,
  ProtonFolderId,
  TreeEventScopeId
} from './proton-drive-types';
import { getProtonDriveApi, ProtonFile, ProtonFolder } from './ProtonDriveApi';
import { getLogger } from './ObsidianSyncLogger';

const EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH = '/plugins/proton-drive-sync';

type ProtonRecursiveFolder = ProtonFolder & {
  children: (ProtonRecursiveFolder | ProtonFile)[];
};

export type SyncSubstate = 'localTreeBuild' | 'remoteTreeBuild' | 'diffComputation' | 'applyingChanges';

export type ConfigSyncState =
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

export const { init: initConfigSyncService, get: getConfigSyncService } = (function () {
  let instance: ConfigSyncService | null = null;

  return {
    init: function initConfigSyncService(vault: Vault): ConfigSyncService {
      return (instance ??= new ConfigSyncService(vault));
    },
    get: function getConfigSyncService(): ConfigSyncService {
      if (!instance) {
        throw new Error('ConfigSyncService has not been initialized. Please call initConfigSyncService first.');
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
}

interface FileUpdate {
  id: ProtonFileId;
  rawPath: string;
  modifiedAt: Date;
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

class ConfigSyncService {
  private readonly stateSubject = new BehaviorSubject<ConfigSyncState>({ state: 'idle' });
  public readonly state$ = this.stateSubject.asObservable();

  constructor(private readonly vault: Vault) {}

  public pushConfig() {
    return Effect.gen(this, function* () {
      if (this.stateSubject.value.state !== 'idle') {
        yield* new SyncAlreadyInProgressError();
      }

      yield* this.pushConfigImpl().pipe(
        Effect.catchAll(error =>
          Effect.gen(this, function* () {
            this.stateSubject.next({ state: 'idle' });
            yield* error;
          })
        )
      );
    });
  }

  private pushConfigImpl() {
    return Effect.gen(this, function* () {
      const logger = getLogger('ConfigSyncService');
      logger.info('Starting config push');

      const configDir = yield* this.validateConfigDir();
      const vaultRootNodeId = getObsidianSettingsStore().getVaultRootNodeUid();

      if (Option.isNone(vaultRootNodeId)) {
        throw new VaultRootIdNotAvailableError();
      }

      this.stateSubject.next({ state: 'pushing', subState: 'localTreeBuild', totalItems: 0, processedItems: 0 });

      const fileApi = getObsidianFileApi();
      const localRoot = yield* fileApi.getConfigFileTree();

      this.stateSubject.next({ state: 'pushing', subState: 'remoteTreeBuild', totalItems: 0, processedItems: 0 });

      const driveApi = getProtonDriveApi();

      const remoteConfigRootFolder = yield* this.getOrCreateRemoteConfigRoot(configDir, vaultRootNodeId.value);
      const remoteRoot = yield* this.scanRemoteConfig(remoteConfigRootFolder);

      this.stateSubject.next({ state: 'pushing', subState: 'diffComputation', totalItems: 0, processedItems: 0 });
      const syncOps: SyncOperation[] = [];

      const q: { local: VaultFolder; remote: ProtonRecursiveFolder }[] = [{ local: localRoot, remote: remoteRoot }];
      while (q.length > 0) {
        const item = q.shift();
        logger.debug('Processing config folder', { localName: item?.local.name, remoteName: item?.remote.name });
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

            if (child.modifiedAt.getTime() - (remoteFile?.modifiedAt.getTime() ?? 0) < 5000) {
              logger.debug('Skipping upload for file with same modified time', { path: child.rawPath });
              continue;
            }

            if (remoteFile) {
              syncOps.push({
                type: 'updateFile',
                details: { id: remoteFile.id, rawPath: child.rawPath, modifiedAt: child.modifiedAt }
              });
            } else {
              syncOps.push({
                type: 'uploadFile',
                details: {
                  name: child.name,
                  rawPath: child.rawPath,
                  parentId: item.remote.id,
                  modifiedAt: child.modifiedAt
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
              const data = yield* fileApi.readConfigFileContent(op.details.rawPath);
              const metadata = this.buildUploadMetadata(
                op.details.rawPath,
                op.details.modifiedAt.getTime(),
                data.byteLength
              );

              yield* driveApi.uploadFile(op.details.name, data, metadata, op.details.parentId);
            }
            break;
          case 'updateFile':
            {
              const data = yield* fileApi.readConfigFileContent(op.details.rawPath);
              const metadata = this.buildUploadMetadata(
                op.details.rawPath,
                op.details.modifiedAt.getTime(),
                data.byteLength
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

  public pullConfig(deleteLocalOrphans = false) {
    return Effect.gen(this, function* () {
      if (this.stateSubject.value.state !== 'idle') {
        yield* new SyncAlreadyInProgressError();
      }

      yield* this.pullConfigImpl(deleteLocalOrphans).pipe(
        Effect.catchAll(error =>
          Effect.gen(this, function* () {
            this.stateSubject.next({ state: 'idle' });
            yield* error;
          })
        )
      );
    });
  }

  private pullConfigImpl(deleteLocalOrphans: boolean) {
    return Effect.gen(this, function* () {
      const logger = getLogger('ConfigSyncService');
      logger.info('Starting config pull', { deleteLocalOrphans });

      const configDir = yield* this.validateConfigDir();
      const vaultRootNodeId = getObsidianSettingsStore().getVaultRootNodeUid();

      if (Option.isNone(vaultRootNodeId)) {
        throw new VaultRootIdNotAvailableError();
      }

      this.stateSubject.next({ state: 'pulling', subState: 'localTreeBuild', totalItems: 0, processedItems: 0 });
      const fileApi = getObsidianFileApi();
      const localRoot = yield* fileApi.getConfigFileTree();

      this.stateSubject.next({ state: 'pulling', subState: 'remoteTreeBuild', totalItems: 0, processedItems: 0 });
      const driveApi = getProtonDriveApi();
      const remoteConfigRootFolder = yield* this.getOrCreateRemoteConfigRoot(configDir, vaultRootNodeId.value);
      const remoteRoot = yield* this.scanRemoteConfig(remoteConfigRootFolder);

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
          const relativePath = normalizePath(
            item.relativePath ? `${item.relativePath}/${remoteChild.name}` : remoteChild.name
          );
          if (!relativePath) {
            continue;
          }

          const localPath = toConfigPath(configDir, relativePath);

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
                relativePath
              });
            } else {
              q.push({ local: localFolder, remote: remoteChild, relativePath });
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

            if (localFile.modifiedAt.getTime() <= remoteChild.modifiedAt.getTime()) {
              localFileWrites.set(localPath, {
                rawPath: localPath,
                remoteId: remoteChild.id,
                remoteModifiedAt: remoteChild.modifiedAt
              });
            }
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
              yield* fileApi.ensureConfigFolder(op.details.rawPath);
            }
            break;
          case 'writeLocalFile':
            {
              const parentPath = getParentPath(op.details.rawPath);
              if (parentPath) {
                yield* fileApi.ensureConfigFolder(parentPath);
              }

              const data = yield* driveApi.downloadFile(op.details.remoteId);
              yield* fileApi.writeConfigFileContent(op.details.rawPath, data);
            }
            break;
          case 'deleteLocalFile':
            {
              yield* fileApi.deleteConfigFile(op.details.rawPath);
            }
            break;
          case 'deleteLocalFolder':
            {
              yield* fileApi.deleteConfigFolder(op.details.rawPath);
            }
            break;
        }

        processedOps += 1;
      }

      this.stateSubject.next({ state: 'idle' });
    });
  }

  private validateConfigDir(): Effect.Effect<string, InvalidConfigPathError> {
    return Effect.sync(() => {
      const configDir = normalizePath(this.vault.configDir ?? '');
      if (!configDir || isAbsolutePath(configDir)) {
        throw new InvalidConfigPathError();
      }

      const segments = configDir.split('/');
      if (segments.some(segment => segment === '..')) {
        throw new InvalidConfigPathError();
      }

      return configDir;
    });
  }

  private scanRemoteConfig(remoteConfigRoot: ProtonFolder) {
    return Effect.gen(this, function* () {
      const driveApi = getProtonDriveApi();

      const walk = (
        parent: ProtonFolder,
        parentRelativePath: string
      ): Effect.Effect<ProtonRecursiveFolder, GenericProtonDriveError | NotAFolderError> => {
        return Effect.gen(this, function* () {
          const result: ProtonRecursiveFolder = {
            ...parent,
            children: []
          };
          for (const child of yield* driveApi.getChildren(parent.id)) {
            const relativePath = normalizePath(parentRelativePath ? `${parentRelativePath}/${child.name}` : child.name);
            if (!relativePath || this.isExcluded(relativePath)) {
              continue;
            }

            if (child._tag === 'folder') {
              result.children.push(yield* walk(child, relativePath));
            } else {
              if (child._tag === 'file') {
                result.children.push(child);
              }
            }
          }

          return result;
        });
      };

      return yield* walk(remoteConfigRoot, '');
    });
  }

  private getOrCreateRemoteConfigRoot(
    configDir: string,
    vaultRootId: ProtonFolderId
  ): Effect.Effect<ProtonFolder, GenericProtonDriveError | InvalidNameError | ItemAlreadyExistsError> {
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

  private buildUploadMetadata(relativePath: string, modifiedAt: number, expectedSize: number): UploadMetadata {
    return {
      mediaType: inferMediaType(relativePath),
      expectedSize,
      modificationTime: new Date(modifiedAt)
    };
  }

  private isExcluded(relativePath: string): boolean {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return false;
    }

    const canonical = canonicalizePath(normalized);
    const excluded = toCanonicalPathKey(this.vault.configDir + EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH);
    return canonical.path === excluded || canonical.path.startsWith(`${excluded}/`);
  }
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[a-z]:\/|[a-z]:\\|\\\\|\/)/i.test(path);
}

function toConfigPath(configDir: string, relativePath: string): string {
  return normalizePath(relativePath ? `${configDir}/${relativePath}` : configDir);
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
  const lower = getBaseName(path).toLowerCase();

  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';

  return 'application/octet-stream';
}

export type ConfigSyncError = InvalidConfigPathError | VaultRootIdNotAvailableError | SyncAlreadyInProgressError;

export class InvalidConfigPathError extends Data.TaggedError('InvalidConfigPathError') {}
export class VaultRootIdNotAvailableError extends Data.TaggedError('VaultRootIdNotAvailableError') {}
export class SyncAlreadyInProgressError extends Data.TaggedError('SyncAlreadyInProgressError') {}
