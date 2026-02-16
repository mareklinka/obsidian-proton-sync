# PRD: Upload Pipeline

## Overview
Upload local files/folders to Proton Drive under the sync root.

## Goals
- Create folders and upload files reliably.
- Use the Drive SDK crypto module for encryption.

## Non-Goals
- Download logic.

## User Stories
- As a user, I want new or changed local files to appear in Proton Drive.

## Requirements
- Create missing folders before file uploads.
- Upload file contents with metadata.
- Retry on transient errors.
- Update local sync state with remote revision IDs.

## Data Model
- UploadResult:
  - path
  - nodeUid
  - revisionId

## UX/Settings
- Optional bandwidth/throttle limits.

## Risks/Notes
- Large files may require chunked upload.

## Acceptance Criteria
- Uploaded files appear in Proton Drive with correct structure.
- Sync state reflects new revision IDs.
