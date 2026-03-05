import { Data, Effect, Option } from 'effect';
import { getLanguage, normalizePath, Notice, Plugin } from 'obsidian';
import { combineLatest, distinctUntilChanged, map, type Subscription } from 'rxjs';

import { pullVault, pushVault } from './actions';
import { getI18n, initI18n } from './i18n';
import { getProtonSessionService, initProtonSessionService } from './proton/auth/ProtonSessionService';
import { initProtonHttpClient } from './proton/drive/ObsidianHttpClient';
import { initProtonAccount } from './proton/drive/ProtonAccount';
import { initProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { getLogger } from './services/ConsoleLogger';
import { initObsidianFileApi } from './services/ObsidianFileApi';
import { initObsidianSecretStore } from './services/ObsidianSecretStore';
import {
  DEFAULT_SYNC_CONTAINER_NAME,
  getObsidianSettingsStore,
  initObsidianSettingsStore
} from './services/ObsidianSettingsStore';
import { getProtonCloudObserver, initProtonCloudObserver } from './services/ProtonCloudObserver';
import type { ProtonFolder } from './services/ProtonDriveApi';
import { getProtonDriveApi, initProtonDriveApi } from './services/ProtonDriveApi';
import { getSyncService, initSyncService } from './services/SyncService';
import { promptFromModal } from './ui/modal-prompt';
import { ProtonDriveCaptchaModal } from './ui/modals/captcha-modal';
import { ProtonDriveMailboxPasswordModal } from './ui/modals/mailbox-password-modal';
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

    const sessionService = initProtonSessionService(`external-drive-obsidiansync@${this.manifest.version}`);
    await Effect.runPromise(
      sessionService
        .loadSession()
        .pipe(
          Effect.catchTag('ProtonApiCommunicationError', error =>
            Effect.succeed(this.logger.error(t.main.notices.login.protonApiCommunicationFailed(error.message), error))
          )
        )
    );

    initProtonAccount();
    initProtonHttpClient();
    initProtonDriveClient();
    initProtonDriveApi();
    initProtonCloudObserver();
    initSyncService(this.app.vault);
    initSyncProgressModal(this.app);
    const syncService = getSyncService();

    const remoteVaultRootPath$ = settings.settings$.pipe(
      map(_ => _.remoteVaultRootPath),
      distinctUntilChanged()
    );
    combineLatest([remoteVaultRootPath$, sessionService.authState$]).subscribe(
      async ([remoteVaultRootPath, authState]) => {
        const effect = Effect.gen(this, function* () {
          this.logger.debug(
            'Auth state or remote vault root path changed. Setting up vault root in Proton Drive if needed.',
            {
              authState,
              remoteVaultRootPath
            }
          );
          const session = sessionService.getCurrentSession();
          settings.setAuthenticationResult(session);

          if (authState === 'connected') {
            const vaultRoot = yield* this.ensureVaultRootFolder(remoteVaultRootPath);
            getObsidianSettingsStore().set('vaultRootNodeUid', Option.some(vaultRoot.id));
            yield* getProtonCloudObserver().subscribeToTreeChanges(vaultRoot.treeEventScopeId);
          } else if (authState === 'disconnected') {
            getProtonCloudObserver().unsubscribeFromTreeChanges();
          }
        }).pipe(
          Effect.catchAll(error => {
            return Effect.gen(this, function* () {
              this.logger.error('Error in vault root setup', error);
              getObsidianSettingsStore().set('vaultRootNodeUid', Option.none());

              return yield* error;
            });
          }),
          Effect.catchTags({
            InvalidName: () => Effect.succeed(new Notice(t.main.notices.invalidFolderName)),
            ItemAlreadyExists: () => Effect.succeed(new Notice(t.main.notices.folderAlreadyExists)),
            MyFilesRootFilesNotFound: () => Effect.succeed(new Notice(t.main.notices.myFilesRootNotFound)),
            GenericProtonDriveError: () => Effect.succeed(new Notice(t.main.notices.setupVaultRootFailed)),
            ProtonApiError: () => Effect.succeed(new Notice(t.main.notices.protonApiError)),
            AmbiguousSharedPathError: () => Effect.succeed(new Notice(t.main.notices.ambiguousSharedPath)),
            SharedFolderNotFoundError: () => Effect.succeed(new Notice(t.main.notices.sharedFolderNotFound)),
            InvalidSharedPathError: () => Effect.succeed(new Notice(t.main.notices.invalidSharedPath)),
            TreeEventSubscriptionFailed: () => Effect.succeed(new Notice(t.main.notices.treeSubscriptionFailed))
          })
        );

        await Effect.runPromise(effect);
      }
    );

    this.statusBarController = createSyncStatusBar(this, {
      loginState$: sessionService.authState$,
      syncState$: syncService.state$
    });

    this.addRibbonIcon('cloud-cog', t.ribbon.openSyncActions, () => {
      void this.openSyncActionDialog();
    });

    this.addCommand({
      id: PUSH_CONFIG_COMMAND_ID,
      name: t.commands.pushVault,
      icon: 'cloud-upload',
      callback: () => {
        void pushVault(this.app);
      }
    });

    this.addCommand({
      id: PULL_CONFIG_COMMAND_ID,
      name: t.commands.pullVault,
      icon: 'cloud-download',
      callback: () => {
        void pullVault(this.app);
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
          CaptchaDataNotProvidedError: () => Effect.succeed(new Notice(t.main.notices.login.captchaDataNotProvided)),
          CaptchaRequiredError: () => Effect.succeed(new Notice(t.main.notices.login.captchaRequired)),
          TwoFactorCodeRequiredError: () => Effect.succeed(new Notice(t.main.notices.login.twoFactorRequired)),
          EncryptionPasswordRequiredError: () =>
            Effect.succeed(new Notice(t.main.notices.login.mailboxPasswordRequired)),
          ProtonApiCommunicationError: error =>
            Effect.succeed(new Notice(t.main.notices.login.protonApiCommunicationFailed(error.message)))
        })
      )
    );
  }

  async signOut(): Promise<void> {
    const { t } = getI18n();

    this.logger.info('Disconnecting from Proton Drive');

    await Effect.runPromise(Effect.either(getProtonSessionService().signOut()));
    getObsidianSettingsStore().set('vaultRootNodeUid', Option.none());
    new Notice(t.main.notices.disconnected);
  }

  private ensureVaultRootFolder(remoteVaultRootPath: string | null) {
    return Effect.gen(this, function* () {
      const normalizedRemoteRootPath = normalizePath(remoteVaultRootPath ?? this.defaultRemoteVaultRootPath);
      const pathSegments = normalizedRemoteRootPath.split('/').filter(segment => segment.trim() !== '');

      const protonApi = getProtonDriveApi();

      let remoteRootId: ProtonFolder;
      if (normalizedRemoteRootPath.startsWith('$shared$/')) {
        // target root is a folder shared with the user - we should not attempt to create it, only to find it
        if (pathSegments.length < 2) {
          // at least $shared$ and one folder name are required in the path
          return yield* new InvalidSharedPathError();
        }

        const shareName = pathSegments[1];
        const shares = yield* protonApi.getSharedFolders();
        const matchingShares = shares.filter(share => share.name === shareName);

        if (matchingShares.length === 0) {
          return yield* new SharedFolderNotFoundError();
        }

        if (matchingShares.length > 1) {
          return yield* new AmbiguousSharedPathError();
        }

        const targetShare = matchingShares[0];

        remoteRootId = yield* this.ensureRemotePath(targetShare, pathSegments.slice(2));
      } else {
        // target root is the user's own folder
        const myFilesRoot = yield* protonApi.getRootFolder();
        remoteRootId = yield* this.ensureRemotePath(myFilesRoot, pathSegments);
      }

      this.logger.info('Vault node root ID is: ', remoteRootId);

      return remoteRootId;
    });
  }

  private ensureRemotePath(parent: ProtonFolder, pathSegments: string[]) {
    const protonApi = getProtonDriveApi();
    let currentFolder = parent;

    return Effect.gen(this, function* () {
      for (const segment of pathSegments) {
        const maybeFolder = yield* protonApi.getFolderByName(segment, currentFolder.id);
        if (Option.isSome(maybeFolder)) {
          currentFolder = maybeFolder.value;
        } else {
          const newFolder = yield* protonApi.createFolder(segment, currentFolder.id);
          currentFolder = newFolder;
        }
      }

      return currentFolder;
    });
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
      await pushVault(this.app);
    } else if (action === 'pull') {
      await pullVault(this.app);
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

class InvalidSharedPathError extends Data.TaggedError('InvalidSharedPathError') {}
class SharedFolderNotFoundError extends Data.TaggedError('SharedFolderNotFoundError') {}
class AmbiguousSharedPathError extends Data.TaggedError('AmbiguousSharedPathError') {}
