import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { EventSubscription } from '@protontech/drive-sdk/dist/internal/events';
import { Effect, Option } from 'effect';
import { Subject } from 'rxjs';

import { getProtonDriveClient } from '../proton/drive/ProtonDriveClient';
import { getLogger } from './ConsoleLogger';
import { getObsidianSettingsStore } from './ObsidianSettingsStore';
import type { TreeEventScopeId } from './proton-drive-types';
import { ProtonEventId, TreeEventSubscriptionFailed } from './proton-drive-types';

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

  private subscription: EventSubscription | null = null;

  public constructor(private readonly client: ProtonDriveClient) {}

  public subscribeToTreeChanges(nodeId: TreeEventScopeId): Effect.Effect<void, TreeEventSubscriptionFailed> {
    return Effect.tryPromise({
      try: async () => {
        this.unsubscribeFromTreeChanges();

        this.subscription = await this.client.subscribeToTreeEvents(nodeId.treeEventScopeId, async cloudEvent => {
          this.logger.info(`Received cloud event for node ${nodeId.treeEventScopeId}`, cloudEvent);
          getObsidianSettingsStore().set('latestEventId', Option.some(new ProtonEventId(cloudEvent.eventId)));
          this.cloudEventSubject.next();
        });
      },
      catch: () => {
        return new TreeEventSubscriptionFailed();
      }
    });
  }

  public unsubscribeFromTreeChanges(): void {
    if (this.subscription) {
      this.subscription.dispose();
      this.subscription = null;
    }
  }
}
