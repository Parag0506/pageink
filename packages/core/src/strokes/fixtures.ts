import type { Sample } from '../types';

/**
 * Handwriting-like test strokes. A seeded generator keeps them the same on
 * every run.
 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Cursive loops written at a steady pace, sampled at 240 Hz like coalesced pen
 * events, with pressure that rises and falls and a little sensor noise.
 */
export function cursive(
  n = 500,
  opts: { x?: number; y?: number; size?: number; seed?: number } = {},
): Sample[] {
  const r = rng(opts.seed ?? 7);
  const size = opts.size ?? 20;
  const x0 = opts.x ?? 20;
  const y0 = opts.y ?? 40;
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / 240;
    const ph = t * Math.PI * 2 * 2.2;
    out.push({
      x: x0 + t * size * 5 + Math.cos(ph) * size * 0.35 + (r() - 0.5) * 0.2,
      y: y0 - Math.sin(ph) * size * 0.6 + Math.sin(t * 3) * size * 0.2 + (r() - 0.5) * 0.2,
      p: 0.45 + 0.3 * Math.sin(t * 5) + (r() - 0.5) * 0.04,
      t: t * 1000,
    });
  }
  return out;
}

/** A zigzag with sharp corners, the hardest case for an outline. */
export function zigzag(): Sample[] {
  const out: Sample[] = [];
  const corners = [
    [10, 10],
    [60, 50],
    [20, 60],
    [80, 20],
    [90, 70],
  ];
  for (let c = 0; c + 1 < corners.length; c++) {
    const a = corners[c] as number[];
    const b = corners[c + 1] as number[];
    for (let i = 0; i < 20; i++) {
      const f = i / 20;
      out.push({
        x: (a[0] ?? 0) + f * ((b[0] ?? 0) - (a[0] ?? 0)),
        y: (a[1] ?? 0) + f * ((b[1] ?? 0) - (a[1] ?? 0)),
        p: 0.5,
        t: 4 * (c * 20 + i),
      });
    }
  }
  const z = corners[corners.length - 1] as number[];
  out.push({ x: z[0] ?? 0, y: z[1] ?? 0, p: 0.5, t: 4 * 81 });
  return out;
}
