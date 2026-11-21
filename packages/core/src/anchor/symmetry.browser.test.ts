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
