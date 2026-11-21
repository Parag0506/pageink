/**
 * Store guards from the security review: records never cross pages, data from storage,
 * folders and archives is checked deeply, deletions stick, and archives cannot explode.
 */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { hashKey, idxKey } from '../hash';
import type { InkConfig, PageRecord } from '../types';
import { memoryFolder, memoryKV } from './memory';
import { laterId } from './merge';
import { erasePage, moveNotes } from './ops';
import { applyPatch, emptyRecord, erasePatch } from './patch';
import { acceptRecord, createStore, slotKeys, storeOver } from './store';
import { importArchive, recordText, syncFolder, unpack } from './sync';
import { identity, note, record, stroke } from './testkit';
import { cleanConfig, cleanRecord, recordProblem, safeParse } from './validate';

/**
 * Two addresses whose 53-bit storage hashes are equal. Finding the pair took two minutes on a
 * laptop with a cycle search, which is why every read checks the key.
 */
const A = 'https://bank.example/167hhoa2o2l';
const B = 'https://bank.example/ajyn10jbi1';
const victim = identity({ key: A, url: A, host: 'bank.example', hosts: ['bank.example'] });
const attacker = identity({ key: B, url: B, host: 'bank.example', hosts: ['bank.example'] });
const [main] = slotKeys(victim.key) as [string];

function withNote(rec: PageRecord, id: string, t = 1000): PageRecord {
  return applyPatch(rec, { add: [note({ id, strokes: [stroke({ id: `${id}s`, t })] })] }, t);
}

describe('records never cross pages', () => {
  it('the two test addresses really collide', () => {
    expect(hashKey(A)).toBe(hashKey(B));
    expect(A).not.toBe(B);
  });

  it('a record in the slot of another key is not returned by load, get or watch', async () => {
    const kv = memoryKV();
    // The attacker's record sits in the victim's main slot, as a hash collision would put it.
    await kv.set({ [main]: withNote(emptyRecord(attacker, 'Evil'), 'bad') });
    // And the site index points the victim's address at it.
    await kv.set({ [idxKey('bank.example')]: { v: 1, m: { [hashKey(victim.key)]: main.slice(2) } } });
    const store = createStore(kv);
    expect(await store.load(victim)).toBeNull();
    expect(await store.get(victim.key)).toBeNull();
    const seen: unknown[] = [];
    store.watch(victim.key, (r) => seen.push(r));
    await kv.set({ [main]: withNote(emptyRecord(attacker, 'Evil'), 'bad2') });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
  });

  it('saving into a slot held by another key uses an overflow slot, and the index points at it', async () => {
    const kv = memoryKV();
    await createStore(kv).save(withNote(emptyRecord(attacker, 'Evil'), 'bad'), attacker);
    const store = createStore(kv);
    const alias = 'https://bank.example/statement';
    const saved = await store.save(withNote(emptyRecord(victim, 'Mine'), 'good'), {
      ...victim,
      aliases: [alias],
    });
    expect(saved.notes.map((n) => n.id)).toEqual(['good']);
    const over = `${main}.1`;
    expect(((await kv.get([over]))[over] as PageRecord).key).toBe(victim.key);
    expect(((await kv.get([main]))[main] as PageRecord).key).toBe(attacker.key);
    const idx = (await kv.get([idxKey('bank.example')]))[idxKey('bank.example')] as {
      m: Record<string, string>;
    };
    // The index points every other address of the page at its exact slot. The shared hash
    // stays with the first page that claimed it; the second is found by its key.
    expect(idx.m[hashKey(alias)]).toBe(over.slice(2));
    expect(idx.m[hashKey(victim.key)]).toBe(main.slice(2));
    // Each page sees only its own notes.
    expect((await store.load(victim))?.notes.map((n) => n.id)).toEqual(['good']);
    expect((await store.get(attacker.key))?.notes.map((n) => n.id)).toEqual(['bad']);
    expect((await store.get(victim.key))?.notes.map((n) => n.id)).toEqual(['good']);
    // A fresh store, which knows nothing, finds both the same way.
    const fresh = createStore(kv);
    expect((await fresh.load(attacker))?.key).toBe(attacker.key);
    expect((await fresh.load(victim))?.key).toBe(victim.key);
    expect((await fresh.list()).map((p) => p.key).sort()).toEqual([attacker.key, victim.key].sort());
  });

  it('an emptied main slot takes the overflow record back', async () => {
    const kv = memoryKV();
    const store = createStore(kv);
    await store.save(withNote(emptyRecord(attacker, 'Evil'), 'bad'), attacker);
    await store.save(withNote(emptyRecord(victim, 'Mine'), 'good'), victim);
    await store.remove(attacker.key);
    expect(((await kv.get([main]))[main] as PageRecord).key).toBe(victim.key);
    expect(await kv.keys(`${main}.`)).toEqual([]);
    expect((await createStore(kv).load(victim))?.notes).toHaveLength(1);
  });

  it('acceptRecord takes only a clean record of this page or its aliases', () => {
    const rec = withNote(emptyRecord(victim, 'Mine'), 'n');
    expect(acceptRecord(rec, victim)?.key).toBe(victim.key);
    expect(acceptRecord(rec, attacker)).toBeNull();
    expect(acceptRecord(rec, identity({ key: 'https://x.example/', aliases: [victim.key] }))?.key).toBe(
      victim.key,
    );
    expect(acceptRecord({ ...rec, v: 2 }, victim)).toBeNull();
    expect(acceptRecord(undefined, victim)).toBeNull();
    const bad = { ...rec, notes: [...rec.notes, { id: '<script>', strokes: 'x' }] };
    expect(acceptRecord(bad, victim)?.notes.map((n) => n.id)).toEqual(['n']);
  });
});

