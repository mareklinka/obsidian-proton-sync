import { MaybeNode, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import type { Vault } from 'obsidian';
import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';

import { CloudReconciliationService, type ReconcileState } from './CloudReconciliationService';
import type { ObsidianVaultFileSystemReader, ReaderChangeEvent } from './ObsidianVaultFileSystemReader';
import type {
  ObsidianSyncService,
  SyncDispatchResult,
  SyncEngineState,
  SyncIndexSnapshot,
  SyncIndexSnapshotEvent
} from './ObsidianSyncService';
import type { PluginLogger } from '../logger';
import type { ProtonSessionService, ProtonSessionState } from '../proton/auth/ProtonSessionService';
import { SettingsService } from './SettingsService';
import { SyncIndexStateService } from './SyncIndexStateService';
import { LocalChangeSuppressionService } from './LocalChangeSuppressionService';

export type OrchestrationState =
  | 'starting'
  | 'auth-restoring'
  | 'queue-ready'
  | 'cloud-initializing'
  | 'running'
  | 'unauthenticated'
  | 'error';

export class SyncOrchestrationService {
  private readonly lifecycleSubject = new BehaviorSubject<OrchestrationState>('starting');
  private readonly syncStateSubject = new BehaviorSubject<SyncEngineState>('idle');

  public readonly lifecycleState$: Observable<OrchestrationState> = this.lifecycleSubject.asObservable();
  public readonly syncState$: Observable<SyncEngineState> = this.syncStateSubject.asObservable();
  public readonly reconcileState$: Observable<ReconcileState>;

  private readonly subscriptions: Subscription[] = [];
  private reader: ObsidianVaultFileSystemReader | null = null;
  private syncService: ObsidianSyncService | null = null;
  private pendingLocalChanges: ReaderChangeEvent[] = [];
  private queueReady = false;
  private pendingCloudInit = false;
  private cloudInitInProgress = false;
  private started = false;
  private disposed = false;

  constructor(private readonly input: SyncOrchestrationInput) {
    this.reconcileState$ = this.input.cloudReconciliationService.state$;
  }

  async start(): Promise<void> {
    if (this.disposed || this.started) {
      return;
    }

    this.started = true;
    this.lifecycleSubject.next('starting');

    this.subscriptions.push(
      this.input.sessionService.currentSession$.subscribe(session => {
        void this.handleSessionState(session);
      })
    );

    this.lifecycleSubject.next('auth-restoring');
    await this.input.sessionService.loadSession();

    this.initializeLocalQueueReader();
    this.queueReady = true;
    this.lifecycleSubject.next('queue-ready');

    if (this.pendingCloudInit) {
      void this.tryStartCloudInitialization();
    } else {
      this.lifecycleSubject.next('unauthenticated');
    }
  }

  async disconnect(): Promise<void> {
    this.pendingCloudInit = false;
    this.cloudInitInProgress = false;
    this.input.cloudReconciliationService.reset();
    this.disposeSyncService();
    await this.input.syncIndexStateService.clear();
    await this.input.settingsService.resetForDisconnect();
    this.lifecycleSubject.next('unauthenticated');
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.started = false;
    this.pendingCloudInit = false;
    this.cloudInitInProgress = false;

    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions.length = 0;

    this.disposeSyncService();
    this.reader?.dispose();
    this.reader = null;
    this.input.cloudReconciliationService.dispose();

    this.pendingLocalChanges = [];
    this.syncStateSubject.next('idle');
    this.syncStateSubject.complete();
    this.lifecycleSubject.complete();
  }

  getReader(): ObsidianVaultFileSystemReader | null {
    return this.reader;
  }

  getSyncService(): ObsidianSyncService | null {
    return this.syncService;
  }

  private async handleSessionState(session: ProtonSessionState): Promise<void> {
    await this.input.settingsService.applyAuthResult(session);

    if (session.state === 'ok') {
      this.pendingCloudInit = true;
      if (this.queueReady) {
        void this.tryStartCloudInitialization();
      }
      return;
    }

    if (session.state === 'disconnected' || session.state === 'logged-out') {
      this.pendingCloudInit = false;
      this.cloudInitInProgress = false;
      this.input.cloudReconciliationService.reset();
      this.disposeSyncService();
      if (this.queueReady) {
        this.lifecycleSubject.next('unauthenticated');
      }
    }
  }

  private initializeLocalQueueReader(): void {
    if (this.reader) {
      return;
    }

    this.reader = this.input.createReader();
    this.subscriptions.push(
      this.reader.changes$.subscribe(change => {
        this.handleLocalChange(change);
      })
    );
    this.reader.start();
  }

  private handleLocalChange(change: ReaderChangeEvent): void {
    if (this.input.localChangeSuppressionService.shouldSuppress(change.path, change.oldPath)) {
      this.input.logger.debug('Suppressed local change generated by remote apply', {
        type: change.type,
        path: change.path,
        oldPath: change.oldPath
      });
      return;
    }

    if (!this.syncService) {
      this.bufferLocalChange(change);
      return;
    }

    const changeId = this.syncService.enqueueChange(change);
    this.input.logger.debug('Isolated sync change enqueued', {
      changeId,
      type: change.type,
      path: change.path,
      oldPath: change.oldPath
    });
  }

  private bufferLocalChange(change: ReaderChangeEvent): void {
    this.pendingLocalChanges.push(change);

    if (this.pendingLocalChanges.length > this.input.maxBufferedChanges) {
      this.pendingLocalChanges.shift();
      this.input.logger.warn('Dropped oldest buffered local change due to buffer limit', {
        maxBufferedChanges: this.input.maxBufferedChanges
      });
    }
  }

  private async tryStartCloudInitialization(): Promise<void> {
    if (!this.canStartCloudInitialization()) {
      return;
    }

    const driveClient = this.input.getDriveClient();
    if (!driveClient) {
      return;
    }

    this.cloudInitInProgress = true;
    this.lifecycleSubject.next('cloud-initializing');

    try {
      await this.runCloudInitialization();
    } catch (error) {
      this.lifecycleSubject.next('error');
      this.input.logger.error('Failed to initialize cloud sync orchestration', {}, error);
    } finally {
      this.cloudInitInProgress = false;
    }
  }

  private canStartCloudInitialization(): boolean {
    return !this.cloudInitInProgress && this.pendingCloudInit && this.queueReady && !this.disposed;
  }

  private async runCloudInitialization(): Promise<void> {
    const { snapshot: initialSnapshot, vaultRootNodeUid } =
      await this.input.cloudReconciliationService.setupCloudIntegration();
    this.initializeSyncService(vaultRootNodeUid, initialSnapshot);
    this.flushBufferedChanges();

    this.pendingCloudInit = false;
    this.lifecycleSubject.next('running');
    this.input.logger.info('Sync roots ready');
  }

  private initializeSyncService(vaultRootNodeUid: string, initialSnapshot: SyncIndexSnapshot): void {
    this.disposeSyncService();

    if (!this.reader) {
      throw new Error('Reader must be initialized before creating sync service.');
    }

    this.syncService = this.input.createSyncService(vaultRootNodeUid, this.reader);
    this.syncService.initializeIndex(initialSnapshot ?? this.input.syncIndexStateService.snapshot());

    this.subscriptions.push(
      this.syncService.dispatchResults$.subscribe(result => {
        this.handleDispatchResult(result);
      }),
      this.syncService.mapChanges$.subscribe(event => {
        void this.handleMapChange(event);
      }),
      this.syncService.syncState$.subscribe(state => {
        this.syncStateSubject.next(state);
      })
    );

    this.syncService.start();
    this.input.logger.info('Isolated sync queue initialized with Proton cloud service');
  }

  private flushBufferedChanges(): void {
    if (!this.syncService || this.pendingLocalChanges.length === 0) {
      return;
    }

    for (const change of this.pendingLocalChanges) {
      if (this.input.localChangeSuppressionService.shouldSuppress(change.path, change.oldPath)) {
        continue;
      }

      const changeId = this.syncService.enqueueChange(change);
      this.input.logger.debug('Flushed buffered local change into sync queue', {
        changeId,
        type: change.type,
        path: change.path,
        oldPath: change.oldPath
      });
    }

    this.pendingLocalChanges = [];
  }

  private disposeSyncService(): void {
    if (!this.syncService) {
      this.syncStateSubject.next('idle');
      return;
    }

    this.syncService.dispose();
    this.syncService = null;
    this.syncStateSubject.next('idle');
  }

  private handleDispatchResult(result: SyncDispatchResult): void {
    if (result.success) {
      this.input.logger.info('Isolated sync operation dispatched to Proton Drive', {
        changeId: result.changeId
      });
      return;
    }

    this.input.logger.warn('Isolated sync operation failed', {
      changeId: result.changeId,
      retryScheduled: result.retryScheduled,
      errorMessage: result.errorMessage
    });
  }

  private async handleMapChange(event: SyncIndexSnapshotEvent): Promise<void> {
    await this.input.syncIndexStateService.applySnapshot(event.snapshot);

    this.input.logger.debug('Isolated sync index snapshot updated', {
      sequence: event.seq,
      reason: event.reason,
      byPathCount: Object.keys(event.snapshot.byPath).length,
      byCloudIdCount: Object.keys(event.snapshot.byCloudId).length
    });
  }
}

type SyncOrchestrationInput = {
  vault: Vault;
  logger: PluginLogger;
  settingsService: SettingsService;
  syncIndexStateService: SyncIndexStateService;
  sessionService: ProtonSessionService;
  cloudReconciliationService: CloudReconciliationService;
  localChangeSuppressionService: LocalChangeSuppressionService;
  getDriveClient: () => ProtonDriveClient | null;
  createReader: () => ObsidianVaultFileSystemReader;
  createSyncService: (vaultRootNodeUid: string, reader: ObsidianVaultFileSystemReader) => ObsidianSyncService;
  maxBufferedChanges: number;
};
