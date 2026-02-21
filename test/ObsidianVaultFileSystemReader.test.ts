import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EntityType,
  FileSystemReaderOptions,
  ObsidianVaultFileSystemReader,
  ReaderChangeEvent
} from '../isolated-sync/ObsidianVaultFileSystemReader';

type FakeBase = {
  kind: EntityType;
  name: string;
  path: string;
  stat?: { mtime: number };
};

type FakeFile = FakeBase & {
  kind: 'file';
  bytes: ArrayBuffer;
  extension: string;
  children?: undefined;
};
type FakeFolder = FakeBase & { kind: 'folder'; children: FakeEntry[] };
type FakeEntry = FakeFile | FakeFolder;

class FakeVaultAdapter {
  private readonly byPath = new Map<string, FakeEntry>();
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private readonly refs = new Map<object, { name: string; callback: (...args: unknown[]) => void }>();

  setEntries(entries: FakeEntry[]): void {
    this.byPath.clear();
    for (const entry of entries) {
      this.byPath.set(entry.path, entry);
    }
  }

  getAbstractFileByPath(path: string): FakeEntry | null {
    return this.byPath.get(path) ?? null;
  }

  getAllLoadedFiles(): FakeEntry[] {
    return Array.from(this.byPath.values());
  }

  async readBinary(file: FakeFile): Promise<ArrayBuffer> {
    return file.bytes;
  }

  on(name: 'create' | 'modify' | 'rename' | 'delete', callback: (...args: unknown[]) => void): object {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);

    const ref = {};
    this.refs.set(ref, { name, callback });
    return ref;
  }

  offref(ref: object): void {
    const found = this.refs.get(ref);
    if (!found) {
      return;
    }

    const list = this.listeners.get(found.name) ?? [];
    const next = list.filter(cb => cb !== found.callback);
    this.listeners.set(found.name, next);
    this.refs.delete(ref);
  }

  emit(name: 'create' | 'modify' | 'rename' | 'delete', ...args: unknown[]): void {
    const list = this.listeners.get(name) ?? [];
    for (const callback of list) {
      callback(...args);
    }
  }

  listenerCount(name: 'create' | 'modify' | 'rename' | 'delete'): number {
    return (this.listeners.get(name) ?? []).length;
  }
}

function makeFile(path: string, mtime = 100): FakeFile {
  const name = path.split('/').pop() ?? path;
  const extIndex = name.lastIndexOf('.');
  const extension = extIndex >= 0 ? name.slice(extIndex + 1) : '';

  return {
    kind: 'file',
    path,
    name,
    stat: { mtime },
    bytes: new TextEncoder().encode(path).buffer,
    extension,
    children: undefined
  };
}

function makeFolder(path: string): FakeFolder {
  return {
    kind: 'folder',
    path,
    name: path.split('/').pop() ?? path,
    children: []
  };
}

function makeReader(
  adapter: FakeVaultAdapter,
  options: Partial<FileSystemReaderOptions> = {},
  useDefaultGuards = false
): ObsidianVaultFileSystemReader {
  const now = vi.fn(() => 12345);

  const customGuards = useDefaultGuards
    ? {}
    : {
        isFile: (entry: unknown): entry is never =>
          Boolean(entry && typeof entry === 'object' && (entry as FakeEntry).kind === 'file'),
        isFolder: (entry: unknown): entry is never =>
          Boolean(entry && typeof entry === 'object' && (entry as FakeEntry).kind === 'folder')
      };

  return new ObsidianVaultFileSystemReader({} as never, {
    now,
    vaultAdapter: adapter as never,
    ...customGuards,
    ...options
  });
}

