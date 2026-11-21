import { hashKey, idxKey } from 'pageink-core/hash';
import type { Front, InkCommands, InkState, Viewer } from 'pageink-core/types';
import { describe, expect, test, vi } from 'vitest';
import type { Api } from '../api';
import type { Load, LoaderModule } from './modules';
import { startStub } from './stub';

type Listener = { type: string; opts: AddEventListenerOptions | boolean | undefined };

function setup(
  o: {
    stored?: Record<string, unknown>;
    top?: boolean;
    penReady?: boolean;
    frames?: number[];
    contentType?: string;
    /** Leave out the test seam: only trusted events count, as on a real page. */
    strict?: boolean;
  } = {},
) {
  const added: Listener[] = [];
  const removed: Listener[] = [];
  const target = new EventTarget();
  const domReads: string[] = [];
  const frameEls = (o.frames ?? []).map((id) => ({ id }));
  const document = new Proxy(
    {},
    {
      get(_t, p) {
        domReads.push(String(p));
        if (p === 'querySelectorAll') return () => frameEls;
        // The one property the stub reads: is this the browser's PDF viewer.
        if (p === 'contentType') return o.contentType ?? 'text/html';
        throw new Error(`stub touched document.${String(p)}`);
      },
    },
  );
  const win = {
    performance,
    location: { hostname: 'a.test', href: 'https://a.test/x' },
    document,
    addEventListener(type: string, fn: EventListener, opts?: AddEventListenerOptions) {
      added.push({ type, opts });
      target.addEventListener(type, fn, opts);
    },
    removeEventListener(type: string, fn: EventListener, opts?: AddEventListenerOptions) {
      removed.push({ type, opts });
      target.removeEventListener(type, fn, opts);
    },
    dispatchEvent: (e: Event) => target.dispatchEvent(e),
  } as unknown as Window & { top: unknown };
  (win as { top: unknown }).top = o.top === false ? {} : win;

  let onMessage: ((m: unknown, s: unknown, reply: (r?: unknown) => void) => boolean | undefined) | undefined;
  const get = vi.fn(async (_keys: string[]) => o.stored ?? {});
  const api = {
    storage: { local: { get } },
    runtime: {
      onMessage: { addListener: (fn: typeof onMessage) => (onMessage = fn) },
      getFrameId: (el: { id: number }) => el.id,
    },
  } as unknown as Api;

  let state: Partial<InkState> = { draw: false, notes: 3 };
  const cmd = { setDraw: vi.fn((on: boolean) => (state = { ...state, draw: on })) } as unknown as InkCommands;
  const viewer = {
    tools: vi.fn(async () => cmd),
    adopt: vi.fn(),
    destroy: vi.fn(),
    state: () => state as InkState,
  } as unknown as Viewer & {
    tools: ReturnType<typeof vi.fn>;
    adopt: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  const loader: LoaderModule = {
    start: vi.fn(async () => viewer),
    pathOf: vi.fn(() => ({ css: 'iframe', xpath: '/iframe' })),
  };
  const pdf = { start: vi.fn() };
  const load = vi.fn(async (name: string) =>
    name === 'loader' ? loader : name === 'pdf' ? pdf : { attachTools: vi.fn() },
  ) as unknown as Load & ReturnType<typeof vi.fn>;

  startStub({ win, api, load, penReady: o.penReady ?? false, ...(o.strict ? {} : { real: () => true }) });
  const send = (m: unknown) =>
    new Promise<unknown>((res) => {
      const r = onMessage?.(m, {}, res);
      if (r !== true) res('sync');
    });
  const pointer = (type: string, pointerType: string, mod = false) => {
    const e = new Event(type) as PointerEvent;
    Object.assign(e, { pointerType, getModifierState: () => mod });
    win.dispatchEvent(e);
    return e;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { o, win, api, get, load, loader, pdf, viewer, cmd, added, removed, send, pointer, flush, domReads };
}

describe('stub', () => {
  test('top frame reads the index and cfg in one call and adds only the early window listeners', async () => {
    const s = setup();
    await s.flush();
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.get).toHaveBeenCalledWith([idxKey('a.test'), 'cfg']);
    expect(s.added).toEqual(
      ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'].map((type) => ({
        type,
        opts: { capture: true },
      })),
    );
    expect(s.load).not.toHaveBeenCalled();
    // One property read, no layout: is this the browser's PDF viewer.
    expect(s.domReads).toEqual(['contentType']);
  });

  test('loads the loader when the host has an index entry', async () => {
    const s = setup({ stored: { [idxKey('a.test')]: { v: 1, m: { x: 'y' } } } });
    await s.flush();
    expect(s.load.mock.calls).toEqual([['loader', undefined]]);
    expect(s.loader.start).toHaveBeenCalledWith(expect.objectContaining({ top: true }));
    expect(s.viewer.tools).not.toHaveBeenCalled();
  });

  test('pen-down loads loader then tools and hands over the buffered events', async () => {
    const s = setup();
    await s.flush();
    const down = s.pointer('pointerdown', 'pen');
    const move = s.pointer('pointermove', 'pen');
    await s.flush();
    // One request for the viewer and the tools together.
    expect(s.load.mock.calls).toEqual([['loader', true]]);
    expect(s.viewer.tools).toHaveBeenCalledTimes(1);
    expect(s.viewer.adopt).toHaveBeenCalledWith([down, move]);
    s.pointer('pointerdown', 'pen');
    await s.flush();
    expect(s.viewer.tools).toHaveBeenCalledTimes(1);
  });

  test('the front hands window events to the loaded code first, and a stopped event goes no further', async () => {
    const s = setup();
    await s.flush();
    s.pointer('pointerdown', 'pen');
    await s.flush();
    const { front } = (s.loader.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { front: Front };
    const seen: string[] = [];
    const off = front.on('pointerdown', (e) => {
      seen.push(`a:${e.type}`);
      e.stopImmediatePropagation();
    });
    front.on('pointerdown', (e) => seen.push(`b:${e.type}`));
    front.on('click', (e) => seen.push(`b:${e.type}`));
    s.pointer('pointerdown', 'pen');
    s.win.dispatchEvent(new Event('click'));
    expect(seen).toEqual(['a:pointerdown', 'b:click']);
    off();
    s.pointer('pointerdown', 'pen');
    expect(seen).toEqual(['a:pointerdown', 'b:click', 'b:pointerdown']);
    // Capture has the pen now. The stub does not load the tools again.
    expect(s.viewer.tools).toHaveBeenCalledTimes(1);
  });

  test('events a page script makes load nothing, reach no consumer and block no touch', async () => {
    const s = setup({ strict: true, stored: { cfg: { penReady: true } } });
    await s.flush();
    s.pointer('pointerdown', 'pen');
    s.pointer('pointerdown', 'mouse', true);
    await s.flush();
    expect(s.load).not.toHaveBeenCalled();
    const e = new Event('touchstart', { cancelable: true }) as TouchEvent;
    Object.assign(e, { changedTouches: [{ touchType: 'stylus' }] });
    s.win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    // Once the tools are in through the popup, fake events still reach no consumer.
    await s.send({ ink: 'draw' });
    const { front } = (s.loader.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { front: Front };
    const seen: string[] = [];
    front.on('pointerdown', (ev) => seen.push(ev.type));
    front.on('click', (ev) => seen.push(ev.type));
    s.pointer('pointerdown', 'pen');
    s.win.dispatchEvent(new Event('click'));
    expect(seen).toEqual([]);
    expect(s.viewer.adopt).toHaveBeenCalledWith([]);
  });

  test('a site left in draw mode loads the viewer at once, unless the reader turned that off', async () => {
    const s = setup({ stored: { cfg: { drawOn: ['a.test'] } } });
    await s.flush();
    expect(s.load.mock.calls.map((c) => c[0])).toEqual(['loader']);
    const t = setup({ stored: { cfg: { drawOn: ['a.test'], rememberDraw: false } } });
    await t.flush();
    expect(t.load).not.toHaveBeenCalled();
    const u = setup({ stored: { cfg: { drawOn: ['b.test'] } } });
    await u.flush();
    expect(u.load).not.toHaveBeenCalled();
  });

  test('settings of the wrong shape in storage count as absent', async () => {
    // A string off list would match by substring, and an object would throw.
    for (const cfg of [{ off: 'xa.test.y' }, { off: { includes: 1 } }, { drawOn: 'a.test' }, 'cfg']) {
      const s = setup({ stored: { cfg } });
      await s.flush();
      expect(s.load).not.toHaveBeenCalled();
      s.pointer('pointerdown', 'pen');
      await s.flush();
      expect(s.load).toHaveBeenCalledWith('loader', true);
    }
  });

  test('a pen that needs the toggle never holds back a stylus touch', async () => {
    const s = setup({ stored: { cfg: { penNeedsToggle: true, penReady: true } } });
    await s.flush();
    expect(s.added.some((a) => a.type.startsWith('touch'))).toBe(false);
  });

  test('pointerrawupdate is not buffered', async () => {
    const s = setup();
    await s.flush();
    s.pointer('pointerdown', 'pen');
    expect(s.added.map((a) => a.type)).not.toContain('pointerrawupdate');
  });

  test('a plain mouse press does nothing, a press with the modifier draws', async () => {
    const s = setup({ stored: { cfg: { modifier: 'Alt' } } });
    await s.flush();
    s.pointer('pointerdown', 'mouse');
    s.pointer('pointerdown', 'touch');
    await s.flush();
    expect(s.load).not.toHaveBeenCalled();
    s.pointer('pointerdown', 'mouse', true);
    await s.flush();
    expect(s.viewer.tools).toHaveBeenCalled();
  });

  test('does nothing on a host where ink is off', async () => {
    const s = setup({ stored: { cfg: { off: ['a.test'] }, [idxKey('a.test')]: { v: 1, m: {} } } });
    await s.flush();
    s.pointer('pointerdown', 'pen');
    expect(await s.send({ ink: 'draw' })).toBe('sync');
    await s.flush();
    expect(s.load).not.toHaveBeenCalled();
    expect(await s.send({ ink: 'state' })).toEqual({ loaded: false, off: true, draw: false, notes: 0 });
  });

  test('draw toggle loads the tools and flips draw', async () => {
    const s = setup();
    await s.flush();
    await s.send({ ink: 'draw' });
    expect(s.cmd.setDraw).toHaveBeenCalledWith(true);
    expect(await s.send({ ink: 'state' })).toEqual({ loaded: true, off: false, draw: true, notes: 3 });
    await s.send({ ink: 'draw', on: true });
    expect(s.cmd.setDraw).toHaveBeenLastCalledWith(true);
  });

  test('ignores messages that are not ours', async () => {
    const s = setup();
    expect(await s.send({ other: 1 })).toBe('sync');
    expect(await s.send(null)).toBe('sync');
  });

  test('penReady blocks stylus touches only', async () => {
    const s = setup({ stored: { cfg: { penReady: true } } });
    await s.flush();
    expect(s.added.filter((a) => a.type.startsWith('touch'))).toEqual([
      { type: 'touchstart', opts: { capture: true, passive: false } },
      { type: 'touchmove', opts: { capture: true, passive: false } },
    ]);
    const touch = (touchType: string) => {
      const e = new Event('touchstart', { cancelable: true }) as TouchEvent;
      Object.assign(e, { changedTouches: [{ touchType }] });
      s.win.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(touch('direct')).toBe(false);
    expect(touch('stylus')).toBe(true);
  });

  test('penReady off adds no touch listener', async () => {
    const s = setup({ stored: { cfg: { penReady: false } }, penReady: true });
    await s.flush();
    expect(s.added.some((a) => a.type.startsWith('touch'))).toBe(false);
  });

  test('a subframe does no storage read and wakes on a frame message', async () => {
    const s = setup({ top: false });
    await s.flush();
    expect(s.get).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
    await s.send({ ink: 'wake' });
    await s.flush();
    expect(s.loader.start).toHaveBeenCalledWith(expect.objectContaining({ top: false }));
  });

  test('a subframe wakes on pen-down', async () => {
    const s = setup({ top: false });
    s.pointer('pointerdown', 'pen');
    await s.flush();
    expect(s.viewer.adopt).toHaveBeenCalled();
  });

  test('answers framePath only for its own frame element', async () => {
    const s = setup({ frames: [7] });
    expect(await s.send({ ink: 'framePath', frameId: 3 })).toBe('sync');
    expect(await s.send({ ink: 'framePath', frameId: 7 })).toEqual({ css: 'iframe', xpath: '/iframe' });
  });

  test('a release build leaves no performance entry on the page', async () => {
    // Only the bench build times the stub (__INK_BENCH__).
    performance.clearMeasures('ink:stub');
    const s = setup({ stored: { [idxKey('a.test')]: { v: 1, m: {} } } });
    await s.flush();
    expect(performance.getEntriesByName('ink:stub')).toEqual([]);
  });

  test('site off from the popup removes the viewer and stops listening; on again comes back', async () => {
    const idx = { [idxKey('a.test')]: { v: 1, m: { x: 'y' } } };
    const s = setup({ stored: idx });
    await s.flush();
    expect(s.loader.start).toHaveBeenCalledTimes(1);
    await s.send({ ink: 'site', on: false });
    await s.flush();
    expect(s.viewer.destroy).toHaveBeenCalledTimes(1);
    expect(s.removed.map((r) => r.type)).toContain('pointerdown');
    s.pointer('pointerdown', 'pen');
    await s.send({ ink: 'draw' });
    await s.flush();
    expect(s.loader.start).toHaveBeenCalledTimes(1);
    expect(await s.send({ ink: 'state' })).toMatchObject({ off: true, loaded: false });

    // The popup wrote cfg before it sent the message, so the read sees the site on.
    s.o.stored = { ...idx, cfg: { off: [] } };
    await s.send({ ink: 'site', on: true });
    await s.flush();
    // Each start with ink reads the index and settings, then the record beside the loader import.
    expect(s.get).toHaveBeenCalledTimes(4);
    expect(s.loader.start).toHaveBeenCalledTimes(2);
    s.pointer('pointerdown', 'pen');
    await s.flush();
    expect(s.viewer.tools).toHaveBeenCalled();
  });

  test('a page with ink: the record its address points at is read beside the loader import', async () => {
    const ik = idxKey('a.test');
    const rec = { v: 1, key: 'https://a.test/x', notes: [] };
    const index = { v: 1, m: { [hashKey('https://a.test/x')]: 'rk' } };
    const s = setup({ stored: { [ik]: index, cfg: { modifier: 'Alt' }, 'p:rk': rec } });
    await s.flush();
    expect(s.get.mock.calls.map((c) => c[0])).toEqual([[ik, 'cfg'], 'p:rk']);
    const ctx = (s.loader.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      pre: Promise<Record<string, unknown>>;
    };
    // Known keys come with it, absent ones as undefined, so the viewer reads none of them again.
    expect(await ctx.pre).toEqual({ [ik]: index, cfg: { modifier: 'Alt' }, 'p:rk': rec });
  });

  test('a record read the boot script started is used when the index points at its slot', async () => {
    const ik = idxKey('a.test');
    const rec = { v: 1, key: 'https://a.test/x', notes: [] };
    const index = { v: 1, m: { [hashKey('https://a.test/x')]: 'rk' } };
    const g = globalThis as { __ink?: Record<string, unknown> };
    g.__ink = { early: { key: 'p:rk', items: Promise.resolve({ 'p:rk': rec }) } };
    try {
      const s = setup({ stored: { [ik]: index } });
      await s.flush();
      expect(s.get.mock.calls.map((c) => c[0])).toEqual([[ik, 'cfg']]);
      const ctx = (s.loader.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        pre: Promise<Record<string, unknown>>;
      };
      expect((await ctx.pre)['p:rk']).toBe(rec);
      // Another slot: the early read is not used.
      g.__ink = { early: { key: 'p:other', items: Promise.resolve({}) } };
      const t = setup({ stored: { [ik]: index, 'p:rk': rec } });
      await t.flush();
      expect(t.get.mock.calls.map((c) => c[0])).toEqual([[ik, 'cfg'], 'p:rk']);
    } finally {
      delete g.__ink;
    }
  });

  test('a page without ink reads storage once and loads nothing', async () => {
    const s = setup({ stored: {} });
    await s.flush();
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.loader.start).not.toHaveBeenCalled();
  });

  test('site off from the bar reaches the stub through the loader', async () => {
    const s = setup({ stored: { [idxKey('a.test')]: { v: 1, m: { x: 'y' } } } });
    await s.flush();
    const ctx = (s.loader.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { off: () => void };
    ctx.off();
    await s.flush();
    expect(s.viewer.destroy).toHaveBeenCalled();
    expect(await s.send({ ink: 'state' })).toMatchObject({ off: true });
  });
});

describe('stub on a PDF document', () => {
  test('hands the page to the PDF chunk with the settings, loads no viewer and drops its pen listener', async () => {
    const cfg = { pdf: false, modifier: 'Alt' };
    const s = setup({ contentType: 'application/pdf', stored: { cfg, [idxKey('a.test')]: { v: 1, m: {} } } });
    await s.flush();
    await s.flush();
    expect(s.load).toHaveBeenCalledWith('pdf');
    expect(s.load).not.toHaveBeenCalledWith('loader');
    expect(s.pdf.start).toHaveBeenCalledTimes(1);
    expect(s.pdf.start.mock.calls[0]![0]).toMatchObject({ cfg });
    expect(s.removed.some((l) => l.type === 'pointerdown')).toBe(true);
    s.pointer('pointerdown', 'pen');
    await s.flush();
    expect(s.load).not.toHaveBeenCalledWith('loader');
  });

  test('leaves a PDF alone on a site where ink is off', async () => {
    const s = setup({ contentType: 'application/pdf', stored: { cfg: { off: ['a.test'] } } });
    await s.flush();
    expect(s.load).not.toHaveBeenCalled();
  });

  test('ordinary pages never load the PDF chunk', async () => {
    const s = setup({ stored: { [idxKey('a.test')]: { v: 1, m: {} } } });
    await s.flush();
    expect(s.load).not.toHaveBeenCalledWith('pdf');
  });
});
