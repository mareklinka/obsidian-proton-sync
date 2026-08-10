import type { EntityResult, ProtonDriveCache } from '@protontech/drive-sdk';
import type { Vault } from 'obsidian';
import { normalizePath } from 'obsidian';

import { getLogger } from '../../services/ConsoleLogger';

const CACHE_DIRECTORY = '/plugins/proton-drive-sync/cache';
const CACHE_FILENAME = 'entities-cache.json.gz';
const FLUSH_DEBOUNCE_MS = 500;
const COMPRESSION_FORMAT = 'gzip';
const CACHE_VERSION = 1;

interface PersistedEntitiesCacheData {
  version?: number;
  accountFingerprint?: string | null;
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

export const { init: initPersistentEntitiesCache, get: getPersistentEntitiesCache } = (function (): {
  init: (this: void, vault: Vault, persistenceEnabled: boolean) => PersistentEntitiesCache;
  get: (this: void) => PersistentEntitiesCache;
} {
  let instance: PersistentEntitiesCache | null = null;

  return {
    init: function (this: void, vault: Vault, persistenceEnabled: boolean): PersistentEntitiesCache {
      return (instance ??= new PersistentEntitiesCache(vault, persistenceEnabled));
    },
    get: function (this: void): PersistentEntitiesCache {
      if (!instance) {
        throw new Error(
          'PersistentEntitiesCache has not been initialized. Please call initPersistentEntitiesCache first.'
        );
      }
      return instance;
    }
  };
})();

/**
 * Persistent implementation of the Proton Drive SDK's entities cache,
 * backed by a JSON file on the Obsidian vault adapter. Mirrors the SDK's
 * in-memory MemoryCache semantics, but survives plugin/app restarts so
 * repeat syncs don't re-fetch and re-decrypt unchanged remote nodes.
 *
 * The SDK caches `DecryptedNode`s, which carry both the encrypted name and the decrypted
 * plaintext one, plus owner/author email addresses, sizes, timestamps and the tree shape.
 * None of that is re-encrypted on the way to disk, so persistence is opt-in per device and
 * the file is destroyed as soon as the session it belongs to goes away.
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

  /** Whether the user has opted into persisting the cache on this device. */
  #persistenceEnabled: boolean;

  /**
   * Set when the cache is destroyed because the session went away. The SDK may still
   * hold this instance and keep mutating it, so writes stay blocked until a new session
   * binds to the cache (or the user toggles the setting back on).
   */
  #sealed = false;

  /** Fingerprint of the account the persisted data belongs to; `null` until known. */
  #accountFingerprint: string | null = null;

  public constructor(
    private readonly vault: Vault,
    persistenceEnabled = true
  ) {
    const cacheDirectory = normalizePath(vault.configDir + CACHE_DIRECTORY);
    this.#cachePath = normalizePath(`${cacheDirectory}/${CACHE_FILENAME}`);
    this.#persistenceEnabled = persistenceEnabled;
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

  /**
   * Applies the user setting. Turning persistence off destroys whatever is already
   * on disk; the cache keeps working in memory for the remainder of the session.
   */
  public async setPersistenceEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.#persistenceEnabled) {
      return;
    }

    this.#persistenceEnabled = enabled;

    if (!enabled) {
      this.#logger.info('Persistent entities cache disabled, removing cached data from disk');
      await this.destroy();
      return;
    }

    this.#sealed = false;
    this.#scheduleFlush();
  }

  /**
   * Binds the cache to the signed-in account. Data cached for a different account is
   * discarded, and a cache sealed by a previous logout is reopened for writing.
   */
  public async bindToAccount(accountFingerprint: string): Promise<void> {
    await this.#ready;

    if (this.#accountFingerprint !== null && this.#accountFingerprint !== accountFingerprint) {
      this.#logger.info('Persisted entities cache belongs to a different account, discarding it');
      await this.destroy();
    }

    this.#sealed = false;

    if (this.#accountFingerprint !== accountFingerprint) {
      this.#accountFingerprint = accountFingerprint;
      this.#scheduleFlush();
    }
  }

  /**
   * Drops all cached data and removes the persisted file. Called whenever the session
   * is gone: explicit disconnect, forced sign-out, or a startup with no session at all.
   */
  public async destroy(): Promise<void> {
    await this.#ready;

    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }

    this.#entities = {};
    this.#entitiesByTag = {};
    this.#accountFingerprint = null;
    this.#dirty = false;
    this.#sealed = true;

    // Queued behind any in-flight write so a flush that is already running
    // cannot recreate the file after it has been removed.
    this.#writeQueue = this.#writeQueue
      .then(async () => {
        if (await this.vault.adapter.exists(this.#cachePath)) {
          await this.vault.adapter.remove(this.#cachePath);
        }
      })
      .catch(error => {
        this.#logger.warn('Failed to remove persisted entities cache', { error });
      });

    await this.#writeQueue;
  }

  async #load(): Promise<void> {
    try {
      if (!(await this.vault.adapter.exists(this.#cachePath))) {
        return;
      }

      if (!this.#persistenceEnabled) {
        // Persistence is off (or was just turned off) - drop anything a previous run left behind.
        await this.vault.adapter.remove(this.#cachePath);
        return;
      }

      const compressed = await this.vault.adapter.readBinary(this.#cachePath);
      const raw = await decompress(compressed);
      const parsed = JSON.parse(raw) as PersistedEntitiesCacheData;

      if ((parsed.version ?? CACHE_VERSION) !== CACHE_VERSION) {
        this.#logger.info('Discarding persisted entities cache written in an unsupported format');
        await this.vault.adapter.remove(this.#cachePath);
        return;
      }

      this.#entities = parsed.entities ?? {};
      this.#entitiesByTag = parsed.entitiesByTag ?? {};
      this.#accountFingerprint = parsed.accountFingerprint ?? null;
    } catch (error) {
      this.#logger.warn('Failed to load persisted entities cache, starting empty', { error });
      this.#entities = {};
      this.#entitiesByTag = {};
      this.#accountFingerprint = null;
    }
  }

  #canPersist(): boolean {
    return this.#persistenceEnabled && !this.#sealed;
  }

  #scheduleFlush(): void {
    this.#dirty = true;

    if (!this.#canPersist() || this.#flushTimer) {
      return;
    }

    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#persist();
    }, FLUSH_DEBOUNCE_MS);
  }

  async #persist(): Promise<void> {
    if (!this.#canPersist() || !this.#dirty) {
      return;
    }
    this.#dirty = false;

    const data: PersistedEntitiesCacheData = {
      version: CACHE_VERSION,
      accountFingerprint: this.#accountFingerprint,
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
