/* eslint-disable @typescript-eslint/naming-convention */
import { Data, Effect, Option } from 'effect';
import { requestUrl, type RequestUrlResponse } from 'obsidian';
import { BehaviorSubject, distinctUntilChanged } from 'rxjs';

import type {
  EncryptedPersistedSessionData,
  PersistedSecretsInvalidFormatError,
  SecretDecryptionFailedError,
  SecretEncryptionFailedError
} from '../../services/EncryptedSecretStore';
import { getEncryptedSecretStore } from '../../services/EncryptedSecretStore';
import { getObsidianSettingsStore } from '../../services/ObsidianSettingsStore';
import type { CaptchaVerification } from '../../ui/modals/captcha-modal';
import type { MasterPasswordModalMode } from '../../ui/modals/master-password-modal';
import { PROTON_BASE_URL } from '../Constants';
import { deleteJson, getJson, postJson, ProtonApiHttpError } from '../ProtonApiClient';
import {
  authenticateInBrowser,
  BrowserSignInError,
  type BrowserSignInResult,
  revokeBrowserSession
} from './BrowserSignIn';
import { getExternalCaptchaUrl } from './CaptchaChallenge';
import type { ProtonSession } from './ProtonSession';
import type { ProtonAuthInfo, ProtonSrpProofs } from './ProtonSrp';
import { buildSrpProofs, computeKeyPasswordFromSalt, decodeBase64, encodeBase64 } from './ProtonSrp';
const AUTH_SCOPE = 'full locked';

const AUTH_REQUEST_TIMEOUT_MS = 30_000;

export { POST_SYNC_MEMORY_CLEAR_DELAY_MS } from '../../services/EncryptedSecretStore';

export type ProtonAuthStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ProtonSignInDelegates {
  requestTwoFactorCode: () => Effect.Effect<Option.Option<string>, never>;
  requestMailboxPassword: () => Effect.Effect<Option.Option<string>, never>;
  requestCaptchaChallenge: (captchaUrl: string) => Effect.Effect<Option.Option<CaptchaVerification>, never>;
  requestMasterPassword: () => Effect.Effect<Option.Option<string>, never>;
}

interface ProtonAuthResponse {
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

interface ProtonApiError<T> {
  Code: number;
  Error: string;
  Details: T;
}

interface ProtonCaptchaApiErrorResponse {
  HumanVerificationToken: string;
  HumanVerificationMethods: Array<string>;
  Direct: number;
  Description: string;
  Title: string;
  WebUrl: string;
  ExpiresAt: number;
}

export const { init: initProtonSessionService, get: getProtonSessionService } = (function (): {
  init: (this: void, appVersionHeader: string) => ProtonSessionService;
  get: (this: void) => ProtonSessionService;
} {
  let instance: ProtonSessionService | null = null;

  return {
    init: function (this: void, appVersionHeader: string): ProtonSessionService {
      return (instance ??= new ProtonSessionService(appVersionHeader));
    },
    get: function (this: void): ProtonSessionService {
      if (!instance) {
        throw new Error('ProtonSessionService has not been initialized. Please call initProtonSessionService first.');
      }
      return instance;
    }
  };
})();

class ProtonSessionService {
  readonly #authStatusSubject = new BehaviorSubject<ProtonAuthStatus>('disconnected');
  public readonly authState$ = this.#authStatusSubject.pipe(distinctUntilChanged());

  readonly #encryptedSecretStore = getEncryptedSecretStore();

  public constructor(public readonly appVersionHeader: string) {}

