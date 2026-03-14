import { Data } from 'effect';

export type ConfigSyncError =
  | InvalidConfigPathError
  | VaultRootIdNotAvailableError
  | SyncAlreadyInProgressError
  | SyncCancelledError;

export class InvalidConfigPathError extends Data.TaggedError('InvalidConfigPathError') {}
export class VaultRootIdNotAvailableError extends Data.TaggedError('VaultRootIdNotAvailableError') {}
export class SyncAlreadyInProgressError extends Data.TaggedError('SyncAlreadyInProgressError') {}
export class SyncCancelledError extends Data.TaggedError('SyncCancelledError')<{ reason?: unknown }> {}
