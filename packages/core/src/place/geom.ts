import { unionRects } from '../render/geom';
import type { Place, Point, Rect } from '../types';

// One copy of these pure helpers serves both folders. render/ owns them.
export { inkBox, unionRects as union } from '../render/geom';

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function contains(outer: Rect, inner: Rect, slack = 0.5): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.w <= outer.x + outer.w + slack &&
    inner.y + inner.h <= outer.y + outer.h + slack
  );
}

/** Note-local box to document space at a pose. */
export function placeBox(local: Rect, origin: Point, scale: number): Rect {
  return {
    x: origin.x + local.x * scale,
    y: origin.y + local.y * scale,
    w: local.w * scale,
    h: local.h * scale,
  };
}

/**
 * Clean the client rects of a text range: drop empty rects, drop element
 * boxes that wrap whole lines (they would paint a block), drop duplicates,
 * and join pieces of the same line that touch.
 */
export function lineRects(raw: readonly Rect[]): Rect[] {
  const rs = raw.filter((r) => r.w > 0.5 && r.h > 0.5);
  if (rs.length === 0) return [];
  const hs = rs.map((r) => r.h).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)]!;
  // A rect much taller than a line is a block box; one that holds another rect is a wrapper.
  const kept = rs.filter((r, i) => {
    if (r.h > med * 1.6) return false;
    return !rs.some((o, j) => j !== i && contains(r, o, 0.5) && (!contains(o, r, 0.5) || j < i));
  });
  // Pieces of one line can come in any order: a raised note marker or a link in another font
  // starts higher than the words before it. So group by line first, then join along it.
  const mid = (r: Rect): number => r.y + r.h / 2;
  const lines: Rect[][] = [];
  for (const r of kept.sort((a, b) => a.x - b.x)) {
    const c = mid(r);
    const line = lines.find((l) => l.some((o) => Math.abs(mid(o) - c) < Math.min(o.h, r.h) / 2));
    if (line) line.push(r);
    else lines.push([r]);
  }
  const out: Rect[] = [];
  for (const line of lines) {
    let last: Rect | undefined;
    for (const r of line) {
      if (last && r.x <= last.x + last.w + 2) {
        const y0 = Math.min(last.y, r.y);
        last.w = Math.max(last.x + last.w, r.x + r.w) - last.x;
        last.h = Math.max(last.y + last.h, r.y + r.h) - y0;
        last.y = y0;
      } else {
        last = { ...r };
        out.push(last);
      }
    }
  }
  return out.sort((a, b) => a.y - b.y);
}

/**
 * How a margin note sits now: beside its block (R, L), in the gap above (A) or below (B) it, in a
 * gap further away (G), or folded into a marker (M).
 */
export type DockKind = 'R' | 'L' | 'A' | 'B' | 'G' | 'M';

export interface DockInput {
  /** Ink box in note-local units. */
  local: Rect;
  /** Where the anchor puts the note. */
  origin: Point;
  scale: number;
  place: Place;
  anchorBox: Rect;
  /** Text lines of the anchor block, document space. Empty when not known. */
  own?: readonly Rect[];
  /** The line the note belongs to. */
  line?: Rect;
  /** Width of the document as the reader sees it. */
  docW: number;
  /** Text lines, media and controls near the anchor, document space. */
  obstacles: readonly Rect[];
  /** Boxes of other ink and markers. */
  taken: readonly Rect[];
  /** How far above and below the block to look for a gap: about a screen. */
  reach?: number;
  /** Height of the document. Ink never goes below it. */
  docH?: number;
  /** Right to left text: the line end is on the left. */
  rtl?: boolean;
  /** Where the note sat after the last pass. It keeps that place on small layout changes. */
  prev?: DockKind;
}

export interface DockResult {
  origin: Point;
  scale: number;
  /** The ink box, or the marker box for a folded note. */
  box: Rect;
  kind: DockKind;
  /** Leader line: through these points to the last one, which is on the anchor line. */
  leader?: Point[];
}

const GAP = 8;
const PAD = 4;
/** Free space keeps this far from text. */
const P = 2;
/** Least scale a docked note may take, relative to its anchor scale. Below this, ink is hard to read. */
export const MIN_DOCK = 0.5;
/** Least scale for a note beside the paragraph. When a side needs less, the note goes to a gap instead. */
export const MIN_SIDE = 0.75;
/** A note keeps its place down to this share of the usual limit, and takes an earlier one only above its inverse. */
const HOLD = 0.9;
/** Marker size in CSS px. */
export const MARK = 22;
/** A note this close to its line needs no leader. */
const NEAR = 12;

