import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashKey } from 'pageink-core/hash';
import { createStore, memoryFolder, memoryKV, syncFolder } from 'pageink-core/store';
import type { FolderIO } from 'pageink-core/types';
import { describe, expect, test } from 'vitest';
import { identity, note, record } from '../testing/records';
import {
  deriveKey,
  envelopeOf,
  fromB64,
  fromRecoveryCode,
  keyCheck,
  lockedName,
  lockMac,
  macText,
  recoveryCode,
  seal,
  sealV1,
  subKey,
  toB64,
  unseal,
  WrongKey,
} from './crypto';
import {
  type HeldKey,
  isNotFound,
  judge,
  keyFromPassword,
  LOCK_FILE,
  type LockFile,
  lockedFolder,
  newLock,
  openChecked,
  readLock,
  settle,
  unlockWith,
  verifyLock,
  writeLock,
} from './lock';

const file = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../../docs/lock-vectors.json'), 'utf8'),
);
const vectors = file.vectors as {
  password: string;
  saltB64: string;
  iterations: number;
  keyHex: string;
  checkB64: string;
  recoveryCode: string;
  sealKeyHex: string;
  fileKeyHex: string;
  namesKeyHex: string;
  pageKey: string;
  name: string;
  nonceB64: string;
  plaintext: string;
  envelope: string;
  lockState: string;
  lockMacText: string;
  lockMacB64: string;
  v1Envelope: string;
}[];

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const URL_A = 'https://a.test/one';
const URL_B = 'https://a.test/two';

describe('vectors', () => {
  test.each(vectors.map((v) => [v.password, v] as const))('%s', async (_p, v) => {
    const key = await deriveKey(v.password, fromB64(v.saltB64), v.iterations);
    expect(hex(key)).toBe(v.keyHex);
    expect(toB64(await keyCheck(key))).toBe(v.checkB64);
    expect(recoveryCode(key)).toBe(v.recoveryCode);
    expect(hex(fromRecoveryCode(v.recoveryCode.toLowerCase().replaceAll('-', ' '))!)).toBe(v.keyHex);
    expect(hex(await subKey(key, 'seal'))).toBe(v.sealKeyHex);
    expect(hex(await subKey(key, 'file'))).toBe(v.fileKeyHex);
    expect(hex(await subKey(key, 'names'))).toBe(v.namesKeyHex);
    expect(`pages/${await lockedName(key, v.pageKey)}.ink.json`).toBe(v.name);
    expect(await seal(key, v.name, v.plaintext, fromB64(v.nonceB64))).toBe(v.envelope);
    expect(await unseal(key, envelopeOf(v.envelope)!)).toBe(v.plaintext);
    expect(await openChecked(key, v.name, envelopeOf(v.envelope)!)).toBe(v.plaintext);
    const lock = {
      kdf: { iterations: v.iterations, salt: v.saltB64 },
      check: v.checkB64,
      state: v.lockState,
    };
    expect(macText(lock)).toBe(v.lockMacText);
    expect(await lockMac(key, lock)).toBe(v.lockMacB64);
    // Version 1, read only to move a place to version 2.
    expect(await sealV1(key, v.plaintext, fromB64(v.nonceB64))).toBe(v.v1Envelope);
    expect(await unseal(key, envelopeOf(v.v1Envelope)!)).toBe(v.plaintext);
  });

  test('plain names', () => {
    for (const n of file.plainNames as { key: string; hash: string }[]) expect(hashKey(n.key)).toBe(n.hash);
  });

  test('the NFC and NFD spellings of a password give the same key', async () => {
    const salt = new Uint8Array(16);
    const a = await deriveKey('café', salt, 100_000);
    const b = await deriveKey('café', salt, 100_000);
    expect(hex(a)).toBe(hex(b));
  });
});

