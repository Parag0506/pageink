import type { MarkStyle, Rect } from '../types';
import { n1 } from './geom';

/** FNV-1a. Seeds the wobble so a note redraws the same way every time. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic generator (mulberry32). Returns values in [-1, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Points along x from x0 to x1, about every 40 px, at least the two ends. */
function stations(x0: number, x1: number): number[] {
  const n = Math.max(1, Math.round((x1 - x0) / 40));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
  return out;
}

/** A wobbly band: an upper edge forward and a lower edge back, closed. */
function band(x0: number, x1: number, top: number, bottom: number, r: () => number, amp: number): string {
  const xs = stations(x0, x1);
  const up = xs.map((x) => `${n1(x)} ${n1(top + r() * amp)}`);
  const down = xs.reverse().map((x) => `${n1(x)} ${n1(bottom + r() * amp)}`);
  return `M${up.join('L')}L${down.join('L')}Z`;
}

/**
 * Path for one text mark over the given rects, in the rects' own space.
 * The wobble depends only on the seed and the rect index, so a redraw of the
 * same layout gives the same path.
 */
export function markPath(style: MarkStyle, rects: readonly Rect[], seed: number): string {
  const parts: string[] = [];
  rects.forEach((rc, i) => {
    const r = rng(seed + i * 7919);
    const h = rc.h;
    if (style === 'highlight') {
      const amp = Math.min(1.2, h * 0.05);
      const x0 = rc.x - 1 + r() * 1.5;
      const x1 = rc.x + rc.w + 1 + r() * 1.5;
      parts.push(band(x0, x1, rc.y + h * 0.04, rc.y + h * 0.98, r, amp));
      return;
    }
    const th = Math.min(3, Math.max(1.2, h * 0.07));
    const yc = style === 'underline' ? rc.y + h * 0.93 : rc.y + h * 0.56;
    const amp = Math.min(0.8, th * 0.35);
    const x0 = rc.x + r() * 1.2;
    const x1 = rc.x + rc.w + r() * 1.2;
    parts.push(band(x0, x1, yc - th / 2, yc + th / 2, r, amp));
  });
  return parts.join('');
}
