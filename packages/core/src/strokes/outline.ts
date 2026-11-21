import { getStroke } from 'perfect-freehand';
import type { Outline, Sample } from '../types';
import { type Seg, writePath } from './path';
import { simplify } from './simplify';

/** Cubic handle length for a quarter circle. */
const K = 0.5523;

type P3 = [number, number, number];

/** Drop samples closer than gap to the one kept before. The last sample is always kept. */
function thin(samples: Sample[], gap: number): P3[] {
  const out: P3[] = [];
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const s = samples[i] as Sample;
    const p = Number.isFinite(s.p) ? Math.min(1, Math.max(0, s.p)) : 0.5;
    const last = out[out.length - 1];
    if (last && Math.hypot(s.x - last[0], s.y - last[1]) < gap) {
      if (i === n - 1 && out.length > 1) out[out.length - 1] = [s.x, s.y, p];
      continue;
    }
    out.push([s.x, s.y, p]);
  }
  return out;
}

function dot(x: number, y: number, r: number): Seg[] {
  const k = r * K;
  return [
    { c: 'M', p: [x - r, y] },
    { c: 'C', p: [x - r, y - k, x - k, y - r, x, y - r] },
    { c: 'C', p: [x + k, y - r, x + r, y - k, x + r, y] },
    { c: 'C', p: [x + r, y + k, x + k, y + r, x, y + r] },
    { c: 'C', p: [x - k, y + r, x - r, y + k, x - r, y] },
    { c: 'Z', p: [] },
  ];
}

/**
 * Half circle around c of radius r that starts at c + a*r, passes c + b*r and
 * ends at c - a*r. a and b are unit vectors at right angles.
 */
function cap(c: [number, number], a: [number, number], b: [number, number], r: number): Seg[] {
  const k = r * K;
  const [cx, cy] = c;
  return [
    {
      c: 'C',
      p: [
        cx + a[0] * r + b[0] * k,
        cy + a[1] * r + b[1] * k,
        cx + b[0] * r + a[0] * k,
        cy + b[1] * r + a[1] * k,
        cx + b[0] * r,
        cy + b[1] * r,
      ],
    },
    {
      c: 'C',
      p: [
        cx + b[0] * r - a[0] * k,
        cy + b[1] * r - a[1] * k,
        cx - a[0] * r + b[0] * k,
        cy - a[1] * r + b[1] * k,
        cx - a[0] * r,
        cy - a[1] * r,
      ],
    },
  ];
}

/** Edge tolerance in output units. The eye cannot see it; the path gets several times shorter. */
const EDGE_EPS = 0.1;

function simp2(P: [number, number][], eps = EDGE_EPS): [number, number][] {
  return simplify(
    P.map(([x, y]) => ({ x, y, p: 0 })),
    eps,
    0,
  ).map((q): [number, number] => [q.x, q.y]);
}

