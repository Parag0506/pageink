// The quick path rung: notes placed from their own block, with no document text built.
import { afterEach, expect, test } from 'vitest';
import type { Rect } from '../types';
import { describe } from './describe';
import { articleHtml, docRect, mount, paragraph, reveal, rng, STYLE } from './fixtures';
import { createResolver } from './resolve';
import { dropModel, hasModel } from './text';

afterEach(() => {
  dropModel(document);
  scrollTo(0, 0);
});

const $ = (id: string) => document.getElementById(id)!;

/** Boxes over many places on the article: words, margins, media. */
function boxes(): Rect[] {
  const out: Rect[] = [];
  for (const id of ['pa', 'pb', 'pc', 'pd', 'pe', 'pf', 'pg', 'ph', 'title']) {
    const r = docRect($(id));
    out.push({ x: r.x + 10, y: r.y + 2, w: 60, h: 14 });
    out.push({ x: r.x + r.w - 80, y: r.y + r.h - 16, w: 70, h: 14 });
    out.push({ x: r.x - 50, y: r.y + 4, w: 36, h: 18 });
  }
  const f = docRect($('fig-1'));
  out.push({ x: f.x + 20, y: f.y + 20, w: 50, h: 30 });
  return out;
}

test('the path rung places notes with no document text built, where the full ladder does', () => {
  const fx = mount(articleHtml());
  const written = boxes().map((b) => {
    reveal(b);
    return describe(fx.ctx, b);
  });
  dropModel(document);
  scrollTo(0, 0);
  const quick = createResolver(fx.ctx);
  let decided = 0;
  const got = written.map((d) => {
    const q = quick.quick!(d.anchor, d.frame);
    if (q) decided++;
    return q;
  });
  // The quick rung built no document text: that is what keeps the first pass small.
  expect(hasModel(fx.ctx)).toBe(false);
  expect(quick.ready!()).toBe(false);
  expect(decided).toBeGreaterThan(written.length * 0.8);
  const full = createResolver(fx.ctx);
  written.forEach((d, i) => {
    const q = got[i];
    if (!q) return;
    const f = full.resolve(d.anchor, d.frame)!;
    expect(f.el).toBe(q.el);
    expect(f.origin.x).toBeCloseTo(q.origin.x, 3);
    expect(f.origin.y).toBeCloseTo(q.origin.y, 3);
    expect(f.scale).toBeCloseTo(q.scale, 6);
    expect(f.method).toBe('path');
  });
});

test('a quote at the start of a block gets its context from the block before, not the whole page', () => {
  const r = rng(5);
  const paras = Array.from({ length: 40 }, (_, i) => `<p id="s${i}">${paragraph(r, 3)}</p>`).join('');
  mount(`${STYLE}<main><section>${paras}</section></main>`);
  const ctx = { doc: document };
  const el = $('s20');
  const range = document.createRange();
  range.setStart(el.firstChild!, 0);
  range.setEnd(el.firstChild!, 6);
  const rr = range.getBoundingClientRect();
  const box = { x: rr.left + scrollX, y: rr.top + scrollY, w: rr.width, h: rr.height };
  reveal(box);
  const d = describe(ctx, box);
  dropModel(document);
  expect(d.anchor.quote.prefix.length).toBeGreaterThan(0);
  const q = createResolver(ctx).quick!(d.anchor, d.frame);
  expect(q?.el).toBe(el);
  expect(hasModel(ctx)).toBe(false);
});

test('when the path no longer holds the quote, the quick rung leaves it to the full ladder', () => {
  const fx = mount(articleHtml());
  const b = docRect($('pc'));
  const box = { x: b.x + 10, y: b.y + 2, w: 60, h: 14 };
  reveal(box);
  const d = describe(fx.ctx, box);
  // The paragraph moves: the path now points at other words, the quote is elsewhere.
  const pc = $('pc');
  pc.parentElement!.insertBefore(pc, $('pg'));
  pc.removeAttribute('id');
  dropModel(document);
  const res = createResolver(fx.ctx);
  expect(res.quick!(d.anchor, d.frame)).toBeUndefined();
  expect(res.resolve(d.anchor, d.frame)?.el).toBe(pc);
});

test('a hidden ancestor or a shadow tree is left to the full ladder', () => {
  const fx = mount(articleHtml());
  const host = $('oc');
  const inner = host.shadowRoot!.querySelector('p')!;
  const ir = inner.getBoundingClientRect();
  const box = { x: ir.left + scrollX + 5, y: ir.top + scrollY + 2, w: 50, h: 14 };
  reveal(box);
  const d = describe(fx.ctx, box);
  dropModel(document);
  expect(createResolver(fx.ctx).quick!(d.anchor, d.frame)).toBeUndefined();
});
