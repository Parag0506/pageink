/**
 * Both providers against the local fakes (test/cloud-fake.ts): sign-in, paging, slow-down
 * answers, tokens that run out, conflicts, the name list, files removed elsewhere.
 */

import { createStore, memoryKV, syncFolder } from 'pageink-core/store';
import type { Store } from 'pageink-core/types';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Fake } from '../../test/cloud-fake';
import { memorySecrets } from '../background/secrets';
import { NAME } from '../brand';
import { cachedFolder, type Seen } from '../connect/cache';
import type { ProviderId } from '../connect/dest';
import { syncWithRetry } from '../connect/sync';
import { identity, note, record } from '../testing/records';
import { googleDrive, MULTIPART_MAX } from './google';
import { fakeHosts } from './hosts';
import { CloudError } from './http';
import { type Cloud, createCloud } from './index';

const REDIRECT = 'https://abcdefgh.chromiumapp.org/';
const URLS = Array.from({ length: 7 }, (_, i) => `https://a.test/page-${i}`);

/** A storage.local stand-in. */
function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of ks) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

let fake: Fake;
beforeEach(async () => {
  fake = await new Fake().start();
});
afterEach(() => fake.stop());

/** One device: its own storage, store and cloud, talking to the shared fake. */
function device(cancel = false) {
  const storage = area();
  const secrets = memorySecrets();
  const flow = async (url: string, interactive: boolean) => {
    if (cancel && interactive) throw new CloudError('cancelled');
    const r = await fetch(url, { redirect: 'manual' });
    const to = r.headers.get('location');
    if (!to) throw new CloudError(interactive ? 'cancelled' : 'expired');
    return to;
  };
  const cloud: Cloud = createCloud({
    storage: storage as never,
    secrets,
    ids: { google: 'g-id', microsoft: 'm-id' },
    flow,
    redirect: REDIRECT,
    hosts: fakeHosts(fake.base),
    net: { sleep: async () => {}, baseMs: 1 },
  });
  const store: Store = createStore(memoryKV());
  return { storage, secrets, cloud, store };
}

const write = (store: Store, url: string, id: string, t = 1000) =>
  store.save(record(url, [note(id, 'words', t)], 'A page', t + 1000), identity(url));

const ids = async (store: Store, url: string) => (await store.get(url))?.notes.map((n) => n.id).sort() ?? [];

const files = (p: ProviderId) => (p === 'google' ? fake.drivePages() : fake.msPages());

