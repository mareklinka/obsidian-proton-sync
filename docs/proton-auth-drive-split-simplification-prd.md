# PRD: Proton Integration Simplification — Auth/Drive Split

## 1) Overview

This PRD defines a structural simplification of Proton integration with two explicit goals:

1. Make authentication/session logic easier to follow through a minimal API:
   - `connect(credentials)`
   - `reconnect()`
2. Split Proton integration into two clear modules:
   - `auth` (authentication/session/refresh/passphrase handling)
   - `drive` (Drive SDK/client and Drive-specific infrastructure)

The resulting design must be straightforward enough for an AI coding agent to implement reliably with minimal ambiguity.

---

## 2) Problem Statement

Current Proton logic has multiple layered abstractions (`runtime`, `integration service`, flows, factories, status getters), which makes core control flow harder to read and reason about.

Current pain points:

- Authentication success/failure semantics are split across `throw`, `boolean`, and state getters.
- Salted passphrase handling is spread across layers and is not clearly confined to Auth concerns.
- Session refresh lifecycle is surfaced through runtime behavior rather than being an internal Auth responsibility.
- Auth and Drive concerns are interleaved within the same high-level abstraction path.

---

## 3) Goals (MUST)

1. Expose a **minimal Auth API** with two primary operations:
   - `connect`
   - `reconnect`
2. Return a **directly consumable successful result object** that can initialize Proton Drive client without additional auth lookups.
3. Keep salted passphrase handling internal to Auth (derive/load/store via secret store).
4. Keep session refresh as an internal Auth concern.
5. Separate Auth and Drive logic into distinct folders/modules with strict ownership boundaries.
6. Reduce `main.ts` logic to orchestration/wiring only; no low-level auth/session/passphrase mechanics.

---

## 4) Non-goals

- Changing sync queue business behavior.
- Rewriting Proton Drive SDK internals.
- UI redesign of login modal.
- Introducing new external services not already required by current architecture.

---

## 5) High-Level Target Design

## 5.1 Module split

```text
proton-integration/
  auth/
    public/
      index.ts
      types.ts
    application/
      ProtonAuthService.ts
      ConnectUseCase.ts
      ReconnectUseCase.ts
      RefreshCoordinator.ts
    infrastructure/
      ProtonAuthGateway.ts
      SessionStorePort.ts
      SecretStorePort.ts
      PassphraseVault.ts
      ProtonApiClient.ts (if needed by auth use-cases)
    domain/
      models.ts
      errors.ts
      redaction.ts

  drive/
    public/
      index.ts
      types.ts
    application/
      ProtonDriveFactory.ts
    infrastructure/
      ProtonDriveClient.ts
      ProtonAccount.ts
      ProtonOpenPgp.ts
      ProtonObsidianHttpClient.ts
      ProtonDriveClientFactory.ts
    domain/
      models.ts
      errors.ts

  shared/
    contracts.ts
    models.ts
```

> `shared/` is optional but recommended if both Auth and Drive need common contracts (`ProtonSession`, logger contract, etc.).

## 5.2 Ownership boundaries

### Auth owns

- credentials-based login
- session restore and refresh
- session persistence
- salted passphrase derivation/storage/loading
- safe error mapping
- lifecycle hooks for refresh start/stop

### Drive owns

- constructing Drive SDK client
- crypto/account/http adapters required for Drive
- Drive client initialization from auth result context

### Main plugin owns

- DI wiring
- calling `connect`/`reconnect`
- displaying notices/UI
- invoking sync-root/sync-queue workflows once Drive client is ready

---

## 6) Public API Contract (Auth)

## 6.1 Primary interface

```ts
export interface ProtonAuthFacade {
  connect(input: ProtonConnectInput): Promise<ProtonAuthResult>;
  reconnect(): Promise<ProtonAuthResult>;
  disconnect(): Promise<void>;

  startAutoRefresh?(callbacks?: ProtonRefreshCallbacks): void;
  stopAutoRefresh?(): void;
}
```

## 6.2 Input type

```ts
export interface ProtonConnectInput {
  email: string;
  password: string;
  mailboxPassword?: string;
  twoFactorCode?: string;
}
```

## 6.3 Success context (directly usable by Drive init)

