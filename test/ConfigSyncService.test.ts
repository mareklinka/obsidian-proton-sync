import { describe, expect, it } from 'vitest';
import { MemberRole, NodeType, RevisionState, type MaybeNode, type UploadMetadata } from '@protontech/drive-sdk';

import { ConfigSyncService } from '../services/ConfigSyncService';

class FakeAdapter {
  private readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>();

  constructor(configDir: string) {
    this.folders.add(normalize(configDir));
  }

  seedFile(path: string, content: string): void {
    const normalized = normalize(path);
    this.ensureFolderTree(parentPath(normalized));
    this.files.set(normalized, new TextEncoder().encode(content));
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalize(path);
    return this.files.has(normalized) || this.folders.has(normalized);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const normalized = normalize(path);
    const folderPrefix = normalized ? `${normalized}/` : '';

    const directFolders = new Set<string>();
    const directFiles = new Set<string>();

    for (const folder of this.folders.values()) {
      if (!folder.startsWith(folderPrefix) || folder === normalized) {
        continue;
      }

      const suffix = folder.slice(folderPrefix.length);
      if (!suffix || suffix.includes('/')) {
        continue;
      }

      directFolders.add(folder);
    }

    for (const file of this.files.keys()) {
      if (!file.startsWith(folderPrefix)) {
        continue;
      }

      const suffix = file.slice(folderPrefix.length);
      if (!suffix || suffix.includes('/')) {
        continue;
      }

      directFiles.add(file);
    }

    return {
      files: Array.from(directFiles.values()),
      folders: Array.from(directFolders.values())
    };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const normalized = normalize(path);
    const bytes = this.files.get(normalized);
    if (!bytes) {
      throw new Error(`File not found: ${normalized}`);
    }

    return bytes.slice().buffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalize(path);
    this.ensureFolderTree(parentPath(normalized));
    this.files.set(normalized, new Uint8Array(data));
  }

  async mkdir(path: string): Promise<void> {
    this.ensureFolderTree(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(normalize(path));
  }

  async rmdir(path: string, recursive = false): Promise<void> {
    const normalized = normalize(path);
    const prefix = `${normalized}/`;

    const hasChildFolders = Array.from(this.folders.values()).some(item => item.startsWith(prefix));
    const hasChildFiles = Array.from(this.files.keys()).some(item => item.startsWith(prefix));
    if (!recursive && (hasChildFolders || hasChildFiles)) {
      throw new Error(`Folder not empty: ${normalized}`);
    }

    for (const file of Array.from(this.files.keys())) {
      if (file.startsWith(prefix)) {
        this.files.delete(file);
      }
    }

    for (const folder of Array.from(this.folders.values())) {
      if (folder === normalized || folder.startsWith(prefix)) {
        this.folders.delete(folder);
      }
    }
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
    const exists = this.files.has(normalize(path));
    if (!exists) {
      return null;
    }

    return { mtime: Date.now() };
  }

  readText(path: string): string | null {
    const bytes = this.files.get(normalize(path));
    if (!bytes) {
      return null;
    }

    return new TextDecoder().decode(bytes);
  }

  private ensureFolderTree(path: string): void {
    const normalized = normalize(path);
    if (!normalized) {
      return;
    }

    const segments = normalized.split('/');
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      this.folders.add(current);
    }
  }
}

type DriveNode = {
  uid: string;
  parentUid: string | null;
  name: string;
  type: NodeType;
  children: string[];
  content?: Uint8Array;
  modificationTime: Date;
};

class FakeDriveClient {
  private readonly nodes = new Map<string, DriveNode>();
  private uidCounter = 100;

  constructor(rootUid: string) {
    this.nodes.set(rootUid, {
      uid: rootUid,
      parentUid: null,
      name: 'root',
      type: NodeType.Folder,
      children: [],
      modificationTime: new Date()
    });
  }

  seedFolder(path: string, rootUid: string): string {
    const segments = normalize(path).split('/').filter(Boolean);
    let currentUid = rootUid;
    for (const segment of segments) {
      const existing = this.findChildByName(currentUid, segment);
      if (existing && existing.type === NodeType.Folder) {
        currentUid = existing.uid;
        continue;
      }

      const uid = `folder-${this.uidCounter++}`;
      this.nodes.set(uid, {
        uid,
        parentUid: currentUid,
        name: segment,
        type: NodeType.Folder,
        children: [],
        modificationTime: new Date()
      });
      this.nodes.get(currentUid)?.children.push(uid);
      currentUid = uid;
    }

    return currentUid;
  }

  seedFile(path: string, rootUid: string, content: string): string {
    const normalized = normalize(path);
    const parent = this.seedFolder(parentPath(normalized), rootUid);
    const uid = `file-${this.uidCounter++}`;
    this.nodes.set(uid, {
      uid,
      parentUid: parent,
      name: baseName(normalized),
      type: NodeType.File,
      children: [],
      content: new TextEncoder().encode(content),
      modificationTime: new Date()
    });
    this.nodes.get(parent)?.children.push(uid);
    return uid;
  }

