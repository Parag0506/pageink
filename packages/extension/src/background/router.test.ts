import { describe, expect, test, vi } from 'vitest';
import type { Api } from '../api';
import { drawIn, listen, route } from './router';
import type { Syncer } from './syncer';

function fakeApi() {
  let onMessage: ((m: unknown, s: unknown, r: (x?: unknown) => void) => boolean | undefined) | undefined;
  let onCommand: ((name: string, tab?: { id?: number }) => Promise<void>) | undefined;
  const api = {
    tabs: {
      sendMessage: vi.fn(async () => 'from-tab'),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,AA'),
      query: vi.fn(async () => [{ id: 9 }]),
    },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    runtime: {
      onMessage: { addListener: (f: typeof onMessage) => (onMessage = f) },
      getURL: (p: string) => `chrome-extension://abc${p}`,
    },
    commands: { onCommand: { addListener: (f: typeof onCommand) => (onCommand = f) } },
  };
  return { api: api as unknown as Api, raw: api, msg: () => onMessage!, cmd: () => onCommand! };
}

const syncer = {
  full: vi.fn(async () => ({ report: { pulled: 1, pushed: 0, merged: 0, conflictsFolded: 0, errors: [] } })),
} as unknown as Syncer;
const sender = {
  tab: { id: 5, url: 'https://top.test/page', windowId: 2 },
  frameId: 4,
} as chrome.runtime.MessageSender;
/** The top frame of tab 9, the active tab in the fake. */
const activeTop = {
  tab: { id: 9, url: 'https://top.test/page', windowId: 2, active: true },
  frameId: 0,
} as chrome.runtime.MessageSender;
const popup = { url: 'chrome-extension://abc/popup.html' } as chrome.runtime.MessageSender;

