import { afterEach, describe, expect, test } from 'vitest';
import { quiet, until } from '../testkit';
import { indexedDbKV } from './idb';
import { localKV, type OwnedKV } from './local';

const open: OwnedKV[] = [];
const keep = <T extends OwnedKV>(kv: T): T => {
  open.push(kv);
  return kv;
};
afterEach(async () => {
  for (const kv of open.splice(0)) kv.close();
  localStorage.clear();
  for (const f of document.querySelectorAll('iframe')) f.remove();
  await new Promise<void>((r) => {
    const req = indexedDB.deleteDatabase('kv-test');
    req.onsuccess = req.onerror = req.onblocked = () => r();
  });
});

type Changed = Record<string, unknown>;

async function roundTrip(kv: OwnedKV): Promise<void> {
  const seen: Changed[] = [];
  kv.onChange?.((c) => seen.push(c));
  const rec = { v: 1, notes: [{ id: 'a', pts: [1, 2, 3] }], title: 'ü and 漢字' };
  await kv.set({ 'p:one': rec, 'p:two': 2, 'idx:x': { v: 1, m: {} } });
  expect(await kv.get(['p:one', 'p:two', 'missing'])).toEqual({ 'p:one': rec, 'p:two': 2 });
  expect(await kv.keys('p:')).toEqual(['p:one', 'p:two']);
  expect(await kv.keys('')).toEqual(['idx:x', 'p:one', 'p:two']);
  await kv.remove(['p:two']);
  expect(await kv.get(['p:two'])).toEqual({});
  expect(await kv.keys('p:')).toEqual(['p:one']);
  // Changes made here are reported here too.
  await until(() => seen.length >= 2, 'own changes');
  expect(seen[0]).toEqual({ 'p:one': rec, 'p:two': 2, 'idx:x': { v: 1, m: {} } });
  expect('p:two' in seen[1]!).toBe(true);
  expect(seen[1]!['p:two']).toBeUndefined();
  // Listeners get copies, so a listener cannot change stored data.
  (seen[0]!['p:one'] as { v: number }).v = 99;
  expect(((await kv.get(['p:one']))['p:one'] as { v: number }).v).toBe(1);
}

describe('IndexedDB KV', () => {
  test('round-trips values and reports changes', async () => {
    await roundTrip(keep(indexedDbKV({ name: 'kv-test' })));
  });

  test('a second KV over the same database hears the first through BroadcastChannel', async () => {
    const a = keep(indexedDbKV({ name: 'kv-test' }));
    const b = keep(indexedDbKV({ name: 'kv-test' }));
    const heard: Changed[] = [];
    b.onChange?.((c) => heard.push(c));
    await a.set({ 'p:x': { n: 1 } });
    await until(() => heard.length > 0, 'broadcast');
    expect(heard[0]).toEqual({ 'p:x': { n: 1 } });
    expect(await b.get(['p:x'])).toEqual({ 'p:x': { n: 1 } });
    await a.remove(['p:x']);
    await until(() => heard.length > 1, 'broadcast of the removal');
    expect(heard[1]).toEqual({ 'p:x': undefined });
  });

  test('a closed KV stops reporting', async () => {
    const a = keep(indexedDbKV({ name: 'kv-test' }));
    const b = indexedDbKV({ name: 'kv-test' });
    // An open KV hears the same change: once it has, a closed one would have too.
    const c = keep(indexedDbKV({ name: 'kv-test' }));
    let n = 0;
    let heard = 0;
    b.onChange?.(() => n++);
    c.onChange?.(() => heard++);
    b.close();
    await a.set({ k: 1 });
    await until(() => heard > 0, 'the open KV heard the change');
    await quiet();
    expect(n).toBe(0);
    await expect(b.get(['k'])).rejects.toThrow();
  });
});

describe('localStorage KV', () => {
  test('round-trips values and reports changes', async () => {
    await roundTrip(keep(localKV({ prefix: 't:' })));
    expect(localStorage.getItem('t:p:one')).toContain('"notes"');
  });

  test('keeps to its prefix', async () => {
    localStorage.setItem('other', '1');
    const kv = keep(localKV({ prefix: 't:' }));
    await kv.set({ a: 1 });
    expect(await kv.keys('')).toEqual(['a']);
    expect(localStorage.getItem('other')).toBe('1');
  });

  test('hears writes from another document through the storage event', async () => {
    const kv = keep(localKV({ prefix: 't:' }));
    const heard: Changed[] = [];
    kv.onChange?.((c) => heard.push(c));
    const f = document.createElement('iframe');
    document.body.append(f);
    const other = f.contentWindow!.localStorage;
    other.setItem('t:p:far', JSON.stringify({ n: 7 }));
    other.setItem('elsewhere', '1');
    await until(() => heard.length > 0, 'storage event');
    expect(heard).toEqual([{ 'p:far': { n: 7 } }]);
    other.removeItem('t:p:far');
    await until(() => heard.length > 1, 'removal event');
    expect(heard[1]).toEqual({ 'p:far': undefined });
  });
});
