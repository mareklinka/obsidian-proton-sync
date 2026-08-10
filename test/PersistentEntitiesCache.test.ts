import type { Vault } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PersistentEntitiesCache } from '../proton/drive/PersistentEntitiesCache';

const CACHE_PATH = '.obsidian/plugins/proton-drive-sync/cache/entities-cache.json.gz';

async function collectAsync<T>(iterable: AsyncGenerator<T>): Promise<Array<T>> {
  const results: Array<T> = [];
  for await (const value of iterable) {
    results.push(value);
  }
  return results;
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged.buffer;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller): void => {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function pipeThroughTransform(
  source: ReadableStream<Uint8Array>,
  transform: GenericTransformStream
): ReadableStream<Uint8Array> {
  return source.pipeThrough(transform as ReadableWritablePair<Uint8Array, Uint8Array>);
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = pipeThroughTransform(bytesToStream(new TextEncoder().encode(text)), new CompressionStream('gzip'));
  return await readAllBytes(stream);
}

async function gunzip(data: ArrayBuffer): Promise<string> {
  const stream = pipeThroughTransform(bytesToStream(new Uint8Array(data)), new DecompressionStream('gzip'));
  return new TextDecoder().decode(await readAllBytes(stream));
}

function createVault(adapter: InMemoryAdapter): Vault {
  return {
    adapter,
    configDir: '.obsidian'
  } as unknown as Vault;
}

class InMemoryAdapter {
  readonly #files = new Map<string, ArrayBuffer>();
  readonly #dirs = new Set<string>();
  public readonly mkdirCalls: Array<string> = [];
  public readonly writeCalls: Array<string> = [];
  public readonly removeCalls: Array<string> = [];

  public async exists(path: string): Promise<boolean> {
    const normalized = this.#normalize(path);
    return this.#files.has(normalized) || this.#dirs.has(normalized);
  }

  public async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.#files.get(this.#normalize(path));
    if (value === undefined) {
      throw new Error('File does not exist');
    }
    return value;
  }

  public async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = this.#normalize(path);
    this.#files.set(normalized, data);
    this.writeCalls.push(normalized);
  }

  public async remove(path: string): Promise<void> {
    const normalized = this.#normalize(path);
    this.#files.delete(normalized);
    this.removeCalls.push(normalized);
  }

  public async mkdir(path: string): Promise<void> {
    const normalized = this.#normalize(path);
    this.#dirs.add(normalized);
    this.mkdirCalls.push(normalized);
  }

  public async seedGzipped(path: string, data: string): Promise<void> {
    this.#files.set(this.#normalize(path), await gzip(data));
  }

  public seedRaw(path: string, data: ArrayBuffer): void {
    this.#files.set(this.#normalize(path), data);
  }

  public async readGunzipped(path: string): Promise<string | undefined> {
    const value = this.#files.get(this.#normalize(path));
    return value === undefined ? undefined : await gunzip(value);
  }

  #normalize(path: string): string {
    return path
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
  }
}

