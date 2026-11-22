import { afterAll, afterEach, beforeAll, expect, describe as group, test } from 'vitest';
import { page } from 'vitest/browser';
import type { Anchor, AnchorContext, Rect } from '../types';
import { describe } from './describe';
import {
  articleHtml,
  docRect,
  gapBoxes,
  layoutHtml,
  mount,
  reveal,
  rng,
  textPieces,
  wordRange,
} from './fixtures';
import { createResolver } from './resolve';
import { dropModel } from './text';

/** Boxes of every kind on the article page: words, margins, gaps, media, blank space. */
function boxes(seed: number): Rect[] {
  const r = rng(seed);
  const out: Rect[] = [];
  const paras = [...document.querySelectorAll('main p:not(.hidden)')].filter((p) => !p.closest('.scroller'));
  for (const p of paras) {
    const words = (p.textContent ?? '').split(/\s+/).filter(Boolean).length;
    for (let i = 0; i < 3; i++) {
      const a = Math.floor(r() * (words - 3));
      const range = wordRange(p, a, a + Math.floor(r() * 3));
      const rect = range.getClientRects()[0]!;
      out.push({
        x: rect.left + scrollX - 2,
        y: rect.top + scrollY - 2,
        w: rect.width + 4,
        h: rect.height + 4,
      });
    }
    const pr = docRect(p);
    const main = docRect(document.querySelector('main')!);
    const leftRoom = pr.x - main.x + 16;
    if (pr.x > 30)
      out.push({
        x: pr.x - Math.min(60, pr.x - 4),
        y: pr.y + r() * pr.h * 0.6,
        w: Math.min(50, pr.x - 8),
        h: 30,
      });
    else if (leftRoom > 10) out.push({ x: 2, y: pr.y + 4, w: 8, h: 20 });
    const right = pr.x + pr.w;
    if (innerWidth - right > 30)
      out.push({ x: right + 8, y: pr.y + r() * pr.h * 0.6, w: Math.min(60, innerWidth - right - 12), h: 28 });
    // Inside the block but past the end of its last line: place on.
    const lines = wordRange(p, 0, 9999).getClientRects();
    const last = lines[lines.length - 1]!;
    if (pr.x + pr.w - last.right > 40) {
      out.push({ x: last.right + scrollX + 12, y: last.top + scrollY + 2, w: 20, h: last.height - 4 });
    }
    // In the gap after this paragraph, once near it and once near what follows.
    out.push({ x: pr.x + 20, y: pr.y + pr.h + 2, w: 80, h: 6 });
    out.push({ x: pr.x + 20, y: pr.y + pr.h + 10, w: 80, h: 6 });
  }
  for (const sel of ['figure img', 'table', '.pdfpage']) {
    const m = docRect(document.querySelector(sel)!);
    out.push({ x: m.x + m.w * 0.2, y: m.y + m.h * 0.2, w: m.w * 0.5, h: m.h * 0.5 });
  }
  const blank = docRect(document.getElementById('blank-area')!);
  out.push({ x: blank.x + 20, y: blank.y + 300, w: 120, h: 60 });
  return out;
}

function ctxBoxes(ctx: AnchorContext): Rect[] {
  // Words inside shadow trees and the inner scroller.
  const out: Rect[] = [];
  const open = document.querySelector('open-card')!.shadowRoot!;
  const closed = ctx.shadowRootOf!(document.querySelector('closed-card')!)!;
  for (const root of [open, closed]) {
    const p = root.querySelector('p')!;
    const rect = wordRange(p, 2, 3).getClientRects()[0]!;
    out.push({
      x: rect.left + scrollX - 1,
      y: rect.top + scrollY - 1,
      w: rect.width + 2,
      h: rect.height + 2,
    });
  }
  const sp = document.querySelector('.scroller p')!;
  const rect = wordRange(sp, 1, 2).getClientRects()[0]!;
  out.push({ x: rect.left + scrollX - 1, y: rect.top + scrollY - 1, w: rect.width + 2, h: rect.height + 2 });
  const h = document.querySelector('header span')!;
  const hr = h.getBoundingClientRect();
  out.push({ x: hr.left + scrollX, y: hr.top + scrollY, w: 40, h: hr.height });
  return out;
}

let saved: [number, number] = [0, 0];
beforeAll(() => {
  saved = [innerWidth, innerHeight];
});
afterAll(async () => {
  await page.viewport(saved[0], saved[1]);
});
afterEach(() => {
  dropModel(document);
  scrollTo(0, 0);
});

