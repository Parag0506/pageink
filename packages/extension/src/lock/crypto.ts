/**
 * The password lock (FORMAT.md, "Password lock"). Each file is sealed on the device before it
 * leaves. A key is made from the password with PBKDF2-SHA-256 and a random salt. Three keys
 * are made from it with HKDF: one seals files (AES-256-GCM, a fresh nonce, the file's name
 * bound in), one signs the lock file (HMAC-SHA-256), and one makes file names (HMAC-SHA-256).
 * Only WebCrypto is used, so the same steps can be written in Swift with CryptoKit and checked
 * against docs/lock-vectors.json.
 */

/** OWASP's 2023 advice for PBKDF2-HMAC-SHA-256. About half a second on a laptop, once per device. */
export const ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
/** Extra data of a version 1 sealed file. Version 1 is read only to move a place to version 2. */
export const AAD_V1 = 'lock-v1';
/** The text the key-check value is made from. */
export const CHECK_TEXT = 'lock-check-v1';
/** Start of the extra data of a version 2 sealed file. The file's name follows it. */
export const AAD_V2 = 'pageink-lock-v2\n';
/** Start of the text the lock file's MAC is made over. */
export const MAC_TEXT = 'pageink-lock-file-v2';

/** HKDF labels for the three keys made from the lock key. Each key has one job. */
export const INFO = {
  seal: 'pageink lock v2 seal',
  file: 'pageink lock v2 lock file',
  names: 'pageink lock v2 names',
} as const;
export type SubKey = keyof typeof INFO;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const subtle = () => globalThis.crypto.subtle;

export function toB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Bytes of standard base64. Throws on anything else. */
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes of base64, or null when it is not base64. */
export function b64OrNull(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  try {
    return fromB64(s);
  } catch {
    return null;
  }
}

export const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

// WebCrypto takes ArrayBuffer-backed views. A copy keeps TypeScript and every engine happy.
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

/** The 32 key bytes for a password. The password is taken as Unicode NFC, then UTF-8. */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations = ITERATIONS,
): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', buf(enc.encode(password.normalize('NFC'))), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, buf(data)));
}

/** HMAC-SHA-256 of CHECK_TEXT under the key. It tells a right password from a wrong one. */
export const keyCheck = (key: Uint8Array): Promise<Uint8Array> => hmac(key, enc.encode(CHECK_TEXT));

/** One of the keys made from the lock key: HKDF-SHA-256, no salt, the label as info, 32 bytes. */
export async function subKey(key: Uint8Array, use: SubKey): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', buf(key), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: buf(enc.encode(INFO[use])) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

const B32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The file name hash of a page while the lock is on: HMAC-SHA-256 of the page key under the
 * names key, the first 10 bytes in lower case base32. 16 letters and digits. Without the key
 * nobody can tell which page a name belongs to.
 */
export async function lockedName(key: Uint8Array, pageKey: string): Promise<string> {
  const mac = await hmac(await subKey(key, 'names'), enc.encode(pageKey));
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of mac.subarray(0, 10)) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The text the lock file's MAC covers: every field but the MAC, one per line. */
export const macText = (f: {
  kdf: { iterations: number; salt: string };
  check: string;
  state: string;
}): string =>
  `${MAC_TEXT}\nkdf=PBKDF2,SHA-256,${f.kdf.iterations},${f.kdf.salt}\ncheck=${f.check}\nstate=${f.state}\n`;

/** The lock file's MAC, base64: HMAC-SHA-256 of macText under the lock file key. */
export async function lockMac(
  key: Uint8Array,
  f: { kdf: { iterations: number; salt: string }; check: string; state: string },
): Promise<string> {
  return toB64(await hmac(await subKey(key, 'file'), enc.encode(macText(f))));
}

/** Compare without stopping at the first difference. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export interface EnvelopeV1 {
  lock: 1;
  alg: 'A256GCM';
  /** The nonce, 12 bytes, base64. */
  n: string;
  /** Cipher text followed by the 16 byte tag, base64. */
  c: string;
}

