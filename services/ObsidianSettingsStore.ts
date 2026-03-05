import { Option } from 'effect';
import { BehaviorSubject } from 'rxjs';

import { ProtonEventId, ProtonFolderId } from './proton-drive-types';

import type { ProtonSession } from '../proton/auth/ProtonSession';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';

export const DEFAULT_SYNC_CONTAINER_NAME = 'obsidian-notes';

export const { init: initObsidianSettingsStore, get: getObsidianSettingsStore } = (function () {
  let instance: ObsidianSettingsStore | null = null;

  return {
    init: function initObsidianSettingsStore(
      defaultRemoteVaultRootPath: string,
      callbacks: {
        load: () => Promise<PluginSettingsStorageModel | null>;
        save: (data: PluginSettingsStorageModel) => Promise<void>;
      }
    ): ObsidianSettingsStore {
      return (instance ??= new ObsidianSettingsStore(defaultRemoteVaultRootPath, callbacks));
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
  private readonly settingsSubject = new BehaviorSubject<Readonly<PluginSettings>>({
    accountEmail: '',
    connectionStatus: 'disconnected',
    lastLoginAt: null,
    lastLoginError: null,
    lastRefreshAt: null,
    sessionExpiresAt: null,
    latestEventId: Option.none(),
    vaultRootNodeUid: Option.none(),
    enableFileLogging: false,
    logLevel: LogLevel.info,
    ignoredPaths: [],
    remoteVaultRootPath: '',
    confirmSyncOperations: true
  });
  public readonly settings$ = this.settingsSubject.asObservable();

  public constructor(
    private readonly defaultRemoteVaultRootPath: string,
    private readonly callbacks: {
      load: () => Promise<PluginSettingsStorageModel | null>;
      save: (data: PluginSettingsStorageModel) => Promise<void>;
    }
  ) {}

  public async load(): Promise<void> {
    const loaded = await this.callbacks.load();

    if (loaded) {
      this.settingsSubject.next({
        accountEmail: loaded.accountEmail,
        connectionStatus: loaded.connectionStatus,
        lastLoginAt: loaded.lastLoginAt ? new Date(loaded.lastLoginAt) : null,
        lastRefreshAt: loaded.lastRefreshAt ? new Date(loaded.lastRefreshAt) : null,
        sessionExpiresAt: loaded.sessionExpiresAt ? new Date(loaded.sessionExpiresAt) : null,
        lastLoginError: loaded.lastLoginError,
        latestEventId: loaded.latestEventId ? Option.some(new ProtonEventId(loaded.latestEventId)) : Option.none(),
        vaultRootNodeUid: loaded.vaultRootNodeUid
          ? Option.some(new ProtonFolderId(loaded.vaultRootNodeUid))
          : Option.none(),
        enableFileLogging: loaded.enableFileLogging,
        logLevel: loaded.logLevel ?? LogLevel.info,
        ignoredPaths: loaded.ignoredPaths ?? [],
        confirmSyncOperations: loaded.confirmSyncOperations ?? true,
        remoteVaultRootPath:
          !loaded.remoteVaultRootPath || loaded.remoteVaultRootPath === ''
            ? this.defaultRemoteVaultRootPath
            : loaded.remoteVaultRootPath
      });
    } else {
      this.settingsSubject.next({
        ...this.settingsSubject.getValue(),
        remoteVaultRootPath: this.defaultRemoteVaultRootPath
      });
    }

    this.settings$.subscribe(async settings => {
      await this.callbacks.save({
        accountEmail: settings.accountEmail,
        connectionStatus: settings.connectionStatus,
        lastLoginAt: settings.lastLoginAt ? settings.lastLoginAt.getTime() : null,
        lastRefreshAt: settings.lastRefreshAt ? settings.lastRefreshAt.getTime() : null,
        sessionExpiresAt: settings.sessionExpiresAt ? settings.sessionExpiresAt.getTime() : null,
        lastLoginError: settings.lastLoginError,
        latestEventId: Option.isSome(settings.latestEventId) ? settings.latestEventId.value.eventId : null,
        vaultRootNodeUid: Option.isSome(settings.vaultRootNodeUid) ? settings.vaultRootNodeUid.value.uid : null,
        enableFileLogging: settings.enableFileLogging,
        logLevel: settings.logLevel,
        ignoredPaths: settings.ignoredPaths,
        remoteVaultRootPath: settings.remoteVaultRootPath ?? null,
        confirmSyncOperations: settings.confirmSyncOperations
      });
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

  public get<K extends keyof PluginSettings>(key: K): PluginSettings[K] {
    return this.settingsSubject.getValue()[key];
  }

  public set<K extends keyof PluginSettings>(key: K, value: PluginSettings[K]): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      [key]: value
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
      latestEventId: Option.none()
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
  remoteVaultRootPath: string | null;
  confirmSyncOperations: boolean;
}

export interface PluginSettings {
  accountEmail: string;
  connectionStatus: ProtonAuthStatus;
  lastLoginAt: Date | null;
  lastRefreshAt: Date | null;
  sessionExpiresAt: Date | null;
  lastLoginError: string | null;
  latestEventId: Option.Option<ProtonEventId>;
  vaultRootNodeUid: Option.Option<ProtonFolderId>;
  enableFileLogging: boolean;
  logLevel: LogLevel;
  ignoredPaths: string[];
  remoteVaultRootPath: string;
  confirmSyncOperations: boolean;
}

export enum LogLevel {
  debug = 'debug',
  info = 'info',
  warn = 'warn',
  error = 'error'
}