describe('deep checks', () => {
  const good = () => withNote(emptyRecord(victim, 'T'), 'n1');
  const withBad = (patch: Record<string, unknown>, where: 'note' | 'stroke' | 'anchor' = 'note') => {
    const r = structuredClone(good()) as unknown as {
      notes: Record<string, unknown>[];
    };
    const n = r.notes[0]!;
    if (where === 'note') Object.assign(n, patch);
    if (where === 'stroke') Object.assign((n.strokes as Record<string, unknown>[])[0]!, patch);
    if (where === 'anchor') Object.assign(n.anchor as object, patch);
    return r;
  };

  it('keeps a good record whole and copies only known fields', () => {
    const g = good();
    const c = cleanRecord({ ...g, extra: 1 });
    expect(c.dropped).toEqual([]);
    expect(c.rec).toEqual(g);
    expect(c.rec).not.toHaveProperty('extra');
  });

  it.each([
    ['an id with markup', { id: '<img onerror=x>' }, 'note'],
    ['a time that is not finite', { updatedAt: Number.POSITIVE_INFINITY }, 'note'],
    ['a kind it does not know', { kind: 'script' }, 'note'],
    ['a path with other commands', { d: 'M0 0A1 1 0 0 1 2 2' }, 'stroke'],
    ['a path with markup', { d: 'M0 0"/><script>' }, 'stroke'],
    ['points that are not integer triples', { pts: [1, 2] }, 'stroke'],
    ['points with fractions', { pts: [1.5, 2, 3] }, 'stroke'],
    ['a colour that is not a name or hex', { color: 'red;background:url(x)' }, 'stroke'],
    ['a width out of range', { w: 1e9 }, 'stroke'],
    ['an anchor type it does not know', { type: 'eval' }, 'anchor'],
    [
      'a quote that is far too long',
      { quote: { exact: 'x'.repeat(5000), prefix: '', suffix: '' } },
      'anchor',
    ],
    ['a position that is negative', { pos: { start: -1, end: 2 } }, 'anchor'],
  ] as const)('drops a note with %s, alone', (_name, patch, where) => {
    const r = withBad(patch, where) as unknown as { notes: unknown[] };
    r.notes.push(good().notes[0]!);
    (r.notes[1] as { id: string }).id = 'n2';
    const c = cleanRecord(r);
    expect(c.rec?.notes.map((n) => n.id)).toEqual(['n2']);
    expect(c.dropped).toHaveLength(1);
  });

  it('keeps a note with a bad picture but leaves the picture out', () => {
    for (const thumb of [
      'javascript:alert(1)',
      'data:text/html;base64,AAAA',
      `data:image/png;base64,${'A'.repeat(9000)}`,
    ]) {
      const c = cleanRecord(withBad({ thumb }));
      expect(c.rec?.notes).toHaveLength(1);
      expect(c.rec?.notes[0]).not.toHaveProperty('thumb');
    }
    const ok = 'data:image/jpeg;base64,AAAA';
    expect(cleanRecord(withBad({ thumb: ok })).rec?.notes[0]?.thumb).toBe(ok);
  });

  it('refuses a record whose own fields are bad, or that is far too large', () => {
    expect(recordProblem({ ...good(), key: 5 })).toBeTruthy();
    expect(recordProblem({ ...good(), urls: 'x' })).toBeTruthy();
    expect(recordProblem({ ...good(), v: 2 })).toMatch(/version/);
    expect(recordProblem({ ...good(), notes: Array.from({ length: 5001 }, () => ({})) })).toBe('too large');
    const many = good();
    many.notes[0]!.strokes = Array.from({ length: 5001 }, (_, i) => stroke({ id: `s${i}` }));
    expect(cleanRecord(many).rec?.notes).toEqual([]);
  });

  it('parses JSON without keys that reach a prototype', () => {
    const v = safeParse(
      '{"__proto__":{"polluted":1},"a":{"constructor":{"prototype":{"x":1}}},"b":2}',
    ) as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['a', 'b']);
    expect(v.a).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const g = good();
    const text = JSON.stringify(g).replace('{"v":1', '{"__proto__":{"isAdmin":true},"v":1');
    expect(text).toContain('__proto__');
    expect(cleanRecord(safeParse(text)).rec).toEqual(g);
  });

  it('checks settings field by field', () => {
    const cfg = {
      theme: 'dark',
      penW: 'x',
      off: ['a.com', 5],
      drawOn: ['b.com'],
      barHideMs: Number.NaN,
      thumbs: false,
    };
    expect(cleanConfig(cfg)).toEqual({ theme: 'dark', drawOn: ['b.com'], thumbs: false });
    expect(cleanConfig(null)).toEqual({});
  });

  it('keeps every settings field the code writes', () => {
    const full: Required<Omit<InkConfig, 'v'>> = {
      device: 'd1',
      off: ['a.com'],
      modifier: 'Meta',
      penReady: true,
      hinted: true,
      barHideMs: 0,
      penW: 3,
      hiW: 12,
      theme: 'light',
      folder: 'Ink',
      lastSync: 1,
      pdf: false,
      rememberDraw: false,
      drawOn: ['b.com'],
      penNeedsToggle: true,
      thumbs: false,
      privateKeep: true,
    };
    expect(cleanConfig(full)).toEqual(full);
  });

  it('a stored note it cannot read is reported once and the record is not overwritten', async () => {
    const kv = memoryKV();
    const bad = withBad({ kind: 'nope' });
    await kv.set({ [main]: bad });
    const told: string[] = [];
    const store = storeOver(kv, { onBadRecord: (_k, p) => told.push(p) });
    expect((await store.load(victim))?.notes).toEqual([]);
    expect((await store.load(victim))?.notes).toEqual([]);
    expect(told).toHaveLength(1);
    await expect(store.save(withNote(emptyRecord(victim, 'T'), 'n9'), victim)).rejects.toThrow(
      /cannot be read/,
    );
    expect((await kv.get([main]))[main]).toEqual(bad);
  });
});

