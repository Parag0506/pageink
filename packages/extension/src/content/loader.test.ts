import { pageIdentity } from 'pageink-core/anchor';
import { hashKey, idxKey, pageKeyOf } from 'pageink-core/hash';
import { createStore, memoryKV } from 'pageink-core/store';
import type { HostHooks, InkState, PageRecord, ViewerOptions } from 'pageink-core/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Api } from '../api';
import {
  boot,
  bootKeys,
  checkedPre,
  frameOptions,
  hasFrameNotes,
  hooksFor,
  primedKV,
  shadowAccessor,
  start,
  wakeFrames,
} from './loader';
import { world } from './modules';

const created: ViewerOptions[] = [];
const reload = vi.fn(async () => {});
const destroy = vi.fn();
let rec: PageRecord | null = null;
let state: Partial<InkState> = {};
vi.mock('pageink-core/view', () => ({
  createInkViewer: vi.fn(async (o: ViewerOptions) => {
    created.push(o);
    return { reload, destroy, state: () => state as InkState, record: () => rec };
  }),
}));

const note = (frame?: string) =>
  ({
    id: 'n',
    kind: 'ink',
    strokes: [{}],
    anchor: frame ? { frame: { url: frame, path: { css: '', xpath: '' } } } : {},
  }) as PageRecord['notes'][number];
const recordWith = (...notes: PageRecord['notes']) => ({ notes }) as PageRecord;

