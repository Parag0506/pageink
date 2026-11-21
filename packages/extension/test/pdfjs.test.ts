/** The PDF.js build step: network code out, and only permissive licences in. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { dropEvalFallback, NO_NET_TEXT, pdfjsDir, stripNetwork } from '../build/pdfjs';
import { builds, files, read } from './builds';

describe('stripNetwork', () => {
  test('global fetch and XMLHttpRequest become stubs; PDF.js methods named fetch are renamed', () => {
    const src = `
      async function a(u) { const r = await fetch(u); return globalThis.fetch(u); }
      function b() { const x = new XMLHttpRequest(); return x.readyState === XMLHttpRequest.DONE; }
      class XRef { fetch(ref) { return this.fetch(ref.next); } }
      const o = { fetch(a) { return a; }, f() { return xref.fetch(1); } };
    `;
    const out = stripNetwork(src);
    expect(out.match(/\bfetch\s*\(|XMLHttpRequest/g)).toBeNull();
    expect(out).toContain('await inkNoNet(u)');
    expect(out).toContain('return inkNoNet(u)');
    expect(out).toContain('new InkNoXhr()');
    expect(out).toContain('InkNoXhr.DONE');
    expect(out).toContain('inkReadObj(ref) { return this.inkReadObj(ref.next)');
    expect(out).toContain('xref.inkReadObj(1)');
  });

  test('the stubs fail instead of reaching the network', async () => {
    const out = stripNetwork(
      'export const go = () => fetch("x"); export const x = () => new XMLHttpRequest();',
    );
    const mod = await import(`data:text/javascript,${encodeURIComponent(out)}`);
    await expect(mod.go()).rejects.toThrow(NO_NET_TEXT);
    expect(() => mod.x()).toThrow(NO_NET_TEXT);
  });

  test('refuses shapes it cannot rewrite safely', () => {
    expect(() => stripNetwork('const fetch = 1; fetch(2);')).toThrow(/local named fetch/);
    expect(() => stripNetwork('const o = { fetch };')).toThrow(/shorthand/);
    expect(() => stripNetwork('new WebSocket("x")')).toThrow(/WebSocket/);
    expect(() => stripNetwork('const inkNoNet = 1;')).toThrow(/already contains/);
  });

  test('the installed PDF.js goes through it with no network token left', () => {
    for (const f of ['build/pdf.mjs', 'build/pdf.worker.mjs']) {
      const out = stripNetwork(readFileSync(join(pdfjsDir, f), 'utf8'), f);
      expect(out.match(/\bfetch\s*\(|XMLHttpRequest/g)).toBeNull();
    }
  });
});

describe('dropEvalFallback', () => {
  test('the legacy build loses its one string evaluation per file and nothing else', () => {
    for (const f of ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs']) {
      const src = readFileSync(join(pdfjsDir, f), 'utf8');
      const out = dropEvalFallback(src);
      expect(out.match(/\bFunction\(\s*['"`]/g), f).toBeNull();
      expect(out.length, f).toBe(src.length - "Function('return this')()".length + 'globalThis'.length);
    }
  });
});

const lazy = builds().filter((b) => !b.test);

describe.each(lazy.map((b) => [b.name, b] as const))('%s PDF files', (_n, b) => {
  test('the worker, the cmaps, the Foxit fonts and the image decoders are there', () => {
    expect(existsSync(join(b.dir, 'pdf/worker.js'))).toBe(true);
    const cmaps = readdirSync(join(pdfjsDir, 'cmaps')).filter((n) => n.endsWith('.bcmap'));
    expect(readdirSync(join(b.dir, 'pdf/cmaps')).sort()).toEqual(cmaps.map((n) => `${n}.js`).sort());
    expect(readdirSync(join(b.dir, 'pdf/fonts')).every((n) => /^Foxit\w+\.pfb\.js$/.test(n))).toBe(true);
    expect(readdirSync(join(b.dir, 'pdf/fonts'))).toHaveLength(10);
    expect(existsSync(join(b.dir, 'pdf/wasm/openjpeg_nowasm_fallback.js'))).toBe(true);
  });

  test('no string evaluation in the PDF viewer or its worker (Firefox lint, store review)', () => {
    for (const f of files(b.dir, ['']).filter((x) => /^(chunks|pdf)\/.*\.js$/.test(x)))
      expect(read(b.dir, f), f).not.toMatch(/\bFunction\(\s*['"`]return this/);
  });

  test('no GPL file ships: no Liberation font, no GPL licence text', () => {
    const all = files(b.dir, ['']);
    expect(all.filter((f) => /liberation/i.test(f))).toEqual([]);
    // NOTICE names the fonts that are left out, so it is the one file allowed to mention them.
    for (const f of all.filter((x) => x !== 'NOTICE' && /\.(txt|js|html|json|css|md)$|LICENSE/.test(x))) {
      expect(read(b.dir, f), f).not.toMatch(/GNU (?:Lesser )?General Public License|LICENSE_LIBERATION/);
    }
  });

  test('the PDF.js, cmap and Foxit notices ship with them', () => {
    expect(read(b.dir, 'pdf/LICENSE-pdfjs.txt')).toContain('Apache License');
    expect(read(b.dir, 'pdf/LICENSE-cmaps.txt')).toContain('Adobe');
    expect(read(b.dir, 'pdf/LICENSE-foxit.txt')).toContain('Redistribution and use');
    for (const f of ['LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2'])
      expect(existsSync(join(b.dir, 'pdf/wasm', f)), f).toBe(true);
  });
});
