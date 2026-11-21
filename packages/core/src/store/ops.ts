/**
 * Changes to whole pages, built on the store's own read, merge and write.
 */
import { newId } from '../hash';
import type { Note, PageIdentity, PageRecord, Store } from '../types';
import { identityOf } from './identity';
import { applyPatch, emptyRecord, erasePatch, showsInk } from './patch';

/**
 * Remove all ink on a page for good. Every note and stroke gets a tombstone and the record
 * stays, so a sync with the folder or another device cannot bring the ink back.
 * With `only`, just the notes it accepts (Clear page in a frame clears that frame).
 * Returns the saved record, or null when the page has no record.
 */
export async function erasePage(
  store: Store,
  key: string,
  only?: (n: Note) => boolean,
  now = Date.now(),
): Promise<PageRecord | null> {
  const rec = await store.get(key);
  if (!rec) return null;
  const patch = erasePatch(rec, only);
  if (!patch.del?.length) return rec;
  return store.save(applyPatch(rec, patch, now), identityOf(rec));
}

/**
 * Move every note of one page to another page, for a page whose address changed.
 * The notes are copied under new ids with their anchors as they are, so the anchoring
 * ladder finds them on the new page. The old page is then erased for good.
 * Returns the target record, or null when there was nothing to move.
 */
export async function moveNotes(
  store: Store,
  fromKey: string,
  to: PageIdentity,
  now = Date.now(),
): Promise<PageRecord | null> {
  const from = await store.get(fromKey);
  const moving = from?.notes.filter(showsInk) ?? [];
  if (!from || moving.length === 0 || to.key === from.key) return null;
  const copies: Note[] = moving.map((n) => ({
    ...n,
    id: newId(),
    updatedAt: now,
    strokes: n.strokes.map((s) => ({ ...s, id: newId() })),
  }));
  const target = (await store.load(to)) ?? emptyRecord(to, from.title);
  const saved = await store.save(applyPatch(target, { add: copies }, now), to);
  await erasePage(store, from.key, undefined, now);
  return saved;
}
