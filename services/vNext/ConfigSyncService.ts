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
  ProtonFolderId,
  TreeEventScopeId
} from './proton-drive-types';
import { getProtonDriveApi, ProtonFile, ProtonFolder } from './ProtonDriveApi';
import { getLogger } from './ObsidianSyncLogger';

const EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH = '/plugins/proton-drive-sync';

type ProtonRecursiveFolder = ProtonFolder & {
  children: (ProtonRecursiveFolder | ProtonFile)[];
};

export type ConfigSyncState = 'idle' | 'pushing' | 'pulling';

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

class ConfigSyncService {
  private readonly stateSubject = new BehaviorSubject<ConfigSyncState>('idle');
  public readonly state$ = this.stateSubject.asObservable();

  constructor(private readonly vault: Vault) {}

  pushConfig() {
    return Effect.gen(this, function* () {
      this.stateSubject.next('pushing');

      try {
        yield* this.pushConfigImpl();
      } finally {
        this.stateSubject.next('idle');
      }
    });
  }

  private pushConfigImpl() {
    return Effect.gen(this, function* () {
      const logger = getLogger('ConfigSyncService');
      logger.info('Starting config push');

      const driveApi = getProtonDriveApi();
      const fileApi = getObsidianFileApi();

      const configDir = yield* this.validateConfigDir();
      const localRoot = yield* getObsidianFileApi().getConfigFileTree();
      const vaultRootNodeId = getObsidianSettingsStore().getVaultRootNodeUid();

      if (Option.isNone(vaultRootNodeId)) {
        throw new VaultRootIdNotAvailableError();
      }

      const remoteConfigRootFolder = yield* this.getOrCreateRemoteConfigRoot(configDir, vaultRootNodeId.value);
      const remoteRoot = yield* this.scanRemoteConfig(remoteConfigRootFolder);

      // push local nodes to remote
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
              const newRemoteFolder = yield* driveApi.createFolder(child.name, item.remote.id);
              remoteFolder = {
                ...newRemoteFolder,
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

            const data = yield* fileApi.readConfigFileContent(child.rawPath);
            const metadata = this.buildUploadMetadata(child.rawPath, child.modifiedAt.getTime(), data.byteLength);

            if (remoteFile) {
              yield* driveApi.uploadRevision(remoteFile.id, data, metadata);
            } else {
              yield* driveApi.uploadFile(child.name, data, metadata, item.remote.id);
            }
          }
        }
      }
    });
  }

  // async pullConfig(): Promise<ConfigSyncResult> {
  //   this.stateSubject.next('pulling');

  //   try {
  //     return await this.pullConfigImpl();
  //   } finally {
  //     this.stateSubject.next('idle');
  //   }
  // }

  // private async pullConfigImpl(): Promise<ConfigSyncResult> {
  //   const validated = this.validateConfigDir();
  //   if (!validated.ok) {
  //     return createAbortedResult('invalid-config-dir');
  //   }

  //   const remoteRootUid = await this.ensureRemoteConfigRoot(validated.configDir, false);
  //   if (!remoteRootUid) {
  //     return createAbortedResult('remote-empty');
  //   }

  //   const remote = await this.scanRemoteConfig(remoteRootUid);
  //   if (remote.files.size === 0 && remote.folders.size === 0) {
  //     return createAbortedResult('remote-empty');
  //   }

  //   const local = await this.scanLocalConfig(validated.configDir);
  //   const result = createSuccessResult();

  //   await this.ensureLocalFolder(validated.configDir);

  //   for (const [canonicalPath, remoteFolder] of Array.from(remote.folders.entries()).sort(
  //     (a, b) => depth(a[1].path) - depth(b[1].path)
  //   )) {
  //     const relPath = remoteFolder.path;
  //     if (local.files.has(canonicalPath)) {
  //       await this.adapter.remove(this.toAbsoluteConfigPath(validated.configDir, relPath));
  //       local.files.delete(canonicalPath);
  //       result.deletedLocalFiles += 1;
  //     }

  //     await this.ensureLocalFolder(this.toAbsoluteConfigPath(validated.configDir, relPath));
  //     local.folders.set(canonicalPath, relPath);
  //   }

  //   for (const [canonicalPath, remoteFile] of Array.from(remote.files.entries()).sort((a, b) =>
  //     a[0].localeCompare(b[0])
  //   )) {
  //     const relPath = remoteFile.path;
  //     const absolutePath = this.toAbsoluteConfigPath(validated.configDir, relPath);
  //     if (local.folders.has(canonicalPath)) {
  //       await this.adapter.rmdir(absolutePath, true);
  //       local.folders.delete(canonicalPath);
  //       result.deletedLocalFolders += 1;
  //     }

  //     await this.ensureLocalFolder(this.toAbsoluteConfigPath(validated.configDir, getParentPath(relPath)));
  //     const bytes = await this.downloadRemoteFile(remoteFile.uid);
  //     await this.adapter.writeBinary(absolutePath, bytes);
  //     local.files.set(canonicalPath, {
  //       absolutePath,
  //       relativePath: relPath,
  //       modifiedAt: Date.now()
  //     });
  //     result.downloadedFiles += 1;
  //   }

  //   for (const [canonicalPath, localFile] of Array.from(local.files.entries())) {
  //     if (remote.files.has(canonicalPath)) {
  //       continue;
  //     }

  //     await this.adapter.remove(localFile.absolutePath);
  //     local.files.delete(canonicalPath);
  //     result.deletedLocalFiles += 1;
  //   }

  //   const remoteFolderKeys = new Set(Array.from(remote.folders.keys()));
  //   const foldersToDelete = Array.from(local.folders.entries())
  //     .filter(([canonicalPath]) => !remoteFolderKeys.has(canonicalPath))
  //     .map(([, relPath]) => relPath)
  //     .sort((a, b) => depth(b) - depth(a));

  //   for (const relPath of foldersToDelete) {
  //     await this.adapter.rmdir(this.toAbsoluteConfigPath(validated.configDir, relPath), true);
  //     local.folders.delete(toCanonicalPathKey(relPath));
  //     result.deletedLocalFolders += 1;
  //   }

  //   return result;
  // }

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

function inferMediaType(path: string): string {
  const lower = getBaseName(path).toLowerCase();

  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';

  return 'application/octet-stream';
}

export type ConfigSyncError = InvalidConfigPathError | VaultRootIdNotAvailableError;

export class InvalidConfigPathError extends Data.TaggedError('InvalidConfigPathError') {}
export class VaultRootIdNotAvailableError extends Data.TaggedError('VaultRootIdNotAvailableError') {}
