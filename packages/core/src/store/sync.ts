import { strFromU8, strToU8, Unzip, UnzipInflate, UnzipPassThrough, zipSync } from 'fflate';
import { hashKey } from '../hash';
import type { ExportArchive, ImportArchive, PageRecord, SyncFolder, SyncReport } from '../types';
import { identityOf } from './identity';
import { merge, sameRecord } from './merge';
import { cleanRecord, safeParse } from './validate';

const DIR = 'pages';
/** `<hash>.ink.json`, or `<hash>.<n>.ink.json` for a page whose hash another page already uses. */
const CANONICAL = /^([0-9a-z]{1,16})(?:\.([1-9][0-9]?))?\.ink\.json$/;
const MAX_SLOTS = 8;

/** Name of the main file for a key. A page that shares its hash with another may use `<hash>.<n>`. */
export const fileName = (key: string) => `${DIR}/${hashKey(key)}.ink.json`;
export const recordText = (rec: PageRecord) => `${JSON.stringify(rec, null, 2)}\n`;

/**
 * Sync services rename a file instead of overwriting it when two devices change it at once:
 * "x (1).ink.json", "x (conflicted copy 2026-01-01).ink.json", "x 2.ink.json",
 * "x.ink.sync-conflict-20260101-120000-ABC.json" and so on. Any file in pages/ that is
 * not a plain "<hash>.ink.json" but still looks like one of ours is treated as such a copy.
 * Its record key, not its name, says which page it belongs to.
 */
export function classify(base: string): 'canonical' | 'copy' | 'other' {
  if (CANONICAL.test(base)) return 'canonical';
  if (base.startsWith('.')) return 'other';
  if (/\.ink\b/.test(base) && (/\.json$/i.test(base) || /sync-conflict/i.test(base))) return 'copy';
  return 'other';
}

/** The hash part of a canonical file name. */
const hashOf = (base: string): string => CANONICAL.exec(base)?.[1] ?? '';

/** A free file name for a hash: the main name, else the first free overflow name. */
function freeName(h: string, taken: Set<string>): string | null {
  for (let i = 0; i < MAX_SLOTS; i++) {
    const n = i === 0 ? `${DIR}/${h}.ink.json` : `${DIR}/${h}.${i}.ink.json`;
    if (!taken.has(n)) return n;
  }
  return null;
}

interface Parsed {
  rec?: PageRecord;
  error?: string;
  /** Parts were left out. The file must not be written over. */
  partial?: boolean;
}

function parse(text: string, name: string): Parsed {
  let v: unknown;
  try {
    v = safeParse(text);
  } catch {
    return { error: `${name}: not valid JSON` };
  }
  const c = cleanRecord(v);
  if (!c.rec) return { error: `${name}: ${c.problem ?? 'unreadable'}` };
  if (c.dropped.length) {
    const more = c.dropped.length > 1 ? ` and ${c.dropped.length - 1} more` : '';
    return { rec: c.rec, partial: true, error: `${name}: left out ${c.dropped[0]}${more}` };
  }
  return { rec: c.rec };
}

interface FolderSide {
  /** Record from the file that holds this key, when it exists and parses. */
  file?: PageRecord;
  /** Name of the file kept for this key, and what it holds. */
  name?: string;
  own?: PageRecord;
  copies: { name: string; rec: PageRecord }[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Thrown by a folder's read when a file is sealed with a password lock this device does not
 * hold. Sync treats such a file as locked, never as damaged: it is not reported as an error,
 * and neither it nor any other file of the same page is written or removed.
 */
export class LockedError extends Error {
  readonly locked = true;
  constructor(name: string) {
    super(`${name}: locked`);
    this.name = 'LockedError';
  }
}

export const isLocked = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { locked?: unknown }).locked === true;

/**
 * Thrown by a folder's read when the password lock is on and the file is not ours: plain, or
 * sealed for another name or with another key. Sync never merges it, never writes over it and
 * never removes it, and writes nothing for its page.
 */
export class RefusedError extends Error {
  readonly refused = true;
  constructor(name: string) {
    super(`${name}: not ours`);
    this.name = 'RefusedError';
  }
}

export const isRefused = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { refused?: unknown }).refused === true;

