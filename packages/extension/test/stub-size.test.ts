/**
 * CONTRACT 5: the stub is about 2 KB minified. Fail over 3 KB. The same holds for every
 * browser, Safari included: no build bundles the viewer or the tools into the stub.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { describe, expect, test } from 'vitest';
import { builds, files, pkg, read } from './builds';

const lazy = builds();

test('there are builds to check, Safari among them', () => {
  expect(lazy.length).toBeGreaterThan(0);
  expect(lazy.some((b) => b.target === 'safari')).toBe(true);
});

describe.each(lazy.map((b) => [b.name, b] as const))('%s stub', (_n, b) => {
  const code = read(b.dir, 'stub.js');

  test('is under 3 KB minified', () => {
    const size = Buffer.byteLength(code);
    console.log(`${b.name} stub: ${size} B minified, ${gzipSync(code).length} B gzip`);
    expect(size).toBeLessThanOrEqual(3072);
  });

  test('has no imports, loads nothing by address and asks the background for modules', () => {
    expect(code).not.toMatch(/(^|[;}\s])import\s*[{*\w]/);
    expect(code).not.toMatch(/\bimport\(/);
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toContain('getURL');
    expect(code).toContain('inject');
  });

  test('carries no viewer and no tools', () => {
    expect(code).not.toContain('Draw mode is on for this site');
    expect(code).not.toContain('Moved notes');
  });

  test('carries the inlined hash helper', () => {
    expect(code).toContain('2654435761');
    expect(code).toContain('idx:');
  });
});

describe.each(lazy.map((b) => [b.name, b] as const))('%s view path', (_n, b) => {
  const dir = join(b.dir, 'content');
  const loader = read(b.dir, 'content/loader.js');
  const tools = read(b.dir, 'content/tools.js');

  // Safari keeps PDFs in its own viewer, so its build has no PDF chunk.
  const want =
    b.target === 'safari'
      ? ['boot.js', 'loader.js', 'tools.js']
      : ['boot.js', 'loader.js', 'pdf.js', 'tools.js'];

  test('the content folder holds plain scripts only: the first read, loader, tools and PDF', () => {
    expect(readdirSync(dir).sort()).toEqual(want);
    for (const f of want) {
      // Plain scripts: they parse as scripts, so no import or export, and import no code.
      const ast = parse(read(dir, f), { ecmaVersion: 'latest', sourceType: 'script' });
      const found: string[] = [];
      simple(ast, {
        ImportExpression: () => found.push('import()'),
        MetaProperty: () => found.push('import.meta'),
      });
      expect(found).toEqual([]);
    }
  });

  test('no page script asks V8 to compile it whole as it loads', () => {
    // An eager compile of the viewer made the stress page's first update one long task far more
    // often (build/content.ts), so every page script is compiled the browser's usual way.
    for (const f of want) expect(read(dir, f)).not.toContain('allFunctionsCalledOnLoad');
    expect(read(dir, '../stub.js')).not.toContain('allFunctionsCalledOnLoad');
  });

  test('boot.js starts the first read on its own, needing nothing from the viewer', () => {
    const boot = read(dir, 'boot.js');
    expect(boot.startsWith('(()=>{"use strict";if((globalThis.__ink??={}).boot)return;')).toBe(true);
    expect(boot).not.toContain('globalThis.__ink.loader');
    expect(boot).toMatch(/storage\.local\.get\(/);
    // It holds the page's identity and the storage keys, nothing of the viewer. Measured at 7,169 B.
    expect(Buffer.byteLength(boot)).toBeLessThan(7_300);
  });

  test('loader.js stores its exports and asks for the tools through the stub', () => {
    expect(loader.startsWith('(()=>{"use strict";if((globalThis.__ink??={}).loader)return;')).toBe(true);
    expect(loader).toContain('globalThis.__ink.loader={');
    expect(loader.match(/globalThis\.__ink\.need\(`tools`\)/g)).toHaveLength(1);
  });

  test('loader.js has no preload helper and runs no DOM call when it loads', () => {
    expect(loader).not.toMatch(/modulepreload|__vitePreload|relList/);
    // Everything that touches the page is inside a function. A top-level
    // statement that names the document would run on load.
    expect(loader.split('\n')[1]).not.toMatch(/^[^{]*\bdocument\b/);
  });

  test('the tools take shared code from the loader and nothing else', () => {
    expect(tools).toMatch(
      /^\(\(\)=>\{"use strict";if\(\(globalThis\.__ink\?\?=\{\}\)\.tools\)return;\nconst\{[^}]+\}=globalThis\.__ink\.loader;/,
    );
    expect(tools).toContain('globalThis.__ink.tools={');
    const sizes = (f: string) => {
      const c = read(dir, f);
      return `${Buffer.byteLength(c)} B minified, ${gzipSync(c).length} B gzip`;
    };
    const pdf = want.includes('pdf.js') ? `; pdf ${sizes('pdf.js')}` : '';
    console.log(`${b.name} loader ${sizes('loader.js')}; tools ${sizes('tools.js')}${pdf}`);
  });

  // CONTRACT 5. Measured at 114,181 B and 80,443 B. The tools grew by the stroke probe calls in capture.
  // The viewer grew by 9,013 B for docking: free space around margin notes, and the marker.
  // It grew to 114,861 B when a just written note learnt to move with its anchor before the first pass,
  // and to 115,865 B when addresses lost credentials by value (web tokens, random values under
  // secret names) and the signed link names. It grew by 1,092 B to 116,957 B when the docking read
  // learnt to skip content a closed section hides and to stop at the end of its slice, and the boot
  // read took every key the first load needs; the limit rose by the same. It is 117,092 B since the
  // viewer takes on a device id another tab stored first, 117,213 B since font sizes read CSS
  // zoom up the tree where the browser has no currentCSSZoom, and 117,217 B since the line at a
  // height is looked for across text order when the search lands half a line away. It grew by
  // 596 B to 117,813 B when a frame pass learnt to leave notes off the screen for idle time, so the
  // first paint waits only for the first screen, and to decide a first-screen note in that frame
  // when the page text builds in time; the limit rose by the same. It grew by 498 B to 118,311 B
  // when the placer learnt to keep where anchors lie across passes, so a pass over a long backlog
  // reads only the boxes its budget allows; the limit rose by the same. It is 118,403 B since a short
  // page's whole text is read before its first-screen notes are placed. It grew by 395 B to
  // 118,798 B when it started with V8's compile hint, read the page's colours in the first placement
  // until the page has painted, and checked a record without naming its fields unless one fails;
  // the limit rose by the same. It is 118,777 B since the compile hint was taken out again, and
  // 118,563 B since the layer host has no box and the top layer has a host for the highlighter.
  // The tools grew by 1,925 B, from 80,898 B to 82,823 B, for the bar: room at the end of the
  // page while the bar is shown at the bottom, a grip drag held inside the screen, and a second
  // column on screens too short for one. Their limit rose by the same.
  test('the viewer and the tools fit their budgets', () => {
    expect(Buffer.byteLength(loader)).toBeLessThan(118_885);
    expect(Buffer.byteLength(tools)).toBeLessThan(82_925);
  });
});

/**
 * The plain scripts copy each shared binding once when they load. A module that exported a
 * binding it later changes would leave the tools with the old value, so none may.
 */
test('no source module exports a binding that can change', () => {
  const bad: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (/\.ts$/.test(n.name) && !/\.test\.ts$/.test(n.name)) {
        if (/^export\s+(let|var)\s/m.test(readFileSync(p, 'utf8'))) bad.push(p);
      }
    }
  };
  walk(join(pkg, 'src'));
  walk(join(pkg, '../core/src'));
  expect(bad).toEqual([]);
});

test('release builds leave out performance marks; the bench build keeps them', () => {
  for (const b of builds()) {
    for (const f of files(b.dir, ['.js']))
      expect(`${b.name}/${f}: ${/\.(mark|measure)\(/.test(read(b.dir, f))}`).toMatch(/false$/);
  }
  for (const b of builds(true)) expect(read(b.dir, 'content/loader.js'), b.name).toMatch(/\.mark\(/);
});
