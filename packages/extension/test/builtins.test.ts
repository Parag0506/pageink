/**
 * No build ships JavaScript newer than its target's oldest browser can run.
 * Every script in every build is parsed for the built-ins in test/builtins.ts.
 * A use counts unless the browser has had it since the target's minimum
 * version, or the same file carries a polyfill for it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PDFJS_BUILD, pdfjsDir } from '../build/pdfjs';
import { MIN_VERSION, type Target } from '../build/targets';
import { builds, files, manifest, pkg, read } from './builds';
import { type Browser, BUILTINS, scan, tooNew } from './builtins';

const browserOf = (t: Target): Browser =>
  t === 'safari' ? 'safari' : t === 'firefox' ? 'firefox' : 'chrome';
const pdfjs = (f: string) => scan(readFileSync(join(pdfjsDir, f), 'utf8'));

describe('the scanner', () => {
  test('sees statics, prototype calls and iterator helpers, not strings or array methods', () => {
    const s = scan(`
      Promise.try(f); m.getOrInsertComputed(k, f); new Map().values().map(g).toArray();
      [1].map(g); Object.keys(o).some(g); const t = "Math.sumPrecise(x)"; // URL.parse(a)
    `);
    expect(BUILTINS.length).toBeGreaterThan(10);
    expect(tooNew(s, 'safari', 17)).toEqual([
      'Iterator helpers: Iterator#map',
      'Iterator helpers: Iterator#toArray',
      'Map and WeakMap getOrInsert: Map#getOrInsertComputed',
      'Map and WeakMap getOrInsert: WeakMap#getOrInsertComputed',
      'Promise.try: Promise.try',
    ]);
    expect(tooNew(s, 'safari', 18.4)).toEqual([
      'Map and WeakMap getOrInsert: Map#getOrInsertComputed',
      'Map and WeakMap getOrInsert: WeakMap#getOrInsertComputed',
    ]);
  });

  test('a polyfill in the same file covers a use, in the shapes core-js and plain code write', () => {
    const use = 'Promise.withResolvers(); a.getOrInsert(k, v); b.transferToFixedLength(4);';
    expect(tooNew(scan(use), 'safari', 17)).toHaveLength(4);
    const covered = scan(`${use}
      Promise.withResolvers = () => 0;
      $({ target: \`Map\`, proto: !0 }, { getOrInsert() {} });
      $({ target: 'WeakMap', proto: true }, { getOrInsert: function () {} });
      Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', { value() {} });
    `);
    expect(tooNew(covered, 'safari', 17)).toEqual([]);
    // Only Map is covered, but a call on any value could be a WeakMap.
    const half = scan(`a.getOrInsert(k, v); Map.prototype.getOrInsert = function () {};`);
    expect(tooNew(half, 'safari', 17)).toEqual(['Map and WeakMap getOrInsert: WeakMap#getOrInsert']);
  });
});

describe('the PDF.js builds', () => {
  const modern = ['build/pdf.mjs', 'build/pdf.worker.mjs'].map(pdfjs);
  const legacy = ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'].map(pdfjs);
  const flagged = (scans: ReturnType<typeof scan>[], t: Target) =>
    [...new Set(scans.flatMap((s) => tooNew(s, browserOf(t), MIN_VERSION[t])))].sort();

  test('the modern build needs built-ins the legacy build polyfills', () => {
    const names = flagged(modern, 'safari').map((x) => x.split(':')[0]);
    for (const n of ['Iterator helpers', 'Map and WeakMap getOrInsert', 'Math.sumPrecise', 'Promise.try'])
      expect(names).toContain(n);
  });

  test.each(Object.keys(PDFJS_BUILD) as Target[])('%s ships the modern build only where it runs', (t) => {
    if (PDFJS_BUILD[t] === 'modern') expect(flagged(modern, t)).toEqual([]);
    // Legacy is chosen because the modern build would not run on the oldest browser.
    else expect(flagged(modern, t)).not.toEqual([]);
  });

  test('as shipped, the legacy build lacks only what src/pdf/compat.ts adds', () => {
    expect(flagged(legacy, 'chrome')).toEqual([]);
    expect(flagged(legacy, 'firefox')).toEqual([]);
    expect(flagged(legacy, 'safari')).toEqual([
      'AbortSignal.any: AbortSignal.any',
      'ArrayBuffer transfer: ArrayBuffer#transferToFixedLength',
      'Promise.withResolvers: Promise.withResolvers',
    ]);
  });
});

describe('minimum versions', () => {
  test('are the ones the manifests and the app declare', () => {
    // A literal copy, so a change to build/targets.ts is a change here too.
    expect(MIN_VERSION).toEqual({ chrome: 119, edge: 119, firefox: 140, safari: 17 });
    const xcode = readFileSync(resolve(pkg, '../../apple/PageInk.xcodeproj/project.pbxproj'), 'utf8');
    const ios = new Set([...xcode.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1]));
    const mac = new Set([...xcode.matchAll(/MACOSX_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1]));
    // iOS 17 ships Safari 17, and macOS 14 ships Safari 17.
    expect([...ios]).toEqual(['17.0']);
    expect([...mac]).toEqual(['14.0']);
  });

  test.each(builds().filter((b) => !b.test))('$name declares its minimum where the store allows it', (b) => {
    const m = manifest(b);
    if (b.target === 'chrome') expect(m.minimum_chrome_version).toBe(String(MIN_VERSION.chrome));
    else expect(m.minimum_chrome_version).toBeUndefined();
    if (b.target === 'firefox') {
      const gecko = (m.browser_specific_settings as { gecko: { strict_min_version: string } }).gecko;
      expect(gecko.strict_min_version).toBe(`${MIN_VERSION.firefox}.0`);
    }
  });
});

const DATA = /^pdf\/(?:cmaps|fonts)\//;

describe.each(builds().map((b) => [b.name, b] as const))('%s', (_n, b) => {
  test('ships no built-in newer than its oldest browser has', () => {
    const scripts = files(b.dir, ['.js', '.mjs']);
    const bad: string[] = [];
    let scanned = 0;
    for (const f of scripts) {
      const code = read(b.dir, f);
      if (DATA.test(f)) {
        // Data modules hold one string and no code.
        expect(code, f).toMatch(/^export default "[A-Za-z0-9+/=]*";\n$/);
        continue;
      }
      for (const hit of tooNew(scan(code), browserOf(b.target), MIN_VERSION[b.target]))
        bad.push(`${f}: ${hit}`);
      scanned++;
    }
    expect(bad).toEqual([]);
    // The stub, the background, the pages, the worker and the decoders at least.
    expect(scripts).toContain('stub.js');
    expect(scripts).toContain('background.js');
    expect(scripts).toContain('pdf/worker.js');
    expect(scanned).toBeGreaterThan(8);
  });
});
