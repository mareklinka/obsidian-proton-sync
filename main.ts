import { Notice, Plugin } from 'obsidian';
import { type Subscription } from 'rxjs';

import { DEFAULT_SETTINGS, ProtonDriveSyncSettings } from './model/settings';
import { createFileLogger, getDefaultLogFilePath, type PluginLogger } from './logger';
import { ObsidianVaultFileSystemReader } from './isolated-sync/ObsidianVaultFileSystemReader';
import { RxSyncService } from './isolated-sync/RxSyncService';
import { ProtonDriveCloudStorageApi } from './isolated-sync/ProtonDriveCloudStorageApi';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonSessionService } from './proton/auth/ProtonSessionService';
import { ObsidianSecretRepository } from './Services/ObsidianSecretRepository';
import { ProtonAccount } from './proton/drive/ProtonAccount';
import { createProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { ObsidianHttpClient } from './proton/drive/ObsidianHttpClient';
import { createSyncStatusBar, type SyncStatusBarController } from './ui/status-bar';
import { CloudReconciliationService } from './Services/CloudReconciliationService';
import { ProtonDriveSyncSettingTab } from './ui/settings-tab';
import { SettingsService } from './Services/SettingsService';
import { SyncOrchestrationService } from './Services/SyncOrchestrationService';
import { SyncIndexStateService } from './Services/SyncIndexStateService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveTwoFactorModal } from './ui/modals/two-factor-modal';
import { ProtonDriveMailboxPasswordModal } from './ui/modals/mailbox-password-modal';

export default class ProtonDriveSyncPlugin extends Plugin {
  private settingsService!: SettingsService;
  private syncIndexStateService!: SyncIndexStateService;
  private protonSessionService!: ProtonSessionService;
  private driveClient: ProtonDriveClient | null = null;
  private logger!: PluginLogger;
  private settingTab: ProtonDriveSyncSettingTab | null = null;
  private orchestrator: SyncOrchestrationService | null = null;
  private cloudReconciliationService: CloudReconciliationService | null = null;
  private statusBarController: SyncStatusBarController | null = null;
  private readonly subscriptions: Subscription[] = [];

  private get settings(): ProtonDriveSyncSettings {
    return this.settingsService.snapshot();
  }

  async onload(): Promise<void> {
    this.settingsService = new SettingsService(
      Object.assign({}, DEFAULT_SETTINGS, await this.loadData()),
      nextSettings => this.saveData(nextSettings)
    );
    this.syncIndexStateService = new SyncIndexStateService(this.settingsService);

    this.subscriptions.push(
      this.settingsService.settings$.subscribe(() => {
        void this.settingTab?.display();
      })
    );

    this.logger = createFileLogger(this.app, {
      enabled: this.settings.enableFileLogging,
      level: this.settings.logLevel,
      filePath: getDefaultLogFilePath(),
      maxFileSizeBytes: this.settings.logMaxSizeKb * 1024
    });

    this.logger.info('Loading Proton Drive Sync plugin', {
      version: this.manifest.version
    });

    const secretStore = new ObsidianSecretRepository(this.app);

    this.protonSessionService = new ProtonSessionService(
      secretStore,
      `external-drive-obsidiansync@${this.manifest.version}`
    );
    const protonAccount = new ProtonAccount(this.protonSessionService);
    this.driveClient = createProtonDriveClient(
      protonAccount,
      this.settingsService,
      new ObsidianHttpClient(this.protonSessionService)
    );

    this.cloudReconciliationService = new CloudReconciliationService({
      getDriveClient: () => this.driveClient,
      logger: this.logger,
      vault: this.app.vault,
      settingsService: this.settingsService,
      syncIndexStateService: this.syncIndexStateService,
      getSyncReader: () => this.orchestrator?.getReader() ?? null,
      getSyncService: () => this.orchestrator?.getSyncService() ?? null
    });

    this.orchestrator = new SyncOrchestrationService({
      vault: this.app.vault,
      logger: this.logger,
      settingsService: this.settingsService,
      syncIndexStateService: this.syncIndexStateService,
      sessionService: this.protonSessionService,
      cloudReconciliationService: this.cloudReconciliationService,
      getDriveClient: () => this.driveClient,
      createReader: () =>
        new ObsidianVaultFileSystemReader(this.app.vault, {
          ignoredPathPrefixes: []
        }),
      createSyncService: (vaultRootNodeUid, reader) => {
        if (!this.driveClient) {
          throw new Error('Drive client unavailable while creating sync service.');
        }

        const cloudApi = new ProtonDriveCloudStorageApi(this.driveClient, vaultRootNodeUid, () =>
          this.syncIndexStateService.snapshot()
        );

        return new RxSyncService(reader, cloudApi);
      },
      maxBufferedChanges: 5000
    });

    this.statusBarController = createSyncStatusBar(this, {
      loginState$: this.protonSessionService.authState$,
      syncState$: this.orchestrator.syncState$,
      reconcileState$: this.orchestrator.reconcileState$
    });
    await this.orchestrator.start();

    this.settingTab = this.setupSettingsTab(this);
  }

  async onunload(): Promise<void> {
    this.logger.info('Unloading Proton Drive Sync plugin');
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.subscriptions.length = 0;
    await this.orchestrator?.dispose();
    this.orchestrator = null;
    this.statusBarController?.dispose();
    this.statusBarController = null;
    this.protonSessionService?.dispose();
  }

  async signIn(credentials: { email: string; password: string }): Promise<void> {
    if (!credentials.email || !credentials.password) {
      new Notice('Email and password are required to connect.');
      return;
    }

    try {
      await this.protonSessionService.signIn(credentials.email.trim(), credentials.password, {
        requestTwoFactorCode: () => promptFromModal(this.app, app => new ProtonDriveTwoFactorModal(app)),
        requestMailboxPassword: () => promptFromModal(this.app, app => new ProtonDriveMailboxPasswordModal(app))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed.';
      new Notice(message);
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Proton Drive');
    this.protonSessionService.signOut();
    await this.orchestrator?.disconnect();
    new Notice('Disconnected from Proton Drive.');
  }

  private setupSettingsTab(plugin: ProtonDriveSyncPlugin): ProtonDriveSyncSettingTab {
    const settingTab = new ProtonDriveSyncSettingTab(plugin, this.settingsService);

    this.subscriptions.push(
      settingTab.loggingChanged$.subscribe(({ isEnabled, maxSize, minLevel }) => {
        this.logger.updateSettings({
          enabled: isEnabled,
          maxFileSizeBytes: maxSize * 1024,
          level: minLevel,
          filePath: getDefaultLogFilePath()
        });
      }),
      settingTab.disconnect$.subscribe(() => {
        this.disconnect();
      }),
      settingTab.login$.subscribe(credentials => {
        this.signIn(credentials);
      })
    );

    this.addSettingTab(settingTab);

    return settingTab;
  }
}
