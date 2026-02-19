import { describe, expect, it, vi } from 'vitest';

import { createProtonDriveFactory } from './ProtonDriveFactory';

describe('createProtonDriveFactory', () => {
  it('creates client from auth context', () => {
    const driveClientFactory = vi.fn(() => ({ client: true }) as any);
    const factory = createProtonDriveFactory({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      driveClientFactory
    });

    const context = {
      appVersion: '1.0.0',
      session: {
        uid: 'uid-1',
        userId: 'user-1',
        accessToken: 'a',
        refreshToken: 'r',
        scope: 'full locked',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        lastRefreshAt: new Date().toISOString()
      },
      getSession: vi.fn(() => null),
      saltedPassphrases: {}
    };

    const client = factory.createFromAuthContext(context);
    expect(client).toEqual({ client: true });
    expect(driveClientFactory).toHaveBeenCalledTimes(1);
  });
});
