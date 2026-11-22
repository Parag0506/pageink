// Ink on the words of a table cell is anchored to those words, as on any other text.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import type { AnchorContext, Described, Point, Rect } from '../types';
import { describe } from './describe';
import { docRect, reveal } from './fixtures';
import { createResolver } from './resolve';
import { dropModel } from './text';

let saved: [number, number] = [0, 0];
beforeAll(() => {
  saved = [innerWidth, innerHeight];
});
afterAll(async () => {
  await page.viewport(saved[0], saved[1]);
});
beforeEach(async () => {
  await page.viewport(1100, 800);
  // An article with a box of facts floated beside the text: a short table of label and value.
  document.body.innerHTML = `
    <style>
      html, body { margin: 0; }
      body { font: 17px/1.6 Arial, Helvetica, sans-serif; }
      main { padding: 0 56px 80px 64px; }
      p { margin: 0 0 14px; }
      .facts { float: right; width: 262px; margin: 0 0 14px 24px; border: 1px solid #a2a9b1; font-size: 13px; line-height: 1.45; padding: 6px; box-sizing: border-box; }
      .facts .t { text-align: center; font-weight: 700; font-size: 15px; padding: 4px 0 6px; }
      .facts table { width: 100%; border-collapse: collapse; }
      .facts th { white-space: nowrap; text-align: left; vertical-align: top; padding: 4px 6px 4px 2px; width: 44%; }
      .facts td { padding: 4px 2px; }
      .facts .h { background: #ffe9b3; text-align: center; font-weight: 700; padding: 3px; }
    </style>
    <main>
      <h1>Honeybee navigation</h1>
      <aside class="facts" id="facts">
        <div class="t">Honeybee navigation</div>
        <table id="tbl">
          <tr><td colspan="2" class="h">At a glance</td></tr>
          <tr><th>Foraging range</th><td id="fact">up to 10 km</td></tr>
          <tr><th>Compass</th><td>the Sun, polarised light</td></tr>
          <tr><th>Odometer</th><td>optic flow</td></tr>
          <tr><th>Shared by</th><td>waggle dance</td></tr>
          <tr><th>Known since</th><td>about 1945</td></tr>
        </table>
      </aside>
      ${Array.from({ length: 4 }, () => '<p>A forager keeps track of the angle between her flight and the Sun. Because the Sun moves across the sky, she corrects that angle as the day goes on, using an internal clock.</p>').join('')}
    </main>`;
  dropModel(document);
});
afterEach(() => {
  dropModel(document);
  scrollTo(0, 0);
});

const ctx: AnchorContext = { doc: document };

/** The words of the fact, as a client rect made document space. */
function words(): Rect {
  const r = document.createRange();
  r.selectNodeContents(document.getElementById('fact')!.firstChild!);
  const lines = r.getClientRects();
  expect(lines.length).toBe(1);
  const q = lines[0]!;
  return { x: q.left + scrollX, y: q.top + scrollY, w: q.width, h: q.height };
}

/** The box of a loose circle round a rect: 12 px wider and 9 px taller on each side. */
const around = (r: Rect): Rect => ({ x: r.x - 12, y: r.y - 9, w: r.w + 24, h: r.h + 18 });

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where the centre of the ink is drawn now, for a note whose ink had the box `was`. */
function inkCentre(d: Described, was: Rect): Point {
  const resolver = createResolver(ctx);
  const r = resolver.resolve(d.anchor, d.frame)!;
  expect(r).not.toBeNull();
  const c = centre(was);
  return { x: r.origin.x + (c.x - d.origin.x) * r.scale, y: r.origin.y + (c.y - d.origin.y) * r.scale };
}

function circleTheFact(): { d: Described; box: Rect } {
  const box = around(words());
  reveal(box);
  return { d: describe(ctx, box, { tool: 'pen' }), box };
}

test('a circle round the words of one table cell is anchored to those words', () => {
  const { d } = circleTheFact();
  expect(d.anchor.type).toBe('text');
  expect(d.anchor.quote.exact).toBe('up to 10 km');
});

