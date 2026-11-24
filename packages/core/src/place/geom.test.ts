import { describe, expect, test } from 'vitest';
import type { Rect, Stroke } from '../types';
import {
  asWritten,
  dock,
  fits,
  inkBox,
  inkOn,
  leader,
  lineAt,
  lineRects,
  MIN_DOCK,
  MIN_SIDE,
  needsDock,
  ON_CONTENT,
  offDoc,
  placeBox,
  union,
} from './geom';

describe('inkBox', () => {
  test('reads the delta-encoded points and pads by the width', () => {
    // Samples (1, 2) and (5, 7), width 2.
    const b = inkBox([
      { id: 'a', t: 0, tool: 'pen', color: 'ink-1', w: 2, pts: [10, 20, 50, 40, 50, 0], d: '' },
    ]);
    expect(b).toEqual({ x: -0.5, y: 0.5, w: 7, h: 8 });
  });

  test('falls back to the path numbers when there are no points', () => {
    const b = inkBox([{ id: 'a', t: 0, tool: 'pen', color: 'ink-1', w: 2, pts: [], d: 'M0 0L40 0L40 10Z' }]);
    expect(b).toEqual({ x: 0, y: 0, w: 40, h: 10 });
    expect(inkBox([])).toBeNull();
  });
});

describe('ink on content', () => {
  const pen = (pts: number[], d = ''): Stroke => ({
    id: 'a',
    t: 0,
    tool: 'pen',
    color: 'ink-1',
    w: 2,
    pts,
    d,
  });
  /** A word with a long tail: an upright of 30, then a tail of 90 to the right along its foot. */
  const hook = [pen([0, 0, 50, 0, 300, 0, 900, 0, 0])];
  const at = { x: 100, y: 200 };

  test('the share is measured along the strokes, at the pose the note has', () => {
    const lines = hook;
    // The box of the hook is 90 by 30. A button in its empty corner touches no ink.
    const button = { x: 150, y: 190, w: 80, h: 30 };
    expect(fits({ x: 100, y: 200, w: 90, h: 30 }, 700, [button])).toBe(false);
    expect(inkOn(lines, at, 1, [button])).toBe(0);
    expect(inkOn(lines, at, 1, [])).toBe(0);
    // A line of words under the last 30 px of the tail: 30 of 122, the pen's width at the start counted.
    const words = { x: 160, y: 222, w: 300, h: 18 };
    expect(inkOn(lines, at, 1, [words])).toBeCloseTo(30 / 122, 5);
    expect(30 / 122).toBeGreaterThan(ON_CONTENT);
    // The whole hook on a picture.
    expect(inkOn(lines, at, 1, [{ x: 0, y: 0, w: 600, h: 600 }])).toBe(1);
    // Two rects over the same ink count it once.
    expect(inkOn(lines, at, 1, [words, { x: 151, y: 220, w: 300, h: 22 }])).toBeCloseTo(39 / 122, 5);
    // At half size the tail ends at x 145 and no longer reaches the words.
    expect(inkOn(lines, at, 0.5, [{ x: 160, y: 207, w: 300, h: 18 }])).toBe(0);
  });

  test('a dot counts, by the width of the pen', () => {
    const dot = [pen([30, 30, 50])];
    expect(inkOn(dot, at, 1, [{ x: 100, y: 200, w: 10, h: 10 }])).toBe(1);
    expect(inkOn(dot, at, 1, [{ x: 120, y: 200, w: 10, h: 10 }])).toBe(0);
  });

  test('strokes with no stored points cannot be measured, so the box decides', () => {
    expect(inkOn([pen([], 'M0 0L40 0L40 10Z')], at, 1, [{ x: 500, y: 500, w: 10, h: 10 }])).toBe(1);
  });

  test('the layout is as written when the anchor block, its text and the window have the sizes stored', () => {
    const frame = { w: 300, h: 80, fontPx: 16, viewportW: 1280 };
    const box = { x: 40, y: 900, w: 300.4, h: 79.8 };
    expect(asWritten(frame, box, 1, 1280)).toBe(true);
    // The block moved, and nothing else: still as written.
    expect(asWritten(frame, { ...box, x: 400, y: 20 }, 1, 1280)).toBe(true);
    expect(asWritten(frame, { ...box, w: 260 }, 1, 1280)).toBe(false);
    expect(asWritten(frame, { ...box, h: 104 }, 1, 1280)).toBe(false);
    expect(asWritten(frame, box, 1.25, 1280)).toBe(false);
    expect(asWritten(frame, box, 1, 1180)).toBe(false);
  });

  test('off the document on either side', () => {
    expect(offDoc({ x: 10, y: 0, w: 100, h: 20 }, 400)).toBe(false);
    expect(offDoc({ x: -5, y: 0, w: 100, h: 20 }, 400)).toBe(true);
    expect(offDoc({ x: 320, y: 0, w: 100, h: 20 }, 400)).toBe(true);
  });
});

