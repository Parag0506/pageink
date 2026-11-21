/**
 * The place in the background, with a real store, a folder in memory, and the cloud code
 * against the local fake: switching, copying, disconnecting, and the lock from start to end.
 */
import { createStore, memoryFolder, memoryKV, syncFolder } from 'pageink-core/store';
import type { FolderIO, Store } from 'pageink-core/types';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Fake } from '../../test/cloud-fake';
import { createCloud } from '../cloud';
import { fakeHosts } from '../cloud/hosts';
import { CloudError } from '../cloud/http';
import { envelopeOf } from '../lock/crypto';
import { LOCK_FILE } from '../lock/lock';
import { readStatus } from '../sync-status';
import { identity, note, record } from '../testing/records';
import { createPlace, LOCK_KEY, type Place, problemOf } from './place';
import { memorySecrets } from './secrets';
import { createSyncer, type Syncer } from './syncer';

const URL_A = 'https://a.test/one';
const URL_B = 'https://a.test/two';

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

interface Dev {
  a: ReturnType<typeof area>;
  secrets: ReturnType<typeof memorySecrets>;
  store: Store;
  folder: FolderIO;
  place: Place;
  syncer: Syncer;
}

/** One device: storage, store, a folder that is "chosen" once `folderOn` is set, and the cloud. */
function dev(folderOn = { on: false }): Dev {
  const a = area();
  const secrets = memorySecrets();
  const store = createStore(memoryKV());
  const folder = memoryFolder();
  let syncer: Syncer;
  const flow = async (url: string, interactive: boolean) => {
    const r = await fetch(url, { redirect: 'manual' });
    const to = r.headers.get('location');
    if (!to) throw new CloudError(interactive ? 'cancelled' : 'expired');
    return to;
  };
  const place = createPlace({
    area: a as never,
    secrets,
    store,
    kind: 'fs',
    openFolder: async () => (folderOn.on ? folder : 'none'),
    loadCloud: async () =>
      createCloud({
        storage: a as never,
        secrets,
        ids: { google: 'g', microsoft: 'm' },
        flow,
        redirect: 'https://x.chromiumapp.org/',
        hosts: fakeHosts(fake.base),
        net: { sleep: async () => {}, baseMs: 1 },
      }),
    syncer: () => syncer,
  });
  syncer = createSyncer({ store, open: place.open, sync: place.sync });
  return { a, secrets, store, folder, place, syncer };
}

const save = (s: Store, url: string, id: string, t = 1000) =>
  s.save(record(url, [note(id, 'words', t)], 'A page', t + 1000), identity(url));