describe.each(['google', 'onedrive'] as const)('%s', (p) => {
  test('connect signs in, makes the folder, and two devices share notes through it', async () => {
    const a = device();
    // OneDrive asks for no profile scope, so it has no account name to show.
    expect(await a.cloud.connect(p)).toEqual({ account: p === 'google' ? fake.account : undefined });
    if (p === 'google') expect(fake.driveTop()?.name).toBe(NAME);
    for (const [i, u] of URLS.entries()) await write(a.store, u, `n${i}`);
    const rep = await syncFolder(a.store, a.cloud.open(p));
    expect(rep).toMatchObject({ pushed: 7, errors: [] });
    expect(files(p)).toHaveLength(7);

    const b = device();
    await b.cloud.connect(p);
    // Seven files, three to a page: the listing has to follow the pages.
    expect(await syncFolder(b.store, b.cloud.open(p))).toMatchObject({ pulled: 7, errors: [] });
    expect(await ids(b.store, URLS[6]!)).toEqual(['n6']);
  });

  test('slow-down answers are waited out', async () => {
    const a = device();
    await a.cloud.connect(p);
    await write(a.store, URLS[0]!, 'n0');
    fake.throttle = 3;
    expect(await syncFolder(a.store, a.cloud.open(p))).toMatchObject({ pushed: 1, errors: [] });
    expect(fake.throttle).toBe(0);
    // Past every try, the reader hears it.
    fake.throttle = 100;
    await write(a.store, URLS[1]!, 'n1');
    const rep = await syncFolder(a.store, a.cloud.open(p));
    expect(rep.errors.join()).toMatch(/throttled/);
  });

  test('an expired token is renewed without a window, and a lost session asks for sign-in', async () => {
    const a = device();
    await a.cloud.connect(p);
    await write(a.store, URLS[0]!, 'n0');
    fake.expireAccess();
    if (p === 'onedrive') fake.expireRefresh();
    expect(await syncFolder(a.store, a.cloud.open(p))).toMatchObject({ pushed: 1, errors: [] });
    fake.expireAccess();
    fake.expireRefresh();
    fake.session = false;
    await write(a.store, URLS[1]!, 'n1');
    const rep = await syncFolder(a.store, a.cloud.open(p));
    expect(rep.errors.join()).toMatch(/expired/);
  });

  test('a write that meets another device’s write reads, merges and writes again', async () => {
    const a = device();
    const b = device();
    await a.cloud.connect(p);
    await b.cloud.connect(p);
    await write(a.store, URLS[0]!, 'from-a', 1000);
    await syncFolder(a.store, a.cloud.open(p));
    await syncFolder(b.store, b.cloud.open(p));
    // Both change the page. B writes first; A's listing still holds the old version.
    const ioA = a.cloud.open(p);
    await ioA.list('pages');
    await write(b.store, URLS[0]!, 'from-b', 3000);
    await syncFolder(b.store, b.cloud.open(p));
    await write(a.store, URLS[0]!, 'from-a2', 4000);
    const first = await syncFolder(a.store, ioA, { only: [URLS[0]!] });
    // The cheap check already saw B's write, or the write was refused. Either way, nothing is lost.
    const rep = first.errors.length ? await syncWithRetry(a.store, a.cloud.open(p)) : first;
    expect(rep.errors).toEqual([]);
    await syncFolder(b.store, b.cloud.open(p));
    for (const s of [a.store, b.store])
      expect(await ids(s, URLS[0]!)).toEqual(['from-a', 'from-a2', 'from-b']);
    expect(files(p)).toHaveLength(1);
  });

  test('a stale listing is refused on write, and the retry merges', async () => {
    const a = device();
    const b = device();
    await a.cloud.connect(p);
    await b.cloud.connect(p);
    await write(a.store, URLS[0]!, 'from-a', 1000);
    await syncFolder(a.store, a.cloud.open(p));
    await syncFolder(b.store, b.cloud.open(p));
    const io = a.cloud.open(p);
    // A has read the file, then B writes, then A writes from what it read.
    await io.list('pages');
    const name = (await io.list('pages'))[0]!.name;
    const text = await io.read(name);
    await write(b.store, URLS[0]!, 'from-b', 3000);
    await syncFolder(b.store, b.cloud.open(p));
    await expect(io.write(name, text)).rejects.toMatchObject({ code: 'conflict' });
    expect(io.takeConflicts()).toBe(1);
    expect(await syncWithRetry(a.store, a.cloud.open(p))).toMatchObject({ errors: [] });
    expect(await ids(a.store, URLS[0]!)).toEqual(['from-a', 'from-b']);
  });

  test('the name list survives in storage, is brought up to date cheaply, and is rebuilt when lost', async () => {
    const a = device();
    await a.cloud.connect(p);
    for (const u of URLS.slice(0, 4)) await write(a.store, u, `x${u.length}`);
    await syncFolder(a.store, a.cloud.open(p));
    fake.log = [];
    // A new run lists nothing in full: the change check is enough.
    await a.cloud.open(p).list('pages');
    const full = fake.log.filter(
      (h) => /\/children$/.test(h.path) || (/\/files$/.test(h.path) && !/modifiedTime/.test(h.search)),
    );
    expect(full).toEqual([]);
    // Losing it costs one full listing.
    a.storage.data.delete(`names:${p}`);
    expect(await a.cloud.open(p).list('pages')).toHaveLength(4);
  });

  test('a change made elsewhere is seen by the change check', async () => {
    const a = device();
    const b = device();
    await a.cloud.connect(p);
    await b.cloud.connect(p);
    await write(a.store, URLS[0]!, 'n0');
    await syncFolder(a.store, a.cloud.open(p));
    await syncFolder(b.store, b.cloud.open(p));
    await write(b.store, URLS[1]!, 'n1');
    await syncFolder(b.store, b.cloud.open(p));
    expect(await syncFolder(a.store, a.cloud.open(p))).toMatchObject({ pulled: 1 });
    expect(await ids(a.store, URLS[1]!)).toEqual(['n1']);
  });

  test('a file removed elsewhere is written again from this device', async () => {
    const a = device();
    await a.cloud.connect(p);
    await write(a.store, URLS[0]!, 'n0');
    await syncFolder(a.store, a.cloud.open(p));
    fake.remove(files(p)[0]!.id);
    await write(a.store, URLS[0]!, 'n1', 5000);
    let rep = await syncWithRetry(a.store, a.cloud.open(p));
    if (rep.errors.length) rep = await syncWithRetry(a.store, a.cloud.open(p));
    expect(rep.errors).toEqual([]);
    expect(files(p)).toHaveLength(1);
    expect(
      JSON.parse(files(p)[0]!.text)
        .notes.map((n: { id: string }) => n.id)
        .sort(),
    ).toEqual(['n0', 'n1']);
  });

  test('a full storage says so', async () => {
    const a = device();
    await a.cloud.connect(p);
    await write(a.store, URLS[0]!, 'n0');
    fake.full = true;
    expect((await syncFolder(a.store, a.cloud.open(p))).errors.join()).toMatch(/full/);
  });

  test('a closed sign-in window and a refusal are told apart', async () => {
    await expect(device(true).cloud.connect(p)).rejects.toMatchObject({ code: 'cancelled' });
    fake.deny = true;
    await expect(device().cloud.connect(p)).rejects.toMatchObject({ code: 'denied' });
  });

  test('disconnect removes the tokens and keeps the files unless told', async () => {
    const a = device();
    await a.cloud.connect(p);
    await write(a.store, URLS[0]!, 'n0');
    await syncFolder(a.store, a.cloud.open(p));
    await a.cloud.disconnect(p, false);
    expect([...a.storage.data.keys()].filter((k) => k.startsWith('tok:') || k.startsWith('names:'))).toEqual(
      [],
    );
    expect([...a.secrets.all.keys()]).toEqual([]);
    expect(files(p)).toHaveLength(1);
    if (p === 'google') expect(fake.google.revoked).toHaveLength(1);

    const b = device();
    await b.cloud.connect(p);
    await b.cloud.disconnect(p, true);
    expect(files(p)).toHaveLength(0);
  });

  test('tokens are kept in the secret store, never in storage.local', async () => {
    const a = device();
    await a.cloud.connect(p);
    expect([...a.secrets.all.keys()]).toEqual([`tok:${p}`]);
    expect([...a.storage.data.keys()].filter((k) => k.startsWith('tok:'))).toEqual([]);
  });

  test('unchanged files are not downloaded again', async () => {
    const a = device();
    await a.cloud.connect(p);
    for (const u of URLS.slice(0, 3)) await write(a.store, u, `n${u.length}`);
    let seen: Record<string, Seen> = {};
    const seenStore = {
      get: async () => seen,
      set: async (s: Record<string, Seen>) => {
        seen = s;
      },
    };
    const run = async () => {
      const io = cachedFolder(a.cloud.open(p), a.store, seenStore);
      const rep = await syncFolder(a.store, io);
      await io.save();
      return rep;
    };
    await run();
    fake.log = [];
    expect(await run()).toMatchObject({ pushed: 0, pulled: 0, errors: [] });
    const downloads = fake.log.filter((h) => /alt=media|\/content$|msfiles/.test(h.path));
    expect(downloads).toEqual([]);
  });
});