describe('lineRects', () => {
  test('drops empty rects, block boxes and wrappers, and joins pieces of a line', () => {
    const out = lineRects([
      { x: 0, y: 0, w: 0, h: 18 },
      { x: 10, y: 100, w: 50, h: 18 },
      { x: 60, y: 100, w: 40, h: 18 },
      { x: 60, y: 100, w: 40, h: 18 },
      { x: 58, y: 98, w: 44, h: 22 },
      { x: 10, y: 120, w: 80, h: 18 },
      { x: 0, y: 90, w: 300, h: 60 },
    ]);
    expect(out).toEqual([
      { x: 10, y: 100, w: 90, h: 18 },
      { x: 10, y: 120, w: 80, h: 18 },
    ]);
  });

  test('a raised piece at the end of a line keeps the words before it', () => {
    // Words, a note marker set higher, and the last word: the marker is the topmost piece.
    const out = lineRects([
      { x: 358, y: 27, w: 27, h: 18 },
      { x: 385, y: 23, w: 15, h: 15 },
      { x: 385, y: 23, w: 15, h: 15 },
      { x: 400, y: 27, w: 27, h: 18 },
    ]);
    expect(out).toEqual([{ x: 358, y: 23, w: 69, h: 22 }]);
    // A short piece a little higher at the line end, as a link in another font can be.
    expect(
      lineRects([
        { x: 10, y: 100.5, w: 200, h: 18 },
        { x: 210, y: 100, w: 2.5, h: 18 },
        { x: 10, y: 124.5, w: 90, h: 18 },
      ]),
    ).toEqual([
      { x: 10, y: 100, w: 202.5, h: 18.5 },
      { x: 10, y: 124.5, w: 90, h: 18 },
    ]);
  });
});

