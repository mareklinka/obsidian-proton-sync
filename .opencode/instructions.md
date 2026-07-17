## Proton Drive sync plugin for Obsidian – AI Contributor Quick Guide

Purpose: Provide AI agents with the context needed to work effectively on this Obsidian community plugin that syncs vault files with Proton Drive.

**Obsidian plugin development docs**: https://docs.obsidian.md/

### Air-Gapped Environment (with Squid Proxy)

This agent runs in a restricted environment with **no direct internet access**. Outbound traffic is routed through a **Squid proxy** (`squid`, port 3128) that only permits connections to a **whitelisted set of domains**. In case a domain needs to be whitelisted, the user must make changes to the squid configuration file.

You **can** fetch web pages, search the internet, or retrieve external documentation — but **only if the target URL resolves to one of the whitelisted domains**. If you need information from a non-whitelisted domain (e.g., GitHub, Stack Overflow, npmjs.com, etc.), you must ask the user to provide it directly.

### Git Metadata is Read-Only

The `.git` directory is mounted read-only inside the container. Any operation that requires write access to git metadata (e.g. `git add`, `git commit`, `git push`, `git stash`) **must be done by the user outside the container**. The agent cannot perform these operations.

### Mandatory SDLC Workflow

All AI agents MUST follow the structured SDLC defined in [docs/sdlc.md](./sdlc.md). The workflow consists of six hard-transition stages:

1. **Requirements Elicitation** — gather requirements, define scope/boundaries, produce draft PRD in `docs/prds/`. No coding.
2. **Exploration** — explore codebase, create technical plan, expand PRD with implementation details. No coding.
3. **Validation (User Review)** — present PRD to user, incorporate feedback, finalize.
4. **Implementation** — write code strictly according to the finalized PRD.
5. **Validation (Implementation Review)** — verify implementation against PRD, run tests, fix issues.
6. **Cleanup & Refactoring** — clean up code, ensure conventions, run linters/formatters.

**Phase transitions are HARD.** Never skip, merge, or bypass stages. The agent MUST enforce this workflow even without explicit user prompting.

### Architecture Essentials

**Service pattern**: Every service uses a singleton init/get pair via self-invoking IIFE. `initFoo(...)` creates the instance; `getFoo()` retrieves it (throws if not initialized). Init order in `main.ts:39-59`: i18n → settings store → secret store → file API → vault log sink → proton session service → sync service → sync progress modal. Proton SDK services (account, HTTP client, drive client, drive API, cloud observer) are lazily initialized during sync operations in `actions.ts:256-266`.

**Effect + RxJS duality**: `effect` library handles async workflows with typed algebraic errors (`Data.TaggedError`). RxJS `BehaviorSubject` handles reactive state streams and modal event channels. All async boundaries use `Effect.gen` with `yield*` chaining. Errors are caught via `Effect.catchTag` / `Effect.catchTags`. Promises are wrapped with `Effect.tryPromise` or `Effect.promise`.

**Sync flow**: Both push and pull follow 4 phases — local tree build, remote tree build, diff computation, applying changes. State machine: `idle → auth → pushing/pulling → {localTreeBuild, remoteTreeBuild, diffComputation, applyingChanges} → idle`. Conflict detection uses SHA1 hashes compared against a persisted `RemoteFileStateSnapshot` baseline. Cancellation via `AbortSignal` checked at every async boundary.

**Auth flow**: SRP (Secure Remote Password) protocol for authentication. Session encrypted with AES-GCM + master password (bcrypt-SHA256 KDF), stored in Obsidian SecretStore. Modals handle 2FA, captcha, mailbox password, and master password prompts via `promptFromModal()`.

**File APIs**: `ObsidianFileApi` wraps `vault.adapter` (list, readBinary, writeBinary, mkdir, rmdir). `ProtonDriveApi` wraps `@protontech/drive-sdk` (getChildren, uploadFile, downloadFile, createFolder, trashNodes). Both expose Effect-based operations.

### Common Development Workflows

**Dev build** (watch mode): `npm run dev` — bundles `main.ts` → `main.js` with inline sourcemaps, watches for changes.

**Production build**: `npm run build` — bundles `main.ts` → `main.js` minified, no sourcemaps.

**Type checking**: `npm run typecheck` — `tsc --noEmit`.

