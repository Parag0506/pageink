/**
 * The one place this device keeps its copy of the notes, in the background: a folder, the
 * Safari app, or a cloud. It opens the place for the syncer, through the password lock and,
 * for a cloud, a cache that skips unchanged files. It answers the connect screen's
 * messages: connect, disconnect, copy my notes, and the lock.
 *
 * The cloud code (src/cloud) is loaded through loadCloud() only when a cloud is connected or
 * being connected. This file holds no network code.
 */
import type { FolderIO, Store, SyncFolder, SyncReport } from 'pageink-core/types';
import { nativeConnect, nativeDisconnect, nativePlace, type SendNative } from '../adapters/folder-native';
import type { Cloud } from '../cloud';
import { cachedFolder, type Seen } from '../connect/cache';
import { type Dest, isProblem, type Problem, type ProviderId, readDest, writeDest } from '../connect/dest';
import { clean } from '../connect/explain';
import { syncWithRetry } from '../connect/sync';
import { fromB64, fromRecoveryCode, recoveryCode, toB64 } from '../lock/crypto';
import {
  fits,
  type HeldKey,
  judge,
  keyFromPassword,
  type LockedFolder,
  type LockFile,
  lockedFolder,
  newLock,
  readLock,
  settle,
  unlockWith,
  verifyLock,
  writeLock,
} from '../lock/lock';
import type { PlaceReply, PlaceState, ToPlace } from '../messages';
import { readStatus, writeStatus } from '../sync-status';
import type { FolderKind } from './folder';
import type { Secrets } from './secrets';
import type { Access, OpenFolder, Syncer } from './syncer';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

/** The key this device holds for the place's lock, in the secret store. Never synced, never in the notes. */
export const LOCK_KEY = 'lockKey';
const SEEN_KEY = (p: ProviderId) => `seen:${p}`;
/**
 * How long a read of the lock file is trusted for pushes. A full sync always reads it again,
 * and so does every step that rewrites files for the lock.
 */
const LOCK_TTL = 10_000;

export interface PlaceDeps {
  area: Area;
  /** Tokens and the lock key: storage only the background can reach (secrets.ts). */
  secrets: Secrets;
  store: Store;
  kind: FolderKind;
  /** The folder on this device or in the app, as before clouds. */
  openFolder: OpenFolder;
  /** Loads src/cloud and makes the cloud. Only called for a cloud. */
  loadCloud: () => Promise<Cloud>;
  send?: SendNative;
  syncer: () => Syncer;
  now?: () => number;
}

export interface Place {
  open: OpenFolder;
  sync: SyncFolder;
  handle(m: ToPlace): Promise<PlaceReply>;
  state(): Promise<PlaceState>;
}

/** The first problem named in a report's errors, if any. */
export function problemOf(rep: SyncReport): Problem | undefined {
  for (const e of rep.errors) {
    const m = /\b(offline|expired|full|denied|throttled|server|not-set-up)\b/.exec(e);
    if (m && isProblem(m[1])) return m[1];
  }
  return undefined;
}

const codeOf = (e: unknown): Problem | 'wrong' | string => {
  const c = (e as { code?: unknown })?.code;
  if (isProblem(c)) return c;
  return e instanceof Error ? e.message : String(e);
};

