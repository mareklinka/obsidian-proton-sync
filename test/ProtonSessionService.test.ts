import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtonSessionService } from '../proton/auth/ProtonSessionService';
import { buildSrpProofs, computeKeyPasswordFromSalt } from '../proton/auth/ProtonSrp';
import { getJson, postJson } from '../proton/ProtonApiClient';
import { requestUrl } from 'obsidian';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn()
}));

vi.mock('../proton/ProtonApiClient', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  deleteJson: vi.fn()
}));

vi.mock('../proton/auth/ProtonSrp', () => ({
  buildSrpProofs: vi.fn(async () => ({
    clientProof: new Uint8Array([1, 2, 3]),
    clientEphemeral: new Uint8Array([4, 5, 6]),
    expectedServerProof: new Uint8Array([9, 9, 9])
  })),
  computeKeyPasswordFromSalt: vi.fn((password: string, salt: string) => `${password}:${salt}`),
  decodeBase64: vi.fn(() => new Uint8Array([9, 9, 9])),
  encodeBase64: vi.fn(() => 'encoded')
}));

describe('ProtonSessionService signIn delegates', () => {
  const requestUrlMock = vi.mocked(requestUrl);
  const getJsonMock = vi.mocked(getJson);
  const postJsonMock = vi.mocked(postJson);
  const buildSrpProofsMock = vi.mocked(buildSrpProofs);
  const computeKeyPasswordFromSaltMock = vi.mocked(computeKeyPasswordFromSalt);

  let service: ProtonSessionService;

  beforeEach(() => {
    const secretData = new Map<string, string>();
    service = new ProtonSessionService(
      {
        get: (key: string) => secretData.get(key) ?? null,
        set: (key: string, value: string) => {
          secretData.set(key, value);
        },
        clear: () => {
          secretData.clear();
        }
      },
      'test-version'
    );

    getJsonMock.mockResolvedValue({
      KeySalts: [{ ID: 'key-1', KeySalt: 'salt-1' }]
    });

    requestUrlMock.mockImplementation(((request: { url?: string }) => {
      const url = (request as { url: string }).url;

      if (url.endsWith('/auth/v4/info')) {
        return toRequestUrlResponse(200, {
          AuthInfo: {
            SRPSession: 'srp-session'
          }
        });
      }

      if (url.endsWith('/auth/v4')) {
        return toRequestUrlResponse(200, createAuthResponse());
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    }) as never);

    postJsonMock.mockResolvedValue({});
  });

  afterEach(() => {
    service.dispose();
    vi.clearAllMocks();
  });

  it('requests and submits a 2FA code when required', async () => {
    requestUrlMock.mockImplementation(((request: { url?: string }) => {
      const url = (request as { url: string }).url;

      if (url.endsWith('/auth/v4')) {
        return toRequestUrlResponse(
          200,
          createAuthResponse({
            '2FA': {
              Enabled: 1,
              TOTP: 1
            }
          })
        );
      }

      if (url.endsWith('/auth/v4/info')) {
        return toRequestUrlResponse(200, {
          AuthInfo: {
            SRPSession: 'srp-session'
          }
        });
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    }) as never);

    const requestTwoFactorCode = vi.fn(async () => '123456');

    await service.signIn('test@example.com', 'login-password', {
      requestTwoFactorCode,
      requestMailboxPassword: async () => undefined,
      requestCaptchaChallenge: async () => ({
        token: 'token',
        verificationMethod: 'captcha'
      })
    });

    expect(requestTwoFactorCode).toHaveBeenCalledTimes(1);
    expect(postJsonMock).toHaveBeenCalledWith(
      '/auth/v4/2fa',
      { accessToken: 'access-token', uid: 'uid-123' },
      'test-version',
      { TwoFactorCode: '123456' }
    );
  });

  it('fails when 2FA is required and prompt is canceled', async () => {
    requestUrlMock.mockImplementation(((request: { url?: string }) => {
      const url = (request as { url: string }).url;

      if (url.endsWith('/auth/v4')) {
        return toRequestUrlResponse(
          200,
          createAuthResponse({
            '2FA': {
              Enabled: 1,
              TOTP: 1
            }
          })
        );
      }

      if (url.endsWith('/auth/v4/info')) {
        return toRequestUrlResponse(200, {
          AuthInfo: {
            SRPSession: 'srp-session'
          }
        });
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    }) as never);

    await expect(
      service.signIn('test@example.com', 'login-password', {
        requestTwoFactorCode: async () => undefined,
        requestMailboxPassword: async () => undefined,
        requestCaptchaChallenge: async () => ({
          token: 'token',
          verificationMethod: 'captcha'
        })
      })
    ).rejects.toThrow('Two-factor authentication code required.');
  });

  it('requests mailbox password when password mode requires it', async () => {
    requestUrlMock.mockImplementation(((request: { url?: string }) => {
      const url = (request as { url: string }).url;

      if (url.endsWith('/auth/v4')) {
        return toRequestUrlResponse(
          200,
          createAuthResponse({
            PasswordMode: 2
          })
        );
      }

      if (url.endsWith('/auth/v4/info')) {
        return toRequestUrlResponse(200, {
          AuthInfo: {
            SRPSession: 'srp-session'
          }
        });
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    }) as never);

    const requestMailboxPassword = vi.fn(async () => 'mailbox-password');

    await service.signIn('test@example.com', 'login-password', {
      requestTwoFactorCode: async () => undefined,
      requestMailboxPassword,
      requestCaptchaChallenge: async () => ({
        token: 'token',
        verificationMethod: 'captcha'
      })
    });

    expect(requestMailboxPassword).toHaveBeenCalledTimes(1);
    expect(computeKeyPasswordFromSaltMock).toHaveBeenCalledWith('mailbox-password', 'salt-1');
  });

  it('fails when mailbox password prompt is canceled', async () => {
    requestUrlMock.mockImplementation(((request: { url?: string }) => {
      const url = (request as { url: string }).url;

      if (url.endsWith('/auth/v4')) {
        return toRequestUrlResponse(
          200,
          createAuthResponse({
            PasswordMode: 2
          })
        );
      }

      if (url.endsWith('/auth/v4/info')) {
        return toRequestUrlResponse(200, {
          AuthInfo: {
            SRPSession: 'srp-session'
          }
        });
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    }) as never);

    await expect(
      service.signIn('test@example.com', 'login-password', {
        requestTwoFactorCode: async () => undefined,
        requestMailboxPassword: async () => undefined,
        requestCaptchaChallenge: async () => ({
          token: 'token',
          verificationMethod: 'captcha'
        })
      })
    ).rejects.toThrow('Mailbox password required.');
  });

  it('requests CAPTCHA challenge and retries authentication', async () => {
    const captchaUrl = 'https://account.proton.me/captcha/challenge';

    requestUrlMock.mockImplementation(((request: { url?: string }) => {
      const url = (request as { url: string }).url;

      if (url.endsWith('/auth/v4')) {
        const authAttempts = requestUrlMock.mock.calls.filter(([call]) =>
          ((call as { url?: string }).url ?? '').endsWith('/auth/v4')
        ).length;

        if (authAttempts === 1) {
          return toRequestUrlResponse(422, {
            Code: 9001,
            Error: 'Human verification required',
            Details: {
              WebUrl: captchaUrl
            }
          });
        }

        return toRequestUrlResponse(200, createAuthResponse());
      }

      if (url.endsWith('/auth/v4/info')) {
        return toRequestUrlResponse(200, {
          AuthInfo: {
            SRPSession: 'srp-session'
          }
        });
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    }) as never);

    const requestCaptchaChallenge = vi.fn(async (_url: string) => ({
      token: 'token',
      verificationMethod: 'captcha'
    }));

    await service.signIn('test@example.com', 'login-password', {
      requestTwoFactorCode: async () => undefined,
      requestMailboxPassword: async () => undefined,
      requestCaptchaChallenge
    });

    expect(requestCaptchaChallenge).toHaveBeenCalledWith(captchaUrl);
    expect(
      requestUrlMock.mock.calls.filter(([request]) => ((request as { url?: string }).url ?? '').endsWith('/auth/v4'))
    ).toHaveLength(2);
  });

  it('does not call delegates when not required', async () => {
    const requestTwoFactorCode = vi.fn(async () => '123456');
    const requestMailboxPassword = vi.fn(async () => 'mailbox-password');

    await service.signIn('test@example.com', 'login-password', {
      requestTwoFactorCode,
      requestMailboxPassword,
      requestCaptchaChallenge: async () => ({
        token: 'token',
        verificationMethod: 'captcha'
      })
    });

    expect(requestTwoFactorCode).not.toHaveBeenCalled();
    expect(requestMailboxPassword).not.toHaveBeenCalled();
    expect(buildSrpProofsMock).toHaveBeenCalledTimes(1);
    expect(computeKeyPasswordFromSaltMock).toHaveBeenCalledWith('login-password', 'salt-1');
  });
});

function createAuthResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    UserID: 'user-id',
    UID: 'uid-123',
    ExpiresIn: 3600,
    AccessToken: 'access-token',
    RefreshToken: 'refresh-token',
    ServerProof: 'server-proof',
    Scope: 'full locked',
    PasswordMode: 1,
    ...overrides
  };
}

function toRequestUrlResponse(status: number, json: unknown): ReturnType<typeof requestUrl> {
  return Promise.resolve({
    status,
    json,
    text: JSON.stringify(json),
    arrayBuffer: new ArrayBuffer(0)
  }) as unknown as ReturnType<typeof requestUrl>;
}
