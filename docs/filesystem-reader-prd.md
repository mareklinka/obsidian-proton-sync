# PRD: Obsidian File System Reader Service

## 1) Overview

This document specifies a **simple, testable file system reader service** for an Obsidian plugin.

The service is responsible for:
- reading file/folder metadata and file content through `Vault` APIs,
- emitting normalized file-system change events based on `Vault` events,
- exposing snapshot APIs (`listFiles`, `listFolders`) for bootstrap/reconciliation,
- applying configurable path ignore behavior (default: ignore nothing).

This service is intentionally minimal and should contain only logic necessary to satisfy the sync service’s read/listen needs.

---

## 2) Goals

1. Provide one class implementation using Obsidian `Vault` APIs.
2. Emit normalized domain events compatible with sync workflows.
3. Support read operations for files/folders needed by sync dispatch.
4. Expose initial/full snapshot listing APIs.
5. Keep behavior deterministic, predictable, and easy to test.
6. Achieve high unit-test coverage (target: 90%+ lines/branches for the service).

---

## 3) Non-goals

- Performing sync queueing, rate limiting, retries, or cloud API calls.
- Persisting state to disk/database.
- Implementing complex reconciliation logic.
- Synthesizing deep child events for folder operations unless explicitly configured later.

---

## 4) Context & Dependencies

- Runtime environment: Obsidian plugin.
- Primary dependency: `Vault` (Obsidian API).
- Reader must listen to Vault events (e.g., create, modify, rename, delete).

### Required constructor dependencies

1. `vault: Vault` (mandatory)
2. `options?: FileSystemReaderOptions` (optional; defaults provided)

No other dependency is required for v1.

---

## 5) Functional Requirements

### 5.1 Read APIs

The service must provide:
- `readFile(path)` -> returns file descriptor (name, path, modifiedAt, content) or `null`.
- `readFolder(path)` -> returns folder descriptor (name, path) or `null`.
- `exists(path, entityType)` -> boolean.

File content output type must be `Blob | ArrayBuffer` (ArrayBuffer recommended for plugin internals).

### 5.2 Snapshot APIs

The service must provide:
- `listFiles()` -> complete list of readable file descriptors (or metadata-only variant + opt-in content loading).
- `listFolders()` -> complete list of folder descriptors.

For simplicity/performance, v1 should expose:
- `listFilesMetadata()` (name, path, modifiedAt)
- `listFolders()`

and keep full-content file reads to `readFile(path)`.

### 5.3 Event listening

Service must subscribe to Vault events and emit normalized domain events.

Required events to handle:
- create
- modify
- rename
- delete

Mapping expectations:
- file create -> `file-created`
- file modify -> `file-edited`
- file delete -> `file-deleted`
- file rename/move -> `file-moved` (with `oldPath`)
- folder create -> `folder-created`
- folder rename path change:
  - if parent unchanged -> `folder-renamed`
  - if parent changed -> `folder-moved`
- folder delete -> `folder-deleted`

### 5.4 Delete payload rule

For delete events, emit only:
- normalized path,
- entity type,
- timestamp,
- `oldPath` where applicable.

No content lookup or cache dependency is required for deletes.

### 5.5 Ignore behavior

- Default behavior: do **not** ignore any paths.
- Ignore policy must be configurable and easy to tune.
- Support both:
  - static ignored path prefixes,
  - custom predicate `(path, entityType) => boolean`.

### 5.6 Path normalization

- Normalize separators to `/`.
- Trim leading/trailing slashes.
- Preserve original case in emitted payload.
- Provide optional canonical key helper (case-insensitive by default on Windows contexts).

### 5.7 Lifecycle

Service must support:
- `start()` (register listeners, idempotent)
- `stop()` (unregister listeners, idempotent)
- `dispose()` (terminal stop + complete streams)

Events must not emit when stopped/disposed.

---

## 6) Data Contracts

```ts
export type EntityType = "file" | "folder";

export type ReaderChangeType =
  | "file-created"
  | "file-edited"
  | "file-deleted"
  | "file-moved"
  | "folder-created"
  | "folder-renamed"
  | "folder-deleted"
  | "folder-moved";

export interface ReaderChangeEvent {
  type: ReaderChangeType;
  entityType: EntityType;
  path: string;
  oldPath?: string;
  occurredAt: number;
}

export interface FileDescriptor {
  name: string;
  path: string;
  modifiedAt: number;
  content: Blob | ArrayBuffer;
}

export interface FileMetadataDescriptor {
  name: string;
  path: string;
  modifiedAt: number;
}

export interface FolderDescriptor {
  name: string;
  path: string;
}
```

---

## 7) Service Interface

