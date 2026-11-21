import { describe, expect, it } from 'vitest';
import { applyPatch } from '../store';
import { anchor, note, record, stroke } from '../store/testkit';
import type { Described, RebaseStroke, Stroke } from '../types';
import { joinNotes, moveNote as realMove } from './index';
import { noteOps } from './ops';

// A stand-in rebase that records its arguments, so geometry is checked without strokes/.
let n = 0;
const fake: RebaseStroke = (s, dx, dy, scale) => ({ ...s, id: `r${++n}`, d: `${s.d}|${dx},${dy},${scale}` });
const ops = noteOps(fake);

const to: Described = {
  anchor: anchor({ quote: { exact: 'new place', prefix: '', suffix: '' } }),
  frame: { w: 1, h: 2, fontPx: 20, viewportW: 800 },
  origin: { x: 0, y: 0 },
};

const ids = (ss: Stroke[]) => ss.map((s) => s.id);

describe('moveNote', () => {
  it('writes a copy under new ids at the new anchor and deletes the old note', () => {
    const src = note({ id: 'n1', strokes: [stroke({ id: 'a', d: 'A' }), stroke({ id: 'b', d: 'B' })] });
    const p = ops.moveNote(src, to, { dx: 3, dy: 4, scale: 2 });
    expect(p.del).toEqual(['n1']);
    const copy = p.add![0]!;
    expect(copy.id).not.toBe('n1');
    expect(copy.anchor).toBe(to.anchor);
    expect(copy.frame).toBe(to.frame);
    expect(copy.strokes.map((s) => s.d)).toEqual(['A|3,4,2', 'B|3,4,2']);
    expect(ids(copy.strokes)).not.toContain('a');
    const after = applyPatch(record({ notes: [src] }), p, 5000);
    expect(after.notes.map((x) => x.id)).toEqual([copy.id]);
  });

  it('uses the real rebase from strokes', () => {
    const src = note({ id: 'n1', strokes: [stroke({ id: 'a', pts: [10, 20, 50], d: 'M1 2L3 4Z' })] });
    const p = realMove(src, to, { dx: 1, dy: 1, scale: 2 });
    const s = p.add![0]!.strokes[0]!;
    expect(s.id).not.toBe('a');
    expect(s.d).not.toBe('M1 2L3 4Z');
  });
});

describe('splitNote', () => {
  it('moves the chosen strokes into a new note', () => {
    const src = note({ id: 'n1', strokes: [stroke({ id: 'a', d: 'A' }), stroke({ id: 'b', d: 'B' })] });
    const p = ops.splitNote(src, ['b'], to, { dx: 1, dy: 0, scale: 1 });
    expect(p.del).toEqual(['b']);
    expect(p.add![0]!.strokes.map((s) => s.d)).toEqual(['B|1,0,1']);
    const after = applyPatch(record({ notes: [src] }), p, 5000);
    expect(after.notes.map((x) => ids(x.strokes))).toEqual([['a'], [p.add![0]!.strokes[0]!.id]]);
  });

  it('deletes the old note when every stroke leaves', () => {
    const src = note({ id: 'n1', strokes: [stroke({ id: 'a' })] });
    expect(ops.splitNote(src, ['a'], to, { dx: 0, dy: 0, scale: 1 }).del).toEqual(['a', 'n1']);
    expect(ops.splitNote(src, ['zzz'], to, { dx: 0, dy: 0, scale: 1 })).toEqual({});
  });
});

describe('joinNotes', () => {
  it('rebases the other notes into the target and deletes them', () => {
    const target = note({ id: 't', strokes: [stroke({ id: 'a', d: 'A' })] });
    const o1 = note({ id: 'o1', strokes: [stroke({ id: 'b', d: 'B' })] });
    const o2 = note({ id: 'o2', strokes: [stroke({ id: 'c', d: 'C' })] });
    const p = ops.joinNotes(target, [
      { note: o1, dx: 5, dy: 0, scale: 1 },
      { note: o2, dx: 0, dy: 7, scale: 0.5 },
    ]);
    expect(p.del).toEqual(['o1', 'o2']);
    expect(p.addStrokes![0]!.note).toBe('t');
    expect(p.addStrokes![0]!.strokes.map((s) => s.d)).toEqual(['B|5,0,1', 'C|0,7,0.5']);
    const after = applyPatch(record({ notes: [target, o1, o2] }), p, 5000);
    expect(after.notes.map((x) => x.id)).toEqual(['t']);
    expect(after.notes[0]!.strokes).toHaveLength(3);
  });

  it('ignores the target in the list of others', () => {
    const target = note({ id: 't' });
    expect(joinNotes(target, [{ note: target, dx: 0, dy: 0, scale: 1 }])).toEqual({});
  });
});
