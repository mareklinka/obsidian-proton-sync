# PRD: Scheduling & Triggers

## Overview
Define when sync runs: manual, interval, and change-driven.

## Goals
- Provide reliable and configurable sync triggers.

## Non-Goals
- Sync logic itself.

## User Stories
- As a user, I want manual sync and optional automatic sync.

## Requirements
- Manual “Sync Now” action.
- Periodic sync interval (configurable).
- Optional filesystem watcher to queue sync on changes.
- Debounce rapid change bursts.

## UX/Settings
- Toggle auto-sync.
- Interval selection.

## Risks/Notes
- Frequent sync can increase API usage.

## Acceptance Criteria
- Sync can be triggered manually and automatically.
