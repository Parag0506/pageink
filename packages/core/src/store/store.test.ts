import { describe, expect, it } from 'vitest';
import { CFG_KEY, hashKey, idxKey, pageKeyOf } from '../hash';
import type { KV, PageRecord } from '../types';
import { toMarkdown } from './markdown';
import { memoryFolder, memoryKV } from './memory';
import { laterId, merge } from './merge';
import { moveNotes } from './ops';
import { applyPatch, emptyRecord, showsInk } from './patch';
import { createStore, storeOver } from './store';
import { identity, note, rng, stroke } from './testkit';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function settle(...stores: { idle(): Promise<void> }[]) {
  for (let i = 0; i < 5; i++) {
    for (const s of stores) await s.idle();
    await tick();
  }
}

describe('memoryKV', () => {
  it('stores copies and reports changes', async () => {
    const kv = memoryKV();
    const seen: Record<string, unknown>[] = [];
    kv.onChange!((c) => seen.push(c));
    const v = { a: 1 };
    await kv.set({ k1: v, k2: 2 });
    v.a = 9;
    expect(await kv.get(['k1', 'nope'])).toEqual({ k1: { a: 1 } });
    expect(await kv.keys('k')).toEqual(['k1', 'k2']);
    await kv.remove(['k1']);
    await tick();
    expect(seen).toEqual([{ k1: { a: 1 }, k2: 2 }, { k1: undefined }]);
  });
});

describe('memoryFolder', () => {
  it('lists one directory with full names', async () => {
    const io = memoryFolder({ 'pages/a.ink.json': '{}', 'other/b.txt': 'x' });
    await io.write('pages/c.ink.json', 'abc');
    expect((await io.list('pages')).map((f) => f.name)).toEqual(['pages/a.ink.json', 'pages/c.ink.json']);
    expect(await io.read('pages/c.ink.json')).toBe('abc');
    await io.remove!('pages/a.ink.json');
    await expect(io.read('pages/a.ink.json')).rejects.toThrow();
  });
});

function withNote(rec: PageRecord, id: string, t = 1000): PageRecord {
  return applyPatch(rec, { add: [note({ id, strokes: [stroke({ id: `${id}s` })] })] }, t);
}

