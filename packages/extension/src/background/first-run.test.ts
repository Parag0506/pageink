/**
 * The first-run guide (first-run.ts): once per install, at the first start the reader can see
 * it, never on later starts, updates or re-enables, and never on top of a page in use.
 */
import { describe, expect, test } from 'vitest';
import type { Api } from '../api';
import { keepFirstRun, WELCOME_GRACE_MS, WELCOME_KEY } from './first-run';

type Reason = 'install' | 'update' | 'browser_update';
type Tab = { url?: string };

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A browser with the extension in it. Storage and tabs last. Each call of `life` is one load
 * of the background: it adds its listeners, then the browser sends the events of that load.
 */
function browser(o: { safari: boolean; front?: Tab | null }) {
  const store: Record<string, unknown> = {};
  const opened: { url: string; active: boolean }[] = [];
  const state = {
    front: o.front === undefined ? ({ url: 'https://example.org/article' } as Tab | null) : o.front,
    read: true,
    write: true,
    tabs: true,
    query: true,
    gets: 0,
    waits: [] as number[],
  };
  const life = async (reason?: Reason, when: 'at once' | 'after the wait' = 'at once') => {
    const listeners: ((d: { reason: string }) => void)[] = [];
    let release = () => {};
    const grace = new Promise<void>((r) => {
      release = r;
    });
    const api = {
      storage: {
        local: {
          async get(k: string) {
            state.gets++;
            if (!state.read) throw new Error('storage is not there');
            return k in store ? { [k]: store[k] } : {};
          },
          async set(items: Record<string, unknown>) {
            if (!state.write) throw new Error('storage is full');
            Object.assign(store, items);
          },
          async remove(k: string) {
            delete store[k];
          },
        },
      },
      runtime: {
        onInstalled: { addListener: (f: (d: { reason: string }) => void) => listeners.push(f) },
        getURL: (p: string) => `ext://id${p}`,
      },
      tabs: {
        async query(q: unknown) {
          expect(q).toEqual({ active: true, lastFocusedWindow: true });
          if (!state.query) throw new Error('no tabs to ask about');
          return state.front ? [state.front] : [];
        },
        async create(t: { url: string; active: boolean }) {
          if (!state.tabs) throw new Error('no window');
          opened.push({ url: t.url, active: t.active });
        },
      },
    } as unknown as Api;
    const done = keepFirstRun(api, {
      safari: o.safari,
      now: () => 42,
      wait: (ms) => {
        state.waits.push(ms);
        return grace;
      },
    });
    // The browser delivers only to listeners added in the first turn.
    expect(listeners).toHaveLength(1);
    const send = () => {
      for (const l of listeners) l({ reason: reason as string });
    };
    if (reason && when === 'at once') send();
    await settle();
    release();
    await done;
    await settle();
    if (reason && when === 'after the wait') send();
    await settle();
  };
  return { life, store, opened, state };
}

const GUIDE = 'ext://id/options.html#welcome';

describe('Chrome, Edge and Firefox', () => {
  test('adding the extension opens the guide once, in front', async () => {
    const b = browser({ safari: false });
    await b.life('install');
    expect(b.opened).toEqual([{ url: GUIDE, active: true }]);
    expect(b.store[WELCOME_KEY]).toEqual({ at: 42 });
  });

  test('later starts, updates and a second install event open nothing', async () => {
    const b = browser({ safari: false });
    await b.life('install');
    await b.life();
    await b.life('update');
    await b.life('browser_update');
    // Firefox sends "install" again when a temporary add-on is loaded again.
    await b.life('install');
    expect(b.opened).toHaveLength(1);
  });

  test('an update of an install from before the flag opens nothing, then or later', async () => {
    const b = browser({ safari: false });
    await b.life('update');
    expect(b.opened).toEqual([]);
    expect(b.store[WELCOME_KEY]).toEqual({ at: 42 });
    await b.life('install');
    expect(b.opened).toEqual([]);
  });

  test('a start with no installed event reads nothing and opens nothing', async () => {
    const b = browser({ safari: false });
    await b.life();
    await b.life();
    expect(b.opened).toEqual([]);
    expect(b.state.gets).toBe(0);
    expect(b.state.waits).toEqual([]);
  });
});

