import { sha1 } from '@noble/hashes/legacy.js';
import { Effect, Option } from 'effect';
import { normalizePath, TFile, TFolder } from 'obsidian';

import { getLogger } from './ObsidianSyncLogger';

import type { Vault } from 'obsidian';

export const { init: initObsidianFileApi, get: getObsidianFileApi } = (function () {
  let instance: ObsidianFileApi | null = null;

  return {
    init: function initObsidianFileApi(vault: Vault): ObsidianFileApi {
      return (instance ??= new ObsidianFileApi(vault));
    },
    get: function getObsidianFileApi(): ObsidianFileApi {
      if (!instance) {
        throw new Error('ObsidianFileApi has not been initialized. Please call initObsidianFileApi first.');
      }
      return instance;
    }
  };
})();

class ObsidianFileApi {
  public constructor(private readonly vault: Vault) {}

  public getVaultFileTree(): Effect.Effect<VaultFolder> {
    return Effect.promise(async () => {
      const vaultRoot = this.vault.getRoot();

      const buildFolderNode = async (folder: TFolder): Promise<VaultFolder> => {
        const children: VaultNode[] = [];
        for (const child of folder.children) {
          if (child instanceof TFile) {
            children.push(await toVaultFile(this.vault.adapter, child));
          } else if (child instanceof TFolder) {
            children.push(await buildFolderNode(child));
          }
        }

        return {
          _type: 'folder',
          name: folder.name,
          rawPath: folder.path,
          path: canonicalizePath(folder.path),
          children
        };
      };

      return await buildFolderNode(vaultRoot);
    });
  }

  public getFileTree(): Effect.Effect<VaultFolder> {
    return Effect.promise(async () => {
      const rootDir = '/';
      const root: VaultFolder = {
        _type: 'folder',
        name: rootDir.split('/').pop() ?? rootDir,
        rawPath: rootDir,
        path: canonicalizePath(rootDir),
        children: []
      };

      const queue: Array<{ path: string; folder: VaultFolder }> = [{ path: rootDir, folder: root }];

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
          continue;
        }

        const children = await this.vault.adapter.list(current.path);

        for (const filePath of children.files) {
          const normalized = normalizePath(filePath);
          const canonical = canonicalizePath(normalized);
          const stats = await this.vault.adapter.stat(filePath);

          current.folder.children.push({
            _type: 'file',
            name: filePath.split('/').pop() ?? filePath,
            rawPath: filePath,
            path: canonical,
            createdAt: stats ? new Date(stats.ctime) : new Date(),
            modifiedAt: stats ? new Date(stats.mtime) : new Date(),
            sha1: await hashFileContent(this.vault.adapter, filePath)
          });
        }

        for (const folderPath of children.folders) {
          const normalized = normalizePath(folderPath);
          const folderNode: VaultFolder = {
            _type: 'folder',
            name: normalized.split('/').pop() ?? normalized,
            rawPath: normalized,
            path: canonicalizePath(normalized),
            children: []
          };

          current.folder.children.push(folderNode);
          queue.push({ path: normalized, folder: folderNode });
        }
      }

      return root;
    });
  }

  public readFileContent(path: CanonicalPath): Effect.Effect<Option.Option<ArrayBuffer>> {
    return Effect.promise(async () => {
      const file = this.vault.getFileByPath(path.path);

      if (!file) {
        return Option.none();
      }

      const content = await this.vault.readBinary(file);

      return Option.some(content);
    });
  }

  public readConfigFileContent(path: string): Effect.Effect<ArrayBuffer> {
    return Effect.promise(async () => await this.vault.adapter.readBinary(path));
  }

  public ensureFolder(path: string): Effect.Effect<void> {
    return Effect.promise(async () => {
      const normalized = normalizePath(path);
      if (!normalized) {
        return;
      }

      const segments = normalized.split('/').filter(Boolean);
      let current = '';

      for (const segment of segments) {
        current = current ? `${current}/${segment}` : segment;
        const exists = await this.vault.adapter.exists(current);
        if (!exists) {
          await this.vault.adapter.mkdir(current);
        }
      }
    });
  }

  public writeFileContent(path: string, data: ArrayBuffer, modifiedAt: Date): Effect.Effect<void> {
    return Effect.promise(async () => {
      await this.vault.adapter.writeBinary(path, data, { mtime: modifiedAt.getTime() });
    });
  }

  public deleteFile(path: string): Effect.Effect<void> {
    return Effect.promise(async () => {
      const exists = await this.vault.adapter.exists(path);
      if (!exists) {
        return;
      }

      await this.vault.adapter.remove(path);
    });
  }

  public deleteFolder(path: string): Effect.Effect<void> {
    return Effect.promise(async () => {
      const exists = await this.vault.adapter.exists(path);
      if (!exists) {
        return;
      }

      await this.vault.adapter.rmdir(path, true);
    });
  }
}

export function canonicalizePath(path: string): CanonicalPath {
  const cleaned = path
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLocaleLowerCase();

  return new CanonicalPath(cleaned);
}

export async function toVaultFile(adapter: Vault['adapter'], file: TFile): Promise<VaultFile> {
  return {
    _type: 'file',
    name: file.name,
    rawPath: file.path,
    path: canonicalizePath(file.path),
    createdAt: new Date(file.stat.ctime),
    modifiedAt: new Date(file.stat.mtime),
    sha1: await hashFileContent(adapter, file.path)
  };
}

export function toVaultFolder(folder: TFolder): VaultFolder {
  return {
    _type: 'folder',
    name: folder.name,
    rawPath: folder.path,
    path: canonicalizePath(folder.path),
    children: []
  };
}

export type VaultNode = VaultFile | VaultFolder;

export interface VaultFile {
  _type: 'file';
  name: string;
  rawPath: string;
  path: CanonicalPath;
  createdAt: Date;
  modifiedAt: Date;
  sha1: string;
}

export interface VaultFolder {
  _type: 'folder';
  name: string;
  rawPath: string;
  path: CanonicalPath;
  children: VaultNode[];
}

export class CanonicalPath {
  public constructor(public readonly path: string) {}

  public equals(other: CanonicalPath): boolean {
    return this.path === other.path;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

async function hashFileContent(adapter: Vault['adapter'], path: string): Promise<string> {
  const logger = getLogger('ObsidianFileApi');
  const now = Date.now();

  const fileBytes = new Uint8Array(await adapter.readBinary(path));
  const hash = bytesToHex(sha1(fileBytes));

  logger.debug('Hashed file content', { path, hash, durationMs: Date.now() - now });

  return hash;
}
