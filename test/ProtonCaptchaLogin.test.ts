/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { Effect, Either, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  platform: { isMobile: false },
  persist: vi.fn(),
  cancelLock: vi.fn()
}));

vi.mock('obsidian', () => ({ requestUrl: mocks.request, Platform: mocks.platform }));
vi.mock('../services/EncryptedSecretStore', () => ({
  POST_SYNC_MEMORY_CLEAR_DELAY_MS: 300_000,
  getEncryptedSecretStore: () => ({
    persistSessionData: mocks.persist,
    cancelScheduledLock: mocks.cancelLock
  })
}));
vi.mock('../services/ObsidianSettingsStore', () => ({ getObsidianSettingsStore: () => ({ set: vi.fn() }) }));
vi.mock('../proton/auth/ProtonSrp', () => ({
  buildSrpProofs: async () => ({
    clientProof: new Uint8Array([1]),
    clientEphemeral: new Uint8Array([2]),
    expectedServerProof: new Uint8Array([3])
  }),
  encodeBase64: (value: Uint8Array) => Buffer.from(value).toString('base64'),
  decodeBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64')),
  computeKeyPasswordFromSalt: () => 'test-salted-password'
}));

const challengeUrl = 'https://verify.proton.me/?methods=captcha&token=S-test-challenge';
const challenge = {
  status: 422,
  json: { Code: 9001, Details: { WebUrl: challengeUrl } }
};
const authSuccess = {
  status: 200,
  json: {
    UID: 'test-uid',
    UserID: 'test-user',
    AccessToken: 'test-access',
    RefreshToken: 'test-refresh',
    ExpiresIn: 3600,
    Scope: 'full locked',
    ServerProof: 'Aw==',
    '2FA': { Enabled: 1 }
  }
};

function delegates() {
  return {
    requestCaptchaChallenge: vi.fn(() =>
      Effect.succeed(
        Option.some({
          token: 'S-test-challenge',
          verificationMethod: 'captcha'
        })
      )
    ),
    requestTwoFactorCode: vi.fn(() => Effect.succeed(Option.some('123456'))),
    requestMailboxPassword: vi.fn(() => Effect.succeed(Option.none<string>())),
    requestMasterPassword: vi.fn(() => Effect.succeed(Option.some('dummy-master-password')))
  };
}