function fakeApi(replies: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const changed: ((c: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  const api = {
    storage: {
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      onChanged: { addListener: vi.fn((f) => changed.push(f)), removeListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async (m: { ink: string }) => {
        sent.push(m);
        return replies[m.ink];
      }),
    },
  };
  return { api: api as unknown as Api, sent, changed };
}

let win: EventTarget & { location: { href: string }; navigation?: EventTarget };
let frames = false;
beforeEach(() => {
  created.length = 0;
  frames = false;
  rec = recordWith();
  state = { notes: 0 };
  reload.mockClear();
  destroy.mockClear();
  win = Object.assign(new EventTarget(), {
    location: { href: 'https://a.test/x#h' },
    navigation: new EventTarget(),
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', win.location);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { querySelector: () => (frames ? {} : null) }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('start', () => {
  test('top frame: builds options and reloads on navigation', async () => {
    const f = fakeApi();
    await start({ api: f.api, top: true });
    const o = created[0]!;
    expect(o.identity).toBeUndefined();
    expect(o.frame).toBeUndefined();
    expect(typeof o.kv.get).toBe('function');
    expect(typeof o.kv.onChange).toBe('function');
    expect(typeof o.shadowRootOf).toBe('function');
    // The viewer imports the tools itself, from the same build as the loader.
    expect(o.loadTools).toBeUndefined();
    win.location.href = 'https://a.test/y';
    win.navigation!.dispatchEvent(new Event('navigatesuccess'));
    expect(reload).toHaveBeenCalledTimes(1);
    // No notes: nothing is sent, so the background stays asleep.
    expect(f.sent).toEqual([]);
  });

  test('frames are woken only when the record has notes inside frames', async () => {
    frames = true;
    const f = fakeApi();
    rec = recordWith(note());
    state = { notes: 1 };
    await start({ api: f.api, top: true });
    expect(f.sent).toEqual([{ ink: 'badge', n: 1 }]);

    const g = fakeApi();
    rec = recordWith(note(), note('https://f.test/'));
    await start({ api: g.api, top: true });
    expect(g.sent).toEqual([{ ink: 'badge', n: 2 }, { ink: 'wakeFrames' }]);
  });

  test('a frame note that arrives through storage wakes the frames', async () => {
    frames = true;
    const f = fakeApi();
    await start({ api: f.api, top: true });
    expect(f.sent).toEqual([]);
    rec = recordWith(note('https://f.test/'));
    for (const fn of f.changed) fn({ 'p:abc': { newValue: rec } }, 'local');
    expect(f.sent).toEqual([{ ink: 'wakeFrames' }]);
  });

  test('the badge leaves out an ink note the merge left with no strokes', async () => {
    const f = fakeApi();
    rec = recordWith(note(), { ...note(), strokes: [] });
    await start({ api: f.api, top: true });
    expect(f.sent).toEqual([{ ink: 'badge', n: 1 }]);
  });

  test('state changes set the badge, and site off calls the off hook and clears it', async () => {
    const f = fakeApi();
    const off = vi.fn();
    const v = await start({ api: f.api, top: true, off });
    const hooks = created[0]!.hooks as HostHooks;
    rec = recordWith(note(), note('https://f.test/'));
    hooks.onState!({ notes: 1 } as InkState);
    // The badge counts frame notes too, and so does the state the popup reads.
    expect(f.sent).toEqual([{ ink: 'badge', n: 2 }]);
    expect(v.state().notes).toBe(2);
    hooks.onState!({ notes: 1 } as InkState);
    expect(f.sent).toHaveLength(1);
    hooks.onState!({ notes: 1, off: true } as InkState);
    expect(off).toHaveBeenCalledTimes(1);
    expect(f.sent.at(-1)).toEqual({ ink: 'badge', n: 0 });
    v.destroy();
    expect(destroy).toHaveBeenCalled();
    await flush();
  });

  test('subframe: identity of the top page and the frame path, and no badge', async () => {
    const path = { css: 'body > iframe', xpath: '/html/body/iframe' };
    const f = fakeApi({ top: { url: 'https://top.test/page?utm_source=x', frameId: 3 }, framePath: path });
    rec = recordWith(note('https://a.test/x'));
    await start({ api: f.api, top: false });
    const o = created[0]!;
    expect(o.identity?.key).toContain('top.test/page');
    expect(o.identity?.host).toBe('top.test');
    expect(o.frame).toEqual({ url: 'https://a.test/x', path });
    expect(f.sent).toEqual([{ ink: 'top' }, { ink: 'framePath', frameId: 3 }]);
  });
});

test('hasFrameNotes', () => {
  expect(hasFrameNotes(null)).toBe(false);
  expect(hasFrameNotes(recordWith(note()))).toBe(false);
  expect(hasFrameNotes(recordWith(note(), note('https://f.test/')))).toBe(true);
});

test('frameOptions is empty when the background has no tab address', async () => {
  expect(await frameOptions(fakeApi({ top: undefined }).api)).toEqual({});
});

test('frameOptions falls back to an empty path', async () => {
  const o = await frameOptions(fakeApi({ top: { url: 'https://t.test/', frameId: 1 } }).api);
  expect(o.frame?.path).toEqual({ css: '', xpath: '' });
});

describe('shadowAccessor', () => {
  const root = {} as ShadowRoot;
  test('uses Firefox element.openOrClosedShadowRoot first', () => {
    const el = { openOrClosedShadowRoot: () => root, shadowRoot: null } as unknown as Element;
    expect(shadowAccessor({} as Api)(el)).toBe(root);
  });
  test('uses chrome.dom.openOrClosedShadowRoot', () => {
    const el = { shadowRoot: null } as unknown as Element;
    const api = { dom: { openOrClosedShadowRoot: () => root } } as unknown as Api;
    expect(shadowAccessor(api)(el)).toBe(root);
  });
  test('falls back to the open root when the accessor throws', () => {
    const el = { shadowRoot: root } as unknown as Element;
    const api = {
      dom: {
        openOrClosedShadowRoot: () => {
          throw new Error('not a host');
        },
      },
    } as unknown as Api;
    expect(shadowAccessor(api)(el)).toBe(root);
  });
});

test('captureVisible asks the background and survives a failure', async () => {
  const f = fakeApi({ capture: 'data:image/png;base64,AA' });
  expect(await hooksFor(f.api).captureVisible!()).toBe('data:image/png;base64,AA');
  (f.api.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('x'));
  expect(await hooksFor(f.api).captureVisible!()).toBeUndefined();
});

test('wakeFrames sends again when a frame finishes loading', async () => {
  const f = fakeApi();
  const doc = Object.assign(new EventTarget(), { querySelector: () => null }) as unknown as Document;
  const stop = wakeFrames(f.api, doc);
  expect(f.sent).toEqual([]);
  const ev = (localName: string) => {
    // Node has no DOM tree, so the event names its frame target itself.
    class FrameLoad extends Event {
      override get target() {
        return { localName } as unknown as EventTarget;
      }
    }
    doc.dispatchEvent(new FrameLoad('load'));
  };
  ev('img');
  ev('iframe');
  expect(f.sent).toEqual([{ ink: 'wakeFrames' }]);
  stop();
  ev('iframe');
  expect(f.sent).toHaveLength(1);
});

describe('start with items the stub read', () => {
  const good = { v: 1, key: 'https://a.test/x', urls: [], title: '', updatedAt: 1, notes: [], deleted: [] };

  test('the viewer reads the settings and the record from them, not from storage', async () => {
    const f = fakeApi();
    const items = { cfg: { modifier: 'Alt' }, 'p:rk': good };
    await start({ api: f.api, top: true, pre: Promise.resolve(items) });
    const kv = created[0]!.kv;
    expect(await kv.get(['cfg', 'p:rk'])).toEqual(items);
    expect(f.api.storage.local.get).not.toHaveBeenCalled();
  });

  test('a record the store would not accept is never handed over: the viewer reads it through the store', async () => {
    const f = fakeApi();
    (f.api.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const items = { cfg: { modifier: 'Alt' }, 'p:rk': { v: 1, key: 'k', notes: [{ id: 7 }] } };
    await start({ api: f.api, top: true, pre: Promise.resolve(items) });
    const kv = created[0]!.kv;
    expect(await kv.get(['cfg'])).toEqual({ cfg: { modifier: 'Alt' } });
    await kv.get(['p:rk']);
    expect(f.api.storage.local.get).toHaveBeenCalledWith(['p:rk']);
  });

  test('a record is handed over only as the clean copy the store accepts for this page', async () => {
    const f = fakeApi();
    (f.api.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const extra = { ...good, evil: '<img>', notes: [] };
    await start({ api: f.api, top: true, pre: Promise.resolve({ 'p:rk': extra }) });
    const got = (await created[0]!.kv.get(['p:rk']))['p:rk'] as Record<string, unknown>;
    expect(got).toEqual(good);
    expect(got.evil).toBeUndefined();
    expect(f.api.storage.local.get).not.toHaveBeenCalled();
  });

  test('a record of another page under the same slot is never handed over', async () => {
    const f = fakeApi();
    (f.api.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const other = { ...good, key: 'https://b.test/other', urls: ['https://b.test/other'] };
    await start({ api: f.api, top: true, pre: Promise.resolve({ cfg: {}, 'p:rk': other }) });
    await created[0]!.kv.get(['p:rk']);
    expect(f.api.storage.local.get).toHaveBeenCalledWith(['p:rk']);
  });

  test('a private window asks the viewer to keep ink in memory', async () => {
    const f = fakeApi();
    (f.api as unknown as { extension: object }).extension = { inIncognitoContext: true };
    await start({ api: f.api, top: true });
    expect(created[0]!.private).toBe(true);
    const g = fakeApi();
    await start({ api: g.api, top: true });
    expect(created[1]!.private).toBeUndefined();
  });
});

describe('the boot read', () => {
  const url = 'https://en.wikipedia.org/wiki/Mars';
  const id = pageIdentity(url);
  const slot = pageKeyOf(id.key);
  const rec = { v: 1, key: id.key, urls: [url], title: 'Mars', updatedAt: 1, notes: [], deleted: [] };
  // Ink written on the desktop site only: the mobile host has no index.
  const stored = {
    [idxKey('en.wikipedia.org')]: { v: 1, m: { [hashKey(url)]: hashKey(id.key) } },
    [slot]: rec,
    cfg: { v: 1, device: 'd1' },
  };

  test('reads every key the first load and the settings read, absent ones as undefined', async () => {
    expect(bootKeys(id)).toEqual([idxKey('en.wikipedia.org'), idxKey('en.m.wikipedia.org'), slot, 'cfg']);
    const kv = memoryKV(stored);
    const get = vi.fn(async (keys: string[]) => kv.get(keys));
    win.location.href = url;
    (win as unknown as { top: unknown }).top = win;
    vi.stubGlobal('chrome', { runtime: { id: 'x' }, storage: { local: { get } } });
    try {
      boot();
      const early = world().early!;
      expect(early.key).toBe(slot);
      const items = await early.items;
      expect(get).toHaveBeenCalledTimes(1);
      expect(Object.keys(items).sort()).toEqual([...bootKeys(id)].sort());
      expect(items[idxKey('en.m.wikipedia.org')]).toBeUndefined();
    } finally {
      delete (globalThis as { __ink?: unknown }).__ink;
    }
  });

  test('a second run of the boot read, as when a stale registration lists it after the viewer, reads nothing more', async () => {
    const kv = memoryKV(stored);
    const get = vi.fn(async (keys: string[]) => kv.get(keys));
    win.location.href = url;
    (win as unknown as { top: unknown }).top = win;
    vi.stubGlobal('chrome', { runtime: { id: 'x' }, storage: { local: { get } } });
    try {
      boot();
      const first = world().early;
      boot();
      expect(world().early).toBe(first);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { __ink?: unknown }).__ink;
    }
  });

  test('with no boot read, as for a viewer injected on pen-down, the viewer reads what it needs itself', async () => {
    const f = fakeApi();
    delete (globalThis as { __ink?: unknown }).__ink;
    win.location.href = url;
    await start({ api: f.api, top: true });
    expect(world().early).toBeUndefined();
    expect(created).toHaveLength(1);
    await created[0]!.kv.get([slot]);
    expect(f.api.storage.local.get).toHaveBeenCalled();
  });

  test('when the stub used the boot read, the viewer gets every key of it, not only those the stub read', async () => {
    const f = fakeApi();
    const kv = memoryKV(stored);
    const items: Record<string, unknown> = { ...(await kv.get(bootKeys(id))) };
    for (const k of bootKeys(id)) if (!(k in items)) items[k] = undefined;
    const ik = idxKey('en.wikipedia.org');
    (globalThis as { __ink?: unknown }).__ink = { early: { key: slot, items: Promise.resolve(items) } };
    try {
      win.location.href = url;
      const pre = Promise.resolve({ [ik]: stored[ik], cfg: stored.cfg, [slot]: rec });
      await start({ api: f.api, top: true, pre });
      const got = await created[0]!.kv.get([ik, idxKey('en.m.wikipedia.org'), slot]);
      expect(got).toEqual({ [ik]: stored[ik], [slot]: rec });
      expect(f.api.storage.local.get).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { __ink?: unknown }).__ink;
    }
  });

  test('the viewer loads the record and reads the settings from those items with no storage trip', async () => {
    const kv = memoryKV(stored);
    const items: Record<string, unknown> = { ...(await kv.get(bootKeys(id))) };
    for (const k of bootKeys(id)) if (!(k in items)) items[k] = undefined;
    const get = vi.spyOn(kv, 'get');
    const store = createStore(primedKV(kv, checkedPre(items, id)));
    const [cfg, loaded] = await Promise.all([store.config(), store.load(id)]);
    expect(loaded).toEqual(rec);
    expect(cfg.device).toBe('d1');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('primedKV', () => {
  test('answers a read of known keys from the items, once, with absent keys left out', async () => {
    const kv = memoryKV();
    const get = vi.spyOn(kv, 'get');
    const p = primedKV(kv, { a: 1, b: undefined });
    expect(await p.get(['a', 'b'])).toEqual({ a: 1 });
    expect(get).not.toHaveBeenCalled();
    // A second read goes to storage: the items are a snapshot for the first read only.
    await kv.set({ a: 2 });
    expect(await p.get(['a'])).toEqual({ a: 2 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('a read with an unknown key goes to storage', async () => {
    const kv = memoryKV();
    await kv.set({ c: 3 });
    const p = primedKV(kv, { a: 1 });
    expect(await p.get(['a', 'c'])).toEqual({ c: 3 });
  });

  test('a write or a change drops the known value', async () => {
    const kv = memoryKV();
    const p = primedKV(kv, { a: 1, b: 1 });
    await p.set({ a: 5 });
    expect(await p.get(['a'])).toEqual({ a: 5 });
    await kv.set({ b: 7 });
    expect(await p.get(['b'])).toEqual({ b: 7 });
  });
});
