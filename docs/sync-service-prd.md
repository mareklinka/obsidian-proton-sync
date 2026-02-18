# PRD: RxJS Sync Service Core

## 1) Overview

This document specifies a **single TypeScript class** that accepts local file/folder change events and synchronizes them to a cloud storage provider through an injected API wrapper.

The service is designed for:
- deterministic event handling,
- bounded send rate (rate-limit friendly),
- per-entity ordering,
- unit-testability,
- external persistence of path↔cloud ID mappings via observable emissions.

This class is intended to replace existing ad-hoc queue behavior with a robust RxJS-driven synchronization core.

---

## 2) Goals

1. Provide a single class (`RxSyncService`) with an enqueue-based API for local changes.
2. Support these local change types:
   - `file-created`
   - `file-edited`
   - `file-deleted`
   - `file-moved`
   - `folder-created`
   - `folder-renamed`
   - `folder-deleted`
   - `folder-moved`
3. Maintain one logical queue per entity (file/folder), identified by normalized path and cloud ID.
4. Debounce consecutive edits to the same entity.
5. Process queues with a **single sender loop** at configurable interval.
6. Global scheduling policy: process entity queues by oldest pending operation timestamp, oldest first.
7. Use constructor DI for:
   - file-system reader abstraction,
   - cloud storage API wrapper abstraction.
8. Maintain in-memory path/cloudID index map and emit map changes as observable for external persistence.
9. Require explicit map initialization before syncing starts.
10. Be fully unit-testable with fake dependencies and controllable schedulers/timers.

---

## 3) Non-goals

- Implementing concrete filesystem access (Obsidian/Vault APIs, Node FS, etc.).
- Implementing concrete cloud provider API details.
- Persisting map state inside this class.
- Multi-threaded sending (explicitly single sender loop).

---

## 4) Terminology

- **Entity**: file or folder.
- **Entity Key**: stable key used for per-entity queueing (prefer cloud ID when known; otherwise normalized path fallback).
- **Path Index**: normalized path → cloud ID metadata.
- **ID Index**: cloud ID → path metadata.
- **Pending Operation**: an enqueued change event waiting for processing.

---

## 5) Functional Requirements

### 5.1 Enqueue API

- Caller enqueues a `SyncChange` via `enqueueChange(change)`.
- Service validates basic shape and normalizes paths.
- If service is not started, changes can still be queued (configurable behavior) but not sent until `start()`.

### 5.2 Per-entity queues

- Maintain `Map<EntityKey, EntityQueue>`.
- Every entity has isolated ordering and debounce behavior.
- Each queue tracks pending operations in arrival order after compaction/debounce rules.

### 5.3 Debounce semantics

- Debounce applies to consecutive edit-like updates for same entity:
  - `file-edited`
  - optionally repeated folder metadata/rename updates to same target (implementation detail)
- Default debounce window: `1500ms` (tunable).
- Only latest change in debounce window survives for that entity.

### 5.4 Sender loop

- Single sender loop driven by RxJS `interval(sendIntervalMs)` or equivalent scheduler-based ticker.
- On each tick:
  1. Find all entity queues with pending operations.
  2. Select queue whose **head operation** has oldest `enqueuedAt`.
  3. Process exactly one operation (default), or up to configured burst size if enabled.
- Must never process two operations concurrently in default mode.

### 5.5 Rate limiting

- Tunable via options/constants:
  - `sendIntervalMs` (default `500ms`)
  - `maxOpsPerTick` (default `1`)
  - optional token-bucket extension (future)
- Service behavior should be stable under API 429 responses:
  - classify as retryable,
  - exponential backoff + jitter,
  - requeue without reordering unrelated queues.

### 5.6 Filesystem reader usage

- For file create/edit/move operations, service retrieves file metadata/content through injected filesystem reader.
- Required file data:
  - name,
  - normalized path,
  - content (`Blob | ArrayBuffer`),
  - last modification timestamp.
- For folder operations, service retrieves folder metadata:
  - name,
  - normalized path.

