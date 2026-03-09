import { getObsidianSettingsStore } from './ObsidianSettingsStore';
import { getVaultLogSink } from './VaultLogSink';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export const getLogger = (function () {
  return function (scope: string): ConsoleLogger {
    return new ConsoleLogger(scope);
  };
})();

class ConsoleLogger {
  public constructor(private readonly scope: string | undefined = undefined) {}

  public withScope(scope: string): ConsoleLogger {
    return new ConsoleLogger(this.scope ? `${this.scope}:${scope}` : scope);
  }

  public debug(message: string, ...data: Array<unknown>): void {
    if (!this.#shouldLog('debug')) {
      return;
    }

    this.#emit('debug', 'debug', message, data);
  }

  public log(message: string, ...data: Array<unknown>): void {
    if (!this.#shouldLog('info')) {
      return;
    }

    this.#emit('info', 'log', message, data);
  }

  public warn(message: string, ...data: Array<unknown>): void {
    if (!this.#shouldLog('warn')) {
      return;
    }

    this.#emit('warn', 'warn', message, data);
  }

  public info(message: string, ...data: Array<unknown>): void {
    if (!this.#shouldLog('info')) {
      return;
    }

    this.#emit('info', 'info', message, data);
  }

  public error(message: string, ...data: Array<unknown>): void {
    if (!this.#shouldLog('error')) {
      return;
    }

    this.#emit('error', 'error', message, data);
  }

  #emit(
    level: LogLevel,
    output: 'debug' | 'log' | 'warn' | 'info' | 'error',
    message: string,
    data: Array<unknown>
  ): void {
    const prefix = `[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`;
    console[output](prefix, ...data);

    if (!this.#isFileLoggingEnabled()) {
      return;
    }

    try {
      getVaultLogSink().write(level, this.scope, message, data);
    } catch {
      // no-op; console logging should never depend on file sink lifecycle
    }
  }

  #shouldLog(level: LogLevel): boolean {
    return LOG_SEVERITY[level] >= LOG_SEVERITY[this.#getCurrentLevel()];
  }

  #getCurrentLevel(): LogLevel {
    try {
      return getObsidianSettingsStore().get('logLevel');
    } catch {
      return 'info';
    }
  }

  #isFileLoggingEnabled(): boolean {
    try {
      return getObsidianSettingsStore().get('enableFileLogging');
    } catch {
      return false;
    }
  }
}
