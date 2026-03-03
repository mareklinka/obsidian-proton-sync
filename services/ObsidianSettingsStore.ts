import { Option } from 'effect';
import { BehaviorSubject } from 'rxjs';

import { ProtonEventId, ProtonFolderId } from './proton-drive-types';

import type { ProtonSession } from '../proton/auth/ProtonSession';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';

export const { init: initObsidianSettingsStore, get: getObsidianSettingsStore } = (function () {
  let instance: ObsidianSettingsStore | null = null;

  return {
    init: function initObsidianSettingsStore(callbacks: {
      load: () => Promise<PluginSettingsStorageModel | null>;
      save: (data: PluginSettingsStorageModel) => Promise<void>;
    }): ObsidianSettingsStore {
      return (instance ??= new ObsidianSettingsStore(callbacks));
    },
    get: function getObsidianSettingsStoreInstance(): ObsidianSettingsStore {
      if (!instance) {
        throw new Error('ObsidianSettingsStore has not been initialized. Please call initObsidianSettingsStore first.');
      }
      return instance;
    }
  };
})();

class ObsidianSettingsStore {
  private readonly settingsSubject = new BehaviorSubject<PluginSettings>({
    accountEmail: '',
    connectionStatus: 'disconnected',
    lastLoginAt: null,
    lastLoginError: null,
    lastRefreshAt: null,
    sessionExpiresAt: null,
    latestEventId: null,
    vaultRootNodeUid: null,
    enableFileLogging: false,
    logLevel: LogLevel.info,
    ignoredPaths: []
  });
  public readonly settings$ = this.settingsSubject.asObservable();

  public constructor(
    private readonly callbacks: {
      load: () => Promise<PluginSettingsStorageModel | null>;
      save: (data: PluginSettingsStorageModel) => Promise<void>;
    }
  ) {}

  public async load(): Promise<void> {
    const loaded = await this.callbacks.load();
    if (!loaded) {
      return;
    }

    this.settingsSubject.next({
      accountEmail: loaded.accountEmail,
      connectionStatus: loaded.connectionStatus,
      lastLoginAt: loaded.lastLoginAt ? new Date(loaded.lastLoginAt) : null,
      lastRefreshAt: loaded.lastRefreshAt ? new Date(loaded.lastRefreshAt) : null,
      sessionExpiresAt: loaded.sessionExpiresAt ? new Date(loaded.sessionExpiresAt) : null,
      lastLoginError: loaded.lastLoginError,
      latestEventId: loaded.latestEventId ? new ProtonEventId(loaded.latestEventId) : null,
      vaultRootNodeUid: loaded.vaultRootNodeUid ? new ProtonFolderId(loaded.vaultRootNodeUid) : null,
      enableFileLogging: loaded.enableFileLogging,
      logLevel: loaded.logLevel ?? LogLevel.info,
      ignoredPaths: loaded.ignoredPaths ?? []
    });

    this.settings$.subscribe(settings => {
      this.callbacks.save({
        accountEmail: settings.accountEmail,
        connectionStatus: settings.connectionStatus,
        lastLoginAt: settings.lastLoginAt ? settings.lastLoginAt.getTime() : null,
        lastRefreshAt: settings.lastRefreshAt ? settings.lastRefreshAt.getTime() : null,
        sessionExpiresAt: settings.sessionExpiresAt ? settings.sessionExpiresAt.getTime() : null,
        lastLoginError: settings.lastLoginError,
        latestEventId: settings.latestEventId?.eventId || null,
        vaultRootNodeUid: settings.vaultRootNodeUid?.uid || null,
        enableFileLogging: settings.enableFileLogging,
        logLevel: settings.logLevel,
        ignoredPaths: settings.ignoredPaths
      });
    });
  }

  public getLogLevel(): LogLevel {
    return this.settingsSubject.getValue().logLevel;
  }

  public setLogLevel(level: LogLevel): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      logLevel: level
    });
  }

  public getIgnoredPaths(): string[] {
    return this.settingsSubject.getValue().ignoredPaths;
  }

  public setIgnoredPaths(patterns: string[]): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      ignoredPaths: sanitizeIgnoredPaths(patterns)
    });
  }

  public getVaultRootNodeUid(): Option.Option<ProtonFolderId> {
    const settings = this.settingsSubject.getValue();
    if (settings.vaultRootNodeUid) {
      return Option.some(settings.vaultRootNodeUid);
    } else {
      return Option.none();
    }
  }

  public setVaultRootNodeUid(vaultRootNodeUid: ProtonFolderId | null): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      vaultRootNodeUid: vaultRootNodeUid
    });
  }

  public setAccountEmail(email: string): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      accountEmail: email
    });
  }

  public getLatestProtonEventId(): string | null {
    const settings = this.settingsSubject.getValue();
    return settings.latestEventId?.eventId || null;
  }

  public setLatestProtonEventId(eventId: ProtonEventId | null): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      latestEventId: eventId
    });
  }

  public setAuthenticationResult(session: Option.Option<ProtonSession>): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      ...(Option.isSome(session)
        ? {
            connectionStatus: 'connected',
            lastLoginError: null,
            lastLoginAt: session.value.updatedAt,
            lastRefreshAt: session.value.lastRefreshAt,
            sessionExpiresAt: session.value.expiresAt
          }
        : {
            connectionStatus: 'disconnected',
            sessionExpiresAt: null,
            lastLoginAt: null,
            lastRefreshAt: null
          })
    });
  }

  public reset() {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      accountEmail: '',
      connectionStatus: 'disconnected',
      lastLoginAt: null,
      lastLoginError: null,
      lastRefreshAt: null,
      sessionExpiresAt: null,
      latestEventId: null
    });
  }
}

interface PluginSettingsStorageModel {
  accountEmail: string;
  connectionStatus: ProtonAuthStatus;
  lastLoginAt: number | null;
  lastRefreshAt: number | null;
  sessionExpiresAt: number | null;
  lastLoginError: string | null;
  latestEventId: string | null;
  vaultRootNodeUid: string | null;
  enableFileLogging: boolean;
  logLevel: LogLevel;
  ignoredPaths?: string[];
}

export interface PluginSettings {
  accountEmail: string;
  connectionStatus: ProtonAuthStatus;
  lastLoginAt: Date | null;
  lastRefreshAt: Date | null;
  sessionExpiresAt: Date | null;
  lastLoginError: string | null;
  latestEventId: ProtonEventId | null;
  vaultRootNodeUid: ProtonFolderId | null;
  enableFileLogging: boolean;
  logLevel: LogLevel;
  ignoredPaths: string[];
}

export enum LogLevel {
  debug = 'debug',
  info = 'info',
  warn = 'warn',
  error = 'error'
}

function sanitizeIgnoredPaths(patterns: string[]): string[] {
  const sanitized: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) {
      continue;
    }

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    sanitized.push(trimmed);
  }

  return sanitized;
}
