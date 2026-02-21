import { describe, expect, it } from 'vitest';
import { MemberRole, NodeType, RevisionState, type MaybeNode, type UploadMetadata } from '@protontech/drive-sdk';
import { ProtonDriveCloudStorageApi } from '../isolated-sync/ProtonDriveCloudStorageApi';
import type { SyncIndexSnapshot } from '../isolated-sync/RxSyncService';

class FakeDriveClient {
  public uploaderCalls: Array<{ parentUid: string; name: string; metadata: UploadMetadata }> = [];
  public revisionUploaderCalls: Array<{ nodeUid: string; metadata: UploadMetadata }> = [];
  public moveCalls: Array<{ ids: string[]; parentUid: string }> = [];
  public renameCalls: Array<{ id: string; name: string }> = [];
  public trashCalls: string[][] = [];
  public deleteCalls: string[][] = [];

  private readonly nodes = new Map<string, NodeRecord>();
  private uidCounter = 100;

  constructor(private readonly rootUid: string) {
    this.nodes.set(rootUid, {
      uid: rootUid,
      parentUid: null,
      name: 'root',
      type: NodeType.Folder,
      children: []
    });
  }

  addFolder(uid: string, parentUid: string, name: string): void {
    this.nodes.set(uid, {
      uid,
      parentUid,
      name,
      type: NodeType.Folder,
      children: []
    });
    this.nodes.get(parentUid)?.children.push(uid);
  }

  addFile(uid: string, parentUid: string, name: string): void {
    this.nodes.set(uid, {
      uid,
      parentUid,
      name,
      type: NodeType.File,
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

      yield this.toMaybeNode(child);
    }
  }

  async createFolder(parentNodeUid: string, name: string): Promise<MaybeNode> {
    const uid = `folder-${this.uidCounter++}`;
    this.addFolder(uid, parentNodeUid, name);
    const node = this.nodes.get(uid)!;
    return this.toMaybeNode(node);
  }

  async getFileUploader(parentFolderUid: string, name: string, metadata: UploadMetadata) {
    this.uploaderCalls.push({ parentUid: parentFolderUid, name, metadata });

    return {
      uploadFromStream: async () => {
        const uid = `file-${this.uidCounter++}`;
        this.addFile(uid, parentFolderUid, name);
        return {
          pause: () => undefined,
          resume: () => undefined,
          completion: async () => ({ nodeUid: uid, nodeRevisionUid: `${uid}-rev` })
        };
      }
    };
  }

  async getFileRevisionUploader(nodeUid: string, metadata: UploadMetadata) {
    this.revisionUploaderCalls.push({ nodeUid, metadata });

    return {
      uploadFromStream: async () => ({
        pause: () => undefined,
        resume: () => undefined,
        completion: async () => ({ nodeUid, nodeRevisionUid: `${nodeUid}-rev2` })
      })
    };
  }

  async getFileDownloader(): Promise<never> {
    throw new Error('not needed in this test');
  }

  async renameNode(nodeUid: string, newName: string): Promise<MaybeNode> {
    this.renameCalls.push({ id: nodeUid, name: newName });
    const node = this.nodes.get(nodeUid);
    if (!node) {
      throw new Error('node not found');
    }
    node.name = newName;
    return this.toMaybeNode(node);
  }

  async *moveNodes(
    nodeUids: string[],
    newParentNodeUid: string
  ): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    this.moveCalls.push({ ids: nodeUids, parentUid: newParentNodeUid });

    for (const uid of nodeUids) {
      const node = this.nodes.get(uid);
      if (!node) {
        yield { uid, ok: false, error: 'not found' };
        continue;
      }

      if (node.parentUid) {
        const oldParent = this.nodes.get(node.parentUid);
        if (oldParent) {
          oldParent.children = oldParent.children.filter(child => child !== uid);
        }
      }

      node.parentUid = newParentNodeUid;
      this.nodes.get(newParentNodeUid)?.children.push(uid);
      yield { uid, ok: true };
    }
  }

