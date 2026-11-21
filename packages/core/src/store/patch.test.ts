import { describe, expect, it } from 'vitest';
import { indexTargets } from './identity';
import { applyPatch, emptyRecord } from './patch';
import { anchor, identity, note, record, stroke } from './testkit';

describe('emptyRecord', () => {
  it('starts with the identity addresses and hosts', () => {
    const id = identity({ aliases: ['https://example.com/canon'], hosts: ['example.com', 'm.example.com'] });
    const r = emptyRecord(id, 'T');
    expect(r).toMatchObject({ v: 1, key: id.key, title: 'T', notes: [], deleted: [], updatedAt: 0 });
    expect(r.urls).toContain(id.url);
    expect(r.urls).toContain('https://example.com/canon');
    const t = indexTargets(r);
    expect(t.hosts).toEqual(['example.com', 'm.example.com']);
    expect(t.addrs).toContain(id.key);
    expect(t.addrs).toContain('https://example.com/canon');
  });
});

describe('applyPatch', () => {
  it('adds notes and strokes and bumps updatedAt', () => {
    const r0 = record({ updatedAt: 5 });
    const n = note({ id: 'n1', updatedAt: 1 });
    const r1 = applyPatch(r0, { add: [n] }, 100);
    expect(r1.notes.map((x) => x.id)).toEqual(['n1']);
    expect(r1.notes[0]!.updatedAt).toBe(100);
    expect(r1.updatedAt).toBe(100);
    expect(r0.notes).toEqual([]);
    const s = stroke({ id: 's9', t: 2000 });
    const r2 = applyPatch(r1, { addStrokes: [{ note: 'n1', strokes: [s] }] }, 200);
    expect(r2.notes[0]!.strokes.map((x) => x.id)).toContain('s9');
    expect(r2.notes[0]!.updatedAt).toBe(200);
    expect(r2.updatedAt).toBe(200);
  });

  it('updates fields but never strokes', () => {
    const n = note({ id: 'n1', strokes: [stroke({ id: 'a' })] });
    const r1 = record({ notes: [n] });
    const r2 = applyPatch(r1, { update: [{ ...n, anchor: anchor({ place: 'left' }), strokes: [] }] }, 50000);
    expect(r2.notes[0]!.anchor.place).toBe('left');
    expect(r2.notes[0]!.strokes.map((s) => s.id)).toEqual(['a']);
    expect(r2.notes[0]!.updatedAt).toBe(50000);
  });

  it('deletes notes and strokes into tombstones', () => {
    const r1 = record({
      notes: [
        note({ id: 'n1', strokes: [stroke({ id: 'a' }), stroke({ id: 'b' })] }),
        note({ id: 'n2', strokes: [stroke({ id: 'c' })] }),
      ],
    });
    const r2 = applyPatch(r1, { del: ['a', 'n2'] }, 70);
    expect(r2.notes.map((n) => n.id)).toEqual(['n1']);
    expect(r2.notes[0]!.strokes.map((s) => s.id)).toEqual(['b']);
    // A note's tombstone is never older than its strokes (t 1000 here), whatever the clock says.
    expect(r2.deleted).toEqual([
      { id: 'a', t: 70 },
      { id: 'n2', t: 1000 },
    ]);
  });

  it('removes an ink note whose last stroke goes, but keeps a textmark', () => {
    const r1 = record({
      notes: [note({ id: 'n1', strokes: [stroke({ id: 'a' })] }), note({ id: 't1', kind: 'textmark' })],
    });
    const r2 = applyPatch(r1, { del: ['a'] }, 70);
    expect(r2.notes.map((n) => n.id)).toEqual(['t1']);
    expect(r2.deleted.map((d) => d.id).sort()).toEqual(['a', 'n1']);
  });

  it('never re-adds a deleted id', () => {
    const r1 = record({
      deleted: [
        { id: 'n1', t: 1 },
        { id: 's1', t: 1 },
      ],
    });
    const r2 = applyPatch(
      r1,
      { add: [note({ id: 'n1' }), note({ id: 'n2', strokes: [stroke({ id: 's1' })] })] },
      9,
    );
    expect(r2.notes.map((n) => n.id)).toEqual(['n2']);
    expect(r2.notes[0]!.strokes).toEqual([]);
  });

  it('leaves the record alone for an empty patch', () => {
    const r1 = record({ updatedAt: 3 });
    expect(applyPatch(r1, {}, 99).updatedAt).toBe(3);
  });
});
