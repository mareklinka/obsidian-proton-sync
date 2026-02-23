import { Platform, requestUrl, RequestUrlResponse } from 'obsidian';

import {
  buildSrpProofs,
  computeKeyPasswordFromSalt,
  decodeBase64,
  encodeBase64,
  ProtonAuthInfo,
  ProtonSrpProofs
} from '../ProtonSrp';
import { BehaviorSubject, distinctUntilChanged, Subject } from 'rxjs';
import { ProtonSession } from '../ProtonSession';
import { deleteJson, getJson, postJson } from '../../ProtonApiClient';
import { PROTON_BASE_URL } from '../../Constants';
import { CaptchaVerification } from '../../../ui/modals/captcha-modal';
import { getObsidianSecretStore } from '../../../services/vNext/ObsidianSecretStore';
import { Effect, Option } from 'effect';
import { UnknownException } from 'effect/Cause';

const AUTH_SCOPE = 'full locked';
const SESSION_STORAGE_KEY = 'proton-drive-sync-session';
const SALTED_PASSPHRASES_SECRET_KEY = 'proton-drive-sync-salted-passphrases';

// this is only used on Mobile where the CSP policy for frame-ancestors prevents us from properly displaying the captcha challenge
const CAPTCHA_FALLBACK_APPVERSION = 'Other';

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
  | { state: 'error'; message: string }
  | { state: 'disconnected' }
  | { state: 'logged-out' };

export type ProtonAuthStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ProtonSignInDelegates = {
  requestTwoFactorCode: () => Effect.Effect<Option.Option<string>, never>;
  requestMailboxPassword: () => Effect.Effect<Option.Option<string>, never>;
  requestCaptchaChallenge: (captchaUrl: string) => Effect.Effect<Option.Option<CaptchaVerification>, never>;
};

interface ProtonApiError<T> {
  Code: number;
  Error: string;
  Details: T;
}

interface ProtonCaptchaApiError {
  HumanVerificationToken: string;
  HumanVerificationMethods: string[];
  Direct: number;
  Description: string;
  Title: string;
  WebUrl: string;
  ExpiresAt: number;
}

export const { init: initProtonSessionService, get: getProtonSessionService } = (function () {
  let instance: ProtonSessionService | null = null;

  return {
    init: function initProtonSessionService(appVersionHeader: string): ProtonSessionService {
      return (instance ??= new ProtonSessionService(appVersionHeader));
    },
    get: function getProtonSessionService(): ProtonSessionService {
      if (!instance) {
        throw new Error('ProtonSessionService has not been initialized. Please call initProtonSessionService first.');
      }
      return instance;
    }
  };
})();

class ProtonSessionService {
  private readonly authStatusSubject = new BehaviorSubject<ProtonAuthStatus>('disconnected');
  public readonly authState$ = this.authStatusSubject.pipe(distinctUntilChanged());

  private refreshIntervalId: ReturnType<typeof globalThis.setInterval> | null = null;

  private session: ProtonSessionState = { state: 'disconnected' };
  private saltedKeyPasswords: Record<string, string> = {};

  private readonly sessionChangeSubject = new Subject<void>();
  public readonly sessionChange$ = this.sessionChangeSubject.asObservable();

  private secretStore: ReturnType<typeof getObsidianSecretStore>;

  constructor(public readonly appVersionHeader: string) {
    this.secretStore = getObsidianSecretStore();

    const saltedPasswordsJson = this.secretStore.get(SALTED_PASSPHRASES_SECRET_KEY);
    this.saltedKeyPasswords = JSON.parse(saltedPasswordsJson ? saltedPasswordsJson : '{}') as Record<string, string>;
  }

  signIn(email: string, password: string, delegates: ProtonSignInDelegates): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      this.authStatusSubject.next('connecting');

      let authResponse: ProtonAuthResponse | null = null;

