/**
 * The registered viewer script (src/background/register.ts): it matches exactly the hosts
 * that have ink, follows the index and the off list, and injects only known modules.
 */
import { idxKey } from 'pageink-core/hash';
import { describe, expect, test } from 'vitest';
import type { Api } from '../src/api';
import {
  hostsOf,
  keepRegistered,
  modulesFor,
  patternOf,
  SCRIPT_ID,
  VIEW_FILES,
  wantedHosts,
} from '../src/background/register';

type Listener = (...a: unknown[]) => unknown;
type Script = { id: string; js?: string[]; matches?: string[]; runAt?: string; allFrames?: boolean };

/** A fake extension API with storage.local, events and scripting. */
function fakeApi(items: Record<string, unknown>, o: { getKeys?: boolean } = {}) {
  const store = { ...items };
  const on = () => {
    const ls: Listener[] = [];
    return { ls, addListener: (f: Listener) => ls.push(f) };
  };
  const events = { installed: on(), startup: on(), changed: on(), message: on() };
  let scripts: Script[] = [];
  const injected: unknown[] = [];
  const reads: (string[] | null)[] = [];
  const local = {
    async get(keys: string[] | string | null) {
      const list = keys === null ? null : Array.isArray(keys) ? keys : [keys];
      reads.push(list);
      const out: Record<string, unknown> = {};
      for (const k of list ?? Object.keys(store)) if (store[k] !== undefined) out[k] = store[k];
      return out;
    },
    ...(o.getKeys === false ? {} : { getKeys: async () => Object.keys(store) }),
  };
  const api = {
    storage: { local, onChanged: events.changed },
    runtime: { onInstalled: events.installed, onStartup: events.startup, onMessage: events.message },
    scripting: {
      async getRegisteredContentScripts(f?: { ids?: string[] }) {
        return scripts.filter((s) => !f?.ids || f.ids.includes(s.id)).map((s) => ({ ...s }));
      },
      async registerContentScripts(list: Script[]) {
        scripts.push(...list.map((s) => ({ ...s })));
      },
      async updateContentScripts(list: Script[]) {
        for (const u of list) Object.assign(scripts.find((s) => s.id === u.id)!, u);
      },
      async unregisterContentScripts(f: { ids: string[] }) {
        scripts = scripts.filter((s) => !f.ids.includes(s.id));
      },
      async executeScript(d: unknown) {
        injected.push(d);
        return [];
      },
    },
  } as unknown as Api;
  /** Change storage and tell the listeners, as the browser does. */
  const write = async (changes: Record<string, unknown>) => {
    const ch: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(changes)) {
      ch[k] = { oldValue: store[k], newValue: v };
      if (v === undefined) delete store[k];
      else store[k] = v;
    }
    for (const f of events.changed.ls) f(ch, 'local');
    await settle();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const matches = () =>
    scripts
      .find((s) => s.id === SCRIPT_ID)
      ?.matches?.slice()
      .sort() ?? null;
  return { api, events, write, settle, matches, scripts: () => scripts, injected, reads };
}

const rec = (key: string, urls: string[] = [key]) => ({ v: 1, key, urls, title: '', notes: [], deleted: [] });
const idx = (slot: string) => ({ v: 1, m: { x: slot } });

describe('hosts', () => {
  test('a record names the hosts of its key, its addresses and its host entries', () => {
    expect(
      hostsOf(
        rec('https://a.test/p', ['https://a.test/p', 'https://www.b.test:8080/q', 'host:c.test', 'local:x']),
      ),
    ).toEqual(['a.test', 'www.b.test', 'c.test']);
    // A name a match pattern cannot hold is never registered.
    expect(hostsOf(rec('https://a.test/p', ['host:a*b', 'host:', 'host:x/y']))).toEqual(['a.test']);
    expect(hostsOf(null)).toEqual([]);
  });

  test('wanted hosts: those with an index entry, not switched off', async () => {
    const f = fakeApi({
      [idxKey('a.test')]: idx('s1'),
      [idxKey('b.test')]: idx('s2'),
      'p:s1': rec('https://a.test/1'),
      'p:s2': rec('https://b.test/2', ['https://b.test/2', 'https://c.test/2']),
      cfg: { off: ['b.test'] },
    });
    // c.test is in a record but has no index entry: no ink there.
    expect([...(await wantedHosts(f.api, []))].sort()).toEqual(['a.test']);
  });

  test('hosts already registered cost no record read', async () => {
    const f = fakeApi({ [idxKey('a.test')]: idx('s1'), 'p:s1': rec('https://a.test/1') });
    expect([...(await wantedHosts(f.api, ['a.test', 'gone.test']))]).toEqual(['a.test']);
    expect(f.reads.flat()).not.toContain('p:s1');
  });

  test('works without getKeys', async () => {
    const f = fakeApi({ [idxKey('a.test')]: idx('s1'), 'p:s1': rec('https://a.test/1') }, { getKeys: false });
    expect([...(await wantedHosts(f.api, []))]).toEqual(['a.test']);
  });
});