  public signInViaBrowser(
    onSignInUrl: (url: string) => void,
    requestMasterPassword: () => Effect.Effect<Option.Option<string>, never>,
    onBrowserComplete: () => void,
    signal: AbortSignal
  ): Effect.Effect<void, BrowserSignInFailure | MasterPasswordRequiredError | SecretEncryptionFailedError> {
    let browserResult: BrowserSignInResult | undefined;
    return Effect.gen(this, function* () {
      this.#authStatusSubject.next('connecting');
      browserResult = yield* Effect.tryPromise({
        try: () => authenticateInBrowser(this.appVersionHeader, onSignInUrl, signal),
        catch: error =>
          new BrowserSignInFailure({
            message: error instanceof BrowserSignInError ? error.message : 'Browser sign-in failed.'
          })
      });
      if (signal.aborted) {
        return yield* new BrowserSignInFailure({ message: 'Browser sign-in cancelled.' });
      }
      onBrowserComplete();
      const masterPassword = yield* this.#resolveMasterPassword(requestMasterPassword());
      if (signal.aborted) {
        return yield* new BrowserSignInFailure({ message: 'Browser sign-in cancelled.' });
      }
      yield* this.#persistEncryptedSessionData(browserResult.session, browserResult.saltedPassphrases, masterPassword);
      if (signal.aborted) {
        yield* this.#encryptedSecretStore.clearSessionData();
        return yield* new BrowserSignInFailure({ message: 'Browser sign-in cancelled.' });
      }
      getObsidianSettingsStore().set('accountEmail', browserResult.accountName);
      this.#encryptedSecretStore.cancelScheduledLock();
      this.#authStatusSubject.next('connected');
    }).pipe(
      Effect.catchAll(error =>
        Effect.gen(this, function* () {
          this.#authStatusSubject.next('error');
          if (browserResult) {
            const failedSession = browserResult.session;
            yield* Effect.promise(() => revokeBrowserSession(this.appVersionHeader, failedSession));
          }
          return yield* Effect.fail(error);
        })
      )
    );
  }

  public signIn(
    email: string,
    password: string,
    delegates: ProtonSignInDelegates
  ): Effect.Effect<
    void,
    | ProtonApiCommunicationError
    | CryptographyError
    | CaptchaRequiredError
    | CaptchaDataNotProvidedError
    | TwoFactorCodeRequiredError
    | UnsupportedTwoFactorMethodError
    | EncryptionPasswordRequiredError
    | MasterPasswordRequiredError
    | SecretEncryptionFailedError,
    never
  > {
    let authResponse: ProtonAuthResponse | null = null;

    return Effect.gen(this, function* () {
      this.#authStatusSubject.next('connecting');

      const authInfo = yield* this.#fetchAuthInfo(email);
      const proofs = yield* this.#buildSrpProofs(authInfo, email, password);
      authResponse = yield* this.#authenticateWithCaptcha(authInfo, email, proofs, delegates);

      yield* this.#verifyServerProof(authResponse.ServerProof, proofs.expectedServerProof);

      if ((authResponse['2FA']?.Enabled ?? 0) > 0 && !this.#requiresTwoFactorCode(authResponse)) {
        return yield* new UnsupportedTwoFactorMethodError();
      }

      if (this.#requiresTwoFactorCode(authResponse)) {
        const twoFactorCode = yield* this.#resolveTwoFactorCode(delegates.requestTwoFactorCode);
        yield* this.#submitTwoFactor(twoFactorCode, { accessToken: authResponse.AccessToken, uid: authResponse.UID });
      }

      let keyPassword = password;

      if (this.#requiresMailboxPassword(authResponse)) {
        keyPassword = yield* this.#resolveMailboxPassword(delegates.requestMailboxPassword);
      }

      const now = new Date();

      const keyPasswords = yield* this.#getKeyPasswords(keyPassword, {
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken
      });

      const session: ProtonSession = {
        uid: authResponse.UID,
        userId: authResponse.UserID || null,
        accessToken: authResponse.AccessToken,
        refreshToken: authResponse.RefreshToken,
        scope: authResponse.Scope || null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + authResponse.ExpiresIn * 1000),
        lastRefreshAt: now
      };

      const masterPassword = yield* this.#resolveMasterPassword(delegates.requestMasterPassword());

      yield* this.#persistEncryptedSessionData(session, keyPasswords, masterPassword);

      this.#encryptedSecretStore.cancelScheduledLock();

