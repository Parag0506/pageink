/**
 * The diagnostics build for the device check (apple/device) must never reach a release.
 * It is made only on request, only for Safari, only for a page on this network, and it goes
 * to its own folder. Store zips refuse it, the Release build of the app refuses it, and none
 * of the builds that ship carries any of its code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { DIAG_DIR, DIAG_FILE, defines, diagOrigin } from '../build/targets';
import config from '../wxt.config';
import { builds, diagBuild, files, outRoot, pkg, read } from './builds';

describe('the build switch', () => {
  test('is off unless INK_DIAG_ORIGIN is set', () => {
    expect(diagOrigin('safari', {})).toBeNull();
    for (const t of ['chrome', 'edge', 'firefox', 'safari'] as const) {
      if (process.env.INK_DIAG_ORIGIN) continue;
      expect(defines(t).__INK_DIAG__).toBe('false');
      expect(defines(t).__INK_DIAG_ORIGIN__).toBe('""');
    }
  });

  test('takes a plain http origin on this network, for Safari only', () => {
    expect(diagOrigin('safari', { INK_DIAG_ORIGIN: 'http://192.168.1.20:8790' })).toBe(
      'http://192.168.1.20:8790',
    );
    expect(diagOrigin('safari', { INK_DIAG_ORIGIN: 'http://10.0.0.7:9000/' })).toBe('http://10.0.0.7:9000');
    expect(diagOrigin('safari', { INK_DIAG_ORIGIN: 'http://127.0.0.1:8790' })).toBe('http://127.0.0.1:8790');
    const bad = [
      'https://192.168.1.20:8790',
      'http://example.com',
      'http://8.8.8.8:80',
      'http://192.168.1.20:8790/check',
      'not an address',
    ];
    for (const v of bad) expect(() => diagOrigin('safari', { INK_DIAG_ORIGIN: v }), v).toThrow();
    for (const t of ['chrome', 'edge', 'firefox'] as const) {
      expect(() => diagOrigin(t, { INK_DIAG_ORIGIN: 'http://192.168.1.20:8790' })).toThrow(/Safari only/);
    }
  });

  test('refuses a release build', () => {
    expect(() =>
      diagOrigin('safari', { INK_DIAG_ORIGIN: 'http://192.168.1.20:8790', INK_RELEASE: '1' }),
    ).toThrow(/release/);
  });

  test('store zips refuse a diagnostics build', () => {
    const hook = (config as { hooks?: Record<string, () => void> }).hooks?.['zip:start'];
    expect(hook).toBeTypeOf('function');
    const before = process.env.INK_DIAG_ORIGIN;
    try {
      process.env.INK_DIAG_ORIGIN = 'http://192.168.1.20:8790';
      expect(() => hook?.()).toThrow(/zip/);
      delete process.env.INK_DIAG_ORIGIN;
      expect(() => hook?.()).not.toThrow();
    } finally {
      if (before === undefined) delete process.env.INK_DIAG_ORIGIN;
      else process.env.INK_DIAG_ORIGIN = before;
    }
  });
});

describe('the builds that ship', () => {
  const shipped = builds();

  test('are not in the diagnostics folder', () => {
    expect(shipped.length).toBeGreaterThan(0);
    for (const b of shipped) expect(b.dir.startsWith(join(outRoot, DIAG_DIR))).toBe(false);
  });

  test.each(shipped.map((b) => [b.name, b] as const))('%s carries no diagnostics code', (_n, b) => {
    expect(existsSync(join(b.dir, DIAG_FILE))).toBe(false);
    for (const f of files(b.dir, ['.js', '.html'])) {
      const text = read(b.dir, f);
      expect(text.includes('ink-diag'), f).toBe(false);
      expect(text.includes('diag:log'), f).toBe(false);
      // The probe that counts each stroke is made only by diagnostics code, so it is left out too.
      expect(text.includes('fingersWhilePen'), f).toBe(false);
      // The PDF viewer's way back to the check page is diagnostics code too.
      expect(text.includes('Back to the Pencil check'), f).toBe(false);
    }
  });
});

describe('a diagnostics build, when one has been made', () => {
  const d = diagBuild();
  test.skipIf(!d)('gives the PDF viewer its way back to the check page', () => {
    const text = files(d!.dir, ['.js']).map((f) => read(d!.dir, f));
    expect(text.some((t) => t.includes('Back to the Pencil check'))).toBe(true);
  });
});

describe('the Release build of the app', () => {
  const sync = resolve(pkg, '../../apple/sync-extension.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'diag-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const ext = (name: string, marked: 'file' | 'code' | 'none') => {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(join(dir, 'stub.js'), marked === 'code' ? 'post({"ink-diag":"hello"})' : 'void 0');
    if (marked === 'file') writeFileSync(join(dir, DIAG_FILE), 'diagnostics');
    return dir;
  };
  const run = (src: string, configuration: string) =>
    execFileSync('bash', [sync, join(tmp, `out-${Math.random()}`)], {
      env: { ...process.env, INK_EXTENSION_DIR: src, CONFIGURATION: configuration },
      stdio: 'pipe',
    });

  test('refuses a diagnostics build, by its marker file or by its code', () => {
    expect(() => run(ext('file', 'file'), 'Release')).toThrow();
    expect(() => run(ext('code', 'code'), 'Release')).toThrow();
  });

  test('takes a plain build, and a Debug build takes either', () => {
    expect(() => run(ext('plain', 'none'), 'Release')).not.toThrow();
    expect(() => run(ext('debug', 'file'), 'Debug')).not.toThrow();
  });
});
