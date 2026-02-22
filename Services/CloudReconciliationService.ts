import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { Vault } from 'obsidian';
import { BehaviorSubject, Subject, type Observable, type Subscription } from 'rxjs';

import { ReconciliationService } from './ReconciliationService';
import type { ObsidianVaultFileSystemReader } from './ObsidianVaultFileSystemReader';
import { normalizePath, toCanonicalPathKey } from './path-utils';
import type { ObsidianSyncService, SyncIndexSnapshot } from './ObsidianSyncService';
import type { PluginLogger } from '../logger';
import { SettingsService } from './SettingsService';
import { SyncIndexStateService } from './SyncIndexStateService';
import { LocalChangeSuppressionService } from './LocalChangeSuppressionService';

export type ReconcileState = 'idle' | 'reconciling' | 'error';

export class CloudReconciliationService {
  private readonly stateSubject = new BehaviorSubject<ReconcileState>('idle');
  private readonly reconcileRequests = new Subject<void>();
  private readonly subscriptions: Subscription[] = [];
  private reconcileInProgress = false;
  private reconcileQueued = false;
  private cloudEventSubscription: { dispose(): void } | null = null;

  public readonly state$: Observable<ReconcileState> = this.stateSubject.asObservable();

  constructor(
    private readonly input: {
      getDriveClient: () => ProtonDriveClient | null;
      logger: PluginLogger;
      vault: Vault;
      settingsService: SettingsService;
      syncIndexStateService: SyncIndexStateService;
      getSyncReader: () => ObsidianVaultFileSystemReader | null;
      getSyncService: () => ObsidianSyncService | null;
      localChangeSuppressionService: LocalChangeSuppressionService;
    }
  ) {
    this.subscriptions.push(
      this.reconcileRequests.subscribe(() => {
        if (this.reconcileInProgress) {
          this.reconcileQueued = true;
          return;
        }

        this.reconcileInProgress = true;
        void this.drainReconciliationRequests();
      })
    );
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.stateSubject.next('reconciling');

    try {
      const result = await operation();
      this.stateSubject.next('idle');
      return result;
    } catch (error) {
      this.stateSubject.next('error');
      throw error;
    }
  }

  async ensureCloudEventSubscription(): Promise<void> {
    if (this.cloudEventSubscription) {
      return;
    }

    const driveClient = this.input.getDriveClient();
    const { vaultRootNodeUid } = this.input.settingsService.getSyncRoots();

    if (!driveClient || !vaultRootNodeUid) {
      return;
    }

    const rootNode = await driveClient.getNode(vaultRootNodeUid);
    if (!rootNode.ok) {
      this.input.logger.warn('Cannot subscribe to cloud tree events: failed to load vault root node', {
        error: String(rootNode.error)
      });
      return;
    }

    const treeEventScopeId = rootNode.value.treeEventScopeId;
    this.cloudEventSubscription = await driveClient.subscribeToTreeEvents(treeEventScopeId, async event => {
      await this.input.settingsService.recordLatestEventId(event);
      this.input.logger.debug('Received Proton tree event', {
        type: (event as { type?: string }).type,
        eventId: (event as { eventId?: string }).eventId
      });

      this.requestReconciliationPass();
    });

    this.input.logger.info('Subscribed to Proton tree events', { treeEventScopeId });
  }

  async runInitialReconciliation(vaultRootNodeUid: string): Promise<SyncIndexSnapshot> {
    const reconciliationResult = await this.executeReconciliation(vaultRootNodeUid);

    this.input.logger.info('Initial reconciliation completed', {
      ...reconciliationResult.stats
    });

    return reconciliationResult.snapshot;
  }

  private async runCloudReconciliationPass(): Promise<void> {
    const driveClient = this.input.getDriveClient();
    const { vaultRootNodeUid } = this.input.settingsService.getSyncRoots();
    const syncReader = this.input.getSyncReader();
    const syncService = this.input.getSyncService();

    if (!driveClient || !vaultRootNodeUid || !syncReader || !syncService) {
      return;
    }

    const before = this.captureLocalPaths();
    this.input.localChangeSuppressionService.beginRemoteApply();

    try {
      const reconciliationResult = await this.executeReconciliation(vaultRootNodeUid);

      syncService.stop();
      syncService.initializeIndex(reconciliationResult.snapshot);
      syncService.start();

      const after = this.captureLocalPaths();
      this.input.localChangeSuppressionService.markSuppressedPaths(this.diffTouchedLocalPaths(before, after));

      this.input.logger.info('Applied cloud reconciliation pass', {
        ...reconciliationResult.stats
      });
    } catch (error) {
      this.input.logger.error('Cloud reconciliation pass failed', {}, error);
      throw error;
    } finally {
      this.input.localChangeSuppressionService.endRemoteApply();
    }
  }

  private requestReconciliationPass(): void {
    if (this.reconcileInProgress) {
      this.reconcileQueued = true;
      return;
    }

    this.reconcileRequests.next();
  }

  private async drainReconciliationRequests(): Promise<void> {
    try {
      do {
        this.reconcileQueued = false;

        try {
          await this.run(async () => {
            await this.runCloudReconciliationPass();
          });
        } catch {
          // Errors are already logged and reflected via reconcile state.
        }
      } while (this.reconcileQueued);
    } finally {
      this.reconcileInProgress = false;
    }
  }

  private async executeReconciliation(
    vaultRootNodeUid: string
  ): Promise<Awaited<ReturnType<ReconciliationService['run']>>> {
    const driveClient = this.input.getDriveClient();
    if (!driveClient) {
      throw new Error('Drive client unavailable for reconciliation');
    }

    const previousSnapshot = this.input.syncIndexStateService.snapshot();
    const tombstones = this.input.settingsService.getReconciliationTombstones();
    const reconciliation = new ReconciliationService(
      this.input.vault,
      driveClient,
      vaultRootNodeUid,
      this.input.logger,
      {
        previousSnapshot,
        tombstones
      }
    );

    const reconciliationResult = await reconciliation.run();

    await this.input.syncIndexStateService.applySnapshot(reconciliationResult.snapshot);
    await this.input.settingsService.setReconciliationTombstones(reconciliationResult.tombstones);

    return reconciliationResult;
  }

  private captureLocalPaths(): Set<string> {
    const paths = new Set<string>();

    for (const entry of this.input.vault.getAllLoadedFiles()) {
      const normalized = normalizePath(entry.path ?? '');
      if (!normalized) {
        continue;
      }

      paths.add(toCanonicalPathKey(normalized));
    }

    return paths;
  }

  private diffTouchedLocalPaths(before: Set<string>, after: Set<string>): string[] {
    const touched = new Set<string>();

    for (const path of before) {
      if (!after.has(path)) {
        touched.add(path);
      }
    }

    for (const path of after) {
      if (!before.has(path)) {
        touched.add(path);
      }
    }

    return Array.from(touched);
  }

  reset(): void {
    this.cloudEventSubscription?.dispose();
    this.cloudEventSubscription = null;
    this.input.localChangeSuppressionService.reset();
    this.reconcileInProgress = false;
    this.reconcileQueued = false;
    this.stateSubject.next('idle');
  }

  dispose(): void {
    this.cloudEventSubscription?.dispose();
    this.cloudEventSubscription = null;
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions.length = 0;
    this.reconcileRequests.complete();
    this.stateSubject.complete();
  }
}
