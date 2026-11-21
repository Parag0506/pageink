/**
 * CONTRACT 2: the embed script makes no network requests. Every built file is parsed by the
 * same scanner the extension uses, so comments and licence text are never matched, and a call
 * cannot hide behind spacing, a member name or a string split in two.
 * Run after the build; the test script builds first.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { scanFile } from '../../../scripts/netscan';

const dist = resolve(import.meta.dirname, '../dist');

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|css|html|json)$/.test(n)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const found = (name: string, text: string) => scanFile(name, text).map((h) => `${h.rule}:${h.detail}`);

test('the scanner catches each kind of call, and not one hidden in a comment', () => {
  const sample =
    'fetch (u);new XMLHttpRequest;new WebSocket(a);new EventSource(b);navigator.sendBeacon(c);' +
    'importScripts("x");self["fe"+"tch"](u);import("https://cdn.example/x.js");';
  expect(found('a.js', sample)).toEqual(
    expect.arrayContaining([
      'api:fetch',
      'api:XMLHttpRequest',
      'api:WebSocket',
      'api:EventSource',
      'api:sendBeacon',
      'api:importScripts',
      'remote-string:https://cdn.example/x.js',
    ]),
  );
  expect(found('a.js', 'self["fe"+"tch"](u)')).toEqual(['api:fetch']);
  expect(found('a.js', '/* fetch(u) https://example.com */ const a = 1;')).toEqual([]);
  expect(found('a.js', 'document.createElementNS("http://www.w3.org/2000/svg","path")')).toEqual([]);
});

test('both builds exist', () => {
  expect(existsSync(join(dist, 'pageink.js'))).toBe(true);
  expect(existsSync(join(dist, 'pageink.mjs'))).toBe(true);
  const chunks = files(dist).filter((f) => f.includes('/chunks/'));
  expect(chunks.some((f) => /\/tools-[\w-]+\.mjs$/.test(f))).toBe(true);
});

test('no network calls and no remote addresses in any built file', () => {
  const bad: string[] = [];
  for (const f of files(dist)) {
    for (const hit of found(f, readFileSync(f, 'utf8'))) bad.push(`${relative(dist, f)}: ${hit}`);
  }
  expect(bad).toEqual([]);
});

test('the module build keeps the drawing tools out of the first file', () => {
  const main = readFileSync(join(dist, 'pageink.mjs'), 'utf8');
  // The tools arrive through a dynamic import, and capture code is not in the entry.
  expect(main).toMatch(/import\(["'`]\.\/chunks\/tools-/);
  expect(main).not.toContain('getPredictedEvents');
});