describe('place', () => {
  test('nothing chosen: open says none, state says so', async () => {
    const d = dev();
    expect(await d.place.open()).toBe('none');
    expect((await d.place.handle({ ink: 'place' })).state).toMatchObject({ dest: null });
  });

  test('connect makes the cloud the place, syncs every page, and reports the account', async () => {
    const d = dev();
    await save(d.store, URL_A, 'n1');
    const r = await d.place.handle({ ink: 'connect', provider: 'google' });
    expect(r).toMatchObject({ ok: true, account: fake.account });
    expect(r.report?.pushed).toBe(1);
    expect(fake.drivePages()).toHaveLength(1);
    const st = (await d.place.handle({ ink: 'place' })).state!;
    expect(st).toMatchObject({
      dest: { kind: 'cloud', provider: 'google' },
      account: fake.account,
      lock: 'off',
    });
    expect(st.dest?.since).toBeUndefined();
  });

  test('the account name stays with the tokens: never in storage.local, gone after Disconnect', async () => {
    const d = dev();
    await d.place.handle({ ink: 'connect', provider: 'google' });
    // storage.local is readable by every content script. The name is not in any value there.
    expect(JSON.stringify([...d.a.data.entries()])).not.toContain(fake.account);
    expect(JSON.stringify(d.secrets.all.get('tok:google'))).toContain(fake.account);
    // The settings still show it, from the background's reply.
    expect((await d.place.handle({ ink: 'place' })).state?.account).toBe(fake.account);
    await d.place.handle({ ink: 'disconnect', removeFiles: false });
    expect(d.secrets.all.has('tok:google')).toBe(false);
    expect((await d.place.handle({ ink: 'place' })).state?.account).toBeUndefined();
    expect(JSON.stringify([...d.a.data.entries()])).not.toContain(fake.account);
  });

  test('OneDrive asks for no profile scope, so it connects without an account name', async () => {
    const d = dev();
    const r = await d.place.handle({ ink: 'connect', provider: 'onedrive' });
    expect(r).toMatchObject({ ok: true });
    expect(r.account).toBeUndefined();
  });

  test('a failed sign-in replies with the scrubbed details', async () => {
    const d = dev();
    fake.authError = { error: 'invalid_request', error_description: 'AADSTS50011: no match for a@b.cd' };
    const r = await d.place.handle({ ink: 'connect', provider: 'onedrive' });
    expect(r.problem).toBe('denied');
    expect(r.detail).toMatchObject({ provider: 'onedrive', step: 'authorize', error: 'invalid_request' });
    expect(r.detail?.description).toBe('AADSTS50011: no match for [email]');
  });

  test('a switch copies nothing old by itself; Copy my notes does', async () => {
    const on = { on: true };
    const d = dev(on);
    await save(d.store, URL_A, 'old', 1000);
    await d.place.handle({ ink: 'useFolder' });
    await d.syncer.full();
    expect(await d.folder.list('pages')).toHaveLength(1);
    // Switch from the folder to Google Drive.
    await new Promise((r) => setTimeout(r, 5));
    const r = await d.place.handle({ ink: 'connect', provider: 'google', switching: true });
    expect(r.ok).toBe(true);
    expect(fake.drivePages()).toHaveLength(0);
    // A new page goes to the new place.
    await save(d.store, URL_B, 'new', Date.now());
    await d.syncer.full();
    expect(fake.drivePages()).toHaveLength(1);
    // The reader asks for the rest.
    expect((await d.place.handle({ ink: 'copyAll' })).ok).toBe(true);
    expect(fake.drivePages()).toHaveLength(2);
    expect((await d.place.state()).dest?.since).toBeUndefined();
    // The folder was never touched.
    expect(await d.folder.list('pages')).toHaveLength(1);
  });

  test('switching between clouds signs out of the old one and keeps its files', async () => {
    const d = dev();
    await save(d.store, URL_A, 'n1');
    await d.place.handle({ ink: 'connect', provider: 'google' });
    await d.place.handle({ ink: 'connect', provider: 'onedrive', switching: true });
    expect(d.secrets.all.has('tok:google')).toBe(false);
    expect(d.secrets.all.has('tok:onedrive')).toBe(true);
    // Nothing secret in storage.local, which content scripts can read.
    expect([...d.a.data.keys()].filter((k) => k.startsWith('tok:') || k === LOCK_KEY)).toEqual([]);
    expect(fake.drivePages()).toHaveLength(1);
  });

  test('disconnect asks nothing of the files unless told; with a yes they go to the bin', async () => {
    const d = dev();
    await save(d.store, URL_A, 'n1');
    await d.place.handle({ ink: 'connect', provider: 'google' });
    expect((await d.place.handle({ ink: 'disconnect' })).ok).toBe(true);
    expect([...d.a.data.keys()].filter((k) => /^(tok|names|seen):|^dest$/.test(k))).toEqual([]);
    expect([...d.secrets.all.keys()]).toEqual([]);
    expect(fake.drivePages()).toHaveLength(1);
    await d.place.handle({ ink: 'connect', provider: 'google' });
    await d.place.handle({ ink: 'disconnect', removeFiles: true });
    expect(fake.drivePages()).toHaveLength(0);
    // The notes on this device stay.
    expect(await d.store.get(URL_A)).not.toBeNull();
  });

  test('a cancelled sign-in and an offline cloud come back as problems', async () => {
    const d = dev();
    fake.deny = true;
    expect(await d.place.handle({ ink: 'connect', provider: 'google' })).toMatchObject({ problem: 'denied' });
    fake.deny = false;
    await d.place.handle({ ink: 'connect', provider: 'google' });
    fake.offline = true;
    await save(d.store, URL_A, 'n1');
    const r = await d.syncer.full();
    expect(r.report?.errors.join()).toMatch(/offline/);
    expect((await readStatus(d.a as never)).problem).toBe('offline');
    fake.offline = false;
    await d.syncer.full();
    expect((await readStatus(d.a as never)).problem).toBeUndefined();
  });

  test('problemOf finds the plain problem in a report', () => {
    const rep = {
      pulled: 0,
      pushed: 0,
      merged: 0,
      conflictsFolded: 0,
      errors: ['pages: cannot list (expired)'],
    };
    expect(problemOf(rep)).toBe('expired');
    expect(problemOf({ ...rep, errors: ['x: bad thing'] })).toBeUndefined();
  });
});

