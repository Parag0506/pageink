/**
 * The brand in every build: each icon a manifest names exists at its stated size, the
 * toolbar icon is the small mark, the old icon is gone, and no shipped style carries the
 * old blue accent.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ICONS, TOOLBAR_SIZES, TOOLBAR_SVG, toolbarIcons } from '../build/icons';
import { builds, files, manifest, pkg, read } from './builds';

const repo = resolve(pkg, '../..');
const all = builds();

/** Width and height of a PNG, from its header. */
function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** The accent colours of the old blue theme, in every spelling the styles used. */
const OLD_BLUE = [
  '#2b59c3',
  '#2563eb',
  '#86a8ff',
  '#8fb0ff',
  '#a9c0ff',
  '#2f6fed',
  '#7aa7ff',
  '#dfe7fb',
  '#0f1320',
  'rgba(37,99,235',
  'rgba(122,162,255',
];

test('there are builds to check', () => {
  expect(all.length).toBeGreaterThan(0);
});

test('the icons in public/ are the ones the builds name, and the old icon is gone', () => {
  const dir = join(pkg, 'public/icons');
  const named = new Set([
    ...Object.values(ICONS),
    ...TOOLBAR_SIZES.map((s) => `icons/toolbar-${s}.png`),
    TOOLBAR_SVG,
    'icons/mark.svg',
    'icons/logo.svg',
    'icons/logo-dark.svg',
  ]);
  expect(new Set(readdirSync(dir).map((f) => `icons/${f}`))).toEqual(named);
  expect(existsSync(join(dir, 'icon.svg'))).toBe(false);
});

test('the SVG icons are the brand files, unchanged', () => {
  const pairs: [string, string][] = [
    ['icons/mark.svg', 'pageink-mark.svg'],
    [TOOLBAR_SVG, 'pageink-mark-small.svg'],
    ['icons/logo.svg', 'pageink-logo.svg'],
    ['icons/logo-dark.svg', 'pageink-logo-dark.svg'],
  ];
  for (const [ours, brand] of pairs) {
    expect(readFileSync(join(pkg, 'public', ours), 'utf8')).toBe(
      readFileSync(join(repo, 'brand', brand), 'utf8'),
    );
  }
});

describe.each(all.map((b) => [b.name, b] as const))('%s', (_n, b) => {
  const m = manifest(b);

  test('manifest icons are 16, 32, 48 and 128, each at its stated size', () => {
    const icons = m.icons as Record<string, string>;
    expect(Object.keys(icons).sort()).toEqual(['128', '16', '32', '48']);
    for (const [size, path] of Object.entries(icons)) {
      expect(pngSize(readFileSync(join(b.dir, path)))).toEqual([Number(size), Number(size)]);
    }
  });

  test('the toolbar icon is the small mark at the sizes this browser asks for', () => {
    const action = m.action as { default_icon: Record<string, string> };
    expect(action.default_icon).toEqual(toolbarIcons(b.target));
    for (const [size, path] of Object.entries(action.default_icon)) {
      const buf = readFileSync(join(b.dir, path));
      if (path.endsWith('.svg')) {
        const svg = buf.toString('utf8');
        expect(svg).toMatch(/viewBox="0 0 128 128"/);
        expect(svg).toBe(readFileSync(join(repo, 'brand/pageink-mark-small.svg'), 'utf8'));
      } else {
        expect(pngSize(buf)).toEqual([Number(size), Number(size)]);
      }
    }
  });

  test('every icon a page or the manifest names is in the build', () => {
    for (const f of files(b.dir, ['.html'])) {
      for (const [, src] of read(b.dir, f).matchAll(/(?:src|srcset)="\/(icons\/[^"]+)"/g)) {
        expect(existsSync(join(b.dir, src!)), `${f} names ${src}`).toBe(true);
      }
    }
  });

  test('no shipped style or script carries the old blue accent', () => {
    const hits: string[] = [];
    for (const f of files(b.dir, ['.css', '.js', '.html'])) {
      if (f.startsWith('pdfjs/') || f.includes('pdf.worker')) continue;
      const text = read(b.dir, f).toLowerCase().replace(/\s+/g, '');
      for (const c of OLD_BLUE) if (text.includes(c)) hits.push(`${f}: ${c}`);
    }
    expect(hits).toEqual([]);
  });
});
