/** Every build and every store zip carries the repo's LICENSE and NOTICE. The Firefox sources zip rebuilds. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { builds, outRoot, pkg } from './builds';

const repo = resolve(pkg, '../..');
const LEGAL = ['LICENSE', 'NOTICE'];

/** Entries of a zip file from its central directory, with a reader for each. */
export function zipEntries(buf: Buffer): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test('the repo has a LICENSE and a NOTICE', () => {
  for (const f of LEGAL) expect(existsSync(join(repo, f))).toBe(true);
});

describe.each(builds().map((b) => [b.name, b] as const))('%s', (_n, b) => {
  test('carries LICENSE and NOTICE, the same as the repo', () => {
    for (const f of LEGAL)
      expect(readFileSync(join(b.dir, f), 'utf8')).toBe(readFileSync(join(repo, f), 'utf8'));
  });
});

const zips = existsSync(outRoot) ? readdirSync(outRoot).filter((n) => n.endsWith('.zip')) : [];

describe.skipIf(!zips.length)('store zips', () => {
  test.each(zips.filter((z) => !z.includes('-sources')))('%s carries LICENSE and NOTICE', (z) => {
    const e = zipEntries(readFileSync(join(outRoot, z)));
    for (const f of LEGAL) expect(e.get(f)?.().toString('utf8')).toBe(readFileSync(join(repo, f), 'utf8'));
  });

  test.each(zips.filter((z) => z.includes('-sources')))('%s holds what a reviewer needs to rebuild', (z) => {
    const names = [...zipEntries(readFileSync(join(outRoot, z))).keys()];
    for (const f of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'LICENSE',
      'NOTICE',
      'packages/core/package.json',
      'packages/core/src/types.ts',
      'packages/extension/package.json',
      'packages/extension/wxt.config.ts',
      'packages/extension/BUILDING.md',
      'packages/extension/build/pdfjs.ts',
    ])
      expect(names).toContain(f);
    expect(names.some((n) => n.includes('node_modules/'))).toBe(false);
    expect(names.some((n) => n.includes('.output/'))).toBe(false);
  });
});
