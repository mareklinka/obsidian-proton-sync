import { requestUrl } from 'obsidian';

import { buildSrpProofs, computeKeyPasswordFromSalt, decodeBase64, encodeBase64, ProtonAuthInfo } from './ProtonSrp';
import { BehaviorSubject, map, merge, of, shareReplay, Subject, switchMap, timer } from 'rxjs';
import { ProtonSession } from './ProtonSession';
import { deleteJson, getJson, postJson } from '../ProtonApiClient';
import type { ProtonSecretStore } from './ProtonSecretStore';
import { PROTON_BASE_URL } from '../Constants';

const AUTH_SCOPE = 'full locked';
const SESSION_STORAGE_KEY = 'proton-drive-sync-session';
const SALTED_PASSPHRASES_SECRET_KEY = 'proton-drive-sync-salted-passphrases';

export const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ProtonAuthResponse {
  UserID: string;
  UID: string;
  ExpiresIn: number;
  AccessToken: string;
  RefreshToken: string;
  ServerProof: string;
  Scope: string;
  '2FA'?: {
    Enabled: number;
    TOTP: number;
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

export type ProtonSignInDelegates = {
  requestTwoFactorCode: () => Promise<string | undefined>;
  requestMailboxPassword: () => Promise<string | undefined>;
};

export class ProtonSessionService {
  private readonly currentSessionSubject: Subject<ProtonSessionState> = new Subject();
  private readonly authStatusSubject = new BehaviorSubject<ProtonAuthStatus>('disconnected');

  private readonly saltedKeyPasswordsSubject: BehaviorSubject<Record<string, string>> = new BehaviorSubject({});
  public readonly saltedKeyPasswords$ = this.saltedKeyPasswordsSubject.asObservable();

  private refreshIntervalId: ReturnType<typeof globalThis.setInterval> | null = null;
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

      const msUntilExpiry = sessionState.session.expiresAt.getTime() - new Date().getTime();

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
    public readonly appVersionHeader: string
  ) {
    const saltedPasswordsJson = this.secretStore.get(SALTED_PASSPHRASES_SECRET_KEY);
    this.saltedKeyPasswordsSubject.next(
      JSON.parse(saltedPasswordsJson ? saltedPasswordsJson : '{}') as Record<string, string>
    );

    this.currentSession$.subscribe(sessionState => {
      switch (sessionState.state) {
        case 'ok':
          this.currentSession = sessionState.session;
          this.secretStore.set(SESSION_STORAGE_KEY, JSON.stringify(this.currentSession));
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

    this.saltedKeyPasswords$.subscribe(_ => {
      this.secretStore.set(SALTED_PASSPHRASES_SECRET_KEY, JSON.stringify(_));
    });
  }

  async signIn(email: string, password: string, delegates: ProtonSignInDelegates): Promise<void> {
    this.authStatusSubject.next('connecting');

    let authResponse: ProtonAuthResponse | undefined = undefined;

    try {
      const authInfo = await this.fetchAuthInfo(email);
      const proofs = await buildSrpProofs(authInfo, email, password);

      authResponse = await this.authenticate(authInfo, email, proofs);

      if (!this.verifyServerProof(authResponse.ServerProof, proofs.expectedServerProof)) {
        throw new Error('SRP server proof mismatch.');
      }

      if (this.requiresTwoFactorCode(authResponse)) {
        const twoFactorCode = await this.resolveTwoFactorCode(delegates.requestTwoFactorCode);
        await this.submitTwoFactor(twoFactorCode, { accessToken: authResponse.AccessToken, uid: authResponse.UID });
      }

      let keyPassword = password;

      if (this.requiresMailboxPassword(authResponse)) {
        keyPassword = await this.resolveMailboxPassword(delegates.requestMailboxPassword);
      }

      const now = new Date();

      const keyPasswords = await this.getKeyPasswords(keyPassword, {
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken
      });

      this.saltedKeyPasswordsSubject.next(keyPasswords);

      this.currentSessionSubject.next({
        state: 'ok',
        session: {
          uid: authResponse.UID,
          userId: authResponse.UserID || null,
          accessToken: authResponse.AccessToken,
          refreshToken: authResponse.RefreshToken,
          scope: authResponse.Scope || null,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + authResponse.ExpiresIn * 1000),
          lastRefreshAt: now
        }
      });

      this.startAutoRefresh();
    } catch (error) {
      if (authResponse) {
        // destroy the session if it was successfully created
        await this.destroySession({
          uid: authResponse.UID,
          accessToken: authResponse.AccessToken
        });
      }
      this.authStatusSubject.next('error');
      throw error;
    }
  }

  async signOut(): Promise<void> {
    const session = this.currentSession;
    if (!session) {
      return;
    }

    await this.destroySession(session);

    this.stopAutoRefresh();
    this.secretStore.set(SESSION_STORAGE_KEY, JSON.stringify(undefined));
    this.saltedKeyPasswordsSubject.next({});

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

  async loadSession() {
    const stored = this.secretStore.get(SESSION_STORAGE_KEY);
    if (!stored) {
      return;
    }

    try {
      await this.refreshSession(JSON.parse(stored) as ProtonSession);
    } catch {
      // session restore failed - the user will need to re-authenticate
    }
  }

  private async destroySession(session: { uid: string; accessToken: string }): Promise<void> {
    await deleteJson<ProtonKeySaltsResponse>('/auth/v4', session, this.appVersionHeader);
  }

  private async refreshSession(session: ProtonSession): Promise<void> {
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

    this.currentSessionSubject.next({
      state: 'ok',
      session: {
        ...session,
        uid: response.UID || session.uid,
        accessToken: response.AccessToken,
        refreshToken: response.RefreshToken,
        scope: response.Scope || session.scope,
        updatedAt: refreshedAt,
        expiresAt: new Date(refreshedAt.getTime() + response.ExpiresIn * 1000),
        lastRefreshAt: refreshedAt
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

  private async submitTwoFactor(twoFactorCode: string, session: { uid: string; accessToken: string }): Promise<void> {
    await postJson('/auth/v4/2fa', session, this.appVersionHeader, {
      TwoFactorCode: twoFactorCode
    });
  }

  private requiresTwoFactorCode(authResponse: ProtonAuthResponse): boolean {
    return Boolean(authResponse['2FA']?.Enabled && (authResponse['2FA'].Enabled & 1) !== 0);
  }

  private requiresMailboxPassword(authResponse: ProtonAuthResponse): boolean {
    return authResponse.PasswordMode === 2;
  }

  private async resolveTwoFactorCode(
    requestTwoFactorCode: ProtonSignInDelegates['requestTwoFactorCode']
  ): Promise<string> {
    const code = (await requestTwoFactorCode())?.trim();
    if (!code) {
      throw new Error('Two-factor authentication code required.');
    }

    return code;
  }

  private async resolveMailboxPassword(
    requestMailboxPassword: ProtonSignInDelegates['requestMailboxPassword']
  ): Promise<string> {
    const mailboxPassword = await requestMailboxPassword();
    if (!mailboxPassword) {
      throw new Error('Mailbox password required.');
    }

    return mailboxPassword;
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

    this.refreshIntervalId = globalThis.setInterval(() => {
      this.refreshSessionIfNeeded();
    }, SESSION_REFRESH_INTERVAL_MS);
  }

  private stopAutoRefresh(): void {
    if (this.refreshIntervalId === null) {
      return;
    }

    globalThis.clearInterval(this.refreshIntervalId);
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
