# PRD: UI, Status & Settings

## Overview
Provide UI for sync status, controls, and settings.

## Goals
- Make sync state visible and controllable.

## Non-Goals
- Implement sync logic.

## User Stories
- As a user, I want to see last sync time and errors.
- As a user, I want to trigger sync manually.

## Requirements
- Status display: connected/disconnected, last sync time, last error.
- Manual sync button.
- Settings for:
  - sync direction
  - conflict strategy
  - auto-sync interval
  - exclusions

## UX/Settings
- Use standard Obsidian settings tab.
- Optional status bar indicator.

## Risks/Notes
- Status should update after sync completes.

## Acceptance Criteria
- UI reflects sync state and allows manual sync.