function hits(box: Rect, rects: readonly Rect[], frac: number): boolean {
  const area = box.w * box.h || 1;
  return rects.some((r) => overlapArea(box, r) > area * frac);
}

/** True when a margin note at its anchored place falls off the document or over content. */
export function needsDock(box: Rect, docW: number, obstacles: readonly Rect[]): boolean {
  if (box.x < -1 || box.x + box.w > docW + 1) return true;
  return hits(box, obstacles, 0.2);
}

/** True when no rect comes within `pad` of the box. A negative pad lets edges touch. */
export function free(box: Rect, rects: readonly Rect[], pad = P): boolean {
  for (const r of rects) {
    if (
      box.x < r.x + r.w + pad &&
      r.x < box.x + box.w + pad &&
      box.y < r.y + r.h + pad &&
      r.y < box.y + box.h + pad
    )
      return false;
  }
  return true;
}

/** True when the box is inside the document and covers no text, media or control. */
export function fits(box: Rect, docW: number, obstacles: readonly Rect[]): boolean {
  return box.x >= -1 && box.x + box.w <= docW + 1 && free(box, obstacles, -1);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** True when the segment from a to b runs through the inside of r. */
function crosses(a: Point, b: Point, r: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x - 1, r.x + r.w - 1 - a.x, a.y - r.y - 1, r.y + r.h - 1 - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return false;
      continue;
    }
    const t = qi / pi;
    if (pi < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-6;
}

/**
 * The leader from a docked note to the nearest edge of its line, through the gutter when a
 * straight line would cross text. Undefined when the note sits right next to its line.
 */
export function leader(box: Rect, line: Rect, obstacles: readonly Rect[], docW: number): Point[] | undefined {
  const dx = Math.max(line.x - box.x - box.w, box.x - line.x - line.w, 0);
  const dy = Math.max(line.y - box.y - box.h, box.y - line.y - line.h, 0);
  if (Math.hypot(dx, dy) <= NEAR) return undefined;
  const cy = line.y + line.h / 2;
  // Pieces of the anchor line itself are where the leader ends, not text it crosses.
  const others = obstacles.filter((r) => !(r.y < cy && r.y + r.h > cy));
  const near = (t: Point): Point => ({
    x: clamp(t.x, box.x, box.x + box.w),
    y: clamp(t.y, box.y, box.y + box.h),
  });
  const ex = box.y >= line.y + line.h ? line.y + line.h : box.y + box.h <= line.y ? line.y : cy;
  const right = { x: line.x + line.w, y: cy };
  const left = { x: line.x, y: cy };
  const paths: Point[][] = [
    [{ x: clamp(box.x + box.w / 2, line.x, line.x + line.w), y: ex }],
    [right],
    [left],
  ];
  const y0 = Math.min(box.y, line.y);
  const y1 = Math.max(box.y + box.h, line.y + line.h);
  const band = others.filter((r) => r.y < y1 && r.y + r.h > y0);
  const gr = Math.min(docW - 2, Math.max(right.x, box.x + box.w, ...band.map((r) => r.x + r.w)) + 4);
  const gl = Math.max(2, Math.min(left.x, box.x, ...band.map((r) => r.x)) - 4);
  const sy = box.y + box.h / 2;
  paths.push([{ x: gr, y: sy }, { x: gr, y: cy }, right], [{ x: gl, y: sy }, { x: gl, y: cy }, left]);
  let best: Point[] | undefined;
  let cost = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    let a = near(path[0]!);
    let c = 0;
    for (const b of path) {
      for (const r of others) if (crosses(a, b, r)) c += 1e4;
      c += Math.hypot(b.x - a.x, b.y - a.y);
      a = b;
    }
    if (c < cost) {
      cost = c;
      best = path;
    }
  }
  return best;
}

/**
 * Free space for a margin note that no longer fits beside its block. In order: the same side if a
 * gutter is wide enough, the other side, the gap above the block, the gap below, the nearest gap
 * further away within `reach`, then either side at the least scale. Free means no text line,
 * media, control or other ink within a couple of pixels. The note shrinks to fit, never below
 * MIN_DOCK. With no such space it folds into a small marker in the nearest sliver beside its
 * line: the line end, the block's top corner, or the page edge. The last place is held on small
 * changes: it stays down to HOLD of the usual limit, and an earlier place must beat the limit by as
 * much to take over.
 */
