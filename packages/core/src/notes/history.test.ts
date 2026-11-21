import { describe, expect, it } from 'vitest';
import { applyPatch } from '../store';
import { anchor, note, type Rng, record, rng, stroke } from '../store/testkit';
import type { Note, PageRecord, Patch, RebaseStroke } from '../types';
import { createHistory } from './history';
import { noteOps } from './ops';

let seq = 0;
const fresh = (p: string) => `${p}${++seq}`;
const keepShape: RebaseStroke = (s) => ({ ...s, id: fresh('rb') });
const ops = noteOps(keepShape);

/** What a reader sees: notes by quote, place and colour, with their stroke shapes. Ids are left out. */
function sig(rec: PageRecord): string[] {
  return rec.notes
    .map(
      (n) =>
        `${n.anchor.quote.exact}|${n.anchor.place}|${n.mark?.color ?? ''}|${n.strokes
          .map((s) => s.d)
          .sort()
          .join(',')}`,
    )
    .sort();
}

function newNote(r: Rng): Note {
  const tag = fresh('q');
  if (r.chance(0.2)) {
    return note({
      id: fresh('n'),
      kind: 'textmark',
      mark: { style: 'highlight', color: 'hi-1' },
      anchor: anchor({ quote: { exact: tag, prefix: '', suffix: '' } }),
    });
  }
  const strokes = Array.from({ length: 1 + r.int(3) }, () => stroke({ id: fresh('s'), d: fresh('d') }));
  return note({ id: fresh('n'), anchor: anchor({ quote: { exact: tag, prefix: '', suffix: '' } }), strokes });
}

/** A random edit of the kind the tools make. */
function randomPatch(r: Rng, rec: PageRecord): Patch {
  const ink = rec.notes.filter((n) => n.kind === 'ink');
  const any = rec.notes;
  const k = r.int(7);
  if (k === 0 || any.length === 0) return { add: [newNote(r)] };
  if (k === 1 && ink.length) {
    const n = r.pick(ink);
    return { addStrokes: [{ note: n.id, strokes: [stroke({ id: fresh('s'), d: fresh('d') })] }] };
  }
  if (k === 2) {
    const n = r.pick(any);
    const place = r.pick(['on', 'left', 'right', 'above', 'below'] as const);
    const color = r.pick(['hi-1', 'hi-2']);
    return {
      update: [{ ...n, anchor: { ...n.anchor, place }, mark: n.mark ? { ...n.mark, color } : undefined }],
    };
  }
  if (k === 3) return { del: [r.pick(any).id] };
  if (k === 4 && ink.length) {
    const strokes = ink.flatMap((n) => n.strokes);
    const del = [r.pick(strokes).id];
    if (r.chance(0.5)) del.push(r.pick(strokes).id);
    return { del };
  }
  if (k === 5 && ink.length) {
    const n = r.pick(ink);
    const to = { anchor: { ...n.anchor, place: 'right' as const }, frame: n.frame, origin: { x: 0, y: 0 } };
    if (r.chance(0.5) && n.strokes.length > 1)
      return ops.splitNote(n, [n.strokes[0]!.id], to, { dx: 1, dy: 1, scale: 1 });
    return ops.moveNote(n, to, { dx: 1, dy: 1, scale: 1 });
  }
  if (k === 6 && ink.length > 1) {
    const [a, b] = [r.pick(ink), r.pick(ink)];
    if (a.id !== b.id) return ops.joinNotes(a, [{ note: b, dx: 0, dy: 0, scale: 1 }]);
  }
  return { add: [newNote(r)] };
}

/** Ids a patch writes must never be ids the record has already deleted. */
function assertFreshIds(rec: PageRecord, p: Patch) {
  const dead = new Set(rec.deleted.map((d) => d.id));
  for (const n of p.add ?? []) {
    expect(dead.has(n.id)).toBe(false);
    for (const s of n.strokes) expect(dead.has(s.id)).toBe(false);
  }
  for (const g of p.addStrokes ?? []) for (const s of g.strokes) expect(dead.has(s.id)).toBe(false);
}

