import { createStore, memoryKV } from 'pageink-core/store';
import { describe, expect, test, vi } from 'vitest';
import { attentionOf, badgeOf, showAttention } from './background/attention';
import { NUDGE_AGAIN, NUDGE_MONTH, noteNudge, nudgeKind, readNudge } from './nudge';
import { identity, note, record } from './testing/records';

const base = { pages: 3, folder: false, archive: false, st: {}, now: 1e12 };

describe('nudgeKind', () => {
  test('asks for a folder once there is ink on three pages and no folder', () => {
    expect(nudgeKind({ ...base, pages: 2 })).toBeNull();
    expect(nudgeKind(base)).toBe('folder');
    expect(nudgeKind({ ...base, folder: true })).toBeNull();
    expect(nudgeKind({ ...base, st: { chosen: true } })).toBeNull();
  });

  test('a first "Not now" rests it for two weeks, a second ends it', () => {
    const now = base.now;
    expect(nudgeKind({ ...base, st: { dismissed: 1, at: now - 1000 } })).toBeNull();
    expect(nudgeKind({ ...base, st: { dismissed: 1, at: now - NUDGE_AGAIN } })).toBe('folder');
    expect(nudgeKind({ ...base, st: { dismissed: 2, at: 0 } })).toBeNull();
  });

  test('Firefox offers the archive, at most once a month', () => {
    const now = base.now;
    expect(nudgeKind({ ...base, archive: true })).toBe('archive');
    expect(nudgeKind({ ...base, archive: true, st: { dismissed: 5, at: now - 1000 } })).toBeNull();
    expect(nudgeKind({ ...base, archive: true, st: { dismissed: 5, at: now - NUDGE_MONTH } })).toBe(
      'archive',
    );
  });

  test('state is read safely and updated by what the reader did', async () => {
    const m: Record<string, unknown> = { nudge: { dismissed: 'x', at: Number.NaN, chosen: 'yes' } };
    const area = {
      get: async (k: string) => ({ [k]: m[k] }),
      set: async (o: Record<string, unknown>) => void Object.assign(m, o),
    } as unknown as chrome.storage.StorageArea;
    expect(await readNudge(area)).toEqual({});
    await noteNudge(area, 'dismiss', 5);
    await noteNudge(area, 'dismiss', 6);
    expect(await readNudge(area)).toEqual({ dismissed: 2, at: 6 });
    await noteNudge(area, 'export', 7);
    await noteNudge(area, 'chosen', 8);
    expect(await readNudge(area)).toEqual({ dismissed: 2, at: 7, chosen: true });
  });
});

describe('attention', () => {
  async function storeWith(n: number) {
    const store = createStore(memoryKV());
    for (let i = 0; i < n; i++) {
      const u = `https://a.test/${i}`;
      await store.save(record(u, [note(`n${i}`)]), identity(u));
    }
    return store;
  }

  test('lapsed access wins over the backup prompt, and each has its badge', async () => {
    const store = await storeWith(3);
    const of = (folder: 'none' | 'permission' | 'ok', archive = false) =>
      attentionOf({ store, archive, folder: async () => folder, nudge: async () => ({}) });
    expect(await of('none')).toEqual({ lapsed: false, nudge: 'folder' });
    expect(await of('permission')).toEqual({ lapsed: true, nudge: null });
    expect(await of('ok')).toEqual({ lapsed: false, nudge: null });
    expect(await of('none', true)).toEqual({ lapsed: false, nudge: 'archive' });
    expect(badgeOf({ lapsed: true, nudge: null }).text).toBe('!');
    expect(badgeOf({ lapsed: false, nudge: 'folder' }).text).toBe('•');
    expect(badgeOf({ lapsed: false, nudge: null }).text).toBe('');
  });

  test('pages with no ink left do not count', async () => {
    const store = await storeWith(2);
    const u = 'https://a.test/gone';
    await store.save({ ...record(u, []), deleted: [{ id: 'x', t: 1 }] }, identity(u));
    const a = await attentionOf({
      store,
      archive: false,
      folder: async () => 'none',
      nudge: async () => ({}),
    });
    expect(a.nudge).toBeNull();
  });

  test('the badge is set for the whole action', async () => {
    const action = { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) };
    await showAttention({ action } as never, { lapsed: true, nudge: null });
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    await showAttention({ action } as never, { lapsed: false, nudge: null });
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });
});

describe('cloud problems', () => {
  test('a lasting problem shows on the action, a passing one does not', async () => {
    const store = createStore(memoryKV());
    const base = { store, archive: false, folder: async () => 'ok' as const, nudge: async () => ({}) };
    for (const p of ['expired', 'locked', 'denied', 'full'] as const) {
      const a = await attentionOf({
        ...base,
        problem: async () => ({ problem: p, place: 'OneDrive', provider: 'onedrive' }),
      });
      expect(a).toMatchObject({ problem: p, place: 'OneDrive', provider: 'onedrive' });
      expect(badgeOf(a).text).toBe('!');
    }
    for (const p of ['offline', 'throttled', 'server'] as const) {
      const a = await attentionOf({ ...base, problem: async () => ({ problem: p }) });
      expect(a.problem).toBeUndefined();
      expect(badgeOf(a).text).toBe('');
    }
  });
});
