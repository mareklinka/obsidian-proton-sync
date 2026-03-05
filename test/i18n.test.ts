import { describe, expect, it } from 'vitest';

import { initI18n } from '../i18n';

describe('i18n fallback resolution', () => {
  it('falls back from region locale to base locale and English', () => {
    const service = initI18n('fr-CA');

    expect(service.t.commands.pushVault).toBe('Push vault to Proton Drive');
    expect(service.t.actions.notices.pushCompleted).toBe('Push completed.');
    expect(service.t.settings.title).toBe('Proton Drive Sync');
  });

  it('falls back to English for unknown locales', () => {
    const service = initI18n('xx-ZZ');

    expect(service.t.commands.pullVault).toBe('Pull vault from Proton Drive');
    expect(service.t.modals.login.title).toBe('Connect to Proton Drive');
  });
});