      try {
        const authInfo = yield* this.fetchAuthInfo(email);
        const proofs = yield* Effect.tryPromise(async () => buildSrpProofs(authInfo, email, password));

        authResponse = yield* this.authenticateWithCaptcha(authInfo, email, proofs, delegates);

        if (!this.verifyServerProof(authResponse.ServerProof, proofs.expectedServerProof)) {
          return yield* Effect.fail(new Error('SRP server proof mismatch.'));
        }

        if (this.requiresTwoFactorCode(authResponse)) {
          const twoFactorCode = yield* this.resolveTwoFactorCode(delegates.requestTwoFactorCode);
          yield* this.submitTwoFactor(twoFactorCode, { accessToken: authResponse.AccessToken, uid: authResponse.UID });
        }

        let keyPassword = password;

        if (this.requiresMailboxPassword(authResponse)) {
          keyPassword = yield* this.resolveMailboxPassword(delegates.requestMailboxPassword);
        }

        const now = new Date();

        const keyPasswords = yield* this.getKeyPasswords(keyPassword, {
          uid: authResponse.UID,
          accessToken: authResponse.AccessToken
        });

        this.saltedKeyPasswords = keyPasswords;
        this.secretStore.set(SALTED_PASSPHRASES_SECRET_KEY, JSON.stringify(keyPasswords));

        this.session = {
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
        };

        this.sessionChangeSubject.next();
        this.authStatusSubject.next('connected');

        this.startAutoRefresh();
      } catch (error) {
        if (authResponse) {
          // destroy the session if it was successfully created
          yield* this.destroySession({
            uid: authResponse.UID,
            accessToken: authResponse.AccessToken
          });
        }
        this.authStatusSubject.next('error');
        return yield* Effect.fail(error);
      }
    });
  }

  public getCurrentSession(): Option.Option<ProtonSession> {
    if (this.session.state === 'ok') {
      return Option.some(this.session.session);
    }

    return Option.none();
  }

  public getSaltedKeyPasswords(): Record<string, string> {
    return this.saltedKeyPasswords;
  }

  private authenticateWithCaptcha(
    authInfo: ProtonAuthInfo,
    email: string,
    proofs: ProtonSrpProofs,
    delegates: ProtonSignInDelegates
  ): Effect.Effect<ProtonAuthResponse, Error> {
    return Effect.gen(this, function* () {
      let appVersionHeader = this.appVersionHeader;
      let authResponse: Option.Option<ProtonAuthResponse> = Option.none();
      let captchaData: Option.Option<CaptchaVerification> = Option.none();

      while (Option.isNone(authResponse)) {
        const authResponseRaw = yield* this.authenticate(authInfo, email, appVersionHeader, proofs, captchaData);

        if (this.requiresCaptcha(authResponseRaw)) {
          if (Platform.isMobile) {
            // on mobile, we can't display the captcha challenge properly, we try to bypass it by setting a fallback app version
            appVersionHeader = CAPTCHA_FALLBACK_APPVERSION;
            continue;
          } else {
            // on desktop, the captcha challenge can be handled normally
            // we elicit the captcha token from the user in a modal
            const captchaUrl = this.extractCaptchaUrl(authResponseRaw.json);
            if (Option.isNone(captchaUrl)) {
              return yield* Effect.fail(
                new Error('CAPTCHA verification is required, but no challenge URL was provided.')
              );
            }

            captchaData = yield* delegates.requestCaptchaChallenge(captchaUrl.value);

            if (Option.isNone(captchaData)) {
              return yield* Effect.fail(new Error('CAPTCHA verification required to continue sign-in.'));
            }

            continue;
          }
        }

        if (authResponseRaw.status >= 400) {
          const message = extractApiError(authResponseRaw.json) ?? `Auth request failed (${authResponseRaw.status}).`;
          return yield* Effect.fail(new Error(message));
        }

        authResponse = Option.some(authResponseRaw.json as ProtonAuthResponse);
      }

      return authResponse.value;
    });
  }

  signOut(): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const session = this.session;
      if (!session || session.state !== 'ok') {
        return;
      }

      this.stopAutoRefresh();
      this.secretStore.set(SESSION_STORAGE_KEY, JSON.stringify(undefined));
      this.saltedKeyPasswords = {};

      this.session = { state: 'logged-out' };
      this.sessionChangeSubject.next();
      this.authStatusSubject.next('disconnected');

      yield* this.destroySession(session.session);
    });
  }

  dispose(): void {
    const session = this.session;
    if (!session || session.state !== 'ok') {
      return;
    }

    this.stopAutoRefresh();

    this.session = { state: 'disconnected' };
    this.sessionChangeSubject.next();
    this.authStatusSubject.next('disconnected');
  }

  public loadSession(): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const stored = this.secretStore.get(SESSION_STORAGE_KEY);
      if (!stored) {
        return;
      }

      yield* this.refreshSession(JSON.parse(stored) as ProtonSession);
    });
  }

  private destroySession(session: { uid: string; accessToken: string }): Effect.Effect<void, Error> {
    return Effect.tryPromise(async () => {
      await deleteJson<ProtonKeySaltsResponse>('/auth/v4', session, this.appVersionHeader);
    });
  }

  private refreshSession(session: ProtonSession): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
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

      const response = yield* this.request<ProtonAuthResponse>('/auth/v4/refresh', body, {
        'x-pm-uid': session.uid,
        authorization: `Bearer ${session.accessToken}`
      });

      const refreshedAt = new Date();

      this.session = {
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
      };
      this.secretStore.set(SESSION_STORAGE_KEY, JSON.stringify(this.session.session));
      this.sessionChangeSubject.next();
      this.authStatusSubject.next('connected');
    });
  }

  private fetchAuthInfo(username: string): Effect.Effect<ProtonAuthInfo, Error> {
    return Effect.gen(this, function* () {
      const response = yield* this.request<{ AuthInfo?: ProtonAuthInfo } | ProtonAuthInfo>('/auth/v4/info', {
        Username: username
      });

      if ('AuthInfo' in response && response.AuthInfo) {
        return response.AuthInfo;
      }

      return response as ProtonAuthInfo;
    });
  }

  private authenticate(
    authInfo: ProtonAuthInfo,
    username: string,
    appVersionHeader: string,
    proofs: { clientProof: Uint8Array; clientEphemeral: Uint8Array },
    captchaData: Option.Option<CaptchaVerification>
  ): Effect.Effect<RequestUrlResponse, Error> {
    return this.requestRaw(
      '/auth/v4',
      {
        Username: username,
        ClientProof: encodeBase64(proofs.clientProof),
        ClientEphemeral: encodeBase64(proofs.clientEphemeral),
        SRPSession: authInfo.SRPSession,
        Scope: AUTH_SCOPE
      },
      appVersionHeader,
      Option.isSome(captchaData)
        ? {
            'x-pm-human-verification-token': captchaData.value.token,
            'x-pm-human-verification-token-type': captchaData.value.verificationMethod
          }
        : undefined
    );
  }

  private submitTwoFactor(
    twoFactorCode: string,
    session: { uid: string; accessToken: string }
  ): Effect.Effect<void, UnknownException> {
    return Effect.tryPromise(async () => {
      await postJson('/auth/v4/2fa', session, this.appVersionHeader, {
        TwoFactorCode: twoFactorCode
      });
    });
  }

  private requiresCaptcha(response: RequestUrlResponse): boolean {
    if (response.status !== 422 || !response.json || !('Code' in response.json) || response.json?.Code !== 9001) {
      return false;
    }

    return true;
  }

  private extractCaptchaUrl(payload: unknown): Option.Option<string> {
    if (!payload || typeof payload !== 'object') {
      return Option.none();
    }

    const captchaError = payload as ProtonApiError<ProtonCaptchaApiError>;
    const url = captchaError.Details?.WebUrl;

    if (typeof url !== 'string' || !url.trim()) {
      return Option.none();
    }

    return Option.some(url);
  }

  private requiresTwoFactorCode(authResponse: ProtonAuthResponse): boolean {
    return Boolean(authResponse['2FA']?.Enabled && (authResponse['2FA'].Enabled & 1) !== 0);
  }

  private requiresMailboxPassword(authResponse: ProtonAuthResponse): boolean {
    return authResponse.PasswordMode === 2;
  }

  private resolveTwoFactorCode(
    requestTwoFactorCode: ProtonSignInDelegates['requestTwoFactorCode']
  ): Effect.Effect<string, Error> {
    return Effect.gen(this, function* () {
      const code = yield* requestTwoFactorCode();

      if (Option.isNone(code) || !code.value.trim()) {
        return yield* Effect.fail(new Error('Two-factor authentication code required.'));
      } else {
        return code.value;
      }
    });
  }

  private resolveMailboxPassword(
    requestMailboxPassword: ProtonSignInDelegates['requestMailboxPassword']
  ): Effect.Effect<string, Error> {
    return Effect.gen(this, function* () {
      const mailboxPassword = yield* requestMailboxPassword();
      if (Option.isNone(mailboxPassword) || !mailboxPassword.value.trim()) {
        return yield* Effect.fail(new Error('Mailbox password required.'));
      }

      return mailboxPassword.value;
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

  private request<T>(path: string, body: unknown, headers?: Record<string, string>): Effect.Effect<T, Error> {
    return Effect.gen(this, function* () {
      const response = yield* this.requestRaw(path, body, this.appVersionHeader, headers);

      if (response.status >= 400) {
        const message = extractApiError(response.json) ?? `Auth request failed (${response.status}).`;
        yield* Effect.fail(new Error(message));
      }

      return response.json as T;
    });
  }

  private requestRaw(
    path: string,
    body: unknown,
    appVersionHeader: string,
    headers?: Record<string, string>
  ): Effect.Effect<RequestUrlResponse> {
    return Effect.promise(() => {
      return requestUrl({
        url: `${PROTON_BASE_URL}${path}`,
        method: 'POST',
        contentType: 'application/json',
        headers: {
          'x-pm-appversion': appVersionHeader,
          ...(headers ?? {})
        },
        body: JSON.stringify(body),
        throw: false
      });
    });
  }

  private getKeyPasswords(
    password: string,
    session: { uid: string; accessToken: string }
  ): Effect.Effect<Record<string, string>> {
    return Effect.promise(async () => {
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
    });
  }

  private startAutoRefresh(): void {
    if (this.refreshIntervalId !== null) {
      return;
    }

    this.refreshIntervalId = globalThis.setInterval(async () => {
      await Effect.runPromise(this.refreshSessionIfNeeded());
    }, SESSION_REFRESH_INTERVAL_MS);
  }

  private stopAutoRefresh(): void {
    if (this.refreshIntervalId === null) {
      return;
    }

    globalThis.clearInterval(this.refreshIntervalId);
    this.refreshIntervalId = null;
  }

  private refreshSessionIfNeeded(): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const session = this.session;
      if (!session || session.state !== 'ok') {
        return;
      }

      const expiresAt = new Date(session.session.expiresAt).getTime();
      const timeToExpiry = expiresAt - new Date().getTime();

      if (timeToExpiry > SESSION_REFRESH_INTERVAL_MS) {
        return;
      }

      yield* this.refreshSession(session.session);
    });
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
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
