# PRD: Delete Propagation

## Overview
Propagate deletions between local vault and Proton Drive.

## Goals
- Keep deletions consistent based on sync policy.

## Non-Goals
- Conflict resolution UI.

## User Stories
- As a user, deletions should sync to the other side according to my policy.

## Requirements
- Detect deletions from local and remote diffs.
- Support policy options:
  - bidirectional deletes
  - local-only deletes
  - remote-only deletes
- Apply delete operations safely (use trash/soft delete if available).

## UX/Settings
- Deletion policy selection.

## Risks/Notes
- Accidental deletes need recovery options.

## Acceptance Criteria
- Deletions are applied according to policy.
