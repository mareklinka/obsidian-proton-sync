import { describe, expect, it } from 'vitest';
import { MemberRole, NodeType, RevisionState, type MaybeNode, type UploadMetadata } from '@protontech/drive-sdk';
import { ReconciliationService, type ReconciliationTombstone } from '../isolated-sync/ReconciliationService';

type FakeNode = {
  uid: string;
  parentUid: string | null;
  name: string;
  type: NodeType;
  modificationTime: Date;
  activeRevision?: {
    claimedModificationTime?: Date;
  };
  content?: ArrayBuffer;
  children: string[];
};

type FakeAbstract =
  | {
      kind: 'file';
      path: string;
      name: string;
      extension: string;
      stat: { mtime: number };
      bytes: ArrayBuffer;
      children?: undefined;
    }
  | {
      kind: 'folder';
      path: string;
      name: string;
      children: FakeAbstract[];
    };

class FakeVault {
  private entries = new Map<string, FakeAbstract>();

  setEntries(entries: FakeAbstract[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.path, entry);
    }
  }

  getAllLoadedFiles(): FakeAbstract[] {
    return Array.from(this.entries.values());
  }

  getAbstractFileByPath(path: string): FakeAbstract | null {
    return this.entries.get(path) ?? null;
  }

  async readBinary(file: FakeAbstract): Promise<ArrayBuffer> {
    if (file.kind !== 'file') {
      throw new Error('Not a file');
    }
    return file.bytes;
  }

  async createFolder(path: string): Promise<void> {
    if (this.entries.has(path)) {
      return;
    }

    this.entries.set(path, {
      kind: 'folder',
      path,
      name: path.split('/').pop() ?? path,
      children: []
    });
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.entries.set(path, {
      kind: 'file',
      path,
      name: path.split('/').pop() ?? path,
      extension: extractExtension(path),
      stat: { mtime: Date.now() },
      bytes: data,
      children: undefined
    });
  }

  async modifyBinary(file: FakeAbstract, data: ArrayBuffer): Promise<void> {
    if (file.kind !== 'file') {
      throw new Error('Not a file');
    }

    this.entries.set(file.path, {
      ...file,
      stat: { mtime: Date.now() },
      bytes: data
    });
  }

  async rename(file: FakeAbstract, newPath: string): Promise<void> {
    this.entries.delete(file.path);

    if (file.kind === 'file') {
      this.entries.set(newPath, {
        ...file,
        path: newPath,
        name: newPath.split('/').pop() ?? newPath,
        extension: extractExtension(newPath)
      });
      return;
    }

    const oldPrefix = `${file.path}/`;
    const updates: Array<{ oldPath: string; next: FakeAbstract }> = [];
    for (const [path, entry] of this.entries.entries()) {
      if (!path.startsWith(oldPrefix)) {
        continue;
      }

      const suffix = path.slice(oldPrefix.length);
      const nextPath = `${newPath}/${suffix}`;
      updates.push({
        oldPath: path,
        next: {
          ...entry,
          path: nextPath,
          name: nextPath.split('/').pop() ?? nextPath,
          ...(entry.kind === 'file' ? { extension: extractExtension(nextPath) } : {})
        }
      });
    }

    for (const update of updates) {
      this.entries.delete(update.oldPath);
      this.entries.set(update.next.path, update.next);
    }

    this.entries.set(newPath, {
      ...file,
      path: newPath,
      name: newPath.split('/').pop() ?? newPath
    });
  }

  async delete(file: FakeAbstract): Promise<void> {
    this.entries.delete(file.path);

    if (file.kind === 'folder') {
      const prefix = `${file.path}/`;
      for (const path of Array.from(this.entries.keys())) {
        if (path.startsWith(prefix)) {
          this.entries.delete(path);
        }
      }
    }
  }
}

class FakeDriveClient {
  private nodes = new Map<string, FakeNode>();
  private uidCounter = 100;

  constructor(rootUid: string) {
    this.nodes.set(rootUid, {
      uid: rootUid,
      parentUid: null,
      name: 'root',
      type: NodeType.Folder,
      modificationTime: new Date(0),
      children: []
    });
  }

  addFolder(uid: string, parentUid: string, name: string, modifiedAt: number): void {
    this.nodes.set(uid, {
      uid,
      parentUid,
      name,
      type: NodeType.Folder,
      modificationTime: new Date(modifiedAt),
      children: []
    });
    this.nodes.get(parentUid)?.children.push(uid);
  }

