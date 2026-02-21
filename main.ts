import { Notice, Plugin } from 'obsidian';
import { of, type Observable, type Subscription } from 'rxjs';

import { DEFAULT_SETTINGS, ProtonDriveSyncSettings } from './model/settings';
import { createFileLogger, getDefaultLogFilePath, type PluginLogger } from './logger';
import { ensureSyncRoots } from './sync-root';
import { ObsidianVaultFileSystemReader } from './isolated-sync/ObsidianVaultFileSystemReader';
import { RxSyncService, type SyncEngineState, type SyncIndexSnapshot } from './isolated-sync/RxSyncService';
import { ProtonDriveCloudStorageApi } from './isolated-sync/ProtonDriveCloudStorageApi';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonSessionService } from './proton/auth/ProtonSessionService';
import { ObsidianSecretRepository } from './Services/ObsidianSecretRepository';
import { ProtonAccount } from './proton/drive/ProtonAccount';
import { createProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { ObsidianHttpClient } from './proton/drive/ObsidianHttpClient';
import { createSyncStatusBar, type SyncStatusBarController } from './ui/status-bar';
import { CloudReconciliationService } from './CloudReconciliationService';
import { ProtonDriveSyncSettingTab } from './ui/settings-tab';
import { SettingsService } from './Services/SettingsService';

export default class ProtonDriveSyncPlugin extends Plugin {
  private settingsService!: SettingsService;
  private protonSessionService!: ProtonSessionService;
  private driveClient: ProtonDriveClient | null = null;
  private logger!: PluginLogger;
  private settingTab: ProtonDriveSyncSettingTab | null = null;
  private isolatedSyncService: RxSyncService | null = null;
  private syncReader: ObsidianVaultFileSystemReader | null = null;
  private syncSubscriptions: Subscription[] = [];
  private sessionSubscription: Subscription | null = null;
  private syncBootstrapInProgress = false;
  private syncBootstrapped = false;
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

    this.protonSessionService = new ProtonSessionService(secretStore, this.manifest.version);
    this.refreshStatusBarBinding();
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
      getSyncReader: () => this.syncReader,
      getSyncService: () => this.isolatedSyncService
    });

    this.sessionSubscription = this.protonSessionService.currentSession$.subscribe(session => {
      void this.settingsService.applyAuthResult(session);

      if (session.state === 'ok') {
        if (!this.syncBootstrapped && !this.syncBootstrapInProgress) {
          this.syncBootstrapInProgress = true;
          void this.bootstrapSyncFromSession().finally(() => {
            this.syncBootstrapInProgress = false;
          });
        }
        return;
      }

      if (session.state === 'disconnected' || session.state === 'logged-out') {
        this.cloudReconciliationService?.reset();
        this.syncBootstrapped = false;
        this.disposeIsolatedSync();
      }
    });

    await this.protonSessionService.loadSession();

    this.settingTab = this.setupSettingsTab(this);
  }

  async onunload(): Promise<void> {
    this.logger.info('Unloading Proton Drive Sync plugin');
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.subscriptions.length = 0;
    this.sessionSubscription?.unsubscribe();
    this.sessionSubscription = null;
    this.protonSessionService?.dispose();
    this.disposeIsolatedSync();
    this.cloudReconciliationService?.dispose();
    this.cloudReconciliationService = null;
    this.statusBarController?.dispose();
    this.statusBarController = null;
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
      await this.protonSessionService.signIn(credentials.email.trim(), credentials.password, credentials.twoFactorCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed.';
      new Notice(message);
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Proton Drive');
    this.protonSessionService.signOut();
    this.cloudReconciliationService?.reset();
    this.syncBootstrapped = false;

    await this.settingsService.resetForDisconnect();
    this.disposeIsolatedSync();
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

  private async bootstrapSyncFromSession(): Promise<void> {
    if (!this.driveClient || !this.cloudReconciliationService) {
      return;
    }

    try {
      await this.cloudReconciliationService.run(async () => {
        const vaultName = this.app.vault.getName();
        const info = await ensureSyncRoots(this.driveClient!, this.settings, vaultName, this.logger);
        const initialSnapshot = await this.cloudReconciliationService!.runInitialReconciliation(info.vaultRootNodeUid);

        this.initializeIsolatedSync(initialSnapshot);
        await this.cloudReconciliationService!.ensureCloudEventSubscription();
        this.syncBootstrapped = true;
        this.logger.info('Sync roots ready', { ...info });
      });
    } catch (error) {
      this.syncBootstrapped = false;
      this.logger.error('Failed to ensure sync roots', {}, error);
      new Notice('Failed to initialize Proton Drive sync bootstrap.');
    }
  }

  private initializeIsolatedSync(initialSnapshot?: SyncIndexSnapshot): void {
    if (this.isolatedSyncService || this.syncReader || !this.driveClient || !this.settings.vaultRootNodeUid) {
      return;
    }

    const reader = new ObsidianVaultFileSystemReader(this.app.vault, {
      ignoredPathPrefixes: []
    });

    const cloudApi = new ProtonDriveCloudStorageApi(this.driveClient, this.settings.vaultRootNodeUid, this.logger, () =>
      this.settingsService.buildInitialSyncSnapshot()
    );

    const syncService = new RxSyncService(reader, cloudApi);
    syncService.initializeIndex(initialSnapshot ?? this.settingsService.buildInitialSyncSnapshot());
    this.refreshStatusBarBinding(syncService.syncState$);

    this.syncSubscriptions.push(
      reader.changes$.subscribe(change => {
        if (this.cloudReconciliationService?.shouldSuppressLocalChange(change.path, change.oldPath)) {
          this.logger.debug('Suppressed local change generated by remote apply', {
            type: change.type,
            path: change.path,
            oldPath: change.oldPath
          });
          return;
        }

        const changeId = syncService.enqueueChange(change);
        this.logger.debug('Isolated sync change enqueued', {
          changeId,
          type: change.type,
          path: change.path,
          oldPath: change.oldPath
        });
      })
    );

    this.syncSubscriptions.push(
      syncService.dispatchResults$.subscribe(result => {
        if (result.success) {
          this.logger.info('Isolated sync operation dispatched to Proton Drive', {
            changeId: result.changeId
          });
          return;
        }

        this.logger.warn('Isolated sync operation failed', {
          changeId: result.changeId,
          retryScheduled: result.retryScheduled,
          retryable: result.retryable,
          errorMessage: result.errorMessage
        });
      })
    );

    this.syncSubscriptions.push(
      syncService.mapChanges$.subscribe(event => {
        void this.settingsService.applySyncSnapshot(event.snapshot);

        this.logger.debug('Isolated sync index snapshot updated', {
          sequence: event.seq,
          reason: event.reason,
          byPathCount: Object.keys(event.snapshot.byPath).length,
          byCloudIdCount: Object.keys(event.snapshot.byCloudId).length
        });
      })
    );

    reader.start();
    syncService.start();

    this.syncReader = reader;
    this.isolatedSyncService = syncService;

    this.logger.info('Isolated sync queue initialized with Proton cloud service');
  }

  private disposeIsolatedSync(): void {
    for (const subscription of this.syncSubscriptions) {
      subscription.unsubscribe();
    }
    this.syncSubscriptions = [];

    this.isolatedSyncService?.dispose();
    this.syncReader?.dispose();

    this.isolatedSyncService = null;
    this.syncReader = null;
    this.cloudReconciliationService?.reset();
    this.refreshStatusBarBinding();
  }

  private refreshStatusBarBinding(syncState$: Observable<SyncEngineState> = of('idle')): void {
    this.statusBarController?.dispose();
    this.statusBarController = createSyncStatusBar(this, {
      loginState$: this.protonSessionService.authState$,
      syncState$,
      reconcileState$: this.cloudReconciliationService?.state$ ?? of('idle')
    });
  }
}
