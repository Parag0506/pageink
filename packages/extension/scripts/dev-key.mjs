/**
 * Makes the development key pair that keeps the extension id the same on every machine
 * (docs/CLOUD_SETUP.md, "A fixed extension id"). Writes:
 *   dev-key.pem  the private key. Git ignores it. Keep it to yourself.
 *   dev-key.pub  the public key, as the manifest's "key". Safe to commit.
 * Then prints the extension id and the sign-in return addresses to register.
 * Builds use the key only with INK_DEV_KEY=1. Run: node scripts/dev-key.mjs
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '..');
const pem = resolve(dir, 'dev-key.pem');
const pub = resolve(dir, 'dev-key.pub');

if (existsSync(pem) && !process.argv.includes('--force')) {
  console.error(
    'dev-key.pem is already there. Use --force to make a new one (the extension id will change).',
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
writeFileSync(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(pub, `${der.toString('base64')}\n`);

// Chrome and Edge make the id from the key: SHA-256, first 32 hex digits, 0-f mapped to a-p.
const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
console.log(`Extension id (Chrome and Edge): ${id}`);
console.log(`Return address to register:     https://${id}.chromiumapp.org/`);
console.log('Build with: INK_DEV_KEY=1 corepack pnpm --filter pageink-extension build');