**Linting**: `npm run lint` — ESLint. `npm run lint:fix` — auto-fix.

**Formatting**: `npm run format` — Prettier. `npm run format:check` — check only.

**Tests**: `npm run test` — Vitest run. `npm run test:watch` — watch mode. `npm run test:coverage` — V8 coverage.

**Full check** (CI): `npm run check` — typecheck + lint + format:check + test.

**Obsidian module mocking**: Tests alias `obsidian` → `test/mocks/obsidian.ts`. Use `vi.hoisted()` for shared mocks and `vi.resetModules()` in `beforeEach` to isolate singleton state.

**Running effects in tests**: Use `Effect.runPromise(effect)` for success paths; `Effect.runPromise(Effect.either(effect))` for failure paths to inspect the `Left` tag.

### Patterns & Conventions

**Tagged errors**: All errors extend `Data.TaggedError('TaggedName')`. Use `Effect.catchTag('TaggedName', handler)` for single-tag handling or `Effect.catchTags({...})` for multi-tag. Never use try/catch inside `Effect.gen` — wrap with `Effect.tryPromise` instead.

**Option over null**: Use `Option<T>` from `effect` instead of `null`/`undefined`. Check with `Option.isSome()` / `Option.isNone()`; access value via `.value`.

**Path canonicalization**: All file paths are normalized to lowercase forward-slash (`CanonicalPath`) via `normalizePath()`. Compare paths using canonical form, not raw paths.

**SHA1 for sync**: File content identity uses hex-encoded SHA1. Both `ObsidianFileApi` and `ProtonDriveApi` compute/compare SHA1 for conflict detection.

**Modal pattern**: All modals expose `submitted$` and `canceled$` RxJS Subjects. Use `promptFromModal(app, () => new Modal(app))` to await user input as an Effect.

**Deferred deletes**: Push prune operations produce `applyMode: 'deferred'` deletes that are batched into a single `trashNodes()` call at the end of the operation.

**Auto-save settings**: `ObsidianSettingsStore` subscribes to its own `settings$` and auto-saves via the provided `save` callback on every change.

**Ensure not cancelled**: Every async step in sync operations calls `ensureNotCancelled(signal)` to check `AbortSignal` at safe boundaries.

### Fast Reference Paths

| File / Directory                        | Purpose                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `main.ts`                               | Plugin entry point, service init order, commands, settings tab                                       |
| `actions.ts`                            | `pushVault()` / `pullVault()` orchestration, confirmation, conflict resolver                         |
| `services/SyncService.ts`               | Core sync engine (push/pull impl, state machine, conflict detection)                                 |
| `services/ObsidianFileApi.ts`           | Vault adapter wrapper (file tree, read/write/delete)                                                 |
| `services/ProtonDriveApi.ts`            | Proton SDK wrapper (children, upload, download, create folder, trash)                                |
| `services/ObsidianSettingsStore.ts`     | Plugin settings persistence (auto-save via RxJS)                                                     |
| `services/EncryptedSecretStore.ts`      | AES-GCM encrypted session storage with master password                                               |
| `services/RemoteFileStateSnapshot.ts`   | Persisted SHA1 baseline for conflict detection                                                       |
| `services/SyncOperationCancellation.ts` | Module-scoped AbortController for sync cancellation                                                  |
| `services/ProtonCloudObserver.ts`       | Proton Drive tree change event subscription                                                          |
| `proton/auth/ProtonSessionService.ts`   | SRP auth, session management, modal prompts for 2FA/captcha/password                                 |
| `proton/drive/`                         | Proton SDK clients (account, HTTP, drive client, drive API)                                          |
| `ui/modals/`                            | All plugin modals (login, 2FA, captcha, master password, sync action, progress, conflict resolution) |
| `ui/status-bar.ts`                      | Plugin status bar icon updates based on sync state                                                   |
| `ui/settings-tab.ts`                    | Settings tab UI, login/disconnect/master password forms                                              |
| `i18n/lang/en.ts`                       | English translation catalog (all UI strings)                                                         |
| `test/`                                 | Vitest tests, mocks, test data factories                                                             |
| `esbuild.config.mjs`                    | Build config (entry: main.ts, output: main.js, platform: browser)                                    |

Keep additions minimal, consistent, and test-backed.
