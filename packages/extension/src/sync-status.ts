/**
 * Folder sync status lives in its own storage key, apart from cfg. Writing it
 * never rewrites the settings, so it cannot undo a change the reader just made.
 */
import { isProblem, type Problem } from './connect/dest';

export const SYNC_KEY = 'sync';

export interface SyncStatus {
  /** Epoch ms of the last sync that finished, full or for one page. */
  lastSync?: number;
  /** Epoch ms of the last full two-way sync. */
  lastFull?: number;
  /** Why the last attempt failed, when it did. */
  error?: string;
  /** The last attempt's problem in plain terms, when there is one (connect/dest.ts). */
  problem?: Problem;
  /** Files the last full sync found locked with a password this device does not hold. */
  locked?: number;
  /** Files the last full sync left alone because, while the lock is on, they are not ours. */
  refused?: number;
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

export async function readStatus(area: Area): Promise<SyncStatus> {
  const v = (await area.get(SYNC_KEY))[SYNC_KEY] as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object') return {};
  const out: SyncStatus = { lastSync: time(v.lastSync), lastFull: time(v.lastFull) };
  if (typeof v.error === 'string') out.error = v.error.slice(0, 500);
  if (isProblem(v.problem)) out.problem = v.problem;
  if (Number.isInteger(v.locked) && (v.locked as number) > 0) out.locked = v.locked as number;
  if (Number.isInteger(v.refused) && (v.refused as number) > 0) out.refused = v.refused as number;
  for (const k of Object.keys(out) as (keyof SyncStatus)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Merge into the stored status. Only sync code writes this key. */
export async function writeStatus(area: Area, patch: SyncStatus): Promise<void> {
  const next: SyncStatus = { ...(await readStatus(area)), ...patch };
  if (!patch.error) delete next.error;
  if (!patch.problem) delete next.problem;
  for (const k of Object.keys(next) as (keyof SyncStatus)[]) if (next[k] === undefined) delete next[k];
  await area.set({ [SYNC_KEY]: next });
}
