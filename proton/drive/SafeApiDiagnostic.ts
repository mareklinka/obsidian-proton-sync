/** Report fixed validation categories without copying server text or account data. */
export function safeApiDiagnostic(text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const code = typeof body['Code'] === 'number' ? `, API code ${body['Code']}` : '';
    const message = typeof body['Error'] === 'string' ? body['Error'].toLowerCase() : '';
    const categories: Array<[RegExp, string]> = [
      [/content.?key.?packet/, 'content key packet'],
      [/node.?key/, 'node key'],
      [/passphrase/, 'passphrase'],
      [/signature/, 'signature'],
      [/verif/, 'verification'],
      [/aead/, 'AEAD'],
      [/format/, 'format'],
      [/not enabled/, 'not enabled'],
      [/already exists/, 'already exists'],
      [/quota|storage.*full|space/, 'storage quota'],
      [/mime/, 'media type'],
      [/permission|access denied/, 'permission'],
      [/invalid/, 'invalid'],
      [/retry/, 'retry requested']
    ];
    const hints = categories.filter(([pattern]) => pattern.test(message)).map(([, label]) => label);
    return code + (hints.length ? `; validation: ${hints.join(', ')}` : '');
  } catch {
    return '';
  }
}