      this.#authStatusSubject.next('connected');
    }).pipe(
      Effect.catchAll(e =>
        Effect.gen(this, function* () {
          this.#authStatusSubject.next('error');
          if (authResponse) {
            // destroy the session if it was successfully created
            yield* this.#destroySession({
              uid: authResponse.UID,
              accessToken: authResponse.AccessToken
            });
          }
          return yield* e;
        })
      )
    );
  }

  public getCurrentSession(): Option.Option<ProtonSession> {
    const unlocked = this.#encryptedSecretStore.getUnlockedSessionData();
    if (Option.isSome(unlocked)) {
      return Option.some(unlocked.value.session);
    }

    return Option.none();
  }

  public getSaltedKeyPasswords(): Option.Option<Record<string, string>> {
    const unlocked = this.#encryptedSecretStore.getUnlockedSessionData();
    if (Option.isSome(unlocked)) {
      return Option.some(unlocked.value.saltedPassphrases);
    }

    return Option.none();
  }

  #authenticateWithCaptcha(
    authInfo: ProtonAuthInfo,
    email: string,
    proofs: ProtonSrpProofs,
    delegates: ProtonSignInDelegates
  ): Effect.Effect<
    ProtonAuthResponse,
    ProtonApiCommunicationError | CaptchaRequiredError | CaptchaDataNotProvidedError
  > {
    return Effect.gen(this, function* () {
      let authResponse: Option.Option<ProtonAuthResponse> = Option.none();
      let captchaData: Option.Option<CaptchaVerification> = Option.none();

      while (Option.isNone(authResponse)) {
        const authResponseRaw = yield* this.#authenticate(authInfo, email, this.appVersionHeader, proofs, captchaData);

        if (this.#requiresCaptcha(authResponseRaw)) {
          // At most one user challenge and one login retry on every platform.
          // Repeated CAPTCHA responses must never create a retry loop.
          if (Option.isSome(captchaData)) {
            return yield* new CaptchaRequiredError();
          }

          const captchaUrl = this.#extractCaptchaUrl(authResponseRaw.json);
          if (Option.isNone(captchaUrl)) {
            return yield* new CaptchaDataNotProvidedError();
          }
          captchaData = yield* delegates.requestCaptchaChallenge(captchaUrl.value);
          if (Option.isNone(captchaData)) {
            return yield* new CaptchaRequiredError();
          }
          continue;
        }

        if (authResponseRaw.status >= 400) {
          return yield* new ProtonApiCommunicationError({
            message: formatAuthHttpFailure('/auth/v4', authResponseRaw)
          });
        }

        authResponse = Option.some(authResponseRaw.json as ProtonAuthResponse);
      }

      return authResponse.value;
    });
  }

  public signOut(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const currentSession = this.getCurrentSession();

      yield* this.#clearLocalSessionState();

      if (Option.isSome(currentSession)) {
        yield* this.#destroySession(currentSession.value);
      }
    });
  }

  /**
   * Drops all local session state without calling Proton. Used when the server has
   * already invalidated the session (rejected refresh token, 401 from the Drive API),
   * so the plugin state matches reality instead of holding on to dead credentials.
   */
  public forceSignOut(): Effect.Effect<void> {
    return this.#clearLocalSessionState();
  }

  #clearLocalSessionState(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* this.#encryptedSecretStore.clearSessionData();
      this.#authStatusSubject.next('disconnected');

      const settingsStore = getObsidianSettingsStore();
      settingsStore.set('accountEmail', '');
      settingsStore.set('lastLoginAt', null);
      settingsStore.set('lastRefreshAt', null);
      settingsStore.set('sessionExpiresAt', null);
      // The event cursor and the entities cache are one snapshot - neither outlives the session.
      settingsStore.set('latestEventId', Option.none());
      settingsStore.set('vaultRootNodeUid', Option.none());
    });
  }

  public dispose(): void {
    this.#encryptedSecretStore.lockSession();
    this.#authStatusSubject.next('disconnected');
  }

  public activatePersistedSession(
    requestMasterPassword: (type: MasterPasswordModalMode) => Effect.Effect<Option.Option<string>, never>
  ): Effect.Effect<
    ProtonSession,
    | PersistedSessionNotFoundError
    | PersistedSecretsInvalidFormatError
    | MasterPasswordRequiredError
    | SecretDecryptionFailedError
    | ProtonApiCommunicationError
    | SecretEncryptionFailedError
    | SessionInvalidatedError
  > {
    return Effect.gen(this, function* () {
      this.#authStatusSubject.next('connecting');

      if (!this.#encryptedSecretStore.hasPersistedSessionData()) {
        this.#authStatusSubject.next('disconnected');
        return yield* new PersistedSessionNotFoundError();
      }

      const unlocked = this.#encryptedSecretStore.getUnlockedSessionData();

      let unlockedSessionData: EncryptedPersistedSessionData;
      let masterPassword: string | null = null;

      if (Option.isNone(unlocked)) {
        masterPassword = yield* this.#resolveMasterPassword(requestMasterPassword('unlock'));

        unlockedSessionData = yield* this.#encryptedSecretStore.loadSessionData(masterPassword);
      } else {
        unlockedSessionData = unlocked.value;
      }

      let session = unlockedSessionData.session;

      if (session.expiresAt.getTime() - Date.now() < 10 * 60 * 1000) {
        session = yield* this.#refreshSession(session).pipe(
          Effect.catchTag('SessionInvalidatedError', error =>
            Effect.gen(this, function* () {
              // Proton refused the refresh token - the session is gone server-side, so drop it here too.
              yield* this.forceSignOut();
              return yield* error;
            })
          )
        );
        yield* this.#persistEncryptedSessionData(
          session,
          unlockedSessionData.saltedPassphrases,
          masterPassword ?? (yield* this.#resolveMasterPassword(requestMasterPassword('session-refresh')))
        );
      }

      this.#encryptedSecretStore.cancelScheduledLock();
      this.#authStatusSubject.next('connected');

      return session;
    });
  }

  #refreshSession(
    session: ProtonSession
  ): Effect.Effect<ProtonSession, ProtonApiCommunicationError | SessionInvalidatedError> {
    return Effect.gen(this, function* () {
      const state = encodeBase64(this.#randomToken(32));
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

      const response = yield* Effect.tryPromise({
        try: () =>
          postJson<ProtonAuthResponse>(
            '/auth/v4/refresh',
            { uid: session.uid, accessToken: session.accessToken },
            this.appVersionHeader,
            body
          ),
        catch: error => (isSessionRejection(error) ? new SessionInvalidatedError() : new ProtonApiCommunicationError())
      });

      const refreshedAt = new Date();

      return {
        ...session,
        uid: response.UID || session.uid,
        accessToken: response.AccessToken,
        refreshToken: response.RefreshToken,
        scope: response.Scope || session.scope,
        updatedAt: refreshedAt,
        expiresAt: new Date(refreshedAt.getTime() + response.ExpiresIn * 1000),
        lastRefreshAt: refreshedAt
      };
    });
  }

  #destroySession(session: { uid: string; accessToken: string }): Effect.Effect<void, never> {
    return Effect.promise(async () => {
      try {
        await deleteJson('/auth/v4', session, this.appVersionHeader);
      } catch {
        // session deletion is best-effort, we ignore any errors here
      }
    });
  }

  #randomToken(byteLength: number): Uint8Array {
    const bytes = new Uint8Array(byteLength);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  #fetchAuthInfo(username: string): Effect.Effect<ProtonAuthInfo, ProtonApiCommunicationError> {
    return Effect.gen(this, function* () {
      const response = yield* this.#request<{ AuthInfo?: ProtonAuthInfo } | ProtonAuthInfo>('/auth/v4/info', {
        Username: username
      });

      if ('AuthInfo' in response && response.AuthInfo) {
        return response.AuthInfo;
      }

      return response as ProtonAuthInfo;
    });
  }

  #authenticate(
    authInfo: ProtonAuthInfo,
    username: string,
    appVersionHeader: string,
    proofs: { clientProof: Uint8Array; clientEphemeral: Uint8Array },
    captchaData: Option.Option<CaptchaVerification>
  ): Effect.Effect<RequestUrlResponse, ProtonApiCommunicationError> {
    return this.#requestRaw(
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

  #submitTwoFactor(
    twoFactorCode: string,
    session: { uid: string; accessToken: string }
  ): Effect.Effect<void, ProtonApiCommunicationError> {
    return Effect.tryPromise({
      try: async () => {
        await postJson('/auth/v4/2fa', session, this.appVersionHeader, {
          TwoFactorCode: twoFactorCode
        });
      },
      catch: error => new ProtonApiCommunicationError({ message: formatAuthenticatedFailure('/auth/v4/2fa', error) })
    });
  }

  #requiresCaptcha(response: RequestUrlResponse): boolean {
    if (
      response.status !== 422 ||
      response.json === undefined ||
      response.json === null ||
      !('Code' in response.json) ||
      response.json?.Code !== 9001
    ) {
      return false;
    }

    return true;
  }

  #extractCaptchaUrl(payload: unknown): Option.Option<string> {
    if (payload === undefined || payload === null || typeof payload !== 'object') {
      return Option.none();
    }

    const captchaError = payload as ProtonApiError<ProtonCaptchaApiErrorResponse>;
    const url = captchaError.Details?.WebUrl;

    if (typeof url !== 'string' || !url.trim()) {
      return Option.none();
    }

    const externalUrl = getExternalCaptchaUrl(url);
    return externalUrl ? Option.some(externalUrl.toString()) : Option.none();
  }

  #requiresTwoFactorCode(authResponse: ProtonAuthResponse): boolean {
    const twoFaEnabled = authResponse['2FA']?.Enabled;
    return Boolean(twoFaEnabled !== undefined && twoFaEnabled !== null && (twoFaEnabled & 1) !== 0);
  }

  #requiresMailboxPassword(authResponse: ProtonAuthResponse): boolean {
    return authResponse.PasswordMode === 2;
  }

  #resolveTwoFactorCode(
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

  #resolveMailboxPassword(
    requestMailboxPassword: ProtonSignInDelegates['requestMailboxPassword']
  ): Effect.Effect<string, EncryptionPasswordRequiredError> {
    return Effect.gen(this, function* () {
      const mailboxPassword = yield* requestMailboxPassword();
      if (Option.isNone(mailboxPassword) || !mailboxPassword.value.trim()) {
        return yield* new EncryptionPasswordRequiredError();
      }

      return mailboxPassword.value;
    });
  }

  #resolveMasterPassword(
    requestMasterPassword: Effect.Effect<Option.Option<string>, never>
  ): Effect.Effect<string, MasterPasswordRequiredError> {
    return Effect.gen(function* () {
      const password = yield* requestMasterPassword;
      if (Option.isNone(password) || !password.value.trim()) {
        return yield* new MasterPasswordRequiredError();
      }

      return password.value;
    });
  }

  #buildSrpProofs(
    authInfo: ProtonAuthInfo,
    email: string,
    password: string
  ): Effect.Effect<ProtonSrpProofs, CryptographyError> {
    return Effect.tryPromise({
      try: () => buildSrpProofs(authInfo, email, password),
      catch: () => new CryptographyError({ message: 'Password proof generation failed' })
    });
  }

  #verifyServerProof(serverProof: string, expected: Uint8Array): Effect.Effect<void, CryptographyError> {
    return Effect.try({
      try: (): void => {
        if (typeof serverProof !== 'string' || !serverProof) {
          throw new CryptographyError({ message: 'Authentication response is missing the server proof' });
        }
        const decoded = decodeBase64(serverProof);
        if (decoded.length !== expected.length) {
          throw new CryptographyError({ message: 'Server proof verification failed (length mismatch)' });
        }

        for (let index = 0; index < decoded.length; index += 1) {
          if (decoded[index] !== expected[index]) {
            throw new CryptographyError({ message: 'Server proof verification failed (proof mismatch)' });
          }
        }
      },
      catch: error => {
        if (error instanceof CryptographyError) {
          return error;
        }

        return new CryptographyError({ message: 'Server proof verification failed (invalid response)' });
      }
    });
  }

  #request<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>
  ): Effect.Effect<T, ProtonApiCommunicationError> {
    return Effect.gen(this, function* () {
      const response = yield* this.#requestRaw(path, body, this.appVersionHeader, headers);

      if (response.status >= 400) {
        return yield* new ProtonApiCommunicationError({ message: formatAuthHttpFailure(path, response) });
      }

      return response.json as T;
    });
  }

  #requestRaw(
    path: string,
    body: unknown,
    appVersionHeader: string,
    headers?: Record<string, string>
  ): Effect.Effect<RequestUrlResponse, ProtonApiCommunicationError> {
    return Effect.tryPromise({
      try: () =>
        requestUrl({
          url: `${PROTON_BASE_URL}${path}`,
          method: 'POST',
          contentType: 'application/json',
          headers: {
            'x-pm-appversion': appVersionHeader,
            ...(headers ?? {})
          },
          body: JSON.stringify(body),
          throw: false
        }),
      catch: () => new ProtonApiCommunicationError({ message: `${path}: network request failed` })
    }).pipe(
      Effect.timeoutFail({
        duration: AUTH_REQUEST_TIMEOUT_MS,
        onTimeout: () => new ProtonApiCommunicationError({ message: `${path}: request timed out after 30 seconds` })
      })
    );
  }

  #getKeyPasswords(
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
      catch: error =>
        new ProtonApiCommunicationError({ message: formatAuthenticatedFailure('/core/v4/keys/salts', error) })
    });
  }

  #persistEncryptedSessionData(
    session: ProtonSession,
    saltedPassphrases: Record<string, string>,
    masterPassword: string
  ): Effect.Effect<void, SecretEncryptionFailedError> {
    return this.#encryptedSecretStore.persistSessionData(
      {
        session,
        saltedPassphrases
      },
      masterPassword
    );
  }
}

