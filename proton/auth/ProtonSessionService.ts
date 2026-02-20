import { requestUrl } from 'obsidian';

import { buildSrpProofs, computeKeyPasswordFromSalt, decodeBase64, encodeBase64, ProtonAuthInfo } from './ProtonSrp';
import { BehaviorSubject, map, merge, of, shareReplay, Subject, switchMap, timer } from 'rxjs';
import { ProtonSession } from './ProtonSession';
import { getJson } from '../ProtonApiClient';
import type { ProtonSecretStore } from './ProtonSecretStore';
import { SESSION_REFRESH_INTERVAL_MS, PROTON_BASE_URL, SALTED_PASSPHRASES_SECRET_KEY } from '../Constants';

const DEFAULT_SESSION_TTL_MS = 50 * 60 * 1000;
const AUTH_SCOPE = 'full locked';

export interface ProtonAuthResponse {
  UserID: string;
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  ServerProof: string;
  Scope: string;
  TwoFA?: {
    Enabled: number;
  };
  PasswordMode?: number;
}

export type ProtonSessionState =
  | {
      state: 'ok';
      session: ProtonSession;
    }
  | { state: 'stale'; session: ProtonSession }
  | { state: 'error'; message: string }
  | { state: 'disconnected' }
  | { state: 'logged-out' };

