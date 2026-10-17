/** Only Proton's verification page may receive the challenge token. */
export function getExternalCaptchaUrl(value: string): URL | null {
  try {
    const supplied = new URL(value);
    if (
      supplied.origin !== 'https://verify.proton.me' ||
      supplied.username ||
      supplied.password ||
      supplied.pathname !== '/'
    ) {
      return null;
    }

    const token = supplied.searchParams.get('token');
    const methods = supplied.searchParams.get('methods')?.split(',');
    if (!token?.trim() || !methods?.includes('captcha')) {
      return null;
    }

    // Do not carry embed/ForceWebMessaging: Proton only grants an external proof
    // when its verification page runs as a top-level page, outside an iframe.
    const external = new URL('https://verify.proton.me/');
    external.searchParams.set('methods', 'captcha');
    external.searchParams.set('token', token);
    return external;
  } catch {
    return null;
  }
}