interface ProtonKeySaltEntry {
  ID?: string;
  KeySalt?: string;
}

interface ProtonKeySaltsResponse {
  KeySalts?: Array<ProtonKeySaltEntry>;
}

export type ProtonSessionError =
  | ProtonApiCommunicationError
  | CryptographyError
  | TwoFactorCodeRequiredError
  | UnsupportedTwoFactorMethodError
  | EncryptionPasswordRequiredError
  | MasterPasswordRequiredError
  | CaptchaRequiredError
  | CaptchaDataNotProvidedError
  | PersistedSessionNotFoundError
  | PersistedSecretsInvalidFormatError
  | SecretEncryptionFailedError
  | SecretDecryptionFailedError
  | SessionInvalidatedError;

/** Statuses Proton returns when it no longer accepts the session's credentials. */
const SESSION_REJECTION_STATUSES = new Set([401, 422]);

function isSessionRejection(error: unknown): boolean {
  return error instanceof ProtonApiHttpError && SESSION_REJECTION_STATUSES.has(error.status);
}

/** Only the fixed route, HTTP status and numeric API code are safe to display. */
function formatAuthHttpFailure(path: string, response: RequestUrlResponse): string {
  const payload: unknown = response.json;
  const code = typeof payload === 'object' && payload !== null && 'Code' in payload ? payload.Code : undefined;
  const apiCode = typeof code === 'number' && Number.isSafeInteger(code) ? `, API code ${code}` : '';
  return `${path}: HTTP ${response.status}${apiCode}`;
}

