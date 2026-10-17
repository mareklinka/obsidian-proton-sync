import { describe, expect, it } from 'vitest';

import { safeApiDiagnostic } from '../proton/drive/SafeApiDiagnostic';

describe('safe API diagnostics', () => {
  it('reports fixed validation categories without echoing server data', () => {
    const result = safeApiDiagnostic(
      JSON.stringify({
        ['Code']: 200501,
        ['Error']: 'Could not verify ContentKeyPacket signature for person@example.com secret-token'
      })
    );
    expect(result).toBe(', API code 200501; validation: content key packet, signature, verification');
  });

  it('does not include unknown messages, nested data, or malformed responses', () => {
    expect(safeApiDiagnostic('{"Error":"secret-token","Details":{"token":"secret"}}')).toBe('');
    expect(safeApiDiagnostic('not json secret')).toBe('');
    expect(safeApiDiagnostic('{"Code":"secret-token"}')).toBe('');
  });
});
