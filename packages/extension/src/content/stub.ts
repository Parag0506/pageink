/**
 * The stub. The only code on every page (DESIGN 5, promise 1; CONTRACT 4).
 * Top frame: one storage read and one pen listener. Subframes: no read.
 * It never touches the DOM, reads layout or messages the background unless
 * the page has ink, a pen touches down or the reader asks to draw.
 */
import { hashKey, idxKey } from 'pageink-core/hash';
import type { Front, FrontType, InkCommands, InkConfig, Viewer } from 'pageink-core/types';
import type { Api } from '../api';
import type { StateReply, ToContent } from '../messages';
import { diagOf, type Load, world } from './modules';

export interface StubEnv {
  win: Window;
  api: Api;
  load: Load;
  /** Build default for cfg.penReady. */
  penReady: boolean;
  /** Test seam. Without it only events the browser made count, never ones a page script made. */
  real?: (e: Event) => boolean;
}

/**
 * Window listeners added at document start, before the page's scripts, so a
 * page that stops events at the window cannot hide them from the ink. Not
 * pointerrawupdate: in a same-process frame it carries the top page's coordinates.
 */
const FRONT: FrontType[] = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'];

/** The stylus listeners, which hold a Pencil touch back before the tools load. */
const TOUCH = ['touchstart', 'touchmove'];

/**
 * True when a stored host list holds the host. Settings are read raw here, so a list of the
 * wrong type counts as empty: a string would match by substring.
 */
const listed = (v: unknown, host: string): boolean => Array.isArray(v) && v.includes(host);

