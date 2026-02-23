import { App, Notice, Plugin } from 'obsidian';
import { type Subscription } from 'rxjs';

import { DEFAULT_SETTINGS, ProtonDriveSyncSettings } from './model/settings';
import { createFileLogger, getDefaultLogFilePath, type PluginLogger } from './logger';
import { ObsidianVaultFileSystemReader } from './services/ObsidianVaultFileSystemReader';
import { ObsidianSyncService } from './services/ObsidianSyncService';
import { ProtonDriveCloudStorageApi } from './services/ProtonDriveCloudStorageApi';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonSessionService } from './proton/auth/ProtonSessionService';
import { ObsidianSecretRepository } from './services/ObsidianSecretRepository';
import { ProtonAccount } from './proton/drive/ProtonAccount';
import { createProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { ObsidianHttpClient } from './proton/drive/ObsidianHttpClient';
import { createSyncStatusBar, type SyncStatusBarController } from './ui/status-bar';
import { CloudReconciliationService } from './services/CloudReconciliationService';
import { ProtonDriveSyncSettingTab } from './ui/settings-tab';
import { SettingsService } from './services/SettingsService';
import { SyncOrchestrationService } from './services/SyncOrchestrationService';
import { SyncIndexStateService } from './services/SyncIndexStateService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveTwoFactorModal } from './ui/modals/two-factor-modal';
import { ProtonDriveMailboxPasswordModal } from './ui/modals/mailbox-password-modal';
import { ProtonDriveCaptchaModal } from './ui/modals/captcha-modal';
import { ConfigSyncService, type ConfigSyncResult } from './services/ConfigSyncService';
import { ProtonDriveConfirmModal } from './ui/modals/confirm-modal';
import { ProtonDriveConfigSyncActionModal, type ConfigSyncAction } from './ui/modals/config-sync-action-modal';
import { LocalChangeSuppressionService } from './services/LocalChangeSuppressionService';
import { initObsidianSecretStore } from './services/vNext/ObsidianSecretStore';
import { initObsidianFileApi } from './services/vNext/ObsidianFileApi';
import { initObsidianFileObserver } from './services/vNext/ObsidianVaultObserver';
import { initProtonCloudApi } from './services/vNext/ProtonCloudApi';
import { initProtonCloudObserver } from './services/vNext/ProtonCloudObserver';
import { initObsidianSettingsStore } from './services/vNext/ObsidianSettingsStore';

const PUSH_CONFIG_COMMAND_ID = 'push-vault-config';
const PULL_CONFIG_COMMAND_ID = 'pull-vault-config';

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
  private configSyncService: ConfigSyncService | null = null;

  private get settings(): ProtonDriveSyncSettings {
    return this.settingsService.snapshot();
  }

  async onload(): Promise<void> {
    initObsidianSettingsStore({ save: this.loadData.bind(this), load: this.loadData.bind(this) });
    initObsidianSecretStore(this.app.secretStorage);
    initObsidianFileApi(this.app.vault);
    initObsidianFileObserver(this.app.vault);

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

    initProtonCloudApi(this.driveClient);
    initProtonCloudObserver(this.driveClient);

    const localChangeSuppressionService = new LocalChangeSuppressionService();

    this.cloudReconciliationService = new CloudReconciliationService({
      getDriveClient: () => this.driveClient,
      logger: this.logger,
      vault: this.app.vault,
      settingsService: this.settingsService,
      syncIndexStateService: this.syncIndexStateService,
      getFileReader: () => this.orchestrator?.getReader() ?? null,
      getSyncService: () => this.orchestrator?.getSyncService() ?? null,
      localChangeSuppressionService
    });

    this.orchestrator = new SyncOrchestrationService({
      vault: this.app.vault,
      logger: this.logger,
      settingsService: this.settingsService,
      syncIndexStateService: this.syncIndexStateService,
      sessionService: this.protonSessionService,
      cloudReconciliationService: this.cloudReconciliationService,
      localChangeSuppressionService,
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

        return new ObsidianSyncService(reader, cloudApi);
      },
      maxBufferedChanges: 5000
    });

    this.configSyncService = this.getConfigSyncService();

    this.statusBarController = createSyncStatusBar(this, {
      loginState$: this.protonSessionService.authState$,
      syncState$: this.orchestrator.syncState$,
      reconcileState$: this.orchestrator.reconcileState$,
      configSyncState$: this.configSyncService.state$
    });
    await this.orchestrator.start();

    this.addRibbonIcon('cloud-cog', 'Vault configuration sync', () => {
      void this.openConfigSyncActionDialog();
    });

    this.addCommand({
      id: PUSH_CONFIG_COMMAND_ID,
      name: 'Push vault configuration to Proton Drive',
      icon: 'cloud-upload',
      callback: () => {
        void this.pushVaultConfig();
      }
    });

    this.addCommand({
      id: PULL_CONFIG_COMMAND_ID,
      name: 'Pull vault configuration from Proton Drive',
      icon: 'cloud-download',
      callback: () => {
        void this.pullVaultConfig();
      }
    });

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
        requestMailboxPassword: () => promptFromModal(this.app, app => new ProtonDriveMailboxPasswordModal(app)),
        requestCaptchaChallenge: async (captchaUrl: string) =>
          await promptFromModal(this.app, app => new ProtonDriveCaptchaModal(app, captchaUrl))
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

  private async openConfigSyncActionDialog(): Promise<void> {
    const action = await promptFromModal(this.app, app => new ProtonDriveConfigSyncActionModal(app));
    if (!action) {
      return;
    }

    await this.executeRegisteredConfigSyncAction(action);
  }

  private async executeRegisteredConfigSyncAction(action: ConfigSyncAction): Promise<void> {
    const commandId = action === 'push' ? PUSH_CONFIG_COMMAND_ID : PULL_CONFIG_COMMAND_ID;
    const fullCommandId = `${this.manifest.id}:${commandId}`;
    const commands = (
      this.app as App & {
        commands?: {
          executeCommandById: (id: string) => boolean;
        };
      }
    ).commands;

    const executed = commands?.executeCommandById(fullCommandId) ?? false;

    if (!executed) {
      new Notice('Unable to execute configuration sync action.');
    }
  }

  private async pushVaultConfig(): Promise<void> {
    const configSyncService = this.configSyncService;
    if (!configSyncService || !this.cloudReconciliationService) {
      return;
    }

    new Notice('Pushing vault configuration to Proton Drive...');

    try {
      const result = await configSyncService.pushConfig();
      this.handleConfigSyncResult(result, 'push');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Config push failed', {}, error);
      new Notice(`Configuration push failed: ${message}`);
    }
  }

  private async pullVaultConfig(): Promise<void> {
    const configSyncService = this.configSyncService;
    if (!configSyncService || !this.cloudReconciliationService) {
      return;
    }

    const confirmed = await promptFromModal(
      this.app,
      app =>
        new ProtonDriveConfirmModal(
          app,
          'Pull vault configuration?',
          'This can be destructive. Local vault configuration files will be replaced by remote configuration files.',
          'Pull and replace local config'
        )
    );

    if (!confirmed) {
      new Notice('Configuration pull canceled.');
      return;
    }

    new Notice('Pulling vault configuration from Proton Drive...');

    try {
      const result = await configSyncService.pullConfig();
      this.handleConfigSyncResult(result, 'pull');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Config pull failed', {}, error);
      new Notice(`Configuration pull failed: ${message}`);
    }
  }

  private getConfigSyncService(): ConfigSyncService {
    if (!this.driveClient) {
      new Notice('Drive client is not available.');
      throw new Error('Drive client unavailable while creating config sync service.');
    }

    const { vaultRootNodeUid } = this.settingsService.getSyncRoots();
    if (!vaultRootNodeUid) {
      new Notice('Sync roots are not ready yet. Please wait and try again.');
      throw new Error('Sync roots not ready while creating config sync service.');
    }

    return new ConfigSyncService(this.app.vault, this.driveClient, vaultRootNodeUid);
  }

  private handleConfigSyncResult(result: ConfigSyncResult, direction: 'push' | 'pull'): void {
    if (result.status === 'aborted') {
      if (result.reason === 'invalid-config-dir') {
        new Notice('Configuration sync is only supported when configDir is inside the vault root.');
        return;
      }

      if (result.reason === 'remote-empty') {
        new Notice('Remote configuration is empty. Pull aborted to avoid clearing local configuration.');
        return;
      }
    }

    if (direction === 'push') {
      new Notice(
        `Configuration push complete.\nUploaded ${result.uploadedFiles} file(s), deleted ${result.deletedRemoteFiles} remote file(s), and deleted ${result.deletedRemoteFolders} remote folder(s).`
      );
      return;
    }

    new Notice(
      `Configuration pull complete. Reopen the vault to apply changes.\nDownloaded ${result.downloadedFiles} file(s), deleted ${result.deletedLocalFiles} local file(s), and deleted ${result.deletedLocalFolders} local folder(s).`
    );
  }

  private setupSettingsTab(plugin: ProtonDriveSyncPlugin): ProtonDriveSyncSettingTab {
    const settingTab = new ProtonDriveSyncSettingTab(
      plugin,
      this.settingsService,
      this.protonSessionService.authState$
    );

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
