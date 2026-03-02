import { Data, Effect, Option } from 'effect';
import { Platform, requestUrl, type RequestUrlResponse } from 'obsidian';
import { BehaviorSubject, distinctUntilChanged } from 'rxjs';

import { getObsidianSecretStore } from '../../services/ObsidianSecretStore';
import { PROTON_BASE_URL } from '../Constants';
import { deleteJson, getJson, postJson } from '../ProtonApiClient';
import { buildSrpProofs, computeKeyPasswordFromSalt, decodeBase64, encodeBase64 } from './ProtonSrp';

import type { ProtonSession } from './ProtonSession';
import type { ProtonAuthInfo, ProtonSrpProofs } from './ProtonSrp';
import type { CaptchaVerification } from '../../ui/modals/captcha-modal';
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

interface ProtonCaptchaApiErrorResponse {
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

  private secretStore: ReturnType<typeof getObsidianSecretStore>;

  constructor(public readonly appVersionHeader: string) {
    this.secretStore = getObsidianSecretStore();

    const saltedPasswordsJson = this.secretStore.get(SALTED_PASSPHRASES_SECRET_KEY);
    this.saltedKeyPasswords = JSON.parse(saltedPasswordsJson ? saltedPasswordsJson : '{}') as Record<string, string>;
  }

  public signIn(
    email: string,
    password: string,
    delegates: ProtonSignInDelegates
  ): Effect.Effect<void, ProtonSessionError> {
    let authResponse: ProtonAuthResponse | null = null;

    return Effect.gen(this, function* () {
      this.authStatusSubject.next('connecting');

      const authInfo = yield* this.fetchAuthInfo(email);
      const proofs = yield* this.buildSrpProofs(authInfo, email, password);
      authResponse = yield* this.authenticateWithCaptcha(authInfo, email, proofs, delegates);

      yield* this.verifyServerProof(authResponse.ServerProof, proofs.expectedServerProof);

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

      this.secretStore.set(SESSION_STORAGE_KEY, JSON.stringify(this.session.session));

      this.authStatusSubject.next('connected');

      this.startAutoRefresh();
    }).pipe(
      Effect.catchAll(e =>
        Effect.gen(this, function* () {
          if (authResponse) {
            // destroy the session if it was successfully created
            yield* this.destroySession({
              uid: authResponse.UID,
              accessToken: authResponse.AccessToken
            });
          }
          this.authStatusSubject.next('error');
          return yield* e;
        })
      )
    );
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
  ): Effect.Effect<
    ProtonAuthResponse,
    ProtonApiCommunicationError | CaptchaRequiredError | CaptchaDataNotProvidedError
  > {
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
              return yield* new CaptchaDataNotProvidedError();
            }

            captchaData = yield* delegates.requestCaptchaChallenge(captchaUrl.value);

            if (Option.isNone(captchaData)) {
              return yield* new CaptchaRequiredError();
            }