describe('registration', () => {
  test('the first read comes ahead of the viewer, so its reply is on its way while the viewer compiles', () => {
    expect(VIEW_FILES).toEqual(['content/boot.js', 'content/loader.js']);
  });

  test('install registers the viewer at document start, top frame, for hosts with ink only', async () => {
    const f = fakeApi({ [idxKey('a.test')]: idx('s1'), 'p:s1': rec('https://a.test/1') });
    keepRegistered(f.api);
    for (const l of f.events.installed.ls) l({ reason: 'install' });
    await f.settle();
    await f.settle();
    expect(f.scripts()).toEqual([
      expect.objectContaining({
        id: SCRIPT_ID,
        js: VIEW_FILES,
        matches: [patternOf('a.test')],
        runAt: 'document_start',
        allFrames: false,
      }),
    ]);
  });

  test('follows the index: a host with new ink is added, a host with none left is removed', async () => {
    const f = fakeApi({});
    keepRegistered(f.api);
    await f.write({ 'p:s1': rec('https://a.test/1'), [idxKey('a.test')]: idx('s1') });
    expect(f.matches()).toEqual([patternOf('a.test')]);
    await f.write({ 'p:s2': rec('https://b.test/1'), [idxKey('b.test')]: idx('s2') });
    expect(f.matches()).toEqual([patternOf('a.test'), patternOf('b.test')]);
    await f.write({ [idxKey('a.test')]: undefined, 'p:s1': undefined });
    expect(f.matches()).toEqual([patternOf('b.test')]);
    await f.write({ [idxKey('b.test')]: undefined });
    expect(f.matches()).toBeNull();
  });

  test('a site switched off leaves the registration and comes back when switched on', async () => {
    const f = fakeApi({});
    keepRegistered(f.api);
    await f.write({ 'p:s1': rec('https://a.test/1'), [idxKey('a.test')]: idx('s1') });
    await f.write({ cfg: { off: ['a.test'] } });
    expect(f.matches()).toBeNull();
    await f.write({ cfg: { off: [] } });
    expect(f.matches()).toEqual([patternOf('a.test')]);
  });

  test('other setting changes and record saves do not touch the registration', async () => {
    const f = fakeApi({});
    keepRegistered(f.api);
    await f.write({ 'p:s1': rec('https://a.test/1'), [idxKey('a.test')]: idx('s1') });
    const before = f.reads.length;
    await f.write({ cfg: { lastSync: 5 } });
    await f.write({ 'p:s1': rec('https://a.test/1', ['https://a.test/1', 'https://z.test/1']) });
    expect(f.reads.length).toBe(before);
  });

  test('a cloud pull: many records at once make one registration, and cloud bookkeeping changes nothing', async () => {
    const f = fakeApi({});
    keepRegistered(f.api);
    let calls = 0;
    const sc = f.api.scripting as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const name of ['registerContentScripts', 'updateContentScripts', 'unregisterContentScripts']) {
      const fn = sc[name]!;
      sc[name] = (...a) => {
        calls++;
        return fn(...a);
      };
    }
    // A sync from a cloud writes the pages it pulled in one go, with their index entries.
    const pulled: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      pulled[`p:c${i}`] = rec(`https://h${i % 4}.test/${i}`);
      pulled[idxKey(`h${i % 4}.test`)] = idx(`c${i}`);
    }
    await f.write(pulled);
    await f.settle();
    expect(f.matches()).toEqual([0, 1, 2, 3].map((i) => patternOf(`h${i}.test`)));
    expect(calls).toBe(1);
    // Tokens, the chosen place, the sync status and the lock key are not ink.
    const before = f.reads.length;
    await f.write({ 'tok:google': { access: 'x' }, dest: { kind: 'cloud', provider: 'google' } });
    await f.write({ sync: { lastFull: 1 }, lockKey: { key: 'k' }, 'seen:google': ['a'] });
    expect(f.reads.length).toBe(before);
    expect(calls).toBe(1);
  });

  test('injects only known modules, into the frame and document that asked', async () => {
    const f = fakeApi({});
    keepRegistered(f.api);
    const ask = (m: unknown, s: unknown) =>
      new Promise((res) => {
        const r = f.events.message.ls.map((l) => l(m, s, res)).find((x) => x === true);
        if (!r) res('none');
      });
    expect(await ask({ ink: 'inject', files: ['loader', 'tools'] }, { tab: { id: 3 }, frameId: 2 })).toBe(
      true,
    );
    expect(f.injected.at(-1)).toEqual({
      target: { tabId: 3, frameIds: [2] },
      files: ['content/loader.js', 'content/tools.js'],
      injectImmediately: true,
    });
    await ask({ ink: 'inject', files: ['pdf'] }, { tab: { id: 3 }, frameId: 0, documentId: 'd1' });
    expect(f.injected.at(-1)).toMatchObject({ target: { tabId: 3, documentIds: ['d1'] } });
    // Unknown names and senders without a tab get nothing.
    expect(await ask({ ink: 'inject', files: ['../background', 'x'] }, { tab: { id: 3 } })).toBe('none');
    expect(await ask({ ink: 'inject', files: ['loader'] }, {})).toBe('none');
    expect(f.injected).toHaveLength(2);
  });
});

