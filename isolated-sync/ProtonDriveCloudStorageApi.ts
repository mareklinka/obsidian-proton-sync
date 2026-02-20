import {
  NodeType,
  type FileUploader,
  type MaybeNode,
  type ProtonDriveClient,
  type UploadMetadata
} from '@protontech/drive-sdk';
import { getBaseName, getParentPath, normalizePath, toCanonicalPathKey } from './path-utils';
import type { CloudUpsertResult, ICloudStorageApi, SyncIndexSnapshot } from './RxSyncService';
import type { FileDescriptor, FolderDescriptor } from './shared-types';
import type { PluginLogger } from '../logger';

export interface ProtonDriveCloudStorageApiOptions {
  caseInsensitivePaths?: boolean;
  strictDelete?: boolean;
}

export class ProtonDriveCloudStorageApi implements ICloudStorageApi {
  private readonly caseInsensitivePaths: boolean;
  private readonly strictDelete: boolean;
  private readonly folderUidByPath = new Map<string, string>();
  private readonly nodeNameByUid = new Map<string, string>();
  private cacheSeeded = false;

  constructor(
    private readonly driveClient: ProtonDriveClient,
    private readonly vaultRootNodeUid: string,
    private readonly logger: PluginLogger,
    private readonly snapshotProvider: () => SyncIndexSnapshot,
    options: ProtonDriveCloudStorageApiOptions = {}
  ) {
    this.caseInsensitivePaths = options.caseInsensitivePaths ?? true;
    this.strictDelete = options.strictDelete ?? true;
    this.folderUidByPath.set(this.toCanonical(''), this.vaultRootNodeUid);
  }

  async createFile(input: FileDescriptor, parentPath?: string): Promise<CloudUpsertResult> {
    this.seedCacheFromSnapshot();

    const normalizedPath = normalizePath(input.path);
    const normalizedParent = normalizePath(parentPath ?? getParentPath(normalizedPath));
    const parentUid = await this.ensureFolderPath(normalizedParent, true);

    const metadata = this.buildUploadMetadata(normalizedPath, input);
    const uploader = await this.driveClient.getFileUploader(parentUid, getBaseName(normalizedPath), metadata);
    const completion = await this.uploadWithUploader(uploader, input.content);

    return {
      cloudId: completion.nodeUid,
      path: normalizedPath,
      entityType: 'file'
    };
  }

  async updateFile(cloudId: string, input: FileDescriptor): Promise<CloudUpsertResult> {
    const normalizedPath = normalizePath(input.path);
    const metadata = this.buildUploadMetadata(normalizedPath, input);
    const uploader = await this.driveClient.getFileRevisionUploader(cloudId, metadata);
    await this.uploadWithUploader(uploader, input.content);

    return {
      cloudId,
      path: normalizedPath,
      entityType: 'file'
    };
  }

  async deleteFile(cloudId: string): Promise<void> {
    await this.deleteNode(cloudId);
  }

  async moveFile(cloudId: string, newPath: string, oldPath?: string): Promise<CloudUpsertResult> {
    const normalizedPath = normalizePath(newPath);
    const normalizedOldPath = oldPath ? normalizePath(oldPath) : undefined;
    const targetParentPath = getParentPath(normalizedPath);
    const targetName = getBaseName(normalizedPath);
    const parentUid = await this.ensureFolderPath(targetParentPath, true);
    const sourceParentPath = normalizedOldPath ? getParentPath(normalizedOldPath) : undefined;
    const parentChanged =
      sourceParentPath === undefined || this.toCanonical(sourceParentPath) !== this.toCanonical(targetParentPath);

    if (parentChanged) {
      const moveResult = await this.consumeSingleNodeResult(this.driveClient.moveNodes([cloudId], parentUid));
      if (!moveResult.ok) {
        throw new Error(`moveFile failed for ${cloudId}: ${moveResult.error ?? 'unknown error'}`);
      }
    }

    const currentName = await this.getNodeName(cloudId);
    if (currentName !== targetName) {
      const renamed = await this.driveClient.renameNode(cloudId, targetName);
      if (!renamed.ok) {
        throw new Error(`moveFile rename failed for ${cloudId}: ${String(renamed.error)}`);
      }
      this.nodeNameByUid.set(cloudId, targetName);
    }

    return {
      cloudId,
      path: normalizedPath,
      entityType: 'file'
    };
  }

