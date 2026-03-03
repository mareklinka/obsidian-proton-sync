import type { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';
import type { LogLevel } from '../services/ObsidianSyncLogger';

export interface ProtonDriveSyncSettings {
  accountEmail: string;
  connectionStatus: ProtonAuthStatus;
  lastLoginAt: number | null;
  lastRefreshAt: number | null;
  sessionExpiresAt: number | null;
  lastLoginError: string | null;
  containerNodeUid: string | null;
  vaultRootNodeUid: string | null;
  latestEventIds: Record<string, string>;
  logLevel: LogLevel;
  ignoredPaths: string[];
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
  latestEventIds: {},
  logLevel: 'info',
  ignoredPaths: []
};
