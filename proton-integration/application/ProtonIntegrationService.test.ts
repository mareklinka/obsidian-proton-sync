import { describe, expect, it, vi } from "vitest";

import { createProtonIntegration } from "../public";
import { redactMeta } from "../domain/redaction";
import type {
  ProtonIntegrationDeps,
  ProtonLogger,
  SecretStore,
  SessionStore,
} from "../public/types";
import type { ProtonSession } from "../../session-store";

type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
  error?: unknown;
};

function buildSession(overrides?: Partial<ProtonSession>): ProtonSession {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const expires = new Date(now.getTime() + 30 * 60 * 1000);

  return {
    uid: "uid-1",
    userId: "user-1",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    scope: "full locked",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    lastRefreshAt: now.toISOString(),
    ...overrides,
  };
}

function buildLogger(entries: LogEntry[]): ProtonLogger {
  return {
    debug: (message, meta) => entries.push({ level: "debug", message, meta }),
    info: (message, meta) => entries.push({ level: "info", message, meta }),
    warn: (message, meta, error) =>
      entries.push({ level: "warn", message, meta, error }),
    error: (message, meta, error) =>
      entries.push({ level: "error", message, meta, error }),
  };
}

function buildStores(initialSession: ProtonSession | null = null): {
  sessionStore: SessionStore;
  secretStore: SecretStore;
  sessionRef: { value: ProtonSession | null };
  secretMap: Map<string, string>;
} {
  const sessionRef = { value: initialSession };
  const secretMap = new Map<string, string>();

  return {
    sessionRef,
    secretMap,
    sessionStore: {
      load: vi.fn(async () => sessionRef.value),
      save: vi.fn(async (session: ProtonSession) => {
        sessionRef.value = session;
      }),
      clear: vi.fn(async () => {
        sessionRef.value = null;
      }),
    },
    secretStore: {
      get: (key: string) => secretMap.get(key) ?? null,
      set: (key: string, value: string) => {
        secretMap.set(key, value);
      },
      clear: (key: string) => {
        secretMap.delete(key);
      },
    },
  };
}

function buildDeps(overrides?: Partial<ProtonIntegrationDeps>): {
  deps: ProtonIntegrationDeps;
  logs: LogEntry[];
  stores: ReturnType<typeof buildStores>;
} {
  const logs: LogEntry[] = [];
  const stores = buildStores();
  const authSession = buildSession();

  const deps: ProtonIntegrationDeps = {
    appVersion: "1.0.0",
    logger: buildLogger(logs),
    sessionStore: stores.sessionStore,
    secretStore: stores.secretStore,
    authGateway: {
      signIn: vi.fn(async () => ({ session: authSession, passwordMode: null })),
      refresh: vi.fn(async (session: ProtonSession) => ({
        ...session,
        accessToken: "new-access",
        refreshToken: "new-refresh",
        updatedAt: new Date("2026-01-01T00:20:00.000Z").toISOString(),
        lastRefreshAt: new Date("2026-01-01T00:20:00.000Z").toISOString(),
        expiresAt: new Date("2026-01-01T01:20:00.000Z").toISOString(),
      })),
    },
    apiClientFactory: ({ getSession }) => ({
      getJson: vi.fn(async () => {
        if (!getSession()) {
          throw new Error("No Proton session available for API request.");
        }
        return { KeySalts: [] };
      }),
    } as any),
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z").getTime() },
    ...overrides,
  };

  return { deps, logs, stores };
}