```ts
export interface ProtonAuthContext {
  session: ProtonSession;
  saltedPassphrases: Record<string, string>;
  appVersion: string;
}
```

## 6.4 Operation result

```ts
export type ProtonAuthResult =
  | {
      ok: true;
      context: ProtonAuthContext;
      source: 'connect' | 'reconnect';
    }
  | {
      ok: false;
      source: 'connect' | 'reconnect';
      reason:
        | 'invalid-credentials'
        | 'two-factor-required'
        | 'mailbox-password-required'
        | 'no-session'
        | 'session-expired'
        | 'passphrase-missing'
        | 'network-error'
        | 'unknown';
      message: string; // sanitized, UI-safe
    };
```

## 6.5 Refresh callbacks (optional)

```ts
export interface ProtonRefreshCallbacks {
  onRefreshSuccess?: (context: ProtonAuthContext) => void | Promise<void>;
  onRefreshError?: (result: Extract<ProtonAuthResult, { ok: false }>) => void;
}
```

---

## 7) Public API Contract (Drive)

Drive initialization should consume only context + explicit dependencies:

```ts
export interface ProtonDriveFactory {
  createFromAuthContext(context: ProtonAuthContext): ProtonDriveClient;
}
```

This ensures successful Auth output can be passed directly to Drive, per requirement.

---

## 8) Required Behavioral Rules

## 8.1 `connect`

1. Authenticate using credentials.
2. Persist session.
3. Derive salted passphrases (mailbox-password aware).
4. Persist passphrases in secret store.
5. Return `ok: true` with `ProtonAuthContext` containing session + passphrases.

Failure:

- return `ok: false` with sanitized `message` and typed `reason`.
- do not leak credentials/tokens in logs or result payloads.

## 8.2 `reconnect`

1. Load session from session store.
2. If missing: return `ok: false`, `reason: 'no-session'`.
3. Refresh session according to policy (internal).
4. Load salted passphrases from secret store.
5. If passphrases missing/corrupt: return `ok: false`, `reason: 'passphrase-missing'`.
6. Return `ok: true` with `ProtonAuthContext`.

## 8.3 Refresh lifecycle

- Entirely internal to Auth module.
- `main.ts` may start/stop it via facade hooks, but must not own refresh policy logic.
- On refresh success, Auth should update persisted session.
- On refresh failure requiring invalidation, Auth clears invalid session and emits safe failure result.

---

## 9) Security & Logging Rules (MUST)

Never log:

- passwords/mailbox passwords/2FA code
- access/refresh tokens
- SRP proofs
- raw secret-store payloads

Always:

- sanitize error messages
- redact sensitive metadata by key-pattern and known fields
- keep auth failure output UI-safe and non-sensitive

---

## 10) Simplification Rules for Abstractions

1. Avoid exposing parallel state+result mechanisms for the same operation.
2. Prefer operation-returned `ProtonAuthResult` over checking multiple getters.
3. Keep public types minimal and scenario-focused.
4. Keep ports/adapters where needed, but hide composition complexity behind a small facade.
5. Remove duplicated responsibility between runtime and integration service layers.

---

## 11) Migration Plan (Step-by-step)

## Phase 1 — Introduce new contracts (no behavior change yet)

- Add `auth/public/types.ts` with `ProtonAuthFacade`, `ProtonAuthContext`, `ProtonAuthResult`.
- Add `drive/public/types.ts` with context-based factory input.
- Keep current runtime in place for compatibility.

## Phase 2 — Implement new Auth facade atop existing internals

- Implement `connect`/`reconnect` wrappers using existing login/restore logic.
- Internalize passphrase handling in Auth service.
- Return result union instead of mixed throw/boolean semantics.

## Phase 3 — Move refresh fully into Auth facade

- Keep refresh threshold/policy internal.
- Expose only minimal lifecycle start/stop hooks if needed.

## Phase 4 — Drive context-based initialization

- Adjust Drive factory to accept `ProtonAuthContext` directly.
- Remove external passphrase/session lookups from caller path.

## Phase 5 — Refactor plugin wiring (`main.ts`)

- Startup path: call `reconnect()`.
- Manual login path: call `connect()`.
- On success: initialize Drive client from returned context.
- On failure: show returned safe message.

