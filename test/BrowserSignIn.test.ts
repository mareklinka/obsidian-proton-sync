/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() =>
  vi.fn<(request: { url: string; method: string; headers: Record<string, string> }) => Promise<unknown>>()
);
vi.mock('obsidian', () => ({ requestUrl: requestMock }));

import { authenticateInBrowser, createBrowserSignInUrl, decryptBrowserKeyPassword } from '../proton/auth/BrowserSignIn';

const APP_VERSION = 'external-drive-obsidiansync@0.3.2-beta.5';
const CLIENT_ID = 'external-drive-obsidiansync';
const SELECTOR = 'dummy-selector';
const KEY_PASSWORD = 'dummy-key-password';
const forkCredentials = {
  UID: 'dummy-uid',
  AccessToken: 'dummy-access',
  RefreshToken: 'dummy-refresh',
  UserID: 'user-id'
};

async function encryptFixture(key: Uint8Array, payload: unknown = { keyPassword: KEY_PASSWORD }, aad = 'fork') {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: new TextEncoder().encode(aad),
      tagLength: 128
    },
    cryptoKey,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return Buffer.concat([Buffer.from(nonce), Buffer.from(encrypted)]).toString('base64');
}

function getFragmentKey(url: string): Uint8Array {
  const payload = new URLSearchParams(new URL(url).hash.slice(1)).get('payload') ?? '';
  return new Uint8Array(Buffer.from(payload.split(':')[2], 'base64'));
}

function setupRequests(options: { pending?: number; identityMismatch?: boolean; badPayload?: boolean } = {}) {
  let forkKey = new Uint8Array(32);
  let polls = 0;
  const onUrl = vi.fn((url: string) => {
    forkKey = getFragmentKey(url);
  });
  requestMock.mockImplementation(async (request: { url: string; method: string }) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'DELETE') {
      return { status: 200, json: { Code: 1000 } };
    }
    if (path === '/auth/v4/sessions/forks') {
      return { status: 200, json: { Selector: SELECTOR, UserCode: 'TEST1234' } };
    }
    if (path === `/auth/v4/sessions/forks/${SELECTOR}`) {
      polls++;
      if (polls <= (options.pending ?? 0)) {
        return { status: 422, json: { Code: 2001 } };
      }
      return {
        status: 200,
        json: {
          ...forkCredentials,
          Scopes: ['full'],
          ExpiresIn: 3600,
          Payload: options.badPayload ? 'invalid' : await encryptFixture(forkKey)
        }
      };
    }
    if (path === '/core/v4/users') {
      return {
        status: 200,
        json: {
          User: {
            ID: options.identityMismatch ? 'other-user' : 'user-id',
            Email: 'dummy@example.test',
            Keys: [
              { ID: 'inactive-key', Primary: 1, Active: 0 },
              { ID: 'primary-key', Primary: 1, Active: 1 }
            ]
          }
        }
      };
    }
    throw new Error('Unexpected test request');
  });
  return onUrl;
}

async function advanceUntilUrl(onUrl: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(onUrl).toHaveBeenCalledOnce());
}

describe('browser sign-in cryptography and URL', () => {
  it('keeps the AES key and user code in the fragment on Proton’s fixed origin', () => {
    const key = new Uint8Array(32).fill(7);
    const url = new URL(createBrowserSignInUrl(CLIENT_ID, 'TEST1234', key));
    expect(url.origin).toBe('https://account.proton.me');
    expect(url.pathname).toBe('/desktop/login');
    expect([...url.searchParams]).toEqual([
      ['app', 'drive'],
      ['pv', '3']
    ]);
    expect(new URLSearchParams(url.hash.slice(1)).get('payload')).toBe(
      `0:TEST1234:${Buffer.from(key).toString('base64')}:${CLIENT_ID}`
    );
  });

  it.each(['cli-drive', 'web-drive', 'external-mail-other', 'https://evil.test'])(
    'rejects client impersonation: %s',
    client => {
      expect(() => createBrowserSignInUrl(client, 'TEST1234', new Uint8Array(32))).toThrow('Invalid browser');
    }
  );

  it('decrypts Proton’s nonce/ciphertext/tag format using the fork AAD', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    expect(await decryptBrowserKeyPassword(key, await encryptFixture(key))).toBe(KEY_PASSWORD);
  });

  it('rejects a wrong key, wrong AAD, tampering, missing password, and truncated ciphertext', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const good = await encryptFixture(key);
    const tampered = Buffer.from(good, 'base64');
    tampered[tampered.length - 1] ^= 1;
    for (const [testKey, payload] of [
      [new Uint8Array(32), good],
      [key, await encryptFixture(key, undefined, 'wrong')],
      [key, tampered.toString('base64')],
      [key, await encryptFixture(key, {})],
      [key, 'short']
    ] as const) {
      await expect(decryptBrowserKeyPassword(testKey, payload)).rejects.toThrow('Could not verify');
    }
  });
});