### 5.7 Cloud API wrapper usage

- Service sends translated operations to injected cloud API abstraction.
- Cloud wrapper returns resulting cloud IDs and any updated metadata required to maintain map consistency.

### 5.8 Map maintenance & emissions

- Service maintains an internal bidirectional index:
  - path → cloud ID entry,
  - cloud ID → path entry.
- Any index mutation emits `MapMutationEvent` on `mapChanges$`.
- Emitted events are append-only facts (for persistence/replay by other services).

### 5.9 Initialization contract

- External caller must set initial map before `start()`:
  - via `initializeIndex(snapshot)` (required).
- `start()` fails fast if index not initialized.

### 5.10 Unit-testability

- No hard dependency on wall clock.
- Class should accept schedulers or timer factories.
- All external effects behind DI interfaces.

---

## 6) Data model

```ts
export type SyncChangeType =
  | "file-created"
  | "file-edited"
  | "file-deleted"
  | "file-moved"
  | "folder-created"
  | "folder-renamed"
  | "folder-deleted"
  | "folder-moved";

export type EntityType = "file" | "folder";

export interface SyncChangeBase {
  type: SyncChangeType;
  entityType: EntityType;
  path: string; // current/new path
  oldPath?: string; // required for move/rename variants
  occurredAt?: number; // source timestamp; fallback to now
  correlationId?: string; // optional tracing
}

export interface QueuedChange extends SyncChangeBase {
  id: string;
  enqueuedAt: number;
  attempt: number;
}
```

### 6.1 Index snapshot and entries

```ts
export interface SyncIndexEntry {
  cloudId: string;
  path: string;
  entityType: EntityType;
  updatedAt: number;
}

export interface SyncIndexSnapshot {
  byPath: Record<string, SyncIndexEntry>;
  byCloudId: Record<string, SyncIndexEntry>;
}
```

### 6.2 Map mutation events

```ts
export type MapMutationType =
  | "upsert"
  | "remove"
  | "path-changed";

export interface MapMutationEvent {
  type: MapMutationType;
  entityType: EntityType;
  cloudId: string;
  path?: string;
  oldPath?: string;
  at: number;
  reason: SyncChangeType | "reconcile" | "init";
}
```

---

## 7) Dependency interfaces (DI contracts)

> These dependencies are in scope only as interfaces; concrete implementations are out of scope.

```ts
import type { Observable } from "rxjs";

export interface FileDescriptor {
  name: string;
  path: string;
  modifiedAt: number;
  content: Blob | ArrayBuffer;
}

export interface FolderDescriptor {
  name: string;
  path: string;
}

export interface IFileSystemReader {
  readFile(path: string): Promise<FileDescriptor | null>;
  readFolder(path: string): Promise<FolderDescriptor | null>;
  exists(path: string, entityType: EntityType): Promise<boolean>;
}

export interface CloudUpsertResult {
  cloudId: string;
  path: string;
  entityType: EntityType;
}

export interface ICloudStorageApi {
  createFile(input: FileDescriptor, parentPath?: string): Promise<CloudUpsertResult>;
  updateFile(cloudId: string, input: FileDescriptor): Promise<CloudUpsertResult>;
  deleteFile(cloudId: string): Promise<void>;
  moveFile(cloudId: string, newPath: string): Promise<CloudUpsertResult>;

  createFolder(input: FolderDescriptor, parentPath?: string): Promise<CloudUpsertResult>;
  renameFolder(cloudId: string, newName: string, newPath: string): Promise<CloudUpsertResult>;
  deleteFolder(cloudId: string): Promise<void>;
  moveFolder(cloudId: string, newPath: string): Promise<CloudUpsertResult>;
}

export interface SyncServiceOptions {
  debounceMs?: number; // default 1500
  sendIntervalMs?: number; // default 500
  maxOpsPerTick?: number; // default 1
  retryMaxAttempts?: number; // default 5
  retryBaseDelayMs?: number; // default 1000
  jitterRatio?: number; // default 0.2
}
```