export function dock(inp: DockInput): DockResult {
  const { local, scale, anchorBox: ab, docW, prev } = inp;
  const want = placeBox(local, inp.origin, scale);
  const own = inp.own?.length ? inp.own : [ab];
  const top = Math.min(...own.map((r) => r.y));
  const bot = Math.max(...own.map((r) => r.y + r.h));
  const line = inp.line ?? own[0]!;
  // Only what lies within reach can matter.
  const reach = inp.reach ?? 800;
  const lo = Math.max(0, ab.y - reach);
  const hi = Math.min(ab.y + ab.h + reach, inp.docH ?? Number.POSITIVE_INFINITY);
  const near = (r: Rect): boolean => r.y + r.h > lo - MARK && r.y < hi + MARK;
  const block = [...inp.obstacles.filter(near), ...own];
  const taken = inp.taken.filter(near);
  const all = [...block, ...taken];
  const inDoc = (b: Rect): boolean => b.x >= PAD - 0.5 && b.x + b.w <= docW - PAD + 0.5;
  const ok = (b: Rect): boolean => inDoc(b) && free(b, all);
  const out = (box: Rect, s: number, kind: DockKind): DockResult => ({
    origin: { x: box.x - local.x * s, y: box.y - local.y * s },
    scale: s,
    box,
    kind,
    leader: leader(box, line, block, docW),
  });
  const first: 'R' | 'L' = inp.place === 'left' || (inp.place !== 'right' && inp.rtl) ? 'L' : 'R';
  const other: 'R' | 'L' = first === 'R' ? 'L' : 'R';
  const order: DockKind[] =
    inp.place === 'above'
      ? ['A', 'B', first, other, 'G']
      : inp.place === 'below'
        ? ['B', 'A', first, other, 'G']
        : [first, other, 'A', 'B', 'G'];
  const rank = (k: DockKind): number => (k === 'M' ? 9 : order.indexOf(k));
  // An earlier place must clear its limit by a margin before the note leaves the one it has.
  const hold = (k: DockKind): number =>
    prev === undefined ? 1 : k === prev ? HOLD : rank(k) < rank(prev) ? 1 / HOLD : 1;
  const least = (k: DockKind, base: number): number => Math.max(MIN_DOCK, base * hold(k)) * scale;
  /** Heights to try: the wanted one first, then just clear of each box already taken. */
  const ys = (y0: number, h: number, lo: number, hi: number): number[] => {
    const c = [y0];
    for (const t of taken) c.push(t.y + t.h + P + 1, t.y - h - P - 1);
    return c
      .filter((y) => y >= lo - 0.5 && y <= hi + 0.5)
      .sort((a, b) => Math.abs(a - y0) - Math.abs(b - y0));
  };

  const side = (k: 'R' | 'L', base: number): DockResult | null => {
    const edge =
      k === 'R' ? Math.max(...own.map((r) => r.x + r.w)) + GAP : Math.min(...own.map((r) => r.x)) - GAP;
    const avail = k === 'R' ? docW - PAD - edge : edge - PAD;
    if (avail <= 0 || local.w <= 0) return null;
    const most = Math.min(scale, avail / local.w);
    const min = least(k, base);
    // Smaller steps down to the limit, so a note beside a short block can fit its height too.
    for (let s = most; s >= min - 1e-9; s = s > min ? Math.max(min, s * 0.88) : 0) {
      const w = local.w * s;
      const h = local.h * s;
      const x = k === 'R' ? edge : edge - w;
      const lo = top - h / 2;
      const hi = Math.max(lo, bot - h / 2);
      for (const y of ys(clamp(want.y, top, bot - h), h, lo, hi)) {
        const b = { x, y, w, h };
        if (ok(b)) return out(b, s, k);
      }
    }
    return null;
  };

  // Gaps: the spans of height where nothing near the anchor has content.
  const spans = block
    .filter((r) => r.y + r.h > lo && r.y < hi && r.w > 0 && r.h > 0)
    .map((r) => [r.y, r.y + r.h] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let edge = lo;
  for (const [y0, y1] of spans) {
    if (y0 > edge) gaps.push([edge, y0]);
    edge = Math.max(edge, y1);
  }
  if (hi > edge) gaps.push([edge, hi]);
  const gapAt = (g: [number, number], k: DockKind): DockResult | null => {
    const room = g[1] - g[0] - 2 * (P + 1);
    const s = Math.min(scale, room / (local.h || 1), (docW - 2 * PAD) / (local.w || 1));
    if (s <= 0 || s < least(k, MIN_DOCK)) return null;
    const w = local.w * s;
    const h = local.h * s;
    // Above the block, the note hugs the bottom of the gap; elsewhere the top.
    const y = g[1] <= top + 0.5 ? g[1] - P - 1 - h : g[0] + P + 1;
    const r = Math.min(ab.x + ab.w, docW - PAD) - w;
    const l = Math.max(ab.x, PAD);
    const xs = first === 'R' ? [r, l] : [l, r];
    for (const t of taken) if (t.y < y + h && t.y + t.h > y) xs.push(t.x + t.w + P + 1, t.x - w - P - 1);
    for (const x of xs) {
      const b = { x: clamp(x, PAD, docW - PAD - w), y, w, h };
      if (ok(b)) return out(b, s, k);
    }
    return null;
  };
  const above = gaps.filter((g) => g[1] <= top + 0.5).pop();
  const below = gaps.find((g) => g[0] >= bot - 0.5);
  const dist = (g: [number, number]): number => (g[1] <= top ? top - g[1] : g[0] - bot);
  const further = gaps.filter((g) => g !== above && g !== below).sort((a, b) => dist(a) - dist(b));

  const tries: (() => DockResult | null)[] = [];
  for (const k of order) {
    if (k === 'R' || k === 'L') tries.push(() => side(k, MIN_SIDE));
    else if (k === 'A') tries.push(() => (above ? gapAt(above, 'A') : null));
    else if (k === 'B') tries.push(() => (below ? gapAt(below, 'B') : null));
    else for (const g of further) tries.push(() => gapAt(g, 'G'));
  }
  tries.push(
    () => side(first, MIN_DOCK),
    () => side(other, MIN_DOCK),
  );
  for (const t of tries) {
    const d = t();
    if (d) return d;
  }
  return fold(inp, first, line, top, taken, block);
}

/** The marker for a note with no free space: the line end, the block's top corner, then the page edge. */
function fold(
  inp: DockInput,
  k: 'R' | 'L',
  line: Rect,
  top: number,
  taken: readonly Rect[],
  block: readonly Rect[],
): DockResult {
  const all = [...block, ...taken];
  const { anchorBox: ab, docW } = inp;
  const M = MARK;
  const y = line.y + line.h / 2 - M / 2;
  const cand: Rect[] = [];
  for (let i = 0; i < 3; i++) {
    const step = i * (M + P);
    cand.push({ x: k === 'R' ? line.x + line.w + 4 + step : line.x - 4 - M - step, y, w: M, h: M });
  }
  for (let i = 0; i < 3; i++) {
    const step = i * (M + P);
    cand.push({ x: k === 'R' ? ab.x + ab.w - M - step : ab.x + step, y: top - M - P - 1, w: M, h: M });
  }
  const res = (box: Rect): DockResult => ({ origin: inp.origin, scale: inp.scale, box, kind: 'M' });
  for (const c of cand) if (c.x >= 0 && c.x + c.w <= docW && free(c, all, 1)) return res(c);
  // The page edge beside the line, as wide as the strip of free space there, stepping down past other markers.
  for (let i = 0; i < 6; i++) {
    const y0 = y + i * (M + P);
    const row = block.filter((r) => r.y < y0 + M && r.y + r.h > y0);
    const strip =
      k === 'R' ? docW - Math.max(0, ...row.map((r) => r.x + r.w)) : Math.min(docW, ...row.map((r) => r.x));
    const w = Math.max(8, Math.min(M, strip - 1));
    const b = { x: k === 'R' ? docW - w : 0, y: y0, w, h: M };
    if (free(b, taken, 1)) return res(b);
  }
  return res({ x: k === 'R' ? docW - 8 : 0, y, w: 8, h: M });
}

/**
 * The line a margin note belongs to, from the text pieces of its block: the one level with the
 * anchor's y (the quote line), or the first or last line for notes above or below the block.
 */
export function lineAt(own: readonly Rect[], y: number, place: Place): Rect | undefined {
  if (!own.length) return undefined;
  const dist = (r: Rect): number => (y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0);
  let pick = own[0]!;
  for (const r of own) {
    if (
      place === 'above'
        ? r.y < pick.y
        : place === 'below'
          ? r.y + r.h > pick.y + pick.h
          : dist(r) < dist(pick)
    )
      pick = r;
  }
  // Pieces of the same line, in other text nodes or inline elements, make one line.
  const cy = pick.y + pick.h / 2;
  return unionRects(own.filter((r) => r.y < cy && r.y + r.h > cy)) ?? pick;
}
