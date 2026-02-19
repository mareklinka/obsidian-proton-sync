import { Notice, Plugin, TFolder } from 'obsidian';

import { ProtonDriveLoginModal } from './login-modal';
import { DEFAULT_SETTINGS, ProtonDriveSyncSettings, ProtonDriveSyncSettingTab } from './settings';
import { createFileLogger, getDefaultLogFilePath, type PluginLogger } from './logger';
import { ensureSyncRoots } from './sync-root';
import { buildSyncEvent, SyncQueue } from './sync-queue';
import { createProtonAuthFacade, type ProtonAuthFacade, type ProtonAuthResult } from './proton-integration/auth/public';
import { createProtonDriveFactory } from './proton-integration/drive/public';
import { DefaultProtonAuthGateway } from './proton-integration/auth/infrastructure/ProtonAuthGateway';
import { ObsidianSecretRepository } from './Services/ObsidianSecretRepository';
import { ObsidianSessionRepository } from './Services/ObsidianSessionRepository';
import type { ProtonDriveClient } from '@protontech/drive-sdk';

export default class ProtonDriveSyncPlugin extends Plugin {
  settings!: ProtonDriveSyncSettings;
  private protonAuth!: ProtonAuthFacade;
  private driveClient: ProtonDriveClient | null = null;
  private logger!: PluginLogger;
  private settingTab: ProtonDriveSyncSettingTab | null = null;
  private layoutReady = false;
  private pendingSyncRootDiscovery = false;
  private syncQueue: SyncQueue | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger = createFileLogger(this.app, {
      enabled: this.settings.enableFileLogging,
      level: this.settings.logLevel,
      filePath: getDefaultLogFilePath(),
      maxFileSizeBytes: this.settings.logMaxSizeKb * 1024
    });

    this.logger.info('Loading Proton Drive Sync plugin', {
      version: this.manifest.version
    });

    this.protonAuth = createProtonAuthFacade({
      appVersion: this.manifest.version,
      logger: this.logger,
      sessionStore: new ObsidianSessionRepository(this.app),
      secretStore: new ObsidianSecretRepository(this.app),
      authGateway: new DefaultProtonAuthGateway(this.manifest.version, this.logger)
    });
    const protonDriveFactory = createProtonDriveFactory({ logger: this.logger });

    const reconnectResult = await this.protonAuth.reconnect();
    this.applyAuthResultToSettings(reconnectResult);
    if (reconnectResult.ok) {
      this.driveClient = protonDriveFactory.createFromAuthContext(reconnectResult.context);
      this.startRefreshLoop();
      this.scheduleSyncRootDiscovery('startup');
    }
    await this.saveSettings();

