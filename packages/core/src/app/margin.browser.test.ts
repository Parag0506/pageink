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
import {
  closeAll,
  drawn,
  filler,
  line,
  openViewer,
  type Rig,
  settle,
  stroke,
  textRect,
  until,
  wait,
} from './testkit';

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

/** A paper: a text column beside a sidebar, with a formula and its number centred in the column. */
const PAPER = `
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #1b1b1b; font: 17px/1.55 Arial, Helvetica, sans-serif; }
    header { background: #2f4f3a; color: #fff; height: 52px; padding: 14px 26px; }
    .wrap { display: flex; gap: 40px; padding: 22px 34px 60px 40px; }
    main { flex: 1; min-width: 0; }
    aside { width: 200px; flex: none; font-size: 13px; }
    h2 { font: 700 19px/1.3 Georgia, serif; margin: 22px 0 8px; }
    p { margin: 0 0 14px; }
    .eq { display: flex; align-items: center; justify-content: center; gap: 30px; margin: 14px 0; font-size: 22px; }
    .eq .n { font-size: 15px; color: #666; }
    #clock { position: fixed; left: 0; top: 0; width: 1px; height: 1px; overflow: hidden; font: 1px/1px monospace; color: transparent; pointer-events: none; }
  </style>
  <header>openprints</header>
  <div class="wrap">
    <main>
      <h2>1. Model</h2>
      <p>Let <i>&omega;</i>(<i>t</i>) be the angular speed of the ground image. The distance a bee reports is</p>
      <div class="eq">
        <math display="block"><mi>d</mi><mo>=</mo><mi>k</mi><msubsup><mo>&int;</mo><mn>0</mn><mi>T</mi></msubsup><mi>&omega;</mi><mo>(</mo><mi>t</mi><mo>)</mo><mspace width="0.2em"/><mi>d</mi><mi>t</mi></math>
        <span class="n">(1)</span>
      </div>
      <p>with a single gain <i>k</i>, fitted once for all colonies. Over open fields the integral grows slowly, so a long trip reads short.</p>
      <h2>2. Results</h2>
      <p>The model explains most of the spread between colonies, with no extra terms.</p>
    </main>
    <aside><b>Download</b> PDF, other formats</aside>
  </div>
  <div id="clock">0</div>`;

type Pts = [number, number][];

/** "= 3 km" in a running hand, one list of points per stroke, in units of the letter height. */
const SUM: Pts[] = [
  [
    [0, 0.45],
    [0.55, 0.42],
  ],
  [
    [0.02, 0.78],
    [0.58, 0.75],
  ],
  [
    [1.0, -0.25],
    [1.3, -0.42],
    [1.55, -0.2],
    [1.38, 0.2],
    [1.2, 0.3],
    [1.5, 0.45],
    [1.6, 0.8],
    [1.35, 1.05],
    [1.0, 0.95],
  ],
  [
    [2.05, -0.75],
    [2.0, 0.2],
    [1.98, 1.0],
  ],
  [
    [2.45, 0.25],
    [2.05, 0.62],
    [2.3, 0.7],
    [2.5, 1.0],
  ],
  [
    [2.75, 0.3],
    [2.78, 1.0],
    [2.85, 0.5],
    [3.05, 0.28],
    [3.15, 0.55],
    [3.16, 1.0],
    [3.22, 0.55],
    [3.45, 0.28],
    [3.56, 0.55],
    [3.58, 1.0],
  ],
];

/** Client points of one stroke of the sum, written with its baseline at `at`. */
function sumStroke(g: Pts, at: { x: number; y: number }, h: number): Pts {
  const pts: Pts = [];
  for (let i = 0; i + 1 < g.length; i++) {
    const [ax, ay] = g[i]!;
    const [bx, by] = g[i + 1]!;
    for (let k = 0; k < 4; k++) {
      pts.push([at.x + (ax + ((bx - ax) * k) / 4) * h, at.y + (ay + ((by - ay) * k) / 4 - 1) * h]);
    }
  }
  const [lx, ly] = g[g.length - 1]!;
  pts.push([at.x + lx * h, at.y + (ly - 1) * h]);
  return pts;
}

