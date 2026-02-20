import type { LogLevel } from '../logger';

export interface ProtonDriveSyncSettings {
  accountEmail: string;
  connectionStatus: 'disconnected' | 'pending' | 'connected' | 'error';
  lastLoginAt: string | null;
  lastLoginError: string | null;
  lastRefreshAt: string | null;
  sessionExpiresAt: string | null;
  containerNodeUid: string | null;
  vaultRootNodeUid: string | null;
  pathMap: Record<string, SyncMapEntry>;
  folderMap: Record<string, SyncMapEntry>;
  latestEventIds: Record<string, string>;
  reconciliationTombstones: ReconciliationTombstone[];
  enableFileLogging: boolean;
  logLevel: LogLevel;
  logMaxSizeKb: number;
}

export interface SyncMapEntry {
  nodeUid: string;
  updatedAt: string;
}

export interface ReconciliationTombstone {
  entityType: 'file' | 'folder';
  path: string;
  cloudId?: string;
  deletedAt: string;
  origin: 'local' | 'remote';
}

export const DEFAULT_SETTINGS: ProtonDriveSyncSettings = {
  accountEmail: '',
  connectionStatus: 'disconnected',
  lastLoginAt: null,
  lastLoginError: null,
  lastRefreshAt: null,
  sessionExpiresAt: null,
  containerNodeUid: null,
  vaultRootNodeUid: null,
  pathMap: {},
  folderMap: {},
  latestEventIds: {},
  reconciliationTombstones: [],
  enableFileLogging: false,
  logLevel: 'info',
  logMaxSizeKb: 1024
};
