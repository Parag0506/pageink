// Margin notes written in the gaps beside the text come back exactly where they were written.
// Docking moves a note only when it would really cover content. DESIGN 7.4.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { createResolver } from '../anchor';
import { describe as describeBox } from '../anchor/describe';
import { gapBoxes, isFree, layoutHtml, mount, reveal, textPieces } from '../anchor/fixtures';
import { createPlacer } from '../place/placer';
import { createLayer } from '../render/layer';
import { memoryKV } from '../store/memory';
import type { Anchor, Note, Point, Rect } from '../types';
import { closeAll, drawn, filler, line, openViewer, settle, stroke, until } from './testkit';

beforeAll(async () => {
  await page.viewport(1280, 800);
});
afterAll(async () => {
  await page.viewport(414, 896);
});
afterEach(() => {
  closeAll();
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  window.scrollTo(0, 0);
});

const links = (n: number) =>
  Array.from({ length: n }, (_, i) => `<li><a href="#s${i}">Section ${i} ${filler(i + 40, 2)}</a></li>`).join(
    '',
  );

const paras = () =>
  Array.from({ length: 8 }, (_, i) => `<p id="p${i}">Paragraph ${i} starts. ${filler(i + 3, 60)}.</p>`).join(
    '',
  );

/** Pages with a contents column on the left, the text, and a column on the right. */
const LAYOUTS: Record<string, () => string> = {
  'a long contents list in a grid column': () =>
    `<div style="display:grid;grid-template-columns:330px minmax(0,1fr) 200px;column-gap:24px">` +
    `<nav style="padding:16px 0 0 12px"><ul style="list-style:none;margin:0;padding:0">${links(450)}</ul></nav>` +
    `<main style="padding:0 48px 0 24px"><h1>The orchard</h1>${paras()}</main>` +
    `<aside><ul style="margin:0;padding:0 0 0 8px;list-style:none">${links(420)}</ul></aside></div>`,
  'a sticky contents list beside a flex column': () =>
    `<div style="display:flex">` +
    `<div style="width:320px;flex:none"><nav style="position:sticky;top:0;padding:16px 0 0 12px"><ul style="list-style:none;margin:0;padding:0">${links(20)}</ul></nav></div>` +
    `<main style="flex:1;padding:0 24px 0 110px"><div><h1>The orchard</h1>${paras()}</div></main>` +
    `<aside style="width:260px;flex:none;padding-left:110px">${links(30)}</aside></div>`,
};

/** Right edge of the text left of a line, and left edge of the text right of it, client space. */
function gapsBeside(el: Element): { left: [number, number]; right: [number, number]; y: number } {
  const range = document.createRange();
  range.selectNodeContents(el);
  const first = range.getClientRects()[1]!;
  const band = textPieces()
    .map((q) => ({ l: q.x - scrollX, r: q.x + q.w - scrollX, t: q.y - scrollY, b: q.y + q.h - scrollY }))
    .filter((q) => q.t < first.bottom && q.b > first.top);
  const l = Math.max(0, ...band.filter((q) => q.r <= first.left + 0.5).map((q) => q.r));
  const r = Math.min(innerWidth, ...band.filter((q) => q.l >= first.right - 0.5).map((q) => q.l));
  return { left: [l, first.left], right: [first.right, r], y: first.top + first.height / 2 };
}

