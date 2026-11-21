import { describe, expect, it } from 'vitest';
import type { GroupCandidate, LassoItem, Point } from '../types';
import { lassoSelect, pickNote, pointInPolygon, rectGap } from './group';

const box = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h });
const cand = (id: string, over: Partial<GroupCandidate> = {}): GroupCandidate => ({
  id,
  bbox: box(0, 0, 100, 20),
  lastEnd: 1000,
  tool: 'pen',
  ...over,
});

describe('pickNote', () => {
  it('joins a stroke that starts soon after and close by', () => {
    expect(pickNote({ t0: 2000, bbox: box(120, 0), tool: 'pen' }, [cand('a')])).toBe('a');
  });

  it('starts a new note after the time gap', () => {
    expect(pickNote({ t0: 2600, bbox: box(110, 0), tool: 'pen' }, [cand('a')])).toBeNull();
    expect(pickNote({ t0: 2600, bbox: box(110, 0), tool: 'pen' }, [cand('a')], { gapMs: 2000 })).toBe('a');
  });

  it('starts a new note beyond the distance gap', () => {
    expect(pickNote({ t0: 1100, bbox: box(141, 0), tool: 'pen' }, [cand('a')])).toBeNull();
    expect(pickNote({ t0: 1100, bbox: box(141, 0), tool: 'pen' }, [cand('a')], { gapPx: 50 })).toBe('a');
  });

  it('keeps highlighter and pen apart', () => {
    expect(pickNote({ t0: 1100, bbox: box(10, 0), tool: 'hi' }, [cand('a')])).toBeNull();
    expect(pickNote({ t0: 1100, bbox: box(10, 0), tool: 'hi' }, [cand('a'), cand('h', { tool: 'hi' })])).toBe(
      'h',
    );
  });

  it('picks the closest when several qualify', () => {
    const cs = [cand('far', { bbox: box(0, 0, 100, 20) }), cand('near', { bbox: box(0, 60, 100, 20) })];
    expect(pickNote({ t0: 1100, bbox: box(10, 50, 10, 5), tool: 'pen' }, cs)).toBe('near');
  });

  it('measures the gap between boxes', () => {
    expect(rectGap(box(0, 0), box(5, 5))).toBe(0);
    expect(rectGap(box(0, 0), box(13, 14))).toBe(5);
  });
});

describe('lassoSelect', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('tests points in a polygon', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
  });

  it('uses stroke points when given and the box centre otherwise', () => {
    const items: LassoItem[] = [
      // Box centre is outside, but most points are inside.
      {
        note: 'a',
        stroke: 'a1',
        bbox: box(50, 50, 200, 200),
        pts: [
          { x: 60, y: 60 },
          { x: 70, y: 70 },
          { x: 200, y: 200 },
        ],
      },
      // Box centre is inside, but most points are outside.
      {
        note: 'a',
        stroke: 'a2',
        bbox: box(40, 40, 20, 20),
        pts: [
          { x: 150, y: 50 },
          { x: 160, y: 50 },
          { x: 50, y: 50 },
        ],
      },
      { note: 'b', stroke: 'b1', bbox: box(10, 10) },
      { note: 'b', stroke: 'b2', bbox: box(20, 20) },
      { note: 'c', stroke: 'c1', bbox: box(500, 500) },
    ];
    expect(lassoSelect(square, items)).toEqual({
      strokes: ['a1', 'b1', 'b2'],
      wholeNotes: ['b'],
      partialNotes: ['a'],
    });
  });

  it('selects nothing with a degenerate lasso', () => {
    expect(lassoSelect([{ x: 0, y: 0 }], [{ note: 'a', stroke: 's', bbox: box(0, 0) }]).strokes).toEqual([]);
  });
});
