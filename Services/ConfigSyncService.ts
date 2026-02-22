import {
  NodeType,
  type FileDownloader,
  type FileUploader,
  type MaybeNode,
  type ProtonDriveClient,
  type UploadMetadata
} from '@protontech/drive-sdk';
import type { Vault } from 'obsidian';

import { getBaseName, getParentPath, normalizePath, toCanonicalPathKey } from './path-utils';
import { BehaviorSubject } from 'rxjs';

const EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH = 'plugins/proton-drive-sync';

type AdapterListResult = {
  files: string[];
  folders: string[];
};

type VaultAdapter = {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<AdapterListResult>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive?: boolean): Promise<void>;
  stat(path: string): Promise<{ mtime: number } | null>;
};

type RemoteFileEntry = {
  uid: string;
  modifiedAt: number;
};

type ScannedLocalConfig = {
  files: Map<string, { absolutePath: string; relativePath: string; modifiedAt: number }>;
  folders: Map<string, string>;
};

type ScannedRemoteConfig = {
  files: Map<string, RemoteFileEntry & { path: string }>;
  folders: Map<string, { uid: string; path: string }>;
};

export type ConfigSyncAbortReason = 'invalid-config-dir' | 'remote-empty';

export type ConfigSyncResult = {
  status: 'success' | 'aborted';
  reason?: ConfigSyncAbortReason;
  uploadedFiles: number;
  downloadedFiles: number;
  deletedRemoteFiles: number;
  deletedRemoteFolders: number;
  deletedLocalFiles: number;
  deletedLocalFolders: number;
};

export type ConfigSyncState = 'idle' | 'pushing' | 'pulling';

export class ConfigSyncService {
  private readonly adapter: VaultAdapter;

  private readonly stateSubject = new BehaviorSubject<ConfigSyncState>('idle');
  public readonly state$ = this.stateSubject.asObservable();

  constructor(
    private readonly vault: Vault,
    private readonly driveClient: ProtonDriveClient,
    private readonly vaultRootNodeUid: string
  ) {
    this.adapter = this.vault.adapter as unknown as VaultAdapter;
  }

  async pushConfig(): Promise<ConfigSyncResult> {
    this.stateSubject.next('pushing');

    try {
      return await this.pushConfigImpl();
    } finally {
      this.stateSubject.next('idle');
    }
  }

