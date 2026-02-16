# PRD: Local Vault Indexer

## Overview
Build a local index of vault files and folders for sync comparison.

## Goals
- Enumerate vault contents with metadata needed for sync.
- Provide incremental updates when files change.

## Non-Goals
- Remote API interaction.
- Conflict resolution.

## User Stories
- As a user, I want changes in my vault to be detected efficiently.

## Requirements
- Scan the vault to collect:
  - path
  - type (file/folder)
  - size
  - modified time
  - content hash (optional/feature-flagged)
- Ignore Obsidian internal files unless explicitly configured.
- Provide APIs to query current index and mark last-synced state.

## Data Model
- LocalEntry:
  - path
  - type
  - size
  - mtime
  - hash (optional)

## UX/Settings
- Option to exclude paths (glob patterns).

## Risks/Notes
- Hashing large files is expensive; consider lazy or size-based hashing.

## Acceptance Criteria
- Index can be built for entire vault.
- Index updates correctly on file changes (create/update/delete).