describe('margin notes come back where they were written', () => {
  for (const [name, html] of Object.entries(LAYOUTS)) {
    for (const side of ['left', 'right'] as const) {
      test(`a note in the gap ${side} of the text, with ${name}`, async () => {
        document.body.style.cssText = 'margin:0;font:16px/1.6 sans-serif;color:#202122;background:#fff';
        document.body.innerHTML = html();
        window.scrollTo(0, document.getElementById('p2')!.getBoundingClientRect().top - 200);
        await settle();
        const kv = memoryKV();
        const a = await openViewer(kv);
        await a.cmd();
        const g = gapsBeside(document.getElementById('p2')!);
        const [g0, g1] = g[side];
        expect(g1 - g0).toBeGreaterThan(70);
        const x0 = (g0 + g1) / 2 - 24;
        await stroke(line([x0, g.y - 8], [x0 + 48, g.y - 4]));
        await stroke(line([x0, g.y + 4], [x0 + 44, g.y + 8]));
        await until(() => a.notes().length === 1, 'note');
        await settle();
        const n = a.notes()[0]!;
        expect(n.anchor.type).toBe('block');
        expect(n.anchor.place).toBe(side);
        const before = drawn(a, n.id)!;
        a.viewer.destroy();

        const b = await openViewer(kv);
        await b.viewer.ready;
        await b.cmd();
        await until(() => !!b.placed(n.id), 'placed after reload');
        await settle();
        expect(b.placed(n.id)!.docked).toBe(false);
        const after = drawn(b, n.id)!;
        expect(Math.abs(after.x - before.x)).toBeLessThan(0.5);
        expect(Math.abs(after.y - before.y)).toBeLessThan(0.5);
        expect(Math.abs(after.w - before.w)).toBeLessThan(0.5);
      });
    }
  }
});

let noteSeq = 0;
/** An ink note whose ink fills a document box, written at a described origin. */
function noteAt(anchor: Anchor, frame: Note['frame'], box: Rect, origin: Point): Note {
  const x0 = box.x - origin.x + 0.75;
  const y0 = box.y - origin.y + 0.75;
  const x1 = x0 + box.w - 1.5;
  const y1 = y0 + box.h - 1.5;
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const pts: number[] = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of corners) {
    const qx = Math.round(x * 10);
    const qy = Math.round(y * 10);
    pts.push(qx - px, qy - py, 50);
    px = qx;
    py = qy;
  }
  const id = `g${++noteSeq}`;
  const d = `M${corners.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`;
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    device: 'test',
    kind: 'ink',
    anchor,
    frame,
    strokes: [{ id: `${id}s`, t: 1, tool: 'pen', color: 'ink-1', w: 1, pts, d }],
  };
}

describe('describe, resolve and place give the written position', () => {
  // The anchor symmetry test checks describe against resolve. This one adds placement as a
  // reload does it, with no known pose: a note in free space is drawn at the described origin.
  for (const width of [1280, 1024]) {
    test(`notes in the gaps of a page with sidebars, floats and columns at ${width} px`, async () => {
      await page.viewport(width, 800);
      const { ctx } = mount(layoutHtml(width));
      const text = textPieces();
      const layer = createLayer(document, { theme: 'light' });
      const placer = createPlacer({ doc: document, resolver: createResolver(ctx), layer });
      const want = new Map<string, { origin: Point; free: boolean; place: string }>();
      const notes: Note[] = [];
      for (const box of gapBoxes(width, text)) {
        reveal(box);
        const d = describeBox(ctx, box);
        if (d.anchor.type !== 'block') continue;
        const n = noteAt(d.anchor, d.frame, box, d.origin);
        notes.push(n);
        want.set(n.id, { origin: d.origin, free: isFree(box, text), place: d.anchor.place });
      }
      scrollTo(0, 0);
      placer.setNotes(notes);
      await until(() => notes.every((n) => !!placer.get(n.id)), 'all placed');
      let checked = 0;
      const places = new Set<string>();
      for (const n of notes) {
        const w = want.get(n.id)!;
        if (!w.free) continue;
        checked++;
        places.add(w.place);
        const p = placer.get(n.id)!;
        const tag = `${w.place} ${n.anchor.path.css} ${JSON.stringify(w.origin)}`;
        expect(p.docked, tag).toBe(false);
        expect(Math.abs(p.origin.x - w.origin.x), `${tag} x`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(p.origin.y - w.origin.y), `${tag} y`).toBeLessThanOrEqual(0.5);
      }
      expect(checked).toBeGreaterThan(10);
      expect(places.has('left') && places.has('right')).toBe(true);
      placer.destroy();
      layer.destroy();
    });
  }
});
