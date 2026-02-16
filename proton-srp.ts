import { md5 } from '@noble/hashes/legacy';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex } from '@noble/hashes/utils';
import bcrypt from 'bcryptjs';
import * as openpgp from 'openpgp';
import { PluginLogger } from './logger';

export interface ProtonAuthInfo {
  Version: number;
  Modulus: string;
  ServerEphemeral: string;
  Salt: string;
  SRPSession: string;
  TwoFA?: {
    Enabled: number;
  };
}

export interface ProtonSrpProofs {
  clientProof: Uint8Array;
  clientEphemeral: Uint8Array;
  expectedServerProof: Uint8Array;
  sharedSession: Uint8Array;
}

export interface ProtonSrpProofsBase64 {
  clientProof: string;
  clientEphemeral: string;
  expectedServerProof: string;
  sharedSession: string;
}

const MODULUS_PUBKEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

xjMEXAHLgxYJKwYBBAHaRw8BAQdAFurWXXwjTemqjD7CXjXVyKf0of7n9Ctm
L8v9enkzggHNEnByb3RvbkBzcnAubW9kdWx1c8J3BBAWCgApBQJcAcuDBgsJ
BwgDAgkQNQWFxOlRjyYEFQgKAgMWAgECGQECGwMCHgEAAPGRAP9sauJsW12U
MnTQUZpsbJb53d0Wv55mZIIiJL2XulpWPQD/V6NglBd96lZKBmInSXX/kXat
Sv+y0io+LR8i2+jV+AbOOARcAcuDEgorBgEEAZdVAQUBAQdAeJHUz1c9+KfE
kSIgcBRE3WuXC4oj5a2/U3oASExGDW4DAQgHwmEEGBYIABMFAlwBy4MJEDUF
hcTpUY8mAhsMAAD/XQD8DxNI6E78meodQI+wLsrKLeHn32iLvUqJbVDhfWSU
WO4BAMcm1u02t4VKw++ttECPt+HUgPUq5pqQWe5Q2cW4TMsE
=Y4Mw
-----END PGP PUBLIC KEY BLOCK-----`;

const BCRYPT_BASE64_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export async function buildSrpProofs(
  authInfo: ProtonAuthInfo,
  username: string,
  password: string
): Promise<ProtonSrpProofs> {
  const modulusBytes = await decodeModulus(authInfo.Modulus);
  const saltBytes = decodeBase64(authInfo.Salt);
  const serverEphemeralBytes = decodeBase64(authInfo.ServerEphemeral);

  const hashedPassword = hashPassword(
    authInfo.Version,
    username,
    password,
    saltBytes,
    modulusBytes
  );

  return generateProofs(modulusBytes, serverEphemeralBytes, hashedPassword);
}

export async function buildSrpProofsFromParams(
  authVersion: number,
  modulus: string,
  serverEphemeral: string,
  salt: string,
  password: string,
  username?: string,
): Promise<ProtonSrpProofsBase64> {
  const modulusBytes = await decodeModulus(modulus);
  const saltBytes = decodeBase64(salt);
  const serverEphemeralBytes = decodeBase64(serverEphemeral);

  if (authVersion < 3 && !username) {
    throw new Error('Username is required for legacy SRP versions');
  }

  const hashedPassword = hashPassword(
    authVersion,
    username ?? '',
    password,
    saltBytes,
    modulusBytes
  );

  const proofs = generateProofs(modulusBytes, serverEphemeralBytes, hashedPassword);

  return {
    clientProof: encodeBase64(proofs.clientProof),
    clientEphemeral: encodeBase64(proofs.clientEphemeral),
    expectedServerProof: encodeBase64(proofs.expectedServerProof),
    sharedSession: encodeBase64(proofs.sharedSession)
  };
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'));
}

function hashPassword(
  authVersion: number,
  username: string,
  password: string,
  salt: Uint8Array,
  modulus: Uint8Array
): Uint8Array {
  switch (authVersion) {
    case 4:
    case 3:
      return hashPasswordVersion3(password, salt, modulus);
    case 2:
      return hashPasswordVersion2(password, username, modulus);
    case 1:
      return hashPasswordVersion1(password, username, modulus);
    case 0:
      return hashPasswordVersion0(password, username, modulus);
    default:
      throw new Error('Unsupported auth version');
  }
}

function hashPasswordVersion3(password: string, salt: Uint8Array, modulus: Uint8Array): Uint8Array {
  const saltWithPepper = Buffer.concat([Buffer.from(salt), Buffer.from('proton')]);
  const encodedSalt = bcryptBase64Encode(saltWithPepper);
  const bcryptHash = bcryptHashWithSalt(password, encodedSalt);
  return expandHash(Buffer.concat([Buffer.from(bcryptHash), Buffer.from(modulus)]));
}

function hashPasswordVersion2(password: string, username: string, modulus: Uint8Array): Uint8Array {
  return hashPasswordVersion1(password, cleanUserName(username), modulus);
}

function hashPasswordVersion1(password: string, username: string, modulus: Uint8Array): Uint8Array {
  const md5Hash = bytesToHex(md5(new TextEncoder().encode(username.toLowerCase())));
  const bcryptHash = bcryptHashWithSalt(password, md5Hash);
  return expandHash(Buffer.concat([Buffer.from(bcryptHash), Buffer.from(modulus)]));
}

function hashPasswordVersion0(password: string, username: string, modulus: Uint8Array): Uint8Array {
  const userAndPass = Buffer.concat([
    Buffer.from(username.toLowerCase()),
    Buffer.from(password)
  ]);
  const prehashed = sha512(userAndPass);
  const prehashedB64 = Buffer.from(prehashed).toString('base64');
  return hashPasswordVersion1(prehashedB64, username, modulus);
}

function cleanUserName(userName: string): string {
  return userName
    .replace(/[-._]/g, '')
    .toLowerCase();
}

function expandHash(data: Buffer): Uint8Array {
  const part0 = sha512(Buffer.concat([data, Buffer.from([0])]));
  const part1 = sha512(Buffer.concat([data, Buffer.from([1])]));
  const part2 = sha512(Buffer.concat([data, Buffer.from([2])]));
  const part3 = sha512(Buffer.concat([data, Buffer.from([3])]));
  return Uint8Array.from(Buffer.concat([part0, part1, part2, part3]));
}

function bcryptBase64Encode(input: Uint8Array): string {
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

    let c2 = input[index++];
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

  return output;
}

function bcryptHashWithSalt(password: string, salt: string): string {
  try {
    return bcrypt.hashSync(password, `$2y$10$${salt}`);
  } catch {
    return bcrypt.hashSync(password, `$2b$10$${salt}`);
  }
}

async function verifyAndDecodeModulus(signedModulus: string): Promise<Uint8Array> {
  const normalized = normalizeSignedModulus(signedModulus);
  const message = await openpgp.readCleartextMessage({
    cleartextMessage: normalized
  });

  const key = await openpgp.readKey({
    armoredKey: normalizeArmoredKey(MODULUS_PUBKEY),
    config: {
      ignoreMalformedPackets: true,
      ignoreUnsupportedPackets: true,
      enableParsingV5Entities: true
    }
  });

  const verification = await openpgp.verify({
    message,
    verificationKeys: key
  });

  if (!verification.signatures.length) {
    throw new Error('No modulus signature found.');
  }

  await verification.signatures[0].verified;

  const modulusBase64 = message.getText().trim();
  return decodeBase64(modulusBase64);
}

async function decodeModulus(modulus: string): Promise<Uint8Array> {
  if (modulus.includes('BEGIN PGP PUBLIC KEY BLOCK') || modulus.includes('BEGIN PGP SIGNED MESSAGE')) {
    return verifyAndDecodeModulus(modulus);
  }

  return decodeBase64(modulus);
}

function normalizeSignedModulus(value: string): string {
  let output = value.trim();
  const hadEscapedNewlines = output.includes('\\n') || output.includes('\\r\\n');

  if (hadEscapedNewlines) {
    output = output.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }

  if (!output.endsWith('\n')) {
    output = `${output}\n`;
  }

  if (output.includes('BEGIN PGP SIGNED MESSAGE') && !output.includes('\n\n')) {
    const headerEnd = output.indexOf('\n');
    if (headerEnd >= 0) {
      output = `${output.slice(0, headerEnd)}\n\n${output.slice(headerEnd + 1)}`;
    }
  }

  return output;
}

function normalizeArmoredKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
}

function generateProofs(
  modulusBytes: Uint8Array,
  serverEphemeralBytes: Uint8Array,
  hashedPassword: Uint8Array
): ProtonSrpProofs {
  const bitLength = modulusBytes.length * 8;
  const modulus = toBigIntLE(modulusBytes);
  const serverEphemeral = toBigIntLE(serverEphemeralBytes);
  const hashedPasswordInt = toBigIntLE(hashedPassword);
  const generator = 2n;

  const clientSecret = generateClientSecret(bitLength, modulus);
  const clientEphemeral = modPow(generator, clientSecret, modulus);
  const clientEphemeralBytes = fromBigIntLE(bitLength, clientEphemeral);

  let scramblingParam = toBigIntLE(expandHash(Buffer.concat([
    Buffer.from(clientEphemeralBytes),
    Buffer.from(serverEphemeralBytes)
  ])));

  if (scramblingParam === 0n) {
    scramblingParam = 1n;
  }

  const multiplier = computeMultiplier(bitLength, generator, modulus);
  const gx = modPow(generator, hashedPasswordInt, modulus);
  const base = mod(
    serverEphemeral - (multiplier * gx),
    modulus
  );

  const exponent = mod(
    clientSecret + (scramblingParam * hashedPasswordInt),
    modulus - 1n
  );

  const sharedSecret = modPow(base, exponent, modulus);
  const sharedSession = fromBigIntLE(bitLength, sharedSecret);

  const clientProof = expandHash(Buffer.concat([
    Buffer.from(clientEphemeralBytes),
    Buffer.from(serverEphemeralBytes),
    Buffer.from(sharedSession)
  ]));

  const expectedServerProof = expandHash(Buffer.concat([
    Buffer.from(clientEphemeralBytes),
    Buffer.from(clientProof),
    Buffer.from(sharedSession)
  ]));

  return {
    clientProof,
    clientEphemeral: clientEphemeralBytes,
    expectedServerProof,
    sharedSession
  };
}

function generateClientSecret(bitLength: number, modulus: bigint): bigint {
  const modulusMinusOne = modulus - 1n;
  const lowerBound = BigInt(bitLength * 2);

  while (true) {
    const candidateBytes = randomBytes(bitLength / 8);
    const candidate = toBigIntLE(candidateBytes);
    if (candidate > lowerBound && candidate < modulusMinusOne) {
      return candidate;
    }
  }
}

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function computeMultiplier(bitLength: number, generator: bigint, modulus: bigint): bigint {
  const generatorBytes = fromBigIntLE(bitLength, generator);
  const modulusBytes = fromBigIntLE(bitLength, modulus);
  const multiplierBytes = expandHash(Buffer.concat([
    Buffer.from(generatorBytes),
    Buffer.from(modulusBytes)
  ]));

  return mod(toBigIntLE(multiplierBytes), modulus);
}

function toBigIntLE(bytes: Uint8Array): bigint {
  const reversed = Uint8Array.from(bytes).reverse();
  const hex = Buffer.from(reversed).toString('hex') || '0';
  return BigInt(`0x${hex}`);
}

function fromBigIntLE(bitLength: number, value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  const bytes = Buffer.from(hex, 'hex');
  const reversed = Uint8Array.from(bytes).reverse();
  const padded = new Uint8Array(bitLength / 8);
  padded.set(reversed.slice(0, padded.length));
  return padded;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let pow = mod(base, modulus);
  let exp = exponent;

  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = mod(result * pow, modulus);
    }
    pow = mod(pow * pow, modulus);
    exp >>= 1n;
  }

  return result;
}

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}
