import { afterEach, beforeEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import type { Sample } from '../types';
import { describeRange } from './describe';
import { articleHtml, type Fixture, mount, reveal, wordRange } from './fixtures';
import { recognizeTextMark } from './mark';
import { createResolver } from './resolve';
import { dropModel, fold } from './text';

let f: Fixture;
beforeEach(async () => {
  await page.viewport(1024, 800);
  f = mount(articleHtml(5));
});
afterEach(() => {
  dropModel(document);
  scrollTo(0, 0);
});

/** A slightly wobbly horizontal stroke in document space. */
function line(x0: number, x1: number, y: number, wobble = 0.6): Sample[] {
  const out: Sample[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    out.push({ x: x0 + ((x1 - x0) * i) / n, y: y + Math.sin(i * 1.3) * wobble, p: 0.5, t: i * 8 });
  }
  return out;
}

/**
 * Client rect of words a..b, made document space. The words must sit on one line. Where they
 * would wrap with the font here, the paragraph is made just wide enough to hold them.
 */
function words(a: number, b: number) {
  const el = document.getElementById('pc')!;
  const lines = () => new Set([...wordRange(el, a, b).getClientRects()].map((q) => Math.round(q.top))).size;
  if (lines() > 1) {
    el.style.whiteSpace = 'nowrap';
    const right = wordRange(el, a, b).getBoundingClientRect().right;
    el.style.whiteSpace = '';
    el.style.width = `${Math.ceil(right - el.getBoundingClientRect().left) + 2}px`;
  }
  expect(lines()).toBe(1);
  const r = wordRange(el, a, b);
  const rect = r.getClientRects()[0]!;
  reveal({ x: 0, y: rect.top + scrollY, w: 0, h: 0 });
  const now = wordRange(el, a, b).getClientRects()[0]!;
  return {
    left: now.left + scrollX,
    right: now.right + scrollX,
    top: now.top + scrollY,
    h: now.height,
    text: fold(r.toString()),
  };
}

test('highlighter over words gives a highlight on whole words', () => {
  const w = words(1, 3);
  // Start inside the first word and stop inside the last one.
  const s = line(w.left + 6, w.right - 6, w.top + w.h / 2);
  const m = recognizeTextMark(f.ctx, s, 'hi')!;
  expect(m.style).toBe('highlight');
  expect(fold(m.range.toString())).toBe(w.text);
});

test('pen under a line gives an underline, through the middle gives a strike', () => {
  const w = words(2, 4);
  const u = recognizeTextMark(f.ctx, line(w.left, w.right, w.top + w.h + 1), 'pen')!;
  expect(u.style).toBe('underline');
  expect(fold(u.range.toString())).toBe(w.text);
  const s = recognizeTextMark(f.ctx, line(w.left, w.right, w.top + w.h * 0.55), 'pen')!;
  expect(s.style).toBe('strike');
  expect(fold(s.range.toString())).toBe(w.text);
});

test('strokes that are not marks stay ink', () => {
  const w = words(1, 4);
  // A circle around the words.
  const circle: Sample[] = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    circle.push({
      x: (w.left + w.right) / 2 + Math.cos(a) * 60,
      y: w.top + w.h / 2 + Math.sin(a) * 14,
      p: 0.5,
      t: i,
    });
  }
  expect(recognizeTextMark(f.ctx, circle, 'pen')).toBeNull();
  // A slanted line taller than 1.5 lines.
  expect(
    recognizeTextMark(
      f.ctx,
      line(w.left, w.right, w.top).map((p, i) => ({ ...p, y: p.y + i * 2 })),
      'pen',
    ),
  ).toBeNull();
  // A level line in the margin, over no text.
  expect(recognizeTextMark(f.ctx, line(w.left - 200, w.left - 40, w.top + w.h / 2), 'hi')).toBeNull();
  // A line over the top of the letters.
  expect(recognizeTextMark(f.ctx, line(w.left, w.right, w.top + 1), 'pen')).toBeNull();
  // Mostly beyond the end of the text: under 60% of the stroke is on text.
  const el = document.getElementById('pc')!;
  const lastLine = [...wordRange(el, 0, 999).getClientRects()].pop()!;
  const y = lastLine.top + scrollY + lastLine.height / 2;
  const x = lastLine.right + scrollX;
  expect(recognizeTextMark(f.ctx, line(x - 30, x + 200, y), 'hi')).toBeNull();
});

/** Words of an element's first text node with their first client rect, document space. */
function wordBoxes(el: Element) {
  const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() as Text;
  const out: { text: string; left: number; right: number; top: number; h: number }[] = [];
  const re = /\S+/g;
  for (let m = re.exec(node.data); m; m = re.exec(node.data)) {
    const r = document.createRange();
    r.setStart(node, m.index);
    r.setEnd(node, m.index + m[0].length);
    const q = r.getClientRects()[0]!;
    out.push({
      text: m[0],
      left: q.left + scrollX,
      right: q.right + scrollX,
      top: q.top + scrollY,
      h: q.height,
    });
  }
  return out;
}

