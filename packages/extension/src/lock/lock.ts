/**
 * The password lock over any place the notes are kept: a cloud, a folder on this device, or
 * the Safari app's folder. The lock file sits at the top of that place. It holds the salt,
 * the settings, a key-check value and a MAC over all of them, never the key.
 *
 * The rules (FORMAT.md, "Password lock"):
 * - Only the reader, on a device that holds the key, turns the lock off. A device never
 *   turns it off by itself because of what it finds in the place.
 * - A device that holds a key and finds the lock file missing, changed, or turning off when
 *   it did not start that, stops syncing the place and asks the reader what to do.
 * - While the lock is on, a file that is plain, or sealed for another name or with another
 *   key, is "not ours": it is never merged, written over or removed.
 * - Turning the lock on or off rewrites and renames the files one at a time, so a stop
 *   halfway is picked up again by the device that started it.
 */
import { hashKey } from 'pageink-core/hash';
import { LockedError, RefusedError, safeParse } from 'pageink-core/store';
import type { FolderIO } from 'pageink-core/types';
import {
  b64OrNull,
  deriveKey,
  type Envelope,
  envelopeOf,
  fromB64,
  ITERATIONS,
  keyCheck,
  lockedName,
  lockMac,
  randomBytes,
  SALT_BYTES,
  sameBytes,
  seal,
  toB64,
  unseal,
  WrongKey,
} from './crypto';

/** Name of the lock file at the top of the place. */
export const LOCK_FILE = 'pageink.lock.json';
const DIR = 'pages';
const EXT = '.ink.json';
/** A file name the lock writes or accepts as a page's own: `pages/<hash>[.<n>].ink.json`. */
const CANONICAL = /^pages\/([0-9a-z]{1,16})(?:\.[1-9][0-9]?)?\.ink\.json$/;

export type LockState = 'on' | 'turning-on' | 'turning-off';

export interface Kdf {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: string;
}

export interface LockFile {
  /** 2 for every lock file written now. 1 is read only to move a place to version 2. */
  v: 1 | 2;
  kdf: Kdf;
  /** HMAC-SHA-256 of "lock-check-v1" under the key, base64. */
  check: string;
  state: LockState;
  /** Version 2: HMAC-SHA-256 over every other field, under a key made from the lock key. */
  mac?: string;
}

/** The key as this device keeps it. `check` ties it to one lock. */
export interface HeldKey {
  key: string;
  check: string;
  /** The lock's settings, so this device can put the lock file back if it goes missing. */
  kdf?: Kdf;
  /** The state this device last wrote or accepted. "turning-off" only when this device started it. */
  state?: LockState;
}

/** True for the "no such file" error of any of the folders: on disk, in the app, in a cloud, in memory. */
export function isNotFound(e: unknown): boolean {
  const o = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (!o || typeof o !== 'object') return false;
  return (
    o.name === 'NotFoundError' ||
    o.code === 'not-found' ||
    (typeof o.message === 'string' && /no such file|not.?found/i.test(o.message))
  );
}

const STATES: readonly string[] = ['on', 'turning-on', 'turning-off'];

/**
 * Read the lock file. Null when there is none. A file we cannot make sense of is 'bad'. Any
 * other failure throws, so a sync that cannot tell whether the place is locked stops instead
 * of writing plain files. The MAC is not checked here: that needs the key (verifyLock).
 */
export async function readLock(io: FolderIO): Promise<LockFile | null | 'bad'> {
  let text: string;
  try {
    text = await io.read(LOCK_FILE);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  try {
    const v = safeParse(text) as LockFile;
    const k = v?.kdf;
    const salt = b64OrNull(k?.salt);
    const check = b64OrNull(v?.check);
    const mac = b64OrNull(v?.mac);
    if (
      (v?.v === 1 || (v?.v === 2 && mac?.length === 32)) &&
      k?.name === 'PBKDF2' &&
      k.hash === 'SHA-256' &&
      Number.isInteger(k.iterations) &&
      k.iterations >= 100_000 &&
      k.iterations <= 10_000_000 &&
      // An empty or short salt would let one table of guesses serve every lock.
      salt !== null &&
      salt.length >= SALT_BYTES &&
      check?.length === 32 &&
      STATES.includes(v.state)
    ) {
      const out: LockFile = {
        v: v.v,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: k.iterations, salt: k.salt },
        check: v.check,
        state: v.state,
      };
      if (v.v === 2) out.mac = v.mac;
      return out;
    }
  } catch {
    // Fall through.
  }
  return 'bad';
}