describe("createProtonIntegration", () => {
  it("login success initializes api client and connected status", async () => {
    const { deps } = buildDeps();
    const integration = createProtonIntegration(deps);

    await integration.signIn({
      email: "alice@example.com",
      password: "pass123",
      twoFactorCode: "123456",
    });

    expect(integration.getStatus().state).toBe("connected");
    expect(integration.getApiClient()).not.toBeNull();
    expect(integration.getSession()).not.toBeNull();
  });

  it("login failure sets error state and does not expose secrets", async () => {
    const { deps } = buildDeps({
      authGateway: {
        signIn: vi.fn(async () => {
          throw new Error("invalid token or password");
        }),
        refresh: vi.fn(),
      },
    });

    const integration = createProtonIntegration(deps);

    await expect(
      integration.signIn({
        email: "alice@example.com",
        password: "super-secret",
      }),
    ).rejects.toThrow();

    const status = integration.getStatus();
    expect(status.state).toBe("error");
    expect(status.lastError).toBe("Operation failed due to a secure authentication error.");
  });

  it("restore with valid session returns true and initializes client", async () => {
    const initial = buildSession();
    const stores = buildStores(initial);
    const { deps } = buildDeps({
      sessionStore: stores.sessionStore,
      secretStore: stores.secretStore,
    });

    const integration = createProtonIntegration(deps);
    const restored = await integration.restoreFromStorage({
      forceRefreshOnRestore: false,
    });

    expect(restored).toBe(true);
    expect(integration.getStatus().state).toBe("connected");
    expect(integration.getApiClient()).not.toBeNull();
  });

  it("restore with missing session returns false and stays disconnected", async () => {
    const { deps } = buildDeps();
    const integration = createProtonIntegration(deps);

    const restored = await integration.restoreFromStorage({
      forceRefreshOnRestore: true,
    });

    expect(restored).toBe(false);
    expect(integration.getStatus().state).toBe("disconnected");
    expect(integration.getApiClient()).toBeNull();
  });

  it("restore refresh failure invalidates stored session", async () => {
    const stores = buildStores(buildSession());
    const { deps } = buildDeps({
      sessionStore: stores.sessionStore,
      secretStore: stores.secretStore,
      authGateway: {
        signIn: vi.fn(),
        refresh: vi.fn(async () => {
          throw new Error("refresh failed");
        }),
      },
    });

    const integration = createProtonIntegration(deps);
    const restored = await integration.restoreFromStorage({
      forceRefreshOnRestore: true,
    });

    expect(restored).toBe(false);
    expect(integration.getStatus().state).toBe("disconnected");
    expect(stores.sessionRef.value).toBeNull();
  });

  it("disconnect clears session and proton secrets", async () => {
    const { deps, stores } = buildDeps();
    const integration = createProtonIntegration(deps);

    await integration.signIn({
      email: "alice@example.com",
      password: "pass123",
    });

    stores.secretMap.set("proton-drive-sync-key-passphrase", "value");
    stores.secretMap.set("proton-drive-sync-salted-passphrases", "value");

    await integration.disconnect();

    expect(integration.getStatus().state).toBe("disconnected");
    expect(integration.getSession()).toBeNull();
    expect(stores.secretMap.has("proton-drive-sync-key-passphrase")).toBe(false);
    expect(stores.secretMap.has("proton-drive-sync-salted-passphrases")).toBe(false);
  });

  it("getApiClient is null when disconnected and after error", async () => {
    const { deps } = buildDeps({
      authGateway: {
        signIn: vi.fn(async () => {
          throw new Error("auth token bad");
        }),
        refresh: vi.fn(),
      },
    });
    const integration = createProtonIntegration(deps);

    expect(integration.getApiClient()).toBeNull();

    await expect(
      integration.signIn({ email: "a@b.com", password: "pwd" }),
    ).rejects.toThrow();

    expect(integration.getApiClient()).toBeNull();
  });

  it("redaction strips sensitive keys from metadata", () => {
    const redacted = redactMeta({
      email: "alice@example.com",
      password: "secret",
      accessToken: "token",
      nested: {
        refreshToken: "refresh",
      },
    });

    expect(redacted?.email).toBe("a***e@example.com");
    expect(redacted?.password).toBe("[REDACTED]");
    expect(redacted?.accessToken).toBe("[REDACTED]");
    expect((redacted?.nested as Record<string, unknown>).refreshToken).toBe(
      "[REDACTED]",
    );
  });

  it("status transitions are deterministic", async () => {
    const { deps } = buildDeps();
    const integration = createProtonIntegration(deps);

    expect(integration.getStatus().state).toBe("disconnected");
    await integration.signIn({ email: "alice@example.com", password: "x" });
    expect(integration.getStatus().state).toBe("connected");
    await integration.disconnect();
    expect(integration.getStatus().state).toBe("disconnected");
  });

  it("DI storage failure produces sanitized error", async () => {
    const failingStore: SessionStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {
        throw new Error("failed writing token to store");
      }),
      clear: vi.fn(async () => undefined),
    };

    const { deps } = buildDeps({ sessionStore: failingStore });
    const integration = createProtonIntegration(deps);

    await expect(
      integration.signIn({ email: "alice@example.com", password: "x" }),
    ).rejects.toThrow("Operation failed due to a secure authentication error.");

    expect(integration.getStatus().lastError).toBe(
      "Operation failed due to a secure authentication error.",
    );
  });
});