---

## 8) Class interface definition

```ts
import type { Observable } from "rxjs";
import type { SchedulerLike } from "rxjs";

export interface SyncQueueStats {
  totalPending: number;
  queueCount: number;
  inFlight: boolean;
  droppedByCompaction: number;
  retried: number;
  failedTerminal: number;
}

export interface SyncDispatchResult {
  changeId: string;
  success: boolean;
  retryScheduled: boolean;
  errorMessage?: string;
}

export interface ISyncService {
  initializeIndex(snapshot: SyncIndexSnapshot): void;
  start(): void;
  stop(): void;
  dispose(): void;

  enqueueChange(change: SyncChangeBase): string; // returns queued change id
  clearPending(entityKey?: string): void;

  readonly mapChanges$: Observable<MapMutationEvent>;
  readonly dispatchResults$: Observable<SyncDispatchResult>;
  readonly stats$: Observable<SyncQueueStats>;
}

export class RxSyncService implements ISyncService {
  constructor(
    fsReader: IFileSystemReader,
    cloudApi: ICloudStorageApi,
    options?: SyncServiceOptions,
    scheduler?: SchedulerLike,
  );

  initializeIndex(snapshot: SyncIndexSnapshot): void;
  start(): void;
  stop(): void;
  dispose(): void;

  enqueueChange(change: SyncChangeBase): string;
  clearPending(entityKey?: string): void;

  readonly mapChanges$: Observable<MapMutationEvent>;
  readonly dispatchResults$: Observable<SyncDispatchResult>;
  readonly stats$: Observable<SyncQueueStats>;
}
```

### Design notes

- `SchedulerLike` injection enables deterministic virtual-time tests.
- API is explicit and side-effect boundaries are mock-friendly.
- Single class requirement is preserved; helper types/interfaces can live in same file.

---

## 9) Scheduling and compaction rules

### 9.1 Entity key resolution

Given a change:
1. If path exists in index and has cloud ID, entity key = `cloud:{cloudId}`.
2. Else fallback key = `path:{normalizedPath}`.
3. For move/rename, old/new path must remap queue ownership to preserve continuity.

### 9.2 Compaction matrix (minimum required)

Within the same entity queue, before dispatch:

- `file-created` followed by `file-edited` => keep only `file-created` (latest content read at send time).
- Multiple consecutive `file-edited` within debounce => keep latest one.
- `file-created` then `file-deleted` before send => drop both (net no-op).
- `file-moved`/`folder-moved` chain => keep latest destination.
- `folder-renamed` chain => keep latest name/path.
- Delete after any pending non-delete op => collapse to single delete when valid.

> Exact matrix should be implemented as a pure function for testability.

### 9.3 Oldest-first global fairness

At each tick, choose queue with smallest head `enqueuedAt`.
If tie, use lexical compare of entity key for determinism.

---

## 10) Operation execution rules

### 10.1 File create/edit

- Resolve latest file descriptor via `fsReader.readFile(path)`.
- If file not found when handling create/edit:
  - treat as soft failure; emit result; do not mutate map.
- If cloud ID known:
  - call `cloudApi.updateFile(cloudId, descriptor)`.
- Else:
  - call `cloudApi.createFile(descriptor, parentPath)`.
- Upsert map using returned cloud ID/path.

### 10.2 File delete

- If cloud ID known, call `cloudApi.deleteFile(cloudId)`.
- Remove index entries for path/cloud ID.
- If unknown, mark as no-op success.

### 10.3 File move

- Requires `oldPath` and `path` (new path).
- Resolve cloud ID from `oldPath` or current index.
- If cloud ID known, call `cloudApi.moveFile(cloudId, newPath)`.
- Update map path.

### 10.4 Folder operations

Analogous to file operations, using folder methods and `fsReader.readFolder` where required.

---

## 11) Error handling and retries

- Classify errors:
  - **retryable**: network/transient/429/5xx.
  - **non-retryable**: validation, 4xx non-rate-limit, malformed input.
