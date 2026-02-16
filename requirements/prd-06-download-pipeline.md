# PRD: Download Pipeline

## Overview
Download remote files/folders from Proton Drive into the vault.

## Goals
- Fetch file contents and write to vault paths.
- Preserve metadata where possible.

## Non-Goals
- Upload logic.

## User Stories
- As a user, I want changes on Proton Drive to appear in my vault.

## Requirements
- Create missing folders locally.
- Download file content and write to vault.
- Update local index and sync state.
- Handle binary files and attachments.

## Data Model
- DownloadResult:
  - path
  - revisionId

## UX/Settings
- Optional overwrite confirmation for conflicts.

## Risks/Notes
- Partial downloads should be recoverable.

## Acceptance Criteria
- Remote-only files appear locally with correct content.
- Sync state reflects new revision IDs.
