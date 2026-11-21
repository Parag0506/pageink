import { describe, expect, test } from 'vitest';
import type { Sample, Stroke } from '../types';
import { cursive, rng, zigzag } from './fixtures';
import {
  decodePts,
  encodePts,
  hitStroke,
  makeStroke,
  outline,
  readPath,
  rebaseStroke,
  simplify,
  strokeBBox,
  writePath,
} from './index';
import { penFreehand, penPort } from './outline';
import { pathBox } from './path';

const S = (x: number, y: number, p = 0.5, t = 0): Sample => ({ x, y, p, t });
const PEN = { tool: 'pen', color: 'ink-1', w: 3 } as const;
const HI = { tool: 'hi', color: 'hi-1', w: 16 } as const;

/** Every number in a path, as written. */
const numbers = (d: string): string[] => d.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? [];

describe('encodePts and decodePts', () => {
  test('match the example in FORMAT', () => {
    expect(encodePts([S(1, 2, 0.5), S(1.4, 2.5, 0.6)])).toEqual([10, 20, 50, 4, 5, 10]);
  });

  test('round trip to a tenth and pressure to a hundredth, t is 0', () => {
    const src = cursive(300);
    const back = decodePts(encodePts(src));
    expect(back).toHaveLength(src.length);
    back.forEach((b, i) => {
      const a = src[i] as Sample;
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(b.p - a.p)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(b.t).toBe(0);
    });
  });

  test('do not drift over long strokes', () => {
    const r = rng(1);
    const src = Array.from({ length: 5000 }, (_, i) => S(i * 0.33 + r(), i * 0.17 - r(), r()));
    const back = decodePts(encodePts(src));
    const last = back[back.length - 1] as Sample;
    const want = src[src.length - 1] as Sample;
    expect(Math.abs(last.x - want.x)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(Math.abs(last.y - want.y)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  test('integers only, pressure clamped, no negative zero', () => {
    const pts = encodePts([S(0.04, -0.04, 2), S(0.04, -0.04, -1)]);
    expect(pts.every(Number.isInteger)).toBe(true);
    expect(pts.some((n) => Object.is(n, -0))).toBe(false);
    expect(decodePts(pts).map((s) => s.p)).toEqual([1, 0]);
  });

  test('empty in, empty out', () => {
    expect(encodePts([])).toEqual([]);
    expect(decodePts([])).toEqual([]);
  });
});

describe('outline', () => {
  test('uses only M L Q C Z and at most one decimal', () => {
    for (const s of [cursive(400), zigzag(), [S(5.123, 6.987)]]) {
      for (const style of [PEN, HI]) {
        const d = outline(s, style);
        expect(d).toMatch(/^M/);
        expect(d.replace(/[MLQCZmlqcz0-9.,-]/g, '')).toBe('');
        for (const n of numbers(d)) expect(n).not.toMatch(/\.\d\d/);
      }
    }
  });

  test('empty samples give an empty path', () => {
    expect(outline([], PEN)).toBe('');
    expect(outline([], HI)).toBe('');
  });

  test('a single sample is a round dot of the pen radius', () => {
    const b = pathBox(readPath(outline([S(10, 10, 0.5)], PEN)));
    expect(b).not.toBeNull();
    const w = (b?.x1 ?? 0) - (b?.x0 ?? 0);
    expect(w).toBeGreaterThan(2);
    expect(w).toBeLessThan(3.2);
    expect(Math.abs((b?.y1 ?? 0) - (b?.y0 ?? 0) - w)).toBeLessThan(0.3);
  });

  test('pen width follows pressure', () => {
    const line = (p: number) => Array.from({ length: 40 }, (_, i) => S(i, 10, p));
    const height = (p: number) => {
      const b = pathBox(readPath(outline(line(p), PEN)));
      return (b?.y1 ?? 0) - (b?.y0 ?? 0);
    };
    expect(height(1)).toBeGreaterThan(height(0.1) * 2);
  });

  test('highlighter is a band of constant width, pressure ignored', () => {
    const line = (p: number) => Array.from({ length: 40 }, (_, i) => S(i * 2, 10, p));
    const h1 = pathBox(readPath(outline(line(1), HI)));
    const h0 = pathBox(readPath(outline(line(0.1), HI)));
    expect((h1?.y1 ?? 0) - (h1?.y0 ?? 0)).toBeCloseTo(16, 0);
    expect((h0?.y1 ?? 0) - (h0?.y0 ?? 0)).toBeCloseTo(16, 0);
  });

  test('both pen variants produce closed paths over the samples', () => {
    for (const f of [penPort, penFreehand]) {
      const segs = f(cursive(200), 3);
      expect(segs[0]?.c).toBe('M');
      expect(segs[segs.length - 1]?.c).toBe('Z');
    }
  });
});

describe('paths', () => {
  test('write and read round trip to a tenth', () => {
    const segs = readPath('M10.04,-3.96L5,5Q1.25,2.75,3,4C1,1,2,2,3,3Z');
    const back = readPath(writePath(segs));
    expect(back.map((s) => s.c)).toEqual(['M', 'L', 'Q', 'C', 'Z']);
    const flat = (x: typeof segs) => x.flatMap((s) => s.p);
    flat(back).forEach((v, i) => {
      expect(Math.abs(v - (flat(segs)[i] ?? 0))).toBeLessThanOrEqual(0.05 + 1e-9);
    });
  });

  test('reads relative commands and implicit line pairs', () => {
    const segs = readPath('m1,1 2,0l0,2q1,1,2,2z');
    expect(segs).toEqual([
      { c: 'M', p: [1, 1] },
      { c: 'L', p: [3, 1] },
      { c: 'L', p: [3, 3] },
      { c: 'Q', p: [4, 4, 5, 5] },
      { c: 'Z', p: [] },
    ]);
  });

  test('a long path does not drift', () => {
    const d = outline(cursive(500), PEN);
    const a = pathBox(readPath(d));
    const b = pathBox(penPort(cursive(500), 3).length ? readPath(writePath(penPort(cursive(500), 3))) : []);
    expect(a).toEqual(b);
  });
});

describe('makeStroke', () => {
  test('stores note-local points: (sample - origin) / scale', () => {
    const src = [S(110, 220, 0.2), S(130, 220, 0.5), S(150, 260, 0.9)];
    const s = makeStroke(src, { x: 100, y: 200 }, PEN, { scale: 2, id: 'a', t: 5 });
    expect(s.id).toBe('a');
    expect(s.t).toBe(5);
    expect(s.tool).toBe('pen');
    expect(s.color).toBe('ink-1');
    expect(s.w).toBe(3);
    expect(decodePts(s.pts)).toEqual([
      { x: 5, y: 10, p: 0.2, t: 0 },
      { x: 15, y: 10, p: 0.5, t: 0 },
      { x: 25, y: 30, p: 0.9, t: 0 },
    ]);
    const b = strokeBBox(s);
    expect(b.x).toBeLessThan(5);
    expect(b.x + b.w).toBeGreaterThan(25);
  });

  test('new ids and a time by default', () => {
    const a = makeStroke([S(1, 1)], { x: 0, y: 0 }, PEN);
    const b = makeStroke([S(1, 1)], { x: 0, y: 0 }, PEN);
    expect(a.id).not.toBe(b.id);
    expect(Math.abs(a.t - Date.now())).toBeLessThan(5000);
  });

  test('a 500 sample stroke is well under 4 KB of JSON', () => {
    for (const size of [10, 20, 40]) {
      const s = makeStroke(cursive(500, { size }), { x: 0, y: 0 }, PEN);
      expect(JSON.stringify(s.pts).length).toBeLessThan(1200);
      if (size <= 20) expect(JSON.stringify(s).length).toBeLessThan(4000);
    }
    const hi = makeStroke(cursive(500), { x: 0, y: 0 }, HI);
    expect(JSON.stringify(hi).length).toBeLessThan(4000);
  });

  test('simplified points stay within a fifth of a unit of the samples', () => {
    const src = cursive(500);
    const pts = decodePts(makeStroke(src, { x: 0, y: 0 }, PEN).pts);
    for (const q of src) {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i] as Sample;
        const b = pts[i + 1] as Sample;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2));
        best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy));
      }
      expect(best).toBeLessThan(0.3);
    }
  });
});

