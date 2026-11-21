import type { Rect } from '../types';

/**
 * The box a `clip-path` value leaves of an element, from its computed value.
 * Simple shapes (inset, rect, xywh) give their own box; circle and ellipse give the box
 * around them. Any other shape gives 'other': the caller keeps ink inside the element's
 * box and hides a note whose anchor lies outside it. Null when nothing is clipped.
 * `box` is the element's border box; `pad` and `border` are its edges, for the other
 * reference boxes. All in the same space.
 */
export type ShapeCut = Rect | 'other' | null;

interface Edges {
  t: number;
  r: number;
  b: number;
  l: number;
}

const NONE: Edges = { t: 0, r: 0, b: 0, l: 0 };

/** A length or a percentage of `of`. NaN when it is neither. */
function len(v: string | undefined, of: number): number {
  if (!v) return Number.NaN;
  const t = v.trim();
  if (t === '0') return 0;
  const m = /^(-?[\d.]+(?:e-?\d+)?)(px|%)$/i.exec(t);
  if (!m) return Number.NaN;
  const n = Number.parseFloat(m[1] ?? '');
  return m[2] === '%' ? (n / 100) * of : n;
}

/** Split on spaces outside brackets. */
function words(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** One position coordinate: a keyword, a length or a percentage of `of`. */
function pos(v: string | undefined, of: number): number {
  switch (v) {
    case undefined:
    case 'center':
      return of / 2;
    case 'left':
    case 'top':
      return 0;
    case 'right':
    case 'bottom':
      return of;
    default:
      return len(v, of);
  }
}

/** The reference box. Margin boxes are taken as the border box: ink is never cut wider than it. */
function refBox(key: string, box: Rect, pad: Edges, border: Edges): Rect {
  const inner = (e: Edges, r: Rect): Rect => ({
    x: r.x + e.l,
    y: r.y + e.t,
    w: Math.max(0, r.w - e.l - e.r),
    h: Math.max(0, r.h - e.t - e.b),
  });
  if (key === 'padding-box') return inner(border, box);
  if (key === 'content-box') return inner(pad, inner(border, box));
  return box;
}

export function shapeCut(value: string, box: Rect, pad: Edges = NONE, border: Edges = NONE): ShapeCut {
  const v = value.trim();
  if (!v || v === 'none') return null;
  const m = /^([a-z-]+)\((.*)\)\s*([a-z-]+)?$/is.exec(v);
  // A reference box alone clips to that box.
  if (!m) {
    if (/^(border|padding|content|margin|fill|stroke|view)-box$/.test(v)) return refBox(v, box, pad, border);
    return 'other';
  }
  const fn = (m[1] ?? '').toLowerCase();
  const args = (m[2] ?? '').trim();
  const b = refBox((m[3] ?? 'border-box').toLowerCase(), box, pad, border);
  const at = (list: string[]): [string[], number, number] => {
    const i = list.indexOf('at');
    const before = i < 0 ? list : list.slice(0, i);
    const after = i < 0 ? [] : list.slice(i + 1);
    let [px, py] = after;
    // "at top" and "at left" name one axis; the other is the centre.
    if (after.length === 1 && (px === 'top' || px === 'bottom')) [px, py] = ['center', px];
    return [before, b.x + pos(px, b.w), b.y + pos(py, b.h)];
  };
  const bad = (...n: number[]) => n.some((x) => !Number.isFinite(x));

  if (fn === 'inset') {
    const parts = words(args.split(/\bround\b/)[0] ?? '');
    const [t, r = t, bt = t, l = r] = parts;
    const ti = len(t, b.h);
    const ri = len(r, b.w);
    const bi = len(bt, b.h);
    const li = len(l, b.w);
    if (bad(ti, ri, bi, li)) return 'other';
    return { x: b.x + li, y: b.y + ti, w: Math.max(0, b.w - li - ri), h: Math.max(0, b.h - ti - bi) };
  }
  if (fn === 'rect') {
    const [t, r, bt, l] = words(args.split(/\bround\b/)[0] ?? '');
    const auto = (s: string | undefined, of: number, end: number) => (s === 'auto' ? end : len(s, of));
    const ti = auto(t, b.h, 0);
    const ri = auto(r, b.w, b.w);
    const bi = auto(bt, b.h, b.h);
    const li = auto(l, b.w, 0);
    if (bad(ti, ri, bi, li)) return 'other';
    return { x: b.x + li, y: b.y + ti, w: Math.max(0, ri - li), h: Math.max(0, bi - ti) };
  }
  if (fn === 'xywh') {
    const [x, y, w, h] = words(args.split(/\bround\b/)[0] ?? '');
    const xi = len(x, b.w);
    const yi = len(y, b.h);
    const wi = len(w, b.w);
    const hi = len(h, b.h);
    if (bad(xi, yi, wi, hi)) return 'other';
    return { x: b.x + xi, y: b.y + yi, w: Math.max(0, wi), h: Math.max(0, hi) };
  }
  if (fn === 'circle' || fn === 'ellipse') {
    const [radii, cx, cy] = at(words(args));
    if (bad(cx, cy)) return 'other';
    const side = (k: string | undefined, axis: 'x' | 'y' | 'r'): number => {
      const dx = [cx - b.x, b.x + b.w - cx];
      const dy = [cy - b.y, b.y + b.h - cy];
      const near = k === 'farthest-side' ? Math.max : Math.min;
      if (axis === 'x') return near(...dx);
      if (axis === 'y') return near(...dy);
      return near(...dx, ...dy);
    };
    const radius = (k: string | undefined, axis: 'x' | 'y' | 'r', of: number): number =>
      k === undefined || k === 'closest-side' || k === 'farthest-side' ? side(k, axis) : len(k, of);
    let rx: number;
    let ry: number;
    if (fn === 'circle') {
      // A percentage radius is of the box diagonal over the square root of two.
      rx = ry = radius(radii[0], 'r', Math.hypot(b.w, b.h) / Math.SQRT2);
    } else {
      rx = radius(radii[0], 'x', b.w);
      ry = radius(radii[1] ?? radii[0], 'y', b.h);
    }
    if (bad(rx, ry)) return 'other';
    return { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry };
  }
  return 'other';
}
