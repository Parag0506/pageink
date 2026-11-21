/**
 * Folder sync in the background (DESIGN 5, promise 3). A page change pushes
 * that page after a short pause. A full two-way sync runs at browser start, on
 * install, when the popup or the options page opens, after a reconnect, and when
 * a page with ink loads and the last full sync is a few minutes old. Otherwise
 * that page alone is pulled from its own file. No alarms and no polling. Pushes
 * are spaced out, so a burst of strokes makes at most one write every few
 * seconds, and a push that fails waits for the next trigger.
 */
import { hashKey } from 'pageink-core/hash';
import type { FolderIO, PageRecord, Store, SyncFolder, SyncReport } from 'pageink-core/types';
import type { Problem } from '../connect/dest';
import type { SyncReply } from '../messages';
import type { SyncStatus } from '../sync-status';

/**
 * Why the place could not be opened. none: nothing chosen. permission: the folder needs a
 * click. locked: the place has a password lock this device does not hold. Or a problem
 * reaching a cloud (connect/dest.ts).
 */
export type Access = 'none' | 'permission' | 'locked' | Problem;
export type OpenFolder = () => Promise<FolderIO | Access>;

/** A full sync older than this runs again when a page with ink loads. */
export const FRESH_MS = 5 * 60 * 1000;

export interface SyncerDeps {
  store: Store;
  open: OpenFolder;
  sync: SyncFolder;
  /** Records when sync last ran. Kept out of cfg so it never races a settings change. */
  status?: (s: SyncStatus) => Promise<void>;
  /** When the last full sync finished. Read from storage, since the background may restart. */
  lastFull?: () => Promise<number | undefined>;
  /** Told whether the folder could be opened, each time it is tried. */
  onAccess?: (a: 'ok' | Access) => void;
  debounceMs?: number;
  /** Least time between two pushes. */
  minGapMs?: number;
  /** A page written without a pause is still pushed after this long. */
  maxWaitMs?: number;
  freshMs?: number;
  now?: () => number;
}

