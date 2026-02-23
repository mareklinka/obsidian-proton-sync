import { BehaviorSubject, type Observable } from 'rxjs';

import type { SyncIndexEntry, SyncIndexSnapshot } from './ObsidianSyncService';
import type { ProtonDriveSyncSettings } from '../model/settings';
import { normalizePath, toCanonicalPathKey } from './path-utils';
import { SettingsService } from './SettingsService';

export class SyncIndexStateService {
  private readonly snapshotSubject: BehaviorSubject<SyncIndexSnapshot>;

  public readonly snapshot$: Observable<SyncIndexSnapshot>;

  constructor(private readonly settingsService: SettingsService) {
    this.snapshotSubject = new BehaviorSubject<SyncIndexSnapshot>(
      this.buildSnapshotFromMaps(this.settingsService.snapshot().pathMap, this.settingsService.snapshot().folderMap)
    );
    this.snapshot$ = this.snapshotSubject.asObservable();
  }

  snapshot(): SyncIndexSnapshot {
    return this.snapshotSubject.value;
  }

  getByPath(path: string): SyncIndexEntry | null {
    const normalized = normalizePath(path);
    if (!normalized) {
      return null;
    }

    const canonical = toCanonicalPathKey(normalized);
    for (const entry of Object.values(this.snapshotSubject.value.byPath)) {
      if (toCanonicalPathKey(entry.path) === canonical) {
        return entry;
      }
    }

    return null;
  }

  getByCloudId(cloudId: string): SyncIndexEntry | null {
    return this.snapshotSubject.value.byCloudId[cloudId] ?? null;
  }

  async applySnapshot(snapshot: SyncIndexSnapshot): Promise<void> {
    const maps = this.toSettingsMaps(snapshot);
    await this.settingsService.setSyncMaps(maps.pathMap, maps.folderMap);
    this.snapshotSubject.next(snapshot);
  }

  async clear(): Promise<void> {
    const empty: SyncIndexSnapshot = {
      byPath: {},
      byCloudId: {}
    };

    await this.settingsService.setSyncMaps({}, {});
    this.snapshotSubject.next(empty);
  }

  private buildSnapshotFromMaps(
    pathMap: ProtonDriveSyncSettings['pathMap'],
    folderMap: ProtonDriveSyncSettings['folderMap']
  ): SyncIndexSnapshot {
    const byPath: SyncIndexSnapshot['byPath'] = {};
    const byCloudId: SyncIndexSnapshot['byCloudId'] = {};

    for (const [path, entry] of Object.entries(pathMap)) {
      const normalizedUpdatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();
      const indexEntry: SyncIndexEntry = {
        cloudId: entry.nodeUid,
        path,
        entityType: 'file',
        updatedAt: normalizedUpdatedAt
      };

      byPath[path] = indexEntry;
      byCloudId[entry.nodeUid] = indexEntry;
    }

    for (const [path, entry] of Object.entries(folderMap)) {
      const normalizedUpdatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();
      const indexEntry: SyncIndexEntry = {
        cloudId: entry.nodeUid,
        path,
        entityType: 'folder',
        updatedAt: normalizedUpdatedAt
      };

      byPath[path] = indexEntry;
      byCloudId[entry.nodeUid] = indexEntry;
    }

    return { byPath, byCloudId };
  }

  private toSettingsMaps(snapshot: SyncIndexSnapshot): {
    pathMap: ProtonDriveSyncSettings['pathMap'];
    folderMap: ProtonDriveSyncSettings['folderMap'];
  } {
    const pathMap: ProtonDriveSyncSettings['pathMap'] = {};
    const folderMap: ProtonDriveSyncSettings['folderMap'] = {};

    for (const entry of Object.values(snapshot.byPath)) {
      if (entry.entityType === 'folder') {
        folderMap[entry.path] = {
          nodeUid: entry.cloudId,
          updatedAt: entry.updatedAt
        };
      } else {
        pathMap[entry.path] = {
          nodeUid: entry.cloudId,
          updatedAt: entry.updatedAt
        };
      }
    }

    return { pathMap, folderMap };
  }
}
