// The viewer checks a page's record before the page's first paint with ink, so the check of a
// record that is good builds no field names: a name is built only to say which field failed.
import { describe, expect, test } from 'vitest';
import { built, cleanRecord } from './validate';

const POINTS = 120;

function record(bad: boolean) {
  const stroke = (i: number, last: boolean) => {
    const pts: number[] = [];
    for (let k = 0; k < POINTS; k++) pts.push(k * 10, (k * 7) % 300, 50);
    // In a bad record, the very last number of each note is not a number, so the whole note is read.
    if (bad && last) (pts as unknown[])[pts.length - 1] = 'x';
    return { id: `s${i}`, t: 1, tool: 'pen', color: 'ink-1', w: 2, pts, d: 'M0 0 L10 10 '.repeat(40) };
  };
  const note = (i: number) => ({
    id: `n${i}`,
    createdAt: 1,
    updatedAt: 1,
    device: 'd',
    kind: 'ink',
    anchor: {
      type: 'text',
      quote: { exact: 'abc', prefix: 'x', suffix: 'y' },
      path: { css: 'p', xpath: '/p' },
      pos: { start: 0, end: 3 },
      hash: 'h',
      place: 'on',
    },
    frame: { w: 100, h: 20, fontPx: 16, viewportW: 1280 },
    strokes: [stroke(3 * i, false), stroke(3 * i + 1, false), stroke(3 * i + 2, true)],
  });
  return {
    v: 1,
    key: 'k',
    urls: ['k'],
    title: 't',
    updatedAt: 1,
    notes: Array.from({ length: 20 }, (_, i) => note(i)),
    deleted: [],
  };
}

describe('the record check', () => {
  test('a bad note is named down to the failing number', () => {
    const c = cleanRecord(record(true));
    expect(c.rec?.notes).toEqual([]);
    expect(c.dropped[0]).toBe(`bad note 0.strokes.2.pts.${POINTS * 3 - 1}`);
    expect(cleanRecord(record(false)).rec?.notes).toHaveLength(20);
  });

  test('a good record is checked without field names: only a bad one builds them, for its message', () => {
    // Counted, not timed: the count is the same on every machine. The record's own few fields
    // are checked by name, so the notes must add nothing to what a record with no notes builds.
    const names = (rec: unknown): number => {
      const before = built.names;
      cleanRecord(rec);
      return built.names - before;
    };
    const good = record(false);
    const empty = { ...record(false), notes: [] };
    expect(names(good)).toBe(names(empty));
    // A bad note is checked once without names, then once with them, to word the failure. So
    // every bad note adds names, and here all twenty are bad.
    expect(names(record(true))).toBeGreaterThan(names(good) + 20);
  });
});
