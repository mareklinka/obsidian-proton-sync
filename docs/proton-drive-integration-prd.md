# PRD: Proton Drive Integration Setup Module

## 1) Overview

This PRD defines a **self-contained Proton integration module** for the Obsidian plugin.

The module must:
- encapsulate Proton auth/session/bootstrap logic in its own folder,
- expose a minimal public API,
- keep most implementation details private/internal,
- support both **login** and **session-restore** flows,
- let callers obtain a **working `ProtonApiClient` instance** after successful bootstrap,
- use dependency injection for external services (storage, secrets, logging, HTTP/env hooks),
- provide traceable logs with strict sensitive-data redaction.

This PRD is intended as the blueprint for refactoring existing Proton code into a maintainable architecture.

---

## 2) Goals

1. Encapsulate Proton logic into a dedicated module folder (reusable, composable, testable).
2. Keep only essential API public; keep everything else internal/private.
3. Provide one orchestrator entrypoint that supports:
   - sign-in bootstrap,
   - restore-from-session bootstrap.
4. Ensure callers can quickly get a valid `ProtonApiClient` after either flow.
5. Enforce security best practices (no token/password logging, secret handling boundaries).
6. Make behavior deterministic and highly testable with mocked dependencies.

---

## 3) Non-goals

- Refactoring sync queue behavior in this phase.
- UI redesign of login modal.
- Rewriting Proton Drive SDK internals.
- Persisting app-level settings directly inside Proton module.

---

## 4) Current pain points (from existing code)

1. Proton concerns are spread across multiple files without a strict boundary.
2. Plugin class (`main.ts`) coordinates many auth/session concerns directly.
3. Secrets/session lifecycle concerns are intertwined with UI and plugin settings.
4. Logging is present but lacks a formal sensitive-data policy contract.

---

## 5) Target architecture

## 5.1 Folder structure

```text
proton-integration/
  public/
    index.ts                 # minimal public exports only
    types.ts                 # public contracts only
  application/
    ProtonIntegrationService.ts    # orchestrator/facade
    SessionLifecycle.ts            # refresh/expiry policies
    LoginFlow.ts                   # auth bootstrap use-case
    RestoreFlow.ts                 # restore bootstrap use-case
  infrastructure/
    ProtonApiClientFactory.ts      # creates configured ProtonApiClient
    ProtonDriveClientFactory.ts    # optional extension point
    ProtonAuthGateway.ts           # wraps existing ProtonAuthService behavior
    storage/
      SessionRepository.ts         # adapter over injected session store
      SecretRepository.ts          # adapter over injected secret store
  domain/
    models.ts                      # session/auth models (internal)
    errors.ts                      # typed domain errors
    redaction.ts                   # sensitive-field redaction utilities
```

> Public surface must be exported only from `proton-integration/public/index.ts`.

## 5.2 Visibility rules

- `public/*`: stable, small API.
- `application/*`: internal orchestration.
- `infrastructure/*`: internal integration adapters.
- `domain/*`: internal models/helpers.

No direct imports to internal modules from outside `proton-integration`.

---

## 6) Public API contract

```ts
// proton-integration/public/types.ts
export interface ProtonCredentials {
  email: string;
  password: string;
  mailboxPassword?: string;
  twoFactorCode?: string;
}

export interface ProtonBootstrapOptions {
  forceRefreshOnRestore?: boolean; // default true
}

export interface ProtonIntegrationStatus {
  state: "disconnected" | "pending" | "connected" | "error";
  accountEmail?: string;
  expiresAt?: string;
  lastError?: string;
}

export interface ProtonIntegrationHandle {
  getStatus(): ProtonIntegrationStatus;
  getApiClient(): ProtonApiClient | null;
  getSession(): ProtonSession | null;

  signIn(credentials: ProtonCredentials): Promise<void>;
  restoreFromStorage(options?: ProtonBootstrapOptions): Promise<boolean>;
  refreshIfNeeded(force?: boolean): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface ProtonIntegrationDeps {
  appVersion: string;
  logger: ProtonLogger;
  sessionStore: SessionStore;
  secretStore: SecretStore;
  authGateway: ProtonAuthGateway;
  apiClientFactory?: ProtonApiClientFactory;
  clock?: { now(): number };
}

export type CreateProtonIntegration = (
  deps: ProtonIntegrationDeps
) => ProtonIntegrationHandle;
```

```ts
// proton-integration/public/index.ts
export { createProtonIntegration } from "../application/ProtonIntegrationService";
export type {
  ProtonCredentials,
  ProtonBootstrapOptions,
  ProtonIntegrationStatus,
  ProtonIntegrationHandle,
  ProtonIntegrationDeps,
  CreateProtonIntegration,
} from "./types";
```

### Public API requirements

- `signIn` and `restoreFromStorage` must each transition into a state where `getApiClient()` is usable on success.
- `getApiClient()` returns `null` when unavailable; callers never access session internals directly.
- No public method should expose raw secrets/tokens in return payloads.

---

## 7) Dependency Injection contracts

These are mandatory abstraction points.

```ts
export interface SessionStore {
  load(): Promise<ProtonSession | null>;
  save(session: ProtonSession): Promise<void>;
  clear(): Promise<void>;
}

export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  clear(key: string): void;
}

export interface ProtonLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>, error?: unknown): void;
  error(message: string, meta?: Record<string, unknown>, error?: unknown): void;
}

export interface ProtonAuthGateway {
  signIn(credentials: ProtonCredentials): Promise<{
    session: ProtonSession;
    passwordMode: number | null;
  }>;
  refresh(session: ProtonSession): Promise<ProtonSession>;
}

export type ProtonApiClientFactory = (args: {
  getSession: () => ProtonSession | null;
  appVersion: string;
  logger: ProtonLogger;
}) => ProtonApiClient;
```

