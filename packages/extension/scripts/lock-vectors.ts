/**
 * Writes docs/lock-vectors.json: known answers for the password lock, so another
 * implementation (the Safari app) can check itself. Run with
 * `corepack pnpm --filter pageink-extension exec tsx scripts/lock-vectors.ts`.
 * The extension's tests check the file against the code on every run.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashKey } from 'pageink-core/hash';
import {
  deriveKey,
  fromB64,
  keyCheck,
  lockedName,
  lockMac,
  macText,
  recoveryCode,
  seal,
  sealV1,
  subKey,
  toB64,
} from '../src/lock/crypto';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (n: number, start: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 255);

const PAGE = 'https://example.com/a';
const record = `${JSON.stringify(
  {
    v: 1,
    key: PAGE,
    urls: [PAGE],
    title: 'A',
    updatedAt: 1,
    notes: [],
    deleted: [],
  },
  null,
  2,
)}\n`;

const cases = [
  {
    password: 'correct horse battery staple',
    iterations: 600_000,
    salt: bytes(16, 0),
    nonce: bytes(12, 100),
  },
  // NFD input: the password is taken as NFC first, so this matches the NFC spelling.
  { password: 'pässwörd ✍', iterations: 100_000, salt: bytes(16, 200), nonce: bytes(12, 50) },
];

const out = [];
for (const c of cases) {
  const key = await deriveKey(c.password, c.salt, c.iterations);
  const name = `pages/${await lockedName(key, PAGE)}.ink.json`;
  const envelope = await seal(key, name, record, c.nonce);
  const lock = {
    kdf: { iterations: c.iterations, salt: toB64(c.salt) },
    check: toB64(await keyCheck(key)),
    state: 'on',
  };
  const v1 = await sealV1(key, record, c.nonce);
  out.push({
    password: c.password,
    passwordNfcUtf8Hex: hex(new TextEncoder().encode(c.password.normalize('NFC'))),
    saltB64: toB64(c.salt),
    iterations: c.iterations,
    keyHex: hex(key),
    checkB64: lock.check,
    recoveryCode: recoveryCode(key),
    sealKeyHex: hex(await subKey(key, 'seal')),
    fileKeyHex: hex(await subKey(key, 'file')),
    namesKeyHex: hex(await subKey(key, 'names')),
    pageKey: PAGE,
    name,
    nonceB64: toB64(c.nonce),
    plaintext: record,
    envelope,
    cipherAndTagHex: hex(fromB64(JSON.parse(envelope).c)),
    lockState: lock.state,
    lockMacText: macText(lock),
    lockMacB64: await lockMac(key, lock),
    v1Envelope: v1,
  });
}

/** Plain names, used while the lock is off: cyrb53 over UTF-16 code units, base36. */
const plainNames = ['', 'a', PAGE, 'https://example.com/ü?x=1#/r', 'https://例え.jp/ページ', '😀'].map(
  (key) => ({
    key,
    hash: hashKey(key),
  }),
);

const file = {
  about:
    'Known answers for the password lock in docs/FORMAT.md. Key: PBKDF2-HMAC-SHA-256 over the NFC UTF-8 password, 32 bytes. Check: HMAC-SHA-256(key, "lock-check-v1"). Sub keys: HKDF-SHA-256(key, empty salt, info "pageink lock v2 seal" | "pageink lock v2 lock file" | "pageink lock v2 names"), 32 bytes each. Name: the first 10 bytes of HMAC-SHA-256(names key, page key) in lower case base32. Seal (version 2): AES-256-GCM under the seal key, 12 byte nonce, 16 byte tag, additional data "pageink-lock-v2\\n" followed by the name. Lock file MAC: HMAC-SHA-256(lock file key, lockMacText). The envelopes are the exact file text. v1Envelope is version 1, read only to move a place to version 2: AES-256-GCM under the key itself, additional data "lock-v1". plainNames: the names used while the lock is off.',
  vectors: out,
  plainNames,
};
writeFileSync(
  resolve(import.meta.dirname, '../../../docs/lock-vectors.json'),
  `${JSON.stringify(file, null, 2)}\n`,
);