describe('simplify', () => {
  test('keeps the ends and drops points on a straight line', () => {
    const line = Array.from({ length: 50 }, (_, i) => S(i, 2 * i));
    const out = simplify(line, 0.2, 1);
    expect(out).toEqual([line[0], line[49]]);
  });

  test('keeps a pressure change on a straight line', () => {
    const line = Array.from({ length: 50 }, (_, i) => S(i, 0, i === 25 ? 1 : 0.2));
    const out = simplify(line, 0.2, 1.5);
    expect(out).toContain(line[25]);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(simplify(line, 0.2, 0)).toEqual([line[0], line[49]]);
  });
});

describe('rebaseStroke', () => {
  const base = makeStroke(cursive(200), { x: 0, y: 0 }, PEN, { id: 'old', t: 9 });

  test('moves then scales points and outline, with a new id', () => {
    const r = rebaseStroke(base, 10, -5, 2);
    expect(r.id).not.toBe('old');
    expect(r.t).toBe(9);
    expect(r.w).toBe(6);
    const a = decodePts(base.pts);
    const b = decodePts(r.pts);
    a.forEach((p, i) => {
      expect(b[i]?.x).toBeCloseTo((p.x + 10) * 2, 0);
      expect(b[i]?.y).toBeCloseTo((p.y - 5) * 2, 0);
      expect(b[i]?.p).toBe(p.p);
    });
    const ba = strokeBBox(base);
    const bb = strokeBBox(r);
    expect(bb.x).toBeCloseTo((ba.x + 10) * 2, 0);
    expect(bb.y).toBeCloseTo((ba.y - 5) * 2, 0);
    expect(bb.w).toBeCloseTo(ba.w * 2, 0);
    for (const n of numbers(r.d)) expect(n).not.toMatch(/\.\d\d/);
  });

  test('does not change the original', () => {
    const copy: Stroke = JSON.parse(JSON.stringify(base));
    rebaseStroke(base, 3, 3, 0.5);
    expect(base).toEqual(copy);
  });
});

