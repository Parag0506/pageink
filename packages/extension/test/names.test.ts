/**
 * The names each store shows. Search inside a store matches on the name, so Chrome, Edge and
 * Firefox carry a name that says what the extension does. Safari keeps the plain name, which
 * the app, Safari's extension list, Settings and the app's UI tests depend on. Everywhere a
 * reader sees the product inside the browser (toolbar title, popup, pages) it is the plain name.
 *
 * The strings are written out again here, so a change in src/brand.ts must be made twice.
 */
import { describe, expect, test } from 'vitest';
import { manifestFor, type Target } from '../build/targets';
import { NAME } from '../src/brand';
import { builds, files, manifest, read } from './builds';

const DESC =
  'Handwrite and annotate web pages and PDFs with a pen, finger or mouse. Notes return on the same words. Free, no account.';

const WANT: Record<Target, { name: string; description: string }> = {
  chrome: { name: 'PageInk: Handwrite and Annotate Web Pages', description: DESC },
  edge: { name: 'PageInk: Handwrite and Annotate Web Pages', description: DESC },
  firefox: { name: 'PageInk: Handwrite on Web Pages', description: DESC },
  safari: {
    name: 'PageInk',
    description:
      'Handwrite and draw on any web page. Your notes come back on the same words and go only where you choose.',
  },
};

/** Store limits. Chrome: name 75, description 132. Edge: name 45. Safari: description 112. */
const NAME_MAX: Record<Target, number> = { chrome: 75, edge: 45, firefox: 50, safari: 75 };
const DESC_MAX: Record<Target, number> = { chrome: 132, edge: 132, firefox: 132, safari: 112 };

/** Words that would name another browser or store in a listing. Edge refuses those. */
const OTHER_BROWSERS = /chrome|edge|firefox|safari|mozilla|microsoft|google|apple/i;

const targets = Object.keys(WANT) as Target[];

test('the plain name is PageInk', () => {
  expect(NAME).toBe('PageInk');
});

describe.each(targets)('%s manifest', (t) => {
  const m = manifestFor(t);

  test('has the store name, the short name and the description', () => {
    expect(m.name).toBe(WANT[t].name);
    expect(m.short_name).toBe('PageInk');
    expect(m.description).toBe(WANT[t].description);
  });

  test('fits the store limits', () => {
    expect((m.name as string).length).toBeLessThanOrEqual(NAME_MAX[t]);
    expect((m.description as string).length).toBeLessThanOrEqual(DESC_MAX[t]);
    // Chrome's short_name limit is 12 characters.
    expect((m.short_name as string).length).toBeLessThanOrEqual(12);
  });

  test('the toolbar button says just PageInk', () => {
    expect((m.action as { default_title: string }).default_title).toBe('PageInk');
  });

  test('names no browser and no store, and has no em dash or exclamation mark', () => {
    for (const s of [m.name as string, m.description as string]) {
      expect(s).not.toMatch(OTHER_BROWSERS);
      expect(s).not.toMatch(/[\u2014!]/);
    }
  });
});

describe.each(builds().map((b) => [b.name, b] as const))('%s build', (_n, b) => {
  test('its manifest carries the names for its store', () => {
    const m = manifest(b);
    const want = WANT[b.target].name;
    expect(m.name).toBe(b.test ? `${want} (test build)` : want);
    expect(m.short_name).toBe('PageInk');
    expect(m.description).toBe(WANT[b.target].description);
    expect((m.action as { default_title: string }).default_title).toBe('PageInk');
  });

  test('the pages say PageInk, and no script reads the manifest name at run time', () => {
    // The pages show NAME from the brand file. getManifest().name would show the long store name.
    expect(read(b.dir, 'popup.html')).toMatch(/<title>PageInk<\/title>/);
    for (const f of files(b.dir, ['.js'])) {
      expect(read(b.dir, f), f).not.toMatch(/getManifest\(\)\s*\.\s*name\b|\bshort_name\b/);
    }
  });
});