    this.settingTab = new ProtonDriveSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      if (this.pendingSyncRootDiscovery) {
        this.pendingSyncRootDiscovery = false;
        void this.initializeSyncRoots('layout');
      }
    });

    this.addRibbonIcon('refresh-ccw', 'Proton Drive Sync', () => {
      new Notice('Proton Drive Sync: scaffold loaded');
    });
  }

  async onunload(): Promise<void> {
    this.logger.info('Unloading Proton Drive Sync plugin');
    this.stopRefreshLoop();
    this.protonAuth?.dispose();
    this.syncQueue?.dispose();
  }

  openLoginModal(): void {
    new ProtonDriveLoginModal(this.app, this).open();
  }

  async signIn(credentials: {
    email: string;
    password: string;
    mailboxPassword?: string;
    twoFactorCode?: string;
  }): Promise<void> {
    if (!credentials.email || !credentials.password) {
      new Notice('Email and password are required to connect.');
      return;
    }

    try {
      const result = await this.protonAuth.connect({
        email: credentials.email.trim(),
        password: credentials.password,
        mailboxPassword: credentials.mailboxPassword,
        twoFactorCode: credentials.twoFactorCode
      });

      if (!result.ok) {
        this.applyAuthResultToSettings(result);
        await this.saveSettings();
        new Notice(result.message);
        return;
      }

      const protonDriveFactory = createProtonDriveFactory({ logger: this.logger });
      this.driveClient = protonDriveFactory.createFromAuthContext(result.context);

      this.applyAuthResultToSettings(result);
      await this.saveSettings();

      this.scheduleSyncRootDiscovery('sign-in');

      this.startRefreshLoop();

      this.logger.info('Sign-in successful', {
        expiresAt: result.context.session.expiresAt
      });

      new Notice('Connected to Proton Drive.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed.';
      this.settings.connectionStatus = 'error';
      this.settings.lastLoginError = message;
      await this.saveSettings();
      this.logger.error('Sign-in failed', undefined, error);
      new Notice(message);
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Proton Drive');
    await this.protonAuth.disconnect();
    this.driveClient = null;
    this.settings.connectionStatus = 'disconnected';
    this.settings.lastLoginError = null;
    this.settings.lastRefreshAt = null;
    this.settings.sessionExpiresAt = null;
    await this.saveSettings();
    this.stopRefreshLoop();
    new Notice('Disconnected from Proton Drive.');
  }

  private startRefreshLoop(): void {
    this.protonAuth.startAutoRefresh({
      onRefreshSuccess: async context => {
        this.settings.connectionStatus = 'connected';
        this.settings.lastLoginError = null;
        this.settings.lastRefreshAt = context.session.lastRefreshAt;
        this.settings.sessionExpiresAt = context.session.expiresAt;
        await this.saveSettings();

        if (!this.driveClient) {
          const protonDriveFactory = createProtonDriveFactory({ logger: this.logger });
          this.driveClient = protonDriveFactory.createFromAuthContext(context);
        }

        this.scheduleSyncRootDiscovery('refresh');
      },
      onRefreshError: result => {
        this.syncQueue?.dispose();
        this.syncQueue = null;
        this.driveClient = null;
        this.settings.connectionStatus = 'error';
        this.settings.lastLoginError = result.message;
        void this.saveSettings();
        new Notice(result.message);
      }
    });
  }

  private stopRefreshLoop(): void {
    this.protonAuth.stopAutoRefresh();
  }

  private scheduleSyncRootDiscovery(reason: 'startup' | 'sign-in' | 'refresh'): void {
    if (this.settings.connectionStatus !== 'connected' || !this.driveClient) {
      return;
    }

    if (!this.layoutReady) {
      this.pendingSyncRootDiscovery = true;
      this.logger.debug('Deferring sync root discovery until layout ready', {
        reason
      });
      return;
    }

    void this.initializeSyncRoots(reason);
  }

  private async initializeSyncRoots(reason: 'startup' | 'sign-in' | 'refresh' | 'layout'): Promise<void> {
    if (!this.driveClient || this.settings.connectionStatus !== 'connected') {
      return;
    }

    try {
      const vaultName = this.app.vault.getName();
      const info = await ensureSyncRoots(this.driveClient, this.settings, vaultName, this.logger);
      await this.saveSettings();
      this.logger.info('Sync roots ready', { reason, ...info });
      this.initializeSyncQueue();
    } catch (error) {
      this.logger.error('Failed to ensure sync roots', { reason }, error);
      new Notice('Failed to initialize Proton Drive sync roots.');
    }
  }

  private initializeSyncQueue(): void {
    if (!this.driveClient || !this.settings.vaultRootNodeUid) {
      return;
    }

    if (!this.syncQueue) {
      this.syncQueue = new SyncQueue(this.app.vault, this.driveClient, this.settings, this.logger, () =>
        this.saveSettings()
      );

      this.registerEvent(
        this.app.vault.on('create', file => {
          const event = buildSyncEvent(file, file instanceof TFolder ? 'folder-create' : 'file-create');
          if (event) {
            this.syncQueue?.enqueue(event);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('modify', file => {
          const event = buildSyncEvent(file, 'file-modify');
          if (event) {
            this.syncQueue?.enqueue(event);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          const event = buildSyncEvent(file, 'rename', oldPath);
          if (event) {
            this.syncQueue?.enqueue(event);
          }
        })
      );
    }
  }

  private applyAuthResultToSettings(result: ProtonAuthResult): void {
    if (result.ok) {
      const session = result.context.session;
      this.settings.connectionStatus = 'connected';
      this.settings.lastLoginError = null;
      this.settings.lastLoginAt = session.updatedAt;
      this.settings.lastRefreshAt = session.lastRefreshAt;
      this.settings.sessionExpiresAt = session.expiresAt;
      return;
    }

    this.settings.connectionStatus = result.reason === 'no-session' ? 'disconnected' : 'error';
    this.settings.lastLoginError = result.message;
    this.settings.sessionExpiresAt = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.logger?.updateSettings({
      enabled: this.settings.enableFileLogging,
      level: this.settings.logLevel,
      filePath: getDefaultLogFilePath(),
      maxFileSizeBytes: this.settings.logMaxSizeKb * 1024
    });
    this.settingTab?.display();
  }
}
