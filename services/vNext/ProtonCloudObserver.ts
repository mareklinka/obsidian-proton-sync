import { Subject } from 'rxjs';
import { getLogger } from './ObsidianSyncLogger';
import { ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonDriveError, ProtonId, TreeEventScopeId, TreeEventSubscriptionFailed } from './proton-drive-types';
import { Effect } from 'effect';
import { getProtonDriveClient } from '../../proton/drive/ProtonDriveClient';

export const { init: initProtonCloudObserver, get: getProtonCloudObserver } = (function () {
  let instance: ProtonCloudObserver | null = null;

  return {
    init: function initProtonCloudObserver(): ProtonCloudObserver {
      return (instance ??= new ProtonCloudObserver(getProtonDriveClient()));
    },
    get: function getProtonCloudObserver(): ProtonCloudObserver {
      if (!instance) {
        throw new Error('ProtonCloudObserver has not been initialized. Please call initProtonCloudObserver first.');
      }
      return instance;
    }
  };
})();

class ProtonCloudObserver {
  private readonly logger = getLogger('ProtonCloudObserver');

  private readonly cloudEventSubject = new Subject<void>();
  public readonly cloudEvents = this.cloudEventSubject.asObservable();

  public constructor(private readonly client: ProtonDriveClient) {}

  public subscribeToTreeChanges(nodeId: TreeEventScopeId): Effect.Effect<void, TreeEventSubscriptionFailed> {
    return Effect.tryPromise({
      try: async () => {
        this.client.subscribeToTreeEvents(nodeId.treeEventScopeId, async cloudEvent => {
          this.logger.info(`Received cloud event for node ${nodeId.treeEventScopeId}`, cloudEvent);
          this.cloudEventSubject.next();
        });
      },
      catch: () => {
        return new TreeEventSubscriptionFailed();
      }
    });
  }
}