describe('seal and open', () => {
  const key = new Uint8Array(32).fill(7);
  test('a fresh nonce every time, and a changed or foreign file does not open', async () => {
    const a = await seal(key, 'pages/x.ink.json', 'hello');
    const b = await seal(key, 'pages/x.ink.json', 'hello');
    expect(a).not.toBe(b);
    expect(await unseal(key, envelopeOf(a)!)).toBe('hello');
    await expect(unseal(new Uint8Array(32).fill(8), envelopeOf(a)!)).rejects.toBeInstanceOf(WrongKey);
    const env = envelopeOf(a)!;
    const c = fromB64(env.c);
    c[0]! ^= 1;
    await expect(unseal(key, { ...env, c: toB64(c) })).rejects.toBeInstanceOf(WrongKey);
  });
  test('the name is bound in: a file sealed for one name does not open as another', async () => {
    const env = envelopeOf(await seal(key, 'pages/a.ink.json', 'hello'))!;
    await expect(unseal(key, { ...env, f: 'pages/b.ink.json' } as never)).rejects.toBeInstanceOf(WrongKey);
  });
  test('plain records and odd text are not envelopes', () => {
    expect(envelopeOf('{\n  "v": 1}')).toBeNull();
    expect(envelopeOf('{"lock": 1, "alg": "other", "n": "", "c": ""}')).toBeNull();
    expect(envelopeOf('{"lock": 2, "alg": "A256GCM", "n": "", "c": ""}')).toBeNull();
    expect(envelopeOf('{"lock": 1, oops')).toBeNull();
  });
  test('recovery codes refuse the wrong length or letters', () => {
    expect(fromRecoveryCode('ABCD')).toBeNull();
    expect(fromRecoveryCode('1'.repeat(52))).toBeNull();
  });
});

/** A lock with a low count, so tests stay quick. The format allows from 100000. */
async function quickLock(password: string): Promise<{ lock: Omit<LockFile, 'v' | 'mac'>; key: Uint8Array }> {
  const { lock } = await newLock('unused');
  const l = { ...lock, kdf: { ...lock.kdf, iterations: 100_000 } };
  const key = await keyFromPassword(l, password);
  return { lock: { ...l, check: toB64(await keyCheck(key)) }, key };
}

const heldOf = (key: Uint8Array, l: { check: string; kdf: LockFile['kdf'] }, state?: HeldKey['state']) => ({
  key: toB64(key),
  check: l.check,
  kdf: l.kdf,
  ...(state ? { state } : {}),
});

async function twoPages(io: FolderIO) {
  const store = createStore(memoryKV());
  await store.save(record(URL_A, [note('n1')]), identity(URL_A));
  await store.save(record(URL_B, [note('n2')]), identity(URL_B));
  await syncFolder(store, io);
  return store;
}

const texts = async (io: FolderIO) => Promise.all((await io.list('pages')).map(async (f) => io.read(f.name)));
const names = async (io: FolderIO) => (await io.list('pages')).map((f) => f.name).sort();

/** A folder with two pages and the lock on. */
async function lockedPlace() {
  const io = memoryFolder();
  await twoPages(io);
  const { lock, key } = await quickLock('pw');
  const l = await writeLock(io, lock, key);
  await settle(io, l, key);
  const on = (await readLock(io)) as LockFile;
  return { io, key, lock: on };
}

