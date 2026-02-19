import { describe, expect, it, vi } from 'vitest';

import type { ProtonSession } from '../../../session-store';
import { createProtonAuthFacade } from './ProtonAuthFacade';
import type { ProtonApiClientFactory } from '../../domain/contracts';

function buildSession(overrides?: Partial<ProtonSession>): ProtonSession {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const expires = new Date(now.getTime() + 30 * 60 * 1000);

  return {
    uid: 'uid-1',
    userId: 'user-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scope: 'full locked',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    lastRefreshAt: now.toISOString(),
    ...overrides
  };
}

describe('createProtonAuthFacade', () => {
  it('connect returns context on success', async () => {
    const stored = { value: null as ProtonSession | null };
    const secretMap = new Map<string, string>();

    const apiClientFactory: ProtonApiClientFactory = () =>
      ({
        getJson: vi.fn(async () => ({ KeySalts: [] }))
      }) as any;

    const auth = createProtonAuthFacade({
      appVersion: '1.0.0',
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      sessionStore: {
        load: vi.fn(async () => stored.value),
        save: vi.fn(async session => {
          stored.value = session;
        }),
        clear: vi.fn(async () => {
          stored.value = null;
        })
      },
      secretStore: {
        get: key => secretMap.get(key) ?? null,
        set: (key, value) => {
          secretMap.set(key, value);
        },
        clear: key => {
          secretMap.delete(key);
        }
      },
      authGateway: {
        signIn: vi.fn(async () => ({ session: buildSession(), passwordMode: null })),
        refresh: vi.fn(async session => session)
      },
      apiClientFactory
    });

    const result = await auth.connect({
      email: 'alice@example.com',
      password: 'top-secret'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.session.uid).toBe('uid-1');
      expect(typeof result.context.saltedPassphrases).toBe('object');
    }
  });

  it('reconnect returns no-session when no stored session exists', async () => {
    const auth = createProtonAuthFacade({
      appVersion: '1.0.0',
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      sessionStore: {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined)
      },
      secretStore: {
        get: vi.fn(() => null),
        set: vi.fn(),
        clear: vi.fn()
      },
      authGateway: {
        signIn: vi.fn(),
        refresh: vi.fn()
      }
    });

    const result = await auth.reconnect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-session');
    }
  });
});
