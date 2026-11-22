// The view chunk must stay small and must not pull in the tools (CONTRACT 3, DESIGN 5).
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build, type Rolldown } from 'vite';
import { describe, expect, test } from 'vitest';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Minified size budgets in bytes, set a little above what the chunks weighed when measured:
 * view 106,328 B, split view 110,901 B, tools 79,433 B. The view carries the quick path rung,
 * which places notes from their own block, the document text built in slices once the parser
 * is done, placement of notes as the page arrives, the clipping and hiding of notes in sections
 * that close, clip-path shapes, the top layer host for dialogs and popovers, translated pages
 * and private windows, and the store's deep checks of stored records, key checks and overflow
 * slots. The tools add the page drag rules, draw mode kept per site, the one-time hint and the
 * picture export. Docking added about 8.9 KB to the view: the search for free space around a
 * margin note, leaders that go round text, and the marker and popover for a note with no room.
 * Moving a just written note by as much as its anchor moved before the first pass added about
 * 0.2 KB: view 107,003 B, split view 111,604 B. Taking credentials out of addresses by value
 * (web tokens, random values under secret names) and the signed link names, and naming files the
 * folder's own way for the password lock, added about 1.0 KB: view 107,990 B, split view 112,571 B.
 * A docking read that skips content a closed section hides and stops at the end of its slice,
 * markers drawn from the pass's own measure, and settings read without waiting for a new device
 * id to be stored added 0.8 KB: view 108,776 B, split view 113,357 B. Both limits rose by that.
 * Taking on a device id another tab stored first: view 108,914 B, split view 113,500 B.
 * Leaving notes off the screen out of a frame pass, so the first paint waits only for the first
 * screen, and deciding a first-screen note in that frame when the page text builds in time, added
 * about 0.6 KB: view 109,035 B to 109,610 B, split view 113,625 B to 114,196 B. Both limits rose by that.
 * Keeping where anchors lie across passes, so a pass over a long backlog reads only the boxes its
 * budget allows, added 0.5 KB: view 110,125 B, split view 114,702 B. Both limits rose by that.
 * Reading a short page's whole text before its first-screen notes are placed: view 110,215 B, split
 * view 114,794 B. Both limits rose by that. Reading the page's colours in the first placement until
 * the page has painted, and checking a record without naming its fields unless one fails: view
 * 110,581 B, split view 115,161 B. Both limits rose by that.
 */
export const VIEW_BUDGET = 110_771;
/** The view as the browser loads it from a split build: the entry and the shared chunks it imports. */
export const VIEW_SPLIT_BUDGET = 115_365;
/**
 * Measured at 79,969 B once capture gained its optional stroke probe calls. Room at the end of
 * the page for a bar at the bottom edge, a grip drag held inside the screen, and a bar that
 * wraps into a second column on short screens added 1.9 KB: 80,441 B to 82,370 B.
 */
export const TOOLS_BUDGET = 82_500;

async function bundle(entry: string, external: (id: string) => boolean) {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      modulePreload: false,
      rollupOptions: {
        input: here(entry),
        external,
        preserveEntrySignatures: 'strict',
        output: { format: 'es' },
      },
    },
  });
  const list = (Array.isArray(out) ? out : [out]) as Rolldown.RolldownOutput[];
  const chunks = list.flatMap((o) => o.output).filter((c): c is Rolldown.OutputChunk => c.type === 'chunk');
  return chunks.map((c) => ({
    name: c.fileName,
    imports: c.imports,
    entry: c.isEntry,
    size: Buffer.byteLength(c.code),
    gz: gzipSync(c.code).length,
    modules: c.moduleIds,
    code: c.code,
  }));
}

const isTools = (id: string) => id === './tools' || /[\\/]app[\\/]tools(\.ts)?$/.test(id);

describe('chunks', () => {
  test('the view chunk has no capture, ui or notes code and fits its budget', async () => {
    const [view, ...rest] = await bundle('./view.ts', isTools);
    expect(rest).toEqual([]);
    const banned = view!.modules.filter((m) =>
      /[\\/](capture|ui|notes)[\\/]|anchor[\\/](describe|mark)\.ts|store[\\/](sync|markdown)\.ts|fflate/.test(
        m,
      ),
    );
    expect(banned).toEqual([]);
    expect(view!.code).toContain('./tools');
    console.info(`view chunk: ${view!.size} bytes minified, ${view!.gz} gzipped`);
    expect(view!.size).toBeLessThan(VIEW_BUDGET);
  }, 60_000);

  test('the tools chunk, split from the view as the browser loads it, fits its budget', async () => {
    const chunks = await bundle('./view.ts', () => false);
    const entry = chunks.find((c) => c.entry)!;
    // What the view loads up front: the entry and the shared chunks it imports statically.
    const up = new Set([entry.name, ...entry.imports]);
    const viewSize = chunks.filter((c) => up.has(c.name)).reduce((n, c) => n + c.size, 0);
    const tools = chunks.filter((c) => !up.has(c.name));
    expect(tools.some((c) => c.modules.some((m) => /app[\\/]tools\.ts$/.test(m)))).toBe(true);
    // Shared code stays with the view; the tools chunk holds only what drawing adds.
    expect(
      tools.flatMap((c) => c.modules).filter((m) => /place[\\/]placer|anchor[\\/]resolve/.test(m)),
    ).toEqual([]);
    const size = tools.reduce((n, c) => n + c.size, 0);
    const gz = tools.reduce((n, c) => n + c.gz, 0);
    console.info(`split build: view ${viewSize} bytes, tools ${size} bytes minified (${gz} gzipped)`);
    expect(viewSize).toBeLessThan(VIEW_SPLIT_BUDGET);
    expect(size).toBeLessThan(TOOLS_BUDGET);
  }, 60_000);
});
