import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { hashKey, idxKey } from '../hash';
import type { FolderIO, PageRecord } from '../types';
import { memoryFolder, memoryKV } from './memory';
import { applyPatch, emptyRecord } from './patch';
import { createStore } from './store';
import {
  exportArchive,
  fileName,
  importArchive,
  LockedError,
  RefusedError,
  recordText,
  syncFolder,
} from './sync';
import { identity, note, stroke } from './testkit';

const idA = identity({ hosts: ['example.com', 'mirror.org'], aliases: ['https://example.com/canon'] });
const idB = identity({ key: 'https://example.com/b', url: 'https://example.com/b' });

function withNote(rec: PageRecord, id: string, t = 1000): PageRecord {
  return applyPatch(rec, { add: [note({ id, strokes: [stroke({ id: `${id}s` })] })] }, t);
}

async function readRec(io: FolderIO, key: string): Promise<PageRecord> {
  return JSON.parse(await io.read(fileName(key)));
}

describe('syncFolder', () => {
  it('pushes store records to an empty folder as pretty JSON', async () => {
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    const io = memoryFolder();
    const rep = await syncFolder(store, io);
    expect(rep).toMatchObject({ pushed: 1, pulled: 0, merged: 0, errors: [] });
    const text = await io.read(`pages/${hashKey(idA.key)}.ink.json`);
    expect(text).toContain('\n  "key"');
    expect(JSON.parse(text).notes[0].id).toBe('n1');
    // A second run finds nothing to do.
    expect(await syncFolder(store, io)).toMatchObject({ pushed: 0, pulled: 0, merged: 0 });
  });

  it('pulls folder records into an empty store and rebuilds the site index', async () => {
    const first = createStore(memoryKV());
    await first.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    const io = memoryFolder();
    await syncFolder(first, io);

    const kv = memoryKV();
    const second = createStore(kv);
    const rep = await syncFolder(second, io);
    expect(rep).toMatchObject({ pulled: 1, pushed: 0 });
    // Found from either host and from the alias, as on the first device.
    expect((await second.load(idA))?.notes.map((n) => n.id)).toEqual(['n1']);
    const atMirror = identity({
      key: 'https://example.com/canon',
      aliases: [],
      host: 'mirror.org',
      hosts: ['mirror.org'],
    });
    expect((await second.load(atMirror))?.key).toBe(idA.key);
    const idx = (await kv.get([idxKey('mirror.org')]))[idxKey('mirror.org')] as { m: Record<string, string> };
    expect(idx.m[hashKey('https://example.com/canon')]).toBe(hashKey(idA.key));
  });

  it('merges both sides when both changed', async () => {
    const store = createStore(memoryKV());
    const io = memoryFolder();
    const base = await store.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    await syncFolder(store, io);
    // Another device deletes n1 and adds n2 in the folder. This device adds n3.
    const remote = withNote(applyPatch(base, { del: ['n1'] }, 2000), 'n2', 2000);
    await io.write(fileName(idA.key), recordText(remote));
    await store.save(withNote(base, 'n3', 3000), idA);
    const rep = await syncFolder(store, io);
    expect(rep.merged).toBe(1);
    const local = (await store.get(idA.key))!;
    const folder = await readRec(io, idA.key);
    expect(local.notes.map((n) => n.id).sort()).toEqual(['n2', 'n3']);
    expect(folder.notes.map((n) => n.id).sort()).toEqual(['n2', 'n3']);
    expect(folder.deleted.map((d) => d.id)).toContain('n1');
  });

  it('folds conflict copies into the record with the same key and removes them', async () => {
    const store = createStore(memoryKV());
    const io = memoryFolder();
    const base = withNote(emptyRecord(idA, 'A'), 'n1');
    await io.write(fileName(idA.key), recordText(base));
    const h = hashKey(idA.key);
    const names = [
      `pages/${h} (1).ink.json`,
      `pages/${h} (conflicted copy 2026-01-01).ink.json`,
      `pages/${h} 2.ink.json`,
      `pages/${h}.ink.sync-conflict-20260101-120000-ABCDEFG.json`,
    ];
    for (const [i, name] of names.entries())
      await io.write(name, recordText(withNote(base, `c${i}`, 2000 + i)));
    // A copy of a different page, named after this one, still goes by its key.
    await io.write(`pages/${h}(2).ink.json`, recordText(withNote(emptyRecord(idB, 'B'), 'b1')));
    await io.write('pages/.DS_Store', 'junk');

    const rep = await syncFolder(store, io);
    expect(rep.conflictsFolded).toBe(5);
    expect(rep.errors).toEqual([]);
    expect((await io.list('pages')).map((f) => f.name).sort()).toEqual(
      ['pages/.DS_Store', fileName(idA.key), fileName(idB.key)].sort(),
    );
    expect((await readRec(io, idA.key)).notes.map((n) => n.id).sort()).toEqual([
      'c0',
      'c1',
      'c2',
      'c3',
      'n1',
    ]);
    expect((await store.get(idB.key))?.notes.map((n) => n.id)).toEqual(['b1']);
  });

  it('reports bad files, skips them and never overwrites them', async () => {
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    const io = memoryFolder();
    const bad = '{ not json';
    const future = JSON.stringify({ ...emptyRecord(idB, 'B'), v: 2 });
    await io.write(fileName(idA.key), bad);
    await io.write(fileName(idB.key), future);
    await io.write(`pages/${hashKey(idA.key)} (1).ink.json`, 'also bad');
    const rep = await syncFolder(store, io);
    expect(rep.errors).toHaveLength(3);
    expect(rep.errors.join('\n')).toMatch(/not valid JSON/);
    expect(rep.errors.join('\n')).toMatch(/unsupported version 2/);
    expect(await io.read(fileName(idA.key))).toBe(bad);
    expect(await io.read(fileName(idB.key))).toBe(future);
    expect(await io.read(`pages/${hashKey(idA.key)} (1).ink.json`)).toBe('also bad');
  });

  it('limits the run to the keys in only', async () => {
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    await store.save(withNote(emptyRecord(idB, 'B'), 'n2'), idB);
    const io = memoryFolder();
    await syncFolder(store, io, { only: [idB.key] });
    expect((await io.list('pages')).map((f) => f.name)).toEqual([fileName(idB.key)]);
  });

  it('carries deletions of whole pages through the folder', async () => {
    const io = memoryFolder();
    const s1 = createStore(memoryKV());
    const s2 = createStore(memoryKV());
    const r = await s1.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    await syncFolder(s1, io);
    await syncFolder(s2, io);
    await s1.save(applyPatch(r, { del: ['n1'] }, 5000), idA);
    await syncFolder(s1, io);
    await syncFolder(s2, io);
    expect((await s2.get(idA.key))?.notes).toEqual([]);
    expect(await s2.load(idA)).not.toBeNull();
    expect((await s2.list()).find((p) => p.key === idA.key)?.notes).toBe(0);
  });

  it('can be interrupted and run again', async () => {
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    await store.save(withNote(emptyRecord(idB, 'B'), 'n2'), idB);
    const io = memoryFolder();
    const h = hashKey(idA.key);
    await io.write(`pages/${h} (1).ink.json`, recordText(withNote(emptyRecord(idA, 'A'), 'c1')));
    let writes = 0;
    const flaky: FolderIO = {
      ...io,
      write: async (n, t) => {
        if (++writes === 2) throw new Error('disk gone');
        return io.write(n, t);
      },
    };
    const rep = await syncFolder(store, flaky);
    expect(rep.errors.length).toBe(1);
    await syncFolder(store, io);
    const a = await readRec(io, idA.key);
    expect(a.notes.map((n) => n.id).sort()).toEqual(['c1', 'n1']);
    expect((await readRec(io, idB.key)).notes.map((n) => n.id)).toEqual(['n2']);
    expect((await io.list('pages')).length).toBe(2);
  });
});