test('a loose circle is still on its words, a mark that reaches far past them is on the table', () => {
  const w = words();
  const loose = { x: w.x - 22, y: w.y - 18, w: w.w + 44, h: w.h + 36 };
  reveal(loose);
  const d = describe(ctx, loose, { tool: 'pen' });
  expect(d.anchor.type).toBe('text');
  expect(d.anchor.quote.exact).toBe('up to 10 km');
  // As wide as the words, and tall enough to take in the rows above and below.
  const tall = { x: w.x - 6, y: w.y - 50, w: w.w + 12, h: w.h + 100 };
  expect(describe(ctx, tall, { tool: 'pen' }).anchor.type).toBe('media');
});

test('the circle stays on its words when the text of the table grows', () => {
  const { d, box } = circleTheFact();
  // What a reader's larger text setting does: the same table, taller rows.
  document.getElementById('facts')!.style.fontSize = '16px';
  dropModel(document);
  const now = centre(words());
  const ink = inkCentre(d, box);
  expect(Math.abs(ink.x - now.x)).toBeLessThan(2);
  expect(Math.abs(ink.y - now.y)).toBeLessThan(2);
});

test('the circle stays on its words when the label beside them wraps', () => {
  const { d, box } = circleTheFact();
  const before = words();
  for (const th of document.querySelectorAll<HTMLElement>('.facts th')) {
    th.style.whiteSpace = 'normal';
    th.style.width = '30%';
  }
  const first = document.querySelector<HTMLElement>('.facts th')!;
  first.textContent = 'Foraging range of a worker in summer';
  dropModel(document);
  const after = words();
  // The fact moved: its row is taller now and the cell starts further left.
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(8);
  const now = centre(after);
  const ink = inkCentre(d, box);
  expect(Math.abs(ink.x - now.x)).toBeLessThan(2);
  expect(Math.abs(ink.y - now.y)).toBeLessThan(2);
});

test('the circle stays on its words when rows are added above them', () => {
  const { d, box } = circleTheFact();
  const row = document.createElement('tr');
  row.innerHTML = '<th>Family</th><td>Apidae, the bees with pollen baskets</td>';
  document.querySelector('#tbl tr')!.after(row);
  dropModel(document);
  const now = centre(words());
  const ink = inkCentre(d, box);
  expect(Math.abs(ink.x - now.x)).toBeLessThan(2);
  expect(Math.abs(ink.y - now.y)).toBeLessThan(2);
});

test('ink across the cells of a table is anchored to the table', () => {
  const t = docRect(document.getElementById('tbl')!);
  // A tall mark down the middle of the table, over both columns and most rows.
  const box = { x: t.x + t.w * 0.15, y: t.y + t.h * 0.2, w: t.w * 0.6, h: t.h * 0.6 };
  reveal(box);
  const d = describe(ctx, box, { tool: 'pen' });
  expect(d.anchor.type).toBe('media');
  // And so is ink on a table where there are no words.
  const corner = { x: t.x + t.w - 40, y: t.y + t.h - 14, w: 30, h: 10 };
  expect(describe(ctx, corner, { tool: 'pen' }).anchor.type).toBe('media');
});

test('ink over part of a long cell, with its words running out of the box, is anchored to the table', () => {
  const cell = document.querySelector('#tbl tr:nth-child(3) td')!;
  cell.textContent =
    'the Sun, polarised light when the Sun is hidden, the pattern of the sky, landmarks close to home, and a clock that corrects for the time of day';
  document.getElementById('facts')!.style.width = '420px';
  dropModel(document);
  const c = docRect(cell);
  expect(c.h).toBeGreaterThan(60);
  // The middle of the cell: every line under it starts before the box and ends after it.
  const box = { x: c.x + c.w * 0.3, y: c.y + c.h * 0.2, w: c.w * 0.4, h: c.h * 0.6 };
  reveal(box);
  expect(describe(ctx, box, { tool: 'pen' }).anchor.type).toBe('media');
});
