import { newId } from '../hash';
import type { CreateHistory, Note, PageRecord, Patch, Stroke } from '../types';

interface Entry {
  patch: Patch;
  /** Notes the patch changed or removed, as they were just before it. Keyed by id at that time. */
  before: Map<string, Note>;
}

/** Notes needed to invert `patch` later, taken from the record it was applied to. */
function extract(rec: PageRecord, patch: Patch): Map<string, Note> {
  const byId = new Map(rec.notes.map((n) => [n.id, n]));
  const owner = new Map<string, Note>();
  for (const n of rec.notes) for (const s of n.strokes) owner.set(s.id, n);
  const out = new Map<string, Note>();
  for (const u of patch.update ?? []) {
    const n = byId.get(u.id);
    if (n) out.set(n.id, n);
  }
  for (const id of patch.del ?? []) {
    const n = byId.get(id) ?? owner.get(id);
    if (n) out.set(n.id, n);
  }
  return out;
}

/**
 * Undo and redo are the same operation: invert the entry against the current record.
 * Ids are never reused, so content that comes back gets new ids, and an alias table
 * sends every older id to its newest copy. Entries deeper in either stack keep their
 * original ids and are resolved through the table when they are inverted.
 */
export const createHistory: CreateHistory = (opts) => {
  const limit = Math.max(1, opts?.limit ?? 100);
  let undos: Entry[] = [];
  let redos: Entry[] = [];
  const alias = new Map<string, string>();

  const resolve = (id: string) => {
    let cur = id;
    for (let next = alias.get(cur); next !== undefined; next = alias.get(cur)) cur = next;
    return cur;
  };

  const copyStroke = (s: Stroke): Stroke => {
    const id = newId();
    alias.set(s.id, id);
    return { ...s, id };
  };
  const copyNote = (n: Note, strokes: Stroke[]): Note => {
    const id = newId();
    alias.set(n.id, id);
    return { ...n, id, strokes: strokes.map(copyStroke) };
  };

  function invert(e: Entry, now: PageRecord): Patch {
    const live = new Map(now.notes.map((n) => [n.id, n]));
    const add: Note[] = [];
    const addStrokes: { note: string; strokes: Stroke[] }[] = [];
    const update: Note[] = [];
    const del: string[] = [];

    for (const n of e.patch.add ?? []) del.push(resolve(n.id));
    for (const g of e.patch.addStrokes ?? []) for (const s of g.strokes) del.push(resolve(s.id));

    for (const u of e.patch.update ?? []) {
      const old = e.before.get(u.id);
      const id = resolve(u.id);
      const cur = live.get(id);
      if (old && cur) update.push({ ...old, id, strokes: cur.strokes });
    }

    const gone = new Set(e.patch.del ?? []);
    const groups = new Map<string, { note: Note; strokes: Stroke[] }>();
    for (const id of gone) {
      const whole = e.before.get(id);
      if (whole && whole.id === id) {
        add.push(copyNote(whole, whole.strokes));
        continue;
      }
      for (const n of e.before.values()) {
        const s = n.strokes.find((x) => x.id === id);
        if (!s || gone.has(n.id)) continue;
        const g = groups.get(n.id) ?? { note: n, strokes: [] };
        g.strokes.push(s);
        groups.set(n.id, g);
        break;
      }
    }
    for (const g of groups.values()) {
      const target = resolve(g.note.id);
      if (live.has(target)) addStrokes.push({ note: target, strokes: g.strokes.map(copyStroke) });
      else add.push(copyNote(g.note, g.strokes));
    }

    const out: Patch = {};
    if (add.length) out.add = add;
    if (addStrokes.length) out.addStrokes = addStrokes;
    if (update.length) out.update = update;
    if (del.length) out.del = del;
    return out;
  }

  const step = (from: Entry[], to: Entry[], now: PageRecord): Patch | null => {
    const e = from.pop();
    if (!e) return null;
    const inv = invert(e, now);
    to.push({ patch: inv, before: extract(now, inv) });
    if (to.length > limit) to.shift();
    return inv;
  };

  return {
    record(patch, before) {
      undos.push({ patch, before: extract(before, patch) });
      if (undos.length > limit) undos.shift();
      redos = [];
    },
    undo: (now) => step(undos, redos, now),
    redo: (now) => step(redos, undos, now),
    canUndo: () => undos.length > 0,
    canRedo: () => redos.length > 0,
    clear() {
      undos = [];
      redos = [];
      alias.clear();
    },
  };
};
