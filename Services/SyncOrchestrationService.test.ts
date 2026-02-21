import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';

import { SyncOrchestrationService, type OrchestrationState } from './SyncOrchestrationService';
import { SettingsService } from './SettingsService';
import { SyncIndexStateService } from './SyncIndexStateService';
import { DEFAULT_SETTINGS, type ProtonDriveSyncSettings } from '../model/settings';
import type { ProtonSessionState } from '../proton/auth/ProtonSessionService';
import type { ReconcileState } from './CloudReconciliationService';
import type { ReaderChangeEvent } from '../isolated-sync/ObsidianVaultFileSystemReader';
import type {
  SyncDispatchResult,
  SyncEngineState,
  SyncIndexSnapshot,
  SyncIndexSnapshotEvent
} from '../isolated-sync/RxSyncService';

vi.mock('../sync-root', () => ({
  ensureSyncRoots: vi.fn(async () => ({
    vaultName: 'TestVault',
    containerNodeUid: 'container-uid',
    vaultRootNodeUid: 'vault-root-uid'
  }))
}));

function createSettingsService(initial?: Partial<ProtonDriveSyncSettings>): SettingsService {
  return new SettingsService(
    {
      ...DEFAULT_SETTINGS,
      ...(initial ?? {})
    },
    async () => {}
  );
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createReader() {
  const changes$ = new Subject<ReaderChangeEvent>();

  return {
    changes$,
    start: vi.fn(),
    dispose: vi.fn(),
    emit: (change: ReaderChangeEvent) => {
      changes$.next(change);
    }
  };
}

function createSyncService() {
  const dispatchResults$ = new Subject<SyncDispatchResult>();
  const mapChanges$ = new Subject<SyncIndexSnapshotEvent>();
  const syncState$ = new BehaviorSubject<SyncEngineState>('idle');

  return {
    dispatchResults$,
    mapChanges$,
    syncState$,
    initializeIndex: vi.fn(),
    start: vi.fn(),
    dispose: vi.fn(),
    enqueueChange: vi.fn(() => 'chg-test')
  };
}

describe('SyncOrchestrationService', () => {
  let sessionSubject: Subject<ProtonSessionState>;
  let settingsService: SettingsService;
  let logger: ReturnType<typeof createLogger>;
  let reader: ReturnType<typeof createReader>;
  let syncService: ReturnType<typeof createSyncService>;
  let reconcileStateSubject: BehaviorSubject<ReconcileState>;
  let syncIndexStateService: SyncIndexStateService;

  beforeEach(() => {
    sessionSubject = new Subject<ProtonSessionState>();
    settingsService = createSettingsService();
    logger = createLogger();
    reader = createReader();
    syncService = createSyncService();
    reconcileStateSubject = new BehaviorSubject<ReconcileState>('idle');
    syncIndexStateService = new SyncIndexStateService(settingsService);
  });

  it('transitions to queue-ready and unauthenticated on disconnected restore', async () => {
    const service = new SyncOrchestrationService({
      vault: {
        getName: () => 'TestVault'
      } as never,
      logger: logger as never,
      settingsService,
      syncIndexStateService,
      sessionService: {
        currentSession$: sessionSubject.asObservable(),
        loadSession: vi.fn(async () => {
          sessionSubject.next({ state: 'disconnected' });
        })
      } as never,
      cloudReconciliationService: {
        state$: reconcileStateSubject.asObservable(),
        reset: vi.fn(),
        dispose: vi.fn(),
        shouldSuppressLocalChange: vi.fn(() => false),
        run: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
        runInitialReconciliation: vi.fn(async () => ({ byPath: {}, byCloudId: {} }) as SyncIndexSnapshot),
        ensureCloudEventSubscription: vi.fn(async () => {})
      } as never,
      getDriveClient: () => null,
      createReader: () => reader as never,
      createSyncService: () => syncService as never,
      maxBufferedChanges: 100
    });

    const states: OrchestrationState[] = [];
    const sub = service.lifecycleState$.subscribe(state => {
      states.push(state);
    });

    await service.start();

    expect(states).toContain('queue-ready');
    expect(states[states.length - 1]).toBe('unauthenticated');

    sub.unsubscribe();
    await service.dispose();
  });

  it('buffers local changes before auth and flushes after cloud initialization', async () => {
    const runInitialReconciliation = vi.fn(async () => ({ byPath: {}, byCloudId: {} }) as SyncIndexSnapshot);

    const service = new SyncOrchestrationService({
      vault: {
        getName: () => 'TestVault'
      } as never,
      logger: logger as never,
      settingsService,
      syncIndexStateService,
      sessionService: {
        currentSession$: sessionSubject.asObservable(),
        loadSession: vi.fn(async () => {
          sessionSubject.next({ state: 'disconnected' });
        })
      } as never,
      cloudReconciliationService: {
        state$: reconcileStateSubject.asObservable(),
        reset: vi.fn(),
        dispose: vi.fn(),
        shouldSuppressLocalChange: vi.fn(() => false),
        run: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
        runInitialReconciliation,
        ensureCloudEventSubscription: vi.fn(async () => {})
      } as never,
      getDriveClient: () => ({}) as never,
      createReader: () => reader as never,
      createSyncService: () => syncService as never,
      maxBufferedChanges: 100
    });

    await service.start();

    reader.emit({
      type: 'file-edited',
      entityType: 'file',
      path: 'foo.md',
      occurredAt: Date.now()
    });

    sessionSubject.next({
      state: 'ok',
      session: {
        uid: 'uid',
        userId: 'user',
        accessToken: 'token',
        refreshToken: 'refresh',
        scope: 'scope',
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        lastRefreshAt: new Date()
      }
    });

    for (let attempt = 0; attempt < 10 && runInitialReconciliation.mock.calls.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    expect(runInitialReconciliation).toHaveBeenCalledTimes(1);
    expect(syncService.initializeIndex).toHaveBeenCalledTimes(1);
    expect(syncService.start).toHaveBeenCalledTimes(1);
    expect(syncService.enqueueChange).toHaveBeenCalled();

    await service.dispose();
  });
});
