import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface AdapterListResult {
  files: Array<string>;
  folders: Array<string>;
}

interface AdapterMock {
  list: ReturnType<typeof vi.fn<(path: string) => Promise<AdapterListResult>>>;
  stat: ReturnType<typeof vi.fn<(path: string) => Promise<{ ctime: number; mtime: number } | null>>>;
  readBinary: ReturnType<typeof vi.fn<(path: string) => Promise<ArrayBuffer>>>;
  exists: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
  mkdir: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
  writeBinary: ReturnType<typeof vi.fn<(path: string, data: ArrayBuffer, options: { mtime: number }) => Promise<void>>>;
  remove: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
  rmdir: ReturnType<typeof vi.fn<(path: string, recursive: boolean) => Promise<void>>>;
}

function createAdapterMock(): AdapterMock {
  return {
    list: vi.fn(),
    stat: vi.fn(),
    readBinary: vi.fn(),
    exists: vi.fn(),
    mkdir: vi.fn(),
    writeBinary: vi.fn(),
    remove: vi.fn(),
    rmdir: vi.fn()
  };
}

function toArrayBuffer(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

describe('ObsidianFileApi', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when getting API before initialization', async () => {
    const mod = await import('../services/ObsidianFileApi');

    expect(() => mod.getObsidianFileApi()).toThrowError(/has not been initialized/i);
  });

  it('returns singleton instance from init/get', async () => {
    const mod = await import('../services/ObsidianFileApi');
    const adapter = createAdapterMock();
    const vault = { adapter };

    const first = mod.initObsidianFileApi(vault as never);
    const second = mod.initObsidianFileApi({ adapter: createAdapterMock() } as never);
    const fromGet = mod.getObsidianFileApi();

    expect(first).toBe(second);
    expect(fromGet).toBe(first);
  });

  it('builds local file tree with canonicalized paths and hashes', async () => {
    const mod = await import('../services/ObsidianFileApi');
    const adapter = createAdapterMock();
    const vault = { adapter };

    const statTime = { ctime: 1_700_000_000_000, mtime: 1_700_000_500_000 };

    adapter.list.mockImplementation(async (path: string) => {
      if (path === '/') {
        return { files: ['Root.TXT'], folders: ['Folder'] };
      }

      if (path === 'Folder') {
        return { files: ['Folder\\Nested.MD'], folders: [] };
      }

      return { files: [], folders: [] };
    });

    adapter.stat.mockImplementation(async (path: string) => {
      if (path === 'Root.TXT') {
        return statTime;
      }
      return null;
    });

    adapter.readBinary.mockImplementation(async (path: string) => {
      if (path === 'Root.TXT') {
        return toArrayBuffer('root-content');
      }

      if (path === 'Folder\\Nested.MD') {
        return toArrayBuffer('nested-content');
      }

      return toArrayBuffer('');
    });

    const api = mod.initObsidianFileApi(vault as never);
    const tree = await Effect.runPromise(api.getFileTree());

    expect(tree._type).toBe('folder');
    expect(tree.path.path).toBe('');
    expect(tree.children).toHaveLength(2);

    const rootFile = tree.children.find(node => node._type === 'file' && node.rawPath === 'Root.TXT');
    expect(rootFile?._type).toBe('file');
    if (!rootFile || rootFile._type !== 'file') {
      throw new Error('Expected root file node.');
    }
    expect(rootFile.path.path).toBe('root.txt');
    expect(rootFile.sha1).toMatch(/^[a-f0-9]{40}$/);
    expect(rootFile.createdAt.toISOString()).toBe(new Date(statTime.ctime).toISOString());
    expect(rootFile.modifiedAt.toISOString()).toBe(new Date(statTime.mtime).toISOString());

    const folder = tree.children.find(node => node._type === 'folder' && node.rawPath === 'Folder');
    expect(folder?._type).toBe('folder');
    if (!folder || folder._type !== 'folder') {
      throw new Error('Expected folder node.');
    }
    expect(folder.path.path).toBe('folder');
    expect(folder.children).toHaveLength(1);

    const nestedFile = folder.children[0];
    expect(nestedFile?._type).toBe('file');
    if (nestedFile._type !== 'file') {
      throw new Error('Expected nested file node.');
    }
    expect(nestedFile.path.path).toBe('folder/nested.md');
    expect(nestedFile.sha1).toMatch(/^[a-f0-9]{40}$/);
    expect(adapter.readBinary).toHaveBeenCalledWith('Root.TXT');
    expect(adapter.readBinary).toHaveBeenCalledWith('Folder\\Nested.MD');
  });

  it('reads and writes file content through adapter', async () => {
    const mod = await import('../services/ObsidianFileApi');
    const adapter = createAdapterMock();
    const vault = { adapter };

    const binary = toArrayBuffer('hello');
    adapter.readBinary.mockResolvedValue(binary);
    adapter.writeBinary.mockResolvedValue();

    const api = mod.initObsidianFileApi(vault as never);

    const read = await Effect.runPromise(api.readFileContent('docs/a.md'));
    const modifiedAt = new Date(1_700_001_000_000);

    await Effect.runPromise(api.writeFileContent('docs/a.md', binary, modifiedAt));

    expect(read).toBe(binary);
    expect(adapter.readBinary).toHaveBeenCalledWith('docs/a.md');
    expect(adapter.writeBinary).toHaveBeenCalledWith('docs/a.md', binary, { mtime: modifiedAt.getTime() });
  });

  it('creates only missing folders when ensuring nested directory', async () => {
    const mod = await import('../services/ObsidianFileApi');
    const adapter = createAdapterMock();
    const vault = { adapter };

    adapter.exists.mockImplementation(async (path: string) => path === 'already');
    adapter.mkdir.mockResolvedValue();

    const api = mod.initObsidianFileApi(vault as never);

    await Effect.runPromise(api.ensureFolder('already\\new//leaf/'));

    expect(adapter.exists).toHaveBeenNthCalledWith(1, 'already');
    expect(adapter.exists).toHaveBeenNthCalledWith(2, 'already/new');
    expect(adapter.exists).toHaveBeenNthCalledWith(3, 'already/new/leaf');
    expect(adapter.mkdir).toHaveBeenNthCalledWith(1, 'already/new');
    expect(adapter.mkdir).toHaveBeenNthCalledWith(2, 'already/new/leaf');
    expect(adapter.mkdir).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when ensuring empty folder path', async () => {
    const mod = await import('../services/ObsidianFileApi');
    const adapter = createAdapterMock();
    const vault = { adapter };

    const api = mod.initObsidianFileApi(vault as never);

    await Effect.runPromise(api.ensureFolder('///'));

    expect(adapter.exists).not.toHaveBeenCalled();
    expect(adapter.mkdir).not.toHaveBeenCalled();
  });

  it('deletes files and folders only when they exist', async () => {
    const mod = await import('../services/ObsidianFileApi');
    const adapter = createAdapterMock();
    const vault = { adapter };

    adapter.exists.mockImplementation(async (path: string) => path.endsWith('exists'));
    adapter.remove.mockResolvedValue();
    adapter.rmdir.mockResolvedValue();

    const api = mod.initObsidianFileApi(vault as never);

    await Effect.runPromise(api.deleteFile('file-missing'));
    await Effect.runPromise(api.deleteFile('file-exists'));

    await Effect.runPromise(api.deleteFolder('folder-missing'));
    await Effect.runPromise(api.deleteFolder('folder-exists'));

    expect(adapter.remove).toHaveBeenCalledTimes(1);
    expect(adapter.remove).toHaveBeenCalledWith('file-exists');
    expect(adapter.rmdir).toHaveBeenCalledTimes(1);
    expect(adapter.rmdir).toHaveBeenCalledWith('folder-exists', true);
  });

  it('canonicalizes paths and compares canonical path values', async () => {
    const mod = await import('../services/ObsidianFileApi');

    const canonical = mod.canonicalizePath('  //Some\\Mixed///Path.MD  ');
    const same = mod.canonicalizePath('some/mixed/path.md');
    const different = mod.canonicalizePath('some/mixed/other.md');

    expect(canonical.path).toBe('some/mixed/path.md');
    expect(canonical.equals(same)).toBe(true);
    expect(canonical.equals(different)).toBe(false);
  });
});