describe('ObsidianVaultFileSystemReader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('readFile returns descriptor for file and uses readBinary', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFile('notes/today.md', 777)]);
    const reader = makeReader(adapter);

    const file = await reader.readFile('notes/today.md');

    expect(file).not.toBeNull();
    expect(file?.name).toBe('today.md');
    expect(file?.path).toBe('notes/today.md');
    expect(file?.modifiedAt).toBe(777);
    expect(file?.content instanceof ArrayBuffer).toBe(true);
  });

  it('readFile can return Blob when configured', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFile('notes/image.png', 888)]);
    const reader = makeReader(adapter, { binaryAsBlob: true });

    const file = await reader.readFile('notes/image.png');

    expect(file?.content instanceof Blob).toBe(true);
  });

  it('readFile returns null for missing path and folder path', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFolder('notes')]);
    const reader = makeReader(adapter);

    await expect(reader.readFile('missing.md')).resolves.toBeNull();
    await expect(reader.readFile('notes')).resolves.toBeNull();
  });

  it('readFolder returns descriptor for folder', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFolder('notes/archive')]);
    const reader = makeReader(adapter);

    const folder = await reader.readFolder('notes/archive');

    expect(folder).toEqual({ name: 'archive', path: 'notes/archive' });
  });

  it('exists supports file and folder checks', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFolder('notes'), makeFile('notes/a.md')]);
    const reader = makeReader(adapter);

    await expect(reader.exists('notes/a.md', 'file')).resolves.toBe(true);
    await expect(reader.exists('notes', 'folder')).resolves.toBe(true);
    await expect(reader.exists('notes', 'file')).resolves.toBe(false);
    await expect(reader.exists('missing', 'file')).resolves.toBe(false);
  });

  it('listFilesMetadata returns only files and excludes root-like empty paths', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFolder(''), makeFolder('notes'), makeFile('notes/a.md', 42)]);
    const reader = makeReader(adapter);

    const list = await reader.listFilesMetadata();

    expect(list).toEqual([{ name: 'a.md', path: 'notes/a.md', modifiedAt: 42 }]);
  });

  it('listFolders returns only folders and honors ignore prefixes', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFolder('notes'), makeFolder('.obsidian/plugins'), makeFile('notes/a.md')]);

    const reader = makeReader(adapter, { ignoredPathPrefixes: ['.obsidian'] });
    const folders = await reader.listFolders();

    expect(folders).toEqual([{ name: 'notes', path: 'notes' }]);
  });

  it('maps create/modify/delete events for files', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('create', makeFile('notes/a.md'));
    adapter.emit('modify', makeFile('notes/a.md'));
    adapter.emit('delete', makeFile('notes/a.md'));

    expect(events.map(e => e.type)).toEqual(['file-created', 'file-edited', 'file-deleted']);
  });

  it('maps create/delete events for folders', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('create', makeFolder('notes/archive'));
    adapter.emit('delete', makeFolder('notes/archive'));

    expect(events.map(e => e.type)).toEqual(['folder-created', 'folder-deleted']);
  });

  it('maps file rename as file-moved with oldPath', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('rename', makeFile('notes/new.md'), 'notes/old.md');

    expect(events[0]).toMatchObject({
      type: 'file-moved',
      entityType: 'file',
      oldPath: 'notes/old.md',
      path: 'notes/new.md',
      occurredAt: 12345
    });
  });

  it('maps folder rename within same parent to folder-renamed', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('rename', makeFolder('notes/new-name'), 'notes/old-name');
    vi.advanceTimersByTime(251);

    expect(events[0]?.type).toBe('folder-renamed');
  });

  it('maps folder rename across parents to folder-moved', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('rename', makeFolder('archive/notes'), 'notes/archive');
    vi.advanceTimersByTime(251);

    expect(events[0]?.type).toBe('folder-moved');
  });

  it('suppresses descendant rename events during pending parent folder rename window', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter, { folderRenameBatchWindowMs: 200 });
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('rename', makeFolder('new-root'), 'old-root');
    adapter.emit('rename', makeFile('new-root/a.md'), 'old-root/a.md');
    adapter.emit('rename', makeFolder('new-root/sub'), 'old-root/sub');

    vi.advanceTimersByTime(199);
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'folder-renamed',
      path: 'new-root',
      oldPath: 'old-root'
    });
  });

  it('ignore rules suppress events (prefix + predicate)', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter, {
      ignoredPathPrefixes: ['.obsidian'],
      ignorePredicate: path => path.endsWith('.tmp')
    });
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('create', makeFile('.obsidian/config'));
    adapter.emit('create', makeFile('notes/temp.tmp'));
    adapter.emit('create', makeFile('notes/ok.md'));

    expect(events).toHaveLength(1);
    expect(events[0].path).toBe('notes/ok.md');
  });

  it('ignore prefix matching is case-insensitive and tunable', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter, {
      ignoredPathPrefixes: ['.OBSIDIAN']
    });

    const insensitiveEvents: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => insensitiveEvents.push(event));

    reader.start();

    adapter.emit('create', makeFile('.obsidian/config.json'));

    expect(insensitiveEvents).toHaveLength(0);
  });

  it('ignores malformed rename payloads safely', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);
    const events: ReaderChangeEvent[] = [];

    reader.changes$.subscribe(event => events.push(event));
    reader.start();

    adapter.emit('rename', makeFile('notes/new.md'), null);
    adapter.emit('rename', makeFile('notes/new.md'), '   ');

    expect(events).toHaveLength(0);
  });

  it('supports default structural file/folder guards', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFolder('notes'), makeFile('notes/a.md')]);
    const reader = makeReader(adapter, {}, true);

    await expect(reader.exists('notes/a.md', 'file')).resolves.toBe(true);
    await expect(reader.exists('notes', 'folder')).resolves.toBe(true);

    const folder = await reader.readFolder('notes');
    const file = await reader.readFile('notes/a.md');

    expect(folder?.path).toBe('notes');
    expect(file?.path).toBe('notes/a.md');
  });

  it('start and stop are idempotent and detach handlers', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);

    reader.start();
    reader.start();

    expect(adapter.listenerCount('create')).toBe(1);
    expect(adapter.listenerCount('modify')).toBe(1);
    expect(adapter.listenerCount('rename')).toBe(1);
    expect(adapter.listenerCount('delete')).toBe(1);

    reader.stop();
    reader.stop();

    expect(adapter.listenerCount('create')).toBe(0);
    expect(adapter.listenerCount('modify')).toBe(0);
    expect(adapter.listenerCount('rename')).toBe(0);
    expect(adapter.listenerCount('delete')).toBe(0);
  });

  it('dispose stops emissions and completes stream', () => {
    const adapter = new FakeVaultAdapter();
    const reader = makeReader(adapter);
    const events: ReaderChangeEvent[] = [];
    let completed = false;

    reader.changes$.subscribe({
      next: event => events.push(event),
      complete: () => {
        completed = true;
      }
    });

    reader.start();
    adapter.emit('create', makeFile('notes/one.md'));

    reader.dispose();
    adapter.emit('create', makeFile('notes/two.md'));

    expect(events.map(e => e.path)).toEqual(['notes/one.md']);
    expect(completed).toBe(true);
  });

  it('normalizes paths from input and events', async () => {
    const adapter = new FakeVaultAdapter();
    adapter.setEntries([makeFile('notes/weird.md')]);
    const reader = makeReader(adapter);

    const file = await reader.readFile('\\notes\\weird.md\\');
    expect(file?.path).toBe('notes/weird.md');

    const events: ReaderChangeEvent[] = [];
    reader.changes$.subscribe(event => events.push(event));
    reader.start();
    adapter.emit('rename', makeFolder('\\archive\\notes\\'), '\\notes\\archive\\');
    vi.advanceTimersByTime(251);

    expect(events[0]).toMatchObject({
      path: 'archive/notes',
      oldPath: 'notes/archive'
    });
  });
});
