# PRD: Diff Engine & Conflict Resolution

## Overview
Compare local and remote indexes to decide sync actions and resolve conflicts.

## Goals
- Produce a deterministic sync plan.
- Handle edits on both sides safely.

## Non-Goals
- Actual file transfer.

## User Stories
- As a user, I want my changes synced without losing data.

## Requirements
- Compute diff between local and remote entries.
- Identify:
  - local-only → upload
  - remote-only → download
  - modified on one side → update
  - modified on both sides → conflict
- Conflict strategy options:
  - create conflict files
  - last-write-wins
  - manual resolution (future)

## Data Model
- SyncAction:
  - type (upload/download/delete/conflict)
  - path
  - reason
  - localMeta
  - remoteMeta

## UX/Settings
- Select conflict strategy.

## Risks/Notes
- Clock drift can mislead mtime comparisons; prefer revision IDs + hashes.

## Acceptance Criteria
- Diff output is stable and reproducible for same inputs.
- Conflicts are detected and surfaced.
