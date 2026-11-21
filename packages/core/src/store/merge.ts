import type { Merge, Note, PageRecord, Stroke, Tombstone } from '../types';
import { cleanRecord } from './validate';

export { recordProblem } from './validate';

/** True when the value is a record with nothing that had to be left out. */
export const isRecord = (v: unknown): v is PageRecord => {
  const c = cleanRecord(v);
  return !!c.rec && c.dropped.length === 0;
};

/**
 * JSON with object keys sorted. Two records with the same content give the same text,
 * whatever order their fields were written in.
 */
export function canon(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** True when the two records hold the same content. */
export function sameRecord(a: PageRecord, b: PageRecord): boolean {
  return canon(merge(a, a)) === canon(merge(b, b));
}

/**
 * Pick one of two values the same way whatever the argument order.
 * The newer time wins. Equal times fall back to the larger canonical text,
 * which keeps merge commutative and associative.
 */
function pick<T>(a: T, ta: number, b: T, tb: number): T {
  if (ta !== tb) return ta > tb ? a : b;
  return canon(a) >= canon(b) ? a : b;
}

const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

function noteFields(n: Note): Omit<Note, 'strokes' | 'id'> {
  const { strokes: _s, id: _id, ...rest } = n;
  return rest;
}

/** Joins a note id and a time in the id of a note that outlived a deletion. */
export const LATER = '~';

/** The id a note was first written under, before any deletion renamed what was left of it. */
export const rootOf = (id: string): string => {
  const i = id.indexOf(LATER);
  return i < 0 ? id : id.slice(0, i);
};

/** Id of the note that holds strokes written after a deletion at time t. */
export const laterId = (id: string, t: number): string => `${rootOf(id)}${LATER}${t.toString(36)}`;

/**
 * FORMAT.md "Merge". Notes are grouped by the id they were first written under. When any
 * note of a group was deleted, the latest such time T decides: strokes written at or before
 * T are gone, and strokes written after T, on any device, form one note with id laterId(root, T).
 * T only grows as copies meet, so a stroke that is gone stays gone, and every device that has
 * seen the same tombstones puts the same strokes under the same id.
 */
export const merge: Merge = (a, b) => {
  const tomb = new Map<string, number>();
  for (const d of [...a.deleted, ...b.deleted]) {
    const t = tomb.get(d.id);
    if (t === undefined || d.t > t) tomb.set(d.id, d.t);
  }
  const deleted: Tombstone[] = [...tomb].map(([id, t]) => ({ id, t })).sort(byId);

  const groups = new Map<string, Note[]>();
  for (const n of [...a.notes, ...b.notes]) {
    const r = rootOf(n.id);
    const list = groups.get(r);
    if (list) list.push(n);
    else groups.set(r, [n]);
  }
  // Latest deletion per group. Stroke ids never share a root with a note, so they never count.
  const cut = new Map<string, number>();
  for (const [id, t] of tomb) {
    const r = rootOf(id);
    if (!groups.has(r)) continue;
    const had = cut.get(r);
    if (had === undefined || t > had) cut.set(r, t);
  }

  const out: Note[] = [];
  /**
   * One note from copies. Fields come from the newest copy that was written after `after`.
   * A copy's time is never older than its own strokes. Strokes are the union, minus tombstones
   * and minus strokes written at or before `after`.
   */
  const fold = (id: string, list: Note[], after = -Infinity): void => {
    let fields: Omit<Note, 'strokes' | 'id'> | undefined;
    const strokes = new Map<string, Stroke>();
    for (const n of list) {
      const t = n.strokes.reduce((m, s) => Math.max(m, s.t), n.updatedAt);
      if (t <= after) continue;
      const f = { ...noteFields(n), updatedAt: t };
      fields = fields ? pick(fields, fields.updatedAt, f, t) : f;
      for (const s of n.strokes) {
        if (tomb.has(s.id) || s.t <= after) continue;
        const had = strokes.get(s.id);
        // Strokes never change, so a clash only happens with bad data. Choose stably.
        strokes.set(s.id, had ? pick(had, 0, s, 0) : s);
      }
    }
    // Every copy is older than the deletion: the note is simply gone.
    if (!fields) return;
    const sorted = [...strokes.values()].sort((x, y) => x.t - y.t || byId(x, y));
    out.push({ ...fields, id, strokes: sorted });
  };

  for (const [root, list] of groups) {
    const t = cut.get(root);
    if (t !== undefined) {
      fold(laterId(root, t), list, t);
      continue;
    }
    const byNote = new Map<string, Note[]>();
    for (const n of list) byNote.set(n.id, [...(byNote.get(n.id) ?? []), n]);
    for (const [id, copies] of byNote) fold(id, copies);
  }
  out.sort((x, y) => x.createdAt - y.createdAt || byId(x, y));

  const head = pick(
    { title: a.title, snapshot: a.snapshot },
    a.updatedAt,
    { title: b.title, snapshot: b.snapshot },
    b.updatedAt,
  );
  const rec: PageRecord = {
    v: 1,
    key: a.key,
    urls: [...new Set([...a.urls, ...b.urls])].sort(),
    title: head.title,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    notes: out,
    deleted,
  };
  if (head.snapshot) rec.snapshot = head.snapshot;
  return rec;
};
