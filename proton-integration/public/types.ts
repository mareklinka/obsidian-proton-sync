import type { ProtonApiClient } from '../../proton-api';
import type { ProtonSession } from '../../session-store';

export interface ProtonCredentials {
  email: string;
  password: string;
  mailboxPassword?: string;
  twoFactorCode?: string;
}

export interface ProtonBootstrapOptions {
  forceRefreshOnRestore?: boolean;
}

export interface ProtonIntegrationStatus {
  state: 'disconnected' | 'pending' | 'connected' | 'error';
  accountEmail?: string;
  expiresAt?: string;
  lastError?: string;
}

export interface ProtonIntegrationHandle {
  getStatus(): ProtonIntegrationStatus;
  getApiClient(): ProtonApiClient | null;
  getSession(): ProtonSession | null;

  signIn(credentials: ProtonCredentials): Promise<void>;
  restoreFromStorage(options?: ProtonBootstrapOptions): Promise<boolean>;
  refreshIfNeeded(force?: boolean): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface SessionStore {
  load(): Promise<ProtonSession | null>;
  save(session: ProtonSession): Promise<void>;
  clear(): Promise<void>;
}

export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  clear(key: string): void;
}

export interface ProtonLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>, error?: unknown): void;
  error(message: string, meta?: Record<string, unknown>, error?: unknown): void;
}

export interface ProtonAuthGateway {
  signIn(credentials: ProtonCredentials): Promise<{
    session: ProtonSession;
    passwordMode: number | null;
  }>;
  refresh(session: ProtonSession): Promise<ProtonSession>;
}

export type ProtonApiClientFactory = (args: {
  getSession: () => ProtonSession | null;
  appVersion: string;
  logger: ProtonLogger;
}) => ProtonApiClient;

export interface ProtonIntegrationDeps {
  appVersion: string;
  logger: ProtonLogger;
  sessionStore: SessionStore;
  secretStore: SecretStore;
  authGateway: ProtonAuthGateway;
  apiClientFactory?: ProtonApiClientFactory;
  clock?: { now(): number };
}

export type CreateProtonIntegration = (deps: ProtonIntegrationDeps) => ProtonIntegrationHandle;