describe('lock file', () => {
  test('missing is null, nonsense is bad, other failures throw', async () => {
    const io = memoryFolder();
    expect(await readLock(io)).toBeNull();
    await io.write(LOCK_FILE, '{"v": 1}');
    expect(await readLock(io)).toBe('bad');
    const broken: FolderIO = { ...io, read: () => Promise.reject(new Error('offline')) };
    await expect(readLock(broken)).rejects.toThrow('offline');
    expect(isNotFound({ name: 'NotFoundError' })).toBe(true);
    expect(isNotFound({ code: 'not-found' })).toBe(true);
    expect(isNotFound(new Error('offline'))).toBe(false);
  });

  test('an empty or short salt, or a version 2 file with no MAC, is refused', async () => {
    const { lock, key } = await quickLock('right');
    const io = memoryFolder();
    const l = await writeLock(io, lock, key);
    for (const salt of ['', 'AAAA']) {
      await io.write(LOCK_FILE, JSON.stringify({ ...l, kdf: { ...l.kdf, salt } }));
      expect(await readLock(io)).toBe('bad');
    }
    const { mac: _, ...noMac } = l;
    await io.write(LOCK_FILE, JSON.stringify(noMac));
    expect(await readLock(io)).toBe('bad');
  });

  test('the right password opens it, a wrong one does not, and the key is never in it', async () => {
    const { lock, key } = await quickLock('right');
    const io = memoryFolder();
    await writeLock(io, lock, key);
    const read = (await readLock(io)) as LockFile;
    expect(read).toMatchObject({ v: 2, ...lock });
    expect(await verifyLock(read, key)).toBe(true);
    expect(await io.read(LOCK_FILE)).not.toContain(toB64(key));
    expect(await unlockWith(read, await keyFromPassword(read, 'wrong'))).toBeNull();
    expect((await unlockWith(read, await keyFromPassword(read, 'right')))?.key).toBe(toB64(key));
    expect(await unlockWith(read, fromRecoveryCode(recoveryCode(key))!)).not.toBeNull();
  });

  test('any field changed without the key fails the MAC', async () => {
    const { lock, key } = await quickLock('right');
    const l = await writeLock(memoryFolder(), lock, key);
    expect(await verifyLock({ ...l, state: 'turning-off' }, key)).toBe(false);
    expect(await verifyLock({ ...l, kdf: { ...l.kdf, iterations: 100_001 } }, key)).toBe(false);
    expect(await verifyLock({ ...l, v: 1 }, key)).toBe(false);
  });
});

describe('judge: a device never turns the lock off by itself', () => {
  test('every case', async () => {
    const { lock, key } = await quickLock('pw');
    const io = memoryFolder();
    const on = await writeLock(io, { ...lock, state: 'on' }, key);
    const h = heldOf(key, on, 'on');
    expect(await judge(null, null)).toEqual({ kind: 'plain' });
    expect(await judge(on, null)).toEqual({ kind: 'needs-password' });
    expect(await judge(null, h)).toEqual({ kind: 'trouble', why: 'missing' });
    expect(await judge('bad', h)).toEqual({ kind: 'trouble', why: 'changed' });
    expect(await judge(on, h)).toMatchObject({ kind: 'ready', work: false });
    // Edited without the key.
    expect(await judge({ ...on, state: 'turning-off' }, h)).toEqual({ kind: 'trouble', why: 'changed' });
    // Signed, but this device did not start turning off.
    const off = await writeLock(io, { ...lock, state: 'turning-off' }, key);
    expect(await judge(off, h)).toEqual({ kind: 'trouble', why: 'changed' });
    expect(await judge(off, { ...h, state: 'turning-off' })).toMatchObject({ kind: 'ready', work: true });
    // An old "turning on" file put back after this device saw the lock on.
    const turning = await writeLock(io, { ...lock, state: 'turning-on' }, key);
    expect(await judge(turning, h)).toEqual({ kind: 'trouble', why: 'changed' });
    expect(await judge(turning, heldOf(key, on))).toMatchObject({ kind: 'ready', work: true });
    // Another lock.
    const other = await quickLock('other');
    expect(await judge(await writeLock(io, other.lock, other.key), h)).toEqual({
      kind: 'trouble',
      why: 'changed',
    });
    // Version 1: moved forward toward on, never followed toward off.
    expect(await judge({ v: 1, ...lock, state: 'on' }, heldOf(key, lock))).toMatchObject({
      kind: 'ready',
      work: true,
    });
    expect(await judge({ v: 1, ...lock, state: 'turning-off' }, heldOf(key, lock))).toMatchObject({
      kind: 'trouble',
    });
  });
});