export function createPlace(d: PlaceDeps): Place {
  const now = d.now ?? Date.now;
  let cloud: Promise<Cloud> | null = null;
  const getCloud = () => {
    cloud ??= d.loadCloud().catch((e) => {
      // A failed load is tried again next time.
      cloud = null;
      throw e;
    });
    return cloud;
  };
  let lockSeen: { at: number; lock: LockFile | null | 'bad' } | null = null;

  const held = async (): Promise<HeldKey | null> => {
    const v = (await d.secrets.get(LOCK_KEY)) as HeldKey | undefined;
    return v && typeof v.key === 'string' && typeof v.check === 'string' ? v : null;
  };
  const keep = (h: HeldKey | null) => (h ? d.secrets.set(LOCK_KEY, h) : d.secrets.remove(LOCK_KEY));

  /** The place with nothing on top: the folder, the app, or the cloud. */
  async function raw(dest: Dest | null): Promise<FolderIO | Access> {
    if (dest?.kind === 'cloud' && d.kind !== 'native') {
      if (!(await d.secrets.get(`tok:${dest.provider}`))) return 'expired';
      return (await getCloud()).open(dest.provider);
    }
    return d.openFolder();
  }

  async function lockOf(io: FolderIO): Promise<LockFile | null | 'bad'> {
    if (lockSeen && now() - lockSeen.at < LOCK_TTL) return lockSeen.lock;
    const lock = await readLock(io);
    lockSeen = { at: now(), lock };
    return lock;
  }

  /**
   * The place through the lock, ready for sync, or why it cannot be synced. A turn on or off
   * this device may finish, and a move from version 1, are done first, before any page is read.
   */
  async function throughLock(io: FolderIO): Promise<LockedFolder | Access> {
    const h = await held();
    const j = await judge(await lockOf(io), h);
    if (j.kind === 'plain') return lockedFolder(io, null, null);
    if (j.kind === 'needs-password') {
      await writeStatus(d.area, { problem: 'locked', error: 'locked' }).catch(() => {});
      return 'locked';
    }
    if (j.kind === 'trouble') {
      // Never a step toward plain by itself: stop, keep the notes here, and ask the reader.
      await writeStatus(d.area, { problem: 'lock-changed', error: 'lock-changed' }).catch(() => {});
      return 'lock-changed';
    }
    let lock = j.lock;
    if (j.work) {
      lockSeen = null;
      const p = await settle(io, lock, j.key);
      lockSeen = null;
      if (lock.state === 'turning-off') {
        // Only the device that started turning off gets here (judge).
        if (p.skipped.length) {
          await writeStatus(d.area, { problem: 'locked', error: 'some-locked' }).catch(() => {});
          return 'locked';
        }
        await keep(null);
        return lockedFolder(io, null, null);
      }
      lock = { ...lock, v: 2, state: 'on' };
    }
    if (h!.state !== 'on' || !h!.kdf) await keep({ ...h!, kdf: lock.kdf, state: 'on' });
    return lockedFolder(io, lock, j.key);
  }

  // What the last open() made, for the sync that follows it. The syncer runs one at a time.
  let current: { refused: Set<string>; save?: () => Promise<void> } | null = null;

  const open: OpenFolder = async () => {
    const dest = await readDest(d.area);
    let io: FolderIO | Access;
    try {
      io = await raw(dest);
      if (typeof io === 'string') return io;
      const locked = await throughLock(io);
      if (typeof locked === 'string') return locked;
      let top: FolderIO = locked;
      let save: (() => Promise<void>) | undefined;
      if (dest?.kind === 'cloud' && d.kind !== 'native') {
        const k = SEEN_KEY(dest.provider);
        const c = cachedFolder(locked, d.store, {
          get: async () => ((await d.area.get(k))[k] as Record<string, Seen> | undefined) ?? {},
          set: (all) => d.area.set({ [k]: all }),
        });
        top = c;
        save = c.save;
      }
      current = { refused: locked.refused, save };
      return top;
    } catch (e) {
      const c = codeOf(e);
      const p = isProblem(c) ? c : 'server';
      await writeStatus(d.area, { error: String(c), problem: p }).catch(() => {});
      return p;
    }
  };

  const sync: SyncFolder = async (store, io, opts) => {
    const dest = await readDest(d.area);
    const here = current;
    const rep = await syncWithRetry(store, io, { ...opts, since: opts?.since ?? dest?.since });
    await here?.save?.().catch(() => {});
    const problem = problemOf(rep);
    await writeStatus(d.area, {
      ...(problem ? { problem, error: problem } : {}),
      ...(!opts?.only
        ? { locked: rep.locked?.length || undefined, refused: rep.refused?.length || undefined }
        : {}),
    }).catch(() => {});
    return rep;
  };

  async function state(): Promise<PlaceState> {
    const dest = await readDest(d.area);
    const st = await readStatus(d.area);
    const s: PlaceState = {
      dest,
      lastSync: st.lastSync,
      problem: st.problem,
      locked: st.locked,
      lock: 'off',
    };
    if (d.kind === 'native' && d.send) {
      const np = await nativePlace(d.send).catch(() => null);
      if (np) {
        s.folder = np.folder ?? undefined;
        s.account = np.account;
        // The reader may have connected the cloud in the app itself.
        if ((np.place === 'google' || np.place === 'onedrive') && s.dest?.kind !== 'cloud') {
          s.dest = { kind: 'cloud', provider: np.place };
        }
      }
    } else if (dest?.kind === 'cloud') {
      // The account name lives with the tokens in the secret store, never in storage.local.
      const t = (await d.secrets.get(`tok:${dest.provider}`).catch(() => undefined)) as
        | { account?: unknown }
        | undefined;
      if (typeof t?.account === 'string') s.account = t.account.slice(0, 200);
    }
    try {
      const io = await raw(dest);
      if (typeof io !== 'string') {
        const h = await held();
        const j = await judge(await lockOf(io), h);
        if (j.kind === 'plain') s.lock = 'off';
        else if (j.kind === 'needs-password') s.lock = 'needs-password';
        else if (j.kind === 'trouble') {
          s.lock = 'changed';
          s.trouble = j.why;
          s.canRestore = !!h?.kdf;
          s.recovery = true;
        } else {
          s.lock = j.lock.v === 1 ? 'on' : j.lock.state;
          s.recovery = true;
        }
      } else s.lock = 'unknown';
    } catch {
      s.lock = 'unknown';
    }
    if (st.refused) s.refused = st.refused;
    return s;
  }

  /** The previous place, for a switch: copy nothing by itself, older pages wait for "Copy". */
  async function switchTo(next: Dest): Promise<Dest> {
    const prev = await readDest(d.area);
    if (
      prev?.kind === 'cloud' &&
      d.kind !== 'native' &&
      (next.kind !== 'cloud' || next.provider !== prev.provider)
    ) {
      await (await getCloud()).disconnect(prev.provider, false).catch(() => {});
    }
    const same = prev && JSON.stringify({ ...prev, since: 0 }) === JSON.stringify({ ...next, since: 0 });
    const out: Dest = { ...next };
    if (same && prev?.since) out.since = prev.since;
    else if (!same && (prev || next.since)) out.since = next.since ?? now();
    else delete out.since;
    await writeDest(d.area, out);
    // A new place may have its own lock. The key for the old one does not open it.
    if (!same) await keep(null);
    lockSeen = null;
    return out;
  }

  const ex = <T>(fn: () => Promise<T>) => d.syncer().exclusive(fn);

  async function lockOp(m: Extract<ToPlace, { ink: 'lock' }>): Promise<PlaceReply> {
    const dest = await readDest(d.area);
    const io = await raw(dest);
    if (typeof io === 'string') return { problem: isProblem(io) ? io : undefined, error: io };
    lockSeen = null;
    const lock = await readLock(io);
    const h = await held();
    try {
      if (m.op === 'on') {
        if (lock) return { error: 'already' };
        // A device that holds a key and finds no lock file chooses between putting it back and off.
        if (h) return { error: 'changed' };
        if (!m.password || m.password.length < 8) return { error: 'short' };
        const { lock: l, key } = await newLock(m.password);
        const mine: HeldKey = { key: toB64(key), check: l.check, kdf: l.kdf, state: 'turning-on' };
        // The key is kept first, so a stop before the lock file is written can put it back.
        await keep(mine);
        const written = await writeLock(io, l, key);
        await settle(io, written, key);
        await keep({ ...mine, state: 'on' });
        return { ok: true, lock: 'on' };
      }
      if (m.op === 'unlock') {
        if (lock === 'bad') return { error: 'bad-lock' };
        if (!lock) return { error: 'no-lock' };
        const key = m.code
          ? fromRecoveryCode(m.code)
          : m.password
            ? await keyFromPassword(lock, m.password)
            : null;
        const got = key && (await unlockWith(lock, key));
        if (!got) return { error: 'wrong' };
        // The right password, but the lock file was changed by someone without it.
        if (lock.v === 2 && !(await verifyLock(lock, key))) return { error: 'changed' };
        await keep({ ...got, ...(lock.state !== 'turning-off' ? { state: lock.state } : {}) });
        return { ok: true, lock: lock.state };
      }
      if (!h)
        return lock ? { error: 'wrong' } : m.op === 'off' ? { ok: true, lock: 'off' } : { error: 'no-lock' };
      const key = fromB64(h.key);
      if (m.op === 'recovery') return { ok: true, code: recoveryCode(key) };
      const kdf = h.kdf ?? (lock && lock !== 'bad' && fits(lock, h) ? lock.kdf : undefined);
      if (m.op === 'restore') {
        if (!kdf) return { error: 'no-restore' };
        await keep({ ...h, kdf, state: 'turning-on' });
        const l = await writeLock(io, { kdf, check: h.check, state: 'turning-on' }, key);
        const p = await settle(io, l, key);
        await keep({ ...h, kdf, state: 'on' });
        return p.skipped.length ? { ok: true, lock: 'on', error: 'some-locked' } : { ok: true, lock: 'on' };
      }
      // Off, on purpose, from this device. Turning-off first, so a stop halfway leaves files
      // that this device finishes on its next sync.
      await keep({ ...h, kdf, state: 'turning-off' });
      const off: LockFile = kdf
        ? await writeLock(io, { kdf, check: h.check, state: 'turning-off' }, key)
        : {
            v: 2,
            kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 0, salt: '' },
            check: h.check,
            state: 'turning-off',
          };
      const p = await settle(io, off, key);
      if (p.skipped.length) return { error: 'some-locked', ok: false };
      await keep(null);
      return { ok: true, lock: 'off' };
    } finally {
      lockSeen = null;
    }
  }

  async function handle(m: ToPlace): Promise<PlaceReply> {
    try {
      switch (m.ink) {
        case 'place':
          return { ok: true, state: await state() };
        case 'connect': {
          let account: string | undefined;
          if (d.kind === 'native') {
            const r = await nativeConnect(d.send!, m.provider);
            if (r.pending) return { ok: true, pending: true, open: r.open };
            account = r.account;
          } else {
            account = (await (await getCloud()).connect(m.provider)).account;
          }
          // The account goes back in this reply only. It is kept with the tokens, not in the place.
          const next: Dest = { kind: 'cloud', provider: m.provider };
          if (m.switching) next.since = now();
          await ex(() => switchTo(next));
          const r = await d.syncer().full();
          return { ok: true, account, report: r.report, problem: isProblem(r.error) ? r.error : undefined };
        }
        case 'useFolder':
          await ex(() => switchTo(m.switching ? { kind: 'folder', since: now() } : { kind: 'folder' }));
          return { ok: true };
        case 'disconnect': {
          const dest = await readDest(d.area);
          await ex(async () => {
            if (dest?.kind === 'cloud' && d.kind !== 'native') {
              await (await getCloud()).disconnect(dest.provider, m.removeFiles === true);
              await d.area.remove(SEEN_KEY(dest.provider));
            } else if (d.kind === 'native' && d.send) {
              await nativeDisconnect(d.send, m.removeFiles === true);
            }
            await writeDest(d.area, null);
            await keep(null);
            await writeStatus(d.area, { locked: undefined });
            lockSeen = null;
          });
          return { ok: true };
        }
        case 'copyAll': {
          const dest = await readDest(d.area);
          if (dest) {
            const { since: _, ...rest } = dest;
            await writeDest(d.area, rest as Dest);
          }
          const r = await d.syncer().full();
          return { ok: !r.error, report: r.report, problem: isProblem(r.error) ? r.error : undefined };
        }
        case 'lock':
          return await ex(() => lockOp(m));
      }
    } catch (e) {
      const c = codeOf(e);
      // Only for a sign-in: what the provider said, cleaned again before it leaves.
      const detail = m.ink === 'connect' ? clean((e as { info?: unknown })?.info) : undefined;
      if (isProblem(c)) return detail ? { problem: c, detail } : { problem: c };
      return detail ? { error: c, detail } : { error: c };
    }
  }

  return { open, sync, handle, state };
}