describe('docking', () => {
  const local = { x: 0, y: 0, w: 200, h: 40 };
  const ab = { x: 100, y: 500, w: 300, h: 80 };
  /** Text lines of a block: full lines of the given width, 24 px apart, the last one shorter. */
  const lines = (x: number, y: number, w: number, n: number, last = w): Rect[] =>
    Array.from({ length: n }, (_, i) => ({ x, y: y + i * 24, w: i === n - 1 ? last : w, h: 20 }));
  const meets = (a: Rect, rs: readonly Rect[]) =>
    rs.some((r) => a.x < r.x + r.w && r.x < a.x + a.w && a.y < r.y + r.h && r.y < a.y + a.h);

  test('a note that fits needs no dock; off the document or over content it does', () => {
    expect(needsDock({ x: 410, y: 500, w: 200, h: 40 }, 700, [])).toBe(false);
    expect(needsDock({ x: 410, y: 500, w: 200, h: 40 }, 500, [])).toBe(true);
    expect(needsDock({ x: 410, y: 500, w: 200, h: 40 }, 700, [{ x: 400, y: 480, w: 300, h: 100 }])).toBe(
      true,
    );
    // The precise check looks at text lines, not block boxes.
    expect(fits({ x: 410, y: 500, w: 200, h: 40 }, 700, [{ x: 100, y: 500, w: 300, h: 20 }])).toBe(true);
    expect(fits({ x: 390, y: 500, w: 200, h: 40 }, 700, [{ x: 100, y: 500, w: 300, h: 20 }])).toBe(false);
  });

  test('docks beside the paragraph, scaled to fit, with no leader when it sits by its line', () => {
    const d = dock({
      local,
      origin: { x: 410, y: 510 },
      scale: 1,
      place: 'right',
      anchorBox: ab,
      docW: 580,
      obstacles: [],
      taken: [],
    });
    expect(d.kind).toBe('R');
    expect(d.box.x).toBeGreaterThanOrEqual(ab.x + ab.w);
    expect(d.box.x + d.box.w).toBeLessThanOrEqual(580);
    expect(d.scale).toBeLessThan(1);
    expect(d.scale).toBeGreaterThanOrEqual(MIN_SIDE);
    expect(d.leader).toBeUndefined();
    expect(placeBox(local, d.origin, d.scale)).toEqual(d.box);
  });

  test('tries the other side when the preferred one is taken by content', () => {
    const d = dock({
      local,
      origin: { x: 410, y: 510 },
      scale: 1,
      place: 'right',
      anchorBox: { x: 300, y: 500, w: 300, h: 80 },
      docW: 900,
      obstacles: [{ x: 600, y: 0, w: 300, h: 2000 }],
      taken: [],
    });
    expect(d.kind).toBe('L');
    expect(d.box.x + d.box.w).toBeLessThanOrEqual(300);
  });

  test('with no room at the side it goes to the gap below, readable, and stacks beside earlier ones', () => {
    const own = lines(10, 0, 380, 2);
    const next = lines(10, 120, 380, 3);
    const inp = {
      local,
      origin: { x: 0, y: 0 },
      scale: 1,
      place: 'right' as const,
      anchorBox: { x: 10, y: 0, w: 380, h: 44 },
      own,
      line: own[0],
      docW: 400,
      obstacles: next,
      taken: [] as Rect[],
    };
    const a = dock(inp);
    expect(a.kind).toBe('B');
    // Full size fits in the gap, so nothing shrinks.
    expect(a.scale).toBe(1);
    expect(a.box.y).toBeGreaterThanOrEqual(44);
    expect(a.box.y + a.box.h).toBeLessThanOrEqual(120);
    expect(a.box.x + a.box.w).toBeLessThanOrEqual(400);
    const b = dock({ ...inp, taken: [a.box] });
    expect(meets(b.box, [a.box])).toBe(false);
    expect(meets(b.box, [...own, ...next])).toBe(false);
  });

  test('a side that would shrink the ink past the readable floor loses to a gap', () => {
    // A phone: 360 px of document, a paragraph with 50 px on each side.
    const d = dock({
      local,
      origin: { x: 320, y: 510 },
      scale: 1,
      place: 'right',
      anchorBox: { x: 50, y: 500, w: 260, h: 80 },
      docW: 360,
      obstacles: [],
      taken: [],
    });
    expect(['A', 'B']).toContain(d.kind);
    expect(d.scale).toBeGreaterThanOrEqual(MIN_SIDE);
    expect(d.box.x).toBeGreaterThanOrEqual(0);
    expect(d.box.x + d.box.w).toBeLessThanOrEqual(360);
  });

  test('looks past tight gaps to the nearest one with room, and never onto text', () => {
    // Paragraphs of three lines with 12 px between them, and one 70 px gap two paragraphs down.
    const ps = [0, 84, 168, 322].map((y) => lines(16, y, 358, 3));
    const own = ps[1]!;
    const d = dock({
      local,
      origin: { x: 380, y: 84 },
      scale: 1,
      place: 'right',
      anchorBox: { x: 16, y: 84, w: 358, h: 68 },
      own,
      line: own[0],
      docW: 390,
      obstacles: ps.flat(),
      taken: [],
    });
    expect(d.kind).toBe('G');
    expect(d.box.y).toBeGreaterThanOrEqual(236);
    expect(meets(d.box, ps.flat())).toBe(false);
    expect(d.scale).toBeGreaterThanOrEqual(MIN_DOCK);
    // The leader runs beside the text, not across it, to the end of the anchor line.
    expect(d.leader!.at(-1)).toEqual({ x: 374, y: 94 });
    expect(d.leader!.every((p) => p.x >= 374)).toBe(true);
  });

  test('with no free space it folds into a marker beside its line, never on text, and never shrinks past the floor', () => {
    const ps = Array.from({ length: 8 }, (_, i) => lines(16, i * 76, 358, 3, 200));
    const own = ps[2]!;
    const inp = {
      local,
      origin: { x: 380, y: 152 },
      scale: 1,
      place: 'right' as const,
      anchorBox: { x: 16, y: 152, w: 358, h: 68 },
      own,
      line: own[0],
      docW: 390,
      obstacles: ps.flat(),
      taken: [] as Rect[],
      reach: 200,
    };
    const d = dock(inp);
    expect(d.kind).toBe('M');
    expect(d.scale).toBe(1);
    expect(meets(d.box, ps.flat())).toBe(false);
    expect(d.box.x + d.box.w).toBeLessThanOrEqual(390);
    // A second note on the same line gets its own marker.
    const e = dock({ ...inp, taken: [d.box] });
    expect(e.kind).toBe('M');
    expect(meets(e.box, [d.box])).toBe(false);
    // A note wider than the screen does not shrink past the floor: it folds too.
    const wide = dock({ ...inp, local: { x: 0, y: 0, w: 2000, h: 40 }, obstacles: [], reach: 2000 });
    expect(wide.kind).toBe('M');
  });

  test('a note keeps its place on small changes, and an earlier place must win by a margin', () => {
    // The right side leaves room for 0.72 of the ink: under the side limit, over the held one.
    const base = {
      local,
      origin: { x: 410, y: 510 },
      scale: 1,
      place: 'right' as const,
      anchorBox: ab,
      docW: ab.x + ab.w + 8 + 144 + 4,
      // A block right above: no gap there, so the choice is between the side and below.
      obstacles: [{ x: 0, y: 0, w: 556, h: 498 }],
      taken: [],
    };
    expect(dock(base).kind).toBe('B');
    expect(dock({ ...base, prev: 'R' }).kind).toBe('R');
    // At 0.8 the side is open, but a note already below stays below until it clears 0.83.
    const wider = { ...base, docW: ab.x + ab.w + 8 + 160 + 4 };
    expect(dock(wider).kind).toBe('R');
    expect(dock({ ...wider, prev: 'B' }).kind).toBe('B');
  });

  test('the leader is hidden next to the line and ends on its nearest edge', () => {
    const line = { x: 16, y: 100, w: 300, h: 20 };
    expect(leader({ x: 322, y: 100, w: 40, h: 20 }, line, [], 390)).toBeUndefined();
    const l = leader({ x: 100, y: 40, w: 60, h: 20 }, line, [], 390)!;
    expect(l).toEqual([{ x: 130, y: 100 }]);
  });

  test('lineAt picks the line level with the anchor, joining pieces of one line', () => {
    const own = [
      { x: 0, y: 0, w: 100, h: 20 },
      { x: 0, y: 24, w: 60, h: 20 },
      { x: 60, y: 25, w: 40, h: 18 },
      { x: 0, y: 48, w: 30, h: 20 },
    ];
    expect(lineAt(own, 30, 'right')).toEqual({ x: 0, y: 24, w: 100, h: 20 });
    expect(lineAt(own, 0, 'above')).toEqual(own[0]);
    expect(lineAt(own, 68, 'below')).toEqual(own[3]);
    expect(lineAt([], 0, 'right')).toBeUndefined();
  });

  test('union of rects', () => {
    expect(union([])).toBeNull();
    expect(
      union([
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 5, y: 5, w: 1, h: 1 },
      ]),
    ).toEqual({ x: 0, y: 0, w: 6, h: 6 });
  });
});