describe('lock through the place', () => {
  test('on, a second device locked out until the password, recovery key, then off', async () => {
    const one = dev();
    await save(one.store, URL_A, 'n1');
    await one.place.handle({ ink: 'connect', provider: 'google' });
    expect(await one.place.handle({ ink: 'lock', op: 'on', password: 'short' })).toMatchObject({
      error: 'short',
    });
    expect(await one.place.handle({ ink: 'lock', op: 'on', password: 'a long password' })).toMatchObject({
      ok: true,
      lock: 'on',
    });
    expect(envelopeOf(fake.drivePages()[0]!.text)).not.toBeNull();
    expect((await one.place.state()).lock).toBe('on');
    const code = (await one.place.handle({ ink: 'lock', op: 'recovery' })).code!;
    expect(code).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);

    const two = dev();
    await save(two.store, URL_B, 'n2');
    // Connecting works; syncing waits for the password and writes nothing plain.
    expect(await two.place.handle({ ink: 'connect', provider: 'google' })).toMatchObject({
      ok: true,
      problem: 'locked',
    });
    expect(await two.place.open()).toBe('locked');
    expect((await two.place.state()).lock).toBe('needs-password');
    expect(fake.drivePages()).toHaveLength(1);
    expect(await two.place.handle({ ink: 'lock', op: 'unlock', password: 'wrong one' })).toMatchObject({
      error: 'wrong',
    });
    expect((await two.place.handle({ ink: 'lock', op: 'unlock', code })).ok).toBe(true);
    await two.syncer.full();
    expect(await two.store.get(URL_A)).not.toBeNull();
    expect(fake.drivePages()).toHaveLength(2);
    for (const f of fake.drivePages()) expect(envelopeOf(f.text)).not.toBeNull();

    // Off from the second device: every file plain again, the lock file gone, the key forgotten.
    expect(await two.place.handle({ ink: 'lock', op: 'off' })).toMatchObject({ ok: true, lock: 'off' });
    for (const f of fake.drivePages()) expect(envelopeOf(f.text)).toBeNull();
    expect([...fake.google.files.values()].some((f) => f.name === LOCK_FILE)).toBe(false);
    expect(two.secrets.all.has(LOCK_KEY)).toBe(false);
    // The first device still holds the key. It does not follow by itself: it stops, keeps its
    // notes, writes nothing, and asks.
    await new Promise((r) => setTimeout(r, 5));
    await save(one.store, URL_A, 'n3', 9000);
    const before = fake.drivePages().map((f) => f.text);
    expect((await one.syncer.full()).error).toBe('lock-changed');
    expect(fake.drivePages().map((f) => f.text)).toEqual(before);
    expect(one.secrets.all.has(LOCK_KEY)).toBe(true);
    expect(await one.place.state()).toMatchObject({ lock: 'changed', trouble: 'missing', canRestore: true });
    // The reader turns it off here on purpose; then it syncs plain.
    expect(await one.place.handle({ ink: 'lock', op: 'off' })).toMatchObject({ ok: true, lock: 'off' });
    expect((await one.syncer.full()).error).toBeUndefined();
    expect(one.secrets.all.has(LOCK_KEY)).toBe(false);
    for (const f of fake.drivePages()) expect(envelopeOf(f.text)).toBeNull();
  });

  test('a lock turned on halfway is finished by the next full sync', async () => {
    const d = dev({ on: true });
    await save(d.store, URL_A, 'n1');
    await save(d.store, URL_B, 'n2');
    await d.place.handle({ ink: 'useFolder' });
    await d.syncer.full();
    // Stop after the first sealed write.
    const real = d.folder.write;
    let n = 0;
    d.folder.write = async (name, text) => {
      if (name.startsWith('pages/') && ++n > 1) throw new Error('offline');
      return real(name, text);
    };
    expect(await d.place.handle({ ink: 'lock', op: 'on', password: 'a long password' })).toMatchObject({
      problem: 'offline',
    });
    d.folder.write = real;
    const texts = async () => Promise.all((await d.folder.list('pages')).map((f) => d.folder.read(f.name)));
    expect((await texts()).filter((t) => envelopeOf(t)).length).toBe(1);
    // A device with the key reads both kinds, and the next full sync seals the rest.
    await new Promise((r) => setTimeout(r, 5));
    await d.syncer.full();
    expect((await texts()).every((t) => envelopeOf(t))).toBe(true);
    expect(JSON.parse(await d.folder.read(LOCK_FILE)).state).toBe('on');
    // A plain sync with a store elsewhere sees only sealed files, which it cannot open.
    const other = createStore(memoryKV());
    const rep = await syncFolder(other, d.folder);
    expect(rep.pulled).toBe(0);
  });
});