## Phase 6 — Remove old abstractions

- Remove superseded runtime/getter/state pathways once parity tests pass.
- Ensure no dead paths remain.

---

## 12) File Mapping Guidance (Current → Target)

### Likely current sources

- `application/ProtonPluginRuntime.ts`
- `application/ProtonIntegrationService.ts`
- `application/LoginFlow.ts`
- `application/RestoreFlow.ts`
- `application/SessionLifecycle.ts`
- `infrastructure/ProtonAuthGateway.ts`
- `infrastructure/ProtonDriveClientFactory.ts`
- `infrastructure/ProtonDriveClient.ts`
- `infrastructure/ProtonOpenPgp.ts`
- `infrastructure/ProtonAccount.ts`

### Suggested split

- Auth behavior into `auth/application/*`
- Drive behavior into `drive/application/*` and `drive/infrastructure/*`
- Shared data/contracts into `shared/*`

---

## 13) Testing Requirements

## 13.1 Auth tests

1. `connect` success returns `ok: true` and context with session+passphrases.
2. `connect` invalid credentials returns `ok: false` with sanitized message.
3. `connect` mailbox password required path returns typed failure.
4. `reconnect` with valid stored session returns `ok: true`.
5. `reconnect` with no session returns `ok: false`, reason `no-session`.
6. `reconnect` with refresh failure invalidates session and returns typed failure.
7. passphrase store/load failures map to `passphrase-missing` or storage-related typed failure.
8. refresh lifecycle updates session store and preserves safe error mapping.
9. sensitive fields are redacted in logs.

## 13.2 Drive tests

1. Drive factory accepts `ProtonAuthContext` and creates client.
2. Uses context session for API/auth headers.
3. Uses context passphrases for key resolution.

## 13.3 Integration tests

1. `main.ts` startup flow uses `reconnect` result only.
2. login flow uses `connect` result only.
3. no direct passphrase handling in `main.ts`.
4. no direct refresh policy logic in `main.ts`.

---

## 14) Acceptance Criteria (Definition of Done)

1. `connect` and `reconnect` are the primary auth operations used by caller.
2. Successful auth returns context directly used for Drive init.
3. Salted passphrase handling is entirely internal to Auth.
4. Session refresh policy/lifecycle is internal to Auth.
5. Auth and Drive code are in separate folders with clear boundaries.
6. `main.ts` contains only composition/orchestration, not auth internals.
7. Build passes and relevant tests pass.
8. Logging remains safe and redacted.

---

## 15) Implementation Guardrails for AI Agent

1. Do not rewrite business logic and API calls unnecessarily during the first pass; preserve behavior.
2. Introduce new API in parallel first, then migrate callers, then remove old paths.
3. Keep public exports minimal and explicit.
4. Preserve existing secure error sanitization and redaction standards.
5. Validate each migration phase with tests/build before proceeding.
6. Avoid broad reformatting or unrelated changes.

---

## 16) Open Decisions (to confirm before coding)

1. Should `connect`/`reconnect` still throw for fatal unexpected errors, or always return `ProtonAuthResult`?
   - Recommended: always return `ProtonAuthResult` for deterministic handling.
2. Should auto-refresh be opt-in via explicit `startAutoRefresh`, or start automatically after successful auth?
   - Recommended: explicit start by caller.
3. Should `passphrase-missing` on reconnect prompt immediate re-login UX in settings/modal?
   - Recommended: yes, as recoverable auth state.

---

## 17) Example Caller Flow (Target)

```ts
const reconnectResult = await protonAuth.reconnect();
if (reconnectResult.ok) {
  driveClient = protonDriveFactory.createFromAuthContext(reconnectResult.context);
} else {
  // safe message for UI
}

const connectResult = await protonAuth.connect({ email, password, mailboxPassword, twoFactorCode });
if (connectResult.ok) {
  driveClient = protonDriveFactory.createFromAuthContext(connectResult.context);
}
```

---

## 18) Summary

This PRD intentionally narrows public API complexity to a minimal auth facade and a context-based drive initialization contract, while preserving security, refresh behavior, and current capabilities. It is designed for incremental, low-risk migration that an AI coding agent can execute in clearly verifiable phases.