export interface EnvelopeV2 {
  lock: 2;
  alg: 'A256GCM';
  /** The name the file was sealed for, from the top of the place: `pages/<name>.ink.json`. */
  f: string;
  n: string;
  c: string;
}

export type Envelope = EnvelopeV1 | EnvelopeV2;

const aes = (key: Uint8Array, use: KeyUsage) =>
  subtle().importKey('raw', buf(key), { name: 'AES-GCM' }, false, [use]);

/** The extra data a version 2 file is sealed with: the label and the name it is sealed for. */
export const aadOf = (name: string) => enc.encode(`${AAD_V2}${name}`);

/**
 * Seal the text of a file for the name it is written under. A fresh nonce every time; `nonce`
 * is for test vectors only. The name is bound into the seal, so the file cannot pass for
 * another page's file.
 */
export async function seal(
  key: Uint8Array,
  name: string,
  text: string,
  nonce = randomBytes(NONCE_BYTES),
): Promise<string> {
  const c = await subtle().encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aadOf(name)), tagLength: 128 },
    await aes(await subKey(key, 'seal'), 'encrypt'),
    buf(enc.encode(text)),
  );
  const env: EnvelopeV2 = { lock: 2, alg: 'A256GCM', f: name, n: toB64(nonce), c: toB64(new Uint8Array(c)) };
  return `${JSON.stringify(env)}\n`;
}

/** A version 1 file, as older versions wrote them. Only tests and the vectors make these now. */
export async function sealV1(
  key: Uint8Array,
  text: string,
  nonce = randomBytes(NONCE_BYTES),
): Promise<string> {
  const c = await subtle().encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(enc.encode(AAD_V1)), tagLength: 128 },
    await aes(key, 'encrypt'),
    buf(enc.encode(text)),
  );
  const env: EnvelopeV1 = { lock: 1, alg: 'A256GCM', n: toB64(nonce), c: toB64(new Uint8Array(c)) };
  return `${JSON.stringify(env)}\n`;
}

/** The envelope inside a file's text, or null when the file is not sealed. */
export function envelopeOf(text: string): Envelope | null {
  // A record starts with {"v" or a newline and spaces. Checking the start first keeps this cheap.
  if (!/^\s*\{\s*"lock"\s*:/.test(text)) return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v.alg !== 'A256GCM' || typeof v.n !== 'string' || typeof v.c !== 'string') return null;
    if (v.lock === 1) return v as unknown as EnvelopeV1;
    if (v.lock === 2 && typeof v.f === 'string') return v as unknown as EnvelopeV2;
  } catch {
    // Not JSON: not ours to open.
  }
  return null;
}

export class WrongKey extends Error {
  constructor() {
    super('wrong key');
    this.name = 'WrongKey';
  }
}

/**
 * Open a sealed file. Version 2 is opened for the name in the envelope; the caller checks that
 * name against where the file was found. Throws WrongKey when the key does not fit or the
 * file was changed.
 */
export async function unseal(key: Uint8Array, env: Envelope): Promise<string> {
  try {
    const v2 = env.lock === 2;
    const n = b64OrNull(env.n);
    const c = b64OrNull(env.c);
    if (!n || !c || n.length !== NONCE_BYTES || c.length < 16) throw new WrongKey();
    const p = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: buf(n),
        additionalData: buf(v2 ? aadOf(env.f) : enc.encode(AAD_V1)),
        tagLength: 128,
      },
      await aes(v2 ? await subKey(key, 'seal') : key, 'decrypt'),
      buf(c),
    );
    return dec.decode(p);
  } catch {
    throw new WrongKey();
  }
}

// Recovery key: the 32 key bytes in base32, in groups of four, easy to write down.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function recoveryCode(key: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of key) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** The key bytes in a recovery code, or null. Case, spaces and dashes do not matter. */
export function fromRecoveryCode(code: string): Uint8Array | null {
  const s = code.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 52 || /[^A-Z2-7]/.test(s)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return out.length >= 32 ? new Uint8Array(out.slice(0, 32)) : null;
}