/** Write a version 2 lock file, with its MAC made under this key. */
export async function writeLock(
  io: FolderIO,
  l: Omit<LockFile, 'v' | 'mac'>,
  key: Uint8Array,
): Promise<LockFile> {
  const base = { kdf: l.kdf, check: l.check, state: l.state };
  const out: LockFile = { v: 2, ...base, mac: await lockMac(key, base) };
  await io.write(LOCK_FILE, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** True when the lock file is version 2 and its MAC is right for this key. */
export async function verifyLock(l: LockFile, key: Uint8Array): Promise<boolean> {
  if (l.v !== 2 || !l.mac) return false;
  const want = b64OrNull(await lockMac(key, l));
  const got = b64OrNull(l.mac);
  return !!want && !!got && sameBytes(want, got);
}

/** Whether a kept key belongs to this lock. Says nothing about the MAC. */
export const fits = (l: LockFile, held: HeldKey | null | undefined): boolean =>
  !!held && held.check === l.check;

/** Turn a password or a recovery key into a kept key, when it opens the lock. Null when wrong. */
export async function unlockWith(l: LockFile, key: Uint8Array): Promise<HeldKey | null> {
  const check = await keyCheck(key);
  const want = b64OrNull(l.check);
  if (!want || !sameBytes(check, want)) return null;
  return { key: toB64(key), check: l.check, kdf: l.kdf };
}

export async function keyFromPassword(l: { kdf: Kdf }, password: string): Promise<Uint8Array> {
  return deriveKey(password, fromB64(l.kdf.salt), l.kdf.iterations);
}

/** A new lock for a password: fresh salt, the default count, and its key. It starts turning on. */
export async function newLock(
  password: string,
): Promise<{ lock: Omit<LockFile, 'v' | 'mac'>; key: Uint8Array }> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, ITERATIONS);
  return {
    lock: {
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) },
      check: toB64(await keyCheck(key)),
      state: 'turning-on',
    },
    key,
  };
}

/** Why a device that holds a key stopped syncing: the lock file is gone, or it is not the one it knows. */
export type Trouble = 'missing' | 'changed';

/** What a device should do with the place, given the lock file it found and the key it holds. */
export type Judgement =
  /** No lock and no key: plain files. */
  | { kind: 'plain' }
  /** A lock and no key that fits: ask for the password. */
  | { kind: 'needs-password' }
  /** Stop syncing this place and ask the reader. */
  | { kind: 'trouble'; why: Trouble }
  /** The lock is verified. `work`: files to rewrite first (a turn on or off to finish, or a move from version 1). */
  | { kind: 'ready'; lock: LockFile; key: Uint8Array; work: boolean };

/**
 * The one decision every open of the place goes through. A held key is only ever given up by
 * the reader (lockOp), never here.
 */
export async function judge(lock: LockFile | null | 'bad', held: HeldKey | null): Promise<Judgement> {
  if (!held) return lock === null ? { kind: 'plain' } : { kind: 'needs-password' };
  if (lock === null) return { kind: 'trouble', why: 'missing' };
  if (lock === 'bad' || !fits(lock, held)) return { kind: 'trouble', why: 'changed' };
  const key = fromB64(held.key);
  if (lock.v === 1) {
    // Version 1 has no MAC. Moving it to version 2 is safe only toward "on".
    if (lock.state === 'turning-off') return { kind: 'trouble', why: 'changed' };
    return { kind: 'ready', lock, key, work: true };
  }
  if (!(await verifyLock(lock, key))) return { kind: 'trouble', why: 'changed' };
  // Turning off is finished only by the device that started it. And a device that saw the
  // lock on does not go back to turning on, the one step that takes plain files in: an old
  // lock file put back by someone else would otherwise let their plain files in.
  if (lock.state === 'turning-off' && held.state !== 'turning-off')
    return { kind: 'trouble', why: 'changed' };
  if (lock.state === 'turning-on' && held.state === 'on') return { kind: 'trouble', why: 'changed' };
  return { kind: 'ready', lock, key, work: lock.state !== 'on' };
}

/** The page key a record's text holds, or null. */
function recordKey(text: string): string | null {
  try {
    const k = (safeParse(text) as { key?: unknown } | null)?.key;
    return typeof k === 'string' && k ? k : null;
  } catch {
    return null;
  }
}

const baseOf = (name: string) => name.slice(name.lastIndexOf('/') + 1);

/**
 * Open a version 2 file found under `name`, and check that it belongs there: sealed for this
 * very name, or, for a sync copy, for the page whose name the copy starts with. Then the page
 * key inside must give that name. Throws WrongKey for anything else.
 */
export async function openChecked(key: Uint8Array, name: string, env: Envelope): Promise<string> {
  if (env.lock !== 2) throw new WrongKey();
  const m = CANONICAL.exec(env.f);
  if (!m) throw new WrongKey();
  const hash = m[1]!;
  const here = CANONICAL.test(name);
  if (here ? name !== env.f : !name.startsWith(`${DIR}/`) || !baseOf(name).startsWith(hash))
    throw new WrongKey();
  const text = await unseal(key, env);
  const k = recordKey(text);
  if (!k || (await lockedName(key, k)) !== hash) throw new WrongKey();
  return text;
}

/** A folder seen through the lock. `refused` collects files that are not ours while the lock is on. */
export interface LockedFolder extends FolderIO {
  refused: Set<string>;
}