  async *iterateFolderChildren(parentNodeUid: string): AsyncGenerator<MaybeNode> {
    const parent = this.nodes.get(parentNodeUid);
    if (!parent) {
      return;
    }

    for (const childUid of parent.children) {
      const child = this.nodes.get(childUid);
      if (!child) {
        continue;
      }

      yield this.toMaybeNode(child);
    }
  }

  async createFolder(parentNodeUid: string, name: string): Promise<MaybeNode> {
    const uid = `folder-${this.uidCounter++}`;
    this.nodes.set(uid, {
      uid,
      parentUid: parentNodeUid,
      name,
      type: NodeType.Folder,
      children: [],
      modificationTime: new Date()
    });
    this.nodes.get(parentNodeUid)?.children.push(uid);
    return this.toMaybeNode(this.nodes.get(uid)!);
  }

  async getFileUploader(parentFolderUid: string, name: string, _metadata: UploadMetadata) {
    return {
      uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
        const content = await readStream(stream);
        const existing = this.findChildByName(parentFolderUid, name);
        if (existing && existing.type === NodeType.File) {
          existing.content = new Uint8Array(content);
          existing.modificationTime = new Date();
          return {
            pause: () => undefined,
            resume: () => undefined,
            completion: async () => ({ nodeUid: existing.uid, nodeRevisionUid: `${existing.uid}-rev` })
          };
        }

        const uid = `file-${this.uidCounter++}`;
        this.nodes.set(uid, {
          uid,
          parentUid: parentFolderUid,
          name,
          type: NodeType.File,
          children: [],
          content: new Uint8Array(content),
          modificationTime: new Date()
        });
        this.nodes.get(parentFolderUid)?.children.push(uid);

        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => ({ nodeUid: uid, nodeRevisionUid: `${uid}-rev` })
        };
      }
    };
  }

  async getFileRevisionUploader(nodeUid: string, _metadata: UploadMetadata) {
    return {
      uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
        const content = await readStream(stream);
        const existing = this.nodes.get(nodeUid);
        if (existing) {
          existing.content = new Uint8Array(content);
          existing.modificationTime = new Date();
        }

        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => ({ nodeUid, nodeRevisionUid: `${nodeUid}-rev2` })
        };
      }
    };
  }

  async getFileDownloader(nodeUid: string) {
    const node = this.nodes.get(nodeUid);
    if (!node?.content) {
      throw new Error('file not found');
    }

    return {
      downloadToStream: (stream: WritableStream<Uint8Array>) => {
        const completionPromise = (async () => {
          const writer = stream.getWriter();
          await writer.write(node.content!);
          await writer.close();
        })();

        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => completionPromise,
          isDownloadCompleteWithSignatureIssues: () => false
        };
      },
      unsafeDownloadToStream: () => {
        throw new Error('not implemented');
      },
      getClaimedSizeInBytes: () => node.content?.byteLength,
      getSeekableStream: () => {
        throw new Error('not implemented');
      }
    };
  }

  async *trashNodes(nodeUids: string[]): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    for (const uid of nodeUids) {
      yield { uid, ok: this.nodes.has(uid), error: this.nodes.has(uid) ? undefined : 'not found' };
    }
  }

  async *deleteNodes(nodeUids: string[]): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    for (const uid of nodeUids) {
      const node = this.nodes.get(uid);
      if (!node) {
        yield { uid, ok: false, error: 'not found' };
        continue;
      }

      this.deleteSubtree(uid);
      yield { uid, ok: true };
    }
  }

  readText(path: string, rootUid: string): string | null {
    const node = this.findPath(path, rootUid);
    if (!node?.content) {
      return null;
    }

    return new TextDecoder().decode(node.content);
  }

  private deleteSubtree(uid: string): void {
    const node = this.nodes.get(uid);
    if (!node) {
      return;
    }

    for (const childUid of [...node.children]) {
      this.deleteSubtree(childUid);
    }

    if (node.parentUid) {
      const parent = this.nodes.get(node.parentUid);
      if (parent) {
        parent.children = parent.children.filter(childUid => childUid !== uid);
      }
    }

    this.nodes.delete(uid);
  }

  private findPath(path: string, rootUid: string): DriveNode | null {
    const segments = normalize(path).split('/').filter(Boolean);
    let current = this.nodes.get(rootUid) ?? null;

    for (const segment of segments) {
      if (!current) {
        return null;
      }

      const next = current.children
        .map(uid => this.nodes.get(uid))
        .find(node => node !== undefined && node.name === segment);

      current = next ?? null;
    }

    return current;
  }

  private findChildByName(parentUid: string, name: string): DriveNode | null {
    const parent = this.nodes.get(parentUid);
    if (!parent) {
      return null;
    }

    return (
      parent.children.map(uid => this.nodes.get(uid)).find(node => node !== undefined && node.name === name) ?? null
    );
  }

  private toMaybeNode(node: DriveNode): MaybeNode {
    return {
      ok: true,
      value: {
        uid: node.uid,
        parentUid: node.parentUid ?? undefined,
        name: node.name,
        keyAuthor: { ok: true, value: null },
        nameAuthor: { ok: true, value: null },
        directRole: MemberRole.Inherited,
        type: node.type,
        isShared: false,
        isSharedPublicly: false,
        creationTime: new Date(node.modificationTime),
        modificationTime: new Date(node.modificationTime),
        activeRevision:
          node.type === NodeType.File
            ? {
                uid: `${node.uid}-rev`,
                state: RevisionState.Active,
                creationTime: new Date(node.modificationTime),
                contentAuthor: { ok: true, value: null },
                storageSize: node.content?.byteLength ?? 0,
                claimedModificationTime: new Date(node.modificationTime)
              }
            : undefined,
        treeEventScopeId: 'scope'
      }
    };
  }
}