  addFile(uid: string, parentUid: string, name: string, modifiedAt: number, content: string): void {
    this.nodes.set(uid, {
      uid,
      parentUid,
      name,
      type: NodeType.File,
      modificationTime: new Date(modifiedAt),
      activeRevision: {
        claimedModificationTime: new Date(modifiedAt)
      },
      content: new TextEncoder().encode(content).buffer,
      children: []
    });
    this.nodes.get(parentUid)?.children.push(uid);
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

      yield {
        ok: true,
        value: {
          uid: child.uid,
          parentUid: child.parentUid ?? undefined,
          name: child.name,
          keyAuthor: { ok: true, value: null },
          nameAuthor: { ok: true, value: null },
          directRole: MemberRole.Inherited,
          type: child.type,
          mediaType: child.type === NodeType.File ? 'application/octet-stream' : undefined,
          isShared: false,
          isSharedPublicly: false,
          creationTime: new Date(child.modificationTime),
          modificationTime: new Date(child.modificationTime),
          activeRevision: child.activeRevision
            ? {
                uid: `${child.uid}-rev`,
                state: RevisionState.Active,
                creationTime: new Date(child.modificationTime),
                contentAuthor: { ok: true, value: null },
                storageSize: child.content?.byteLength ?? 0,
                claimedModificationTime: child.activeRevision.claimedModificationTime
              }
            : undefined,
          treeEventScopeId: 'scope'
        }
      };
    }
  }

  async createFolder(parentNodeUid: string, name: string): Promise<MaybeNode> {
    const uid = `folder-${this.uidCounter++}`;
    this.addFolder(uid, parentNodeUid, name, Date.now());

    return {
      ok: true,
      value: {
        uid,
        parentUid: parentNodeUid,
        name,
        keyAuthor: { ok: true, value: null },
        nameAuthor: { ok: true, value: null },
        directRole: MemberRole.Inherited,
        type: NodeType.Folder,
        isShared: false,
        isSharedPublicly: false,
        creationTime: new Date(),
        modificationTime: new Date(),
        treeEventScopeId: 'scope'
      }
    };
  }

  async getFileUploader(parentFolderUid: string, name: string, _metadata: UploadMetadata) {
    return {
      uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
        const bytes = await readStream(stream);
        const uid = `file-${this.uidCounter++}`;
        this.nodes.set(uid, {
          uid,
          parentUid: parentFolderUid,
          name,
          type: NodeType.File,
          modificationTime: new Date(),
          activeRevision: {
            claimedModificationTime: new Date()
          },
          content: bytes,
          children: []
        });
        this.nodes.get(parentFolderUid)?.children.push(uid);

        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => ({ nodeRevisionUid: `${uid}-rev`, nodeUid: uid })
        };
      }
    };
  }

  async getFileRevisionUploader(nodeUid: string, _metadata: UploadMetadata) {
    return {
      uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
        const bytes = await readStream(stream);
        const node = this.nodes.get(nodeUid);
        if (node) {
          node.content = bytes;
          node.modificationTime = new Date();
          node.activeRevision = {
            claimedModificationTime: new Date()
          };
        }

        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => ({ nodeRevisionUid: `${nodeUid}-rev2`, nodeUid })
        };
      }
    };
  }

  async getFileDownloader(nodeUid: string) {
    const node = this.nodes.get(nodeUid);
    if (!node?.content) {
      throw new Error('Missing file content');
    }

    return {
      getClaimedSizeInBytes: () => node.content?.byteLength,
      downloadToStream: (stream: WritableStream<Uint8Array>) => {
        const completionPromise = (async () => {
          const writer = stream.getWriter();
          await writer.write(new Uint8Array(node.content!));
          await writer.close();
        })();

        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => completionPromise,
          isDownloadCompleteWithSignatureIssues: () => false
        };
      },
      unsafeDownloadToStream: (stream: WritableStream<Uint8Array>) => {
        const completionPromise = (async () => {
          const writer = stream.getWriter();
          await writer.write(new Uint8Array(node.content!));
          await writer.close();
        })();

        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => completionPromise,
          isDownloadCompleteWithSignatureIssues: () => false
        };
      },
      getSeekableStream: () => {
        throw new Error('Not implemented in fake');
      }
    };
  }

  async renameNode(nodeUid: string, newName: string): Promise<MaybeNode> {
    const node = this.nodes.get(nodeUid);
    if (!node) {
      throw new Error('Node not found');
    }

    node.name = newName;
    node.modificationTime = new Date();

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
        treeEventScopeId: 'scope'
      }
    };
  }

  async *moveNodes(
    nodeUids: string[],
    newParentNodeUid: string
  ): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    for (const uid of nodeUids) {
      const node = this.nodes.get(uid);
      if (!node) {
        yield { uid, ok: false, error: 'Node not found' };
        continue;
      }

      if (node.parentUid) {
        const oldParent = this.nodes.get(node.parentUid);
        if (oldParent) {
          oldParent.children = oldParent.children.filter(childUid => childUid !== uid);
        }
      }

      node.parentUid = newParentNodeUid;
      this.nodes.get(newParentNodeUid)?.children.push(uid);
      yield { uid, ok: true };
    }
  }

  async *trashNodes(nodeUids: string[]): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    for (const uid of nodeUids) {
      yield { uid, ok: this.nodes.has(uid), error: this.nodes.has(uid) ? undefined : 'Node not found' };
    }
  }

  async *deleteNodes(nodeUids: string[]): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    for (const uid of nodeUids) {
      const node = this.nodes.get(uid);
      if (!node) {
        yield { uid, ok: false, error: 'Node not found' };
        continue;
      }

      const removed = this.collectDescendants(uid);
      for (const removedUid of removed) {
        this.nodes.delete(removedUid);
      }

      if (node.parentUid) {
        const parent = this.nodes.get(node.parentUid);
        if (parent) {
          parent.children = parent.children.filter(childUid => childUid !== uid);
        }
      }

      yield { uid, ok: true };
    }
  }

  hasPath(path: string, rootUid: string): boolean {
    return this.findNodeByPath(path, rootUid) !== null;
  }

  fileText(path: string, rootUid: string): string | null {
    const node = this.findNodeByPath(path, rootUid);
    if (!node?.content) {
      return null;
    }
    return new TextDecoder().decode(node.content);
  }

  private findNodeByPath(path: string, rootUid: string): FakeNode | null {
    const segments = path.split('/').filter(Boolean);
    let current = this.nodes.get(rootUid) ?? null;
    for (const segment of segments) {
      if (!current) {
        return null;
      }

      const child = current.children.map(uid => this.nodes.get(uid)).find(node => node && node.name === segment);

      if (!child) {
        return null;
      }

      current = child;
    }

    return current;
  }

  private collectDescendants(uid: string): string[] {
    const node = this.nodes.get(uid);
    if (!node) {
      return [];
    }

    const result = [uid];
    for (const childUid of node.children) {
      result.push(...this.collectDescendants(childUid));
    }
    return result;
  }
}

