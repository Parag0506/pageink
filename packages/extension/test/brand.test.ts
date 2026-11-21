/**
 * The product name lives in the brand files only. A rename then means changing
 * those files, the Xcode settings and the docs. This scans the source a reader
 * can see for the name written out by hand.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { FORMER_NAMES, NAME } from 'pageink-core/brand';
import { expect, test } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');

/** Folders and files that ship or build what readers see. */
const ROOTS = [
  'packages/core/src',
  'packages/embed/src',
  'packages/embed/vite.iife.config.ts',
  'packages/extension/src',
  'packages/extension/entrypoints',
  'packages/extension/build',
  'packages/extension/wxt.config.ts',
];

/** The only places the name may be written. */
const BRAND = ['packages/core/src/brand.ts', 'packages/extension/src/brand.ts'];

const skip = (f: string) =>
  /\.test\.ts$/.test(f) || /testkit\.ts$/.test(f) || f.includes('/testing/') || f.includes('/fixtures');

function walk(p: string, out: string[]): void {
  if (statSync(p).isDirectory()) {
    for (const n of readdirSync(p)) walk(join(p, n), out);
  } else if (/\.(ts|html|css|json|mjs)$/.test(p)) out.push(p);
}

/** Comments are for developers. Strip them so only code and markup are checked. */
function code(text: string, file: string): string {
  if (file.endsWith('.html')) return text.replace(/<!--[\s\S]*?-->/g, '');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lines of shipped code and markup, outside the brand files, that match the pattern. */
function written(word: RegExp): string[] {
  const files: string[] = [];
  for (const r of ROOTS) walk(join(repo, r), files);
  expect(files.length).toBeGreaterThan(50);
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(repo, f);
    if (BRAND.includes(rel) || skip(rel)) continue;
    const lines = code(readFileSync(f, 'utf8'), rel).split('\n');
    lines.forEach((l, i) => {
      if (word.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim()}`);
    });
  }
  return hits;
}

test('the product name is written only in the brand files', () => {
  expect(written(new RegExp(`\\b${literal(NAME)}\\b`))).toEqual([]);
});

/**
 * A former name left in code or markup would show the old name to readers. Words such as
 * "ink" in lower case are the ordinary word and are fine; the capitalised former name is not.
 */
test('former names are not written in what readers see', () => {
  expect(FORMER_NAMES.length).toBeGreaterThan(0);
  for (const old of FORMER_NAMES) {
    expect(old).not.toBe(NAME);
    expect(written(new RegExp(`\\b${literal(old)}\\b`))).toEqual([]);
  }
});

test('the brand files hold the name', () => {
  for (const f of BRAND) expect(readFileSync(join(repo, f), 'utf8')).toMatch(/NAME/);
  expect(NAME.length).toBeGreaterThan(0);
});