export const syncFolder: SyncFolder = async (store, io, opts) => {
  const report: SyncReport = { pulled: 0, pushed: 0, merged: 0, conflictsFolded: 0, errors: [] };
  const only = opts?.only ? new Set(opts.only) : null;
  const hashes = new Map<string, string>();
  const hashOfKey = async (key: string): Promise<string> => {
    let h = hashes.get(key);
    if (h === undefined) {
      h = io.hash ? await io.hash(key) : hashKey(key);
      hashes.set(key, h);
    }
    return h;
  };
  const onlyHashes = only ? new Set(await Promise.all([...only].map(hashOfKey))) : null;

  let listed: { name: string }[] = [];
  try {
    listed = await io.list(DIR);
  } catch (e) {
    report.errors.push(`${DIR}: cannot list (${errMsg(e)})`);
    return report;
  }

  const side = new Map<string, FolderSide>();
  const at = (key: string) => {
    const had = side.get(key);
    if (had) return had;
    const s: FolderSide = { copies: [] };
    side.set(key, s);
    return s;
  };
  // Names we must never write or remove: they hold something we could not read in full.
  const blocked = new Set<string>();
  // Every name in the folder, so a new file never lands on an existing one.
  const taken = new Set<string>();
  // Hashes of pages with a locked file. Nothing is written for them until the lock is open.
  const lockedHashes = new Set<string>();

  for (const entry of listed) {
    // Adapters may list bare names or names relative to the folder root.
    const name = entry.name.includes('/') ? entry.name : `${DIR}/${entry.name}`;
    taken.add(name);
    const base = name.slice(name.lastIndexOf('/') + 1);
    const kind = classify(base);
    if (kind === 'other') continue;
    if (kind === 'canonical' && onlyHashes && !onlyHashes.has(hashOf(base))) continue;
    let text: string;
    try {
      text = await io.read(name);
    } catch (e) {
      blocked.add(name);
      if (isLocked(e) || isRefused(e)) {
        if (isRefused(e)) {
          report.refused ??= [];
          report.refused.push(name);
        } else {
          report.locked ??= [];
          report.locked.push(name);
        }
        // A copy's name says little about its page, so a locked copy holds back nothing more.
        if (kind === 'canonical') lockedHashes.add(hashOf(base));
        continue;
      }
      report.errors.push(`${name}: cannot read (${errMsg(e)})`);
      continue;
    }
    const { rec, error, partial } = parse(text, name);
    if (error) report.errors.push(error);
    if (!rec || partial) blocked.add(name);
    if (!rec) continue;
    if (only && !only.has(rec.key)) continue;
    const s = at(rec.key);
    if (kind === 'canonical' && hashOf(base) === (await hashOfKey(rec.key))) {
      s.file = s.file ? merge(s.file, rec) : rec;
      // The first readable file is the one to keep. A second one for the same key is folded in.
      if (!s.name && !partial) {
        s.name = name;
        s.own = rec;
      } else if (!partial) s.copies.push({ name, rec });
    } else if (kind === 'canonical') {
      // A plain file under another page's hash. Fold it in but leave it, since it is not a copy.
      s.copies.push({ name: '', rec });
    } else {
      s.copies.push({ name: partial ? '' : name, rec });
    }
  }

  const keys = new Set(side.keys());
  try {
    for (const p of await store.list()) {
      if (only && !only.has(p.key)) continue;
      if (opts?.since !== undefined && p.updatedAt < opts.since && !side.has(p.key)) continue;
      keys.add(p.key);
    }
  } catch (e) {
    report.errors.push(`store: cannot list (${errMsg(e)})`);
    return report;
  }

  for (const key of keys) {
    try {
      const s = side.get(key) ?? { copies: [] };
      const local = await store.get(key);
      let folder = s.file;
      for (const c of s.copies) folder = folder ? merge(folder, c.rec) : c.rec;
      if (!local && !folder) continue;
      // The page's own file is locked: leave both sides as they are.
      const h = await hashOfKey(key);
      if (lockedHashes.has(h)) continue;

      let m = local && folder ? merge(local, folder) : (local ?? folder)!;
      const storeChanged = !local || !sameRecord(local, m);
      if (storeChanged) m = await store.save(m, identityOf(m));

      const target = s.name ?? freeName(h, taken);
      if (!target) throw new Error('no free file name');
      taken.add(target);
      const folderChanged = !s.own || !sameRecord(s.own, m);
      if (folderChanged) await io.write(target, recordText(m));

      if (storeChanged && folderChanged) report.merged++;
      else if (storeChanged) report.pulled++;
      else if (folderChanged) report.pushed++;

      // Only after the merged record is safe on both sides.
      for (const c of s.copies) {
        if (!c.name || c.name === target || blocked.has(c.name) || !io.remove) continue;
        await io.remove(c.name);
        report.conflictsFolded++;
      }
    } catch (e) {
      report.errors.push(`${key}: ${errMsg(e)}`);
    }
  }
  return report;
};

