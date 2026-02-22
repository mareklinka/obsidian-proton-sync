import type { PluginLogger } from '../logger';
import type { SyncIndexSnapshot } from './ObsidianSyncService';
import { getBaseName, getParentPath, normalizePath, toCanonicalPathKey } from './path-utils';
import {
  NodeType,
  type MaybeNode,
  type UploadMetadata,
  type FileUploader,
  type FileDownloader,
  Revision,
  NodeOrUid,
  RevisionOrUid,
  RevisionState
} from '@protontech/drive-sdk';
import type { TAbstractFile, TFile, TFolder, Vault } from 'obsidian';
import { LocalChangeSuppressionService, type LocalSuppressionLockOptions } from './LocalChangeSuppressionService';

export interface ReconciliationOptions {
  ignoredPathPrefixes?: string[];
  modifiedAtToleranceMs?: number;
  previousSnapshot?: SyncIndexSnapshot;
  tombstones?: ReconciliationTombstone[];
  tombstoneTtlMs?: number;
  now?: () => number;
}

export interface ReconciliationTombstone {
  entityType: 'file' | 'folder';
  path: string;
  cloudId?: string;
  deletedAt: number;
  origin: 'local' | 'remote';
}

export interface ReconciliationStats {
  localFoldersCreated: number;
  remoteFoldersCreated: number;
  localFilesCreatedOrUpdated: number;
  remoteFilesCreatedOrUpdated: number;
  comparedFiles: number;
  localMovesApplied: number;
  remoteDeletesApplied: number;
  localDeletesApplied: number;
}

export interface ReconciliationResult {
  snapshot: SyncIndexSnapshot;
  stats: ReconciliationStats;
  tombstones: ReconciliationTombstone[];
}

type RemoteFolderEntry = {
  path: string;
  uid: string;
  modifiedAt: number;
};

type RemoteFileEntry = {
  path: string;
  uid: string;
  modifiedAt: number;
};

type LocalFolderEntry = {
  path: string;
};

type LocalFileEntry = {
  path: string;
  modifiedAt: number;
};

type NodeResult = {
  uid: string;
  ok: boolean;
  error?: string;
};

interface DriveLike {
  iterateRevisions(nodeUid: NodeOrUid, signal?: AbortSignal): AsyncGenerator<Revision>;
  deleteRevision(revisionUid: RevisionOrUid): Promise<void>;
  iterateFolderChildren(parentNodeUid: string, filterOptions?: { type?: NodeType }): AsyncGenerator<MaybeNode>;
  createFolder(parentNodeUid: string, name: string, modificationTime?: Date): Promise<MaybeNode>;
  getFileUploader(parentFolderUid: string, name: string, metadata: UploadMetadata): Promise<FileUploader>;
  getFileRevisionUploader(nodeUid: string, metadata: UploadMetadata): Promise<FileUploader>;
  getFileDownloader(nodeUid: string): Promise<FileDownloader>;
  renameNode(nodeUid: string, newName: string): Promise<MaybeNode>;
  moveNodes(nodeUids: string[], newParentNodeUid: string): AsyncGenerator<NodeResult>;
  trashNodes(nodeUids: string[]): AsyncGenerator<NodeResult>;
  deleteNodes(nodeUids: string[]): AsyncGenerator<NodeResult>;
}

