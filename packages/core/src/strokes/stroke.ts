import { newId } from '../hash';
import type { HitStroke, MakeStroke, RebaseStroke, Sample, StrokeBBox } from '../types';
import { decodePts, encodePts } from './codec';
import { outlineSegs, penRadius } from './outline';
import { mapPath, pathBox, readPath, writePath } from './path';
import { simplify } from './simplify';

/** Simplify tolerance in note-local units. Well under one screen pixel. */
const EPS = 0.2;

export const makeStroke: MakeStroke = (docSamples, origin, style, opts) => {
  const k = opts?.scale && opts.scale > 0 ? opts.scale : 1;
  const local = docSamples.map((s) => ({
    x: (s.x - origin.x) / k,
    y: (s.y - origin.y) / k,
    p: s.p,
    t: s.t,
  }));
  // The highlighter ignores pressure, so pressure alone never keeps a point.
  const kept = simplify(local, EPS, style.tool === 'hi' ? 0 : style.w / 2);
  const pts = encodePts(kept);
  // The outline is drawn from the full samples so curves keep their shape.
  const d = writePath(outlineSegs(local, style));
  return {
    id: opts?.id ?? newId(),
    t: opts?.t ?? Date.now(),
    tool: style.tool,
    color: style.color,
    w: style.w,
    pts,
    d,
  };
};

export const rebaseStroke: RebaseStroke = (s, dx, dy, scale) => {
  const moved = decodePts(s.pts).map((q) => ({ x: (q.x + dx) * scale, y: (q.y + dy) * scale, p: q.p, t: 0 }));
  const d = writePath(mapPath(readPath(s.d), (x, y) => [(x + dx) * scale, (y + dy) * scale]));
  return {
    ...s,
    id: newId(),
    w: Math.round(s.w * scale * 100) / 100,
    pts: encodePts(moved),
    d,
  };
};

/** Largest distance from the centre line to the outline edge. */
function reach(s: { tool: string; w: number }): number {
  return s.tool === 'hi' ? s.w / 2 : penRadius(s.w, 1);
}

export const strokeBBox: StrokeBBox = (s) => {
  let b = s.d ? pathBox(readPath(s.d)) : null;
  if (!b) {
    const pts = decodePts(s.pts);
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    const r = reach(s);
    b = {
      x0: Math.min(...pts.map((p) => p.x)) - r,
      y0: Math.min(...pts.map((p) => p.y)) - r,
      x1: Math.max(...pts.map((p) => p.x)) + r,
      y1: Math.max(...pts.map((p) => p.y)) + r,
    };
  }
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
};

/** Eraser test. Distance from p to the centre line, against radius plus half the stroke width. */
export const hitStroke: HitStroke = (s, p, radius) => {
  const pts = decodePts(s.pts);
  if (!pts.length) return false;
  const tol = radius + reach(s);
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const q of pts) {
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  if (p.x < x0 - tol || p.y < y0 - tol || p.x > x1 + tol || p.y > y1 + tol) return false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Sample;
    const b = pts[i + 1] ?? a;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= tol) return true;
  }
  return false;
};
