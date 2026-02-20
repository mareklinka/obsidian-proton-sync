import { Notice, Plugin } from 'obsidian';
import type { Subscription } from 'rxjs';

import { ProtonDriveLoginModal } from './login-modal';
import { DEFAULT_SETTINGS, ProtonDriveSyncSettings, ProtonDriveSyncSettingTab } from './settings';
import { createFileLogger, getDefaultLogFilePath, type PluginLogger } from './logger';
import { ensureSyncRoots } from './sync-root';
import { ObsidianVaultFileSystemReader } from './isolated-sync/ObsidianVaultFileSystemReader';
import { RxSyncService, type SyncIndexSnapshot } from './isolated-sync/RxSyncService';
import { ProtonDriveCloudStorageApi } from './isolated-sync/ProtonDriveCloudStorageApi';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonSessionService, ProtonSessionState } from './proton/auth/ProtonSessionService';
import { loadSession, saveSession } from './session-store';
import { ObsidianSecretRepository } from './Services/ObsidianSecretRepository';
import { ProtonAccount } from './proton/drive/ProtonAccount';
import { createProtonDriveClient } from './proton/drive/ProtonDriveClient';
import { ObsidianHttpClient } from './proton/drive/ObsidianHttpClient';
import { ReconciliationService, type ReconciliationTombstone } from './isolated-sync/ReconciliationService';

export default class ProtonDriveSyncPlugin extends Plugin {
  settings!: ProtonDriveSyncSettings;
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

    const secretStore = new ObsidianSecretRepository(this.app);

    this.protonSessionService = new ProtonSessionService(secretStore, this.manifest.version);
    const protonAccount = new ProtonAccount(this.protonSessionService, secretStore);
    this.driveClient = createProtonDriveClient(protonAccount, new ObsidianHttpClient(this.protonSessionService));

    this.sessionSubscription = this.protonSessionService.currentSession$.subscribe(session => {
      this.applyAuthResultToSettings(session);

      if (session.state === 'ok') {
        saveSession(this.app, session.session);
        if (!this.syncBootstrapped && !this.syncBootstrapInProgress) {
          this.syncBootstrapInProgress = true;
          void this.bootstrapSyncFromSession().finally(() => {
            this.syncBootstrapInProgress = false;
          });
        }
        return;
      }

      if (session.state === 'disconnected' || session.state === 'logged-out') {
        this.syncBootstrapped = false;
        this.disposeIsolatedSync();
      }
    });

    const existingSession = loadSession(this.app);
    if (existingSession) {
      await this.protonSessionService.refreshSession(existingSession);
    }

    this.settingTab = new ProtonDriveSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addRibbonIcon('refresh-ccw', 'Proton Drive Sync', () => {
      new Notice('Proton Drive Sync: scaffold loaded');
    });
  }

  async onunload(): Promise<void> {
    this.logger.info('Unloading Proton Drive Sync plugin');
    this.sessionSubscription?.unsubscribe();
    this.sessionSubscription = null;
    this.protonSessionService?.dispose();
    this.disposeIsolatedSync();
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
      await this.protonSessionService.signIn(credentials.email.trim(), credentials.password, credentials.twoFactorCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed.';
      new Notice(message);
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Proton Drive');
    this.protonSessionService.signOut();
    this.syncBootstrapped = false;
    this.disposeIsolatedSync();
    this.saveSettings();
    new Notice('Disconnected from Proton Drive.');
  }

  private async bootstrapSyncFromSession(): Promise<void> {
    if (!this.driveClient) {
      return;
    }

    try {
      const vaultName = this.app.vault.getName();
      const info = await ensureSyncRoots(this.driveClient, this.settings, vaultName, this.logger);
      const reconciliation = new ReconciliationService(
        this.app.vault,
        this.driveClient,
        info.vaultRootNodeUid,
        this.logger,
        {
          previousSnapshot: this.buildInitialSyncSnapshot(),
          tombstones: this.settings.reconciliationTombstones.map(
            (item: ProtonDriveSyncSettings['reconciliationTombstones'][number]) => ({
              ...item,
              deletedAt: Date.parse(item.deletedAt)
            })
          )
        }
      );
      const reconciliationResult = await reconciliation.run();

      this.applySnapshotToSettings(reconciliationResult.snapshot);
      this.settings.reconciliationTombstones = reconciliationResult.tombstones.map((item: ReconciliationTombstone) => ({
        ...item,
        deletedAt: new Date(item.deletedAt).toISOString()
      }));
      await this.saveSettings();

      this.initializeIsolatedSync(reconciliationResult.snapshot);
      this.syncBootstrapped = true;

      this.logger.info('Initial reconciliation completed', {
        ...reconciliationResult.stats
      });
      this.logger.info('Sync roots ready', { ...info });
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
      this.buildInitialSyncSnapshot()
    );

    const syncService = new RxSyncService(reader, cloudApi);
    syncService.initializeIndex(initialSnapshot ?? this.buildInitialSyncSnapshot());

    this.syncSubscriptions.push(
      reader.changes$.subscribe(change => {
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
        this.applySnapshotToSettings(event.snapshot);
        void this.saveSettings();

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
  }

  private buildInitialSyncSnapshot(): SyncIndexSnapshot {
    const byPath: SyncIndexSnapshot['byPath'] = {};
    const byCloudId: SyncIndexSnapshot['byCloudId'] = {};

    for (const [path, entry] of Object.entries(this.settings.pathMap)) {
      const updatedAt = Date.parse(entry.updatedAt);
      const normalizedUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now();
      const indexEntry = {
        cloudId: entry.nodeUid,
        path,
        entityType: 'file' as const,
        updatedAt: normalizedUpdatedAt
      };

      byPath[path] = indexEntry;
      byCloudId[entry.nodeUid] = indexEntry;
    }

    for (const [path, entry] of Object.entries(this.settings.folderMap)) {
      const updatedAt = Date.parse(entry.updatedAt);
      const normalizedUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now();
      const indexEntry = {
        cloudId: entry.nodeUid,
        path,
        entityType: 'folder' as const,
        updatedAt: normalizedUpdatedAt
      };

      byPath[path] = indexEntry;
      byCloudId[entry.nodeUid] = indexEntry;
    }

    return { byPath, byCloudId };
  }

  private applySnapshotToSettings(snapshot: SyncIndexSnapshot): void {
    const pathMap: ProtonDriveSyncSettings['pathMap'] = {};
    const folderMap: ProtonDriveSyncSettings['folderMap'] = {};

    for (const entry of Object.values(snapshot.byPath)) {
      const updatedAt = new Date(entry.updatedAt).toISOString();
      if (entry.entityType === 'folder') {
        folderMap[entry.path] = {
          nodeUid: entry.cloudId,
          updatedAt
        };
      } else {
        pathMap[entry.path] = {
          nodeUid: entry.cloudId,
          updatedAt
        };
      }
    }

    this.settings.pathMap = pathMap;
    this.settings.folderMap = folderMap;
  }

  private applyAuthResultToSettings(sessionState: ProtonSessionState): void {
    if (sessionState.state === 'ok') {
      this.settings.connectionStatus = 'connected';
      this.settings.lastLoginError = null;
      this.settings.lastLoginAt = sessionState.session.updatedAt;
      this.settings.lastRefreshAt = new Date(sessionState.session.lastRefreshAt).toISOString();
      this.settings.sessionExpiresAt = new Date(sessionState.session.expiresAt).toISOString();
    } else {
      this.settings.connectionStatus = 'disconnected';
      this.settings.sessionExpiresAt = null;
    }

    this.saveSettings();
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