/**
 * The folder for sync. With a lock that is on and its key, reads open and check version 2
 * files, writes seal them, and page files are named with the keyed name. Anything else in
 * pages/ is refused. With no lock and no key, files pass as they are, and a sealed file is
 * "locked": sync leaves it alone.
 */
export function lockedFolder(io: FolderIO, lock: LockFile | null, key: Uint8Array | null): LockedFolder {
  const refused = new Set<string>();
  if (lock && (!key || lock.state !== 'on')) {
    // The place is not ready for sync on this device. Nothing is read as a page, nothing written.
    return {
      ...io,
      refused,
      read: async (name) => {
        throw new LockedError(name);
      },
      write: async (name) => {
        throw new LockedError(name);
      },
    };
  }
  if (!lock) {
    return {
      ...io,
      refused,
      async read(name) {
        const text = await io.read(name);
        if (envelopeOf(text)) throw new LockedError(name);
        return text;
      },
    };
  }
  const k = key!;
  const names = new Map<string, string>();
  return {
    ...io,
    refused,
    async hash(pageKey: string) {
      let h = names.get(pageKey);
      if (!h) {
        h = await lockedName(k, pageKey);
        names.set(pageKey, h);
      }
      return h;
    },
    async read(name) {
      const text = await io.read(name);
      if (!name.startsWith(`${DIR}/`)) return text;
      const env = envelopeOf(text);
      try {
        if (!env) throw new WrongKey();
        return await openChecked(k, name, env);
      } catch (e) {
        if (!(e instanceof WrongKey)) throw e;
        refused.add(name);
        throw new RefusedError(name);
      }
    },
    async write(name, text) {
      if (!name.startsWith(`${DIR}/`)) {
        await io.write(name, text);
        return;
      }
      // Never a plain page file into a locked place, and never one under a name it cannot pass.
      if (!CANONICAL.test(name)) throw new RefusedError(name);
      await io.write(name, await seal(k, name, text));
    },
  };
}

export interface Progress {
  done: number;
  left: number;
  /** Files sealed with another key, left as they are. */
  skipped: string[];
  /** Files that are not ours while the lock is on, left as they are. */
  refused: string[];
}

/**
 * Bring every page file to the lock's state, then record that state. On and turning on:
 * each file becomes version 2, sealed under its keyed name. Turning off: each file is opened
 * and written plain under its plain name, then the lock file goes. Each file is written under
 * its new name before the old one is removed, so a stop at any point loses nothing: a name
 * already taken gets a sync copy, which the next sync folds in.
 *
 * Plain files are taken in only while turning on, the step the reader started. While the
 * lock is on (a move from version 1) a plain file is not ours and stays as it is.
 */
export async function settle(io: FolderIO, lock: LockFile, key: Uint8Array): Promise<Progress> {
  const p: Progress = { done: 0, left: 0, skipped: [], refused: [] };
  const off = lock.state === 'turning-off';
  const takePlain = lock.state === 'turning-on';
  const files = (await io.list(DIR)).map((f) => (f.name.includes('/') ? f.name : `${DIR}/${f.name}`));
  const taken = new Set(files);
  p.left = files.length;
  for (const name of files) {
    p.left--;
    let text: string;
    try {
      text = await io.read(name);
    } catch (e) {
      // Gone since the listing, moved by another device: nothing to do here.
      if (isNotFound(e)) continue;
      throw e;
    }
    const env = envelopeOf(text);
    let open: string;
    if (!off) {
      if (env?.lock === 2) continue;
      if (env) {
        try {
          open = await unseal(key, env);
        } catch {
          p.skipped.push(name);
          continue;
        }
      } else if (takePlain) {
        open = text;
      } else {
        p.refused.push(name);
        continue;
      }
    } else {
      if (!env) continue;
      try {
        open = env.lock === 2 ? await openChecked(key, name, env) : await unseal(key, env);
      } catch {
        p.skipped.push(name);
        continue;
      }
    }
    const k = recordKey(open);
    if (!k) {
      (off ? p.skipped : p.refused).push(name);
      continue;
    }
    const hash = off ? hashKey(k) : await lockedName(key, k);
    const canonical = `${DIR}/${hash}${EXT}`;
    let target = canonical;
    if (target !== name && taken.has(target)) {
      // The name is taken (another page with the same plain hash, or a stop halfway). A sync
      // copy is folded into the right page by the next sync.
      target = `${DIR}/${hash} (moved ${toB64(randomBytes(6)).replace(/[+/=]/g, '').toLowerCase()})${EXT}`;
    }
    await io.write(target, off ? open : await seal(key, canonical, open));
    taken.add(target);
    if (target !== name) await io.remove?.(name);
    p.done++;
  }
  if (off) {
    if (p.skipped.length) return p;
    await io.remove?.(LOCK_FILE).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
  } else if (lock.state !== 'on' || lock.v !== 2) {
    await writeLock(io, { ...lock, state: 'on' }, key);
  }
  return p;
}
