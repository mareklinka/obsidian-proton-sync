export const getLogger = (function () {
  return function (scope: string): ObsidianSyncLogger {
    return new ObsidianSyncLogger(scope);
  };
})();

class ObsidianSyncLogger {
  public constructor(private readonly scope: string | undefined = undefined) {}
  public debug(message: string, ...data: unknown[]): void {
    console.debug(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public log(message: string, ...data: unknown[]): void {
    console.log(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public warn(message: string, ...data: unknown[]): void {
    console.warn(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public info(message: string, ...data: unknown[]): void {
    console.info(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }

  public error(message: string, ...data: unknown[]): void {
    console.error(`[ObsidianSync]${this.scope ? ` [${this.scope}]` : ''} ${message}`, ...data);
  }
}
