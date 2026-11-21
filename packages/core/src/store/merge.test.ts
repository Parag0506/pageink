import { describe, expect, it } from 'vitest';
import type { PageRecord } from '../types';
import { canon, laterId, merge, rootOf } from './merge';
import { note, randomRecord, record, rng, stroke } from './testkit';

const N = 400;
const same = (a: unknown, b: unknown) => expect(canon(a)).toBe(canon(b));

describe('merge properties on random records', () => {
  it('is commutative', () => {
    const r = rng(1);
    for (let i = 0; i < N; i++) {
      const a = randomRecord(r);
      const b = randomRecord(r);
      same(merge(a, b), merge(b, a));
    }
  });

  it('is associative', () => {
    const r = rng(2);
    for (let i = 0; i < N; i++) {
      const a = randomRecord(r);
      const b = randomRecord(r);
      const c = randomRecord(r);
      same(merge(merge(a, b), c), merge(a, merge(b, c)));
    }
  });

  it('is idempotent', () => {
    const r = rng(3);
    for (let i = 0; i < N; i++) {
      const m = merge(randomRecord(r), randomRecord(r));
      same(merge(m, m), m);
      const a = randomRecord(r);
      same(merge(merge(a, a), a), merge(a, a));
    }
  });

  it('removes what a deletion covers, for good', () => {
    const r = rng(4);
    for (let i = 0; i < N; i++) {
      const a = randomRecord(r);
      const b = randomRecord(r);
      const m = merge(a, b);
      check(m);
      // Merging with any later copy, even one that still holds the content, keeps it gone.
      check(merge(m, randomRecord(r)));
    }
  });

  it('keeps every stroke written after the deletion that covers it', () => {
    const r = rng(5);
    for (let i = 0; i < N; i++) {
      const a = randomRecord(r);
      const b = randomRecord(r);
      const m = merge(a, b);
      const dead = tombs(m);
      const where = new Map(m.notes.flatMap((n) => n.strokes.map((s) => [s.id, n.id] as const)));
      for (const n of [...a.notes, ...b.notes]) {
        const t = cutOf(m, rootOf(n.id));
        for (const s of n.strokes) {
          if (dead.has(s.id)) continue;
          if (t === undefined) expect(where.get(s.id)).toBe(n.id);
          else if (s.t > t) expect(where.get(s.id)).toBe(laterId(n.id, t));
          else expect(where.has(s.id)).toBe(false);
        }
      }
    }
  });

  it('gives the same id to what is left, whatever the order of merges', () => {
    const r = rng(6);
    for (let i = 0; i < N; i++) {
      const xs = [randomRecord(r), randomRecord(r), randomRecord(r), randomRecord(r)];
      const one = xs.reduce((x, y) => merge(x, y));
      const two = [...xs].reverse().reduce((x, y) => merge(x, y));
      const three = merge(merge(xs[0]!, xs[2]!), merge(xs[3]!, xs[1]!));
      same(one, two);
      same(one, three);
    }
  });
});

const tombs = (m: PageRecord) => new Map(m.deleted.map((d) => [d.id, d.t]));

/** Latest deletion of any note first written under this root. */
function cutOf(m: PageRecord, root: string): number | undefined {
  let t: number | undefined;
  for (const d of m.deleted)
    if (rootOf(d.id) === root && d.id.startsWith('n') && (t === undefined || d.t > t)) t = d.t;
  return t;
}

/** Nothing a deletion covers is in the record, and no stroke id that was deleted is. */
function check(m: PageRecord) {
  const dead = tombs(m);
  for (const n of m.notes) {
    const t = cutOf(m, rootOf(n.id));
    if (t !== undefined) expect(n.id).toBe(laterId(n.id, t));
    else expect(dead.has(n.id)).toBe(false);
    for (const s of n.strokes) {
      expect(dead.has(s.id)).toBe(false);
      if (t !== undefined) expect(s.t).toBeGreaterThan(t);
    }
  }
}

describe('merge rules', () => {
  it('keeps the later tombstone time', () => {
    const m = merge(record({ deleted: [{ id: 'x', t: 9 }] }), record({ deleted: [{ id: 'x', t: 3 }] }));
    expect(m.deleted).toEqual([{ id: 'x', t: 9 }]);
  });

  it('keeps strokes another device wrote after a deletion, as a new note', () => {
    const early = stroke({ id: 's1', t: 100 });
    const late = stroke({ id: 's2', t: 300 });
    // Device B deleted the note at 200. Device C, offline, had added a stroke at 300.
    const b = record({ deleted: [{ id: 'n', t: 200 }] });
    const c = record({ notes: [note({ id: 'n', updatedAt: 300, strokes: [early, late] })] });
    const m = merge(b, c);
    expect(m.notes.map((n) => n.id)).toEqual([laterId('n', 200)]);
    expect(m.notes[0]!.strokes.map((s) => s.id)).toEqual(['s2']);
    expect(laterId('n', 200)).toBe(`n~${(200).toString(36)}`);
    // A later deletion of the new note covers it too.
    const gone = merge(m, record({ deleted: [{ id: laterId('n', 200), t: 400 }] }));
    expect(gone.notes).toEqual([]);
    // Nothing written or changed after the deletion: the note is gone.
    expect(merge(b, record({ notes: [note({ id: 'n', updatedAt: 100, strokes: [early] })] })).notes).toEqual(
      [],
    );
    // A copy changed after the deletion keeps its change, even with no stroke left to show.
    const edited = merge(b, record({ notes: [note({ id: 'n', updatedAt: 250, strokes: [early] })] }));
    expect(edited.notes.map((n) => [n.id, n.strokes.length])).toEqual([[laterId('n', 200), 0]]);
  });

  it('takes note fields from the newer copy and unions strokes ordered by t', () => {
    const s1 = stroke({ id: 's1', t: 5 });
    const s2 = stroke({ id: 's2', t: 2 });
    const a = record({ notes: [note({ id: 'n', updatedAt: 10, device: 'old', strokes: [s1] })] });
    const b = record({ notes: [note({ id: 'n', updatedAt: 20, device: 'new', strokes: [s2] })] });
    const m = merge(a, b);
    expect(m.notes[0]!.device).toBe('new');
    expect(m.notes[0]!.strokes.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('takes title from the newer copy, unions urls and keeps the larger updatedAt', () => {
    const a = record({ title: 'Old', updatedAt: 1, urls: ['u1'] });
    const b = record({ title: 'New', updatedAt: 2, urls: ['u2', 'u1'], snapshot: { ref: 'r', t: 2 } });
    const m = merge(a, b);
    expect(m.title).toBe('New');
    expect(m.snapshot).toEqual({ ref: 'r', t: 2 });
    expect(m.urls).toEqual(['u1', 'u2']);
    expect(m.updatedAt).toBe(2);
  });

  it('does not change its inputs', () => {
    const a = record({ notes: [note({ id: 'n' })] });
    const b = record({ deleted: [{ id: 'n', t: 1 }] });
    const before = canon([a, b]);
    merge(a, b);
    expect(canon([a, b])).toBe(before);
  });
});