describe('ReconciliationService', () => {
  it('reconciles both sides and applies timestamp winner rule', async () => {
    const rootUid = 'root-uid';
    const drive = new FakeDriveClient(rootUid);
    drive.addFolder('folder-notes', rootUid, 'notes', 100);
    drive.addFolder('folder-remote-only', rootUid, 'remote-only-folder', 110);
    drive.addFile('file-both-remote-newer', 'folder-notes', 'both.md', 200, 'remote-newer');
    drive.addFile('file-local-wins', 'folder-notes', 'local-wins.md', 100, 'remote-old');
    drive.addFile('file-remote-only', 'folder-notes', 'remote-only.md', 120, 'remote-only');

    const vault = new FakeVault();
    vault.setEntries([
      {
        kind: 'folder',
        path: 'notes',
        name: 'notes',
        children: []
      },
      {
        kind: 'folder',
        path: 'local-only-folder',
        name: 'local-only-folder',
        children: []
      },
      {
        kind: 'file',
        path: 'notes/both.md',
        name: 'both.md',
        extension: 'md',
        stat: { mtime: 50 },
        bytes: new TextEncoder().encode('local-older').buffer,
        children: undefined
      },
      {
        kind: 'file',
        path: 'notes/local-wins.md',
        name: 'local-wins.md',
        extension: 'md',
        stat: { mtime: 250 },
        bytes: new TextEncoder().encode('local-newer').buffer,
        children: undefined
      },
      {
        kind: 'file',
        path: 'notes/local-only.md',
        name: 'local-only.md',
        extension: 'md',
        stat: { mtime: 210 },
        bytes: new TextEncoder().encode('local-only').buffer,
        children: undefined
      }
    ]);

    const service = new ReconciliationService(vault as never, drive as never, rootUid, undefined, {
      modifiedAtToleranceMs: 0
    });
    const result = await service.run();

    const remoteUpdated = drive.fileText('notes/local-wins.md', rootUid);
    expect(remoteUpdated).toBe('local-newer');

    const remoteCreated = drive.fileText('notes/local-only.md', rootUid);
    expect(remoteCreated).toBe('local-only');

    const localRemoteOnly = vault.getAbstractFileByPath('notes/remote-only.md');
    expect(localRemoteOnly && localRemoteOnly.kind === 'file').toBe(true);
    const localBoth = vault.getAbstractFileByPath('notes/both.md');
    expect(localBoth && localBoth.kind === 'file').toBe(true);

    if (localBoth && localBoth.kind === 'file') {
      expect(new TextDecoder().decode(localBoth.bytes)).toBe('remote-newer');
    }

    expect(vault.getAbstractFileByPath('remote-only-folder')).not.toBeNull();
    expect(drive.hasPath('local-only-folder', rootUid)).toBe(true);

    expect(Object.keys(result.snapshot.byPath).length).toBeGreaterThan(0);
    expect(result.stats.comparedFiles).toBeGreaterThan(0);
  });

  it('applies remote move to local path using previous snapshot cloud ID continuity', async () => {
    const rootUid = 'root-uid';
    const drive = new FakeDriveClient(rootUid);
    drive.addFolder('folder-notes', rootUid, 'notes', 100);
    drive.addFolder('folder-archive', rootUid, 'archive', 100);
    drive.addFile('file-1', 'folder-archive', 'moved.md', 120, 'content');

    const vault = new FakeVault();
    vault.setEntries([
      {
        kind: 'folder',
        path: 'notes',
        name: 'notes',
        children: []
      },
      {
        kind: 'folder',
        path: 'archive',
        name: 'archive',
        children: []
      },
      {
        kind: 'file',
        path: 'notes/moved.md',
        name: 'moved.md',
        extension: 'md',
        stat: { mtime: 110 },
        bytes: new TextEncoder().encode('content').buffer,
        children: undefined
      }
    ]);

    const previousSnapshot = {
      byPath: {
        'notes/moved.md': {
          cloudId: 'file-1',
          path: 'notes/moved.md',
          entityType: 'file' as const,
          updatedAt: 110
        }
      },
      byCloudId: {
        'file-1': {
          cloudId: 'file-1',
          path: 'notes/moved.md',
          entityType: 'file' as const,
          updatedAt: 110
        }
      }
    };

    const service = new ReconciliationService(vault as never, drive as never, rootUid, undefined, {
      previousSnapshot,
      modifiedAtToleranceMs: 0
    });

    await service.run();

    expect(vault.getAbstractFileByPath('notes/moved.md')).toBeNull();
    expect(vault.getAbstractFileByPath('archive/moved.md')).not.toBeNull();
  });

  it('propagates local delete to remote when previous snapshot entry disappears locally', async () => {
    const rootUid = 'root-uid';
    const drive = new FakeDriveClient(rootUid);
    drive.addFolder('folder-notes', rootUid, 'notes', 100);
    drive.addFile('file-1', 'folder-notes', 'gone.md', 120, 'content');

    const vault = new FakeVault();
    vault.setEntries([
      {
        kind: 'folder',
        path: 'notes',
        name: 'notes',
        children: []
      }
    ]);

    const previousSnapshot = {
      byPath: {
        'notes/gone.md': {
          cloudId: 'file-1',
          path: 'notes/gone.md',
          entityType: 'file' as const,
          updatedAt: 110
        }
      },
      byCloudId: {
        'file-1': {
          cloudId: 'file-1',
          path: 'notes/gone.md',
          entityType: 'file' as const,
          updatedAt: 110
        }
      }
    };

    const service = new ReconciliationService(vault as never, drive as never, rootUid, undefined, {
      previousSnapshot,
      modifiedAtToleranceMs: 0
    });

    const result = await service.run();

    expect(drive.fileText('notes/gone.md', rootUid)).toBeNull();
    expect(result.stats.remoteDeletesApplied).toBeGreaterThanOrEqual(1);
    expect(
      result.tombstones.some(
        (item: ReconciliationTombstone) => item.path === 'notes/gone.md' && item.origin === 'local'
      )
    ).toBe(true);
  });
});

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

function extractExtension(path: string): string {
  const name = path.split('/').pop() ?? path;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : '';
}