describe('turning the lock on and off', () => {
  test('on: every file is sealed under a keyed name the provider cannot link to its page', async () => {
    const io = memoryFolder();
    await twoPages(io);
    const plainNames = await names(io);
    expect(plainNames).toEqual(
      [`pages/${hashKey(URL_A)}.ink.json`, `pages/${hashKey(URL_B)}.ink.json`].sort(),
    );
    const { lock, key } = await quickLock('pw');
    const p = await settle(io, await writeLock(io, lock, key), key);
    expect(p).toMatchObject({ done: 2, left: 0, skipped: [], refused: [] });
    const locked = await names(io);
    expect(locked).toEqual(
      [
        `pages/${await lockedName(key, URL_A)}.ink.json`,
        `pages/${await lockedName(key, URL_B)}.ink.json`,
      ].sort(),
    );
    for (const n of plainNames) expect(locked).not.toContain(n);
    for (const t of await texts(io)) expect(envelopeOf(t)?.lock).toBe(2);
    const on = (await readLock(io)) as LockFile;
    expect(on.state).toBe('on');
    expect(await verifyLock(on, key)).toBe(true);

    const other = createStore(memoryKV());
    const rep = await syncFolder(other, lockedFolder(io, on, key));
    expect(rep).toMatchObject({ pulled: 2, errors: [] });
    expect((await other.get(URL_A))?.notes).toHaveLength(1);
    // A write lands under the keyed name, sealed.
    await other.save(record(URL_A, [note('n1'), note('n3')]), identity(URL_A));
    expect(await syncFolder(other, lockedFolder(io, on, key))).toMatchObject({ pushed: 1, errors: [] });
    expect(await names(io)).toEqual(locked);
  });

  test('stopped halfway, every file still opens, and the next pass finishes', async () => {
    const io = memoryFolder();
    await twoPages(io);
    const { lock, key } = await quickLock('pw');
    const l = await writeLock(io, lock, key);
    let writes = 0;
    const flaky: FolderIO = {
      ...io,
      write: async (n, t) => {
        if (++writes > 1) throw new Error('offline');
        await io.write(n, t);
      },
    };
    await expect(settle(flaky, l, key)).rejects.toThrow('offline');
    const mixed = await texts(io);
    expect(mixed.filter((t) => envelopeOf(t)).length).toBe(1);
    expect(((await readLock(io)) as LockFile).state).toBe('turning-on');
    expect((await settle(io, l, key)).done).toBe(1);
    expect(((await readLock(io)) as LockFile).state).toBe('on');
    const store = createStore(memoryKV());
    expect((await syncFolder(store, lockedFolder(io, (await readLock(io)) as LockFile, key))).pulled).toBe(2);
  });

  test('off: every file is plain again under its plain name, and the lock file goes', async () => {
    const { io, key, lock } = await lockedPlace();
    const off = await writeLock(io, { ...lock, state: 'turning-off' }, key);
    expect((await settle(io, off, key)).done).toBe(2);
    for (const t of await texts(io)) expect(envelopeOf(t)).toBeNull();
    expect(await names(io)).toEqual(
      [`pages/${hashKey(URL_A)}.ink.json`, `pages/${hashKey(URL_B)}.ink.json`].sort(),
    );
    expect(await readLock(io)).toBeNull();
  });

  test('a place locked with version 1 moves to version 2; plain files found there stay out', async () => {
    const io = memoryFolder();
    await twoPages(io);
    const { lock, key } = await quickLock('pw');
    const [a, b] = await names(io);
    await io.write(a!, await sealV1(key, await io.read(a!)));
    // b stays plain, as if someone put it there while the lock was on.
    await io.write(LOCK_FILE, JSON.stringify({ v: 1, ...lock, state: 'on' }));
    const v1 = (await readLock(io)) as LockFile;
    expect(v1.v).toBe(1);
    const p = await settle(io, v1, key);
    expect(p).toMatchObject({ done: 1, refused: [b] });
    const now = (await readLock(io)) as LockFile;
    expect(now).toMatchObject({ v: 2, state: 'on' });
    expect(await verifyLock(now, key)).toBe(true);
    expect(await names(io)).toEqual([`pages/${await lockedName(key, URL_A)}.ink.json`, b].sort());
  });
});

