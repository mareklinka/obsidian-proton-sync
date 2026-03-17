import bcrypt from 'bcryptjs';

const BCRYPT_BASE64_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function bcryptBase64Encode(input: Uint8Array, maxLength?: number): string {
  let output = '';
  let index = 0;

  while (index < input.length) {
    let c1 = input[index++];
    output += BCRYPT_BASE64_ALPHABET[(c1 >> 2) & 0x3f];
    c1 = (c1 & 0x03) << 4;

    if (index >= input.length) {
      output += BCRYPT_BASE64_ALPHABET[c1 & 0x3f];
      break;
    }

    const c2 = input[index++];
    c1 |= (c2 >> 4) & 0x0f;
    output += BCRYPT_BASE64_ALPHABET[c1 & 0x3f];
    c1 = (c2 & 0x0f) << 2;

    if (index >= input.length) {
      output += BCRYPT_BASE64_ALPHABET[c1 & 0x3f];
      break;
    }

    const c3 = input[index++];
    c1 |= (c3 >> 6) & 0x03;
    output += BCRYPT_BASE64_ALPHABET[c1 & 0x3f];
    output += BCRYPT_BASE64_ALPHABET[c3 & 0x3f];
  }

  if (typeof maxLength === 'number') {
    return output.slice(0, maxLength);
  }

  return output;
}

export function bcryptHashWithSalt(password: string, salt: string, rounds: number): string {
  const normalizedRounds = Math.max(4, Math.min(31, Math.trunc(rounds)));
  const roundsToken = normalizedRounds.toString().padStart(2, '0');

  try {
    return bcrypt.hashSync(password, `$2y$${roundsToken}$${salt}`);
  } catch {
    return bcrypt.hashSync(password, `$2b$${roundsToken}$${salt}`);
  }
}

export function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
