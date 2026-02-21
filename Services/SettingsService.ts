import type { DriveEvent } from '@protontech/drive-sdk';
import { BehaviorSubject, type Observable } from 'rxjs';

import type { ReconciliationTombstone } from '../isolated-sync/ReconciliationService';
import type { SyncIndexSnapshot } from '../isolated-sync/RxSyncService';
import { type ProtonDriveSyncSettings } from '../model/settings';
import type { ProtonSessionState } from '../proton/auth/ProtonSessionService';

export class SettingsService {
  private settings: ProtonDriveSyncSettings;
  private readonly settingsSubject: BehaviorSubject<ProtonDriveSyncSettings>;
  private readonly saveSettings: (settings: ProtonDriveSyncSettings) => Promise<void>;

  public readonly settings$: Observable<ProtonDriveSyncSettings>;

  constructor(
    initialSettings: ProtonDriveSyncSettings,
    saveSettings: (settings: ProtonDriveSyncSettings) => Promise<void>
  ) {
    this.settings = initialSettings;
    this.saveSettings = saveSettings;
    this.settingsSubject = new BehaviorSubject<ProtonDriveSyncSettings>(this.settings);
    this.settings$ = this.settingsSubject.asObservable();
  }

  snapshot(): ProtonDriveSyncSettings {
    return this.settings;
  }

  getVaultRootNodeUid(): string | null {
    return this.settings.vaultRootNodeUid;
  }

  getLatestEventId(treeEventScopeId: string): string | null {
    const id = this.settings.latestEventIds[treeEventScopeId];
    if (!id || !id.trim()) {
      return null;
    }

    return id;
  }

  getReconciliationSeed(): {
    previousSnapshot: SyncIndexSnapshot;
    tombstones: ReconciliationTombstone[];
  } {
    return {
      previousSnapshot: this.buildInitialSyncSnapshot(),
      tombstones: this.settings.reconciliationTombstones.map(
        (item: ProtonDriveSyncSettings['reconciliationTombstones'][number]) => ({
          ...item,
          deletedAt: Date.parse(item.deletedAt)
        })
      )
    };
  }

  async applySyncSnapshot(snapshot: SyncIndexSnapshot): Promise<void> {
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
    await this.persist();
  }

  async applyReconciliationResult(snapshot: SyncIndexSnapshot, tombstones: ReconciliationTombstone[]): Promise<void> {
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
    this.settings.reconciliationTombstones = tombstones.map((item: ReconciliationTombstone) => ({
      ...item,
      deletedAt: new Date(item.deletedAt).toISOString()
    }));

    await this.persist();
  }

  async setAccountEmail(email: string): Promise<void> {
    this.settings.accountEmail = email.trim();
    await this.persist();
  }

  async setSyncRoots(containerNodeUid: string, vaultRootNodeUid: string): Promise<void> {
    this.settings.containerNodeUid = containerNodeUid;
    this.settings.vaultRootNodeUid = vaultRootNodeUid;
    await this.persist();
  }

  async setLogging(options: {
    enableFileLogging?: boolean;
    logLevel?: ProtonDriveSyncSettings['logLevel'];
    logMaxSizeKb?: number;
  }): Promise<void> {
    if (typeof options.enableFileLogging === 'boolean') {
      this.settings.enableFileLogging = options.enableFileLogging;
    }

    if (options.logLevel) {
      this.settings.logLevel = options.logLevel;
    }

    if (typeof options.logMaxSizeKb === 'number' && Number.isFinite(options.logMaxSizeKb) && options.logMaxSizeKb > 0) {
      this.settings.logMaxSizeKb = options.logMaxSizeKb;
    }

    await this.persist();
  }

  async applyAuthResult(sessionState: ProtonSessionState): Promise<void> {
    if (sessionState.state === 'ok') {
      this.settings.connectionStatus = 'connected';
      this.settings.lastLoginError = null;
      this.settings.lastLoginAt = sessionState.session.updatedAt.getTime();
      this.settings.lastRefreshAt = sessionState.session.lastRefreshAt.getTime();
      this.settings.sessionExpiresAt = sessionState.session.expiresAt.getTime();
    } else {
      this.settings.connectionStatus = 'disconnected';
      this.settings.sessionExpiresAt = null;
    }

    await this.persist();
  }

  async resetForDisconnect(): Promise<void> {
    this.settings = {
      ...this.settings,
      connectionStatus: 'disconnected',
      sessionExpiresAt: null,
      pathMap: {},
      folderMap: {},
      latestEventIds: {},
      reconciliationTombstones: [],
      vaultRootNodeUid: null,
      containerNodeUid: null,
      lastLoginAt: null,
      lastLoginError: null,
      lastRefreshAt: null
    };

    await this.persist();
  }

  async recordLatestEventId(event: DriveEvent): Promise<void> {
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
    await this.persist();
  }

  buildInitialSyncSnapshot(): SyncIndexSnapshot {
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

  private async persist(): Promise<void> {
    await this.saveSettings(this.settings);
    this.settingsSubject.next(this.settings);
  }
}
