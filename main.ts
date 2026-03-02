import { Effect, Option } from 'effect';
import { Notice, Plugin } from 'obsidian';
import { type Subscription } from 'rxjs';

import { pullVault, pushVault } from './actions';
import { getProtonSessionService, initProtonSessionService } from './proton/auth/ProtonSessionService';
import { initProtonHttpClient } from './proton/drive/ObsidianHttpClient';
import { initProtonAccount } from './proton/drive/ProtonAccount';
import { initProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { initObsidianFileApi } from './services/ObsidianFileApi';
import { initObsidianSecretStore } from './services/ObsidianSecretStore';
import { getObsidianSettingsStore, initObsidianSettingsStore } from './services/ObsidianSettingsStore';
import { getLogger } from './services/ObsidianSyncLogger';
import { getProtonCloudObserver, initProtonCloudObserver } from './services/ProtonCloudObserver';
import { getProtonDriveApi, initProtonDriveApi } from './services/ProtonDriveApi';
import { getSyncService, initSyncService } from './services/SyncService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveCaptchaModal } from './ui/modals/captcha-modal';
import { ProtonDriveMailboxPasswordModal } from './ui/modals/mailbox-password-modal';
import { ProtonDriveSyncActionModal, type ConfigSyncAction } from './ui/modals/sync-action-modal';
import { ProtonDriveTwoFactorModal } from './ui/modals/two-factor-modal';
import { ProtonDriveSyncSettingTab } from './ui/settings-tab';
import { createSyncStatusBar, type SyncStatusBarController } from './ui/status-bar';

const PUSH_CONFIG_COMMAND_ID = 'push-vault-config';
const PULL_CONFIG_COMMAND_ID = 'pull-vault-config';
const SYNC_CONTAINER_NAME = 'obsidian-notes';

export default class ProtonDriveSyncPlugin extends Plugin {
  private readonly logger = getLogger('Main');
  private statusBarController: SyncStatusBarController | null = null;

  private readonly subscriptions: Subscription[] = [];

  async onload(): Promise<void> {
    this.logger.info('Loading Proton Drive Sync plugin', this.manifest.version);

    const settings = initObsidianSettingsStore({ save: this.saveData.bind(this), load: this.loadData.bind(this) });
    await settings.load();
    initObsidianSecretStore(this.app.secretStorage);
    initObsidianFileApi(this.app.vault);

    const versionWithoutSuffix = this.manifest.version.includes('-')
      ? this.manifest.version.substring(0, this.manifest.version.lastIndexOf('-'))
      : this.manifest.version;

    const sessionService = initProtonSessionService(`external-drive-obsidiansync@${versionWithoutSuffix}`);
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
    initSyncService(this.app.vault);
    const syncService = getSyncService();

    sessionService.authState$.subscribe(async authState => {
      const effect = Effect.gen(this, function* () {
        this.logger.info('Authentication state changed', authState);

        const session = sessionService.getCurrentSession();
        settings.setAuthenticationResult(session);

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
          this.logger.info('Vault node root ID is: ', vaultRoot.id);

          getObsidianSettingsStore().setVaultRootNodeUid(vaultRoot.id);
          yield* getProtonCloudObserver().subscribeToTreeChanges(vaultRoot.treeEventScopeId);
        } else if (authState === 'disconnected') {
          getProtonCloudObserver().unsubscribeFromTreeChanges();
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
      syncState$: syncService.state$
    });

    this.addRibbonIcon('cloud-cog', 'Proton Drive Sync', () => {
      void this.openSyncActionDialog();
    });

    this.addCommand({
      id: PUSH_CONFIG_COMMAND_ID,
      name: 'Push vault to Proton Drive',
      icon: 'cloud-upload',
      callback: () => {
        void pushVault(this.app, true);
      }
    });

    this.addCommand({
      id: PULL_CONFIG_COMMAND_ID,
      name: 'Pull vault from Proton Drive',
      icon: 'cloud-download',
      callback: () => {
        void pullVault(this.app, true);
      }
    });

    this.setupSettingsTab(this);
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

  async signOut(): Promise<void> {
    this.logger.info('Disconnecting from Proton Drive');

    await Effect.runPromise(Effect.either(getProtonSessionService().signOut()));
    getObsidianSettingsStore().setVaultRootNodeUid(null);
    new Notice('Disconnected from Proton Drive.');
  }

  private async openSyncActionDialog(): Promise<void> {
    const action = await Effect.runPromise(promptFromModal(this.app, app => new ProtonDriveSyncActionModal(app)));
    if (Option.isNone(action)) {
      return;
    }

    await this.executeRegisteredSyncAction(action.value);
  }

  private async executeRegisteredSyncAction(action: ConfigSyncAction): Promise<void> {
    if (action === 'push') {
      await pushVault(this.app, false);
    } else if (action === 'pull') {
      await pullVault(this.app, false);
    }
  }

  private setupSettingsTab(plugin: ProtonDriveSyncPlugin): ProtonDriveSyncSettingTab {
    const settingTab = new ProtonDriveSyncSettingTab(plugin, getProtonSessionService().authState$);

    this.subscriptions.push(
      settingTab.loggingChanged$.subscribe(() => {}),
      settingTab.disconnect$.subscribe(() => {
        this.signOut();
      }),
      settingTab.login$.subscribe(credentials => {
        this.signIn(credentials);
      })
    );

    this.addSettingTab(settingTab);

    return settingTab;
  }
}
