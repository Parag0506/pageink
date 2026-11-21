import type { DecodePts, EncodePts, Sample } from '../types';

/**
 * FORMAT "Stroke points": integer triples x, y, pressure. x and y in tenths,
 * pressure 0 to 100. The first triple is absolute, the rest are differences.
 * Differences are taken between rounded values so decoding never drifts.
 */
export const encodePts: EncodePts = (samples) => {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  let pp = 0;
  for (const s of samples) {
    const x = Math.round(s.x * 10);
    const y = Math.round(s.y * 10);
    const p = Math.round(Math.min(1, Math.max(0, Number.isFinite(s.p) ? s.p : 0.5)) * 100);
    // Adding 0 turns -0 into 0 so JSON stays clean.
    out.push(x - px + 0, y - py + 0, p - pp + 0);
    px = x;
    py = y;
    pp = p;
  }
  return out;
};

export const decodePts: DecodePts = (pts) => {
  const out: Sample[] = [];
  let x = 0;
  let y = 0;
  let p = 0;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    x += pts[i] ?? 0;
    y += pts[i + 1] ?? 0;
    p += pts[i + 2] ?? 0;
    out.push({ x: x / 10, y: y / 10, p: p / 100, t: 0 });
  }
  return out;
};