  async createFolder(input: FolderDescriptor, parentPath?: string): Promise<CloudUpsertResult> {
    this.seedCacheFromSnapshot();

    const normalizedPath = normalizePath(input.path);
    const normalizedParent = normalizePath(parentPath ?? getParentPath(normalizedPath));
    const parentUid = await this.ensureFolderPath(normalizedParent, true);

    const created = await this.driveClient.createFolder(parentUid, input.name);
    const node = this.requireNode(created, NodeType.Folder, `createFolder failed for ${normalizedPath}`);

    this.setFolderPath(node.uid, normalizedPath);
    this.nodeNameByUid.set(node.uid, node.name);

    return {
      cloudId: node.uid,
      path: normalizedPath,
      entityType: 'folder'
    };
  }

  async renameFolder(cloudId: string, newName: string, newPath: string): Promise<CloudUpsertResult> {
    const normalizedPath = normalizePath(newPath);
    const renamed = await this.driveClient.renameNode(cloudId, newName);
    this.requireNode(renamed, NodeType.Folder, `renameFolder failed for ${cloudId}`);

    this.nodeNameByUid.set(cloudId, newName);
    this.setFolderPath(cloudId, normalizedPath);

    return {
      cloudId,
      path: normalizedPath,
      entityType: 'folder'
    };
  }

  async deleteFolder(cloudId: string): Promise<void> {
    await this.deleteNode(cloudId);
    this.removeFolderByUid(cloudId);
  }

  async moveFolder(cloudId: string, newPath: string): Promise<CloudUpsertResult> {
    const normalizedPath = normalizePath(newPath);
    const targetParentPath = getParentPath(normalizedPath);
    const targetName = getBaseName(normalizedPath);
    const parentUid = await this.ensureFolderPath(targetParentPath, true);

    const moveResult = await this.consumeSingleNodeResult(this.driveClient.moveNodes([cloudId], parentUid));
    if (!moveResult.ok) {
      throw new Error(`moveFolder failed for ${cloudId}: ${moveResult.error ?? 'unknown error'}`);
    }

    const currentName = await this.getNodeName(cloudId);
    if (currentName !== targetName) {
      const renamed = await this.driveClient.renameNode(cloudId, targetName);
      this.requireNode(renamed, NodeType.Folder, `moveFolder rename failed for ${cloudId}`);
      this.nodeNameByUid.set(cloudId, targetName);
    }

    this.setFolderPath(cloudId, normalizedPath);

    return {
      cloudId,
      path: normalizedPath,
      entityType: 'folder'
    };
  }

  private async deleteNode(cloudId: string): Promise<void> {
    const trashResult = await this.consumeSingleNodeResult(this.driveClient.trashNodes([cloudId]));
    if (!trashResult.ok) {
      if (isNotFoundMessage(trashResult.error)) {
        return;
      }
      throw new Error(`Delete failed while trashing node ${cloudId}: ${trashResult.error ?? 'unknown error'}`);
    }

    if (!this.strictDelete) {
      return;
    }

    const deleteResult = await this.consumeSingleNodeResult(this.driveClient.deleteNodes([cloudId]));
    if (!deleteResult.ok && !isNotFoundMessage(deleteResult.error)) {
      throw new Error(`Delete failed while removing node ${cloudId}: ${deleteResult.error ?? 'unknown error'}`);
    }
  }

  private buildUploadMetadata(path: string, input: FileDescriptor): UploadMetadata {
    return {
      mediaType: inferMediaType(path),
      expectedSize: this.getContentSize(input.content),
      modificationTime: new Date(input.modifiedAt)
    };
  }

