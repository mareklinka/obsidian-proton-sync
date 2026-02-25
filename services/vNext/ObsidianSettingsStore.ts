import { Option } from 'effect';
import { ProtonAuthStatus, ProtonSessionState } from '../../proton/auth/ProtonSessionService';
import { ProtonEventId, ProtonFolderId } from './proton-drive-types';
import { BehaviorSubject } from 'rxjs';

export const { init: initObsidianSettingsStore, get: getObsidianSettingsStore } = (function () {
  let instance: ObsidianSettingsStore | null = null;

  return {
    init: function initObsidianSettingsStore(callbacks: {
      load: () => Promise<PluginSettingsStorageModel>;
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
    logLevel: LogLevel.info
  });
  public readonly settings$ = this.settingsSubject.asObservable();

  public constructor(
    private readonly callbacks: {
      load: () => Promise<PluginSettingsStorageModel>;
      save: (data: PluginSettingsStorageModel) => Promise<void>;
    }
  ) {
    callbacks.load().then(model => {
      this.settingsSubject.next({
        accountEmail: model.accountEmail,
        connectionStatus: model.connectionStatus,
        lastLoginAt: model.lastLoginAt ? new Date(model.lastLoginAt) : null,
        lastRefreshAt: model.lastRefreshAt ? new Date(model.lastRefreshAt) : null,
        sessionExpiresAt: model.sessionExpiresAt ? new Date(model.sessionExpiresAt) : null,
        lastLoginError: model.lastLoginError,
        latestEventId: model.latestEventId ? new ProtonEventId(model.latestEventId) : null,
        vaultRootNodeUid: model.vaultRootNodeUid ? new ProtonFolderId(model.vaultRootNodeUid) : null,
        enableFileLogging: model.enableFileLogging,
        logLevel: model.logLevel
      });
    });

    this.settings$.subscribe(settings => {
      callbacks.save({
        accountEmail: settings.accountEmail,
        connectionStatus: settings.connectionStatus,
        lastLoginAt: settings.lastLoginAt ? settings.lastLoginAt.getTime() : null,
        lastRefreshAt: settings.lastRefreshAt ? settings.lastRefreshAt.getTime() : null,
        sessionExpiresAt: settings.sessionExpiresAt ? settings.sessionExpiresAt.getTime() : null,
        lastLoginError: settings.lastLoginError,
        latestEventId: settings.latestEventId?.eventId || null,
        vaultRootNodeUid: settings.vaultRootNodeUid?.uid || null,
        enableFileLogging: settings.enableFileLogging,
        logLevel: settings.logLevel
      });
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

  public setLatestProtonEventId(eventId: ProtonEventId): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      latestEventId: eventId
    });
  }

  public setLogging(enabled: boolean, logLevel: LogLevel): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      enableFileLogging: enabled,
      logLevel: logLevel
    });
  }

  public setAuthenticationResult(session: ProtonSessionState): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      ...(session.state === 'ok'
        ? {
            connectionStatus: 'connected',
            lastLoginError: null,
            lastLoginAt: session.session.updatedAt,
            lastRefreshAt: session.session.lastRefreshAt,
            sessionExpiresAt: session.session.expiresAt
          }
        : {
            connectionStatus: 'disconnected',
            sessionExpiresAt: null
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
}

export enum LogLevel {
  debug = 'debug',
  info = 'info',
  warn = 'warn',
  error = 'error'
}
