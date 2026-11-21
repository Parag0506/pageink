import { hashKey, pageKeyOf } from 'pageink-core/hash';
import { createStore, memoryFolder, memoryKV, syncFolder } from 'pageink-core/store';
import type { FolderIO } from 'pageink-core/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SyncStatus } from '../sync-status';
import { identity, note, record } from '../testing/records';
import { createSyncer, type OpenFolder } from './syncer';

const URL_A = 'https://a.test/one';
const URL_B = 'https://a.test/two';

function setup(open?: OpenFolder, at = { now: 42 }) {
  const store = createStore(memoryKV());
  const io = memoryFolder();
  const sync = vi.fn(syncFolder);
  const status: SyncStatus[] = [];
  const access: string[] = [];
  const syncer = createSyncer({
    store,
    open: open ?? (async () => io),
    sync,
    status: async (st) => void status.push(st),
    lastFull: async () => status.findLast((x) => x.lastFull)?.lastFull,
    onAccess: (a) => void access.push(a),
    debounceMs: 100,
    freshMs: 1000,
    now: () => at.now,
  });
  const change = async (url: string) => {
    const rec = await store.get(url);
    syncer.changed({ [pageKeyOf(url)]: { newValue: rec } });
  };
  return { store, io, sync, syncer, change, status, access, at };
}

const names = async (io: FolderIO) => (await io.list('pages')).map((f) => f.name);

describe('syncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('pushes only the changed page after the pause', async () => {
    const s = setup();
    await s.store.save(record(URL_A, [note('n1')]), identity(URL_A));
    await s.store.save(record(URL_B, [note('n2')]), identity(URL_B));
    await s.change(URL_A);
    await s.change(URL_A);
    expect(s.sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(s.sync).toHaveBeenCalledTimes(1);
    expect(s.sync.mock.calls[0]![2]).toEqual({ only: [URL_A] });
    expect(await names(s.io)).toHaveLength(1);
    expect(s.status).toEqual([{ lastSync: 42 }]);
    expect(s.access).toEqual(['ok']);
    // Settings are never rewritten by sync.
    expect((await s.store.config()).lastSync).toBeUndefined();
  });

  test('a change it caused itself does not push again', async () => {
    const s = setup();
    await s.store.save(record(URL_A, [note('n1')]), identity(URL_A));
    await s.change(URL_A);
    await vi.advanceTimersByTimeAsync(150);
    await s.change(URL_A);
    await vi.advanceTimersByTimeAsync(150);
    expect(s.sync).toHaveBeenCalledTimes(1);
  });

  test('ignores keys that are not pages', async () => {
    const s = setup();
    s.syncer.changed({ cfg: { newValue: {} }, 'idx:x': { newValue: {} } });
    await vi.advanceTimersByTimeAsync(150);
    expect(s.sync).not.toHaveBeenCalled();
  });

  test('a removed page removes its file', async () => {
    const s = setup();
    await s.store.save(record(URL_A, [note('n1')]), identity(URL_A));
    await s.syncer.full();
    expect(await names(s.io)).toHaveLength(1);
    const pk = pageKeyOf(URL_A);
    // A removal that names another page leaves the file alone.
    s.syncer.changed({ [pk]: { oldValue: { key: URL_B }, newValue: undefined } });
    await vi.advanceTimersByTimeAsync(150);
    expect(await names(s.io)).toHaveLength(1);
    s.syncer.changed({ [pk]: { oldValue: { key: URL_A }, newValue: undefined } });
    await vi.advanceTimersByTimeAsync(150);
    expect(await names(s.io)).toEqual([]);
  });

  test('full sync is two-way', async () => {
    const s = setup();
    await s.store.save(record(URL_A, [note('n1')]), identity(URL_A));
    const other = createStore(memoryKV());
    await other.save(record(URL_B, [note('n2')]), identity(URL_B));
    await syncFolder(other, s.io);
    const r = await s.syncer.full();
    expect(r.error).toBeUndefined();
    expect(r.report).toBeDefined();
    expect(await s.store.get(URL_B)).not.toBeNull();
    expect(await names(s.io)).toHaveLength(2);
  });

  test('without a folder or access, full sync says why and push does nothing', async () => {
    for (const why of ['none', 'permission'] as const) {
      const s = setup(async () => why);
      await s.store.save(record(URL_A, [note('n1')]), identity(URL_A));
      expect(await s.syncer.full()).toEqual({ error: why });
      await s.change(URL_A);
      await vi.advanceTimersByTimeAsync(150);
      expect(s.sync).not.toHaveBeenCalled();
    }
  });

  test('flush runs pending pushes at once', async () => {
    const s = setup();
    await s.store.save(record(URL_A, [note('n1')]), identity(URL_A));
    await s.change(URL_A);
    await s.syncer.flush();
    expect(s.sync).toHaveBeenCalledTimes(1);
  });

  test('a failing sync is reported, not thrown', async () => {
    const s = setup();
    s.sync.mockRejectedValueOnce(new Error('disk full'));
    expect((await s.syncer.full()).error).toContain('disk full');
    expect(s.status.at(-1)?.error).toContain('disk full');
  });
});

