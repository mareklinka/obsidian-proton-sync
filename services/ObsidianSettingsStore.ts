import { Option } from 'effect';
import { BehaviorSubject } from 'rxjs';

import { ProtonEventId, ProtonFolderId } from './proton-drive-types';
import type { RemoteFileStateSnapshot } from './RemoteFileStateSnapshot';

export const DEFAULT_SYNC_CONTAINER_NAME = 'obsidian-notes';

type NonSnapshotPluginSettingsKeys = Exclude<keyof PluginSettings, 'remoteFileStateSnapshot'>;

export const { init: initObsidianSettingsStore, get: getObsidianSettingsStore } = (function (): {
  init: (
    this: void,
    defaultRemoteVaultRootPath: string,
    callbacks: {
      load: () => Promise<PluginSettingsStorageModel | null>;
      save: (data: PluginSettingsStorageModel) => Promise<void>;
    }
  ) => ObsidianSettingsStore;
  get: (this: void) => ObsidianSettingsStore;
} {
  let instance: ObsidianSettingsStore | null = null;

  return {
    init: function (
      this: void,
      defaultRemoteVaultRootPath: string,
      callbacks: {
        load: () => Promise<PluginSettingsStorageModel | null>;
        save: (data: PluginSettingsStorageModel) => Promise<void>;
      }
    ): ObsidianSettingsStore {
      return (instance ??= new ObsidianSettingsStore(defaultRemoteVaultRootPath, callbacks));
    },
    get: function (this: void): ObsidianSettingsStore {
      if (!instance) {
        throw new Error('ObsidianSettingsStore has not been initialized. Please call initObsidianSettingsStore first.');
      }
      return instance;
    }
  };
})();

class ObsidianSettingsStore {
  readonly #settingsSubject = new BehaviorSubject<Readonly<PluginSettings>>({
    accountEmail: '',
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
    remoteFileStateSnapshot: null
  });
  public readonly settings$ = this.#settingsSubject.asObservable();

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
      this.#settingsSubject.next({
        accountEmail: loaded.accountEmail,
        lastLoginAt: typeof loaded.lastLoginAt === 'number' ? new Date(loaded.lastLoginAt) : null,
        lastRefreshAt: typeof loaded.lastRefreshAt === 'number' ? new Date(loaded.lastRefreshAt) : null,
        sessionExpiresAt: typeof loaded.sessionExpiresAt === 'number' ? new Date(loaded.sessionExpiresAt) : null,
        lastLoginError: loaded.lastLoginError,
        latestEventId: loaded.latestEventId ? Option.some(new ProtonEventId(loaded.latestEventId)) : Option.none(),
        vaultRootNodeUid: loaded.vaultRootNodeUid
          ? Option.some(new ProtonFolderId(loaded.vaultRootNodeUid))
          : Option.none(),
        enableFileLogging: loaded.enableFileLogging,
        logLevel: loaded.logLevel ?? LogLevel.info,
        ignoredPaths: loaded.ignoredPaths ?? [],
        remoteVaultRootPath:
          !loaded.remoteVaultRootPath || loaded.remoteVaultRootPath === ''
            ? this.defaultRemoteVaultRootPath
            : loaded.remoteVaultRootPath,
        remoteFileStateSnapshot: loaded.remoteFileStateSnapshot ?? null
      });
    } else {
      this.#settingsSubject.next({
        ...this.#settingsSubject.getValue(),
        remoteVaultRootPath: this.defaultRemoteVaultRootPath
      });
    }

    this.settings$.subscribe(async settings => {
      await this.callbacks.save({
        accountEmail: settings.accountEmail,
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
        remoteFileStateSnapshot: settings.remoteFileStateSnapshot
      });
    });
  }

  public get<K extends NonSnapshotPluginSettingsKeys>(key: K): PluginSettings[K] {
    return this.#settingsSubject.getValue()[key];
  }

  public set<K extends NonSnapshotPluginSettingsKeys>(key: K, value: PluginSettings[K]): void {
    const currentSettings = this.#settingsSubject.getValue();
    const nextSettings: PluginSettings = {
      ...currentSettings,
      [key]: value
    };

    if (this.#shouldClearRemoteFileStateSnapshot(key, currentSettings[key], value)) {
      nextSettings.remoteFileStateSnapshot = null;
    }

    this.#settingsSubject.next(nextSettings);
  }

  public setRemoteFileStateSnapshot(snapshot: RemoteFileStateSnapshot | null): void {
    this.#settingsSubject.next({
      ...this.#settingsSubject.getValue(),
      remoteFileStateSnapshot: snapshot ? { ...snapshot } : null
    });
  }

  public getRemoteFileStateSnapshot(): RemoteFileStateSnapshot | null {
    return this.#settingsSubject.getValue().remoteFileStateSnapshot;
  }

  public reset(): void {
    this.#settingsSubject.next({
      ...this.#settingsSubject.getValue(),
      accountEmail: '',
      lastLoginAt: null,
      lastLoginError: null,
      lastRefreshAt: null,
      sessionExpiresAt: null,
      latestEventId: Option.none(),
      remoteFileStateSnapshot: null
    });
  }

  #shouldClearRemoteFileStateSnapshot<K extends keyof PluginSettings>(
    key: K,
    previousValue: PluginSettings[K],
    nextValue: PluginSettings[K]
  ): boolean {
    if (key === 'remoteFileStateSnapshot') {
      return false;
    }

    if (key === 'remoteVaultRootPath') {
      return previousValue !== nextValue;
    }

    if (key === 'ignoredPaths') {
      return !isSameStringArray(previousValue as Array<string>, nextValue as Array<string>);
    }

    if (key === 'vaultRootNodeUid') {
      return !isSameOptionalFolderId(
        previousValue as PluginSettings['vaultRootNodeUid'],
        nextValue as PluginSettings['vaultRootNodeUid']
      );
    }

    return false;
  }
}

interface PluginSettingsStorageModel {
  accountEmail: string;
  lastLoginAt: number | null;
  lastRefreshAt: number | null;
  sessionExpiresAt: number | null;
  lastLoginError: string | null;
  latestEventId: string | null;
  vaultRootNodeUid: string | null;
  enableFileLogging: boolean;
  logLevel: LogLevel;
  ignoredPaths?: Array<string>;
  remoteVaultRootPath: string | null;
  remoteFileStateSnapshot?: RemoteFileStateSnapshot | null;
}

export interface PluginSettings {
  accountEmail: string;
  lastLoginAt: Date | null;
  lastRefreshAt: Date | null;
  sessionExpiresAt: Date | null;
  lastLoginError: string | null;
  latestEventId: Option.Option<ProtonEventId>;
  vaultRootNodeUid: Option.Option<ProtonFolderId>;
  enableFileLogging: boolean;
  logLevel: LogLevel;
  ignoredPaths: Array<string>;
  remoteVaultRootPath: string;
  remoteFileStateSnapshot: RemoteFileStateSnapshot | null;
}

export enum LogLevel {
  debug = 'debug',
  info = 'info',
  warn = 'warn',
  error = 'error'
}

function isSameOptionalFolderId(
  left: PluginSettings['vaultRootNodeUid'],
  right: PluginSettings['vaultRootNodeUid']
): boolean {
  if (Option.isNone(left) && Option.isNone(right)) {
    return true;
  }

  if (Option.isSome(left) && Option.isSome(right)) {
    return left.value.uid === right.value.uid;
  }

  return false;
}

function isSameStringArray(left: Array<string>, right: Array<string>): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