---

## 8) Core flows

## 8.1 Login flow

1. Set status = `pending`.
2. Call `authGateway.signIn(credentials)`.
3. Persist returned session via `sessionStore.save`.
4. If mailbox password mode requires key derivation:
   - derive salted passphrases via internal use-case,
   - persist into `secretStore`.
5. Initialize `ProtonApiClient` via factory.
6. Set status = `connected`.

Failure path:
- Set status = `error`.
- Keep redacted error message only.
- No partial secret writes unless atomic write succeeded.

## 8.2 Restore flow

1. Load session via `sessionStore.load`.
2. If absent: status remains `disconnected`, return `false`.
3. Optionally refresh session (`forceRefreshOnRestore` default true).
4. Save refreshed session if changed.
5. Initialize `ProtonApiClient`.
6. Set status = `connected`, return `true`.

Failure path:
- clear invalid session,
- status = `error` or `disconnected` depending on error class,
- return `false`.

## 8.3 Disconnect flow

1. Clear session store.
2. Clear Proton-related secret keys.
3. Drop in-memory session and API client.
4. status = `disconnected`.

---

## 9) Security requirements (MUST)

1. **Never log**:
   - passwords,
   - mailbox passwords,
   - 2FA codes,
   - access/refresh tokens,
   - SRP proofs,
   - secret-store payloads.
2. Redact potentially sensitive fields before logging metadata.
3. Centralize redaction utility in one internal module (`domain/redaction.ts`).
4. Use least-privilege API scopes where possible.
5. Treat session and secrets persistence as separate concerns.
6. Ensure all errors surfaced to UI are sanitized.

### Logging policy examples

Allowed:
- masked email (`m***a@domain.com`),
- status transitions,
- refresh timing,
- endpoint path class (`/auth/v4/...`) without payload content.

Disallowed:
- raw response body if it can contain token/session data.

---

## 10) Error model

Define typed internal errors:
- `NoSessionError`
- `AuthFailedError`
- `TwoFactorRequiredError`
- `SessionRefreshError`
- `SecretStorageError`
- `BootstrapStateError`

Public API should map internal errors to safe status + sanitized message.

---

## 11) State model

Internal finite states:
- `disconnected`
- `pending`
- `connected`
- `error`

State transitions must be explicit and logged with redacted metadata.

---

## 12) Observability and traceability

- Every public operation logs start/end/failure with correlation id.
- Correlation id should be operation-scoped (e.g., login request id).
- Log metadata should be structured and redact-first.

---

## 13) Testability requirements

The module must be testable without Obsidian runtime.

## 13.1 Unit test target

- 90%+ line/branch coverage recommended for proton-integration application layer.

## 13.2 Required test cases

1. login success initializes `ProtonApiClient` and status `connected`.
2. login failure sets error state and does not expose secrets.
3. restore with valid session returns `true` and initializes client.
4. restore with missing session returns `false` and remains disconnected.
5. restore refresh failure clears/invalidates session as specified.
6. disconnect clears both session and secrets.
7. `getApiClient()` null when disconnected/error.
8. logging redaction strips sensitive keys from metadata.
9. status transitions are deterministic.
10. DI failures (storage unavailable) produce sanitized errors.

---

## 14) Migration mapping (existing files -> target module)

Likely migration candidates:
- `proton-auth.ts` -> `infrastructure/ProtonAuthGateway.ts`
- `proton-api.ts` -> remains core API client, instantiated via `ProtonApiClientFactory`
- `proton-drive-client.ts` -> optional infra factory retained but hidden behind integration boundary
- `session-store.ts`, `key-passphrase-store.ts` -> adapters implementing `SessionStore` / `SecretStore`
- relevant logic in `main.ts` (sign-in/restore/refresh) -> moved into integration service

`main.ts` should only call public integration handle methods and react to status.

---

## 15) Suggested implementation phases

Phase 1:
- create folder structure,
- define public contracts,
- implement `createProtonIntegration` orchestrator,
- wire login + restore + disconnect,
- keep existing behavior parity.

Phase 2:
- migrate refresh loop policy into module,
- migrate key salt/passphrase derivation orchestration.

Phase 3:
- tighten redaction and typed errors,
- remove direct Proton orchestration from plugin root.

---

## 16) Example usage from caller

```ts
import { createProtonIntegration } from "./proton-integration/public";

const proton = createProtonIntegration({
  appVersion: this.manifest.version,
  logger,
  sessionStore,
  secretStore,
  authGateway,
});

const restored = await proton.restoreFromStorage({ forceRefreshOnRestore: true });

if (!restored) {
  await proton.signIn({
    email,
    password,
    mailboxPassword,
    twoFactorCode,
  });
}

const api = proton.getApiClient();
if (!api) {
  throw new Error("Proton API client unavailable after bootstrap");
}

const me = await api.getJson("/core/v4/users");
```

---

## 17) Open decisions (non-blocking but recommended)

1. Should refresh policy live fully inside integration service, or exposed as explicit caller-triggered method only?
2. Should integration expose status as observable (`status$`) in v1?
3. Should key-passphrase derivation be part of login flow by default, or opt-in strategy?

---

## 18) Definition of done

Implementation is done when:
- Proton integration code is encapsulated in dedicated folder,
- public API surface is minimal and documented,
- login + restore flows initialize usable `ProtonApiClient`,
- external dependencies are DI-based abstractions,
- logs are structured and sanitized,
- tests pass and cover critical flow/security paths,
- caller (`main.ts`) orchestration can be reduced to simple API calls.
