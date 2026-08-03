import type { EntityResult, ProtonDriveCache } from '@protontech/drive-sdk';
import type { Vault } from 'obsidian';
import { normalizePath } from 'obsidian';

import { getLogger } from '../../services/ConsoleLogger';

const CACHE_DIRECTORY = '/plugins/proton-drive-sync/cache';
const CACHE_FILENAME = 'entities-cache.json.gz';
const FLUSH_DEBOUNCE_MS = 500;
const COMPRESSION_FORMAT = 'gzip';

interface PersistedEntitiesCacheData {
  entities: Record<string, string>;
  entitiesByTag: Record<string, Array<string>>;
}

async function compress(text: string): Promise<ArrayBuffer> {
  const source = bytesToStream(new TextEncoder().encode(text));
  const stream = pipeThroughTransform(source, new CompressionStream(COMPRESSION_FORMAT));
  return await readAllBytes(stream);
}

async function decompress(data: ArrayBuffer): Promise<string> {
  const source = bytesToStream(new Uint8Array(data));
  const stream = pipeThroughTransform(source, new DecompressionStream(COMPRESSION_FORMAT));
  return new TextDecoder().decode(await readAllBytes(stream));
}

/**
 * lib.dom's `GenericTransformStream` types `writable` as `WritableStream<BufferSource>`,
 * which TS won't structurally match against `ReadableWritablePair<Uint8Array, Uint8Array>`
 * for `pipeThrough`, even though it's exactly what CompressionStream/DecompressionStream are.
 */
function pipeThroughTransform(
  source: ReadableStream<Uint8Array>,
  transform: GenericTransformStream
): ReadableStream<Uint8Array> {
  return source.pipeThrough(transform as ReadableWritablePair<Uint8Array, Uint8Array>);
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller): void => {
      controller.enqueue(bytes);
      controller.close();
    }
  });
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

/**
 * Persistent implementation of the Proton Drive SDK's entities cache,
 * backed by a JSON file on the Obsidian vault adapter. Mirrors the SDK's
 * in-memory MemoryCache semantics, but survives plugin/app restarts so
 * repeat syncs don't re-fetch and re-decrypt unchanged remote nodes.
 */
export class PersistentEntitiesCache implements ProtonDriveCache<string> {
  readonly #logger = getLogger('PersistentEntitiesCache');
  readonly #cachePath: string;
  readonly #ready: Promise<void>;

  #entities: Record<string, string> = {};
  #entitiesByTag: Record<string, Array<string>> = {};
  #dirty = false;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly vault: Vault) {
    const cacheDirectory = normalizePath(vault.configDir + CACHE_DIRECTORY);
    this.#cachePath = normalizePath(`${cacheDirectory}/${CACHE_FILENAME}`);
    this.#ready = this.#load();
  }

  public async clear(): Promise<void> {
    await this.#ready;

    this.#entities = {};
    this.#entitiesByTag = {};
    this.#scheduleFlush();
  }

  public async setEntity(key: string, value: string, tags?: Array<string>): Promise<void> {
    await this.#ready;

    this.#entities[key] = value;

    for (const tag of Object.keys(this.#entitiesByTag)) {
      const index = this.#entitiesByTag[tag].indexOf(key);
      if (index !== -1) {
        this.#entitiesByTag[tag].splice(index, 1);
        if (this.#entitiesByTag[tag].length === 0) {
          delete this.#entitiesByTag[tag];
        }
      }
    }

    if (tags) {
      for (const tag of tags) {
        (this.#entitiesByTag[tag] ??= []).push(key);
      }
    }

    this.#scheduleFlush();
  }

  public async getEntity(key: string): Promise<string> {
    await this.#ready;

    const value = this.#entities[key];
    if (!value) {
      throw new Error('Entity not found');
    }

    return value;
  }

  public async *iterateEntities(keys: Array<string>): AsyncGenerator<EntityResult<string>> {
    await this.#ready;

    for (const key of keys) {
      try {
        const value = await this.getEntity(key);
        yield { key, ok: true, value };
      } catch (error) {
        yield { key, ok: false, error: `${error}` };
      }
    }
  }

  public async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<string>> {
    await this.#ready;

    if (!(tag in this.#entitiesByTag)) {
      return;
    }

    const keys = this.#entitiesByTag[tag];

    // Pass a copy so concurrent mutations don't affect an in-flight iteration.
    yield* this.iterateEntities([...keys]);
  }

  public async removeEntities(keys: Array<string>): Promise<void> {
    await this.#ready;

    for (const key of keys) {
      delete this.#entities[key];
      for (const tagKeys of Object.values(this.#entitiesByTag)) {
        const index = tagKeys.indexOf(key);
        if (index !== -1) {
          tagKeys.splice(index, 1);
        }
      }
    }

    this.#scheduleFlush();
  }

  /** Forces any pending debounced write to disk immediately. */
  public async flush(): Promise<void> {
    await this.#ready;

    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }

    await this.#persist();
  }

  async #load(): Promise<void> {
    try {
      if (!(await this.vault.adapter.exists(this.#cachePath))) {
        return;
      }

      const compressed = await this.vault.adapter.readBinary(this.#cachePath);
      const raw = await decompress(compressed);
      const parsed = JSON.parse(raw) as PersistedEntitiesCacheData;
      this.#entities = parsed.entities ?? {};
      this.#entitiesByTag = parsed.entitiesByTag ?? {};
    } catch (error) {
      this.#logger.warn('Failed to load persisted entities cache, starting empty', { error });
      this.#entities = {};
      this.#entitiesByTag = {};
    }
  }

  #scheduleFlush(): void {
    this.#dirty = true;

    if (this.#flushTimer) {
      return;
    }

    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#persist();
    }, FLUSH_DEBOUNCE_MS);
  }

  async #persist(): Promise<void> {
    if (!this.#dirty) {
      return;
    }
    this.#dirty = false;

    const data: PersistedEntitiesCacheData = {
      entities: this.#entities,
      entitiesByTag: this.#entitiesByTag
    };
    const serialized = JSON.stringify(data);

    this.#writeQueue = this.#writeQueue
      .then(async () => {
        const compressed = await compress(serialized);
        await this.#ensureCacheDirectory();
        await this.vault.adapter.writeBinary(this.#cachePath, compressed);
      })
      .catch(error => {
        this.#logger.warn('Failed to persist entities cache', { error });
      });

    await this.#writeQueue;
  }

  async #ensureCacheDirectory(): Promise<void> {
    const cacheDir = this.#cachePath.split('/').slice(0, -1).join('/');
    if (!cacheDir) {
      return;
    }

    const segments = cacheDir.split('/').filter(Boolean);
    let current = '';

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const exists = await this.vault.adapter.exists(current);
      if (!exists) {
        await this.vault.adapter.mkdir(current);
      }
    }
  }
}
