import type { LassoSelect, PickNote, Point, Rect } from '../types';

/** Gap between two boxes. Zero when they touch or overlap. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

export const pickNote: PickNote = (stroke, candidates, opts) => {
  const gapMs = opts?.gapMs ?? 1500;
  const gapPx = opts?.gapPx ?? 40;
  let best: { id: string; d: number; end: number } | null = null;
  for (const c of candidates) {
    // A highlight next to handwriting is a different thought, so tools never mix.
    if (c.tool !== stroke.tool) continue;
    if (Math.abs(stroke.t0 - c.lastEnd) > gapMs) continue;
    const d = rectGap(stroke.bbox, c.bbox);
    if (d > gapPx) continue;
    if (!best || d < best.d || (d === best.d && c.lastEnd > best.end)) best = { id: c.id, d, end: c.lastEnd };
  }
  return best?.id ?? null;
};

/** Even-odd ray test. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A stroke is inside when more than half of its sample points are. A lasso drawn by hand
 * clips the ends of strokes it clearly meant to take.
 */
export const lassoSelect: LassoSelect = (polygon, items) => {
  const strokes: string[] = [];
  const total = new Map<string, number>();
  const hit = new Map<string, number>();
  for (const it of items) {
    total.set(it.note, (total.get(it.note) ?? 0) + 1);
    let inside: boolean;
    if (polygon.length < 3) inside = false;
    else if (it.pts && it.pts.length > 0) {
      const n = it.pts.filter((p) => pointInPolygon(p, polygon)).length;
      inside = n * 2 > it.pts.length;
    } else {
      inside = pointInPolygon({ x: it.bbox.x + it.bbox.w / 2, y: it.bbox.y + it.bbox.h / 2 }, polygon);
    }
    if (inside) {
      strokes.push(it.stroke);
      hit.set(it.note, (hit.get(it.note) ?? 0) + 1);
    }
  }
  const wholeNotes: string[] = [];
  const partialNotes: string[] = [];
  for (const [note, n] of hit) (n === total.get(note) ? wholeNotes : partialNotes).push(note);
  return { strokes, wholeNotes, partialNotes };
};