describe('locked files and since', () => {
  /** A folder whose files with these names cannot be opened, as with a password lock. */
  function sealed(io: FolderIO, names: Set<string>): FolderIO {
    return {
      ...io,
      read: async (name) => {
        if (names.has(name)) throw new LockedError(name);
        return io.read(name);
      },
    };
  }

  it('a locked file is not an error, is never written over, and holds its page back', async () => {
    const first = createStore(memoryKV());
    await first.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    const io = memoryFolder();
    await syncFolder(first, io);
    const before = await io.read(fileName(idA.key));

    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'mine', 5000), idA);
    await store.save(withNote(emptyRecord(idB, 'B'), 'n2'), idB);
    const rep = await syncFolder(store, sealed(io, new Set([fileName(idA.key)])));
    expect(rep.errors).toEqual([]);
    expect(rep.locked).toEqual([fileName(idA.key)]);
    expect(await io.read(fileName(idA.key))).toBe(before);
    expect((await io.list('pages')).map((f) => f.name)).toEqual(
      [fileName(idA.key), fileName(idB.key)].sort(),
    );
    // The local page is kept as it was.
    expect((await store.get(idA.key))?.notes.map((n) => n.id)).toEqual(['mine']);
  });

  it('a refused file is reported apart, never merged or written over, and holds its page back', async () => {
    const io = memoryFolder();
    const planted = recordText(withNote(emptyRecord(idA, 'A'), 'planted'));
    await io.write(fileName(idA.key), planted);
    const refusing: FolderIO = {
      ...io,
      read: async (name) => {
        if (name === fileName(idA.key)) throw new RefusedError(name);
        return io.read(name);
      },
    };
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'mine', 5000), idA);
    const rep = await syncFolder(store, refusing);
    expect(rep.refused).toEqual([fileName(idA.key)]);
    expect(rep.locked).toBeUndefined();
    expect(await io.read(fileName(idA.key))).toBe(planted);
    expect((await store.get(idA.key))?.notes.map((n) => n.id)).toEqual(['mine']);
  });

  it("a folder's own hash names the files", async () => {
    const io = memoryFolder();
    const named: FolderIO = { ...io, hash: async (key) => `k${hashKey(`~${key}`)}` };
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    expect(await syncFolder(store, named)).toMatchObject({ pushed: 1, errors: [] });
    const name = `pages/k${hashKey(`~${idA.key}`)}.ink.json`;
    expect((await io.list('pages')).map((f) => f.name)).toEqual([name]);
    // Read back by the same naming, with nothing to change.
    expect(await syncFolder(store, named)).toMatchObject({ pushed: 0, pulled: 0, errors: [] });
    expect(await syncFolder(store, named, { only: [idA.key] })).toMatchObject({ errors: [] });
    expect((await io.list('pages')).map((f) => f.name)).toEqual([name]);
  });

  it('since leaves out old pages that live only on this device', async () => {
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(idA, 'A'), 'old', 1000), idA);
    await store.save(withNote(emptyRecord(idB, 'B'), 'new', 9000), idB);
    const io = memoryFolder();
    const rep = await syncFolder(store, io, { since: 5000 });
    expect(rep.pushed).toBe(1);
    expect((await io.list('pages')).map((f) => f.name)).toEqual([fileName(idB.key)]);
    // A page the folder already holds still syncs, however old.
    const other = createStore(memoryKV());
    await other.save(withNote(emptyRecord(idA, 'A'), 'there', 2000), idA);
    await syncFolder(other, io);
    await syncFolder(store, io, { since: 5000 });
    expect((await readRec(io, idA.key)).notes.map((n) => n.id).sort()).toEqual(['old', 'there']);
  });
});

