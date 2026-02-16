# PRD: Sync State & Storage

## Overview
Persist sync state for incremental sync and recovery.

## Goals
- Store per-file sync metadata.
- Support resuming after restarts.

## Non-Goals
- UI settings.

## User Stories
- As a user, I want sync to resume without re-uploading everything.

## Requirements
- Store mapping between local path and remote node UID.
- Store last synced revision ID and hash (optional).
- Persist sync root info.
- Handle state migration if schema changes.

## Data Model
- SyncState:
  - vaultId
  - rootNodeUid
  - entries: { path, nodeUid, revisionId, hash, lastSyncedAt }

## UX/Settings
- Option to reset sync state.

## Risks/Notes
- Corrupted state must be recoverable.

## Acceptance Criteria
- Incremental sync uses stored state to avoid reprocessing unchanged files.
