import { createStore, memoryFolder, memoryKV, syncFolder } from 'pageink-core/store';
import { describe, expect, test } from 'vitest';
import { identity, note, record } from '../testing/records';
import { cachedFolder, type Seen } from './cache';
import { DEST_KEY, PROBLEMS, problemText, readDest } from './dest';
import { isSetUp } from './ids';
import { syncWithRetry } from './sync';

function area(init: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(init));
  return {
    get: async (k: string) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (o: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(o)) data.set(k, v);
    },
    remove: async (k: string) => void data.delete(k),
  };
}

describe('client ids', () => {
  test('an empty id means the button shows as not set up', () => {
    expect(isSetUp('google', { google: '', microsoft: 'm' })).toBe(false);
    expect(isSetUp('onedrive', { google: '', microsoft: 'm' })).toBe(true);
    expect(isSetUp('onedrive', { google: 'g', microsoft: '  ' })).toBe(false);
  });
  test('the committed config file has empty ids', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const v = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../cloud-ids.json'), 'utf8'));
    expect(v).toMatchObject({ google: '', microsoft: '' });
  });
});

describe('dest', () => {
  test('only well formed places are read', async () => {
    expect(await readDest(area() as never)).toBeNull();
    expect(await readDest(area({ [DEST_KEY]: { kind: 'cloud', provider: 'dropbox' } }) as never)).toBeNull();
    expect(await readDest(area({ [DEST_KEY]: { kind: 'folder', since: 5 } }) as never)).toEqual({
      kind: 'folder',
      since: 5,
    });
    expect(
      await readDest(
        area({ [DEST_KEY]: { kind: 'cloud', provider: 'google', account: 7, since: 'x' } }) as never,
      ),
    ).toEqual({ kind: 'cloud', provider: 'google' });
  });

  test('every problem has plain words and one next step, with no dashes', () => {
    for (const p of PROBLEMS) {
      const t = problemText(p, 'OneDrive');
      expect(t.text.length).toBeGreaterThan(10);
      expect(t.next.length).toBeGreaterThan(3);
      expect(`${t.text} ${t.next}`).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe('read cache', () => {
  test('an unchanged file is read from this device, a changed one from the place', async () => {
    const io = memoryFolder();
    const store = createStore(memoryKV());
    await store.save(record('https://a.test/x', [note('n1')]), identity('https://a.test/x'));
    let version = 'v1';
    let reads = 0;
    const peeking = {
      ...io,
      read: async (n: string) => {
        reads++;
        return io.read(n);
      },
      peek: () => ({ version }),
    };
    let seen: Record<string, Seen> = {};
    const box = {
      get: async () => seen,
      set: async (s: Record<string, Seen>) => {
        seen = s;
      },
    };
    const run = async () => {
      const c = cachedFolder(peeking, store, box);
      await syncFolder(store, c);
      await c.save();
    };
    await run();
    reads = 0;
    await run();
    expect(reads).toBe(0);
    version = 'v2';
    await run();
    expect(reads).toBe(1);
  });
});

describe('sync with retry', () => {
  test('a refused write runs the sync again, at most three times', async () => {
    const store = createStore(memoryKV());
    let calls = 0;
    const fake = async () => {
      calls++;
      return { pulled: 0, pushed: 0, merged: 0, conflictsFolded: 0, errors: ['k: conflict'] };
    };
    const rep = await syncWithRetry(store, memoryFolder(), undefined, fake);
    expect(calls).toBe(3);
    expect(rep.errors).toEqual(['k: conflict']);
    calls = 0;
    await syncWithRetry(store, memoryFolder(), undefined, async () => {
      calls++;
      return { pulled: 0, pushed: 0, merged: 0, conflictsFolded: 0, errors: [] };
    });
    expect(calls).toBe(1);
  });
});