describe('createStore', () => {
  it('saves and loads, and indexes every host and alias', async () => {
    const kv = memoryKV();
    const store = createStore(kv);
    const id = identity({
      aliases: ['https://example.com/canonical'],
      hosts: ['example.com', 'mirror.org'],
    });
    const saved = await store.save(withNote(emptyRecord(id, 'T'), 'n1'), id);
    expect(saved.notes).toHaveLength(1);
    expect(await store.load(id)).toEqual(saved);
    for (const host of ['example.com', 'mirror.org']) {
      const idx = (await kv.get([idxKey(host)]))[idxKey(host)] as { v: 1; m: Record<string, string> };
      expect(idx.v).toBe(1);
      expect(idx.m[hashKey(id.key)]).toBe(hashKey(id.key));
      expect(idx.m[hashKey('https://example.com/canonical')]).toBe(hashKey(id.key));
    }
  });

  it('finds a record written at one address from another address of the document', async () => {
    const store = createStore(memoryKV());
    const first = identity({
      key: 'https://a.org/x',
      aliases: ['https://a.org/canon'],
      host: 'a.org',
      hosts: ['a.org'],
    });
    await store.save(withNote(emptyRecord(first, 'T'), 'n1'), first);
    // Arrives at the canonical address, which is its own key here.
    const viaAlias = identity({ key: 'https://a.org/canon', aliases: [], host: 'a.org', hosts: ['a.org'] });
    expect((await store.load(viaAlias))?.key).toBe('https://a.org/x');
    // Arrives at a new address that lists the first one as an alias.
    const viaOther = identity({
      key: 'https://a.org/y',
      aliases: ['https://a.org/x'],
      host: 'a.org',
      hosts: ['a.org'],
    });
    expect((await store.load(viaOther))?.key).toBe('https://a.org/x');
    const none = identity({ key: 'https://a.org/z', aliases: [], host: 'a.org', hosts: ['a.org'] });
    expect(await store.load(none)).toBeNull();
  });

  it('merges with what is stored instead of overwriting', async () => {
    const kv = memoryKV();
    const id = identity();
    await createStore(kv).save(withNote(emptyRecord(id, 'T'), 'n1'), id);
    const out = await createStore(kv).save(withNote(emptyRecord(id, 'T'), 'n2'), id);
    expect(out.notes.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
  });

  it('drops an empty page from the index but keeps its tombstones', async () => {
    const kv = memoryKV();
    const store = createStore(kv);
    const a = identity();
    const b = identity({ key: 'https://example.com/b', url: 'https://example.com/b' });
    const ra = await store.save(withNote(emptyRecord(a, 'A'), 'n1'), a);
    await store.save(withNote(emptyRecord(b, 'B'), 'n2'), b);
    const cleared = await store.save(applyPatch(ra, { del: ['n1'] }, 5000), a);
    expect(cleared.notes).toEqual([]);
    expect(await store.get(a.key)).toMatchObject({ deleted: [{ id: 'n1' }] });
    let idx = (await kv.get([idxKey('example.com')]))[idxKey('example.com')] as { m: Record<string, string> };
    expect(Object.values(idx.m)).toEqual([hashKey(b.key)]);

    const rb = (await store.get(b.key))!;
    await store.save(applyPatch(rb, { del: ['n2'] }, 6000), b);
    idx = (await kv.get([idxKey('example.com')]))[idxKey('example.com')] as { m: Record<string, string> };
    expect(idx).toBeUndefined();
  });

  it('removes a record with nothing in it', async () => {
    const kv = memoryKV();
    const id = identity();
    await createStore(kv).save(emptyRecord(id, 'T'), id);
    expect(await kv.keys('')).toEqual([]);
  });

  it('watches a record', async () => {
    const kv = memoryKV();
    const store = createStore(kv);
    const id = identity();
    const seen: (PageRecord | null)[] = [];
    const stop = store.watch(id.key, (r) => seen.push(r));
    await store.save(withNote(emptyRecord(id, 'T'), 'n1'), id);
    await tick();
    expect(seen.at(-1)?.notes.map((n) => n.id)).toEqual(['n1']);
    await store.remove(id.key);
    await tick();
    expect(seen.at(-1)).toBeNull();
    stop();
  });

  it('gets, removes and lists newest first', async () => {
    const kv = memoryKV();
    const store = createStore(kv);
    const a = identity();
    const b = identity({ key: 'https://example.com/b', url: 'https://example.com/b' });
    await store.save(withNote(emptyRecord(a, 'A'), 'n1', 100), a);
    await store.save(withNote(emptyRecord(b, 'B'), 'n2', 200), b);
    const list = await store.list();
    expect(list.map((p) => p.title)).toEqual(['B', 'A']);
    expect(list[1]).toMatchObject({ key: a.key, hash: hashKey(a.key), notes: 1, url: a.key, updatedAt: 100 });
    await store.remove(a.key);
    expect(await store.get(a.key)).toBeNull();
    expect(await store.load(a)).toBeNull();
    expect((await store.list()).map((p) => p.key)).toEqual([b.key]);
  });

  it('a note the merge left with no strokes is not counted, indexed, exported or moved', async () => {
    const kv = memoryKV();
    const store = createStore(kv);
    const a = identity();
    // Deleted at 200 on one device, edited at 250 with no new stroke on another.
    const dead = { ...emptyRecord(a, 'A'), deleted: [{ id: 'n', t: 200 }] };
    const late = {
      ...emptyRecord(a, 'A'),
      notes: [note({ id: 'n', updatedAt: 250, strokes: [stroke({ t: 100 })] })],
    };
    const saved = await store.save(merge(dead, late), a);
    expect(saved.notes.map((n) => [n.id, n.strokes.length])).toEqual([[laterId('n', 200), 0]]);
    expect(saved.notes.filter(showsInk)).toEqual([]);
    expect((await store.list())[0]).toMatchObject({ key: a.key, notes: 0 });
    expect((await kv.get([idxKey(a.host)]))[idxKey(a.host)]).toBeUndefined();
    expect(toMarkdown([saved])).toBe('# Notes\n');
    const b = identity({ key: 'https://example.com/b', url: 'https://example.com/b' });
    expect(await moveNotes(store, a.key, b)).toBeNull();
  });

  it('creates a device id once and keeps settings', async () => {
    const kv = memoryKV();
    const s1 = storeOver(kv);
    const c1 = await s1.config();
    expect(c1.device).toMatch(/^[0-9a-z]+$/);
    expect(c1).toMatchObject({ v: 1, off: [], theme: 'auto' });
    // The id is stored behind the caller. Calls of the same store run after that write.
    expect((await s1.config()).device).toBe(c1.device);
    await s1.idle();
    const c2 = await createStore(kv).config();
    expect(c2.device).toBe(c1.device);
    const c3 = await createStore(kv).setConfig({ off: ['x.com'], theme: 'dark' });
    expect(c3).toMatchObject({ device: c1.device, off: ['x.com'], theme: 'dark', penW: 2, thumbs: true });
    // Only the given fields are stored. Defaults stay implicit and are filled in on read.
    expect((await kv.get([CFG_KEY]))[CFG_KEY]).toEqual({
      v: 1,
      device: c1.device,
      off: ['x.com'],
      theme: 'dark',
    });
    await createStore(kv).setConfig({ theme: undefined, thumbs: false });
    expect((await kv.get([CFG_KEY]))[CFG_KEY]).toEqual({
      v: 1,
      device: c1.device,
      off: ['x.com'],
      thumbs: false,
    });
    expect((await createStore(kv).config()).theme).toBe('auto');
  });

  it('reads settings without waiting for the new device id to be stored, and loses no setting to that write', async () => {
    const inner = memoryKV();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let sets = 0;
    // The first write waits until the test lets it through, like a slow disk.
    const kv: KV = {
      ...inner,
      async set(items) {
        if (sets++ === 0) await held;
        return inner.set(items);
      },
    };
    const store = storeOver(kv);
    const c1 = await store.config();
    expect(c1.device).toMatch(/^[0-9a-z]+$/);
    expect((await inner.get([CFG_KEY]))[CFG_KEY]).toBeUndefined();
    // A setting changed meanwhile is written after the id, and keeps both.
    const changing = store.setConfig({ theme: 'dark' });
    release();
    const c2 = await changing;
    expect(c2).toMatchObject({ device: c1.device, theme: 'dark' });
    await store.idle();
    expect((await inner.get([CFG_KEY]))[CFG_KEY]).toEqual({ v: 1, device: c1.device, theme: 'dark' });
  });

  it('a device id another store has already stored is kept, and the store that lost uses it', async () => {
    const kv = memoryKV();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let gets = 0;
    // Store b reads at once, then its write's own check waits until a has stored its id.
    const kvB: KV = {
      ...kv,
      async get(keys) {
        if (gets++ === 1) await held;
        return kv.get(keys);
      },
    };
    const a = storeOver(kv);
    const b = storeOver(kvB);
    const [ca, cb] = await Promise.all([a.config(), b.config()]);
    expect(ca.device).not.toBe(cb.device);
    await a.idle();
    release();
    await settle(a, b);
    // The later write keeps the id that was already stored.
    expect((await kv.get([CFG_KEY]))[CFG_KEY]).toEqual({ v: 1, device: ca.device });
    expect((await b.config()).device).toBe(ca.device);
    expect((await b.setConfig({ theme: 'dark' })).device).toBe(ca.device);
    expect((await kv.get([CFG_KEY]))[CFG_KEY]).toEqual({ v: 1, device: ca.device, theme: 'dark' });
  });

  it('two stores whose device id writes cross end on one id', async () => {
    const kv = memoryKV();
    const a = storeOver(kv);
    const b = storeOver(kv);
    // Both check before either writes, as two tabs opened at the same moment.
    const [ca, cb] = await Promise.all([a.config(), b.config()]);
    await settle(a, b);
    const stored = ((await kv.get([CFG_KEY]))[CFG_KEY] as { device: string }).device;
    expect([ca.device, cb.device]).toContain(stored);
    expect((await a.config()).device).toBe(stored);
    expect((await b.config()).device).toBe(stored);
  });
});

/** Wraps a KV so every call waits a random short time, which shuffles concurrent calls. */
function jittery(kv: KV, seed: number): KV {
  const r = rng(seed);
  const wait = () => new Promise((res) => setTimeout(res, r.int(3)));
  return {
    get: async (k) => {
      await wait();
      return kv.get(k);
    },
    set: async (i) => {
      await wait();
      return kv.set(i);
    },
    remove: async (k) => {
      await wait();
      return kv.remove(k);
    },
    keys: async (p) => {
      await wait();
      return kv.keys(p);
    },
    onChange: kv.onChange?.bind(kv),
  };
}

describe('concurrent saves', () => {
  async function race(kvFor: (i: number) => KV, rounds: number) {
    const id = identity();
    const stores = [storeOver(kvFor(0)), storeOver(kvFor(1))];
    // Each writer only knows its own notes, like two tabs that have not seen each other yet.
    await Promise.all(
      stores.map(async (store, w) => {
        let rec = emptyRecord(id, 'T');
        for (let i = 0; i < rounds; i++) {
          rec = withNote(rec, `w${w}n${i}`, 1000 + i);
          void store.save(rec, id);
          if (i % 3 === 0) await tick();
        }
      }),
    );
    await settle(...stores);
    return stores;
  }

  it('never loses a stroke with interleaved saves', async () => {
    const kv = memoryKV();
    await race(() => kv, 20);
    const rec = (await kv.get([pageKeyOf(identity().key)]))[pageKeyOf(identity().key)] as PageRecord;
    expect(rec.notes).toHaveLength(40);
  });

  it('never loses a stroke when calls are shuffled in time', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const kv = memoryKV();
      await race((i) => jittery(kv, seed * 10 + i), 12);
      await new Promise((r) => setTimeout(r, 30));
      const key = pageKeyOf(identity().key);
      const rec = (await kv.get([key]))[key] as PageRecord;
      expect(rec.notes).toHaveLength(24);
      const idx = (await kv.get([idxKey('example.com')]))[idxKey('example.com')] as {
        m: Record<string, string>;
      };
      expect(idx.m[hashKey(identity().key)]).toBe(hashKey(identity().key));
    }
  });
});