group('describe then resolve gives the same origin', () => {
  for (const width of [390, 820, 1280]) {
    test(`article at ${width} px`, async () => {
      await page.viewport(width, 800);
      const { ctx } = mount(articleHtml(3 + width));
      const resolver = createResolver(ctx);
      const types = new Map<string, number>();
      const places = new Set<string>();
      let all = boxes(width);
      let checked = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (const box of all) {
          reveal(box);
          const d = describe(ctx, box);
          types.set(d.anchor.type, (types.get(d.anchor.type) ?? 0) + 1);
          if (d.anchor.type === 'block') places.add(d.anchor.place);
          // Resolve at another scroll position: the result is in document space.
          scrollTo(0, 0);
          const res = resolver.resolve(d.anchor, d.frame);
          expect(res, JSON.stringify(d.anchor)).not.toBeNull();
          expect(
            Math.abs(res!.origin.x - d.origin.x),
            `${d.anchor.type} ${d.anchor.place} x`,
          ).toBeLessThanOrEqual(0.5);
          expect(
            Math.abs(res!.origin.y - d.origin.y),
            `${d.anchor.type} ${d.anchor.place} y`,
          ).toBeLessThanOrEqual(0.5);
          expect(res!.scale).toBeCloseTo(1, 5);
          checked++;
        }
        all = ctxBoxes(ctx);
      }
      expect(checked).toBeGreaterThan(40);
      for (const t of ['text', 'block', 'media', 'viewport'])
        expect(types.get(t) ?? 0, `${t} ${[...types]}`).toBeGreaterThan(0);
      expect(places.has('below')).toBe(true);
      expect(places.has('above')).toBe(true);
      expect(places.has('on')).toBe(true);
      if (width >= 820) {
        expect(places.has('left')).toBe(true);
        expect(places.has('right')).toBe(true);
      }
    });
  }

  for (const width of [1280, 1024]) {
    test(`margin boxes on a page with sidebars, floats and columns at ${width} px`, async () => {
      await page.viewport(width, 800);
      const { ctx } = mount(layoutHtml(width));
      const resolver = createResolver(ctx);
      const places = new Set<string>();
      for (const box of gapBoxes(width, textPieces())) {
        reveal(box);
        const d = describe(ctx, box);
        if (d.anchor.type === 'block') places.add(d.anchor.place);
        scrollTo(0, 0);
        const res = resolver.resolve(d.anchor, d.frame);
        const tag = `${d.anchor.type} ${d.anchor.place} ${d.anchor.path.css}`;
        expect(res, tag).not.toBeNull();
        expect(Math.abs(res!.origin.x - d.origin.x), `${tag} x`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(res!.origin.y - d.origin.y), `${tag} y`).toBeLessThanOrEqual(0.5);
      }
      expect(places.has('left')).toBe(true);
      expect(places.has('right')).toBe(true);
    });
  }

  // Content that sits in the middle of a wide block, with empty space on both sides inside the
  // block's own box. Some of it is built from small blocks that repeat: the symbols of a formula.
  const CENTRED: Record<string, string> = {
    'a formula in MathML, centred with its number': `
      <div class="mid" style="display:flex;align-items:center;justify-content:center;gap:30px;margin:14px 0;font-size:22px">
        <math display="block"><mi>d</mi><mo>=</mo><mi>k</mi><msubsup><mo>&int;</mo><mn>0</mn><mi>T</mi></msubsup><mi>&omega;</mi><mo>(</mo><mi>t</mi><mo>)</mo><mspace width="0.2em"/><mi>d</mi><mi>t</mi></math>
        <span style="font-size:15px">(1)</span>
      </div>`,
    'a formula built from small blocks that repeat': `
      <div class="mid" style="display:flex;align-items:baseline;justify-content:center;gap:10px;margin:14px 0;font-size:22px">
        <div>x</div><div>+</div><div>x</div><div>=</div><div>2</div><div>x</div> <span style="font-size:15px">(2)</span>
      </div>`,
    'a short centred line': `<p class="mid" style="text-align:center">Three words here.</p>`,
    'a narrow block centred by its margins, with two lines that are the same': `
      <div class="mid" style="width:220px;margin:14px auto"><div>the same words</div><div>the same words</div></div>`,
  };
  /** A text column with the centred content between two paragraphs. */
  const column = (html: string): AnchorContext => {
    document.body.innerHTML = `
      <style>body{margin:0;font:17px/1.55 Arial,Helvetica,sans-serif} main{margin:22px 240px 60px 40px} p{margin:0 0 14px}</style>
      <main>
        <p>Let the angular speed of the ground image be known. The distance a bee reports is</p>
        ${html}
        <p>with a single gain, fitted once for all colonies. Over open fields the integral grows slowly, so a long trip reads short.</p>
      </main>`;
    dropModel(document);
    return { doc: document };
  };
  /** The box of what an element shows, which can be much narrower than the element. */
  const contentOf = (el: Element): DOMRect => {
    const all = document.createRange();
    all.selectNodeContents(el);
    return all.getBoundingClientRect();
  };
  /** A box in the free space right of an element's content, level with its middle. */
  const rightOf = (el: Element, gap = 44): Rect => {
    const c = contentOf(el);
    return { x: c.right + scrollX + gap, y: c.top + scrollY + c.height / 2 - 11, w: 30, h: 22 };
  };

  for (const [name, html] of Object.entries(CENTRED)) {
    test(`notes on both sides of ${name}`, async () => {
      await page.viewport(1032, 800);
      const ctx = column(html);
      // The space the content leaves free on each side, between the edges of the text column.
      const main = docRect(document.querySelector('main')!);
      const content = contentOf(document.querySelector('.mid')!);
      const top = content.top + scrollY;
      let checked = 0;
      for (const h of [8, 22, content.height]) {
        for (const gap of [12, 44, 90]) {
          for (const box of [
            { x: content.right + scrollX + gap, y: top + (content.height - h) / 2, w: 30, h },
            { x: content.left + scrollX - gap - 30, y: top + (content.height - h) / 2, w: 30, h },
          ]) {
            if (box.x < main.x + 2 || box.x + box.w > main.x + main.w - 2) continue;
            const d = describe(ctx, box);
            const tag = `${d.anchor.type} ${d.anchor.place} "${d.anchor.quote.exact}" ${d.anchor.path.css}, box at ${Math.round(box.x)}, ${h} high`;
            expect(d.anchor.type, tag).toBe('block');
            for (const how of ['resolve', 'quick'] as const) {
              const resolver = createResolver(ctx);
              const res =
                how === 'quick' ? resolver.quick!(d.anchor, d.frame) : resolver.resolve(d.anchor, d.frame);
              // The quick rung may leave a note to the full ladder. It may not place it elsewhere.
              if (how === 'quick' && !res) continue;
              expect(res, `${how} ${tag}`).not.toBeNull();
              expect(Math.abs(res!.origin.x - d.origin.x), `${how} ${tag} x`).toBeLessThanOrEqual(0.5);
              expect(Math.abs(res!.origin.y - d.origin.y), `${how} ${tag} y`).toBeLessThanOrEqual(0.5);
            }
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(10);
    });
  }

  test('a note beside a formula stays beside it when the page around the formula is rebuilt', async () => {
    await page.viewport(1032, 800);
    for (const html of [
      CENTRED['a formula in MathML, centred with its number']!,
      CENTRED['a formula built from small blocks that repeat']!,
    ]) {
      const ctx = column(html);
      const mid = document.querySelector('.mid')!;
      const d = describe(ctx, rightOf(mid));
      expect(d.anchor.type).toBe('block');
      const dx = d.origin.x - docRect(mid).x;
      // A wrapper, a new class and a paragraph above: the stored path names nothing now.
      const wrap = document.createElement('section');
      mid.before(wrap);
      wrap.append(mid);
      mid.className = 'mid moved';
      document.querySelector('main')!.insertAdjacentHTML('afterbegin', '<div>A line that is new.</div>');
      dropModel(document);
      const res = createResolver(ctx).resolve(d.anchor, d.frame)!;
      expect(res).not.toBeNull();
      expect(res.method).not.toBe('path');
      expect(res.el).toBe(mid);
      expect(Math.abs(res.origin.x - docRect(mid).x - dx)).toBeLessThanOrEqual(0.5);
    }
  });

  test('a note beside the second of two formulas that are the same stays beside the second', async () => {
    await page.viewport(1032, 800);
    const formula = CENTRED['a formula built from small blocks that repeat']!;
    const ctx = column(`${formula}<p>Then, by the same steps and for the other side,</p>${formula}`);
    const mids = document.querySelectorAll('.mid');
    for (const mid of mids) {
      const d = describe(ctx, rightOf(mid));
      expect(d.anchor.type).toBe('block');
      const res = createResolver(ctx).resolve(d.anchor, d.frame)!;
      expect(res).not.toBeNull();
      expect(res.el).toBe(mid);
      expect(Math.abs(res.origin.x - d.origin.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(res.origin.y - d.origin.y)).toBeLessThanOrEqual(0.5);
    }
  });

  test('a random sweep of boxes over the whole page', async () => {
    await page.viewport(1024, 768);
    const { ctx } = mount(articleHtml(99));
    const resolver = createResolver(ctx);
    const r = rng(1234);
    const h = document.documentElement.scrollHeight;
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const box = { x: r() * 960, y: r() * (h - 80), w: 10 + r() * 120, h: 8 + r() * 60 };
      reveal(box);
      const d = describe(ctx, box);
      const res = resolver.resolve(d.anchor, d.frame);
      expect(res, JSON.stringify(d.anchor as Anchor)).not.toBeNull();
      expect(Math.abs(res!.origin.x - d.origin.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(res!.origin.y - d.origin.y)).toBeLessThanOrEqual(0.5);
      n++;
    }
    expect(n).toBe(120);
  });
});