describe('google only', () => {
  test('disconnect renews a token that ran out, then gives it back', async () => {
    const a = device();
    await a.cloud.connect('google');
    const t = a.secrets.all.get('tok:google') as { access: string; exp: number };
    a.secrets.all.set('tok:google', { ...t, exp: Date.now() - 1000 });
    await a.cloud.disconnect('google', false);
    expect(fake.google.revoked).toHaveLength(1);
    expect(fake.google.revoked[0]).not.toBe(t.access);
    expect(a.secrets.all.size).toBe(0);
  });

  test('two files with one name are folded into one', async () => {
    const a = device();
    await a.cloud.connect('google');
    await write(a.store, URLS[0]!, 'n0');
    await syncFolder(a.store, a.cloud.open('google'));
    const [first] = fake.drivePages();
    const other = record(URLS[0]!, [note('elsewhere', 'words', 2000)], 'A page', 3000);
    fake.driveWrite(first!.name, `${JSON.stringify(other, null, 2)}\n`);
    const rep = await syncFolder(a.store, a.cloud.open('google'));
    expect(rep).toMatchObject({ conflictsFolded: 1, errors: [] });
    expect(fake.drivePages()).toHaveLength(1);
    expect(await ids(a.store, URLS[0]!)).toEqual(['elsewhere', 'n0']);
  });

  test('large files go up in a resumable upload', async () => {
    const storage = area();
    const flow = async (url: string) => (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
    const g = googleDrive({
      hosts: fakeHosts(fake.base).google,
      clientId: 'g',
      redirect: REDIRECT,
      flow,
      tokens: {
        get: async () => (storage.data.get('t') as never) ?? null,
        set: async (t) => void storage.data.set('t', t),
        remove: async () => {},
      },
    });
    await g.signIn();
    const { pages } = await g.folders();
    const big = `"${'x'.repeat(MULTIPART_MAX + 10)}"`;
    const f = await g.create(pages, 'big.ink.json', big);
    expect(fake.log.some((h) => h.path.includes('/session/'))).toBe(true);
    expect(await g.download(f)).toBe(big);
  });
});