- Retry policy:
  - exponential backoff: $delay = base \times 2^{attempt-1}$
  - jitter: $delay \times (1 \pm jitterRatio)$
  - max attempts configurable.
- On terminal failure:
  - emit failure in `dispatchResults$`,
  - keep service alive,
  - continue with next eligible queue.

---

## 12) Observability requirements

Expose these observables:
- `mapChanges$`: all index mutations.
- `dispatchResults$`: per-operation success/failure/retry.
- `stats$`: queue and throughput metrics snapshots.

Optional (nice-to-have):
- `lifecycle$` for start/stop/dispose events.

---

## 13) Lifecycle requirements

- `initializeIndex()` must be called exactly once before `start()` (or subsequent call replaces snapshot explicitly if allowed).
- `start()` is idempotent.
- `stop()` pauses sending but keeps pending queue.
- `dispose()` stops service, completes observables, clears pending memory.

---

## 14) Defaults and tunables

Suggested defaults (override via options):

- `DEFAULT_DEBOUNCE_MS = 1500`
- `DEFAULT_SEND_INTERVAL_MS = 500`
- `DEFAULT_MAX_OPS_PER_TICK = 1`
- `DEFAULT_RETRY_MAX_ATTEMPTS = 5`
- `DEFAULT_RETRY_BASE_DELAY_MS = 1000`
- `DEFAULT_JITTER_RATIO = 0.2`

All defaults should be exported constants to make tuning straightforward.

---

## 15) Unit test plan (acceptance criteria)

1. **Initialization guard**
   - `start()` before `initializeIndex()` throws meaningful error.
2. **Per-entity isolation**
   - edits on two files do not reorder within same entity; global oldest-head-first works.
3. **Debounce**
   - multiple `file-edited` within window dispatch once.
4. **Compaction**
   - create→delete before dispatch produces no API call.
5. **Single sender**
   - ensure no concurrent cloud calls when `maxOpsPerTick=1`.
6. **Rate control**
   - dispatch count over simulated time matches configured interval.
7. **Retry/backoff**
   - retryable failures reattempt with increasing delay.
8. **Map emissions**
   - create/move/delete produce expected `mapChanges$` sequence.
9. **Stop/resume**
   - stop pauses dispatch, resume continues pending.
10. **Dispose behavior**
   - subscriptions complete, pending cleared, no further dispatch.

Use RxJS `TestScheduler` (or injected virtual scheduler) to avoid real-time sleeps.

---

## 16) Implementation sketch (high-level)

1. `enqueueChange` pushes into input subject.
2. Input stream normalizes path + enriches metadata.
3. Route to per-entity queue map with compaction/debounce.
4. Sender ticker selects oldest queue head.
5. Execute one operation, update index map, emit map mutation and dispatch result.
6. Handle retries via delayed reinsert to same entity queue.

---

## 17) Usage example

```ts
import { RxSyncService } from "./RxSyncService";
import type {
  ICloudStorageApi,
  IFileSystemReader,
  SyncIndexSnapshot,
} from "./RxSyncService";

const fsReader: IFileSystemReader = /* concrete impl */ null as any;
const cloudApi: ICloudStorageApi = /* concrete impl */ null as any;

const service = new RxSyncService(fsReader, cloudApi, {
  debounceMs: 1500,
  sendIntervalMs: 500,
  maxOpsPerTick: 1,
  retryMaxAttempts: 5,
  retryBaseDelayMs: 1000,
  jitterRatio: 0.2,
});

const initialIndex: SyncIndexSnapshot = {
  byPath: {},
  byCloudId: {},
};

service.initializeIndex(initialIndex);

const mapSub = service.mapChanges$.subscribe((event) => {
  // Persist externally (settings/db/file)
  // Example: append event to write-ahead log or apply directly to durable map.
});

const resultSub = service.dispatchResults$.subscribe((r) => {
  if (!r.success) {
    console.warn("Sync dispatch failed", r);
  }
});

service.start();

service.enqueueChange({
  type: "file-created",
  entityType: "file",
  path: "notes/today.md",
});

service.enqueueChange({
  type: "file-edited",
  entityType: "file",
  path: "notes/today.md",
});

service.enqueueChange({
  type: "folder-moved",
  entityType: "folder",
  oldPath: "notes/archive",
  path: "archive/notes",
});

// later
service.stop();
mapSub.unsubscribe();
resultSub.unsubscribe();
service.dispose();
```

