import { Effect, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TreeEventScopeId } from '../services/proton-drive-types';

const subscribeToTreeEventsMock = vi.hoisted(() => vi.fn());
const getProtonDriveClientMock = vi.hoisted(() => vi.fn());
const getObsidianSettingsStoreMock = vi.hoisted(() => vi.fn());
const settingsSetMock = vi.hoisted(() => vi.fn());
const loggerInfoMock = vi.hoisted(() => vi.fn());

vi.mock('../proton/drive/ProtonDriveClient', () => ({
  getProtonDriveClient: getProtonDriveClientMock
}));

vi.mock('../services/ObsidianSettingsStore', () => ({
  getObsidianSettingsStore: getObsidianSettingsStoreMock
}));

vi.mock('../services/ConsoleLogger', () => ({
  getLogger: () => ({
    info: loggerInfoMock
  })
}));

describe('ProtonCloudObserver', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    getProtonDriveClientMock.mockReturnValue({
      subscribeToTreeEvents: subscribeToTreeEventsMock
    });

    getObsidianSettingsStoreMock.mockReturnValue({
      set: settingsSetMock
    });
  });

  it('throws when getting observer before initialization', async () => {
    const mod = await import('../services/ProtonCloudObserver');

    expect(() => mod.getProtonCloudObserver()).toThrowError(/has not been initialized/i);
  });

  it('returns singleton instance from init/get', async () => {
    const mod = await import('../services/ProtonCloudObserver');

    const first = mod.initProtonCloudObserver();
    const second = mod.initProtonCloudObserver();
    const fromGet = mod.getProtonCloudObserver();

    expect(first).toBe(second);
    expect(fromGet).toBe(first);
    expect(getProtonDriveClientMock).toHaveBeenCalledTimes(1);
  });

  it('subscribes to tree events, emits cloudEvents, and persists latest event id', async () => {
    const mod = await import('../services/ProtonCloudObserver');

    const subscription = { dispose: vi.fn() };
    subscribeToTreeEventsMock.mockResolvedValue(subscription);

    const observer = mod.initProtonCloudObserver();
    const cloudEventListener = vi.fn();
    const cloudSubscription = observer.cloudEvents.subscribe(cloudEventListener);

    const nodeId = new TreeEventScopeId('scope-123');
    await Effect.runPromise(observer.subscribeToTreeChanges(nodeId));

    expect(subscribeToTreeEventsMock).toHaveBeenCalledTimes(1);
    expect(subscribeToTreeEventsMock).toHaveBeenCalledWith('scope-123', expect.any(Function));

    const callback = subscribeToTreeEventsMock.mock.calls[0]?.[1] as
      | ((event: { eventId: string }) => Promise<void>)
      | undefined;
    if (!callback) {
      throw new Error('Expected tree event callback to be registered.');
    }

    await callback({ eventId: 'evt-abc' });

    expect(cloudEventListener).toHaveBeenCalledTimes(1);
    expect(settingsSetMock).toHaveBeenCalledTimes(1);
    expect(settingsSetMock).toHaveBeenCalledWith('latestEventId', expect.anything());

    const latestEventIdArg: Option.Option<{ eventId: string }> = settingsSetMock.mock.calls[0]?.[1];
    expect(Option.isSome(latestEventIdArg)).toBe(true);
    if (Option.isSome(latestEventIdArg)) {
      expect(latestEventIdArg.value.eventId).toBe('evt-abc');
    }

    cloudSubscription.unsubscribe();
  });

  it('maps subscription failures to TreeEventSubscriptionFailed', async () => {
    const mod = await import('../services/ProtonCloudObserver');

    subscribeToTreeEventsMock.mockRejectedValue(new Error('boom'));

    const observer = mod.initProtonCloudObserver();

    const result = await Effect.runPromise(
      Effect.either(observer.subscribeToTreeChanges(new TreeEventScopeId('scope-fail')))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({ _tag: 'TreeEventSubscriptionFailed' });
    }
  });

  it('disposes active subscription when unsubscribing and is safe to call twice', async () => {
    const mod = await import('../services/ProtonCloudObserver');

    const dispose = vi.fn();
    subscribeToTreeEventsMock.mockResolvedValue({ dispose });

    const observer = mod.initProtonCloudObserver();
    await Effect.runPromise(observer.subscribeToTreeChanges(new TreeEventScopeId('scope-dispose')));

    observer.unsubscribeFromTreeChanges();
    observer.unsubscribeFromTreeChanges();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