describe('pulling', () => {
  test('pull reads only the page’s own file and brings in another device’s notes', async () => {
    const s = setup();
    const other = createStore(memoryKV());
    await other.save(record(URL_A, [note('n1')]), identity(URL_A));
    await other.save(record(URL_B, [note('n2')]), identity(URL_B));
    await syncFolder(other, s.io);
    const read = vi.spyOn(s.io, 'read');
    const list = vi.spyOn(s.io, 'list');
    const r = await s.syncer.pull(URL_A);
    expect(r.report?.pulled).toBe(1);
    expect(list).not.toHaveBeenCalled();
    expect(read.mock.calls.map((c) => c[0])).toEqual([
      `pages/${hashKey(URL_A)}.ink.json`,
      `pages/${hashKey(URL_A)}.1.ink.json`,
    ]);
    expect((await s.store.get(URL_A))?.notes).toHaveLength(1);
    expect(await s.store.get(URL_B)).toBeNull();
  });

  test('fresh runs a full sync when the last one is old, else a pull of the page', async () => {
    const s = setup(undefined, { now: 10_000 });
    await s.syncer.fresh(URL_A);
    expect(s.sync.mock.calls[0]![2]).toBeUndefined();
    s.at.now = 10_500;
    await s.syncer.fresh(URL_A);
    expect(s.sync.mock.calls[1]![2]).toEqual({ only: [URL_A] });
    s.at.now = 12_000;
    await s.syncer.fresh(URL_A);
    expect(s.sync.mock.calls[2]![2]).toBeUndefined();
    expect(s.status.at(-1)).toEqual({ lastSync: 12_000, lastFull: 12_000 });
  });

  test('lapsed access is reported every time it is tried, and pull says why', async () => {
    const s = setup(async () => 'permission');
    expect(await s.syncer.pull(URL_A)).toEqual({ error: 'permission' });
    expect(await s.syncer.fresh(URL_A)).toEqual({ error: 'permission' });
    expect(s.access).toEqual(['permission', 'permission']);
  });
});

describe('pacing and retry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('a burst of writes makes at most one push per gap', async () => {
    const store = createStore(memoryKV());
    const io = memoryFolder();
    const sync = vi.fn(syncFolder);
    const at = { now: 0 };
    const syncer = createSyncer({
      store,
      open: async () => io,
      sync,
      debounceMs: 100,
      minGapMs: 5000,
      maxWaitMs: 1000,
      now: () => at.now,
    });
    // Writing without a pause for three seconds, a change every 50 ms.
    for (let i = 0; i < 60; i++) {
      at.now = i * 50;
      await store.save(record(URL_A, [note(`n${i}`, 'w', 1000 + i)], 'A', 2000 + i), identity(URL_A));
      syncer.changed({ [pageKeyOf(URL_A)]: { newValue: await store.get(URL_A) } });
      await vi.advanceTimersByTimeAsync(50);
    }
    // Pushed once at the max wait, and the gap holds the next one back.
    expect(sync.mock.calls.length).toBe(1);
    at.now = 10_000;
    await vi.advanceTimersByTimeAsync(6000);
    expect(sync.mock.calls.length).toBe(2);
  });

  test('a push that fails waits for the next trigger and is not lost', async () => {
    const store = createStore(memoryKV());
    const io = memoryFolder();
    let down = true;
    const sync = vi.fn(async (...a: Parameters<typeof syncFolder>) => {
      if (down) return { pulled: 0, pushed: 0, merged: 0, conflictsFolded: 0, errors: ['x: offline'] };
      return syncFolder(...a);
    });
    const syncer = createSyncer({ store, open: async () => io, sync, debounceMs: 10 });
    await store.save(record(URL_A, [note('n1')]), identity(URL_A));
    syncer.changed({ [pageKeyOf(URL_A)]: { newValue: await store.get(URL_A) } });
    await vi.advanceTimersByTimeAsync(20);
    expect(sync).toHaveBeenCalledTimes(1);
    // No timer retries by itself.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(1);
    down = false;
    // The next change carries the waiting page along.
    await store.save(record(URL_B, [note('n2')]), identity(URL_B));
    syncer.changed({ [pageKeyOf(URL_B)]: { newValue: await store.get(URL_B) } });
    await vi.advanceTimersByTimeAsync(20);
    expect(sync.mock.calls[1]![2]!.only!.sort()).toEqual([URL_A, URL_B].sort());
    expect(await names(io)).toHaveLength(2);
  });

  test('a place that cannot be reached keeps the pages for later', async () => {
    const store = createStore(memoryKV());
    const io = memoryFolder();
    let access: 'offline' | 'ok' = 'offline';
    const sync = vi.fn(syncFolder);
    const syncer = createSyncer({
      store,
      open: async () => (access === 'ok' ? io : 'offline'),
      sync,
      debounceMs: 10,
    });
    await store.save(record(URL_A, [note('n1')]), identity(URL_A));
    syncer.changed({ [pageKeyOf(URL_A)]: { newValue: await store.get(URL_A) } });
    await vi.advanceTimersByTimeAsync(20);
    expect(sync).not.toHaveBeenCalled();
    access = 'ok';
    await syncer.flush();
    expect(sync.mock.calls[0]![2]).toEqual({ only: [URL_A] });
  });
});
