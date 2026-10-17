/* eslint-disable @typescript-eslint/naming-convention */
import { requestUrl, type RequestUrlResponse } from 'obsidian';

import { PROTON_BASE_URL } from '../Constants';
import type { ProtonSession } from './ProtonSession';

const ACCOUNT_ORIGIN = 'https://account.proton.me';
const POLL_INTERVAL_MS = 5000;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export class BrowserSignInError extends Error {
  public constructor(
    public readonly reason: 'cancelled' | 'timeout' | 'failed',
    message: string
  ) {
    super(message);
    this.name = 'BrowserSignInError';
  }
}

export interface BrowserSignInResult {
  session: ProtonSession;
  saltedPassphrases: Record<string, string>;
  accountName: string;
}

interface Credentials {
  uid: string;
  accessToken: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserSignInError('failed', 'Proton browser sign-in returned an invalid response.');
  }
  return value as JsonRecord;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BrowserSignInError('failed', 'Proton browser sign-in returned incomplete session data.');
  }
  return value;
}

/** Same fragment format used by ProtonDriveApps/sdk authWeb.ts (protocol v3). */
export function createBrowserSignInUrl(clientId: string, userCode: string, key: Uint8Array): string {
  if (!/^external-drive-[a-z0-9_-]+$/.test(clientId) || key.length !== 32 || !/^[A-Z0-9-]{4,32}$/i.test(userCode)) {
    throw new BrowserSignInError('failed', 'Invalid browser sign-in configuration.');
  }
  const url = new URL('/desktop/login', ACCOUNT_ORIGIN);
  url.searchParams.set('app', 'drive');
  url.searchParams.set('pv', '3');
  // The encryption key stays in the fragment, not the HTTP query or a callback.
  const payload = `0:${userCode}:${Buffer.from(key).toString('base64')}:${clientId}`;
  url.hash = `payload=${encodeURIComponent(payload)}`;
  return url.toString();
}