test('pen under a phrase that ends a line underlines that phrase', () => {
  const el = document.getElementById('pc')!;
  // At least three lines, so there are line ends to write under, with any font.
  const all = document.createRange();
  all.selectNodeContents(el);
  el.style.whiteSpace = 'nowrap';
  const one = all.getBoundingClientRect().width;
  el.style.whiteSpace = '';
  const ws0 = wordBoxes(el);
  if (ws0.at(-1)!.top - ws0[0]!.top < 2 * ws0[0]!.h) el.style.width = `${Math.floor(one / 3)}px`;
  reveal({ x: 0, y: el.getBoundingClientRect().top + scrollY, w: 0, h: 0 });
  const ws = wordBoxes(el);
  let tried = 0;
  for (let k = 1; k + 1 < ws.length; k++) {
    if (Math.abs(ws[k + 1]!.top - ws[k]!.top) < 2) continue;
    const a = ws[k - 1]!;
    const b = ws[k]!;
    for (const over of [0, 3, 8]) {
      const s = line(a.left + 2, b.right + over, b.top + b.h + 1);
      const m = recognizeTextMark(f.ctx, s, 'pen');
      expect(m, `${a.text} ${b.text} +${over}`).not.toBeNull();
      expect(m!.style).toBe('underline');
      expect(fold(m!.range.toString()), `+${over}`).toBe(`${a.text} ${b.text}`);
      tried++;
    }
  }
  expect(tried).toBeGreaterThan(2);
});

/** Every word of an element with its client rects, through links and other inline elements. */
function allWords(el: Element) {
  const out: { text: string; rects: DOMRect[] }[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let glue = false;
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    const re = /\S+/g;
    for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
      const r = document.createRange();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      const rects = [...r.getClientRects()].filter((q) => q.width > 0);
      // A word that runs on into the next text node, as into a note marker, is one word.
      if (glue && m.index === 0 && out.length) {
        out[out.length - 1]!.text += m[0];
        out[out.length - 1]!.rects.push(...rects);
      } else out.push({ text: m[0], rects });
      glue = false;
    }
    glue = !/\s$/.test(n.data);
  }
  return out;
}

test('pen under the last words of lines, through links and note markers', async () => {
  for (const [font, width] of [
    ['16px/1.6 sans-serif', 420],
    ['16px/1.6 sans-serif', 700],
    ['19px/1.6 Georgia, serif', 560],
    ['14px/1.3 serif', 560],
  ] as const) {
    document.body.innerHTML = `<style>body{margin:0;font:${font}}</style><main style="width:${width}px;margin:20px 40px"><p id="lk">${Array.from(
      { length: 14 },
      (_, i) =>
        `The <a href="#a${i}">orchard ${i} keeps</a> its pears near the river, and${i % 3 === 0 ? `<sup><a href="#n">[${i + 1}]</a></sup>` : ''} the gardener writes.`,
    ).join(' ')}</p></main>`;
    dropModel(document);
    const ctx = { doc: document };
    const ws = allWords(document.getElementById('lk')!);
    let tried = 0;
    for (let k = 1; k + 1 < ws.length; k++) {
      const a = ws[k - 1]!;
      const b = ws[k]!;
      const ra = a.rects[0]!;
      const rb = b.rects[b.rects.length - 1]!;
      const next = ws[k + 1]!.rects[0]!;
      if (next.top < rb.top + 2 || Math.abs(ra.top - rb.top) > 2) continue;
      for (const dy of [1, 3, 5, 7]) {
        for (const over of [0, 4, 12]) {
          const y = Math.max(ra.bottom, rb.bottom) + dy + scrollY;
          const m = recognizeTextMark(
            ctx,
            line(ra.left + 2 + scrollX, rb.right + over + scrollX, y, 0.4),
            'pen',
          );
          const tag = `${font} ${width} "${a.text} ${b.text}" dy ${dy} over ${over}: ${m ? fold(m.range.toString()) : 'ink'}`;
          // Not sure is ink. A mark is on the words written under, with the stop that ends them.
          if (!m) continue;
          expect(m.style, tag).toBe('underline');
          const got = fold(m.range.toString());
          expect(got, tag).toBe(`${a.text} ${b.text}`);
          // Found again from its own block, with no document text, and with the full ladder.
          const d = describeRange(ctx, m.range);
          dropModel(document);
          const q = createResolver(ctx).quick!(d.anchor, d.frame);
          if (q) expect(fold(q.range!.toString()), `${tag} quick`).toBe(got);
          const full = createResolver(ctx).resolve(d.anchor, d.frame)!;
          expect(fold(full.range!.toString()), `${tag} full`).toBe(got);
          tried++;
        }
      }
    }
    expect(tried, `${font} ${width}`).toBeGreaterThan(6);
  }
});

test('a mark range describes and resolves to the same words', () => {
  const w = words(4, 6);
  const m = recognizeTextMark(f.ctx, line(w.left, w.right, w.top + w.h / 2), 'hi')!;
  const d = describeRange(f.ctx, m.range);
  expect(d.anchor.type).toBe('text');
  const r = createResolver(f.ctx).resolve(d.anchor, d.frame)!;
  expect(fold(r.range!.toString())).toBe(w.text);
});
