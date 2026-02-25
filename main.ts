import { App, Notice, Plugin } from 'obsidian';
import { Subject, type Subscription } from 'rxjs';

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonAccount } from './proton/drive/ProtonAccount';
import { createProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { ObsidianHttpClient } from './proton/drive/ObsidianHttpClient';
import { createSyncStatusBar, type SyncStatusBarController } from './ui/status-bar';
import { CloudReconciliationService } from './services/CloudReconciliationService';
import { ProtonDriveSyncSettingTab } from './ui/settings-tab';
import { SyncOrchestrationService } from './services/SyncOrchestrationService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveTwoFactorModal } from './ui/modals/two-factor-modal';
import { ProtonDriveMailboxPasswordModal } from './ui/modals/mailbox-password-modal';
import { ProtonDriveCaptchaModal } from './ui/modals/captcha-modal';
import { ConfigSyncService, type ConfigSyncResult } from './services/ConfigSyncService';
import { ProtonDriveConfirmModal } from './ui/modals/confirm-modal';
import { ProtonDriveConfigSyncActionModal, type ConfigSyncAction } from './ui/modals/config-sync-action-modal';
import { initObsidianSecretStore } from './services/vNext/ObsidianSecretStore';
import { initObsidianFileApi } from './services/vNext/ObsidianFileApi';
import { initObsidianFileObserver } from './services/vNext/ObsidianFileObserver';
import { initProtonCloudApi } from './services/vNext/ProtonCloudApi';
import { initProtonCloudObserver } from './services/vNext/ProtonCloudObserver';
import { getObsidianSettingsStore, initObsidianSettingsStore } from './services/vNext/ObsidianSettingsStore';
import { getProtonSessionService, initProtonSessionService } from './proton/auth/vNext/ProtonSessionService';
import { getLogger } from './services/vNext/ObsidianSyncLogger';
import { Effect, Option } from 'effect';

const PUSH_CONFIG_COMMAND_ID = 'push-vault-config';
const PULL_CONFIG_COMMAND_ID = 'pull-vault-config';
const SYNC_CONTAINER_NAME = 'obsidian-notes';

export default class ProtonDriveSyncPlugin extends Plugin {
  private readonly logger = getLogger('Main');

  private driveClient: ProtonDriveClient | null = null;
  private orchestrator: SyncOrchestrationService | null = null;
  private cloudReconciliationService: CloudReconciliationService | null = null;
  private statusBarController: SyncStatusBarController | null = null;
  private readonly subscriptions: Subscription[] = [];
  private configSyncService: ConfigSyncService | null = null;

  async onload(): Promise<void> {
    this.logger.info('Loading Proton Drive Sync plugin', this.manifest.version);

    initObsidianSettingsStore({ save: this.loadData.bind(this), load: this.loadData.bind(this) });
    initObsidianSecretStore(this.app.secretStorage);
    initObsidianFileApi(this.app.vault);
    const fileObserver = initObsidianFileObserver(this.app.vault);

    this.app.workspace.onLayoutReady(() => {
      fileObserver.changes$.subscribe(change => {
        this.logger.info('Observed vault change', change);
      });
    });

    const sessionService = initProtonSessionService(`external-drive-obsidiansync@${this.manifest.version}`);
    await Effect.runPromise(sessionService.loadSession());
    const protonAccount = new ProtonAccount();
    this.driveClient = createProtonDriveClient(protonAccount, new ObsidianHttpClient());

    const protonApi = initProtonCloudApi(this.driveClient);
    initProtonCloudObserver(this.driveClient);

    // this.configSyncService = this.getConfigSyncService();

    sessionService.authState$.subscribe(async authState => {
      const effect = Effect.gen(this, function* () {
        this.logger.info('Authentication state changed', authState);

        if (authState === 'connected') {
          const myFilesRoot = yield* protonApi.getRootFolder();
          const maybeSyncRoot = yield* protonApi.getFolderByName(SYNC_CONTAINER_NAME, myFilesRoot.id);

          const syncRoot = Option.isSome(maybeSyncRoot)
            ? maybeSyncRoot.value
            : yield* protonApi.createFolder(SYNC_CONTAINER_NAME, myFilesRoot.id);

          const maybeVaultContainerRoot = yield* protonApi.getFolderByName(this.app.vault.getName(), syncRoot.id);

          const vaultRoot = Option.isSome(maybeVaultContainerRoot)
            ? maybeVaultContainerRoot.value
            : yield* protonApi.createFolder(this.app.vault.getName(), syncRoot.id);

          getObsidianSettingsStore().setVaultRootNodeUid(vaultRoot.id);

          this.logger.info('Vault node root ID is: ', vaultRoot.id);
        }
      });

      await Effect.runPromise(effect);
    });

    this.statusBarController = createSyncStatusBar(this, {
      loginState$: sessionService.authState$,
      syncState$: new Subject(), // Placeholder, will be set properly after orchestrator is created
      reconcileState$: new Subject(), // Placeholder, will be set properly after orchestrator is created
      configSyncState$: new Subject() // Placeholder, will be set properly after configSyncService is created
    });

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

    this.setupSettingsTab(this);
    fileObserver.start();
  }

  async onunload(): Promise<void> {
    this.logger.info('Unloading Proton Drive Sync plugin');
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.subscriptions.length = 0;
    await this.orchestrator?.dispose();
    this.orchestrator = null;
    this.statusBarController?.dispose();
    this.statusBarController = null;
    getProtonSessionService().dispose();
  }

  async signIn(credentials: { email: string; password: string }): Promise<void> {
    if (!credentials.email || !credentials.password) {
      new Notice('Email and password are required to connect.');
      return;
    }

    const app = this.app;

    Effect.runPromise(
      Effect.gen(
        (this,
        function* () {
          yield* getProtonSessionService().signIn(credentials.email.trim(), credentials.password, {
            requestTwoFactorCode: () => promptFromModal(app, app => new ProtonDriveTwoFactorModal(app)),
            requestMailboxPassword: () => promptFromModal(app, app => new ProtonDriveMailboxPasswordModal(app)),
            requestCaptchaChallenge: (captchaUrl: string) =>
              promptFromModal(app, app => new ProtonDriveCaptchaModal(app, captchaUrl))
          });
        })
      ).pipe(
        Effect.catchTags({
          CaptchaDataNotProvidedError: () =>
            Effect.succeed(new Notice('Captcha data was not provided. Login aborted.')),
          CaptchaRequiredError: () => Effect.succeed(new Notice('Captcha is required to login. Login aborted.')),
          TwoFactorCodeRequiredError: () =>
            Effect.succeed(new Notice('Two-factor code is required to login. Login aborted.')),
          EncryptionPasswordRequiredError: () =>
            Effect.succeed(new Notice('Mailbox password is required to login. Login aborted.')),
          ProtonApiCommunicationError: error =>
            Effect.succeed(new Notice(`Failed to communicate with Proton API: ${error.message}. Login aborted.`))
        })
      )
    );
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Proton Drive');
    await this.orchestrator?.disconnect();

    await Effect.runPromise(Effect.either(getProtonSessionService().signOut()));
    new Notice('Disconnected from Proton Drive.');
  }

  private async openConfigSyncActionDialog(): Promise<void> {
    const action = await Effect.runPromise(promptFromModal(this.app, app => new ProtonDriveConfigSyncActionModal(app)));
    if (Option.isNone(action)) {
      return;
    }

    await this.executeRegisteredConfigSyncAction(action.value);
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
      this.logger.error('Config push failed', error);
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
      this.logger.error('Config pull failed', error);
      new Notice(`Configuration pull failed: ${message}`);
    }
  }

  private getConfigSyncService(): ConfigSyncService {
    if (!this.driveClient) {
      new Notice('Drive client is not available.');
      throw new Error('Drive client unavailable while creating config sync service.');
    }

    throw new Error('Config sync service is not implemented yet.');
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
    const settingTab = new ProtonDriveSyncSettingTab(plugin, getProtonSessionService().authState$);

    this.subscriptions.push(
      settingTab.loggingChanged$.subscribe(() => {}),
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
