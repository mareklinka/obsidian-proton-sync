import { getObsidianSettingsStore } from './ObsidianSettingsStore';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export const getLogger = (function () {
  return function (scope: string): ObsidianSyncLogger {
    return new ObsidianSyncLogger(scope);
  };
})();

class ObsidianSyncLogger {
  public constructor(private readonly scope: string | undefined = undefined) {}

  public withScope(scope: string): ObsidianSyncLogger {
    return new ObsidianSyncLogger(this.scope ? `${this.scope}:${scope}` : scope);
  }

  public debug(message: string, ...data: unknown[]): void {
    if (!this.shouldLog('debug')) {
      return;
    }

    console.debug(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public log(message: string, ...data: unknown[]): void {
    if (!this.shouldLog('info')) {
      return;
    }

    console.log(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public warn(message: string, ...data: unknown[]): void {
    if (!this.shouldLog('warn')) {
      return;
    }

    console.warn(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public info(message: string, ...data: unknown[]): void {
    if (!this.shouldLog('info')) {
      return;
    }

    console.info(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public error(message: string, ...data: unknown[]): void {
    if (!this.shouldLog('error')) {
      return;
    }

    console.error(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_SEVERITY[level] >= LOG_SEVERITY[this.getCurrentLevel()];
  }

  private getCurrentLevel(): LogLevel {
    try {
      return getObsidianSettingsStore().getLogLevel();
    } catch {
      return 'info';
    }
  }
}