function formatAuthenticatedFailure(path: string, error: unknown): string {
  return error instanceof ProtonApiHttpError
    ? `${path}: HTTP ${error.status}`
    : `${path}: network request or response processing failed`;
}

export class ProtonApiCommunicationError extends Data.TaggedError('ProtonApiCommunicationError')<{
  message?: string;
}> {
  public constructor(options: { message?: string } = {}) {
    super(options);
  }
}
export class CryptographyError extends Data.TaggedError('CryptographyError')<{ message?: string }> {
  public constructor(options: { message?: string } = {}) {
    super(options);
  }
}
export class TwoFactorCodeRequiredError extends Data.TaggedError('TwoFactorCodeRequiredError') {}
export class UnsupportedTwoFactorMethodError extends Data.TaggedError('UnsupportedTwoFactorMethodError') {}
export class BrowserSignInFailure extends Data.TaggedError('BrowserSignInFailure')<{ message: string }> {}
export class EncryptionPasswordRequiredError extends Data.TaggedError('EncryptionPasswordRequiredError') {}
export class MasterPasswordRequiredError extends Data.TaggedError('MasterPasswordRequiredError') {}
export class CaptchaRequiredError extends Data.TaggedError('CaptchaRequiredError') {}
export class CaptchaDataNotProvidedError extends Data.TaggedError('CaptchaDataNotProvidedError') {}
export class PersistedSessionNotFoundError extends Data.TaggedError('PersistedSessionNotFoundError') {}
export class SessionInvalidatedError extends Data.TaggedError('SessionInvalidatedError') {}