describe('browser sign-in protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls pending once, decrypts the session, and binds the key password to the signed-in account', async () => {
    const onUrl = setupRequests({ pending: 1 });
    const promise = authenticateInBrowser(APP_VERSION, onUrl, new AbortController().signal);
    await advanceUntilUrl(onUrl);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result.session).toMatchObject({ uid: 'dummy-uid', userId: 'user-id', scope: 'full' });
    expect(result.saltedPassphrases).toEqual({ 'primary-key': KEY_PASSWORD });
    expect(result.accountName).toBe('dummy@example.test');
    const requests = requestMock.mock.calls.map(([r]) => r);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(requests.some(r => r.url.includes('/keys/salts') || r.url.includes('/2fa'))).toBe(false);
    expect(requests[0].headers).toEqual({ 'x-pm-appversion': APP_VERSION });
    expect(requests.at(-1).headers.authorization).toBe('Bearer dummy-access');
  });

  it.each([{ identityMismatch: true }, { badPayload: true }])(
    'revokes sessions on invalid payload/account: %j',
    async options => {
      const onUrl = setupRequests(options);
      const outcome = authenticateInBrowser(APP_VERSION, onUrl, new AbortController().signal).catch(e => e);
      await advanceUntilUrl(onUrl);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      expect(requestMock.mock.calls.some(([r]) => r.method === 'DELETE' && r.url.endsWith('/auth/v4'))).toBe(true);
      expect(String(result)).not.toContain('dummy-access');
      expect(String(result)).not.toContain(KEY_PASSWORD);
    }
  );

  it('cancels waiting, invalidates the selector, and does not poll again', async () => {
    const onUrl = setupRequests();
    const controller = new AbortController();
    const outcome = authenticateInBrowser(APP_VERSION, onUrl, controller.signal).catch(e => e);
    await advanceUntilUrl(onUrl);
    controller.abort();
    expect((await outcome).reason).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestMock.mock.calls.filter(([r]) => r.method === 'GET')).toHaveLength(1);
    expect(requestMock.mock.calls.at(-1)[0]).toMatchObject({ method: 'DELETE' });
  });

  it('revokes a session that arrives after cancellation of an in-flight poll', async () => {
    const onUrl = setupRequests();
    let resolvePoll: (value: unknown) => void = () => {};
    const pendingPoll = new Promise(resolve => {
      resolvePoll = resolve;
    });
    const normal = requestMock.getMockImplementation();
    if (!normal) {
      throw new Error('Expected the request fixture');
    }
    requestMock.mockImplementation(request =>
      request.method === 'GET' && request.url.endsWith(`/${SELECTOR}`) ? pendingPoll : normal(request)
    );
    const controller = new AbortController();
    const outcome = authenticateInBrowser(APP_VERSION, onUrl, controller.signal).catch(e => e);
    await advanceUntilUrl(onUrl);
    await vi.advanceTimersByTimeAsync(5000);
    controller.abort();
    expect((await outcome).reason).toBe('cancelled');
    resolvePoll({ status: 200, json: forkCredentials });
    await vi.waitFor(() =>
      expect(requestMock.mock.calls.some(([r]) => r.method === 'DELETE' && r.url.endsWith('/auth/v4'))).toBe(true)
    );
    expect(requestMock.mock.calls.some(([r]) => r.url.endsWith('/core/v4/users'))).toBe(false);
  });

  it('expires pending verification after ten minutes', async () => {
    const onUrl = setupRequests({ pending: 1000 });
    const outcome = authenticateInBrowser(APP_VERSION, onUrl, new AbortController().signal).catch(e => e);
    await advanceUntilUrl(onUrl);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 5000);
    expect((await outcome).reason).toBe('timeout');
    expect(requestMock.mock.calls.filter(([r]) => r.method === 'GET').length).toBeLessThanOrEqual(122);
  });

  it('does not open a browser link if initialization fails', async () => {
    requestMock.mockResolvedValue({ status: 403, json: { Error: 'private raw text' } });
    const onUrl = vi.fn();
    await expect(authenticateInBrowser(APP_VERSION, onUrl, new AbortController().signal)).rejects.toThrow(
      'Start browser sign-in: HTTP 403'
    );
    expect(onUrl).not.toHaveBeenCalled();
  });
});