  private async uploadWithUploader(
    uploader: FileUploader,
    content: Blob | ArrayBuffer
  ): Promise<{ nodeUid: string; nodeRevisionUid: string }> {
    const arrayBuffer = await toArrayBuffer(content);
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        controller.enqueue(new Uint8Array(arrayBuffer));
        controller.close();
      }
    });

    const controller = await uploader.uploadFromStream(stream, []);
    return controller.completion();
  }

  private getContentSize(content: Blob | ArrayBuffer): number {
    return content instanceof Blob ? content.size : content.byteLength;
  }

  private seedCacheFromSnapshot(): void {
    if (this.cacheSeeded) {
      return;
    }

    const snapshot = this.snapshotProvider();
    for (const entry of Object.values(snapshot.byPath)) {
      const normalizedPath = normalizePath(entry.path);
      if (!normalizedPath) {
        continue;
      }

      if (entry.entityType === 'folder') {
        this.folderUidByPath.set(this.toCanonical(normalizedPath), entry.cloudId);
      }

      this.nodeNameByUid.set(entry.cloudId, getBaseName(normalizedPath));
    }

    this.cacheSeeded = true;
  }

  private async ensureFolderPath(path: string, createMissing: boolean): Promise<string> {
    const normalized = normalizePath(path);
    if (!normalized) {
      return this.vaultRootNodeUid;
    }

    const cached = this.folderUidByPath.get(this.toCanonical(normalized));
    if (cached) {
      return cached;
    }

    const segments = normalized.split('/');
    let currentPath = '';
    let currentUid = this.vaultRootNodeUid;

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const currentCanonical = this.toCanonical(currentPath);
      const fromCache = this.folderUidByPath.get(currentCanonical);
      if (fromCache) {
        currentUid = fromCache;
        continue;
      }

      const found = await this.findChildFolderByName(currentUid, segment);
      if (found) {
        currentUid = found.uid;
        this.folderUidByPath.set(currentCanonical, found.uid);
        this.nodeNameByUid.set(found.uid, found.name);
        continue;
      }

      if (!createMissing) {
        throw new Error(`Folder path not found in Proton Drive: ${currentPath}`);
      }

      const created = await this.driveClient.createFolder(currentUid, segment);
      const node = this.requireNode(created, NodeType.Folder, `Failed to create folder ${currentPath}`);
      currentUid = node.uid;
      this.folderUidByPath.set(currentCanonical, node.uid);
      this.nodeNameByUid.set(node.uid, node.name);
    }

    return currentUid;
  }

  private async findChildFolderByName(parentUid: string, name: string): Promise<{ uid: string; name: string } | null> {
    for await (const child of this.driveClient.iterateFolderChildren(parentUid, { type: NodeType.Folder })) {
      if (!child.ok) {
        continue;
      }

      if (child.value.type === NodeType.Folder && child.value.name === name) {
        return {
          uid: child.value.uid,
          name: child.value.name
        };
      }
    }

    return null;
  }

  private async consumeSingleNodeResult(
    generator: AsyncGenerator<{ uid: string; ok: boolean; error?: string }>
  ): Promise<{ uid: string; ok: boolean; error?: string }> {
    const first = await generator.next();
    if (!first.value) {
      throw new Error('No result returned from Proton operation.');
    }

    await generator.return(undefined);
    return first.value;
  }

  private requireNode(result: MaybeNode, expectedType: NodeType, errorMessage: string) {
    if (!result.ok) {
      throw new Error(`${errorMessage}: ${String(result.error)}`);
    }

    if (result.value.type !== expectedType) {
      throw new Error(`${errorMessage}: unexpected node type ${result.value.type}`);
    }

    return result.value;
  }

  private async getNodeName(cloudId: string): Promise<string> {
    const cached = this.nodeNameByUid.get(cloudId);
    if (cached) {
      return cached;
    }

    const node = await this.driveClient.getNode(cloudId);
    if (!node.ok) {
      throw new Error(`Cannot resolve node name for ${cloudId}: ${String(node.error)}`);
    }

    this.nodeNameByUid.set(cloudId, node.value.name);
    return node.value.name;
  }

  private setFolderPath(cloudId: string, path: string): void {
    this.removeFolderByUid(cloudId);
    this.folderUidByPath.set(this.toCanonical(path), cloudId);
  }

  private removeFolderByUid(cloudId: string): void {
    for (const [key, uid] of this.folderUidByPath.entries()) {
      if (uid === cloudId) {
        this.folderUidByPath.delete(key);
      }
    }
  }

  private toCanonical(path: string): string {
    return toCanonicalPathKey(path, this.caseInsensitivePaths);
  }
}

async function toArrayBuffer(content: Blob | ArrayBuffer): Promise<ArrayBuffer> {
  if (content instanceof Blob) {
    return content.arrayBuffer();
  }
  return content;
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
