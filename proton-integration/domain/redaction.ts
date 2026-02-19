const SENSITIVE_KEY_PARTS = [
  'password',
  'passphrase',
  'token',
  'proof',
  'secret',
  'refresh',
  'access',
  '2fa',
  'twofactor',
  'two_factor',
  'srp',
  'authorization'
];

const REDACTED = '[REDACTED]';

export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const [user, domain] = trimmed.split('@');
  if (!user || !domain) {
    return trimmed;
  }

  if (user.length === 1) {
    return `*@${domain}`;
  }

  if (user.length === 2) {
    return `${user[0]}*@${domain}`;
  }

  return `${user[0]}***${user[user.length - 1]}@${domain}`;
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(entry => redactValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeErrorMessage(value.message)
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const keyLower = key.toLowerCase();
    if (SENSITIVE_KEY_PARTS.some(part => keyLower.includes(part))) {
      output[key] = REDACTED;
      continue;
    }

    if (keyLower.includes('email') && typeof entry === 'string') {
      output[key] = maskEmail(entry);
      continue;
    }

    output[key] = redactValue(entry);
  }

  return output;
}

export function redactMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  return redactValue(meta) as Record<string, unknown>;
}

export function sanitizeErrorMessage(message: string): string {
  if (!message) {
    return 'Operation failed.';
  }

  if (/token|password|passphrase|proof|secret|authorization|2fa/i.test(message)) {
    return 'Operation failed due to a secure authentication error.';
  }

  return message;
}
