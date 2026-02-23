import { Subject } from 'rxjs';
import { getLogger } from './ObsidianSyncLogger';
import { ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonDriveError, ProtonId } from './proton-drive-types';
import { Effect } from 'effect';

export const { init: initProtonCloudObserver, get: getProtonCloudObserver } = (function () {
  let instance: ProtonCloudObserver | null = null;

  return {
    init: function initProtonCloudObserver(client: ProtonDriveClient): ProtonCloudObserver {
      return (instance ??= new ProtonCloudObserver(client));
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

  public subscribeToTreeChanges(nodeId: ProtonId): Effect.Effect<void, ProtonDriveError> {
    return Effect.tryPromise({
      try: async () => {
        this.client.subscribeToTreeEvents(nodeId.uid, async cloudEvent => {
          this.logger.info(`Received cloud event for node ${nodeId.uid}`, cloudEvent);
          this.cloudEventSubject.next();
        });
      },
      catch: () => {
        throw new ProtonDriveError('TreeSubscriptionFailed');
      }
    });
  }
}