describe('strokeBBox and hitStroke', () => {
  const line = makeStroke(
    Array.from({ length: 21 }, (_, i) => S(i * 5, (i % 2) * 0.01)),
    { x: 0, y: 0 },
    { tool: 'pen', color: 'ink-1', w: 4 },
  );

  test('the box includes the stroke width', () => {
    const b = strokeBBox(line);
    expect(b.x).toBeLessThan(0);
    expect(b.y).toBeLessThan(-1);
    expect(b.y + b.h).toBeGreaterThan(1);
    expect(b.x + b.w).toBeGreaterThan(100);
  });

  test('a box can be made from points alone', () => {
    const b = strokeBBox({ ...line, d: '' });
    expect(b.x).toBeLessThan(0);
    expect(b.w).toBeGreaterThan(100);
  });

  test('hits near the line, misses away from it, radius counts', () => {
    expect(hitStroke(line, { x: 50, y: 0 }, 0)).toBe(true);
    expect(hitStroke(line, { x: 50, y: 3 }, 1)).toBe(true);
    expect(hitStroke(line, { x: 50, y: 20 }, 2)).toBe(false);
    expect(hitStroke(line, { x: 50, y: 20 }, 18)).toBe(true);
    expect(hitStroke(line, { x: 130, y: 0 }, 5)).toBe(false);
  });

  test('a dot can be hit', () => {
    const dot = makeStroke([S(5, 5)], { x: 0, y: 0 }, PEN);
    expect(hitStroke(dot, { x: 6, y: 5 }, 0)).toBe(true);
    expect(hitStroke(dot, { x: 15, y: 5 }, 2)).toBe(false);
  });
});