describe('route', () => {
  test('top answers with the tab address and the frame id', async () => {
    const f = fakeApi();
    expect(await route({ api: f.api, syncer }, { ink: 'top' }, sender)).toEqual({
      url: 'https://top.test/page',
      frameId: 4,
    });
  });

  test('framePath is asked of every frame in the tab', async () => {
    const f = fakeApi();
    expect(await route({ api: f.api, syncer }, { ink: 'framePath', frameId: 4 }, sender)).toBe('from-tab');
    expect(f.raw.tabs.sendMessage).toHaveBeenCalledWith(5, { ink: 'framePath', frameId: 4 });
  });

  test('wakeFrames relays wake to every frame', async () => {
    const f = fakeApi();
    await route({ api: f.api, syncer }, { ink: 'wakeFrames' }, sender);
    expect(f.raw.tabs.sendMessage).toHaveBeenCalledWith(5, { ink: 'wake' });
  });

  test('capture takes the visible tab, only for the top frame of the active tab that asks', async () => {
    const f = fakeApi();
    expect(await route({ api: f.api, syncer }, { ink: 'capture' }, activeTop)).toMatch(/^data:image\/png/);
    expect(f.raw.tabs.captureVisibleTab).toHaveBeenCalledWith(2, { format: 'png' });
    expect(await route({ api: f.api, syncer }, { ink: 'capture' }, {})).toBeUndefined();
    f.raw.tabs.captureVisibleTab.mockClear();
    // A frame inside the page, and a tab that is not the active one, get no picture.
    expect(
      await route({ api: f.api, syncer }, { ink: 'capture' }, { ...activeTop, frameId: 3 }),
    ).toBeUndefined();
    expect(
      await route({ api: f.api, syncer }, { ink: 'capture' }, { ...sender, frameId: 0 }),
    ).toBeUndefined();
    const background = { ...activeTop, tab: { ...activeTop.tab!, active: false } };
    expect(await route({ api: f.api, syncer }, { ink: 'capture' }, background)).toBeUndefined();
    expect(f.raw.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  test('capture without captureVisibleTab, or when it throws, gives no picture', async () => {
    const f = fakeApi();
    (f.raw.tabs as { captureVisibleTab?: unknown }).captureVisibleTab = undefined;
    expect(await route({ api: f.api, syncer }, { ink: 'capture' }, activeTop)).toBeUndefined();
    f.raw.tabs.captureVisibleTab = vi.fn(() => {
      throw new Error('not supported');
    });
    expect(await route({ api: f.api, syncer }, { ink: 'capture' }, activeTop)).toBeUndefined();
  });

  test('draw goes to the top frame of the named tab, and only the popup may ask', async () => {
    const f = fakeApi();
    await route({ api: f.api, syncer }, { ink: 'draw', tabId: 3, on: true }, popup);
    expect(f.raw.tabs.sendMessage).toHaveBeenCalledWith(3, { ink: 'draw', on: true }, { frameId: 0 });
    f.raw.tabs.sendMessage.mockClear();
    expect(await route({ api: f.api, syncer }, { ink: 'draw', tabId: 3, on: true }, sender)).toEqual({
      error: 'not allowed',
    });
    expect(f.raw.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test('badge sets the action text for the sender tab, and zero clears it', async () => {
    const f = fakeApi();
    await route({ api: f.api, syncer }, { ink: 'badge', n: 3 }, sender);
    expect(f.raw.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 5, text: '3' });
    await route({ api: f.api, syncer }, { ink: 'badge', n: 120 }, sender);
    expect(f.raw.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 5, text: '99+' });
    await route({ api: f.api, syncer }, { ink: 'badge', n: 0 }, sender);
    expect(f.raw.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 5, text: '' });
    expect(await route({ api: f.api, syncer }, { ink: 'badge', n: 1 }, {})).toBeUndefined();
  });

  test('a page with ink reports in from the top frame only, and only with notes', async () => {
    const f = fakeApi();
    const onPage = vi.fn();
    const top = { ...sender, frameId: 0 };
    await route({ api: f.api, syncer, onPage }, { ink: 'badge', n: 2 }, top);
    await route({ api: f.api, syncer, onPage }, { ink: 'badge', n: 0 }, top);
    await route({ api: f.api, syncer, onPage }, { ink: 'badge', n: 2 }, sender);
    expect(onPage.mock.calls).toEqual([['https://top.test/page']]);
  });

  test('attention, reconnect and the backup prompt', async () => {
    const f = fakeApi();
    const attention = vi.fn(async () => ({ lapsed: false, nudge: null }));
    const nudge = vi.fn(async () => {});
    const d = { api: f.api, syncer, attention, nudge };
    expect(await route(d, { ink: 'attention' }, popup)).toEqual({ lapsed: false, nudge: null });
    expect(await route(d, { ink: 'reconnected' }, popup)).toHaveProperty('report');
    expect(attention).toHaveBeenCalledTimes(2);
    await route(d, { ink: 'nudge', act: 'dismiss' }, popup);
    expect(nudge).toHaveBeenCalledWith('dismiss');
    expect(attention).toHaveBeenCalledTimes(3);
  });

  test('sync runs a full sync', async () => {
    const f = fakeApi();
    const full = syncer.full as unknown as ReturnType<typeof vi.fn>;
    full.mockClear();
    const got = await route({ api: f.api, syncer }, { ink: 'sync' }, popup);
    expect(full).toHaveBeenCalledOnce();
    expect(got).toEqual({ report: { pulled: 1, pushed: 0, merged: 0, conflictsFolded: 0, errors: [] } });
  });

  test('messages from content without a tab resolve to nothing', async () => {
    const f = fakeApi();
    expect(await route({ api: f.api, syncer }, { ink: 'framePath', frameId: 1 }, {})).toBeUndefined();
    expect(await route({ api: f.api, syncer }, { ink: 'wakeFrames' }, {})).toBeUndefined();
  });

  test('unknown messages go to the extra handler', async () => {
    const f = fakeApi();
    const extra = vi.fn(() => Promise.resolve('x'));
    expect(await route({ api: f.api, syncer, extra }, { ink: 'test:x' } as never, {})).toBe('x');
    expect(route({ api: f.api, syncer }, { ink: 'test:x' } as never, {})).toBeUndefined();
  });
});

test('drawIn swallows a tab with no stub', async () => {
  const f = fakeApi();
  f.raw.tabs.sendMessage.mockRejectedValueOnce(new Error('no receiver'));
  expect(await drawIn(f.api, 1)).toBeUndefined();
  expect(f.raw.tabs.sendMessage).toHaveBeenCalledWith(1, { ink: 'draw' }, { frameId: 0 });
});

describe('listen', () => {
  test('replies asynchronously to our messages and ignores others', async () => {
    const f = fakeApi();
    listen({ api: f.api, syncer });
    const reply = vi.fn();
    expect(f.msg()({ ink: 'top' }, sender, reply)).toBe(true);
    await Promise.resolve();
    expect(reply).toHaveBeenCalledWith({ url: 'https://top.test/page', frameId: 4 });
    expect(f.msg()({ hello: 1 }, sender, reply)).toBeUndefined();
    expect(f.msg()({ ink: 'nope' }, sender, reply)).toBeUndefined();
  });

  test('a handler that throws still replies', async () => {
    const f = fakeApi();
    const extra = () => {
      throw new Error('boom');
    };
    listen({ api: f.api, syncer, extra });
    const reply = vi.fn();
    expect(f.msg()({ ink: 'test:x' }, sender, reply)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(reply).toHaveBeenCalledWith({ error: 'Error: boom' });
  });

  test('no commands API, or one without onCommand, is not an error', () => {
    for (const commands of [undefined, {}]) {
      const f = fakeApi();
      (f.raw as { commands?: unknown }).commands = commands;
      expect(() => listen({ api: f.api, syncer })).not.toThrow();
    }
  });

  test('the shortcut toggles draw in the active tab', async () => {
    const f = fakeApi();
    listen({ api: f.api, syncer });
    await f.cmd()('toggle-draw');
    expect(f.raw.tabs.sendMessage).toHaveBeenCalledWith(9, { ink: 'draw' }, { frameId: 0 });
    await f.cmd()('toggle-draw', { id: 4 });
    expect(f.raw.tabs.sendMessage).toHaveBeenLastCalledWith(4, { ink: 'draw' }, { frameId: 0 });
    await f.cmd()('other');
    expect(f.raw.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('the connect screen messages', () => {
  test('come only from the extension’s own pages, never from a web page', async () => {
    const f = fakeApi();
    (f.raw.runtime as unknown as { getURL: (p: string) => string }).getURL = (p: string) =>
      `chrome-extension://abc${p}`;
    const place = vi.fn(async () => ({ ok: true }));
    const attention = vi.fn(async () => ({ lapsed: false, nudge: null }));
    const d = { api: f.api, syncer, place, attention };
    const fromPage = { tab: { id: 1, url: 'https://evil.test/' }, url: 'https://evil.test/' } as never;
    expect(await route(d, { ink: 'lock', op: 'recovery' }, fromPage)).toEqual({ error: 'not allowed' });
    expect(place).not.toHaveBeenCalled();
    const fromOptions = { tab: { id: 2 }, url: 'chrome-extension://abc/options.html' } as never;
    expect(await route(d, { ink: 'connect', provider: 'google' }, fromOptions)).toEqual({ ok: true });
    expect(attention).toHaveBeenCalledTimes(1);
    // Asking for the state does not touch the badge.
    await route(d, { ink: 'place' }, { url: 'chrome-extension://abc/popup.html' } as never);
    expect(attention).toHaveBeenCalledTimes(1);
  });

  test('pdf.html, which a site can show in a frame, and a framed own page, are refused', async () => {
    const f = fakeApi();
    const place = vi.fn(async () => ({ ok: true }));
    const d = { api: f.api, syncer, place, attention: vi.fn(async () => ({})) };
    const framedPdf = {
      tab: { id: 1, url: 'https://evil.test/', windowId: 2 },
      frameId: 3,
      url: 'chrome-extension://abc/pdf.html?file=x',
    } as never;
    for (const m of [
      { ink: 'lock', op: 'off' },
      { ink: 'disconnect' },
      { ink: 'place' },
      { ink: 'sync' },
      { ink: 'draw', tabId: 1 },
    ] as const) {
      expect(await route(d as never, m as never, framedPdf)).toBeUndefined();
    }
    const framedOptions = { ...(framedPdf as object), url: 'chrome-extension://abc/options.html' } as never;
    expect(await route(d as never, { ink: 'lock', op: 'off' }, framedOptions)).toEqual({
      error: 'not allowed',
    });
    const lookalike = { url: 'chrome-extension://abc/options.html.evil' } as never;
    expect(await route(d as never, { ink: 'disconnect' }, lookalike)).toBeUndefined();
    expect(place).not.toHaveBeenCalled();
    // The viewer, as the top frame of the active tab, gets its picture.
    const viewer = { ...activeTop, url: 'chrome-extension://abc/pdf.html?file=x' } as never;
    expect(await route(d as never, { ink: 'capture' }, viewer)).toMatch(/^data:image\/png/);
  });
});
