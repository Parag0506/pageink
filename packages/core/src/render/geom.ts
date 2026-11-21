import type { Rect, Stroke } from '../types';

/**
 * Ink bounding box in note-local units, padded by the stroke width.
 * Read from the stored points so no layout is needed. Falls back to the
 * numbers in the outline path when a stroke has no points.
 */
export function inkBox(strokes: readonly Stroke[]): Rect | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const s of strokes) {
    const pad = (s.w || 1) * 0.75;
    let any = false;
    const add = (x: number, y: number): void => {
      any = true;
      if (x - pad < x0) x0 = x - pad;
      if (y - pad < y0) y0 = y - pad;
      if (x + pad > x1) x1 = x + pad;
      if (y + pad > y1) y1 = y + pad;
    };
    const p = s.pts;
    if (p.length >= 3) {
      let x = 0;
      let y = 0;
      for (let i = 0; i + 1 < p.length; i += 3) {
        x += p[i]!;
        y += p[i + 1]!;
        add(x / 10, y / 10);
      }
    }
    if (!any && s.d) {
      // The outline already includes the width, so no padding is needed here.
      const nums = s.d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi);
      if (nums) {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const x = Number(nums[i]);
          const y = Number(nums[i + 1]);
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** One decimal, as the stored paths use. */
export function n1(v: number): string {
  return String(Math.round(v * 10) / 10);
}
