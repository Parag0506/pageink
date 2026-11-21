import { describe, expect, test } from 'vitest';
import { pathsBox } from './thumb';

describe('pathsBox', () => {
  test('absolute lines and curves', () => {
    expect(pathsBox(['M10 20L30 5Q40 50 12 12Z'])).toEqual({ x: 10, y: 5, w: 30, h: 45 });
  });

  test('relative commands, H, V and implicit lines after a moveto', () => {
    expect(pathsBox(['m5 5 10 0v10h-20z'])).toEqual({ x: -5, y: 5, w: 20, h: 10 });
  });

  test('compact numbers and arcs', () => {
    expect(pathsBox(['M1.5.5L-2-3A2 2 0 0 1 4 4'])).toEqual({ x: -2, y: -3, w: 6, h: 7 });
  });

  test('several paths and empty input', () => {
    expect(pathsBox(['M0 0L1 1', 'M10 10L11 12'])).toEqual({ x: 0, y: 0, w: 11, h: 12 });
    expect(pathsBox([])).toBeNull();
    expect(pathsBox([''])).toBeNull();
  });
});
