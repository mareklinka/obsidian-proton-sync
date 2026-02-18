# File System Reader: Implementation Ticket Breakdown

This document translates `docs/filesystem-reader-prd.md` into atomic implementation tickets suitable for a coding AI agent.

## Delivery principles

- Keep implementation isolated (no sync-service integration yet).
- Keep logic minimal and explicit.
- Prefer test-first workflow.
- Every ticket must include tests unless explicitly stated otherwise.

---

## Ticket FR-01 — Create service skeleton and types

### Objective
Create the isolated service file and all public types/interfaces required by the PRD.

### Scope
- Add file: `isolated-sync/ObsidianVaultFileSystemReader.ts`
- Define and export:
  - `EntityType`
  - `ReaderChangeType`
  - `ReaderChangeEvent`
  - `FileDescriptor`
  - `FileMetadataDescriptor`
  - `FolderDescriptor`
  - `FileSystemReaderOptions`
  - `IFileSystemReaderService`
  - class `ObsidianVaultFileSystemReader`

### Notes
- `changes$` should be present as observable, even if initially no event wiring logic.
- Constructor should accept `vault: Vault` and `options?`.

### Acceptance criteria
- File compiles.
- All types and class signatures match PRD.

---

## Ticket FR-02 — Implement path helpers and ignore policy

### Objective
Implement minimal helper logic for normalization and ignore filtering.

### Scope
- Add internal helpers:
  - `normalizePath(path: string): string`
  - canonical key helper (case-insensitive option)
  - `isIgnored(path, entityType)` combining prefixes + predicate
- Defaults:
  - no ignored prefixes
  - no predicate
  - case-insensitive true

### Acceptance criteria
- Unit tests cover path normalization and ignore decision matrix.
- Ignore defaults do not suppress events/reads.

---

## Ticket FR-03 — Implement read methods

### Objective
Provide file/folder read and existence APIs using Vault.

### Scope
- Implement:
  - `readFile(path)`
  - `readFolder(path)`
  - `exists(path, entityType)`
- File read behavior:
  - text files via `vault.read`
  - binary via `vault.readBinary`
  - output type based on `binaryAsBlob` option
- Return `null` when path is missing or wrong type.

### Acceptance criteria
- Tests validate:
  - text file descriptor
  - binary file descriptor
  - missing path returns `null`
  - folder read success and non-folder returns `null`
  - `exists` true/false paths for both entity types

---

## Ticket FR-04 — Implement snapshot listing methods

### Objective
Expose bootstrap/reconciliation list APIs.

### Scope
- Implement:
  - `listFilesMetadata()` using `vault.getAllLoadedFiles()` + `TFile` filter
  - `listFolders()` using `vault.getAllLoadedFiles()` + `TFolder` filter
- Apply ignore filtering.

### Acceptance criteria
- Tests verify listing accuracy, type filtering, and ignore behavior.

---

## Ticket FR-05 — Add lifecycle management

### Objective
Implement idempotent lifecycle (`start`, `stop`, `dispose`) and event stream completion.

### Scope
- Internal state flags:
  - started/running
  - disposed
- `start()`:
  - register vault event handlers once
- `stop()`:
  - unregister all registered handlers
- `dispose()`:
  - stop, mark terminal, complete stream

### Acceptance criteria
- Tests verify:
  - `start()` idempotency
  - `stop()` idempotency
  - no emissions after stop/dispose
  - stream completes on dispose

---

## Ticket FR-06 — Implement Vault event mapping

### Objective
Map raw Vault events to normalized reader change events.

### Scope
- Handle events:
  - `create`
  - `modify`
  - `rename`
  - `delete`
- Mapping rules:
  - file create => `file-created`
  - file modify => `file-edited`
  - file delete => `file-deleted`
  - file rename => `file-moved` with `oldPath`
  - folder create => `folder-created`
  - folder delete => `folder-deleted`
  - folder rename same parent => `folder-renamed`
  - folder rename parent changed => `folder-moved`
- Include `occurredAt` from injected `now()`.

### Acceptance criteria
- Unit tests for all mapping permutations, especially rename classification.

---

## Ticket FR-07 — Error handling hardening

### Objective
Ensure malformed inputs/events do not crash service.

### Scope
- Guard invalid/empty paths.
- Guard unexpected event payloads.
- Ensure handler exceptions don’t break future emissions.

### Acceptance criteria
- Tests assert graceful handling of malformed payload cases.

---

## Ticket FR-08 — Add dedicated test harness for Vault adapter

### Objective
Make tests deterministic without Obsidian runtime.

### Scope
- Add test-only fake adapter or mocked Vault wrapper to simulate:
  - file tree lookup
  - text/binary reads
  - event subscription/unsubscription
  - event emission
- Keep this harness lightweight and reusable.

### Acceptance criteria
- All service tests run in Node test environment without Obsidian app runtime.

---

## Ticket FR-09 — Coverage and quality gate

### Objective
Meet quality target and verify build/test stability.

### Scope
- Run:
  - `npm test`
  - `npm run test:coverage`
- Ensure service file coverage target is met (>= 90% lines/branches).

### Acceptance criteria
- Coverage report demonstrates target for reader service file.
- Tests all pass.

---

## Suggested implementation order

1. FR-01
2. FR-02
3. FR-03
4. FR-04
5. FR-05
6. FR-06
7. FR-07
8. FR-08
9. FR-09

---

## Definition of done (for this ticket set)

- All tickets FR-01..FR-09 completed.
- PRD conformance verified against `docs/filesystem-reader-prd.md`.
- No integration changes to existing plugin runtime (`main.ts` sync wiring remains untouched).
- Test and coverage gates pass.

---

## Optional follow-up tickets (post-v1)

- FR-10: Add optional lifecycle observable (`lifecycle$`).
- FR-11: Add optional folder-recursive synthetic event mode.
- FR-12: Add optional periodic snapshot emission stream.