```ts
import type { Observable } from "rxjs";

export interface FileSystemReaderOptions {
  ignoredPathPrefixes?: string[];
  ignorePredicate?: (path: string, entityType: EntityType) => boolean;
  caseInsensitivePaths?: boolean; // default true
  now?: () => number; // default Date.now
  binaryAsBlob?: boolean; // default false -> ArrayBuffer
}

export interface IFileSystemReaderService {
  start(): void;
  stop(): void;
  dispose(): void;

  readFile(path: string): Promise<FileDescriptor | null>;
  readFolder(path: string): Promise<FolderDescriptor | null>;
  exists(path: string, entityType: EntityType): Promise<boolean>;

  listFilesMetadata(): Promise<FileMetadataDescriptor[]>;
  listFolders(): Promise<FolderDescriptor[]>;

  readonly changes$: Observable<ReaderChangeEvent>;
}

export class ObsidianVaultFileSystemReader implements IFileSystemReaderService {
  constructor(vault: Vault, options?: FileSystemReaderOptions);
  // ...implements all methods above
}
```

---

## 8) Design Constraints (Simplicity First)

1. Avoid internal caches unless strictly required.
2. Avoid inferred/synthetic events beyond direct Vault mapping.
3. Keep rename classification logic minimal:
   - compare old parent path and new parent path.
4. Keep methods small and pure where possible (normalization/classification helpers).
5. Prefer explicit null returns over exceptions for not-found reads.

---

## 9) Obsidian-specific Behavior Notes

1. Vault events may arrive rapidly; reader should emit events as-is without debounce.
2. Reader should not mutate Vault state.
3. Reader must register and clean up event handlers safely.
4. Use `TFile` / `TFolder` type guards to classify entities.

---

## 10) Error Handling

- Read/list methods:
  - return `null`/empty arrays on not-found where appropriate.
  - throw only for unexpected internal failures (and keep message actionable).
- Event pipeline:
  - never crash due to one malformed event; guard and skip if needed.

---

## 11) Testability Requirements

Implementation must be highly testable via unit tests with mocked Vault behavior.

### 11.1 Recommended test seam

Define a tiny internal adapter interface for the subset of Vault APIs used, so tests can inject fakes without requiring a live Obsidian runtime.

Example:

```ts
interface VaultAdapter {
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getAllLoadedFiles(): TAbstractFile[];
  read(file: TFile): Promise<string>;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  on(name: "create" | "modify" | "rename" | "delete", cb: (...args: any[]) => void): EventRef;
  offref(ref: EventRef): void;
}
```

Production class may wrap real `Vault`; tests inject fake adapter.

### 11.2 Coverage target

- Target >= 90% lines and branches for this service file.

### 11.3 Required test cases

1. `readFile` returns descriptor for text file.
2. `readFile` returns descriptor for binary file.
3. `readFile` returns null for missing/non-file path.
4. `readFolder` returns descriptor for folder path.
5. `exists` true/false for both entity types.
6. `listFilesMetadata` includes all files, excludes folders.
7. `listFolders` includes all folders, excludes files.
8. create/modify/delete mapping for files.
9. create/delete mapping for folders.
10. rename mapping:
    - same parent => renamed
    - different parent => moved
11. ignore rules suppress configured paths.
12. `start`/`stop` idempotency.
13. `dispose` stops emissions and completes stream.
14. path normalization correctness (`\\` -> `/`, trimming).

---

## 12) Suggested Implementation Sketch

1. Build class with ctor(vault, options) + subjects.
2. Add helpers:
   - `normalizePath`
   - `isIgnored`
   - `classifyFolderRename`
3. Implement read/list methods via Vault APIs and type guards.
4. Implement listener registration in `start()`.
5. Map Vault events to `ReaderChangeEvent` and emit via `changes$`.
6. Ensure cleanup in `stop()`/`dispose()`.
7. Add unit tests with fake vault adapter.

---

## 13) Usage Example

```ts
import { ObsidianVaultFileSystemReader } from "./ObsidianVaultFileSystemReader";

const reader = new ObsidianVaultFileSystemReader(this.app.vault, {
  ignoredPathPrefixes: [],
  caseInsensitivePaths: true,
  binaryAsBlob: false,
});

reader.start();

const sub = reader.changes$.subscribe((event) => {
  // Forward to sync service enqueue
  // syncService.enqueueChange(event)
});

const file = await reader.readFile("notes/today.md");
if (file) {
  // file.content -> ArrayBuffer (or Blob if configured)
}

const files = await reader.listFilesMetadata();
const folders = await reader.listFolders();

// later
sub.unsubscribe();
reader.dispose();
```

---

## 14) Integration Contract with Sync Service

- Reader emits normalized domain events expected by sync service enqueue API.
- Reader never applies debounce/rate limiting (sync service owns that).
- Reader snapshot APIs support bootstrap map/consistency workflows.

---

## 15) Open decisions for implementation (none blocking)

Resolved for v1:
- Event shape: normalized domain events.
- Bootstrap API: include file/folder listing.
- Delete payload: path + type + timestamp only.
- Ignore behavior: default no ignores, configurable tuning.

---

## 16) Done Definition

Implementation is done when:
- class compiles,
- required unit tests pass,
- coverage target is met,
- event mapping and read/list behavior match this PRD,
- service can run independently from sync integration code.
