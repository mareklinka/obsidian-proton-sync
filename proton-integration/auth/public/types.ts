import type { ProtonSession } from '../../../session-store';
export type { ProtonSecretStore as SecretStore, ProtonSessionStore as SessionStore } from '../../domain/contracts';

export interface ProtonConnectInput {
  email: string;
  password: string;
  mailboxPassword?: string;
  twoFactorCode?: string;
}

export interface ProtonAuthContext {
  appVersion: string;
  session: ProtonSession;
  getSession: () => ProtonSession | null;
  saltedPassphrases: Record<string, string>;
}

export type ProtonAuthFailureReason =
  | 'invalid-credentials'
  | 'two-factor-required'
  | 'mailbox-password-required'
  | 'no-session'
  | 'session-expired'
  | 'passphrase-missing'
  | 'network-error'
  | 'unknown';

export type ProtonAuthResult =
  | {
      ok: true;
      source: 'connect' | 'reconnect';
      context: ProtonAuthContext;
    }
  | {
      ok: false;
      source: 'connect' | 'reconnect';
      reason: ProtonAuthFailureReason;
      message: string;
    };

export interface ProtonRefreshCallbacks {
  onRefreshSuccess?: (context: ProtonAuthContext) => void | Promise<void>;
  onRefreshError?: (result: Extract<ProtonAuthResult, { ok: false }>) => void;
}

export interface ProtonAuthFacade {
  connect(input: ProtonConnectInput): Promise<ProtonAuthResult>;
  reconnect(): Promise<ProtonAuthResult>;
  disconnect(): Promise<void>;

  startAutoRefresh(callbacks?: ProtonRefreshCallbacks): void;
  stopAutoRefresh(): void;
  dispose(): void;

  getCurrentSession(): ProtonSession | null;
}