/** The document box the points of some strokes cover. */
function boxOfPoints(strokes: Pts[]): Rect {
  const xs = strokes.flat().map((p) => p[0] + scrollX);
  const ys = strokes.flat().map((p) => p[1] + scrollY);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** True when the ink a note shows is on the box its strokes were written over, within the pen's width. */
function drawnAt(rig: Rig, id: string, want: Rect): boolean {
  const d = drawn(rig, id);
  return (
    !!d &&
    Math.abs(d.x + d.w / 2 - (want.x + want.w / 2)) < 3 &&
    Math.abs(d.y + d.h / 2 - (want.y + want.h / 2)) < 3 &&
    Math.abs(d.w - want.w) < 6
  );
}

describe('a note beside a formula centred in its column', () => {
  let clock = 0;
  /** A live page changes all the time: a clock, a counter. Every change places the notes again. */
  const startClock = (): void => {
    let n = 0;
    clock = window.setInterval(() => {
      document.getElementById('clock')!.textContent = String(++n);
    }, 150);
  };
  afterEach(() => window.clearInterval(clock));

  const open = async (): Promise<{ rig: Rig; at: { x: number; y: number } }> => {
    await page.viewport(1032, 900);
    document.body.innerHTML = PAPER;
    await settle();
    const rig = await openViewer();
    await rig.cmd();
    // Right of the number, in the free half of the formula's own block.
    const num = textRect(document.querySelector('.eq .n')!, '(1)');
    return { rig, at: { x: num.right + 44, y: num.bottom - 2 } };
  };

  test('strokes written one after the other stay one note, where they were written', async () => {
    const { rig, at } = await open();
    startClock();
    const strokes = SUM.map((g) => sumStroke(g, at, 20));
    for (const pts of strokes) await stroke(pts);
    await until(() => rig.notes().length > 0, 'note');
    // Long enough for the page to change and the notes to be placed from their anchors.
    await wait(500);
    window.clearInterval(clock);
    await settle();
    expect(rig.notes().length).toBe(1);
    const n = rig.notes()[0]!;
    expect(n.strokes.length).toBe(SUM.length);
    expect(n.anchor.type).toBe('block');
    const want = boxOfPoints(strokes);
    expect(drawnAt(rig, n.id, want), JSON.stringify([drawn(rig, n.id), want])).toBe(true);
    expect(rig.placed(n.id)!.docked).toBe(false);

    // And after a reload, from the stored record alone.
    const kv = rig.kv;
    rig.viewer.destroy();
    const again = await openViewer(kv);
    await again.viewer.ready;
    await again.cmd();
    await until(() => !!again.placed(n.id), 'placed after reload');
    await settle();
    expect(drawnAt(again, n.id, want), JSON.stringify([drawn(again, n.id), want])).toBe(true);
    expect(again.placed(n.id)!.docked).toBe(false);
  });

  test('strokes written with long pauses are notes of their own, each where it was written', async () => {
    const { rig, at } = await open();
    startClock();
    // The two bars of the equals sign and the m, each after a pause longer than a note stays open.
    const strokes = [SUM[0]!, SUM[1]!, SUM[5]!].map((g) => sumStroke(g, at, 20));
    for (const pts of strokes) {
      await stroke(pts);
      await wait(1700);
    }
    window.clearInterval(clock);
    await settle();
    const notes = rig.notes();
    expect(notes.length).toBe(strokes.length);
    notes.forEach((n, i) => {
      const want = boxOfPoints([strokes[i]!]);
      expect(drawnAt(rig, n.id, want), `stroke ${i} ${JSON.stringify([drawn(rig, n.id), want])}`).toBe(true);
    });
  });
});