describe('folder and archive', () => {
  it('a file with a bad note is read, reported once and never written over', async () => {
    const store = createStore(memoryKV());
    const r = structuredClone(withNote(emptyRecord(victim, 'T'), 'n1')) as unknown as { notes: object[] };
    r.notes.push({ id: 'n2', kind: 'evil' });
    const name = `pages/${hashKey(victim.key)}.ink.json`;
    const text = JSON.stringify(r);
    const io = memoryFolder({ [name]: text });
    const rep = await syncFolder(store, io);
    expect(rep.errors).toHaveLength(1);
    expect(rep.errors[0]).toContain(name);
    expect((await store.get(victim.key))?.notes.map((n) => n.id)).toEqual(['n1']);
    expect(await io.read(name)).toBe(text);
    // The good notes still reach the folder, in a file of their own.
    expect((await io.list('pages')).map((f) => f.name)).toContain(`pages/${hashKey(victim.key)}.1.ink.json`);
  });

  it('two keys with one hash get two files, and each comes back to its own page', async () => {
    // Another device wrote the attacker's page first, under the shared hash.
    const io = memoryFolder({
      [`pages/${hashKey(B)}.ink.json`]: recordText(withNote(emptyRecord(attacker, 'E'), 'bad')),
    });
    const store = createStore(memoryKV());
    await store.save(withNote(emptyRecord(victim, 'V'), 'good'), victim);
    await syncFolder(store, io);
    const names = (await io.list('pages')).map((f) => f.name);
    expect(names).toEqual([
      `pages/${hashKey(victim.key)}.1.ink.json`,
      `pages/${hashKey(victim.key)}.ink.json`,
    ]);
    const other = createStore(memoryKV());
    await syncFolder(other, io);
    expect((await other.load(victim))?.notes.map((n) => n.id)).toEqual(['good']);
    expect((await other.get(attacker.key))?.notes.map((n) => n.id)).toEqual(['bad']);
  });

  it('stops a zip bomb while unpacking', () => {
    const zeros = new Uint8Array(40 * 1024 * 1024);
    const zip = zipSync({ 'pages/a.ink.json': zeros }, { level: 9 });
    expect(zip.length).toBeLessThan(200_000);
    expect(() => unpack(zip)).toThrow(/larger than/);
    const small = { archive: 1e6, total: 2000, file: 1500, files: 3, name: 255 };
    const two = zipSync({
      'pages/a.ink.json': new Uint8Array(1000),
      'pages/b.ink.json': new Uint8Array(1001),
    });
    expect(() => unpack(two, small)).toThrow(/unpacks to more than/);
    const many = zipSync(Object.fromEntries([1, 2, 3, 4].map((i) => [`x${i}.txt`, new Uint8Array(1)])));
    expect(() => unpack(many, small)).toThrow(/more than 3 files/);
    expect(() => unpack(new Uint8Array(2e6), small)).toThrow(/larger than/);
  });

  it('reads only plain names under pages/', async () => {
    const rec = recordText(withNote(emptyRecord(victim, 'T'), 'n1'));
    const zip = zipSync({
      'pages/../evil.ink.json': strToU8(rec),
      '/pages/a.ink.json': strToU8(rec),
      'pages/sub/a.ink.json': strToU8(rec),
      'pages\\a.ink.json': strToU8(rec),
      'other/a.ink.json': strToU8(rec),
    });
    expect([...unpack(zip).keys()]).toEqual([]);
    const store = createStore(memoryKV());
    expect(await importArchive(store, zip)).toMatchObject({ pulled: 0, errors: [] });
  });
});

