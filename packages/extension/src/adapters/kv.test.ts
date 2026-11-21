import { describe, expect, test } from 'vitest';
import { localKV, storageKV } from './kv';

function fakeArea(withGetKeys: boolean) {
  const m = new Map<string, unknown>();
  type L = (c: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const ls = new Set<L>();
  const fire = (c: Record<string, chrome.storage.StorageChange>, area = 'local') => {
    for (const l of ls) l(c, area);
  };
  const area = {
    async get(keys: string[] | null) {
      const out: Record<string, unknown> = {};
      for (const k of keys ?? [...m.keys()]) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    async set(items: Record<string, unknown>) {
      const c: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        c[k] = { oldValue: m.get(k), newValue: v };
        m.set(k, v);
      }
      fire(c);
    },
    async remove(keys: string[]) {
      const c: Record<string, chrome.storage.StorageChange> = {};
      for (const k of keys) {
        c[k] = { oldValue: m.get(k) };
        m.delete(k);
      }
      fire(c);
    },
    ...(withGetKeys ? { getKeys: async () => [...m.keys()] } : {}),
  };
  const changed = { addListener: (l: L) => ls.add(l), removeListener: (l: L) => ls.delete(l) };
  return { area, changed, fire, listeners: ls };
}

describe.each([true, false])('storageKV (getKeys %s)', (withGetKeys) => {
  test('get, set, keys, remove round-trip', async () => {
    const f = fakeArea(withGetKeys);
    const kv = storageKV(f.area as never, f.changed as never);
    await kv.set({ 'p:a': { n: 1 }, 'p:b': 2, cfg: { v: 1 } });
    expect(await kv.get(['p:a', 'zz'])).toEqual({ 'p:a': { n: 1 } });
    expect((await kv.keys('p:')).sort()).toEqual(['p:a', 'p:b']);
    await kv.remove(['p:a']);
    expect(await kv.keys('p:')).toEqual(['p:b']);
    expect(await kv.get([])).toEqual({});
    await kv.remove([]);
  });

  test('onChange reports new values for this area only and can stop', async () => {
    const f = fakeArea(withGetKeys);
    const kv = storageKV(f.area as never, f.changed as never);
    const seen: Record<string, unknown>[] = [];
    const off = kv.onChange!((c) => seen.push(c));
    await kv.set({ a: 1 });
    await kv.remove(['a']);
    f.fire({ b: { newValue: 2 } }, 'sync');
    expect(seen).toEqual([{ a: 1 }, { a: undefined }]);
    off();
    expect(f.listeners.size).toBe(0);
  });
});

test('storageKV without a change event has no onChange', () => {
  expect(storageKV(fakeArea(true).area as never).onChange).toBeUndefined();
});

test('localKV wires storage.local and storage.onChanged', async () => {
  const f = fakeArea(true);
  const kv = localKV({ storage: { local: f.area, onChanged: f.changed } } as never);
  const seen: unknown[] = [];
  kv.onChange!((c) => seen.push(c));
  await kv.set({ x: 1 });
  expect(seen).toEqual([{ x: 1 }]);
});
