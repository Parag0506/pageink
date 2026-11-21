import type { ApplyPatch, EmptyRecord, Note, PageRecord, Patch, Stroke } from '../types';
import { identityUrls } from './identity';

/**
 * True when a note draws something. The merge rule can leave an ink note with no strokes:
 * it shows nothing, so it is not placed, counted, listed or exported.
 */
export const showsInk = (n: Note): boolean => n.kind === 'textmark' || n.strokes.length > 0;

/**
 * Patch that removes ink for good: every note and every stroke gets a tombstone, so no
 * copy on another device or in the folder can bring it back. With `only`, just those notes.
 * The page toolbar's Clear page and the library's Delete both use it.
 */
export function erasePatch(rec: PageRecord, only?: (n: Note) => boolean): Patch {
  const notes = only ? rec.notes.filter(only) : rec.notes;
  return { del: [...notes.map((n) => n.id), ...notes.flatMap((n) => n.strokes.map((s) => s.id))] };
}

/** updatedAt 0 so an unsaved empty record never wins a title over stored data. */
export const emptyRecord: EmptyRecord = (id, title) => ({
  v: 1,
  key: id.key,
  urls: [...new Set(identityUrls(id))].sort(),
  title,
  updatedAt: 0,
  notes: [],
  deleted: [],
});

const byT = (a: Stroke, b: Stroke) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const applyPatch: ApplyPatch = (rec, patch, now = Date.now()) => {
  const dead = new Map(rec.deleted.map((d) => [d.id, d.t]));
  const notes = new Map<string, Note>(rec.notes.map((n) => [n.id, n]));
  const touched = new Set<string>();
  // Notes we write get a time at least as new as their old one, so merge keeps the edit.
  const stamp = (n: Note) => Math.max(now, n.updatedAt + 1);

  const addStrokes = (n: Note, strokes: Stroke[]): Note => {
    const have = new Set(n.strokes.map((s) => s.id));
    const fresh = strokes.filter((s) => !have.has(s.id) && !dead.has(s.id));
    return { ...n, strokes: [...n.strokes, ...fresh].sort(byT) };
  };

  for (const n of patch.add ?? []) {
    if (dead.has(n.id)) continue;
    const had = notes.get(n.id);
    const base = had
      ? addStrokes({ ...n, strokes: had.strokes }, n.strokes)
      : addStrokes({ ...n, strokes: [] }, n.strokes);
    notes.set(n.id, { ...base, updatedAt: Math.max(now, n.updatedAt) });
    touched.add(n.id);
  }

  for (const { note, strokes } of patch.addStrokes ?? []) {
    const n = notes.get(note);
    if (!n) continue;
    const next = addStrokes(n, strokes);
    notes.set(note, { ...next, updatedAt: stamp(n) });
    touched.add(note);
  }

  for (const u of patch.update ?? []) {
    const n = notes.get(u.id);
    if (!n) continue;
    notes.set(u.id, { ...u, strokes: n.strokes, updatedAt: stamp(n) });
    touched.add(u.id);
  }

  if (patch.del?.length) {
    const owner = new Map<string, string>();
    for (const n of notes.values()) for (const s of n.strokes) owner.set(s.id, n.id);
    // A note's tombstone is never older than a stroke it removes. A device whose clock runs
    // ahead could otherwise write strokes that outlive the deletion of their own note.
    const latest = (n: Note | undefined) => n?.strokes.reduce((m, s) => Math.max(m, s.t), now) ?? now;
    for (const id of patch.del) {
      if (!dead.has(id)) dead.set(id, latest(notes.get(id)));
      if (notes.delete(id)) {
        touched.add(id);
        continue;
      }
      const nid = owner.get(id);
      const n = nid === undefined ? undefined : notes.get(nid);
      if (!n || nid === undefined) continue;
      const strokes = n.strokes.filter((s) => s.id !== id);
      touched.add(nid);
      if (strokes.length === 0 && n.kind !== 'textmark') {
        notes.delete(nid);
        if (!dead.has(nid)) dead.set(nid, latest(n));
      } else {
        notes.set(nid, { ...n, strokes, updatedAt: stamp(n) });
      }
    }
  }

  const changed = touched.size > 0 || dead.size !== rec.deleted.length;
  const out: PageRecord = {
    ...rec,
    notes: [...notes.values()],
    deleted: [...dead].map(([id, t]) => ({ id, t })),
    updatedAt: changed ? Math.max(now, rec.updatedAt) : rec.updatedAt,
  };
  return out;
};