describe('PersistentEntitiesCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when getting an entity that was never set', async () => {
    const cache = new PersistentEntitiesCache(createVault(new InMemoryAdapter()));

    await expect(cache.getEntity('missing')).rejects.toThrowError(/entity not found/i);
  });

  it('stores and retrieves an entity before it has been flushed to disk', async () => {
    const cache = new PersistentEntitiesCache(createVault(new InMemoryAdapter()));

    await cache.setEntity('node-1', 'serialized-node-1');

    await expect(cache.getEntity('node-1')).resolves.toBe('serialized-node-1');
  });

  it('associates and iterates entities by tag', async () => {
    const cache = new PersistentEntitiesCache(createVault(new InMemoryAdapter()));

    await cache.setEntity('node-1', 'value-1', ['parentUid:root']);
    await cache.setEntity('node-2', 'value-2', ['parentUid:root']);
    await cache.setEntity('node-3', 'value-3', ['parentUid:other']);

    const results = await collectAsync(cache.iterateEntitiesByTag('parentUid:root'));

    expect(results).toEqual([
      { key: 'node-1', ok: true, value: 'value-1' },
      { key: 'node-2', ok: true, value: 'value-2' }
    ]);
  });

  it('re-tagging an entity removes it from its previous tags', async () => {
    const cache = new PersistentEntitiesCache(createVault(new InMemoryAdapter()));

    await cache.setEntity('node-1', 'value-1', ['parentUid:folder-a']);
    await cache.setEntity('node-1', 'value-1-moved', ['parentUid:folder-b']);

    const oldTag = await collectAsync(cache.iterateEntitiesByTag('parentUid:folder-a'));
    const newTag = await collectAsync(cache.iterateEntitiesByTag('parentUid:folder-b'));

    expect(oldTag).toEqual([]);
    expect(newTag).toEqual([{ key: 'node-1', ok: true, value: 'value-1-moved' }]);
  });

  it('removes entities from storage and from tag indexes', async () => {
    const cache = new PersistentEntitiesCache(createVault(new InMemoryAdapter()));

    await cache.setEntity('node-1', 'value-1', ['parentUid:root']);
    await cache.removeEntities(['node-1']);

    await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
    await expect(collectAsync(cache.iterateEntitiesByTag('parentUid:root'))).resolves.toEqual([]);
  });

  it('reports missing keys as non-ok results without throwing', async () => {
    const cache = new PersistentEntitiesCache(createVault(new InMemoryAdapter()));

    await cache.setEntity('node-1', 'value-1');

    const results = await collectAsync(cache.iterateEntities(['node-1', 'missing']));

    expect(results[0]).toEqual({ key: 'node-1', ok: true, value: 'value-1' });
    expect(results[1]).toMatchObject({ key: 'missing', ok: false });
  });

  it('clear empties both entities and tag indexes', async () => {
    const cache = new PersistentEntitiesCache(createVault(new InMemoryAdapter()));

    await cache.setEntity('node-1', 'value-1', ['parentUid:root']);
    await cache.clear();

    await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
    await expect(collectAsync(cache.iterateEntitiesByTag('parentUid:root'))).resolves.toEqual([]);
  });

  it('coalesces rapid mutations into a single debounced write', async () => {
    const adapter = new InMemoryAdapter();
    const cache = new PersistentEntitiesCache(createVault(adapter));

    await cache.setEntity('node-1', 'value-1');
    await cache.setEntity('node-2', 'value-2');
    await cache.setEntity('node-3', 'value-3');

    expect(adapter.writeCalls).toHaveLength(0);

    await vi.runAllTimersAsync();
    // The debounced write compresses off the timer queue, so wait for it to land.
    await vi.waitFor(() => expect(adapter.writeCalls).toHaveLength(1));

    const persisted = JSON.parse((await adapter.readGunzipped(CACHE_PATH)) ?? '{}');
    expect(persisted.entities).toEqual(
      Object.fromEntries([
        ['node-1', 'value-1'],
        ['node-2', 'value-2'],
        ['node-3', 'value-3']
      ])
    );
  });

  it('flush() writes pending changes immediately and cancels the debounce timer', async () => {
    const adapter = new InMemoryAdapter();
    const cache = new PersistentEntitiesCache(createVault(adapter));

    await cache.setEntity('node-1', 'value-1');
    await cache.flush();

    expect(adapter.writeCalls).toHaveLength(1);

    // No further write should happen once the (now-cancelled) debounce timer would have fired.
    await vi.runAllTimersAsync();
    expect(adapter.writeCalls).toHaveLength(1);
  });

  it('creates the cache directory hierarchy before writing', async () => {
    const adapter = new InMemoryAdapter();
    const cache = new PersistentEntitiesCache(createVault(adapter));

    await cache.setEntity('node-1', 'value-1');
    await cache.flush();

    expect(adapter.mkdirCalls).toEqual([
      '.obsidian',
      '.obsidian/plugins',
      '.obsidian/plugins/proton-drive-sync',
      '.obsidian/plugins/proton-drive-sync/cache'
    ]);
  });

  it('loads previously persisted (gzip-compressed) entities on construction', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.seedGzipped(
      CACHE_PATH,
      JSON.stringify({
        entities: Object.fromEntries([['node-1', 'value-1']]),
        entitiesByTag: Object.fromEntries([['parentUid:root', ['node-1']]])
      })
    );

    const cache = new PersistentEntitiesCache(createVault(adapter));

    await expect(cache.getEntity('node-1')).resolves.toBe('value-1');
    await expect(collectAsync(cache.iterateEntitiesByTag('parentUid:root'))).resolves.toEqual([
      { key: 'node-1', ok: true, value: 'value-1' }
    ]);
  });

  it('starts empty if the persisted cache file is not valid gzip data', async () => {
    const adapter = new InMemoryAdapter();
    adapter.seedRaw(CACHE_PATH, new TextEncoder().encode('not-valid-gzip-data').buffer);

    const cache = new PersistentEntitiesCache(createVault(adapter));

    await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
  });

  it('round-trips through gzip so persisted bytes are smaller than the raw JSON for repetitive data', async () => {
    const adapter = new InMemoryAdapter();
    const cache = new PersistentEntitiesCache(createVault(adapter));

    const repetitiveValue = 'x'.repeat(2000);
    for (let index = 0; index < 20; index += 1) {
      await cache.setEntity(`node-${index}`, repetitiveValue, ['parentUid:root']);
    }
    await cache.flush();

    const rawJson = JSON.stringify({
      version: 1,
      accountFingerprint: null,
      entities: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`node-${index}`, repetitiveValue])),
      entitiesByTag: Object.fromEntries([['parentUid:root', Array.from({ length: 20 }, (_, index) => `node-${index}`)]])
    });
    const persistedBytes = await adapter.readBinary(CACHE_PATH);

    expect(persistedBytes.byteLength).toBeLessThan(new TextEncoder().encode(rawJson).byteLength);

    const roundTripped = await adapter.readGunzipped(CACHE_PATH);
    expect(JSON.parse(roundTripped ?? '{}')).toEqual(JSON.parse(rawJson));
  });

  describe('persistence setting', () => {
    it('never touches disk while persistence is disabled', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), false);

      await cache.setEntity('node-1', 'value-1');
      await vi.runAllTimersAsync();
      await cache.flush();

      expect(adapter.writeCalls).toHaveLength(0);
      // Still a working in-memory cache for the rest of the session.
      await expect(cache.getEntity('node-1')).resolves.toBe('value-1');
    });

    it('removes a cache file left behind by a previous run when persistence is disabled', async () => {
      const adapter = new InMemoryAdapter();
      await adapter.seedGzipped(
        CACHE_PATH,
        JSON.stringify({
          entities: Object.fromEntries([['node-1', 'value-1']]),
          entitiesByTag: {}
        })
      );

      const cache = new PersistentEntitiesCache(createVault(adapter), false);

      await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
      expect(adapter.removeCalls).toEqual([CACHE_PATH]);
      expect(await adapter.exists(CACHE_PATH)).toBe(false);
    });

    it('destroys the persisted file when persistence is turned off', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), true);

      await cache.setEntity('node-1', 'value-1');
      await cache.flush();
      expect(await adapter.exists(CACHE_PATH)).toBe(true);

      await cache.setPersistenceEnabled(false);

      expect(await adapter.exists(CACHE_PATH)).toBe(false);
      await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
    });

    it('resumes persisting when the setting is turned back on', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), false);

      await cache.setEntity('node-1', 'value-1');
      await cache.setPersistenceEnabled(true);
      await cache.flush();

      const persisted = JSON.parse((await adapter.readGunzipped(CACHE_PATH)) ?? '{}');
      expect(persisted.entities).toEqual(Object.fromEntries([['node-1', 'value-1']]));
    });

    it('discards a cache file written in an unsupported format', async () => {
      const adapter = new InMemoryAdapter();
      await adapter.seedGzipped(
        CACHE_PATH,
        JSON.stringify({ version: 99, entities: Object.fromEntries([['node-1', 'value-1']]), entitiesByTag: {} })
      );

      const cache = new PersistentEntitiesCache(createVault(adapter), true);

      await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
      expect(await adapter.exists(CACHE_PATH)).toBe(false);
    });
  });

  describe('destroy', () => {
    it('drops cached data and removes the persisted file', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), true);

      await cache.setEntity('node-1', 'value-1', ['parentUid:root']);
      await cache.flush();

      await cache.destroy();

      expect(await adapter.exists(CACHE_PATH)).toBe(false);
      await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
      await expect(collectAsync(cache.iterateEntitiesByTag('parentUid:root'))).resolves.toEqual([]);
    });

    it('a pending debounced write cannot resurrect the file after destroy', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), true);

      await cache.setEntity('node-1', 'value-1');
      await cache.destroy();

      await vi.runAllTimersAsync();
      await cache.flush();

      expect(await adapter.exists(CACHE_PATH)).toBe(false);
    });

    it('keeps the file destroyed while the SDK keeps writing to a sealed cache', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), true);

      await cache.setEntity('node-1', 'value-1');
      await cache.flush();
      await cache.destroy();

      // The SDK may still hold the instance after a forced sign-out.
      await cache.setEntity('node-2', 'value-2');
      await vi.runAllTimersAsync();
      await cache.flush();

      expect(await adapter.exists(CACHE_PATH)).toBe(false);
    });
  });

  describe('account binding', () => {
    it('persists the bound account fingerprint', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), true);

      await cache.bindToAccount('fingerprint-a');
      await cache.setEntity('node-1', 'value-1');
      await cache.flush();

      const persisted = JSON.parse((await adapter.readGunzipped(CACHE_PATH)) ?? '{}');
      expect(persisted.accountFingerprint).toBe('fingerprint-a');
    });

    it('discards data cached for a different account', async () => {
      const adapter = new InMemoryAdapter();
      await adapter.seedGzipped(
        CACHE_PATH,
        JSON.stringify({
          version: 1,
          accountFingerprint: 'fingerprint-a',
          entities: Object.fromEntries([['node-1', 'value-1']]),
          entitiesByTag: {}
        })
      );

      const cache = new PersistentEntitiesCache(createVault(adapter), true);
      await cache.bindToAccount('fingerprint-b');

      await expect(cache.getEntity('node-1')).rejects.toThrowError(/entity not found/i);
    });

    it('keeps data cached for the same account', async () => {
      const adapter = new InMemoryAdapter();
      await adapter.seedGzipped(
        CACHE_PATH,
        JSON.stringify({
          version: 1,
          accountFingerprint: 'fingerprint-a',
          entities: Object.fromEntries([['node-1', 'value-1']]),
          entitiesByTag: {}
        })
      );

      const cache = new PersistentEntitiesCache(createVault(adapter), true);
      await cache.bindToAccount('fingerprint-a');

      await expect(cache.getEntity('node-1')).resolves.toBe('value-1');
    });

    it('reopens a cache sealed by a previous sign-out when a new session binds', async () => {
      const adapter = new InMemoryAdapter();
      const cache = new PersistentEntitiesCache(createVault(adapter), true);

      await cache.destroy();
      await cache.bindToAccount('fingerprint-a');

      await cache.setEntity('node-1', 'value-1');
      await cache.flush();

      const persisted = JSON.parse((await adapter.readGunzipped(CACHE_PATH)) ?? '{}');
      expect(persisted.entities).toEqual(Object.fromEntries([['node-1', 'value-1']]));
    });
  });
});