const DEFAULT_TOLERANCE_MS = 3000;
const DEFAULT_TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export class ReconciliationService {
  private readonly modifiedAtToleranceMs: number;
  private readonly ignoredPrefixes: string[];
  private readonly now: () => number;
  private readonly previousSnapshot: SyncIndexSnapshot | null;
  private readonly tombstoneTtlMs: number;
  private tombstones: ReconciliationTombstone[];

  constructor(
    private readonly vault: Vault,
    private readonly driveClient: DriveLike,
    private readonly vaultRootNodeUid: string,
    private readonly localChangeSuppressionService: LocalChangeSuppressionService,
    private readonly logger?: PluginLogger,
    options: ReconciliationOptions = {}
  ) {
    this.modifiedAtToleranceMs = options.modifiedAtToleranceMs ?? DEFAULT_TOLERANCE_MS;
    this.previousSnapshot = options.previousSnapshot ?? null;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.tombstones = this.pruneTombstones(options.tombstones ?? []);
    this.ignoredPrefixes = (options.ignoredPathPrefixes ?? ['.obsidian'])
      .map(path => normalizePath(path))
      .filter(path => path.length > 0);
  }

  async run(): Promise<ReconciliationResult> {
    const stats: ReconciliationStats = {
      localFoldersCreated: 0,
      remoteFoldersCreated: 0,
      localFilesCreatedOrUpdated: 0,
      remoteFilesCreatedOrUpdated: 0,
      comparedFiles: 0,
      localMovesApplied: 0,
      remoteDeletesApplied: 0,
      localDeletesApplied: 0
    };

    let local = this.scanLocal();
    const remoteFolders = new Map<string, RemoteFolderEntry>();
    const remoteFiles = new Map<string, RemoteFileEntry>();

    await this.scanRemoteFolder(this.vaultRootNodeUid, '', remoteFolders, remoteFiles);

    if (this.previousSnapshot) {
      await this.applyMovePropagationFromRemote(remoteFolders, remoteFiles, stats);
      local = this.scanLocal();

      await this.applyDeletePropagationFromPrevious(local, remoteFolders, remoteFiles, stats);
      local = this.scanLocal();
    }

    await this.reconcileFolders(local.folders, remoteFolders, stats);
    await this.reconcileFiles(local.files, remoteFolders, remoteFiles, stats);

    return {
      snapshot: this.buildSnapshot(remoteFolders, remoteFiles),
      stats,
      tombstones: this.pruneTombstones(this.tombstones)
    };
  }

  private scanLocal(): { folders: Map<string, LocalFolderEntry>; files: Map<string, LocalFileEntry> } {
    const folders = new Map<string, LocalFolderEntry>();
    const files = new Map<string, LocalFileEntry>();

    const entries = this.vault.getAllLoadedFiles();
    for (const entry of entries) {
      const path = normalizePath(entry.path ?? '');
      if (!path || this.isIgnored(path)) {
        continue;
      }

      if (isVaultFolder(entry)) {
        folders.set(toCanonicalPathKey(path), { path });
        continue;
      }

      if (isVaultFile(entry)) {
        files.set(toCanonicalPathKey(path), {
          path,
          modifiedAt: entry.stat?.mtime ?? this.now()
        });
      }
    }

    return { folders, files };
  }

  private async scanRemoteFolder(
    parentUid: string,
    parentPath: string,
    folders: Map<string, RemoteFolderEntry>,
    files: Map<string, RemoteFileEntry>
  ): Promise<void> {
    for await (const child of this.driveClient.iterateFolderChildren(parentUid)) {
      if (!child.ok) {
        this.logger?.warn('Skipping degraded remote node during reconciliation', {
          parentUid,
          error: String(child.error)
        });
        continue;
      }

      const node = child.value;
      const path = normalizePath(parentPath ? `${parentPath}/${node.name}` : node.name);
      if (!path || this.isIgnored(path)) {
        continue;
      }

      if (node.type === NodeType.Folder) {
        folders.set(toCanonicalPathKey(path), {
          path,
          uid: node.uid,
          modifiedAt: node.modificationTime.getTime()
        });
        await this.scanRemoteFolder(node.uid, path, folders, files);
        continue;
      }

      if (node.type === NodeType.File) {
        const modifiedAt = node.activeRevision?.claimedModificationTime?.getTime() ?? node.modificationTime.getTime();
        files.set(toCanonicalPathKey(path), {
          path,
          uid: node.uid,
          modifiedAt
        });
      }
    }
  }

  private async applyMovePropagationFromRemote(
    remoteFolders: Map<string, RemoteFolderEntry>,
    remoteFiles: Map<string, RemoteFileEntry>,
    stats: ReconciliationStats
  ): Promise<void> {
    if (!this.previousSnapshot) {
      return;
    }

    const remoteFoldersByUid = new Map<string, RemoteFolderEntry>();
    const remoteFilesByUid = new Map<string, RemoteFileEntry>();

    for (const folder of remoteFolders.values()) {
      remoteFoldersByUid.set(folder.uid, folder);
    }
    for (const file of remoteFiles.values()) {
      remoteFilesByUid.set(file.uid, file);
    }

    for (const entry of Object.values(this.previousSnapshot.byCloudId)) {
      const oldPath = normalizePath(entry.path);
      if (!oldPath || this.isIgnored(oldPath)) {
        continue;
      }

      const remote =
        entry.entityType === 'folder' ? remoteFoldersByUid.get(entry.cloudId) : remoteFilesByUid.get(entry.cloudId);
      if (!remote) {
        continue;
      }

      const newPath = remote.path;
      if (toCanonicalPathKey(oldPath) === toCanonicalPathKey(newPath)) {
        continue;
      }

      const localOld = this.vault.getAbstractFileByPath(oldPath);
      const localNew = this.vault.getAbstractFileByPath(newPath);

      if (!localOld || localNew) {
        continue;
      }

      await this.withSuppressionLock(
        oldPath,
        {
          subtree: entry.entityType === 'folder',
          aliasPaths: [newPath]
        },
        async () => {
          await this.ensureLocalFolderPath(getParentPath(newPath));
          await this.vault.rename(localOld, newPath);
        }
      );
      stats.localMovesApplied += 1;
    }
  }

  private async applyDeletePropagationFromPrevious(
    local: { folders: Map<string, LocalFolderEntry>; files: Map<string, LocalFileEntry> },
    remoteFolders: Map<string, RemoteFolderEntry>,
    remoteFiles: Map<string, RemoteFileEntry>,
    stats: ReconciliationStats
  ): Promise<void> {
    if (!this.previousSnapshot) {
      return;
    }

    const remoteFoldersByUid = new Map<string, RemoteFolderEntry>();
    const remoteFilesByUid = new Map<string, RemoteFileEntry>();

    for (const folder of remoteFolders.values()) {
      remoteFoldersByUid.set(folder.uid, folder);
    }
    for (const file of remoteFiles.values()) {
      remoteFilesByUid.set(file.uid, file);
    }

    for (const entry of Object.values(this.previousSnapshot.byCloudId)) {
      const path = normalizePath(entry.path);
      if (!path || this.isIgnored(path)) {
        continue;
      }

      const canonical = toCanonicalPathKey(path);
      const localExists = entry.entityType === 'folder' ? local.folders.has(canonical) : local.files.has(canonical);
      const remote =
        entry.entityType === 'folder' ? remoteFoldersByUid.get(entry.cloudId) : remoteFilesByUid.get(entry.cloudId);

      if (!localExists && remote && toCanonicalPathKey(remote.path) === canonical) {
        this.recordTombstone(entry.entityType, path, entry.cloudId, 'local');
        await this.deleteRemoteNode(entry.cloudId);
        if (entry.entityType === 'folder') {
          remoteFolders.delete(toCanonicalPathKey(remote.path));
        } else {
          remoteFiles.delete(toCanonicalPathKey(remote.path));
        }
        stats.remoteDeletesApplied += 1;
        continue;
      }

      if (localExists && !remote) {
        this.recordTombstone(entry.entityType, path, entry.cloudId, 'remote');
        await this.deleteLocalPath(path);
        stats.localDeletesApplied += 1;
      }
    }
  }

  private async reconcileFolders(
    localFolders: Map<string, LocalFolderEntry>,
    remoteFolders: Map<string, RemoteFolderEntry>,
    stats: ReconciliationStats
  ): Promise<void> {
    const localOnly = Array.from(localFolders.entries())
      .filter(([key]) => !remoteFolders.has(key))
      .map(([, value]) => value.path)
      .sort((a, b) => depth(a) - depth(b));

    for (const path of localOnly) {
      if (this.findRelevantTombstone('folder', path, undefined, 'remote', this.now())) {
        await this.deleteLocalPath(path);
        stats.localDeletesApplied += 1;
        continue;
      }

      await this.ensureRemoteFolderPath(path, remoteFolders);
      stats.remoteFoldersCreated += 1;
    }

    const remoteOnly = Array.from(remoteFolders.entries())
      .filter(([key]) => !localFolders.has(key))
      .map(([, value]) => value.path)
      .sort((a, b) => depth(a) - depth(b));

    for (const path of remoteOnly) {
      const remote = remoteFolders.get(toCanonicalPathKey(path));
      if (!remote) {
        continue;
      }

      if (this.findRelevantTombstone('folder', path, remote.uid, 'local', remote.modifiedAt)) {
        await this.deleteRemoteNode(remote.uid);
        stats.remoteDeletesApplied += 1;
        remoteFolders.delete(toCanonicalPathKey(path));
        continue;
      }

      await this.ensureLocalFolderPath(path);
      stats.localFoldersCreated += 1;
    }
  }

  private async reconcileFiles(
    localFiles: Map<string, LocalFileEntry>,
    remoteFolders: Map<string, RemoteFolderEntry>,
    remoteFiles: Map<string, RemoteFileEntry>,
    stats: ReconciliationStats
  ): Promise<void> {
    const allFileKeys = new Set<string>([...localFiles.keys(), ...remoteFiles.keys()]);

    for (const key of allFileKeys) {
      const local = localFiles.get(key);
      const remote = remoteFiles.get(key);
      const path = local?.path ?? remote?.path ?? key;

      if (local && remote) {
        stats.comparedFiles += 1;

        if (local.modifiedAt > remote.modifiedAt + this.modifiedAtToleranceMs) {
          try {
            const uploadedUid = await this.uploadLocalFileAsRevision(path, remote.uid);
            remoteFiles.set(key, {
              path,
              uid: uploadedUid,
              modifiedAt: local.modifiedAt
            });
            stats.remoteFilesCreatedOrUpdated += 1;
          } catch (error) {
            if (error instanceof Error && error.message.includes('Draft revision already exists for this link')) {
              this.logger?.warn('Revision conflict detected, attempting to resolve by replacing the existing file');

              await this.deleteRemoteNode(remote.uid);

              const uid = await this.uploadLocalFileAsCreate(path, remoteFolders);

              remoteFiles.set(key, {
                path,
                uid: uid,
                modifiedAt: local.modifiedAt
              });
              stats.remoteFilesCreatedOrUpdated += 1;
            }

            throw error;
          }
          continue;
        }

        if (remote.modifiedAt > local.modifiedAt + this.modifiedAtToleranceMs) {
          await this.downloadRemoteFileToLocal(path, remote.uid);
          stats.localFilesCreatedOrUpdated += 1;
        }

        continue;
      }

      if (local && !remote) {
        if (this.findRelevantTombstone('file', path, undefined, 'remote', local.modifiedAt)) {
          await this.deleteLocalPath(path);
          stats.localDeletesApplied += 1;
          continue;
        }

        await this.ensureRemoteFolderPath(getParentPath(path), remoteFolders);
        const uid = await this.uploadLocalFileAsCreate(path, remoteFolders);
        remoteFiles.set(key, {
          path,
          uid,
          modifiedAt: local.modifiedAt
        });
        stats.remoteFilesCreatedOrUpdated += 1;
        continue;
      }

      if (!local && remote) {
        if (this.findRelevantTombstone('file', path, remote.uid, 'local', remote.modifiedAt)) {
          await this.deleteRemoteNode(remote.uid);
          stats.remoteDeletesApplied += 1;
          continue;
        }

        await this.downloadRemoteFileToLocal(path, remote.uid);
        stats.localFilesCreatedOrUpdated += 1;
      }
    }
  }

  private async uploadLocalFileAsCreate(path: string, remoteFolders: Map<string, RemoteFolderEntry>): Promise<string> {
    const local = this.vault.getAbstractFileByPath(path);
    if (!local || !isVaultFile(local)) {
      throw new Error(`Cannot upload missing local file: ${path}`);
    }

    const bytes = await this.vault.readBinary(local);
    const parentPath = getParentPath(path);
    const parentUid = await this.ensureRemoteFolderPath(parentPath, remoteFolders);
    const metadata = this.buildUploadMetadata(path, bytes.byteLength, local.stat?.mtime ?? this.now());
    const uploader = await this.driveClient.getFileUploader(parentUid, getBaseName(path), metadata);
    const controller = await uploader.uploadFromStream(this.arrayBufferToReadableStream(bytes), []);
    const completion = await controller.completion();
    return completion.nodeUid;
  }

  private async uploadLocalFileAsRevision(path: string, nodeUid: string): Promise<string> {
    const local = this.vault.getAbstractFileByPath(path);
    if (!local || !isVaultFile(local)) {
      throw new Error(`Cannot upload revision for missing local file: ${path}`);
    }

    const bytes = await this.vault.readBinary(local);
    const metadata = this.buildUploadMetadata(path, bytes.byteLength, local.stat?.mtime ?? this.now());

    const uploader = await this.driveClient.getFileRevisionUploader(nodeUid, metadata);
    const controller = await uploader.uploadFromStream(this.arrayBufferToReadableStream(bytes), []);
    const completion = await controller.completion();

    return completion.nodeUid;
  }

  private async downloadRemoteFileToLocal(path: string, nodeUid: string): Promise<void> {
    const bytes = await this.downloadRemoteFile(nodeUid);
    await this.writeLocalBinary(path, bytes);
  }

  private async downloadRemoteFile(nodeUid: string): Promise<ArrayBuffer> {
    const downloader = await this.driveClient.getFileDownloader(nodeUid);
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

  private async deleteRemoteNode(nodeUid: string): Promise<void> {
    const trashed = await this.consumeSingleResult(this.driveClient.trashNodes([nodeUid]));
    if (!trashed.ok) {
      throw new Error(`Failed to trash remote node ${nodeUid}: ${trashed.error ?? 'unknown error'}`);
    }

    const deleted = await this.consumeSingleResult(this.driveClient.deleteNodes([nodeUid]));
    if (!deleted.ok) {
      throw new Error(`Failed to delete remote node ${nodeUid}: ${deleted.error ?? 'unknown error'}`);
    }
  }

  private async consumeSingleResult(generator: AsyncGenerator<NodeResult>): Promise<NodeResult> {
    const next = await generator.next();
    if (!next.value) {
      throw new Error('No result returned from Proton operation');
    }

    await generator.return(undefined);
    return next.value;
  }

  private async deleteLocalPath(path: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (!existing) {
      return;
    }

    await this.withSuppressionLock(path, { subtree: isVaultFolder(existing) }, async () => {
      await this.vault.delete(existing, true);
    });
  }

  private async writeLocalBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    await this.withSuppressionLock(path, {}, async () => {
      const parent = getParentPath(path);
      if (parent) {
        await this.ensureLocalFolderPath(parent);
      }

      const existing = this.vault.getAbstractFileByPath(path);
      if (!existing) {
        await this.vault.createBinary(path, bytes);
        return;
      }

      if (isVaultFile(existing)) {
        await this.vault.modifyBinary(existing, bytes);
        return;
      }

      throw new Error(`Cannot write file because path points to a folder: ${path}`);
    });
  }

  private async ensureLocalFolderPath(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized) {
      return;
    }

    const segments = normalized.split('/');
    let current = '';

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.vault.getAbstractFileByPath(current);
      if (existing) {
        if (!isVaultFolder(existing)) {
          throw new Error(`Cannot create folder because a file exists at ${current}`);
        }
        continue;
      }

      await this.withSuppressionLock(current, { subtree: true }, async () => {
        await this.vault.createFolder(current);
      });
    }
  }

  private async withSuppressionLock<T>(
    path: string,
    options: LocalSuppressionLockOptions,
    operation: () => Promise<T>
  ): Promise<T> {
    const normalizedPath = normalizePath(path);
    if (!this.localChangeSuppressionService || !normalizedPath) {
      return operation();
    }

    const lock = this.localChangeSuppressionService.acquirePathLock(normalizedPath, options);
    try {
      return await operation();
    } finally {
      lock.release();
    }
  }

  private async ensureRemoteFolderPath(path: string, remoteFolders: Map<string, RemoteFolderEntry>): Promise<string> {
    const normalized = normalizePath(path);
    if (!normalized) {
      return this.vaultRootNodeUid;
    }

    const canonical = toCanonicalPathKey(normalized);
    const existing = remoteFolders.get(canonical);
    if (existing) {
      return existing.uid;
    }

    const parentPath = getParentPath(normalized);
    const parentUid = await this.ensureRemoteFolderPath(parentPath, remoteFolders);
    const created = await this.driveClient.createFolder(parentUid, getBaseName(normalized));
    const folderNode = requireNode(created, NodeType.Folder, `Failed to create remote folder: ${normalized}`);

    remoteFolders.set(canonical, {
      path: normalized,
      uid: folderNode.uid,
      modifiedAt: folderNode.modificationTime.getTime()
    });

    return folderNode.uid;
  }

  private buildUploadMetadata(path: string, expectedSize: number, modifiedAt: number): UploadMetadata {
    return {
      mediaType: inferMediaType(path),
      expectedSize,
      modificationTime: new Date(modifiedAt)
    };
  }

  private arrayBufferToReadableStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: controller => {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      }
    });
  }

  private buildSnapshot(
    remoteFolders: Map<string, RemoteFolderEntry>,
    remoteFiles: Map<string, RemoteFileEntry>
  ): SyncIndexSnapshot {
    const byPath: SyncIndexSnapshot['byPath'] = {};
    const byCloudId: SyncIndexSnapshot['byCloudId'] = {};

    for (const folder of remoteFolders.values()) {
      const entry = {
        cloudId: folder.uid,
        path: folder.path,
        entityType: 'folder' as const,
        updatedAt: folder.modifiedAt
      };
      byPath[entry.path] = entry;
      byCloudId[entry.cloudId] = entry;
    }

    for (const file of remoteFiles.values()) {
      const entry = {
        cloudId: file.uid,
        path: file.path,
        entityType: 'file' as const,
        updatedAt: file.modifiedAt
      };
      byPath[entry.path] = entry;
      byCloudId[entry.cloudId] = entry;
    }

    return { byPath, byCloudId };
  }

  private isIgnored(path: string): boolean {
    const canonical = toCanonicalPathKey(path);
    for (const prefix of this.ignoredPrefixes) {
      const canonicalPrefix = toCanonicalPathKey(prefix);
      if (canonical === canonicalPrefix || canonical.startsWith(`${canonicalPrefix}/`)) {
        return true;
      }
    }

    return false;
  }

  private pruneTombstones(input: ReconciliationTombstone[]): ReconciliationTombstone[] {
    const threshold = this.now() - this.tombstoneTtlMs;
    return input.filter(item => item.deletedAt >= threshold);
  }

  private recordTombstone(
    entityType: 'file' | 'folder',
    path: string,
    cloudId: string | undefined,
    origin: 'local' | 'remote'
  ): void {
    const tombstone: ReconciliationTombstone = {
      entityType,
      path: normalizePath(path),
      cloudId,
      deletedAt: this.now(),
      origin
    };

    this.tombstones = this.pruneTombstones([...this.tombstones, tombstone]);
  }

  private findRelevantTombstone(
    entityType: 'file' | 'folder',
    path: string,
    cloudId: string | undefined,
    expectedOrigin: 'local' | 'remote',
    counterpartModifiedAt: number
  ): ReconciliationTombstone | null {
    const canonicalPath = toCanonicalPathKey(path);
    let best: ReconciliationTombstone | null = null;

    for (const item of this.tombstones) {
      if (item.entityType !== entityType || item.origin !== expectedOrigin) {
        continue;
      }

      const pathMatch = toCanonicalPathKey(item.path) === canonicalPath;
      const cloudMatch = Boolean(cloudId && item.cloudId && item.cloudId === cloudId);
      if (!pathMatch && !cloudMatch) {
        continue;
      }

      if (item.deletedAt + this.modifiedAtToleranceMs < counterpartModifiedAt) {
        continue;
      }

      if (!best || item.deletedAt > best.deletedAt) {
        best = item;
      }
    }

    return best;
  }
}

function requireNode(result: MaybeNode, expectedType: NodeType, message: string) {
  if (!result.ok) {
    throw new Error(`${message}: ${String(result.error)}`);
  }

  if (result.value.type !== expectedType) {
    throw new Error(`${message}: node type mismatch`);
  }

  return result.value;
}

function depth(path: string): number {
  if (!path) {
    return 0;
  }

  return normalizePath(path).split('/').length;
}

function isVaultFile(entry: TAbstractFile): entry is TFile {
  const candidate = entry as { extension?: unknown; stat?: unknown; children?: unknown };
  return (
    typeof candidate.extension === 'string' && typeof candidate.stat === 'object' && candidate.children === undefined
  );
}

function isVaultFolder(entry: TAbstractFile): entry is TFolder {
  const candidate = entry as { children?: unknown };
  return Array.isArray(candidate.children);
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
