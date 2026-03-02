import type { LogLevel } from '../logger';
import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';

export interface ProtonDriveSyncSettings {
  accountEmail: string;
  connectionStatus: ProtonAuthStatus;
  lastLoginAt: number | null;
  lastRefreshAt: number | null;
  sessionExpiresAt: number | null;
  lastLoginError: string | null;
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
  updatedAt: number;
}

export interface ReconciliationTombstone {
  entityType: 'file' | 'folder';
  path: string;
  cloudId?: string;
  deletedAt: number;
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