describe('ConfigSyncService', () => {
  it('push mirrors allowed local config and keeps excluded plugin subtree untouched', async () => {
    const vaultRootUid = 'vault-root';
    const drive = new FakeDriveClient(vaultRootUid);
    drive.seedFile('.obsidian/stale.json', vaultRootUid, 'stale');
    drive.seedFile('.obsidian/plugins/proton-drive-sync/remote-only.json', vaultRootUid, 'keep-me');

    const adapter = new FakeAdapter('.obsidian');
    adapter.seedFile('.obsidian/app.json', '{"theme":"dark"}');
    adapter.seedFile('.obsidian/plugins/proton-drive-sync/local-only.json', 'local-plugin-data');

    const service = new ConfigSyncService(
      {
        configDir: '.obsidian',
        adapter
      } as never,
      drive as never,
      vaultRootUid
    );

    const result = await service.pushConfig();

    expect(result.status).toBe('success');
    expect(drive.readText('.obsidian/app.json', vaultRootUid)).toBe('{"theme":"dark"}');
    expect(drive.readText('.obsidian/stale.json', vaultRootUid)).toBeNull();
    expect(drive.readText('.obsidian/plugins/proton-drive-sync/remote-only.json', vaultRootUid)).toBe('keep-me');
  });

  it('pull aborts when remote config is empty and does not clear local files', async () => {
    const vaultRootUid = 'vault-root';
    const drive = new FakeDriveClient(vaultRootUid);

    const adapter = new FakeAdapter('.obsidian');
    adapter.seedFile('.obsidian/app.json', 'local');

    const service = new ConfigSyncService(
      {
        configDir: '.obsidian',
        adapter
      } as never,
      drive as never,
      vaultRootUid
    );

    const result = await service.pullConfig();

    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('remote-empty');
    expect(adapter.readText('.obsidian/app.json')).toBe('local');
  });

  it('pull mirrors remote config while preserving excluded plugin subtree', async () => {
    const vaultRootUid = 'vault-root';
    const drive = new FakeDriveClient(vaultRootUid);
    drive.seedFile('.obsidian/app.json', vaultRootUid, 'remote-app');
    drive.seedFile('.obsidian/plugins/proton-drive-sync/remote-only.json', vaultRootUid, 'remote-plugin');

    const adapter = new FakeAdapter('.obsidian');
    adapter.seedFile('.obsidian/app.json', 'local-app');
    adapter.seedFile('.obsidian/old.json', 'stale-local');
    adapter.seedFile('.obsidian/plugins/proton-drive-sync/local-plugin.json', 'local-plugin');

    const service = new ConfigSyncService(
      {
        configDir: '.obsidian',
        adapter
      } as never,
      drive as never,
      vaultRootUid
    );

    const result = await service.pullConfig();

    expect(result.status).toBe('success');
    expect(adapter.readText('.obsidian/app.json')).toBe('remote-app');
    expect(adapter.readText('.obsidian/old.json')).toBeNull();
    expect(adapter.readText('.obsidian/plugins/proton-drive-sync/local-plugin.json')).toBe('local-plugin');
  });

  it('aborts when configDir is outside vault root', async () => {
    const vaultRootUid = 'vault-root';
    const drive = new FakeDriveClient(vaultRootUid);
    const adapter = new FakeAdapter('.obsidian');

    const service = new ConfigSyncService(
      {
        configDir: '../.obsidian',
        adapter
      } as never,
      drive as never,
      vaultRootUid
    );

    const result = await service.pushConfig();

    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('invalid-config-dir');
  });
});

function normalize(path: string): string {
  return path
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function parentPath(path: string): string {
  const normalized = normalize(path);
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) {
    return '';
  }

  return normalized.slice(0, idx);
}

function baseName(path: string): string {
  const normalized = normalize(path);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged.buffer;
}