---

## 18) Integration notes for this repository

- Current code uses `SyncQueue` and settings maps (`pathMap`, `folderMap`).
- New service should expose map mutation events so plugin-level code can continue persistence through existing settings save flow.
- Since RxJS is not currently listed in dependencies, implementation task should add:
  - runtime dependency: `rxjs`
  - (optional) test scheduler utilities from RxJS for unit tests.

---

## 19) Open decisions for implementation phase

1. Whether enqueue is allowed before `start()` (recommended: yes, queue pending).
2. Whether `initializeIndex()` can be called while running (recommended: no; require stop first).
3. Exact compact/merge behavior for mixed move+edit sequences across parent folder moves.
4. Whether to emit full snapshot periodically in addition to mutation stream.

---

## 20) Done definition

Implementation is considered done when:
- class compiles,
- all acceptance tests above pass,
- class operates with injected fake filesystem/cloud dependencies,
- no direct persistence logic exists in class,
- map changes are emitted and consumable by caller,
- sender loop obeys single-thread and oldest-head-first scheduling.

---

## 21) Recommended additions (missing-but-important requirements)

These were not explicitly requested but are strongly recommended to avoid common sync bugs in production.

### 21.1 Delivery semantics (must be explicit)

- Define guarantee as **at-least-once delivery** of outbound cloud operations.
- Require cloud wrapper methods to be idempotent when possible (or expose idempotency key support).
- `enqueueChange` should return change ID to support traceability and dedupe across retries.

### 21.2 Path normalization policy (critical on Windows)

- Normalize separators to `/`.
- Define case policy for path keys (recommended: preserve original path for display, but use canonical key for lookup).
- Specify whether lookup keys are case-insensitive on Windows-like environments.
- Reject invalid/empty paths after normalization.

### 21.3 Event validity contract

- `file-moved`, `folder-moved`, and `folder-renamed` require both `oldPath` and `path`.
- Service must reject/emit non-retryable dispatch result for invalid change payloads.
- Define behavior for duplicate/out-of-order local events (e.g., edit after delete).

### 21.4 Parent-child dependency ordering

- If a file/folder operation depends on parent folder existence, parent create/move must be processed first.
- Add dependency check before dispatch; if unmet, defer operation (without starvation).
- For folder delete, define whether children must be deleted first or whether provider supports recursive delete.

### 21.5 Concurrency and state transitions

- Define explicit lifecycle state machine: `idle -> initialized -> running -> stopped -> disposed`.
- `enqueueChange` behavior by state must be documented (accepted/rejected/buffered).
- `dispose()` should be terminal and reject future enqueue attempts.

### 21.6 Persistence stream contract

- `mapChanges$` events should include monotonically increasing sequence number (`seq`) for durable replay ordering.
- Require consumers to persist events in order; document snapshot + mutation replay bootstrap sequence.
- Optional: periodic full snapshot emission for crash recovery acceleration.

### 21.7 Backpressure and memory limits

- Add configurable safety limits:
  - `maxPendingTotal`
  - `maxPendingPerEntity`
- Define behavior when limits are hit (recommended: compact aggressively, then reject newest with explicit error/result event).

### 21.8 Retry budget and dead-letter handling

- After terminal failure, emit structured result with classification and leave service healthy.
- Add optional dead-letter callback/observable for external alerting and manual replay.

### 21.9 Clock abstraction

- Inject time source (`now(): number`) in addition to scheduler for deterministic tests and reproducible retry behavior.

### 21.10 Migration compatibility with current plugin settings