export interface Syncer {
  /** Feed storage.local changes. Only `p:` keys matter. */
  changed(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>): void;
  /** Push pending pages now. */
  flush(): Promise<void>;
  full(): Promise<SyncReply>;
  /** Two-way sync of one page, reading only its own files. */
  pull(key: string): Promise<SyncReply>;
  /** A page with ink loaded: a full sync when the last one is old, else a pull of that page. */
  fresh(key?: string): Promise<SyncReply>;
  /** Run fn when no sync is running, and hold sync back until it ends. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/** Overflow files a page can use, as in the store (FORMAT "Storage keys"). */
const SLOTS = 8;

/** The names a page's files can have in this folder: its own name and the overflow names. */
export async function slotNames(io: FolderIO, key: string): Promise<string[]> {
  const h = io.hash ? await io.hash(key) : hashKey(key);
  return Array.from({ length: SLOTS }, (_, i) => `pages/${h}${i ? `.${i}` : ''}.ink.json`);
}

/**
 * The folder narrowed to one page's own files. Reading stops at the first missing name,
 * so a pull costs one or two reads, never a listing of the whole folder.
 */
export function narrow(io: FolderIO, key: string): FolderIO {
  const seen = new Map<string, string>();
  return {
    ...io,
    async list() {
      for (const name of await slotNames(io, key)) {
        try {
          seen.set(name, await io.read(name));
        } catch {
          break;
        }
      }
      return [...seen.keys()].map((name) => ({ name, mtime: 0, size: seen.get(name)!.length }));
    },
    read: async (name) => seen.get(name) ?? io.read(name),
  };
}

export function createSyncer(d: SyncerDeps): Syncer {
  const wait = d.debounceMs ?? 1500;
  const gap = d.minGapMs ?? 0;
  const maxWait = d.maxWaitMs ?? 30_000;
  const freshMs = d.freshMs ?? FRESH_MS;
  const now = d.now ?? Date.now;
  const pending = new Set<string>();
  const removed = new Map<string, string>();
  // updatedAt of each record as last written to the folder. Stops the loop
  // where a sync writes storage and the change would push the page again.
  const pushed = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPush = Number.NEGATIVE_INFINITY;
  let firstPending: number | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let lastFull: number | undefined;
  const status = (s: SyncStatus) => d.status?.(s).catch(() => {});

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const open = async () => {
    const io = await d.open();
    d.onAccess?.(typeof io === 'string' ? io : 'ok');
    return io;
  };

  const remember = async (keys: string[]) => {
    for (const k of keys) {
      const r = await d.store.get(k);
      if (r) pushed.set(k, r.updatedAt);
    }
  };

  const flush = () =>
    serial(async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const keys = [...pending];
      const gone = [...removed];
      pending.clear();
      removed.clear();
      firstPending = undefined;
      if (!keys.length && !gone.length) return;
      // Kept for the next trigger when the place cannot take them now (offline, a lapsed
      // sign-in). There is no timer to retry; the next change or full sync carries them.
      const later = () => {
        for (const k of keys) pending.add(k);
        for (const [slot, key] of gone) removed.set(slot, key);
      };
      const io = await open();
      if (io === 'none') return;
      if (typeof io === 'string') return later();
      lastPush = now();
      // A removed record takes its file along only when the file still holds that page.
      for (const [, key] of gone) {
        for (const name of await slotNames(io, key)) {
          let text: string;
          try {
            text = await io.read(name);
          } catch {
            break;
          }
          let held: unknown;
          try {
            held = (JSON.parse(text) as { key?: unknown }).key;
          } catch {
            continue;
          }
          if (held === key) {
            await io.remove?.(name).catch(() => {});
            break;
          }
        }
      }
      if (keys.length) {
        let rep: SyncReport;
        try {
          rep = await d.sync(d.store, io, { only: keys });
        } catch {
          return later();
        }
        await remember(keys);
        if (rep.errors.length) {
          for (const k of keys) pushed.delete(k);
          return later();
        }
        await status({ lastSync: now() });
      }
    }).catch(() => {});
  const schedule = () => {
    if (timer) clearTimeout(timer);
    const t = now();
    firstPending ??= t;
    // Wait for a pause in writing, but not past maxWait, and never sooner than the gap.
    const pause = Math.min(wait, Math.max(0, firstPending + maxWait - t));
    timer = setTimeout(() => void flush(), Math.max(pause, lastPush + gap - t));
  };

  const run = (only?: string[]) =>
    serial(async (): Promise<SyncReply> => {
      const io = await open();
      if (typeof io === 'string') return { error: io };
      let report: SyncReport;
      try {
        report = only ? await d.sync(d.store, narrow(io, only[0]!), { only }) : await d.sync(d.store, io);
      } catch (e) {
        await status({ error: String(e) });
        return { error: String(e) };
      }
      await remember(only ?? (await d.store.list()).map((s) => s.key));
      const t = now();
      if (!only) lastFull = t;
      await status(only ? { lastSync: t } : { lastSync: t, lastFull: t });
      return { report };
    });

  return {
    changed(changes) {
      let any = false;
      for (const [k, c] of Object.entries(changes)) {
        if (!k.startsWith('p:')) continue;
        const rec = c.newValue as PageRecord | undefined;
        if (!rec) {
          const old = c.oldValue as PageRecord | undefined;
          if (old && typeof old.key === 'string') {
            removed.set(k.slice(2), old.key);
            any = true;
          }
          continue;
        }
        if (typeof rec.key !== 'string' || rec.updatedAt <= (pushed.get(rec.key) ?? -1)) continue;
        pending.add(rec.key);
        any = true;
      }
      if (any) schedule();
    },
    flush,
    exclusive: (fn) => serial(fn),
    full: () => run(),
    pull: (key) => run([key]),
    async fresh(key) {
      lastFull ??= await d.lastFull?.().catch(() => undefined);
      if (lastFull === undefined || now() - lastFull > freshMs || !key) return run();
      return run([key]);
    },
  };
}
