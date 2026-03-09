import type { Vault } from 'obsidian';
import { normalizePath } from 'obsidian';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB
const LOG_DIRECTORY = '/plugins/proton-drive-sync/logs';
const LOG_FILENAME = 'proton-drive-sync.log';

const textEncoder = new TextEncoder();

export const { init: initVaultLogSink, get: getVaultLogSink } = (function (): {
  init: (this: void, vault: Vault) => VaultLogSink;
  get: (this: void) => VaultLogSink;
} {
  let instance: VaultLogSink | null = null;

  return {
    init: function (this: void, vault: Vault): VaultLogSink {
      return (instance ??= new VaultLogSink(vault));
    },
    get: function (this: void): VaultLogSink {
      if (!instance) {
        throw new Error('VaultLogSink has not been initialized. Please call initVaultLogSink first.');
      }

      return instance;
    }
  };
})();

export class VaultLogSink {
  readonly #activeLogPath: string;
  readonly #rotatedLogPath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly vault: Vault) {
    const logDirectory = normalizePath(vault.configDir + LOG_DIRECTORY);
    const logFilename = LOG_FILENAME;

    this.#activeLogPath = normalizePath(`${logDirectory}/${logFilename}`);
    this.#rotatedLogPath = normalizePath(`${logDirectory}/${logFilename}.1`);
  }

  public write(level: LogLevel, scope: string | undefined, message: string, data: Array<unknown>): void {
    const formattedLine = this.#formatLine(level, scope, message, data);

    this.#writeQueue = this.#writeQueue
      .then(async () => {
        await this.#ensureLogDirectory();
        await this.#rotateIfNeeded(this.#byteLength(formattedLine));
        await this.vault.adapter.append(this.#activeLogPath, formattedLine);
      })
      .catch(() => {
        // swallow sink errors to avoid affecting app behavior
      });
  }

  public async flush(): Promise<void> {
    await this.#writeQueue;
  }

  #formatLine(level: LogLevel, scope: string | undefined, message: string, data: Array<unknown>): string {
    const timestamp = new Date().toISOString();
    const levelLabel = level.toUpperCase();
    const scopeLabel = scope ? ` [${scope}]` : '';
    const serializedData = data.length > 0 ? ` ${this.#serializeData(data)}` : '';

    return `${timestamp} [${levelLabel}]${scopeLabel} ${message}${serializedData}\n`;
  }

  #serializeData(data: Array<unknown>): string {
    return data
      .map(item => {
        if (item instanceof Error) {
          return JSON.stringify({
            name: item.name,
            message: item.message,
            stack: item.stack
          });
        }

        if (typeof item === 'string') {
          return item;
        }

        try {
          return JSON.stringify(item);
        } catch {
          return '[unserializable]';
        }
      })
      .join(' ');
  }

  #byteLength(value: string): number {
    return textEncoder.encode(value).length;
  }

  async #rotateIfNeeded(incomingBytes: number): Promise<void> {
    const stat = await this.vault.adapter.stat(this.#activeLogPath);
    const currentSize = stat?.size ?? 0;

    if (currentSize + incomingBytes <= MAX_FILE_SIZE_BYTES) {
      return;
    }

    if (await this.vault.adapter.exists(this.#rotatedLogPath)) {
      await this.vault.adapter.remove(this.#rotatedLogPath);
    }

    if (!(await this.vault.adapter.exists(this.#activeLogPath))) {
      return;
    }

    await this.vault.adapter.rename(this.#activeLogPath, this.#rotatedLogPath);
  }

  async #ensureLogDirectory(): Promise<void> {
    const logDir = this.#activeLogPath.split('/').slice(0, -1).join('/');
    if (!logDir) {
      return;
    }

    const segments = logDir.split('/').filter(Boolean);
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
