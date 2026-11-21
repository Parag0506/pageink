import { rebaseStroke } from '../strokes';
import type { JoinNotes, MoveNote, SplitNote } from '../types';
import { noteOps } from './ops';

export { lassoSelect, pickNote, pointInPolygon, rectGap } from './group';
export { createHistory } from './history';
export { noteOps } from './ops';

const ops = noteOps(rebaseStroke);
export const moveNote: MoveNote = ops.moveNote;
export const splitNote: SplitNote = ops.splitNote;
export const joinNotes: JoinNotes = ops.joinNotes;
