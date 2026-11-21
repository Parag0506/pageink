import { describe, expect, test } from 'vitest';
import { shapeCut } from './shape';

const box = { x: 100, y: 200, w: 400, h: 200 };

describe('shapeCut', () => {
  test('none clips nothing', () => {
    expect(shapeCut('none', box)).toBeNull();
    expect(shapeCut('', box)).toBeNull();
  });

  test('inset in pixels and percentages, with one to four values and rounded corners', () => {
    expect(shapeCut('inset(10px 20px 30px 40px)', box)).toEqual({ x: 140, y: 210, w: 340, h: 160 });
    expect(shapeCut('inset(10px)', box)).toEqual({ x: 110, y: 210, w: 380, h: 180 });
    expect(shapeCut('inset(10% 0px)', box)).toEqual({ x: 100, y: 220, w: 400, h: 160 });
    expect(shapeCut('inset(0px 50% 0px 0px round 8px)', box)).toEqual({ x: 100, y: 200, w: 200, h: 200 });
    expect(shapeCut('inset(0px 0px 100% 0px)', box)).toEqual({ x: 100, y: 200, w: 400, h: 0 });
  });

  test('rect and xywh', () => {
    expect(shapeCut('rect(10px auto 50px 20px)', box)).toEqual({ x: 120, y: 210, w: 380, h: 40 });
    expect(shapeCut('xywh(10px 20px 50% 25%)', box)).toEqual({ x: 110, y: 220, w: 200, h: 50 });
  });

  test('circle and ellipse through the box around them', () => {
    expect(shapeCut('circle(50px at 50% 50%)', box)).toEqual({ x: 250, y: 250, w: 100, h: 100 });
    // The default radius is the closest side.
    expect(shapeCut('circle(at 50% 50%)', box)).toEqual({ x: 200, y: 200, w: 200, h: 200 });
    expect(shapeCut('ellipse(100px 50px at 0px 0px)', box)).toEqual({ x: 0, y: 150, w: 200, h: 100 });
    expect(shapeCut('ellipse(at center)', box)).toEqual({ x: 100, y: 200, w: 400, h: 200 });
  });

  test('reference boxes', () => {
    const edges = { t: 5, r: 5, b: 5, l: 5 };
    expect(shapeCut('inset(0px) content-box', box, edges, edges)).toEqual({ x: 110, y: 210, w: 380, h: 180 });
    expect(shapeCut('padding-box', box, edges, edges)).toEqual({ x: 105, y: 205, w: 390, h: 190 });
  });

  test('other shapes are left to the caller', () => {
    expect(shapeCut('polygon(0% 0%, 100% 0%, 50% 100%)', box)).toBe('other');
    expect(shapeCut('path("M0 0L10 10")', box)).toBe('other');
    expect(shapeCut('url("#c")', box)).toBe('other');
    expect(shapeCut('inset(calc(10px + 1em))', box)).toBe('other');
  });
});