export function startStub(env: StubEnv): void {
  const { win, api, load } = env;
  const real = env.real ?? ((e: Event) => e.isTrusted);
  let spent = 0;
  const t0 = __INK_BENCH__ ? win.performance.now() : 0;
  // When the stub starts: after the browser has parsed and run the whole content script.
  if (__INK_BENCH__) win.performance.mark('ink:stub-start', { startTime: t0 });
  const top = win === win.top;
  const host = win.location.hostname;
  // Not passive: a stroke swallows the click that follows it, and pointer events never block scrolling.
  const cap = { capture: true };
  const block = { capture: true, passive: false };
  let cfg: Partial<InkConfig> | undefined;
  let off = false;
  let viewer: Promise<Viewer> | undefined;
  let ready: Promise<[Viewer, InkCommands]> | undefined;
  let buf: PointerEvent[] | undefined;
  const subs: Partial<Record<string, ((e: Event) => void)[]>> = {};
  const front: Front = {
    on(type, fn) {
      const list = subs[type] ?? [];
      subs[type] = list;
      list.push(fn);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
  };

  // The bench build times the stub. Release builds leave this out.
  const done = (t: number) => {
    if (!__INK_BENCH__) return;
    spent += win.performance.now() - t;
    win.performance.measure('ink:stub', { start: t0, duration: spent });
  };
  // Before the tools are in, a pen-down loads them and the gesture is kept for them.
  const route = (e: Event) => {
    if (!real(e)) return;
    const list = subs[e.type];
    if (e.type === 'pointerdown') {
      // While the tools load, more pen-downs join the buffer. Once they are in, capture has them.
      if (!list?.length && (!ready || buf)) pen(e as PointerEvent);
    } else if (buf && e.type !== 'click') buf.push(e as PointerEvent);
    // A consumer that stops the event, such as a stroke swallowing its click, stops the rest.
    if (list) for (const f of [...list]) if (!e.cancelBubble) f(e);
  };
  const listen = (on: boolean, types: string[], fn: (e: never) => void, o: AddEventListenerOptions) => {
    for (const t of types)
      on
        ? win.addEventListener(t, fn as EventListener, o)
        : win.removeEventListener(t, fn as EventListener, o);
  };

  const view = (pre?: Promise<Record<string, unknown>>, withTools?: boolean) => {
    viewer ??= load('loader', withTools).then((m) => m.start({ api, cfg, top, off: halt, front, pre }));
    return viewer;
  };

  // Load the viewer and the tools. Pointer events seen meanwhile are handed over.
  const tools = (e?: PointerEvent) => {
    if (off) return;
    buf ??= [];
    if (e) buf.push(e);
    if (__INK_DIAG__ && e && !diagOf().downAt) diagOf().downAt = e.timeStamp;
    ready ??= view(undefined, true).then(async (v) => {
      const cmd = await v.tools();
      // Capture owns input from here on, through the front.
      listen(false, TOUCH, stylus, block);
      const b = buf ?? [];
      buf = undefined;
      if (__INK_DIAG__) {
        diagOf().buffered = b.length;
        diagOf().adoptedAt = win.performance.now();
      }
      v.adopt(b);
      return [v, cmd];
    });
    return ready;
  };

  function pen(e: PointerEvent) {
    if (off) return;
    const mod = cfg?.modifier ?? 'Alt';
    if (e.pointerType === 'pen' || (e.pointerType === 'mouse' && mod !== 'none' && e.getModifierState(mod)))
      tools(e);
  }

  // A Pencil touch would scroll before the tools load. Block it for stylus only.
  function stylus(ev: Event) {
    if (!real(ev)) return;
    const e = ev as TouchEvent;
    for (const t of e.changedTouches) {
      if ((t as Touch & { touchType?: string }).touchType === 'stylus') {
        e.preventDefault();
        if (__INK_DIAG__) {
          const d = diagOf();
          d.stylus++;
          if (e.defaultPrevented) d.stylusCancelled++;
        }
        return;
      }
    }
  }

  // Ink switched off for the site: the ink leaves the page and the stub goes quiet.
  function halt() {
    off = true;
    listen(false, FRONT, route, cap);
    listen(false, TOUCH, stylus, block);
    viewer?.then(
      (v) => v.destroy(),
      () => {},
    );
    viewer = ready = buf = undefined;
  }

  // Top frame: one read of the index and settings. Subframes: no read.
  const begin = () => {
    off = false;
    listen(true, FRONT, route, cap);
    if (!top) {
      if (env.penReady) listen(true, TOUCH, stylus, block);
      return;
    }
    const key = idxKey(host);
    api.storage.local.get([key, 'cfg']).then((r) => {
      const t = __INK_BENCH__ ? win.performance.now() : 0;
      cfg = r.cfg as Partial<InkConfig> | undefined;
      if (listed(cfg?.off, host)) halt();
      else if (win.document.contentType === 'application/pdf') {
        // The browser's PDF viewer: no ink here. The PDF chunk may hand it to the extension's viewer.
        // Safari keeps its own viewer, so its build has no PDF chunk.
        halt();
        if (__INK_TARGET__ !== 'safari') load('pdf').then((m) => m.start({ api, cfg }));
      } else {
        // A pen that needs the draw toggle must still scroll the page like a finger.
        if ((cfg?.penReady ?? env.penReady) && !cfg?.penNeedsToggle) listen(true, TOUCH, stylus, block);
        // The page's record is read while the loader is fetched, so the viewer starts with it.
        // The index maps the hash of an address to the hash of its record key.
        // The record read here is only a hint: the loader hands it on only after the store's check.
        const ix = r[key] as { m?: Record<string, string> } | undefined;
        const sk = `p:${ix?.m?.[hashKey(win.location.href.split('#')[0]!)]}`;
        // On hosts with ink the boot script has usually started this read already.
        const e = world().early;
        if (ix)
          view(
            (e?.key === sk ? e.items : api.storage.local.get(sk)).then((p) => ({
              [key]: ix,
              cfg,
              [sk]: p[sk],
            })),
          );
        // Draw mode left on at this site: the viewer turns it back on.
        else if (cfg?.rememberDraw !== false && listed(cfg?.drawOn, host)) view();
      }
      done(t);
    });
  };

  api.runtime.onMessage.addListener((m: ToContent, _s, reply: (r?: unknown) => void) => {
    if (!m || typeof m.ink !== 'string') return;
    if (m.ink === 'state') {
      const r: StateReply = { loaded: false, off, draw: false, notes: 0 };
      if (!viewer || off) return reply(r);
      viewer.then(
        (v) => {
          const s = v.state();
          reply({ ...r, loaded: true, draw: s.draw, notes: s.notes });
        },
        () => reply(r),
      );
      return true;
    }
    if (m.ink === 'site') {
      if (!m.on) halt();
      else if (off) begin();
      return;
    }
    if (off) return;
    if (m.ink === 'draw') {
      tools()?.then(
        ([v, cmd]) => reply(cmd.setDraw(m.on ?? !v.state().draw)),
        () => reply(),
      );
      return true;
    } else if (m.ink === 'wake') {
      view();
    } else if (m.ink === 'framePath') {
      const getFrameId = (api.runtime as { getFrameId?: (el: Element) => number }).getFrameId;
      if (!getFrameId) return;
      for (const el of win.document.querySelectorAll('iframe,frame')) {
        if (getFrameId(el) === m.frameId) {
          load('loader').then(
            (l) => reply(l.pathOf(el)),
            () => reply(),
          );
          return true;
        }
      }
    }
  });

  begin();
  done(t0);
}