describe('deleting for good', () => {
  it('erasePage writes tombstones for every note and stroke, so a sync cannot bring them back', async () => {
    const store = createStore(memoryKV());
    const io = memoryFolder();
    const rec = withNote(withNote(emptyRecord(victim, 'T'), 'a'), 'b');
    await store.save(rec, victim);
    await syncFolder(store, io);
    const out = await erasePage(store, victim.key, undefined, 5000);
    expect(out?.notes).toEqual([]);
    expect(out?.deleted.map((d) => d.id).sort()).toEqual(['a', 'as', 'b', 'bs']);
    // The old file still holds the notes. Syncing does not bring them back.
    await syncFolder(store, io);
    expect((await store.get(victim.key))?.notes).toEqual([]);
    expect((await store.list()).find((p) => p.key === victim.key)?.notes).toBe(0);
    const again = createStore(memoryKV());
    await syncFolder(again, io);
    expect((await again.get(victim.key))?.notes).toEqual([]);
  });

  it('erasePatch can clear some notes only', () => {
    const rec = withNote(withNote(emptyRecord(victim, 'T'), 'a'), 'b');
    expect(erasePatch(rec, (n) => n.id === 'a')).toEqual({ del: ['a', 'as'] });
  });

  it('moveNotes copies notes to the new address under new ids and erases the old page', async () => {
    const store = createStore(memoryKV());
    const old = identity({ key: 'https://news.example/2024/story', url: 'https://news.example/2024/story' });
    const next = identity({ key: 'https://news.example/story', url: 'https://news.example/story' });
    await store.save(withNote(emptyRecord(old, 'Story'), 'n1'), old);
    const moved = await moveNotes(store, old.key, next, 9000);
    expect(moved?.notes).toHaveLength(1);
    expect(moved!.notes[0]!.id).not.toBe('n1');
    expect(moved!.notes[0]!.strokes[0]!.id).not.toBe('n1s');
    expect(moved!.notes[0]!.anchor).toEqual(note().anchor);
    expect((await store.load(next))?.notes).toHaveLength(1);
    expect((await store.get(old.key))?.notes).toEqual([]);
    expect(await moveNotes(store, old.key, next)).toBeNull();
  });

  it('a stroke added offline after the page was erased survives as a new note', async () => {
    const store = createStore(memoryKV());
    const rec = withNote(emptyRecord(victim, 'T'), 'a', 1000);
    await store.save(rec, victim);
    const offline = applyPatch(
      rec,
      { addStrokes: [{ note: 'a', strokes: [stroke({ id: 'late', t: 9000 })] }] },
      9000,
    );
    await erasePage(store, victim.key, undefined, 5000);
    const out = await store.save(offline, victim);
    expect(out.notes.map((n) => [n.id, n.strokes.map((s) => s.id)])).toEqual([
      [laterId('a', 5000), ['late']],
    ]);
    expect(record().v).toBe(1);
  });
});
