import type { Vault } from 'obsidian';
import { describe, expect, it } from 'vitest';

import { VaultLogSink } from '../services/VaultLogSink';

const ACTIVE_LOG_PATH = '.obsidian/plugins/proton-drive-sync/logs/proton-drive-sync.log';
const ROTATED_LOG_PATH = '.obsidian/plugins/proton-drive-sync/logs/proton-drive-sync.log.1';

function createVault(adapter: InMemoryAdapter): Vault {
  return {
    adapter,
    configDir: '.obsidian'
  } as unknown as Vault;
}

class InMemoryAdapter {
  readonly #files = new Map<string, string>();
  readonly #dirs = new Set<string>();

  public async append(path: string, data: string): Promise<void> {
    const normalized = this.#normalize(path);
    const previous = this.#files.get(normalized) ?? '';
    this.#files.set(normalized, previous + data);
  }

  public async stat(path: string): Promise<{ size: number } | null> {
    const normalized = this.#normalize(path);
    const content = this.#files.get(normalized);
    if (content === undefined) {
      return null;
    }

    return { size: new TextEncoder().encode(content).length };
  }

  public async exists(path: string): Promise<boolean> {
    const normalized = this.#normalize(path);
    return this.#files.has(normalized) || this.#dirs.has(normalized);
  }

  public async remove(path: string): Promise<void> {
    const normalized = this.#normalize(path);
    this.#files.delete(normalized);
    this.#dirs.delete(normalized);
  }

  public async rename(from: string, to: string): Promise<void> {
    const normalizedFrom = this.#normalize(from);
    const normalizedTo = this.#normalize(to);
    const content = this.#files.get(normalizedFrom);
    if (content === undefined) {
      return;
    }

    this.#files.set(normalizedTo, content);
    this.#files.delete(normalizedFrom);
  }

  public async read(path: string): Promise<string> {
    return this.#files.get(this.#normalize(path)) ?? '';
  }

  public async write(path: string, data: string): Promise<void> {
    this.#files.set(this.#normalize(path), data);
  }

  public async mkdir(path: string): Promise<void> {
    this.#dirs.add(this.#normalize(path));
  }

  public readUnsafe(path: string): string {
    return this.#files.get(this.#normalize(path)) ?? '';
  }

  #normalize(path: string): string {
    return path
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
  }
}

describe('VaultLogSink', () => {
  it('appends formatted records to the active log file', async () => {
    const adapter = new InMemoryAdapter();
    const sink = new VaultLogSink(createVault(adapter));

    sink.write('info', 'SyncService', 'Pull completed', [{ files: 3 }]);
    sink.write('warn', undefined, 'Potential mismatch', []);
    await sink.flush();

    const content = adapter.readUnsafe(ACTIVE_LOG_PATH);

    expect(content).toContain('[INFO] [SyncService] Pull completed');
    expect(content).toContain('{"files":3}');
    expect(content).toContain('[WARN] Potential mismatch');
  });

  it('rotates the log when max size is exceeded and keeps one backup', async () => {
    const adapter = new InMemoryAdapter();
    const sink = new VaultLogSink(createVault(adapter));
    const largeFirstMessage = `first-entry-${'a'.repeat(600_000)}`;
    const largeSecondMessage = `second-entry-${'b'.repeat(600_000)}`;

    sink.write('info', 'Scope', largeFirstMessage, []);
    await sink.flush();

    const beforeRotation = adapter.readUnsafe(ACTIVE_LOG_PATH);
    expect(beforeRotation.length).toBeGreaterThan(0);

    sink.write('info', 'Scope', largeSecondMessage, []);
    await sink.flush();

    const active = adapter.readUnsafe(ACTIVE_LOG_PATH);
    const rotated = adapter.readUnsafe(ROTATED_LOG_PATH);

    expect(active).toContain('second-entry');
    expect(active).not.toContain('first-entry');
    expect(rotated).toContain('first-entry');
  });
});