describe('archive', () => {
  it('exports the folder layout and imports by merging', async () => {
    const s1 = createStore(memoryKV());
    await s1.save(withNote(emptyRecord(idA, 'A'), 'n1'), idA);
    await s1.save(withNote(emptyRecord(idB, 'B'), 'n2'), idB);
    const zip = await exportArchive(s1);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([fileName(idA.key), fileName(idB.key)].sort());

    const s2 = createStore(memoryKV());
    await s2.save(withNote(emptyRecord(idA, 'A'), 'local'), idA);
    const rep = await importArchive(s2, zip);
    expect(rep).toMatchObject({ pulled: 1, merged: 1, errors: [] });
    expect((await s2.get(idA.key))?.notes.map((n) => n.id).sort()).toEqual(['local', 'n1']);
    expect((await s2.load(idB))?.notes.map((n) => n.id)).toEqual(['n2']);
    // Importing again changes nothing.
    expect(await importArchive(s2, zip)).toMatchObject({ pulled: 0, merged: 0 });
  });

  it('reports bad entries and bad archives', async () => {
    const store = createStore(memoryKV());
    const zip = zipSync({ 'pages/x.ink.json': strToU8('nope') });
    expect((await importArchive(store, zip)).errors).toHaveLength(1);
    expect((await importArchive(store, new Uint8Array([1, 2, 3]))).errors).toHaveLength(1);
  });
});
