/**
 * Recognising text marks (DESIGN 7.3). A near straight stroke, less than 1.5 line
 * heights tall, that runs over text on one line for at least 60% of its length. It marks whole
 * words: a word at either end only when the stroke runs along most of it.
 */
import type { AnchorContext, MarkStyle, RecognizeTextMark, Sample, StrokeTool } from '../types';
import { glyphAt, NEW_TEXT } from './describe';
import { charRect, viewOf } from './geom';
import { dropModel, getModel, isWordChar, type Span, type TextModel, widenToWords } from './text';

/** Share of the stroke that must lie over text on one line. */
const COVER = 0.6;
const PROBES = 11;

interface Hit {
  k: number;
  top: number;
  bottom: number;
  /** Stroke height inside the character box: 0 at the top, 1 at the bottom. */
  rel: number;
  /** The stroke is just as close under the line above: in the gap between two lines. */
  unsure?: boolean;
}

/** Below this share of the character box from its top, a pen stroke is over the top of the letters. */
const HIGH = 0.45;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

/** True when the stroke is close to a straight, mostly level line. */
function straight(samples: Sample[]): boolean {
  const a = samples[0]!;
  const b = samples[samples.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (Math.abs(dx) < 12 || Math.abs(dy) > Math.abs(dx) * 0.3) return false;
  let len = 0;
  let dev = 0;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1]!;
    const q = samples[i]!;
    len += Math.hypot(q.x - p.x, q.y - p.y);
    dev = Math.max(dev, Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / chord);
  }
  return len <= chord * 1.35 && dev <= Math.max(6, chord * 0.12);
}