  async *trashNodes(nodeUids: string[]): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    this.trashCalls.push(nodeUids);
    for (const uid of nodeUids) {
      if (!this.nodes.has(uid)) {
        yield { uid, ok: false, error: 'not found' };
      } else {
        yield { uid, ok: true };
      }
    }
  }

  async *deleteNodes(nodeUids: string[]): AsyncGenerator<{ uid: string; ok: boolean; error?: string }> {
    this.deleteCalls.push(nodeUids);
    for (const uid of nodeUids) {
      const node = this.nodes.get(uid);
      if (!node) {
        yield { uid, ok: false, error: 'not found' };
        continue;
      }

      this.nodes.delete(uid);
      if (node.parentUid) {
        const parent = this.nodes.get(node.parentUid);
        if (parent) {
          parent.children = parent.children.filter(child => child !== uid);
        }
      }
      yield { uid, ok: true };
    }
  }

  async getNode(nodeUid: string): Promise<MaybeNode> {
    const node = this.nodes.get(nodeUid);
    if (!node) {
      return {
        ok: false,
        error: 'not found'
      } as never;
    }

    return this.toMaybeNode(node);
  }

  private toMaybeNode(node: NodeRecord): MaybeNode {
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
        creationTime: new Date(0),
        modificationTime: new Date(0),
        activeRevision:
          node.type === NodeType.File
            ? {
                uid: `${node.uid}-rev`,
                state: RevisionState.Active,
                creationTime: new Date(0),
                contentAuthor: { ok: true, value: null },
                storageSize: 1
              }
            : undefined,
        treeEventScopeId: 'scope'
      }
    };
  }
}

type NodeRecord = {
  uid: string;
  parentUid: string | null;
  name: string;
  type: NodeType;
  children: string[];
};

const emptySnapshot = (): SyncIndexSnapshot => ({ byPath: {}, byCloudId: {} });

