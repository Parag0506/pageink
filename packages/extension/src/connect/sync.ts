/**
 * Sync with a cloud: the same syncFolder, run again when a write was refused because another
 * device wrote first. The second pass reads that device's file, merges through the normal
 * rule and writes again. No network code here.
 */
import { syncFolder } from 'pageink-core/store';
import type { FolderIO, Store, SyncOptions, SyncReport } from 'pageink-core/types';

export interface Conflicting {
  takeConflicts?(): number;
}

/** How many passes a sync makes at most when writes keep meeting another device's. */
export const PASSES = 3;

export async function syncWithRetry(
  store: Store,
  io: FolderIO & Conflicting,
  opts?: SyncOptions,
  sync = syncFolder,
): Promise<SyncReport> {
  let rep = await sync(store, io, opts);
  io.takeConflicts?.();
  for (let i = 1; i < PASSES; i++) {
    const conflict = rep.errors.some((e) => /\bconflict\b/.test(e));
    if (!conflict) break;
    const next = await sync(store, io, opts);
    io.takeConflicts?.();
    rep = {
      pulled: rep.pulled + next.pulled,
      pushed: rep.pushed + next.pushed,
      merged: rep.merged + next.merged,
      conflictsFolded: rep.conflictsFolded + next.conflictsFolded,
      errors: next.errors,
      locked: next.locked,
    };
  }
  return rep;
}