/** AES-256-GCM: 12-byte nonce || ciphertext || 16-byte tag; AAD is "fork". */
export async function decryptBrowserKeyPassword(key: Uint8Array, encodedPayload: string): Promise<string> {
  try {
    if (encodedPayload.length > 90_000) {
      throw new Error('Invalid payload');
    }
    const blob = new Uint8Array(Buffer.from(encodedPayload, 'base64'));
    if (key.length !== 32 || blob.length < 29 || blob.length > 65_536) {
      throw new Error('Invalid payload');
    }
    const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['decrypt']);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: blob.slice(0, 12),
          additionalData: new TextEncoder().encode('fork'),
          tagLength: 128
        },
        cryptoKey,
        blob.slice(12)
      )
    );
    try {
      return requiredString(record(JSON.parse(new TextDecoder().decode(plaintext))).keyPassword);
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new BrowserSignInError('failed', 'Could not verify the encrypted browser sign-in payload.');
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BrowserSignInError('cancelled', 'Browser sign-in cancelled.');
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new BrowserSignInError('cancelled', 'Browser sign-in cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

export async function revokeBrowserSession(appVersion: string, credentials: Credentials): Promise<void> {
  const cleanupSignal = new AbortController();
  try {
    await request(
      'Session cleanup',
      '/auth/v4',
      'DELETE',
      appVersion,
      cleanupSignal.signal,
      credentials,
      undefined,
      5000
    );
  } catch {
    // Revocation is best-effort, without logging session data or blocking forever.
  }
}

async function request(
  stage: string,
  path: string,
  method: 'GET' | 'DELETE',
  appVersion: string,
  signal: AbortSignal,
  credentials?: Credentials,
  lateKind?: 'init' | 'poll',
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<RequestUrlResponse> {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (!settled) {
        finish();
        reject(new BrowserSignInError('cancelled', 'Browser sign-in cancelled.'));
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        finish();
        reject(new BrowserSignInError('timeout', `${stage}: request timed out. Reconnect to try again.`));
      }
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    const headers: Record<string, string> = { 'x-pm-appversion': appVersion };
    if (credentials) {
      headers['x-pm-uid'] = credentials.uid;
      headers.authorization = `Bearer ${credentials.accessToken}`;
    }
    void Promise.resolve()
      .then(() => requestUrl({ url: `${PROTON_BASE_URL}${path}`, method, headers, throw: false }))
      .then(
        response => {
          if (settled) {
            // requestUrl cannot be aborted. Revoke a session arriving after Cancel
            // or a timeout instead of letting it escape the abandoned attempt.
            void cleanupLateResponse(appVersion, response, lateKind);
            return;
          }
          finish();
          resolve(response);
        },
        () => {
          if (!settled) {
            finish();
            reject(new BrowserSignInError('failed', `${stage}: network request failed.`));
          }
        }
      );
  });
}

async function cleanupLateResponse(
  appVersion: string,
  response: RequestUrlResponse,
  kind?: 'init' | 'poll'
): Promise<void> {
  try {
    if (response.status !== 200) {
      return;
    }
    const payload = record(response.json);
    if (kind === 'poll' && typeof payload.UID === 'string' && typeof payload.AccessToken === 'string') {
      await revokeBrowserSession(appVersion, { uid: payload.UID, accessToken: payload.AccessToken });
    } else if (kind === 'init' && typeof payload.Selector === 'string') {
      await invalidateSelector(appVersion, payload.Selector);
    }
  } catch {
    // No response payloads or secret-bearing URLs are logged, even on failure.
  }
}

async function invalidateSelector(appVersion: string, selector: string): Promise<void> {
  try {
    await request(
      'Sign-in cleanup',
      `/auth/v4/sessions/forks/${encodeURIComponent(selector)}`,
      'DELETE',
      appVersion,
      new AbortController().signal,
      undefined,
      undefined,
      5000
    );
  } catch {
    // One-time selector also expires server-side.
  }
}

function expectSuccess(stage: string, response: RequestUrlResponse): JsonRecord {
  if (response.status !== 200) {
    throw new BrowserSignInError('failed', `${stage}: HTTP ${response.status}.`);
  }
  return record(response.json);
}

/** User performs all password, CAPTCHA and WebAuthn steps on Proton's origin. */
export async function authenticateInBrowser(
  appVersion: string,
  onSignInUrl: (url: string) => void,
  signal: AbortSignal
): Promise<BrowserSignInResult> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let selector: string | undefined;
  let session: ProtonSession | undefined;
  let completed = false;
  try {
    const clientId = appVersion.split('@')[0];
    const init = expectSuccess(
      'Start browser sign-in',
      await request('Start browser sign-in', '/auth/v4/sessions/forks', 'GET', appVersion, signal, undefined, 'init')
    );
    selector = requiredString(init.Selector);
    onSignInUrl(createBrowserSignInUrl(clientId, requiredString(init.UserCode), key));
    const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await waitForPoll(signal);
      const response = await request(
        'Check browser sign-in',
        `/auth/v4/sessions/forks/${encodeURIComponent(selector)}`,
        'GET',
        appVersion,
        signal,
        undefined,
        'poll'
      );
      if (response.status === 422) {
        continue; // Official SDK's pending response; bounded by the deadline.
      }
      const fork = expectSuccess('Check browser sign-in', response);
      const now = new Date();
      session = {
        uid: requiredString(fork.UID),
        userId: typeof fork.UserID === 'string' ? fork.UserID : null,
        accessToken: requiredString(fork.AccessToken),
        refreshToken: requiredString(fork.RefreshToken),
        scope: Array.isArray(fork.Scopes)
          ? fork.Scopes.filter((s): s is string => typeof s === 'string').join(' ')
          : null,
        createdAt: now,
        updatedAt: now,
        lastRefreshAt: now,
        // If expiry is omitted, force a normal refresh before the next operation.
        expiresAt: new Date(
          now.getTime() + (typeof fork.ExpiresIn === 'number' ? Math.max(0, fork.ExpiresIn) * 1000 : 0)
        )
      };
      checkCancelled(signal);
      const keyPassword = await decryptBrowserKeyPassword(key, requiredString(fork.Payload));
      checkCancelled(signal);
      const userResponse = expectSuccess(
        'Load signed-in account',
        await request('Load signed-in account', '/core/v4/users', 'GET', appVersion, signal, session)
      );
      const user = record(userResponse.User);
      const userId = requiredString(user.ID);
      if (session.userId && session.userId !== userId) {
        throw new BrowserSignInError('failed', 'Browser sign-in account identity did not match.');
      }
      session.userId = userId;
      const keys = Array.isArray(user.Keys)
        ? user.Keys.map(record).filter(k => k.Active === undefined || k.Active === true || k.Active === 1)
        : [];
      const primaryKey = keys.find(k => k.Primary === true || k.Primary === 1) ?? keys[0];
      const primaryKeyId = requiredString(primaryKey?.ID);
      checkCancelled(signal);
      completed = true;
      return {
        session,
        saltedPassphrases: { [primaryKeyId]: keyPassword },
        accountName: typeof user.Email === 'string' ? user.Email : typeof user.Name === 'string' ? user.Name : ''
      };
    }
    throw new BrowserSignInError('timeout', 'Browser sign-in expired after 10 minutes. Reconnect to try again.');
  } catch (error) {
    if (error instanceof BrowserSignInError) {
      throw error;
    }
    throw new BrowserSignInError('failed', 'Browser sign-in could not be completed. Reconnect to try again.');
  } finally {
    key.fill(0);
    if (!completed) {
      if (session) {
        await revokeBrowserSession(appVersion, session);
      }
      if (selector) {
        await invalidateSelector(appVersion, selector);
      }
    }
  }
}