- Define mapping between current persisted maps and new index snapshot:
  - `settings.pathMap` + `settings.folderMap` -> `SyncIndexSnapshot`.
- Document one-time migration and fallback strategy for malformed legacy entries.

---

## 22) Additional acceptance tests (recommended)

11. **Path normalization/case handling**
  - same logical path in different separator/case forms maps to one canonical entity key.

12. **Invalid payload handling**
  - move/rename without `oldPath` is rejected as non-retryable and does not crash loop.

13. **Parent dependency scheduling**
  - child file create waits until parent folder creation succeeds.

14. **Persistence ordering**
  - `mapChanges$` sequence numbers are monotonic and replay reproduces index exactly.

15. **Backpressure limits**
  - when pending limits are exceeded, service emits explicit overflow result and remains operational.

16. **Lifecycle terminal behavior**
  - after `dispose()`, enqueue attempts fail predictably and no new dispatch occurs.

17. **At-least-once semantics**
  - retryable failure followed by success may invoke cloud API more than once; final state remains correct.

---

## 23) Implementation priority contract (MUST / SHOULD / COULD)

This section converts the recommendation set into delivery priorities for implementation agents.

### 23.1 Priority definitions

- **MUST**: required for v1 merge. Missing any MUST item blocks release.
- **SHOULD**: strongly recommended for v1; may be deferred only with explicit note and follow-up ticket.
- **COULD**: optional enhancement; implement if low-risk and time permits.

### 23.2 Priority matrix

#### MUST (v1 blocking)

1. Core class contract in this PRD section 8 (`RxSyncService`) with constructor DI, enqueue API, lifecycle API, and observables.
2. Single sender loop with oldest-head-first queue scheduling and no concurrent dispatch when `maxOpsPerTick = 1`.
3. Per-entity queueing with debounce for `file-edited`.
4. Explicit initialization guard: `initializeIndex()` required before `start()`.
5. Bidirectional index maintenance (path↔cloudID) and `mapChanges$` mutation emission.
6. Path normalization to `/` separators and rejection of invalid/empty normalized paths.
7. Event payload validation for move/rename variants requiring `oldPath`.
8. At-least-once retry behavior for retryable errors with bounded attempts and backoff.
9. Lifecycle terminal behavior: after `dispose()`, no new processing and enqueue attempts fail predictably.
10. Unit tests for all MUST behavior using virtual time (`SchedulerLike`/`TestScheduler`).

#### SHOULD (v1 strongly recommended)

1. Canonical case-handling policy for path keys on Windows-like environments (documented and tested).
2. Parent-child dependency handling (parent folder availability before child operations).
3. Backpressure controls (`maxPendingTotal`, `maxPendingPerEntity`) with explicit overflow handling.
4. Structured terminal failure output and optional dead-letter observable/hook.
5. Monotonic sequence field (`seq`) on `mapChanges$` events for deterministic persistence replay.
6. Injected clock abstraction (`now(): number`) in addition to scheduler.
7. Migration adapter definition from `settings.pathMap`/`settings.folderMap` to `SyncIndexSnapshot`.

#### COULD (post-v1)

1. Periodic full snapshot emission in addition to mutation events.
2. Token-bucket rate limiter in addition to interval-based pacing.
3. Additional lifecycle observable stream (`lifecycle$`) for diagnostics.

### 23.3 Implementation gate

The implementation agent should produce:

1. **MUST-complete checklist** (all items marked done).
2. **Acceptance report** mapping each MUST item to passing test(s).
3. **Deferred SHOULD list** (if any) with rationale and next-step tickets.

If any MUST item fails tests, implementation is considered incomplete.

### 23.4 Suggested execution order for coding agent

1. Build class skeleton + DI interfaces + lifecycle state machine.
2. Implement queue model, debounce, scheduler loop, and oldest-first selector.
3. Implement operation dispatcher (file/folder create/edit/delete/move/rename).
4. Implement map mutations and observable emissions.
5. Implement retry/backoff and terminal failure handling.
6. Add and pass MUST test suite.
7. Add SHOULD items as time permits.