describe('Safari', () => {
  test('turned on in Settings, then Safari is opened: no installed event, and the guide still opens at that start', async () => {
    const b = browser({ safari: true });
    await b.life();
    // The reader has a page in front, so the guide is a tab in the background.
    expect(b.opened).toEqual([{ url: GUIDE, active: false }]);
    expect(b.state.waits).toEqual([WELCOME_GRACE_MS]);
  });

  test('never again: not on a wake, not when Safari loads the extension again, not when it is turned off and on', async () => {
    const b = browser({ safari: true });
    await b.life();
    // A message wakes the background.
    await b.life();
    // A change of setting while Safari runs: Safari loads the extension again and says "install".
    await b.life('install');
    await b.life('install', 'after the wait');
    await b.life();
    expect(b.opened).toHaveLength(1);
    // A start that finds the flag does not wait for anything.
    expect(b.state.waits).toHaveLength(1);
  });

  test('turned on while Safari runs: the installed event opens the guide at once, behind the page in front', async () => {
    const b = browser({ safari: true });
    await b.life('install');
    expect(b.opened).toEqual([{ url: GUIDE, active: false }]);
    await b.life('install');
    await b.life();
    expect(b.opened).toHaveLength(1);
  });

  test('a page whose address Safari hides counts as a page in use', async () => {
    // All Websites is on Ask at first, so the tab has no address for the extension.
    const b = browser({ safari: true, front: {} });
    await b.life();
    expect(b.opened).toEqual([{ url: GUIDE, active: false }]);
  });

  test('a blank tab in front, or no tab at all: the guide opens in front', async () => {
    for (const front of [{ url: '' }, { url: 'about:blank' }, null]) {
      const b = browser({ safari: true, front });
      await b.life();
      expect(b.opened, JSON.stringify(front)).toEqual([{ url: GUIDE, active: true }]);
    }
  });

  test('the tabs cannot be asked: the guide stays in the background', async () => {
    const b = browser({ safari: true });
    b.state.query = false;
    await b.life('install');
    expect(b.opened).toEqual([{ url: GUIDE, active: false }]);
  });

  test('the start check and an installed event in one load open one guide', async () => {
    const b = browser({ safari: true });
    await b.life('install', 'after the wait');
    expect(b.opened).toHaveLength(1);
  });

  test('an update opens nothing: the start waits for the event and the event sets the flag', async () => {
    const b = browser({ safari: true });
    await b.life('update');
    expect(b.opened).toEqual([]);
    expect(b.store[WELCOME_KEY]).toEqual({ at: 42 });
    await b.life();
    await b.life('install');
    expect(b.opened).toEqual([]);
  });
});

describe('when something fails', () => {
  test('storage that cannot be read: nothing opens, on any start', async () => {
    for (const safari of [true, false]) {
      const b = browser({ safari });
      b.state.read = false;
      await b.life('install');
      await b.life();
      await b.life('install');
      expect(b.opened).toEqual([]);
    }
  });

  test('storage that cannot be written: nothing opens, so the guide cannot come back on every start', async () => {
    for (const safari of [true, false]) {
      const b = browser({ safari });
      b.state.write = false;
      await b.life('install');
      await b.life();
      expect(b.opened).toEqual([]);
    }
  });

  test('no window to open the guide in: the flag is taken back and the next start in Safari opens it', async () => {
    const b = browser({ safari: true });
    b.state.tabs = false;
    await b.life();
    expect(b.opened).toEqual([]);
    expect(b.store[WELCOME_KEY]).toBeUndefined();
    b.state.tabs = true;
    await b.life();
    await b.life();
    expect(b.opened).toHaveLength(1);
  });
});
