import { normalizePath, TFile, TFolder, Vault } from 'obsidian';
import { Effect, Option } from 'effect';
import { UnknownException } from 'effect/Cause';

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
    return Effect.sync(() => {
      const vaultRoot = this.vault.getRoot();

      const buildFolderNode = (folder: TFolder): VaultFolder => {
        const children: VaultNode[] = [];
        for (const child of folder.children) {
          if (child instanceof TFile) {
            children.push(toVaultFile(child));
          } else if (child instanceof TFolder) {
            children.push(buildFolderNode(child));
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

      return buildFolderNode(vaultRoot);
    });
  }

  public getConfigFileTree(): Effect.Effect<VaultFolder> {
    return Effect.promise(async () => {
      const configDir = normalizePath(this.vault.configDir);

      const walk = async (path: string): Promise<VaultFolder> => {
        const children: VaultNode[] = [];

        const listed = await this.vault.adapter.list(path);

        for (const filePath of listed.files) {
          const normalized = normalizePath(filePath);
          const canonical = canonicalizePath(normalized);
          const stats = await this.vault.adapter.stat(filePath);

          children.push({
            _type: 'file',
            name: filePath.split('/').pop() ?? filePath,
            rawPath: filePath,
            path: canonical,
            createdAt: stats ? new Date(stats.ctime) : new Date(),
            modifiedAt: stats ? new Date(stats.mtime) : new Date()
          });
        }

        for (const folderPath of listed.folders) {
          const normalized = normalizePath(folderPath);

          children.push(await walk(normalized));
        }

        return {
          _type: 'folder',
          name: path.split('/').pop() ?? path,
          rawPath: path,
          path: canonicalizePath(path),
          children: children
        };
      };

      return await walk(configDir);
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

export function toVaultFile(file: TFile): VaultFile {
  return {
    _type: 'file',
    name: file.name,
    rawPath: file.path,
    path: canonicalizePath(file.path),
    createdAt: new Date(file.stat.ctime),
    modifiedAt: new Date(file.stat.mtime)
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