/** Stroke y at a given x, from the nearest sample. */
function yAt(samples: Sample[], x: number): number {
  let best = samples[0]!;
  let bd = Number.POSITIVE_INFINITY;
  for (const s of samples) {
    const d = Math.abs(s.x - x);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best.y;
}

/** Share of a word at an end of the stroke that the stroke must run along to take it in. */
const END_WORD = 0.6;
/**
 * Half of a one letter word is a pixel or two. So the stroke must also run along this share of
 * the line height, or along NARROW_WORD of the word when the word is narrower than that.
 */
const END_WORD_MIN = 0.25;
const NARROW_WORD = 0.8;

/** Left and right of the part of [a, b) drawn on the line through midY. Null when none is. */
function extentOnLine(
  m: TextModel,
  a: number,
  b: number,
  midY: number,
  lineH: number,
): { l: number; r: number } | null {
  const range = m.range(a, b);
  if (!range) return null;
  let l = Number.POSITIVE_INFINITY;
  let r = Number.NEGATIVE_INFINITY;
  for (const q of range.getClientRects()) {
    if (q.width <= 0 || Math.abs((q.top + q.bottom) / 2 - midY) > lineH / 2) continue;
    l = Math.min(l, q.left);
    r = Math.max(r, q.right);
  }
  return l < r ? { l, r } : null;
}

/**
 * Drops a word at either end of the span that the stroke only touches. A hand runs a little
 * past the last word, or starts a little before the first, and that must not mark the
 * neighbour. A word here is the text between two spaces, with its punctuation.
 */
function trimEnds(m: TextModel, w: Span, x0: number, x1: number, midY: number, lineH: number): void {
  const t = m.text;
  const kept = (a: number, b: number): boolean => {
    const x = extentOnLine(m, a, b, midY, lineH);
    // Text that cannot be measured is never dropped.
    if (!x) return true;
    const width = x.r - x.l;
    const need = Math.max(width * END_WORD, Math.min(width * NARROW_WORD, lineH * END_WORD_MIN));
    return Math.min(x1, x.r) - Math.max(x0, x.l) >= need;
  };
  for (;;) {
    let b = w.start;
    while (b < w.end && t[b] !== ' ') b++;
    // One word left: the stroke is on this line and on text, so it is the word meant.
    if (b >= w.end) return;
    let a = w.start;
    while (a > 0 && t[a - 1] !== ' ') a--;
    if (kept(a, b)) break;
    while (b < w.end && t[b] === ' ') b++;
    w.start = b;
  }
  for (;;) {
    let a = w.end;
    while (a > w.start && t[a - 1] !== ' ') a--;
    if (a <= w.start) return;
    let b = w.end;
    while (b < t.length && t[b] !== ' ') b++;
    if (kept(a, b)) break;
    while (a > w.start && !isWordChar(t[a - 1])) a--;
    w.end = a;
  }
}

export const recognizeTextMark: RecognizeTextMark = (
  ctx: AnchorContext,
  docSamples: Sample[],
  tool: StrokeTool,
): { range: Range; style: MarkStyle } | null => {
  if (docSamples.length < 2 || !straight(docSamples)) return null;
  return recognize(ctx, docSamples, tool, false);
};

function recognize(
  ctx: AnchorContext,
  docSamples: Sample[],
  tool: StrokeTool,
  retried: boolean,
): { range: Range; style: MarkStyle } | null {
  const m = getModel(ctx);
  const v = viewOf(ctx.doc);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of docSamples) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
  }

  const hits: Hit[] = [];
  let em = 0;
  for (let i = 0; i < PROBES; i++) {
    const x = minX + ((maxX - minX) * (i + 0.5)) / PROBES;
    const y = yAt(docSamples, x);
    const cx = x - v.sx;
    const cy = y - v.sy;
    // An underline sits below the letters, so a pen also looks a little above itself.
    const lifts = tool === 'hi' ? [0] : [0, 0.2, 0.4, 0.6];
    let hit: Hit | null = null;
    for (const lift of lifts) {
      const k = glyphAt(m, cx, cy - lift * (em || 16), 2, true);
      if (k === NEW_TEXT && !retried) {
        // Text the model has not seen: the page changed. Rebuild once.
        dropModel(ctx.doc);
        return recognize(ctx, docSamples, tool, true);
      }
      if (k < 0) continue;
      const r = m.range(k, k + 1)!.getBoundingClientRect();
      if (!em) em = r.height;
      const h: Hit = { k, top: r.top, bottom: r.bottom, rel: (cy - r.top) / r.height };
      if (!hit) {
        hit = h;
        // Over the top of a line's letters, the pen may be under the line above instead.
        if (lift === 0 && tool !== 'hi' && h.rel < HIGH) continue;
        break;
      }
      if (h.bottom <= hit.top + 1) {
        hit.unsure = true;
        break;
      }
    }
    if (hit) hits.push(hit);
  }
  if (!hits.length) return null;

  // Group hits by line and keep the line with most of them.
  const lines: Hit[][] = [];
  for (const h of hits) {
    const mid = (h.top + h.bottom) / 2;
    const line = lines.find((l) => mid > l[0]!.top && mid < l[0]!.bottom);
    if (line) line.push(h);
    else lines.push([h]);
  }
  lines.sort((a, b) => b.length - a.length);
  const line = lines[0]!;
  if (line.length < PROBES * COVER) return null;

  const lineH = median(line.map((h) => h.bottom - h.top));
  if (maxY - minY >= lineH * 1.5) return null;

  let style: MarkStyle;
  if (tool === 'hi') style = 'highlight';
  else {
    const rel = median(line.map((h) => h.rel));
    if (rel < 0.3) return null;
    style = rel < 0.75 ? 'strike' : 'underline';
    // Between two lines it could underline the one or strike the other. A wrong mark is worse
    // than ink, so it stays ink.
    if (style === 'strike' && line.filter((h) => h.unsure).length * 2 >= line.length) return null;
  }

  let s = Math.min(...line.map((h) => h.k));
  let e = Math.max(...line.map((h) => h.k)) + 1;
  // Reach the ends of the stroke on the same line.
  const midY = (line[0]!.top + line[0]!.bottom) / 2;
  const left = glyphAt(m, minX - v.sx + 1, midY, 2, true);
  const right = glyphAt(m, maxX - v.sx - 1, midY, 2, true);
  if (left >= 0 && left < s) s = left;
  if (right >= 0 && right + 1 > e) e = right + 1;
  const w = widenToWords(m.text, s, e);
  const t = m.text;
  trimEnds(m, w, minX - v.sx, maxX - v.sx, midY, lineH);
  // No word is left when the stroke only touched one and ran under a dash beside it.
  if (w.end <= w.start) return null;
  // Punctuation after the last word, such as the stop that ends a line, belongs to the mark when
  // the stroke runs under it.
  let pe = w.end;
  while (pe < w.end + 3 && t[pe] && t[pe] !== ' ' && !isWordChar(t[pe])) pe++;
  const r = pe > w.end && !isWordChar(t[pe]) ? charRect(m, pe - 1) : null;
  if (r && r.left < maxX - v.sx && Math.abs(r.top + r.bottom - 2 * midY) < r.height) w.end = pe;
  const range = m.range(w.start, w.end);
  return range ? { range, style } : null;
}
