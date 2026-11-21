/**
 * Backup, archive and Markdown. Loaded on first use, so a page that only shows ink
 * does not carry the zip code.
 */
import {
  createStore,
  emptyRecord,
  exportArchive,
  importArchive,
  merge,
  syncFolder,
  toMarkdown,
} from 'pageink-core/store';
import type { FolderIO, KV, Note, PageIdentity, SyncReport } from 'pageink-core/types';

export async function markdownOf(kv: KV, id: PageIdentity): Promise<string> {
  const rec = await createStore(kv).load(id);
  return toMarkdown(rec ? [rec] : []);
}

export const archiveOf = (kv: KV): Promise<Uint8Array> => exportArchive(createStore(kv));

export const importInto = (kv: KV, zip: Uint8Array): Promise<SyncReport> =>
  importArchive(createStore(kv), zip);

export const syncWith = (kv: KV, io: FolderIO): Promise<SyncReport> => syncFolder(createStore(kv), io);

/** Add notes to the page record. Merge drops notes whose ids were deleted before. */
export async function addNotesTo(kv: KV, id: PageIdentity, title: string, notes: Note[]): Promise<void> {
  const store = createStore(kv);
  const base = emptyRecord(id, title);
  const extra = { ...base, notes, updatedAt: Math.max(base.updatedAt, ...notes.map((n) => n.updatedAt)) };
  const had = await store.load(id);
  await store.save(had && had.key === id.key ? merge(had, extra) : extra, id);
}