export type ProtonAuthStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export class ProtonSessionService {
  public readonly appVersionHeader: string;
  private readonly currentSessionSubject: Subject<ProtonSessionState> = new Subject();
  private readonly authStatusSubject = new BehaviorSubject<ProtonAuthStatus>('disconnected');

  private refreshIntervalId: number | null = null;
  private currentSession: ProtonSession | null = null;
  public readonly authState$ = this.authStatusSubject.asObservable();
  public readonly currentSession$ = this.currentSessionSubject.pipe(
    switchMap(sessionState => {
      if (!sessionState) {
        return of<ProtonSessionState>({ state: 'disconnected' });
      }

      if (sessionState.state !== 'ok') {
        return of(sessionState);
      }

      const msUntilExpiry = sessionState.session.expiresAt - new Date().getTime();

      return merge(
        of<ProtonSessionState>(sessionState),
        timer(msUntilExpiry).pipe(
          map(() => ({ state: 'stale', session: sessionState.session }) satisfies ProtonSessionState)
        )
      );
    }),

    shareReplay({ bufferSize: 1, refCount: true })
  );

  constructor(
    private readonly secretStore: ProtonSecretStore,
    appVersion: string
  ) {
    this.appVersionHeader = `external-drive-obsidiansync@${appVersion}`;
    this.currentSession$.subscribe(session => {
      switch (session.state) {
        case 'ok':
          this.currentSession = session.session;
          this.authStatusSubject.next('connected');
          break;
        case 'stale':
          this.authStatusSubject.next('connected');
          break;
        case 'error':
          this.authStatusSubject.next('error');
          break;
        default:
          this.authStatusSubject.next('disconnected');
          break;
      }
    });
  }

  async signIn(email: string, password: string, twoFactorCode: string | undefined): Promise<void> {
    this.authStatusSubject.next('connecting');

    try {
      const authInfo = await this.fetchAuthInfo(email);
      const proofs = await buildSrpProofs(authInfo, email, password);

      const authResponse = await this.authenticate(authInfo, email, proofs);

      if (!this.verifyServerProof(authResponse.ServerProof, proofs.expectedServerProof)) {
        throw new Error('SRP server proof mismatch.');
      }

      if (authResponse.TwoFA?.Enabled && (authResponse.TwoFA.Enabled & 1) !== 0) {
        if (!twoFactorCode) {
          throw new Error('Two-factor authentication code required.');
        }

        await this.submitTwoFactor(twoFactorCode);
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + DEFAULT_SESSION_TTL_MS);

      const keyPasswords = await this.getKeyPasswords(password, {
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken
      });

      this.secretStore.set(SALTED_PASSPHRASES_SECRET_KEY, JSON.stringify(keyPasswords));

      this.currentSessionSubject.next({
        state: 'ok',
        session: {
          uid: authResponse.UID,
          userId: authResponse.UserID || null,
          accessToken: authResponse.AccessToken,
          refreshToken: authResponse.RefreshToken,
          scope: authResponse.Scope || null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: expiresAt.getTime(),
          lastRefreshAt: now.getTime()
        }
      });

      this.startAutoRefresh();
    } catch (error) {
      this.authStatusSubject.next('error');
      throw error;
    }
  }

  signOut(): void {
    const session = this.currentSession;
    if (!session) {
      return;
    }

    this.stopAutoRefresh();
    this.secretStore.clear(SALTED_PASSPHRASES_SECRET_KEY);

    this.currentSessionSubject.next({ state: 'logged-out' });
    this.authStatusSubject.next('disconnected');
  }

  dispose(): void {
    const session = this.currentSession;
    if (!session) {
      return;
    }

    this.stopAutoRefresh();

    this.currentSessionSubject.next({ state: 'disconnected' });
    this.authStatusSubject.next('disconnected');
  }

  async refreshSession(session: ProtonSession): Promise<void> {
    const state = encodeBase64(randomToken(32));
    const body = {
      UID: session.uid,
      RefreshToken: session.refreshToken,
      ResponseType: 'token',
      GrantType: 'refresh_token',
      RedirectURI: 'https://protonmail.ch',
      State: state,
      AccessToken: session.accessToken,
      Scope: session.scope
    };

    const response = await this.request<ProtonAuthResponse>('/auth/v4/refresh', body, {
      'x-pm-uid': session.uid,
      authorization: `Bearer ${session.accessToken}`
    });

    const refreshedAt = new Date();
    const refreshedExpiresAt = new Date(refreshedAt.getTime() + DEFAULT_SESSION_TTL_MS);

    this.currentSessionSubject.next({
      state: 'ok',
      session: {
        ...session,
        uid: response.UID || session.uid,
        accessToken: response.AccessToken,
        refreshToken: response.RefreshToken,
        scope: response.Scope || session.scope,
        updatedAt: refreshedAt.toISOString(),
        expiresAt: refreshedExpiresAt.getTime(),
        lastRefreshAt: refreshedAt.getTime()
      }
    });
  }

  private async fetchAuthInfo(username: string): Promise<ProtonAuthInfo> {
    const response = await this.request<{ AuthInfo?: ProtonAuthInfo } | ProtonAuthInfo>('/auth/v4/info', {
      Username: username
    });

    if ('AuthInfo' in response && response.AuthInfo) {
      return response.AuthInfo;
    }

    return response as ProtonAuthInfo;
  }

  private async authenticate(
    authInfo: ProtonAuthInfo,
    username: string,
    proofs: { clientProof: Uint8Array; clientEphemeral: Uint8Array }
  ): Promise<ProtonAuthResponse> {
    return this.request<ProtonAuthResponse>('/auth/v4', {
      Username: username,
      ClientProof: encodeBase64(proofs.clientProof),
      ClientEphemeral: encodeBase64(proofs.clientEphemeral),
      SRPSession: authInfo.SRPSession,
      Scope: AUTH_SCOPE
    });
  }

  private async submitTwoFactor(twoFactorCode: string): Promise<void> {
    await this.request<void>('/auth/v4/2fa', {
      TwoFactorCode: twoFactorCode
    });
  }

  private verifyServerProof(serverProof: string, expected: Uint8Array): boolean {
    const decoded = decodeBase64(serverProof);
    if (decoded.length !== expected.length) {
      return false;
    }

    for (let index = 0; index < decoded.length; index += 1) {
      if (decoded[index] !== expected[index]) {
        return false;
      }
    }

    return true;
  }

  private async request<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await requestUrl({
      url: `${PROTON_BASE_URL}${path}`,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'x-pm-appversion': this.appVersionHeader,
        ...(headers ?? {})
      },
      body: JSON.stringify(body),
      throw: false
    });

    if (response.status >= 400) {
      const message = extractApiError(response.json) ?? `Auth request failed (${response.status}).`;
      throw new Error(message);
    }

    return response.json as T;
  }

  private async getKeyPasswords(
    password: string,
    session: { uid: string; accessToken: string }
  ): Promise<Record<string, string>> {
    const response = await getJson<ProtonKeySaltsResponse>('/core/v4/keys/salts', session, this.appVersionHeader);

    const entries = response.KeySalts ?? [];
    const map: Record<string, string> = {};

    for (const entry of entries) {
      if (!entry.ID || !entry.KeySalt) {
        continue;
      }

      map[entry.ID] = computeKeyPasswordFromSalt(password, entry.KeySalt);
    }

    return map;
  }

  private startAutoRefresh(): void {
    if (this.refreshIntervalId !== null) {
      return;
    }

    this.refreshIntervalId = window.setInterval(() => {
      this.refreshSessionIfNeeded();
    }, SESSION_REFRESH_INTERVAL_MS);
  }

  private stopAutoRefresh(): void {
    if (this.refreshIntervalId === null) {
      return;
    }

    window.clearInterval(this.refreshIntervalId);
    this.refreshIntervalId = null;
  }

  private async refreshSessionIfNeeded() {
    const currentSession = this.currentSession;
    if (!currentSession) {
      return;
    }

    const expiresAt = new Date(currentSession.expiresAt).getTime();
    const timeToExpiry = expiresAt - new Date().getTime();

    if (timeToExpiry > SESSION_REFRESH_INTERVAL_MS) {
      return;
    }

    await this.refreshSession(currentSession);
  }
}

type ProtonKeySaltEntry = {
  ID?: string;
  KeySalt?: string;
};

type ProtonKeySaltsResponse = {
  KeySalts?: ProtonKeySaltEntry[];
};

function extractApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as { Error?: string; Message?: string };
  return record.Error ?? record.Message ?? null;
}

function randomToken(byteLength: number): Uint8Array {
  return randomBytes(byteLength);
}

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