export const exportArchive: ExportArchive = async (store) => {
  const files: Record<string, Uint8Array> = {};
  const taken = new Set<string>();
  for (const p of await store.list()) {
    const rec = await store.get(p.key);
    const name = rec && freeName(hashKey(rec.key), taken);
    if (!rec || !name) continue;
    taken.add(name);
    files[name] = strToU8(recordText(rec));
  }
  return zipSync(files, { level: 6 });
};

/** Caps for an archive. They are checked while it is unpacked, so a zip bomb stops early. */
export const LIMITS = {
  /** Size of the archive file. */
  archive: 256 * 1024 * 1024,
  /** All files unpacked together. */
  total: 1024 * 1024 * 1024,
  /** One unpacked file. */
  file: 32 * 1024 * 1024,
  files: 50_000,
  name: 255,
};

/** Bytes handed to the unzipper at a time. Deflate expands at most about 1000 times. */
const CHUNK = 16 * 1024;

class TooBig extends Error {}

/** An archive entry name we accept: pages/<file>, plain characters, no folders or tricks. */
const okName = (name: string): boolean =>
  name.length <= LIMITS.name &&
  name.startsWith(`${DIR}/`) &&
  !name.slice(DIR.length + 1).includes('/') &&
  !name.includes('\\') &&
  !name.includes('..') &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  !/[\u0000-\u001f\u007f]/.test(name) &&
  classify(name.slice(DIR.length + 1)) !== 'other';

/**
 * Unpack the record files of an archive with every cap enforced as bytes come out.
 * Entries with other names are skipped unread. Throws TooBig when a cap is passed.
 */
export function unpack(zip: Uint8Array, limits = LIMITS): Map<string, Uint8Array> {
  if (zip.length > limits.archive) throw new TooBig(`archive is larger than ${limits.archive} bytes`);
  // A zip starts with a file header, or with the end record when it holds no files.
  const sig = zip.length >= 4 ? (zip[0]! | (zip[1]! << 8) | (zip[2]! << 16) | (zip[3]! << 24)) >>> 0 : 0;
  if (sig !== 0x04034b50 && sig !== 0x06054b50) throw new Error('not a zip archive');
  const out = new Map<string, Uint8Array>();
  let count = 0;
  let total = 0;
  const u = new Unzip((file) => {
    if (++count > limits.files) throw new TooBig(`more than ${limits.files} files`);
    if (!okName(file.name)) return;
    if (out.has(file.name)) throw new TooBig(`${file.name} appears twice`);
    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      size += chunk.length;
      total += chunk.length;
      if (size > limits.file) throw new TooBig(`${file.name} is larger than ${limits.file} bytes`);
      if (total > limits.total) throw new TooBig(`archive unpacks to more than ${limits.total} bytes`);
      parts.push(chunk);
      if (final) {
        const all = new Uint8Array(size);
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.length;
        }
        out.set(file.name, all);
      }
    };
    file.start();
  });
  u.register(UnzipInflate);
  u.register(UnzipPassThrough);
  for (let i = 0; i < zip.length; i += CHUNK) {
    u.push(zip.subarray(i, Math.min(zip.length, i + CHUNK)), i + CHUNK >= zip.length);
  }
  return out;
}

export const importArchive: ImportArchive = async (store, zip) => {
  const report: SyncReport = { pulled: 0, pushed: 0, merged: 0, conflictsFolded: 0, errors: [] };
  let entries: Map<string, Uint8Array>;
  try {
    entries = unpack(zip);
  } catch (e) {
    report.errors.push(`archive: cannot unzip (${errMsg(e)})`);
    return report;
  }
  const byKey = new Map<string, PageRecord>();
  for (const [name, bytes] of entries) {
    const { rec, error } = parse(strFromU8(bytes), name);
    if (error) report.errors.push(error);
    if (!rec) continue;
    const had = byKey.get(rec.key);
    if (had) report.conflictsFolded++;
    byKey.set(rec.key, had ? merge(had, rec) : rec);
  }
  for (const [key, rec] of byKey) {
    try {
      const local = await store.get(key);
      if (local && sameRecord(local, merge(local, rec))) continue;
      await store.save(local ? merge(local, rec) : rec, identityOf(rec));
      if (local) report.merged++;
      else report.pulled++;
    } catch (e) {
      report.errors.push(`${key}: ${errMsg(e)}`);
    }
  }
  return report;
};
