import { App, Notice, Plugin } from 'obsidian';
import { BehaviorSubject, type Subscription } from 'rxjs';

import { initProtonAccount } from './proton/drive/ProtonAccount';
import { createSyncStatusBar, type SyncStatusBarController } from './ui/status-bar';
import { ProtonDriveSyncSettingTab } from './ui/settings-tab';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveTwoFactorModal } from './ui/modals/two-factor-modal';
import { ProtonDriveMailboxPasswordModal } from './ui/modals/mailbox-password-modal';
import { ProtonDriveCaptchaModal } from './ui/modals/captcha-modal';
import { ProtonDriveConfigSyncActionModal, type ConfigSyncAction } from './ui/modals/config-sync-action-modal';
import { initObsidianSecretStore } from './services/vNext/ObsidianSecretStore';
import { initObsidianFileApi } from './services/vNext/ObsidianFileApi';
import { initObsidianFileObserver } from './services/vNext/ObsidianFileObserver';
import { getProtonDriveApi, initProtonDriveApi } from './services/vNext/ProtonDriveApi';
import { initProtonCloudObserver } from './services/vNext/ProtonCloudObserver';
import { getObsidianSettingsStore, initObsidianSettingsStore } from './services/vNext/ObsidianSettingsStore';
import { getProtonSessionService, initProtonSessionService } from './proton/auth/vNext/ProtonSessionService';
import { initProtonHttpClient } from './proton/drive/ObsidianHttpClient';
import { initProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { getLogger } from './services/vNext/ObsidianSyncLogger';
import { Effect, Option } from 'effect';
import { getConfigSyncService, initConfigSyncService } from './services/vNext/ConfigSyncService';
import { ProtonDriveConfigSyncProgressModal } from './ui/modals/config-sync-progress-modal';
import type { SyncEngineState } from './services/ObsidianSyncService';
import type { ReconcileState } from './services/CloudReconciliationService';

const PUSH_CONFIG_COMMAND_ID = 'push-vault-config';
const PULL_CONFIG_COMMAND_ID = 'pull-vault-config';
const SYNC_CONTAINER_NAME = 'obsidian-notes';

export default class ProtonDriveSyncPlugin extends Plugin {
  private readonly logger = getLogger('Main');
  private statusBarController: SyncStatusBarController | null = null;

  private readonly subscriptions: Subscription[] = [];

  async onload(): Promise<void> {
    this.logger.info('Loading Proton Drive Sync plugin', this.manifest.version);
    this.app.workspace.onLayoutReady(() => {
      fileObserver.changes$.subscribe(change => {
        this.logger.info('Observed vault change', change);
      });
    });

    initObsidianSettingsStore({ save: this.loadData.bind(this), load: this.loadData.bind(this) });
    initObsidianSecretStore(this.app.secretStorage);
    initObsidianFileApi(this.app.vault);
    const fileObserver = initObsidianFileObserver(this.app.vault);

    const sessionService = initProtonSessionService(`external-drive-obsidiansync@${this.manifest.version}`);
    await Effect.runPromise(
      sessionService
        .loadSession()
        .pipe(
          Effect.catchTag('ProtonApiCommunicationError', error =>
            Effect.succeed(this.logger.error('Failed to re-establish Proton session. Please log in again.', error))
          )
        )
    );

    initProtonAccount();
    initProtonHttpClient();
    initProtonDriveClient();
    initProtonDriveApi();
    initProtonCloudObserver();
    initConfigSyncService(this.app.vault);
    const configSyncService = getConfigSyncService();

    sessionService.authState$.subscribe(async authState => {
      const effect = Effect.gen(this, function* () {
        this.logger.info('Authentication state changed', authState);

        if (authState === 'connected') {
          const protonApi = getProtonDriveApi();
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
      }).pipe(
        Effect.catchAll(error => {
          return Effect.gen(this, function* () {
            this.logger.error('Error in vault root setup', error);
            getObsidianSettingsStore().setVaultRootNodeUid(null);

            return yield* error;
          });
        }),
        Effect.catchTags({
          InvalidName: () => Effect.succeed(new Notice('Invalid folder name.')),
          ItemAlreadyExists: () => Effect.succeed(new Notice('Folder already exists.')),
          MyFilesRootFilesNotFound: () =>
            Effect.succeed(new Notice('The "My Files" root folder was not found in Proton Drive.')),
          GenericProtonDriveError: () =>
            Effect.succeed(
              new Notice(
                'An error occurred while setting up the vault root folder in Proton Drive. Please try again later.'
              )
            )
        })
      );

      await Effect.runPromise(effect);
    });

    this.statusBarController = createSyncStatusBar(this, {
      loginState$: sessionService.authState$,
      syncState$: new BehaviorSubject<SyncEngineState>('idle'), // Placeholder, will be set properly after orchestrator is created
      reconcileState$: new BehaviorSubject<ReconcileState>('idle'), // Placeholder, will be set properly after orchestrator is created
      configSyncState$: configSyncService.state$
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
        // void this.pullVaultConfig();
      }
    });

    this.setupSettingsTab(this);
    fileObserver.start();
  }

  async onunload(): Promise<void> {
    this.logger.info('Unloading Proton Drive Sync plugin');
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.subscriptions.length = 0;
    this.statusBarController?.dispose();
    this.statusBarController = null;
    await Effect.runPromise(getProtonSessionService().dispose());
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
    const configSyncService = getConfigSyncService();
    const progressModal = new ProtonDriveConfigSyncProgressModal(this.app, configSyncService.state$);
    progressModal.open();

    new Notice('Pushing vault configuration to Proton Drive...');

    await Effect.runPromise(
      configSyncService.pushConfig().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            progressModal.markCompleted();
            new Notice('Configuration push completed.');
          })
        ),
        Effect.catchTag('SyncAlreadyInProgressError', () =>
          Effect.sync(() => {
            progressModal.close();
            new Notice('A configuration sync is already in progress. Please wait for it to complete.');
          })
        ),
        Effect.catchAll(e => {
          this.logger.error('Configuration push failed', e);
          return Effect.sync(() => {
            progressModal.markFailed('Configuration push failed. Please try again.');
            new Notice('Configuration push failed. Please try again.');
          });
        })
      )
    );
  }

  // private async pullVaultConfig(): Promise<void> {
  //   const configSyncService = this.configSyncService;
  //   if (!configSyncService || !this.cloudReconciliationService) {
  //     return;
  //   }

  //   const confirmed = await promptFromModal(
  //     this.app,
  //     app =>
  //       new ProtonDriveConfirmModal(
  //         app,
  //         'Pull vault configuration?',
  //         'This can be destructive. Local vault configuration files will be replaced by remote configuration files.',
  //         'Pull and replace local config'
  //       )
  //   );

  //   if (!confirmed) {
  //     new Notice('Configuration pull canceled.');
  //     return;
  //   }

  //   new Notice('Pulling vault configuration from Proton Drive...');

  //   try {
  //     const result = await configSyncService.pullConfig();
  //     this.handleConfigSyncResult(result, 'pull');
  //   } catch (error) {
  //     const message = error instanceof Error ? error.message : String(error);
  //     this.logger.error('Config pull failed', error);
  //     new Notice(`Configuration pull failed: ${message}`);
  //   }
  // }

  // private handleConfigSyncResult(result: ConfigSyncResult, direction: 'push' | 'pull'): void {
  //   if (result.status === 'aborted') {
  //     if (result.reason === 'invalid-config-dir') {
  //       new Notice('Configuration sync is only supported when configDir is inside the vault root.');
  //       return;
  //     }

  //     if (result.reason === 'remote-empty') {
  //       new Notice('Remote configuration is empty. Pull aborted to avoid clearing local configuration.');
  //       return;
  //     }
  //   }

  //   if (direction === 'push') {
  //     new Notice(
  //       `Configuration push complete.\nUploaded ${result.uploadedFiles} file(s), deleted ${result.deletedRemoteFiles} remote file(s), and deleted ${result.deletedRemoteFolders} remote folder(s).`
  //     );
  //     return;
  //   }

  //   new Notice(
  //     `Configuration pull complete. Reopen the vault to apply changes.\nDownloaded ${result.downloadedFiles} file(s), deleted ${result.deletedLocalFiles} local file(s), and deleted ${result.deletedLocalFolders} local folder(s).`
  //   );
  // }

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