describe('ProtonDriveCloudStorageApi', () => {
  it('creates missing parent folders and uploads file', async () => {
    const rootUid = 'root';
    const drive = new FakeDriveClient(rootUid);
    const api = new ProtonDriveCloudStorageApi(drive as never, rootUid, () => emptySnapshot());

    const result = await api.createFile(
      {
        name: 'today.md',
        path: 'notes/daily/today.md',
        modifiedAt: 123,
        content: new TextEncoder().encode('hello').buffer
      },
      'notes/daily'
    );

    expect(result.entityType).toBe('file');
    expect(result.path).toBe('notes/daily/today.md');
    expect(drive.uploaderCalls).toHaveLength(1);
    expect(drive.uploaderCalls[0].name).toBe('today.md');
  });

  it('updates file using revision uploader', async () => {
    const rootUid = 'root';
    const drive = new FakeDriveClient(rootUid);
    const api = new ProtonDriveCloudStorageApi(drive as never, rootUid, () => emptySnapshot());

    const result = await api.updateFile('file-1', {
      name: 'a.md',
      path: 'a.md',
      modifiedAt: 42,
      content: new TextEncoder().encode('updated').buffer
    });

    expect(result.cloudId).toBe('file-1');
    expect(drive.revisionUploaderCalls).toHaveLength(1);
    expect(drive.revisionUploaderCalls[0].nodeUid).toBe('file-1');
  });

  it('moves and renames file when basename changes', async () => {
    const rootUid = 'root';
    const drive = new FakeDriveClient(rootUid);
    drive.addFolder('folder-archive', rootUid, 'archive');
    drive.addFile('file-1', rootUid, 'old.md');

    const snapshot: SyncIndexSnapshot = {
      byPath: {
        archive: {
          cloudId: 'folder-archive',
          path: 'archive',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      },
      byCloudId: {
        'folder-archive': {
          cloudId: 'folder-archive',
          path: 'archive',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      }
    };

    const api = new ProtonDriveCloudStorageApi(drive as never, rootUid, () => snapshot);

    const moved = await api.moveFile('file-1', 'archive/new.md', 'old.md');

    expect(moved.path).toBe('archive/new.md');
    expect(drive.moveCalls).toHaveLength(1);
    expect(drive.renameCalls).toHaveLength(1);
    expect(drive.renameCalls[0]).toEqual({ id: 'file-1', name: 'new.md' });
  });

  it('rename-only moveFile does not call moveNodes when parent folder is unchanged', async () => {
    const rootUid = 'root';
    const drive = new FakeDriveClient(rootUid);
    drive.addFolder('folder-notes', rootUid, 'notes');
    drive.addFile('file-1', 'folder-notes', 'old.md');

    const snapshot: SyncIndexSnapshot = {
      byPath: {
        notes: {
          cloudId: 'folder-notes',
          path: 'notes',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      },
      byCloudId: {
        'folder-notes': {
          cloudId: 'folder-notes',
          path: 'notes',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      }
    };

    const api = new ProtonDriveCloudStorageApi(drive as never, rootUid, () => snapshot);

    const moved = await api.moveFile('file-1', 'notes/new.md', 'notes/old.md');

    expect(moved.path).toBe('notes/new.md');
    expect(drive.moveCalls).toHaveLength(0);
    expect(drive.renameCalls).toHaveLength(1);
    expect(drive.renameCalls[0]).toEqual({ id: 'file-1', name: 'new.md' });
  });

  it('rename-only moveFolder does not call moveNodes when parent folder is unchanged', async () => {
    const rootUid = 'root';
    const drive = new FakeDriveClient(rootUid);
    drive.addFolder('folder-parent', rootUid, 'parent');
    drive.addFolder('folder-1', 'folder-parent', 'old-name');

    const snapshot: SyncIndexSnapshot = {
      byPath: {
        parent: {
          cloudId: 'folder-parent',
          path: 'parent',
          entityType: 'folder',
          updatedAt: Date.now()
        },
        'parent/old-name': {
          cloudId: 'folder-1',
          path: 'parent/old-name',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      },
      byCloudId: {
        'folder-parent': {
          cloudId: 'folder-parent',
          path: 'parent',
          entityType: 'folder',
          updatedAt: Date.now()
        },
        'folder-1': {
          cloudId: 'folder-1',
          path: 'parent/old-name',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      }
    };

    const api = new ProtonDriveCloudStorageApi(drive as never, rootUid, () => snapshot);

    const moved = await api.moveFolder('folder-1', 'parent/new-name', 'parent/old-name');

    expect(moved.path).toBe('parent/new-name');
    expect(drive.moveCalls).toHaveLength(0);
    expect(drive.renameCalls).toHaveLength(1);
    expect(drive.renameCalls[0]).toEqual({ id: 'folder-1', name: 'new-name' });
  });

  it('moveFolder performs parent move and rename when both change', async () => {
    const rootUid = 'root';
    const drive = new FakeDriveClient(rootUid);
    drive.addFolder('folder-parent-a', rootUid, 'a');
    drive.addFolder('folder-parent-b', rootUid, 'b');
    drive.addFolder('folder-1', 'folder-parent-a', 'old-name');

    const snapshot: SyncIndexSnapshot = {
      byPath: {
        a: {
          cloudId: 'folder-parent-a',
          path: 'a',
          entityType: 'folder',
          updatedAt: Date.now()
        },
        b: {
          cloudId: 'folder-parent-b',
          path: 'b',
          entityType: 'folder',
          updatedAt: Date.now()
        },
        'a/old-name': {
          cloudId: 'folder-1',
          path: 'a/old-name',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      },
      byCloudId: {
        'folder-parent-a': {
          cloudId: 'folder-parent-a',
          path: 'a',
          entityType: 'folder',
          updatedAt: Date.now()
        },
        'folder-parent-b': {
          cloudId: 'folder-parent-b',
          path: 'b',
          entityType: 'folder',
          updatedAt: Date.now()
        },
        'folder-1': {
          cloudId: 'folder-1',
          path: 'a/old-name',
          entityType: 'folder',
          updatedAt: Date.now()
        }
      }
    };

    const api = new ProtonDriveCloudStorageApi(drive as never, rootUid, () => snapshot);

    const moved = await api.moveFolder('folder-1', 'b/new-name', 'a/old-name');

    expect(moved.path).toBe('b/new-name');
    expect(drive.moveCalls).toHaveLength(1);
    expect(drive.renameCalls).toHaveLength(1);
    expect(drive.renameCalls[0]).toEqual({ id: 'folder-1', name: 'new-name' });
  });

  it('delete ignores not-found errors for idempotence', async () => {
    const rootUid = 'root';
    const drive = new FakeDriveClient(rootUid);
    const api = new ProtonDriveCloudStorageApi(drive as never, rootUid, () => emptySnapshot());

    await expect(api.deleteFile('missing-id')).resolves.toBeUndefined();
    expect(drive.trashCalls).toEqual([['missing-id']]);
  });
});

const fakeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  updateSettings: () => undefined
};