describe('createHistory', () => {
  it('undoes an add by deleting it and redoes it under new ids', () => {
    const h = createHistory();
    const r0 = record();
    const n = note({ id: 'n1', strokes: [stroke({ id: 's1' })] });
    const r1 = applyPatch(r0, { add: [n] }, 10);
    h.record({ add: [n] }, r0);
    expect(h.canUndo()).toBe(true);
    const u = h.undo(r1)!;
    expect(u).toEqual({ del: ['n1'] });
    const r2 = applyPatch(r1, u, 20);
    expect(r2.notes).toEqual([]);
    expect(h.canRedo()).toBe(true);
    const re = h.redo(r2)!;
    expect(re.add![0]!.id).not.toBe('n1');
    expect(re.add![0]!.strokes[0]!.id).not.toBe('s1');
    const r3 = applyPatch(r2, re, 30);
    expect(sig(r3)).toEqual(sig(r1));
    expect(h.undo(r3)).toEqual({ del: [re.add![0]!.id] });
  });

  it('undoes an update by restoring the old fields', () => {
    const h = createHistory();
    const n = note({ id: 'n1' });
    const r0 = record({ notes: [n] });
    const p = { update: [{ ...n, anchor: anchor({ place: 'left' }) }] };
    const r1 = applyPatch(r0, p, 5000);
    h.record(p, r0);
    const r2 = applyPatch(r1, h.undo(r1)!, 6000);
    expect(r2.notes[0]!.anchor.place).toBe('on');
    expect(r2.notes[0]!.id).toBe('n1');
  });

  it('follows new ids through several undo and redo steps', () => {
    const h = createHistory();
    let rec = record();
    const apply = (p: Patch, t: number) => {
      const before = rec;
      rec = applyPatch(rec, p, t);
      return before;
    };
    const n = note({ id: 'n1', strokes: [stroke({ id: 's1', d: 'one' })] });
    h.record({ add: [n] }, apply({ add: [n] }, 10));
    const more = { addStrokes: [{ note: 'n1', strokes: [stroke({ id: 's2', d: 'two' })] }] };
    h.record(more, apply(more, 20));
    h.record({ del: ['n1'] }, apply({ del: ['n1'] }, 30));
    expect(rec.notes).toEqual([]);
    // Back to the start, then forward to the end, twice.
    for (let round = 0; round < 2; round++) {
      apply(h.undo(rec)!, 40);
      expect(sig(rec)).toEqual(['quoted words|on||one,two']);
      apply(h.undo(rec)!, 50);
      expect(sig(rec)).toEqual(['quoted words|on||one']);
      apply(h.undo(rec)!, 60);
      expect(rec.notes).toEqual([]);
      expect(h.canUndo()).toBe(false);
      apply(h.redo(rec)!, 70);
      apply(h.redo(rec)!, 80);
      expect(sig(rec)).toEqual(['quoted words|on||one,two']);
      apply(h.redo(rec)!, 90);
      expect(rec.notes).toEqual([]);
      expect(h.canRedo()).toBe(false);
    }
  });

  it('matches a model over long random chains', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const h = createHistory({ limit: 10000 });
      let rec = record();
      let now = 1000;
      const states = [sig(rec)];
      let at = 0;
      for (let step = 0; step < 400; step++) {
        now += 10;
        const roll = r.next();
        if (roll < 0.5) {
          const p = randomPatch(r, rec);
          assertFreshIds(rec, p);
          const before = rec;
          rec = applyPatch(rec, p, now);
          h.record(p, before);
          states.length = at + 1;
          states.push(sig(rec));
          at++;
        } else if (roll < 0.8) {
          const p = h.undo(rec);
          if (at === 0) {
            expect(p).toBeNull();
            continue;
          }
          assertFreshIds(rec, p!);
          rec = applyPatch(rec, p!, now);
          at--;
        } else {
          const p = h.redo(rec);
          if (at === states.length - 1) {
            expect(p).toBeNull();
            continue;
          }
          assertFreshIds(rec, p!);
          rec = applyPatch(rec, p!, now);
          at++;
        }
        expect(sig(rec)).toEqual(states[at]);
        expect(h.canUndo()).toBe(at > 0);
        expect(h.canRedo()).toBe(at < states.length - 1);
      }
    }
  });

  it('keeps at most limit steps and clears', () => {
    const h = createHistory({ limit: 3 });
    let rec = record();
    for (let i = 0; i < 5; i++) {
      const p = { add: [note({ id: `n${i}` })] };
      const before = rec;
      rec = applyPatch(rec, p, 10 + i);
      h.record(p, before);
    }
    let undone = 0;
    for (let p = h.undo(rec); p; p = h.undo(rec)) {
      rec = applyPatch(rec, p, 100 + undone);
      undone++;
    }
    expect(undone).toBe(3);
    expect(rec.notes.map((n) => n.id)).toEqual(['n0', 'n1']);
    h.clear();
    expect(h.canRedo()).toBe(false);
    expect(h.redo(rec)).toBeNull();
  });
});
