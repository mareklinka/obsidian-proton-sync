import { describe, expect, it } from 'vitest';

import { LocalChangeSuppressionService } from '../services/LocalChangeSuppressionService';

describe('LocalChangeSuppressionService', () => {
  it('suppresses exact locked paths and releases correctly', () => {
    const service = new LocalChangeSuppressionService();

    const lock = service.acquirePathLock('notes/a.md');

    expect(service.shouldSuppress('notes/a.md')).toBe(true);
    expect(service.shouldSuppress('notes/b.md')).toBe(false);

    lock.release();

    expect(service.shouldSuppress('notes/a.md')).toBe(false);
  });

  it('suppresses descendants for subtree locks', () => {
    const service = new LocalChangeSuppressionService();

    const lock = service.acquirePathLock('notes/archive', { subtree: true });

    expect(service.shouldSuppress('notes/archive')).toBe(true);
    expect(service.shouldSuppress('notes/archive/2026/today.md')).toBe(true);
    expect(service.shouldSuppress('notes/other.md')).toBe(false);

    lock.release();
    expect(service.shouldSuppress('notes/archive/2026/today.md')).toBe(false);
  });

  it('suppresses alias paths and oldPath checks for moves', () => {
    const service = new LocalChangeSuppressionService();

    const lock = service.acquirePathLock('new-root', {
      subtree: true,
      aliasPaths: ['old-root']
    });

    expect(service.shouldSuppress('new-root/a.md')).toBe(true);
    expect(service.shouldSuppress('other.md', 'old-root/a.md')).toBe(true);
    expect(service.shouldSuppress('other.md')).toBe(false);

    lock.release();
    expect(service.shouldSuppress('new-root/a.md')).toBe(false);
  });
});
