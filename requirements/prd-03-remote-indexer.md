# PRD: Remote Drive Indexer

## Overview
Build a remote index of Proton Drive nodes under the sync root.

## Goals
- List nodes and gather metadata needed for diffing.
- Support paging and retry logic.

## Non-Goals
- Upload/download logic.
- Conflict resolution.

## User Stories
- As a user, I want the plugin to efficiently detect remote changes.

## Requirements
- Enumerate nodes under sync root:
  - node UID
  - path/name
  - type
  - size
  - modified time
  - revision ID
- Handle pagination and rate limits.
- Provide a stable mapping for path → node UID.

## Data Model
- RemoteEntry:
  - nodeUid
  - path
  - type
  - size
  - mtime
  - revisionId

## UX/Settings
- None.

## Risks/Notes
- Remote listing may be slow for large vaults; caching required.

## Acceptance Criteria
- Remote index built for sync root.
- Index rebuilds or updates on demand.
