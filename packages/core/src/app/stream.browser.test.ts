// A page that arrives in pieces, as a parser adds it: notes are placed as their content
// appears, with no pass building the whole document text.
import { afterEach, expect, test } from 'vitest';
import { describe } from '../anchor/describe';
import { createResolver } from '../anchor/resolve';
import { dropModel, hasModel } from '../anchor/text';
import { createPlacer } from '../place/placer';
import { createLayer, type InkLayer } from '../render/layer';
import type { AnchorContext, Note } from '../types';
import { filler, quiet, until, wait } from './testkit';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = '';
  dropModel(document);
  scrollTo(0, 0);
});

const CHUNKS = 12;
const PER = 25;

function chunk(i: number): string {
  let out = `<section id="s${i}"><h2>Part ${i}</h2>`;
  for (let k = 0; k < PER; k++)
    out += `<p id="p${i}-${k}">Part ${i} line ${k}: ${filler(i * 31 + k, 30)}.</p>`;
  return `${out}</section>`;
}

test('notes are placed as their content streams in, and no pass builds the document text', async () => {
  document.body.style.cssText = 'margin:0;font:16px/1.5 sans-serif';
  document.body.innerHTML = `<main id="m">${Array.from({ length: CHUNKS }, (_, i) => chunk(i)).join('')}</main>`;
  const ctx: AnchorContext = { doc: document, isOurs: (el) => el.localName === 'ink-layer' };
  // One note at the start of every chunk, written on the whole page.
  const notes: Note[] = [];
  for (let i = 0; i < CHUNKS; i++) {
    const p = document.getElementById(`p${i}-3`)!;
    const r = p.getBoundingClientRect();
    scrollTo(0, Math.max(0, r.top + scrollY - 200));
    const b = p.getBoundingClientRect();
    const d = describe(ctx, { x: b.left + scrollX + 20, y: b.top + scrollY + 2, w: 80, h: 14 });
    notes.push({
      id: `n${i}`,
      createdAt: 1,
      updatedAt: 1,
      device: 't',
      kind: 'ink',
      anchor: d.anchor,
      frame: d.frame,
      strokes: [
        {
          id: `s${i}`,
          t: 1,
          tool: 'pen',
          color: 'ink-1',
          w: 2,
          pts: [0, 0, 50, 300, 0, 0],
          d: 'M0 0L30 0L30 10Z',
        },
      ],
    });
  }
  scrollTo(0, 0);
  const main = document.getElementById('m')!;
  main.innerHTML = '';
  dropModel(document);

  const resolver = createResolver(ctx);
  const layer = createLayer(document, { theme: 'light' }) as InkLayer;
  const passes: number[] = [];
  let builtInPass = false;
  const placer = createPlacer({
    doc: document,
    resolver,
    layer,
    onTiming: (name, ms) => {
      if (name !== 'place.pass') return;
      passes.push(ms);
    },
  });
  cleanups.push(() => {
    placer.destroy();
    layer.destroy();
  });
  // Watch whether the text appears within a pass rather than in its own slices.
  const resolve = resolver.resolve.bind(resolver);
  resolver.resolve = (a, f) => {
    if (!hasModel(ctx)) builtInPass = true;
    return resolve(a, f);
  };
  placer.setNotes(notes);

  const errors: string[] = [];
  const onError = (e: ErrorEvent) => errors.push(e.message);
  window.addEventListener('error', onError);
  cleanups.push(() => window.removeEventListener('error', onError));
  for (let i = 0; i < CHUNKS; i++) {
    main.insertAdjacentHTML('beforeend', chunk(i));
    await wait(40);
    // The note of a chunk on screen is drawn by the passes its content starts, with no
    // later idle work: once they have run, it is there.
    if (i === 0) {
      await quiet();
      expect(placer.get('n0')).toBeDefined();
    }
  }
  await until(() => notes.every((n) => placer.get(n.id)), 'all placed');
  // The last chunk's mutation pass and the idle check of quick placements.
  await quiet();

  // The first chunk is on screen: its note came with it, from the path rung alone.
  const first = placer.get('n0')!;
  expect(first.method).toBe('path');
  expect(builtInPass).toBe(false);
  // Ink written right after layout never makes the browser report a resize loop to the page.
  expect(errors).toEqual([]);
  // Passes ran while 300 paragraphs arrived and 12 notes were placed. That each one stops at
  // its time budget is proven on a driven clock in place/load.browser.test.ts, and the time
  // from content to ink is a budget in the extension's e2e budgets and in the bench.
  expect(passes.length).toBeGreaterThan(1);
  // Each note sits where the full ladder puts it on the finished page.
  const full = createResolver(ctx);
  for (const n of notes) {
    const want = full.resolve(n.anchor, n.frame)!;
    const got = placer.get(n.id)!;
    expect(want.el.id).toBe(`p${n.id.slice(1)}-3`);
    expect(got.anchorBox).toEqual(want.box);
  }
});
