import { Effect, Option } from 'effect';
import { getLanguage, normalizePath, Notice, Plugin } from 'obsidian';
import { type Subscription } from 'rxjs';

import { pullVault, pushVault } from './actions';
import { getI18n, initI18n } from './i18n';
import { getProtonSessionService, initProtonSessionService } from './proton/auth/ProtonSessionService';
import { getLogger } from './services/ConsoleLogger';
import { initObsidianFileApi } from './services/ObsidianFileApi';
import { initObsidianSecretStore } from './services/ObsidianSecretStore';
import {
  DEFAULT_SYNC_CONTAINER_NAME,
  getObsidianSettingsStore,
  initObsidianSettingsStore
} from './services/ObsidianSettingsStore';
import { initSyncService } from './services/SyncService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveCaptchaModal } from './ui/modals/captcha-modal';
import { ProtonDriveMailboxPasswordModal } from './ui/modals/mailbox-password-modal';
import { ProtonDriveMasterPasswordModal } from './ui/modals/master-password-modal';
import { type ConfigSyncAction, ProtonDriveSyncActionModal } from './ui/modals/sync-action-modal';
import { initSyncProgressModal } from './ui/modals/sync-progress-modal';
import { ProtonDriveTwoFactorModal } from './ui/modals/two-factor-modal';
import { ProtonDriveSyncSettingTab } from './ui/settings-tab';
import { createSyncStatusBar, type SyncStatusBarController } from './ui/status-bar';

const PUSH_CONFIG_COMMAND_ID = 'push-vault-config';
const PULL_CONFIG_COMMAND_ID = 'pull-vault-config';

export default class ProtonDriveSyncPlugin extends Plugin {
  private readonly logger = getLogger('Main');
  private readonly defaultRemoteVaultRootPath = normalizePath(
    `${DEFAULT_SYNC_CONTAINER_NAME}/${this.app.vault.getName()}`
  );
  private statusBarController: SyncStatusBarController | null = null;

  private readonly subscriptions: Subscription[] = [];

  async onload(): Promise<void> {
    initI18n(getLanguage());
    const { t } = getI18n();

    this.logger.info('Loading Proton Drive Sync plugin', this.manifest.version);
    this.logger.info('Obsidian language:', getLanguage());

    const settings = initObsidianSettingsStore(this.defaultRemoteVaultRootPath, {
      save: this.saveData.bind(this),
      load: this.loadData.bind(this)
    });

    await settings.load();
    initObsidianSecretStore(this.app.secretStorage);
    initObsidianFileApi(this.app.vault);

    initProtonSessionService(`external-drive-obsidiansync@${this.manifest.version}`);

    const syncService = initSyncService(this.app.vault);
    initSyncProgressModal(this.app);

    this.statusBarController = createSyncStatusBar(this, syncService.state$);

    this.addRibbonIcon('cloud-cog', t.ribbon.openSyncActions, () => {
      void this.openSyncActionDialog();
    });

    this.addCommand({
      id: PUSH_CONFIG_COMMAND_ID,
      name: t.commands.pushVault,
      icon: 'cloud-upload',
      callback: async () => {
        await this.executeRegisteredSyncAction('push');
      }
    });

    this.addCommand({
      id: PULL_CONFIG_COMMAND_ID,
      name: t.commands.pullVault,
      icon: 'cloud-download',
      callback: async () => {
        await this.executeRegisteredSyncAction('pull');
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
    const { t } = getI18n();

    if (!credentials.email || !credentials.password) {
      new Notice(t.main.notices.login.credentialsRequired);
      return;
    }

    const app = this.app;

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* getProtonSessionService().signIn(credentials.email.trim(), credentials.password, {
          requestTwoFactorCode: () => promptFromModal(app, app => new ProtonDriveTwoFactorModal(app)),
          requestMailboxPassword: () => promptFromModal(app, app => new ProtonDriveMailboxPasswordModal(app)),
          requestCaptchaChallenge: (captchaUrl: string) =>
            promptFromModal(app, app => new ProtonDriveCaptchaModal(app, captchaUrl)),
          requestMasterPassword: () => promptFromModal(app, app => new ProtonDriveMasterPasswordModal(app, 'setup'))
        });

        const sessionService = getProtonSessionService();
        const currentSession = sessionService.getCurrentSession();

        if (Option.isSome(currentSession)) {
          const settingsStore = getObsidianSettingsStore();
          settingsStore.set('lastLoginAt', new Date());
          settingsStore.set('lastRefreshAt', new Date());
          settingsStore.set('sessionExpiresAt', currentSession.value.expiresAt);
        }
      }).pipe(
        Effect.catchTags({
          CaptchaDataNotProvidedError: () => Effect.succeed(new Notice(t.main.notices.login.captchaDataNotProvided)),
          CaptchaRequiredError: () => Effect.succeed(new Notice(t.main.notices.login.captchaRequired)),
          TwoFactorCodeRequiredError: () => Effect.succeed(new Notice(t.main.notices.login.twoFactorRequired)),
          EncryptionPasswordRequiredError: () =>
            Effect.succeed(new Notice(t.main.notices.login.mailboxPasswordRequired)),
          MasterPasswordRequiredError: () => Effect.succeed(new Notice(t.main.notices.login.masterPasswordRequired)),
          SecretEncryptionFailedError: () => Effect.succeed(new Notice(t.main.notices.login.secureStorageFailed)),
          ProtonApiCommunicationError: error =>
            Effect.succeed(new Notice(t.main.notices.login.protonApiCommunicationFailed(error.message))),
          CryptographyError: error =>
            Effect.succeed(new Notice(t.main.notices.login.protonApiCommunicationFailed(error.message)))
        })
      )
    );
  }

  async signOut(): Promise<void> {
    const { t } = getI18n();

    this.logger.info('Disconnecting from Proton Drive');

    await Effect.runPromise(Effect.either(getProtonSessionService().signOut()));

    const settingsStore = getObsidianSettingsStore();
    settingsStore.set('lastLoginAt', null);
    settingsStore.set('lastRefreshAt', null);
    settingsStore.set('sessionExpiresAt', null);
    settingsStore.set('vaultRootNodeUid', Option.none());

    new Notice(t.main.notices.disconnected);
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
      await Effect.runPromise(pushVault(this.app));
    } else if (action === 'pull') {
      await Effect.runPromise(pullVault(this.app));
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