describe('sync through the lock', () => {
  test('without the key a sealed file is locked: no error, never written over, told once', async () => {
    const { io, lock } = await lockedPlace();
    const before = await texts(io);
    const store = createStore(memoryKV());
    await store.save(record(URL_A, [note('mine')]), identity(URL_A));
    // With a lock but no key, nothing is read or written at all.
    const rep = await syncFolder(store, lockedFolder(io, lock, null));
    expect(rep.errors.filter((e) => !/locked/.test(e))).toEqual([]);
    expect(rep.locked).toHaveLength(2);
    expect(await texts(io)).toEqual(before);
    expect(await names(io)).toHaveLength(2);
  });

  test('while on, a plain record is not ours: never merged, written over or removed', async () => {
    const { io, key, lock } = await lockedPlace();
    const store = createStore(memoryKV());
    await syncFolder(store, lockedFolder(io, lock, key));
    const name = `pages/${await lockedName(key, URL_A)}.ink.json`;
    // A plain record with a deletion, planted under the page's own name.
    const planted = `${JSON.stringify({ ...record(URL_A, []), deleted: [{ id: 'n1', t: 9e12 }] }, null, 2)}\n`;
    await io.write(name, planted);
    const rep = await syncFolder(store, lockedFolder(io, lock, key));
    expect(rep.refused).toEqual([name]);
    expect((await store.get(URL_A))?.notes.map((n) => n.id)).toEqual(['n1']);
    expect(await io.read(name)).toBe(planted);
  });

  test("a page's file under another page's name is refused; a sync copy of its own is folded in", async () => {
    const { io, key, lock } = await lockedPlace();
    const na = `pages/${await lockedName(key, URL_A)}.ink.json`;
    const nb = `pages/${await lockedName(key, URL_B)}.ink.json`;
    const ta = await io.read(na);
    const tb = await io.read(nb);
    // Swapped.
    await io.write(na, tb);
    await io.write(nb, ta);
    const store = createStore(memoryKV());
    const rep = await syncFolder(store, lockedFolder(io, lock, key));
    expect(rep.refused?.sort()).toEqual([na, nb].sort());
    expect(rep.pulled).toBe(0);
    // Put back, plus a sync copy of A made by a sync service.
    await io.write(na, ta);
    await io.write(nb, tb);
    const copy = na.replace('.ink.json', ' (1).ink.json');
    await io.write(copy, ta);
    // And A's file posing as a copy of B.
    const fake = nb.replace('.ink.json', ' (2).ink.json');
    await io.write(fake, ta);
    const rep2 = await syncFolder(store, lockedFolder(io, lock, key));
    expect(rep2.refused).toEqual([fake]);
    expect(rep2.conflictsFolded).toBe(1);
    expect(await io.read(fake)).toBe(ta);
  });

  test('writes are sealed for their name, and a name the lock does not know is refused', async () => {
    const { lock, key } = await quickLock('pw');
    const io = memoryFolder();
    const on = await writeLock(io, { ...lock, state: 'on' }, key);
    const f = lockedFolder(io, on, key);
    await f.write('pages/x.ink.json', 'hello');
    expect(envelopeOf(await io.read('pages/x.ink.json'))).toMatchObject({ lock: 2, f: 'pages/x.ink.json' });
    await expect(f.write('pages/x (1).ink.json', 'hi')).rejects.toThrow('not ours');
  });
});
