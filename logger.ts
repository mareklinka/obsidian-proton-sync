import { App } from 'obsidian';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerSettings {
  enabled: boolean;
  level: LogLevel;
  filePath: string;
  maxFileSizeBytes: number;
}

export interface PluginLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>, error?: unknown): void;
  error(message: string, context?: Record<string, unknown>, error?: unknown): void;
  updateSettings(settings: LoggerSettings): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const DEFAULT_MAX_BYTES = 1024 * 1024;

export function createFileLogger(app: App, settings: Partial<LoggerSettings>): PluginLogger {
  return new FileLogger(app, normalizeLoggerSettings(settings));
}

export function getDefaultLogFilePath(): string {
  return '.obsidian/plugins/proton-drive-sync/debug.log';
}

class FileLogger implements PluginLogger {
  private settings: LoggerSettings;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    settings: LoggerSettings
  ) {
    this.settings = settings;
  }

  updateSettings(settings: LoggerSettings): void {
    this.settings = normalizeLoggerSettings(settings);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.enqueue('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.enqueue('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>, error?: unknown): void {
    this.enqueue('warn', message, context, error);
  }

  error(message: string, context?: Record<string, unknown>, error?: unknown): void {
    this.enqueue('error', message, context, error);
  }

  private enqueue(level: LogLevel, message: string, context?: Record<string, unknown>, error?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry = formatLogEntry(level, message, context, error);

    this.writeChain = this.writeChain.then(() => this.appendEntry(entry)).catch(() => this.appendEntry(entry));
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.settings.enabled) {
      return false;
    }

    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.settings.level];
  }

  private async appendEntry(entry: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const filePath = this.settings.filePath;

    await this.ensureFile(filePath);
    await this.rotateIfNeeded(filePath);

    const maybeAppend = adapter as { append?: (path: string, data: string) => Promise<void> };

    if (typeof maybeAppend.append === 'function') {
      await maybeAppend.append(filePath, entry);
      return;
    }

    const existing = await adapter.read(filePath).catch(() => '');
    await adapter.write(filePath, `${existing}${entry}`);
  }

  private async ensureFile(filePath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const directory = filePath.split('/').slice(0, -1).join('/');

    if (directory) {
      const dirExists = await adapter.exists(directory);
      if (!dirExists) {
        await adapter.mkdir(directory);
      }
    }

    const fileExists = await adapter.exists(filePath);
    if (!fileExists) {
      await adapter.write(filePath, '');
    }
  }

  private async rotateIfNeeded(filePath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const maxBytes = this.settings.maxFileSizeBytes ?? DEFAULT_MAX_BYTES;

    const stat = await adapter.stat(filePath).catch(() => null);
    if (!stat || stat.size <= maxBytes) {
      return;
    }

    const contents = await adapter.read(filePath).catch(() => '');
    const keepBytes = Math.floor(maxBytes * 0.7);
    const trimmed = contents.slice(Math.max(0, contents.length - keepBytes));
    await adapter.write(filePath, trimmed);
  }
}

function normalizeLoggerSettings(settings: Partial<LoggerSettings>): LoggerSettings {
  return {
    enabled: settings.enabled ?? false,
    level: settings.level ?? 'info',
    filePath: settings.filePath ?? getDefaultLogFilePath(),
    maxFileSizeBytes: settings.maxFileSizeBytes ?? DEFAULT_MAX_BYTES
  };
}

function formatLogEntry(level: LogLevel, message: string, context?: Record<string, unknown>, error?: unknown): string {
  const timestamp = new Date().toISOString();
  const levelLabel = level.toUpperCase();
  const contextText = context ? ` ${safeStringify(context)}` : '';
  const errorText = error ? ` ${formatError(error)}` : '';
  return `${timestamp} ${levelLabel} ${message}${contextText}${errorText}\n`;
}

function formatError(error: unknown): string {
  if (!error) {
    return '';
  }

  if (error instanceof Error) {
    return error.stack ? `error=${error.message} stack=${error.stack}` : `error=${error.message}`;
  }

  return `error=${safeStringify(error)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (entry instanceof Error) {
        return { message: entry.message, stack: entry.stack };
      }
      return entry;
    });
  } catch {
    return '[unserializable]';
  }
}
