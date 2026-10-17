import { describe, expect, it } from 'vitest';

import { getExternalCaptchaUrl } from '../proton/auth/CaptchaChallenge';

describe('external CAPTCHA challenge URL', () => {
  it('uses a top-level Proton page without embedded-mode or injected parameters', () => {
    const url = getExternalCaptchaUrl(
      'https://verify.proton.me/?methods=email,captcha&token=S-test%3Avalue' +
        '&embed=1&ForceWebMessaging=1&redirect=https://evil.test'
    );
    expect(url?.origin).toBe('https://verify.proton.me');
    if (!url) {
      throw new Error('Expected a trusted verification URL');
    }
    expect([...url.searchParams]).toEqual([
      ['methods', 'captcha'],
      ['token', 'S-test:value']
    ]);
  });

  it.each([
    'javascript:alert(1)',
    'http://verify.proton.me/?methods=captcha&token=test',
    'https://verify.proton.me.evil.test/?methods=captcha&token=test',
    'https://user:pass@verify.proton.me/?methods=captcha&token=test',
    'https://verify.proton.me:444/?methods=captcha&token=test',
    'https://verify.proton.me/elsewhere?methods=captcha&token=test',
    'https://evil.test/?methods=captcha&token=test',
    'https://verify.proton.me/?methods=captcha',
    'https://verify.proton.me/?methods=captcha&token=%20',
    'https://verify.proton.me/?methods=email&token=test',
    'not a URL'
  ])('rejects unsupported or untrusted verification links: %s', value => {
    expect(getExternalCaptchaUrl(value)).toBeNull();
  });
});
