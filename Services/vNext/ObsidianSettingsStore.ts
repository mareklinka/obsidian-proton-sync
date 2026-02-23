import { ProtonAuthStatus, ProtonSessionState } from '../../proton/auth/ProtonSessionService';
import { ProtonEventId } from './proton-drive-types';
import { BehaviorSubject } from 'rxjs';
import { LogLevel } from '../../logger';

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
    enableFileLogging: false,
    logLevel: 'info',
    logMaxSizeKb: 1024
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
        enableFileLogging: model.enableFileLogging,
        logLevel: model.logLevel,
        logMaxSizeKb: model.logMaxSizeKb
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
        enableFileLogging: settings.enableFileLogging,
        logLevel: settings.logLevel,
        logMaxSizeKb: settings.logMaxSizeKb
      });
    });
  }

  public setAccountEmail(email: string): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      accountEmail: email
    });
  }

  public setLatestProtonEventId(eventId: ProtonEventId): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      latestEventId: eventId
    });
  }

  public setLogging(enabled: boolean, logLevel: LogLevel, logMaxSizeKb: number): void {
    this.settingsSubject.next({
      ...this.settingsSubject.getValue(),
      enableFileLogging: enabled,
      logLevel: logLevel,
      logMaxSizeKb: logMaxSizeKb
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
  enableFileLogging: boolean;
  logLevel: LogLevel;
  logMaxSizeKb: number;
}

export interface PluginSettings {
  accountEmail: string;
  connectionStatus: ProtonAuthStatus;
  lastLoginAt: Date | null;
  lastRefreshAt: Date | null;
  sessionExpiresAt: Date | null;
  lastLoginError: string | null;
  latestEventId: ProtonEventId | null;
  enableFileLogging: boolean;
  logLevel: LogLevel;
  logMaxSizeKb: number;
}