            continue;
          }
        }

        if (authResponseRaw.status >= 400) {
          return yield* new ProtonApiCommunicationError();
        }

        authResponse = Option.some(authResponseRaw.json as ProtonAuthResponse);
      }

      return authResponse.value;
    });
  }

  public signOut(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const session = this.session;
      if (!session || session.state !== 'ok') {
        return;
      }

      this.stopAutoRefresh();
      this.secretStore.clear(SESSION_STORAGE_KEY);
      this.saltedKeyPasswords = {};

      this.session = { state: 'logged-out' };
      this.authStatusSubject.next('disconnected');

      yield* this.destroySession(session.session);
    });
  }

  public dispose(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const session = this.session;
      if (!session || session.state !== 'ok') {
        return;
      }

      this.stopAutoRefresh();

      this.session = { state: 'disconnected' };
      this.authStatusSubject.next('disconnected');

      yield* this.destroySession(session.session);
    });
  }

  public loadSession(): Effect.Effect<void, ProtonApiCommunicationError> {
    return Effect.gen(this, function* () {
      const stored = this.secretStore.get(SESSION_STORAGE_KEY);
      if (!stored) {
        return;
      }

      yield* this.refreshSession(JSON.parse(stored) as ProtonSession);
    });
  }

  private destroySession(session: { uid: string; accessToken: string }): Effect.Effect<void, never> {
    return Effect.promise(async () => {
      this.secretStore.clear(SESSION_STORAGE_KEY);

      try {
        await deleteJson<ProtonKeySaltsResponse>('/auth/v4', session, this.appVersionHeader);
      } catch {
        // session deletion is best-effort, we ignore any errors here
      }
    });
  }

  private refreshSession(session: ProtonSession): Effect.Effect<void, ProtonApiCommunicationError> {
    return Effect.gen(this, function* () {
      const state = encodeBase64(this.randomToken(32));
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
      this.authStatusSubject.next('connected');
    });
  }

  private fetchAuthInfo(username: string): Effect.Effect<ProtonAuthInfo, ProtonApiCommunicationError> {
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
  ): Effect.Effect<RequestUrlResponse, ProtonApiCommunicationError> {
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
  ): Effect.Effect<void, ProtonApiCommunicationError> {
    return Effect.tryPromise({
      try: async () => {
        await postJson('/auth/v4/2fa', session, this.appVersionHeader, {
          TwoFactorCode: twoFactorCode
        });
      },
      catch: () => {
        throw new ProtonApiCommunicationError();
      }
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

    const captchaError = payload as ProtonApiError<ProtonCaptchaApiErrorResponse>;
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
  ): Effect.Effect<string, TwoFactorCodeRequiredError> {
    return Effect.gen(this, function* () {
      const code = yield* requestTwoFactorCode();

      if (Option.isNone(code) || !code.value.trim()) {
        return yield* new TwoFactorCodeRequiredError();
      } else {
        return code.value;
      }
    });
  }

  private resolveMailboxPassword(
    requestMailboxPassword: ProtonSignInDelegates['requestMailboxPassword']
  ): Effect.Effect<string, EncryptionPasswordRequiredError> {
    return Effect.gen(this, function* () {
      const mailboxPassword = yield* requestMailboxPassword();
      if (Option.isNone(mailboxPassword) || !mailboxPassword.value.trim()) {
        return yield* Effect.fail(new EncryptionPasswordRequiredError());
      }

      return mailboxPassword.value;
    });
  }

  private buildSrpProofs(
    authInfo: ProtonAuthInfo,
    email: string,
    password: string
  ): Effect.Effect<ProtonSrpProofs, CryptographyError> {
    return Effect.tryPromise({
      try: () => buildSrpProofs(authInfo, email, password),
      catch: () => {
        throw new CryptographyError();
      }
    });
  }

  private verifyServerProof(serverProof: string, expected: Uint8Array): Effect.Effect<void, CryptographyError> {
    return Effect.try({
      try: () => {
        const decoded = decodeBase64(serverProof);
        if (decoded.length !== expected.length) {
          throw new CryptographyError();
        }

        for (let index = 0; index < decoded.length; index += 1) {
          if (decoded[index] !== expected[index]) {
            throw new CryptographyError();
          }
        }
      },
      catch: error => {
        if (error instanceof CryptographyError) {
          throw error;
        }

        return new CryptographyError();
      }
    });
  }

  private request<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Effect.Effect<T, ProtonApiCommunicationError> {
    return Effect.gen(this, function* () {
      const response = yield* this.requestRaw(path, body, this.appVersionHeader, headers);

      if (response.status >= 400) {
        return yield* Effect.fail(new ProtonApiCommunicationError());
      }

      return response.json as T;
    });
  }

  private requestRaw(
    path: string,
    body: unknown,
    appVersionHeader: string,
    headers?: Record<string, string>
  ): Effect.Effect<RequestUrlResponse, ProtonApiCommunicationError> {
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
  ): Effect.Effect<Record<string, string>, ProtonApiCommunicationError> {
    return Effect.tryPromise({
      try: async () => {
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
      },
      catch: () => new ProtonApiCommunicationError()
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

  private refreshSessionIfNeeded(): Effect.Effect<void, ProtonApiCommunicationError> {
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

  private randomToken(byteLength: number): Uint8Array {
    const bytes = new Uint8Array(byteLength);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
}

type ProtonKeySaltEntry = {
  ID?: string;
  KeySalt?: string;
};

type ProtonKeySaltsResponse = {
  KeySalts?: ProtonKeySaltEntry[];
};

export type ProtonSessionError =
  | ProtonApiCommunicationError
  | CryptographyError
  | TwoFactorCodeRequiredError
  | EncryptionPasswordRequiredError
  | CaptchaRequiredError
  | CaptchaDataNotProvidedError;

export class ProtonApiCommunicationError extends Data.TaggedError('ProtonApiCommunicationError') {}
export class CryptographyError extends Data.TaggedError('CryptographyError') {}
export class TwoFactorCodeRequiredError extends Data.TaggedError('TwoFactorCodeRequiredError') {}
export class EncryptionPasswordRequiredError extends Data.TaggedError('EncryptionPasswordRequiredError') {}
export class CaptchaRequiredError extends Data.TaggedError('CaptchaRequiredError') {}
export class CaptchaDataNotProvidedError extends Data.TaggedError('CaptchaDataNotProvidedError') {}
