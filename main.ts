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
import { normalizePath, toCanonicalPathKey } from './isolated-sync/path-utils';
import type { DriveEvent, LatestEventIdProvider } from '@protontech/drive-sdk';

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
  private cloudEventSubscription: { dispose(): void } | null = null;
  private cloudReconcileInProgress = false;
  private cloudReconcileQueued = false;
  private applyingRemoteChanges = false;
  private readonly suppressedLocalPathsUntil = new Map<string, number>();
  private readonly localSuppressionTtlMs = 5000;

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
    this.driveClient = createProtonDriveClient(
      protonAccount,
      new ObsidianHttpClient(this.protonSessionService),
      this.buildLatestEventIdProvider()
    );

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
    this.cloudEventSubscription?.dispose();
    this.cloudEventSubscription = null;
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
      await this.ensureCloudEventSubscription();
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
        if (this.shouldSuppressLocalChange(change.path, change.oldPath)) {
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
    this.cloudEventSubscription?.dispose();

    this.isolatedSyncService = null;
    this.syncReader = null;
    this.cloudEventSubscription = null;
    this.suppressedLocalPathsUntil.clear();
    this.applyingRemoteChanges = false;
    this.cloudReconcileInProgress = false;
    this.cloudReconcileQueued = false;
  }

  private async ensureCloudEventSubscription(): Promise<void> {
    if (this.cloudEventSubscription || !this.driveClient || !this.settings.vaultRootNodeUid) {
      return;
    }

    const rootNode = await this.driveClient.getNode(this.settings.vaultRootNodeUid);
    if (!rootNode.ok) {
      this.logger.warn('Cannot subscribe to cloud tree events: failed to load vault root node', {
        error: String(rootNode.error)
      });
      return;
    }

    const treeEventScopeId = rootNode.value.treeEventScopeId;
    this.cloudEventSubscription = await this.driveClient.subscribeToTreeEvents(treeEventScopeId, async event => {
      this.recordLatestEventId(event);
      this.logger.debug('Received Proton tree event', {
        type: (event as { type?: string }).type,
        eventId: (event as { eventId?: string }).eventId
      });
      await this.queueCloudReconciliation();
    });

    this.logger.info('Subscribed to Proton tree events', { treeEventScopeId });
  }

  private async queueCloudReconciliation(): Promise<void> {
    if (this.cloudReconcileInProgress) {
      this.cloudReconcileQueued = true;
      return;
    }

    this.cloudReconcileInProgress = true;

    try {
      do {
        this.cloudReconcileQueued = false;
        await this.runCloudReconciliationPass();
      } while (this.cloudReconcileQueued);
    } finally {
      this.cloudReconcileInProgress = false;
    }
  }

  private async runCloudReconciliationPass(): Promise<void> {
    if (!this.driveClient || !this.settings.vaultRootNodeUid || !this.syncReader || !this.isolatedSyncService) {
      return;
    }

    const before = this.captureLocalPaths();
    this.applyingRemoteChanges = true;

    try {
      const reconciliation = new ReconciliationService(
        this.app.vault,
        this.driveClient,
        this.settings.vaultRootNodeUid,
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

      this.isolatedSyncService.stop();
      this.isolatedSyncService.initializeIndex(reconciliationResult.snapshot);
      this.isolatedSyncService.start();

      const after = this.captureLocalPaths();
      this.markSuppressedLocalPaths(this.diffTouchedLocalPaths(before, after));

      this.logger.info('Applied cloud reconciliation pass', {
        ...reconciliationResult.stats,
        suppressedPaths: this.suppressedLocalPathsUntil.size
      });
    } catch (error) {
      this.logger.error('Cloud reconciliation pass failed', {}, error);
    } finally {
      this.applyingRemoteChanges = false;
    }
  }

  private captureLocalPaths(): Set<string> {
    const paths = new Set<string>();

    for (const entry of this.app.vault.getAllLoadedFiles()) {
      const normalized = normalizePath(entry.path ?? '');
      if (!normalized) {
        continue;
      }

      paths.add(this.toCanonicalPath(normalized));
    }

    return paths;
  }

  private diffTouchedLocalPaths(before: Set<string>, after: Set<string>): string[] {
    const touched = new Set<string>();

    for (const path of before) {
      if (!after.has(path)) {
        touched.add(path);
      }
    }

    for (const path of after) {
      if (!before.has(path)) {
        touched.add(path);
      }
    }

    return Array.from(touched);
  }

  private markSuppressedLocalPaths(paths: string[]): void {
    if (paths.length === 0) {
      return;
    }

    const until = Date.now() + this.localSuppressionTtlMs;
    for (const path of paths) {
      this.suppressedLocalPathsUntil.set(path, until);
    }
  }

  private shouldSuppressLocalChange(path: string, oldPath?: string): boolean {
    if (this.applyingRemoteChanges) {
      return true;
    }

    this.pruneExpiredSuppressions();
    const canonicalPath = this.toCanonicalPath(path);
    if (this.suppressedLocalPathsUntil.has(canonicalPath)) {
      return true;
    }

    if (oldPath) {
      const canonicalOldPath = this.toCanonicalPath(oldPath);
      if (this.suppressedLocalPathsUntil.has(canonicalOldPath)) {
        return true;
      }
    }

    return false;
  }

  private pruneExpiredSuppressions(): void {
    const now = Date.now();
    for (const [path, until] of this.suppressedLocalPathsUntil.entries()) {
      if (until <= now) {
        this.suppressedLocalPathsUntil.delete(path);
      }
    }
  }

  private toCanonicalPath(path: string): string {
    return toCanonicalPathKey(path, true);
  }

  private buildLatestEventIdProvider(): LatestEventIdProvider {
    return {
      getLatestEventId: (treeEventScopeId: string): string | null => {
        const id = this.settings.latestEventIds[treeEventScopeId];
        if (!id || !id.trim()) {
          return null;
        }

        return id;
      }
    };
  }

  private recordLatestEventId(event: DriveEvent): void {
    const eventId = event.eventId;
    if (!eventId || eventId === 'none') {
      return;
    }

    const scope = event.treeEventScopeId;
    if (!scope) {
      return;
    }

    if (this.settings.latestEventIds[scope] === eventId) {
      return;
    }

    this.settings.latestEventIds[scope] = eventId;
    void this.saveSettings();
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