describe('Safari and older browsers', () => {
  test('a start of the background registers again when the browser lost the registration', async () => {
    // Ink on a.test, but nothing registered: a browser that did not keep it across a relaunch.
    const f = fakeApi({ [idxKey('a.test')]: idx('s1'), 'p:s1': rec('https://a.test/1') });
    keepRegistered(f.api);
    for (let i = 0; i < 4; i++) await f.settle();
    expect(f.matches()).toEqual([patternOf('a.test')]);
    // A start that finds it in place reads nothing.
    const before = f.reads.length;
    keepRegistered(f.api);
    for (let i = 0; i < 4; i++) await f.settle();
    expect(f.reads.length).toBe(before);
  });

  test('a refused option is dropped, so the call still happens', async () => {
    const f = fakeApi({});
    const sc = f.api.scripting as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const reg = sc.registerContentScripts!;
    const exe = sc.executeScript!;
    sc.registerContentScripts = (list) => {
      if ((list as { persistAcrossSessions?: boolean }[])[0]!.persistAcrossSessions !== undefined)
        return Promise.reject(new TypeError('unknown key persistAcrossSessions'));
      return reg(list);
    };
    sc.executeScript = (d) => {
      if ((d as { injectImmediately?: boolean }).injectImmediately !== undefined)
        return Promise.reject(new TypeError('unknown key injectImmediately'));
      return exe(d);
    };
    keepRegistered(f.api);
    await f.write({ 'p:s1': rec('https://a.test/1'), [idxKey('a.test')]: idx('s1') });
    await f.settle();
    expect(f.matches()).toEqual([patternOf('a.test')]);
    const ok = await new Promise((res) => {
      for (const l of f.events.message.ls)
        l({ ink: 'inject', files: ['loader'] }, { tab: { id: 1 }, frameId: 0 }, res);
    });
    expect(ok).toBe(true);
    expect(f.injected.at(-1)).toEqual({ target: { tabId: 1, frameIds: [0] }, files: ['content/loader.js'] });
  });

  test('Safari injects the viewer and the tools only: it keeps PDFs in its own viewer', () => {
    expect(modulesFor('safari')).toEqual(['loader', 'tools']);
    expect(modulesFor('chrome')).toEqual(['loader', 'tools', 'pdf']);
  });
});