/** A device on a folder with the lock on and two pages written. */
async function lockedFolderDevice() {
  const d = dev({ on: true });
  await save(d.store, URL_A, 'n1');
  await save(d.store, URL_B, 'n2');
  await d.place.handle({ ink: 'useFolder' });
  await d.syncer.full();
  expect(await d.place.handle({ ink: 'lock', op: 'on', password: 'a long password' })).toMatchObject({
    ok: true,
  });
  await new Promise((r) => setTimeout(r, 5));
  return d;
}

const snapshot = async (io: FolderIO) =>
  Object.fromEntries(
    await Promise.all(
      [...(await io.list('pages')), { name: LOCK_FILE }].map(async (f) => [
        f.name,
        await io.read(f.name).catch(() => null),
      ]),
    ),
  );

describe('the folder cannot turn the lock off', () => {
  test('a lock file set to turning-off by someone else stops sync; nothing is opened or written', async () => {
    const d = await lockedFolderDevice();
    const l = JSON.parse(await d.folder.read(LOCK_FILE));
    await d.folder.write(LOCK_FILE, JSON.stringify({ ...l, state: 'turning-off' }));
    const before = await snapshot(d.folder);
    await save(d.store, URL_A, 'n3', 9000);
    expect((await d.syncer.full()).error).toBe('lock-changed');
    await d.syncer.flush();
    expect(await snapshot(d.folder)).toEqual(before);
    expect(await d.place.state()).toMatchObject({ lock: 'changed', trouble: 'changed' });
    expect(d.secrets.all.has(LOCK_KEY)).toBe(true);
  });

  test('a removed lock file stops sync and nothing plain is written; the reader can put it back', async () => {
    const d = await lockedFolderDevice();
    await d.folder.remove!(LOCK_FILE);
    await save(d.store, URL_A, 'n3', 9000);
    expect((await d.syncer.full()).error).toBe('lock-changed');
    await d.syncer.flush();
    for (const f of await d.folder.list('pages'))
      expect(envelopeOf(await d.folder.read(f.name))).not.toBeNull();
    expect(await d.place.handle({ ink: 'lock', op: 'restore' })).toMatchObject({ ok: true, lock: 'on' });
    expect((await d.syncer.full()).error).toBeUndefined();
    expect(JSON.parse(await d.folder.read(LOCK_FILE))).toMatchObject({ v: 2, state: 'on' });
    for (const f of await d.folder.list('pages'))
      expect(envelopeOf(await d.folder.read(f.name))).not.toBeNull();
  });

  test('a plain record put in the folder while the lock is on is not merged, written over or removed', async () => {
    const d = await lockedFolderDevice();
    const name = (await d.folder.list('pages'))[0]!.name;
    const planted = `${JSON.stringify(record(URL_A, [note('planted', 'words', 5000)], 'A page', 6000), null, 2)}\n`;
    await d.folder.write(name, planted);
    const r = await d.syncer.full();
    expect(r.report?.refused).toEqual([name]);
    expect((await d.store.get(URL_A))?.notes.map((n) => n.id)).toEqual(['n1']);
    expect(await d.folder.read(name)).toBe(planted);
    expect((await d.place.state()).refused).toBe(1);
  });

  test('two pages whose files are swapped are both refused', async () => {
    const d = await lockedFolderDevice();
    const [a, b] = (await d.folder.list('pages')).map((f) => f.name);
    const ta = await d.folder.read(a!);
    const tb = await d.folder.read(b!);
    await d.folder.write(a!, tb);
    await d.folder.write(b!, ta);
    const r = await d.syncer.full();
    expect(r.report?.refused?.sort()).toEqual([a, b].sort());
    expect(r.report?.pulled).toBe(0);
  });
});