describe('CAPTCHA login recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.request.mockReset();
    mocks.persist.mockReturnValue(Effect.void);
    mocks.platform.isMobile = false;
  });

  afterEach(() => vi.useRealTimers());

  it.each([false, true])('continues from external verification to 2FA (mobile=%s)', async mobile => {
    mocks.platform.isMobile = mobile;
    mocks.request
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce(authSuccess)
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ status: 200, json: { KeySalts: [] } });
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const service = initProtonSessionService('test-version');
    const states: Array<string> = [];
    const sub = service.authState$.subscribe(state => states.push(state));
    const prompts = delegates();

    await Effect.runPromise(service.signIn('test@example.test', 'dummy-password', prompts));

    expect(states).toEqual(['disconnected', 'connecting', 'connected']);
    expect(prompts.requestCaptchaChallenge).toHaveBeenCalledExactlyOnceWith(challengeUrl);
    expect(prompts.requestTwoFactorCode).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls[2][0].headers).toMatchObject({
      'x-pm-appversion': 'test-version',
      'x-pm-human-verification-token': 'S-test-challenge',
      'x-pm-human-verification-token-type': 'captcha'
    });
    expect(mocks.request.mock.calls[3][0].url).toContain('/auth/v4/2fa');
    expect(mocks.persist).toHaveBeenCalledOnce();
    sub.unsubscribe();
  });

  it.each([false, true])('stops after rejected verification instead of looping (mobile=%s)', async mobile => {
    mocks.platform.isMobile = mobile;
    mocks.request.mockResolvedValueOnce({ status: 200, json: {} }).mockResolvedValue(challenge);
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const service = initProtonSessionService('test-version');
    const states: Array<string> = [];
    const sub = service.authState$.subscribe(state => states.push(state));
    const prompts = delegates();
    const result = await Effect.runPromise(Effect.either(service.signIn('test@example.test', 'dummy', prompts)));

    expect(Either.isLeft(result) && result.left._tag).toBe('CaptchaRequiredError');
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(prompts.requestCaptchaChallenge).toHaveBeenCalledOnce();
    expect(prompts.requestTwoFactorCode).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('error');
    sub.unsubscribe();
  });

  it('cancels without another authentication request', async () => {
    mocks.request.mockResolvedValueOnce({ status: 200, json: {} }).mockResolvedValue(challenge);
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const prompts = { ...delegates(), requestCaptchaChallenge: vi.fn(() => Effect.succeed(Option.none())) };
    const result = await Effect.runPromise(
      Effect.either(initProtonSessionService('test').signIn('test@example.test', 'dummy', prompts))
    );
    expect(Either.isLeft(result) && result.left._tag).toBe('CaptchaRequiredError');
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('rejects an untrusted challenge URL without handing it to the browser', async () => {
    mocks.request.mockResolvedValueOnce({ status: 200, json: {} }).mockResolvedValue({
      status: 422,
      json: { Code: 9001, Details: { WebUrl: 'https://evil.test/?methods=captcha&token=secret' } }
    });
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const prompts = delegates();
    const result = await Effect.runPromise(
      Effect.either(initProtonSessionService('test').signIn('test@example.test', 'dummy', prompts))
    );
    expect(Either.isLeft(result) && result.left._tag).toBe('CaptchaDataNotProvidedError');
    expect(prompts.requestCaptchaChallenge).not.toHaveBeenCalled();
  });

  it('recovers from a rejected network request', async () => {
    mocks.request.mockRejectedValue(new Error('network unavailable'));
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const service = initProtonSessionService('test');
    const states: Array<string> = [];
    const sub = service.authState$.subscribe(state => states.push(state));
    const result = await Effect.runPromise(Effect.either(service.signIn('test@example.test', 'dummy', delegates())));
    expect(Either.isLeft(result) && result.left._tag).toBe('ProtonApiCommunicationError');
    expect(Either.isLeft(result) && result.left.message).toBe('/auth/v4/info: network request failed');
    expect(states).toEqual(['disconnected', 'connecting', 'error']);
    sub.unsubscribe();
  });

  it.each(['/auth/v4/info', '/auth/v4'])('reports only safe HTTP diagnostics for %s', async path => {
    if (path === '/auth/v4') {
      mocks.request.mockResolvedValueOnce({ status: 200, json: {} });
    }
    mocks.request.mockResolvedValue({
      status: 429,
      json: { Code: 2028, Error: 'private raw response', Details: { token: 'private-token' } }
    });
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const result = await Effect.runPromise(
      Effect.either(initProtonSessionService('test').signIn('test@example.test', 'dummy', delegates()))
    );
    expect(Either.isLeft(result) && result.left.message).toBe(`${path}: HTTP 429, API code 2028`);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('times out a stalled network request instead of staying Connecting forever', async () => {
    vi.useFakeTimers();
    mocks.request.mockReturnValue(new Promise(() => {}));
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const service = initProtonSessionService('test');
    const states: Array<string> = [];
    const sub = service.authState$.subscribe(state => states.push(state));
    const resultPromise = Effect.runPromise(Effect.either(service.signIn('test@example.test', 'dummy', delegates())));
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await resultPromise;
    expect(Either.isLeft(result) && result.left._tag).toBe('ProtonApiCommunicationError');
    expect(states.at(-1)).toBe('error');
    sub.unsubscribe();
  });

  it.each([
    ['', 'Authentication response is missing the server proof'],
    ['BA==', 'Server proof verification failed (proof mismatch)']
  ])('identifies server-proof failures before requesting 2FA', async (proof, message) => {
    mocks.request
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ ...authSuccess, json: { ...authSuccess.json, ServerProof: proof } })
      .mockResolvedValue({ status: 200, json: {} });
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const prompts = delegates();
    const result = await Effect.runPromise(
      Effect.either(initProtonSessionService('test').signIn('test@example.test', 'dummy', prompts))
    );
    expect(Either.isLeft(result) && result.left.message).toBe(message);
    expect(prompts.requestTwoFactorCode).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'identifies post-authentication HTTP failures without raw details (2fa=%s)',
    async twoFactor => {
      mocks.request
        .mockResolvedValueOnce({ status: 200, json: {} })
        .mockResolvedValueOnce({
          ...authSuccess,
          json: { ...authSuccess.json, '2FA': { Enabled: twoFactor ? 1 : 0 } }
        })
        .mockResolvedValueOnce({ status: 403, json: { Error: 'private raw message', Details: { token: 'secret' } } })
        .mockResolvedValue({ status: 200, json: {} });
      const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
      const result = await Effect.runPromise(
        Effect.either(initProtonSessionService('test').signIn('test@example.test', 'dummy', delegates()))
      );
      const route = twoFactor ? '/auth/v4/2fa' : '/core/v4/keys/salts';
      expect(Either.isLeft(result) && result.left.message).toBe(`${route}: HTTP 403`);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(mocks.persist).not.toHaveBeenCalled();
    }
  );

  it('stops security-key-only login before fetching keys and revokes the restricted session', async () => {
    mocks.request
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ ...authSuccess, json: { ...authSuccess.json, '2FA': { Enabled: 2 } } })
      .mockResolvedValue({ status: 200, json: {} });
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const prompts = delegates();
    const result = await Effect.runPromise(
      Effect.either(initProtonSessionService('test').signIn('test@example.test', 'dummy', prompts))
    );
    expect(Either.isLeft(result) && result.left._tag).toBe('UnsupportedTwoFactorMethodError');
    expect(prompts.requestTwoFactorCode).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(mocks.request.mock.calls[2][0]).toMatchObject({ method: 'DELETE' });
    expect(mocks.request.mock.calls.some(([request]) => String(request.url).includes('/keys/salts'))).toBe(false);
  });

  it('still requests an authenticator code when both 2FA methods are enabled', async () => {
    mocks.request
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ ...authSuccess, json: { ...authSuccess.json, '2FA': { Enabled: 3 } } })
      .mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ status: 200, json: { KeySalts: [] } });
    const { initProtonSessionService } = await import('../proton/auth/ProtonSessionService');
    const prompts = delegates();
    await Effect.runPromise(initProtonSessionService('test').signIn('test@example.test', 'dummy', prompts));
    expect(prompts.requestTwoFactorCode).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledOnce();
  });
});