  private async pushConfigImpl(): Promise<ConfigSyncResult> {
    const validated = this.validateConfigDir();
    if (!validated.ok) {
      return createAbortedResult('invalid-config-dir');
    }

    const local = await this.scanLocalConfig(validated.configDir);
    const remoteRootUid = await this.ensureRemoteConfigRoot(validated.configDir, true);
    const remote = await this.scanRemoteConfig(remoteRootUid);

    const result = createSuccessResult();

    for (const relPath of Array.from(local.folders.values()).sort((a, b) => depth(a) - depth(b))) {
      await this.ensureRemoteFolderByRelativePath(relPath, remoteRootUid, remote);
    }

    for (const [canonicalPath, localFile] of Array.from(local.files.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const relPath = localFile.relativePath;
      if (remote.folders.has(canonicalPath)) {
        const folder = remote.folders.get(canonicalPath);
        if (folder) {
          await this.deleteRemoteNode(folder.uid);
          this.removeRemoteFolderSubtree(remote, relPath);
          result.deletedRemoteFolders += 1;
        }
      }

      const parentUid = await this.ensureRemoteFolderByRelativePath(getParentPath(relPath), remoteRootUid, remote);

      const existing = remote.files.get(canonicalPath);

      if (existing) {
        await this.uploadRevision(existing.uid, localFile.absolutePath, relPath, localFile.modifiedAt);
      } else {
        const createdUid = await this.uploadCreate(parentUid, relPath, localFile.absolutePath, localFile.modifiedAt);
        remote.files.set(canonicalPath, {
          uid: createdUid,
          modifiedAt: localFile.modifiedAt,
          path: relPath
        });
      }

      result.uploadedFiles += 1;
    }

    const localFileKeys = new Set(Array.from(local.files.keys()));
    for (const [canonicalPath, remoteFile] of Array.from(remote.files.entries())) {
      if (localFileKeys.has(canonicalPath)) {
        continue;
      }

      await this.deleteRemoteNode(remoteFile.uid);
      remote.files.delete(canonicalPath);
      result.deletedRemoteFiles += 1;
    }

    const localFolderKeys = new Set(Array.from(local.folders.keys()));
    const remoteFolderEntries = Array.from(remote.folders.entries()).sort((a, b) => depth(b[0]) - depth(a[0]));
    for (const [canonicalPath, folder] of remoteFolderEntries) {
      if (localFolderKeys.has(canonicalPath)) {
        continue;
      }

      await this.deleteRemoteNode(folder.uid);
      remote.folders.delete(canonicalPath);
      result.deletedRemoteFolders += 1;
    }

    return result;
  }

  async pullConfig(): Promise<ConfigSyncResult> {
    this.stateSubject.next('pulling');

    try {
      return await this.pullConfigImpl();
    } finally {
      this.stateSubject.next('idle');
    }
  }

  private async pullConfigImpl(): Promise<ConfigSyncResult> {
    const validated = this.validateConfigDir();
    if (!validated.ok) {
      return createAbortedResult('invalid-config-dir');
    }

    const remoteRootUid = await this.ensureRemoteConfigRoot(validated.configDir, false);
    if (!remoteRootUid) {
      return createAbortedResult('remote-empty');
    }

    const remote = await this.scanRemoteConfig(remoteRootUid);
    if (remote.files.size === 0 && remote.folders.size === 0) {
      return createAbortedResult('remote-empty');
    }

    const local = await this.scanLocalConfig(validated.configDir);
    const result = createSuccessResult();

    await this.ensureLocalFolder(validated.configDir);

    for (const [canonicalPath, remoteFolder] of Array.from(remote.folders.entries()).sort(
      (a, b) => depth(a[1].path) - depth(b[1].path)
    )) {
      const relPath = remoteFolder.path;
      if (local.files.has(canonicalPath)) {
        await this.adapter.remove(this.toAbsoluteConfigPath(validated.configDir, relPath));
        local.files.delete(canonicalPath);
        result.deletedLocalFiles += 1;
      }

      await this.ensureLocalFolder(this.toAbsoluteConfigPath(validated.configDir, relPath));
      local.folders.set(canonicalPath, relPath);
    }

    for (const [canonicalPath, remoteFile] of Array.from(remote.files.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const relPath = remoteFile.path;
      const absolutePath = this.toAbsoluteConfigPath(validated.configDir, relPath);
      if (local.folders.has(canonicalPath)) {
        await this.adapter.rmdir(absolutePath, true);
        local.folders.delete(canonicalPath);
        result.deletedLocalFolders += 1;
      }

      await this.ensureLocalFolder(this.toAbsoluteConfigPath(validated.configDir, getParentPath(relPath)));
      const bytes = await this.downloadRemoteFile(remoteFile.uid);
      await this.adapter.writeBinary(absolutePath, bytes);
      local.files.set(canonicalPath, {
        absolutePath,
        relativePath: relPath,
        modifiedAt: Date.now()
      });
      result.downloadedFiles += 1;
    }

    for (const [canonicalPath, localFile] of Array.from(local.files.entries())) {
      if (remote.files.has(canonicalPath)) {
        continue;
      }

      await this.adapter.remove(localFile.absolutePath);
      local.files.delete(canonicalPath);
      result.deletedLocalFiles += 1;
    }

    const remoteFolderKeys = new Set(Array.from(remote.folders.keys()));
    const foldersToDelete = Array.from(local.folders.entries())
      .filter(([canonicalPath]) => !remoteFolderKeys.has(canonicalPath))
      .map(([, relPath]) => relPath)
      .sort((a, b) => depth(b) - depth(a));

    for (const relPath of foldersToDelete) {
      await this.adapter.rmdir(this.toAbsoluteConfigPath(validated.configDir, relPath), true);
      local.folders.delete(toCanonicalPathKey(relPath));
      result.deletedLocalFolders += 1;
    }

    return result;
  }

  private validateConfigDir(): { ok: true; configDir: string } | { ok: false } {
    const configDir = normalizePath(this.vault.configDir ?? '');
    if (!configDir || isAbsolutePath(configDir)) {
      return { ok: false };
    }

    const segments = configDir.split('/');
    if (segments.some(segment => segment === '..')) {
      return { ok: false };
    }

    return {
      ok: true,
      configDir
    };
  }

  private async scanLocalConfig(configDir: string): Promise<ScannedLocalConfig> {
    const files = new Map<string, { absolutePath: string; relativePath: string; modifiedAt: number }>();
    const folders = new Map<string, string>();

    const rootExists = await this.adapter.exists(configDir);
    if (!rootExists) {
      return { files, folders };
    }

    const walk = async (absoluteFolderPath: string): Promise<void> => {
      const listed = await this.adapter.list(absoluteFolderPath);

      for (const folderPath of listed.folders) {
        const relative = this.toRelativeConfigPath(configDir, folderPath);
        if (relative === null || this.isExcluded(relative)) {
          continue;
        }

        const canonicalRelative = toCanonicalPathKey(relative);
        if (canonicalRelative) {
          folders.set(canonicalRelative, relative);
        }

        await walk(folderPath);
      }

      for (const filePath of listed.files) {
        const relative = this.toRelativeConfigPath(configDir, filePath);
        if (relative === null || this.isExcluded(relative)) {
          continue;
        }

        const stat = await this.adapter.stat(filePath).catch(() => null);
        files.set(toCanonicalPathKey(relative), {
          absolutePath: filePath,
          relativePath: relative,
          modifiedAt: stat?.mtime ?? Date.now()
        });
      }
    };

    await walk(configDir);

    return { files, folders };
  }

  private async scanRemoteConfig(remoteConfigRootUid: string): Promise<ScannedRemoteConfig> {
    const files = new Map<string, RemoteFileEntry & { path: string }>();
    const folders = new Map<string, { uid: string; path: string }>();

    const walk = async (parentUid: string, parentRelativePath: string): Promise<void> => {
      for await (const child of this.driveClient.iterateFolderChildren(parentUid)) {
        if (!child.ok) {
          continue;
        }

        const relativePath = normalizePath(
          parentRelativePath ? `${parentRelativePath}/${child.value.name}` : child.value.name
        );
        if (!relativePath || this.isExcluded(relativePath)) {
          continue;
        }

        if (child.value.type === NodeType.Folder) {
          const canonicalPath = toCanonicalPathKey(relativePath);
          folders.set(canonicalPath, {
            uid: child.value.uid,
            path: relativePath
          });
          await walk(child.value.uid, relativePath);
          continue;
        }

        if (child.value.type === NodeType.File) {
          const canonicalPath = toCanonicalPathKey(relativePath);
          files.set(canonicalPath, {
            uid: child.value.uid,
            modifiedAt:
              child.value.activeRevision?.claimedModificationTime?.getTime() ?? child.value.modificationTime.getTime(),
            path: relativePath
          });
        }
      }
    };

    await walk(remoteConfigRootUid, '');

    return { files, folders };
  }

  private async ensureRemoteConfigRoot(configDir: string, createMissing: true): Promise<string>;
  private async ensureRemoteConfigRoot(configDir: string, createMissing: false): Promise<string | null>;
  private async ensureRemoteConfigRoot(configDir: string, createMissing: boolean): Promise<string | null> {
    let currentUid = this.vaultRootNodeUid;

    for (const segment of configDir.split('/').filter(Boolean)) {
      const existingChild = await this.findDirectChildByName(currentUid, segment);
      if (existingChild?.type === NodeType.Folder) {
        currentUid = existingChild.uid;
        continue;
      }

      if (!existingChild && !createMissing) {
        return null;
      }

      if (existingChild) {
        if (!createMissing) {
          return null;
        }

        await this.deleteRemoteNode(existingChild.uid);
      }

      const created = await this.driveClient.createFolder(currentUid, segment);
      const folder = this.requireFolderNode(created, `Failed to create remote config folder: ${segment}`);
      currentUid = folder.uid;
    }

    return currentUid;
  }

  private async ensureRemoteFolderByRelativePath(
    relativePath: string,
    remoteConfigRootUid: string,
    remote: ScannedRemoteConfig
  ): Promise<string> {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return remoteConfigRootUid;
    }

    const canonical = toCanonicalPathKey(normalized);
    const cached = remote.folders.get(canonical);
    if (cached) {
      return cached.uid;
    }

    const parentPath = getParentPath(normalized);
    const parentUid = await this.ensureRemoteFolderByRelativePath(parentPath, remoteConfigRootUid, remote);

    const existing = await this.findDirectChildByName(parentUid, getBaseName(normalized));
    if (existing?.type === NodeType.Folder) {
      remote.folders.set(canonical, {
        uid: existing.uid,
        path: normalized
      });
      return existing.uid;
    }

    if (existing?.type === NodeType.File) {
      await this.deleteRemoteNode(existing.uid);
      remote.files.delete(canonical);
    }

    const created = await this.driveClient.createFolder(parentUid, getBaseName(normalized));
    const folder = this.requireFolderNode(created, `Failed to create remote folder: ${normalized}`);
    remote.folders.set(canonical, {
      uid: folder.uid,
      path: normalized
    });
    return folder.uid;
  }

  private async uploadCreate(
    parentUid: string,
    relativePath: string,
    localAbsolutePath: string,
    modifiedAt: number
  ): Promise<string> {
    const bytes = await this.adapter.readBinary(localAbsolutePath);
    const metadata = this.buildUploadMetadata(relativePath, modifiedAt, bytes.byteLength);
    const uploader = await this.driveClient.getFileUploader(parentUid, getBaseName(relativePath), metadata);
    const completion = await this.uploadWithUploader(uploader, bytes);
    return completion.nodeUid;
  }

  private async uploadRevision(
    nodeUid: string,
    localAbsolutePath: string,
    relativePath: string,
    modifiedAt: number
  ): Promise<void> {
    const bytes = await this.adapter.readBinary(localAbsolutePath);
    const metadata = this.buildUploadMetadata(relativePath, modifiedAt, bytes.byteLength);
    const uploader = await this.driveClient.getFileRevisionUploader(nodeUid, metadata);
    await this.uploadWithUploader(uploader, bytes);
  }

  private async uploadWithUploader(
    uploader: FileUploader,
    bytes: ArrayBuffer
  ): Promise<{ nodeUid: string; nodeRevisionUid: string }> {
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      }
    });

    const uploadController = await uploader.uploadFromStream(stream, []);
    return uploadController.completion();
  }

  private async downloadRemoteFile(nodeUid: string): Promise<ArrayBuffer> {
    const downloader = await this.driveClient.getFileDownloader(nodeUid);
    return this.readDownloaderToArrayBuffer(downloader);
  }

  private async readDownloaderToArrayBuffer(downloader: FileDownloader): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    const writable = new WritableStream<Uint8Array>({
      write: async chunk => {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    });

    const controller = downloader.downloadToStream(writable);
    await controller.completion();

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return merged.buffer;
  }

  private async findDirectChildByName(
    parentUid: string,
    name: string
  ): Promise<{ uid: string; name: string; type: NodeType } | null> {
    for await (const child of this.driveClient.iterateFolderChildren(parentUid)) {
      if (!child.ok || child.value.name !== name) {
        continue;
      }

      return {
        uid: child.value.uid,
        name: child.value.name,
        type: child.value.type
      };
    }

    return null;
  }

  private async deleteRemoteNode(nodeUid: string): Promise<void> {
    const trashResult = await this.consumeSingleNodeResult(this.driveClient.trashNodes([nodeUid]));
    if (!trashResult.ok && !isNotFoundMessage(trashResult.error)) {
      throw new Error(`Failed to trash remote node ${nodeUid}: ${trashResult.error ?? 'unknown error'}`);
    }

    const deleteResult = await this.consumeSingleNodeResult(this.driveClient.deleteNodes([nodeUid]));
    if (!deleteResult.ok && !isNotFoundMessage(deleteResult.error)) {
      throw new Error(`Failed to delete remote node ${nodeUid}: ${deleteResult.error ?? 'unknown error'}`);
    }
  }

  private async consumeSingleNodeResult(
    generator: AsyncGenerator<{ uid: string; ok: boolean; error?: string }>
  ): Promise<{ uid: string; ok: boolean; error?: string }> {
    const next = await generator.next();
    if (!next.value) {
      throw new Error('No result returned from Proton operation.');
    }

    await generator.return(undefined);
    return next.value;
  }

  private requireFolderNode(result: MaybeNode, errorMessage: string) {
    if (!result.ok) {
      throw new Error(`${errorMessage}: ${String(result.error)}`);
    }

    if (result.value.type !== NodeType.Folder) {
      throw new Error(`${errorMessage}: node type mismatch`);
    }

    return result.value;
  }

  private buildUploadMetadata(relativePath: string, modifiedAt: number, expectedSize: number): UploadMetadata {
    return {
      mediaType: inferMediaType(relativePath),
      expectedSize,
      modificationTime: new Date(modifiedAt)
    };
  }

  private toRelativeConfigPath(configDir: string, absolutePath: string): string | null {
    const normalizedConfigDir = normalizePath(configDir);
    const normalizedAbsolutePath = normalizePath(absolutePath);

    if (!normalizedAbsolutePath) {
      return null;
    }

    const canonicalConfigDir = toCanonicalPathKey(normalizedConfigDir);
    const canonicalAbsolutePath = toCanonicalPathKey(normalizedAbsolutePath);

    if (canonicalAbsolutePath === canonicalConfigDir) {
      return '';
    }

    const prefix = `${canonicalConfigDir}/`;
    if (!canonicalAbsolutePath.startsWith(prefix)) {
      return null;
    }

    const relative = normalizedAbsolutePath.slice(normalizedConfigDir.length + 1);
    return normalizePath(relative);
  }

  private toAbsoluteConfigPath(configDir: string, relativePath: string): string {
    const normalizedConfigDir = normalizePath(configDir);
    const normalizedRelativePath = normalizePath(relativePath);
    if (!normalizedRelativePath) {
      return normalizedConfigDir;
    }

    return normalizePath(`${normalizedConfigDir}/${normalizedRelativePath}`);
  }

  private isExcluded(relativePath: string): boolean {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return false;
    }

    const canonical = toCanonicalPathKey(normalized);
    const excluded = toCanonicalPathKey(EXCLUDED_PLUGIN_CONFIG_RELATIVE_PATH);
    return canonical === excluded || canonical.startsWith(`${excluded}/`);
  }

  private removeRemoteFolderSubtree(remote: ScannedRemoteConfig, relativePath: string): void {
    const canonical = toCanonicalPathKey(relativePath);
    const prefix = `${canonical}/`;

    for (const path of Array.from(remote.folders.keys())) {
      if (path === canonical || path.startsWith(prefix)) {
        remote.folders.delete(path);
      }
    }

    for (const path of Array.from(remote.files.keys())) {
      if (path === canonical || path.startsWith(prefix)) {
        remote.files.delete(path);
      }
    }
  }

  private async ensureLocalFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized) {
      return;
    }

    const segments = normalized.split('/').filter(Boolean);
    let current = '';

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const exists = await this.adapter.exists(current);
      if (!exists) {
        await this.adapter.mkdir(current);
      }
    }
  }
}

function createSuccessResult(): ConfigSyncResult {
  return {
    status: 'success',
    uploadedFiles: 0,
    downloadedFiles: 0,
    deletedRemoteFiles: 0,
    deletedRemoteFolders: 0,
    deletedLocalFiles: 0,
    deletedLocalFolders: 0
  };
}

function createAbortedResult(reason: ConfigSyncAbortReason): ConfigSyncResult {
  return {
    ...createSuccessResult(),
    status: 'aborted',
    reason
  };
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[a-z]:\/|[a-z]:\\|\\\\|\/)/i.test(path);
}

function depth(path: string): number {
  const normalized = normalizePath(path);
  if (!normalized) {
    return 0;
  }

  return normalized.split('/').length;
}

function inferMediaType(path: string): string {
  const lower = getBaseName(path).toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'application/javascript';
  if (lower.endsWith('.ts')) return 'application/typescript';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function isNotFoundMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return normalized.includes('not found') || normalized.includes('missing');
}