/** Midpoint quadratic chain through P, as used for smooth outlines. */
function chain(P: [number, number][], segs: Seg[]): void {
  for (let k = 1; k < P.length - 1; k++) {
    const a = P[k] as [number, number];
    const b = P[k + 1] as [number, number];
    segs.push({ c: 'Q', p: [a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  const z = P[P.length - 1] as [number, number];
  segs.push({ c: 'L', p: [z[0], z[1]] });
}

/** Pen radius for a pressure. Light touch still leaves a visible line. */
export const penRadius = (w: number, p: number): number => Math.max(0.35, (w / 2) * (0.35 + 0.95 * p));

/**
 * Variable width pen outline. Ported from a version proven on iPad with a Pencil:
 * a light three tap smoothing, offset edges along the normal, short tapers and
 * round caps. Tapers go by distance, not by sample count, so dense coalesced
 * samples taper the same as sparse ones.
 */
export function penPort(samples: Sample[], w: number): Seg[] {
  const pts = thin(samples, Math.min(1, w / 4));
  const n = pts.length;
  if (!n) return [];
  const first = pts[0] as P3;
  if (n === 1) return dot(first[0], first[1], penRadius(w, first[2]));
  const s: P3[] = pts.map((p, i) => {
    if (i === 0 || i === n - 1) return p;
    const a = pts[i - 1] as P3;
    const b = pts[i + 1] as P3;
    return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4, (a[2] + 2 * p[2] + b[2]) / 4];
  });
  const run: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = s[i - 1] as P3;
    const b = s[i] as P3;
    run.push((run[i - 1] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = run[n - 1] ?? 0;
  if (total < w / 4) return dot(first[0], first[1], penRadius(w, first[2]));
  const taperLen = Math.max(2, w * 2);
  const L: [number, number][] = [];
  const R: [number, number][] = [];
  const N: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = s[Math.max(0, i - 1)] as P3;
    const next = s[Math.min(n - 1, i + 1)] as P3;
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const edge = Math.min(run[i] ?? 0, total - (run[i] ?? 0));
    const taper = Math.min(1, 0.55 + (0.45 * edge) / taperLen);
    const r = penRadius(w, (s[i] as P3)[2]) * taper;
    const c = s[i] as P3;
    L.push([c[0] + nx * r, c[1] + ny * r]);
    R.push([c[0] - nx * r, c[1] - ny * r]);
    N.push([nx, ny]);
  }
  const end = s[n - 1] as P3;
  const start = s[0] as P3;
  const nE = N[n - 1] as [number, number];
  const n0 = N[0] as [number, number];
  const rEnd = penRadius(w, end[2]) * 0.55;
  const r0 = penRadius(w, start[2]) * 0.55;
  const L0 = L[0] as [number, number];
  const segs: Seg[] = [{ c: 'M', p: [L0[0], L0[1]] }];
  chain(simp2(L), segs);
  // End cap bulges forward: from the left edge round to the right edge.
  segs.push(...cap([end[0], end[1]], nE, [nE[1], -nE[0]], rEnd));
  chain(simp2(R.slice().reverse()), segs);
  segs.push(...cap([start[0], start[1]], [-n0[0], -n0[1]], [-n0[1], n0[0]], r0));
  segs.push({ c: 'Z', p: [] });
  return segs;
}

/** Polygon from perfect-freehand to a midpoint quadratic path. */
function polygonPath(poly: number[][]): Seg[] {
  const n = poly.length;
  if (n < 3) return [];
  const at = (i: number): [number, number] => {
    const q = poly[i % n] as number[];
    return [q[0] ?? 0, q[1] ?? 0];
  };
  const p0 = at(0);
  const p1 = at(1);
  const segs: Seg[] = [{ c: 'M', p: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2] }];
  for (let i = 1; i <= n; i++) {
    const a = at(i);
    const b = at(i + 1);
    segs.push({ c: 'Q', p: [a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  segs.push({ c: 'Z', p: [] });
  return segs;
}

/** Pen outline from perfect-freehand, tuned to match the port's widths. */
export function penFreehand(samples: Sample[], w: number): Seg[] {
  const pts = thin(samples, Math.min(1, w / 4));
  if (!pts.length) return [];
  if (pts.length === 1) {
    const p = pts[0] as P3;
    return dot(p[0], p[1], penRadius(w, p[2]));
  }
  const poly = getStroke(pts, {
    size: w * 1.2,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.35,
    simulatePressure: false,
    last: true,
  });
  return polygonPath(simp2(poly as [number, number][]));
}

/**
 * Highlighter: a band of constant width with round ends. Pressure is ignored.
 * Built by perfect-freehand with no thinning so sharp turns stay solid.
 */
export function hiBand(samples: Sample[], w: number): Seg[] {
  const pts = thin(samples, Math.min(2, w / 6)).map((p): P3 => [p[0], p[1], 0.5]);
  if (!pts.length) return [];
  const first = pts[0] as P3;
  if (pts.every((p) => Math.hypot(p[0] - first[0], p[1] - first[1]) < 0.5))
    return dot(first[0], first[1], w / 2);
  const poly = getStroke(pts, {
    size: w,
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.4,
    simulatePressure: false,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
    last: true,
  });
  return polygonPath(simp2(poly as [number, number][]));
}

/**
 * Which pen outline is used. Both were rendered side by side on handwriting,
 * sharp zigzags and slow small writing. The port keeps fine pressure tapers and
 * clean thin ends. perfect-freehand gave blobby round ends and lumpier edges.
 */
export const PEN_OUTLINE: 'port' | 'freehand' = 'port';

export function outlineSegs(samples: Sample[], style: { tool: 'pen' | 'hi'; w: number }): Seg[] {
  if (style.tool === 'hi') return hiBand(samples, style.w);
  return PEN_OUTLINE === 'port' ? penPort(samples, style.w) : penFreehand(samples, style.w);
}

export const outline: Outline = (samples, style) => writePath(outlineSegs(samples, style));
