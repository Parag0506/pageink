import { newId } from '../hash';
import type { JoinNotes, MoveNote, Note, RebaseStroke, SplitNote } from '../types';

/**
 * Move, split and join over a given rebase function. The folder index wires in the real
 * one from strokes/. Tests pass a fake.
 */
export function noteOps(rebase: RebaseStroke): {
  moveNote: MoveNote;
  splitNote: SplitNote;
  joinNotes: JoinNotes;
} {
  const moveNote: MoveNote = (note, to, shift) => {
    const copy: Note = {
      ...note,
      id: newId(),
      anchor: to.anchor,
      frame: to.frame,
      strokes: note.strokes.map((s) => rebase(s, shift.dx, shift.dy, shift.scale)),
    };
    return { add: [copy], del: [note.id] };
  };

  const splitNote: SplitNote = (note, strokeIds, to, shift) => {
    const take = new Set(strokeIds);
    const moved = note.strokes.filter((s) => take.has(s.id));
    if (moved.length === 0) return {};
    const copy: Note = {
      ...note,
      id: newId(),
      anchor: to.anchor,
      frame: to.frame,
      strokes: moved.map((s) => rebase(s, shift.dx, shift.dy, shift.scale)),
    };
    const del = moved.map((s) => s.id);
    if (moved.length === note.strokes.length) del.push(note.id);
    return { add: [copy], del };
  };

  const joinNotes: JoinNotes = (target, others) => {
    const rest = others.filter((o) => o.note.id !== target.id);
    const strokes = rest.flatMap((o) => o.note.strokes.map((s) => rebase(s, o.dx, o.dy, o.scale)));
    if (rest.length === 0) return {};
    return {
      addStrokes: strokes.length ? [{ note: target.id, strokes }] : [],
      del: rest.map((o) => o.note.id),
    };
  };

  return { moveNote, splitNote, joinNotes };
}
