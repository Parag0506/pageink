/**
 * The view chunk. It loads the page record and paints it. Drawing tools arrive
 * later through a dynamic import (CONTRACT 3, DESIGN 5 promise 1), so this file
 * imports concrete files and never the capture, ui or notes folders, nor the
 * describe half of anchor.
 */
import { pageIdentity } from '../anchor/identity';
import { createResolver } from '../anchor/resolve';
import { LAYER_TAG } from '../brand';
import { CFG_KEY, pageKeyOf } from '../hash';
import { createPlacer } from '../place/placer';
import { createLayer, type InkLayer } from '../render/layer';
import { merge } from '../store/merge';
import { applyPatch, emptyRecord, showsInk } from '../store/patch';
import { BadRecordError, storeOver } from '../store/store';
import type {
  AnchorContext,
  AttachTools,
  CreateViewer,
  InkCommands,
  InkConfig,
  InkState,
  InkWarning,
  Layer,
  Note,
  PageIdentity,
  PageRecord,
  Placer,
  Point,
  Store,
  TrayItem,
  Viewer,
  ViewerInternals,
  ViewerOptions,
} from '../types';
import { memoryOverKV } from './memkv';

/** Shown in the bar while ink is kept in memory only. */
export const SAVE_WARN = 'Not saved yet. Your ink stays on this page and is saved on your next change.';
export const FULL_WARN =
  'Not saved: storage is full. Delete notes you no longer need in the settings, then write again.';
export const RECORD_WARN =
  'Not saved: this page has ink from a newer version. Update the extension to save here.';
/** Shown when draw mode comes back on by itself at a site where the reader left it on. */
export const DRAW_TIP = 'Draw mode is on for this site. Press Esc or Draw to stop.';

/**
 * True when the browser has translated the page. Chromium marks <html> with a class.
 * Chromium, Firefox (123 and later) and Safari change an existing `lang` on <html>, so a
 * `lang` that differs from the one the page had at load counts too. Edge marks the
 * translated text with its own attributes. A page with no `lang` that Firefox or Safari
 * translates shows no sign we can read.
 */
export function isTranslated(doc: Document, lang0: string): boolean {
  const html = doc.documentElement;
  if (html.classList.contains('translated-ltr') || html.classList.contains('translated-rtl')) return true;
  const lang = html.getAttribute('lang') ?? '';
  if (lang0 && lang && lang.toLowerCase() !== lang0.toLowerCase()) return true;
  return !!doc.querySelector('[_msttexthash]');
}

/** True for a write that failed because storage is full. Browsers word this differently. */
export const isQuotaError = (err: unknown): boolean => {
  const e = err as { name?: string; message?: string } | null;
  const text = `${e?.name ?? ''} ${e?.message ?? String(err)}`;
  return /quota|QUOTA_BYTES|storage is full|disk is full|NS_ERROR_DOM_QUOTA_REACHED/i.test(text);
};
/** The page counts as settled after its load event and this long without DOM changes. */
export const QUIET_MS = 1000;

type Tools = ReturnType<AttachTools>;

/** What the quiet handle waits on: the load event, then an idle slice. */
interface HandleWait {
  load?: (() => void) | undefined;
  idle?: number;
  timer?: number;
}

const BASE_STATE: InkState = {
  draw: false,
  tool: 'pen',
  color: 'ink-1',
  canUndo: false,
  canRedo: false,
  notes: 0,
  tray: 0,
  selected: [],
  theme: 'light',
  off: false,
};

/** Cheap change test for a note. applyPatch and merge both move updatedAt on any change. */
const sig = (n: Note): string =>
  `${n.updatedAt}|${n.strokes.length}|${n.strokes[n.strokes.length - 1]?.id ?? ''}`;

const isOff = (cfg: InkConfig, id: PageIdentity): boolean => cfg.off.includes(id.host);

/**
 * A viewer that also shows its record. The extension reads it to tell whether
 * the page has notes inside frames, so it wakes frames only when it must.
 */
export interface InkViewer extends Viewer {
  /** The page record as shown now. Null while ink is off for the site. */
  record(): PageRecord | null;
}

export const createViewer: CreateViewer = (opts) => createInkViewer(opts);

export async function createInkViewer(opts: ViewerOptions): Promise<InkViewer> {
  const doc = opts.doc ?? document;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  const hooks = opts.hooks ?? {};
  // Timings go to the host. The extension's bench build turns them into performance marks.
  const now = opts.now ? (): number => opts.now!() : (): number => performance.now();
  const t0 = now();
  hooks.onTiming?.('view.start', 0);

  // Each problem goes to the host once, so a full disk does not flood it.
  const told = new Set<string>();
  const tell = (w: InkWarning): void => {
    const k = `${w.kind}|${w.key}`;
    if (told.has(k)) return;
    told.add(k);
    hooks.onWarn?.(w);
  };
  const onBadRecord = (key: string, message: string): void => tell({ kind: 'record', key, message });
  // A private window writes nothing until it knows the reader asked to keep private ink.
  let kv = opts.private ? memoryOverKV(opts.kv) : opts.kv;
  let store = storeOver(kv, { onBadRecord });
  const identityNow = (): PageIdentity => opts.identity ?? pageIdentity(win.location.href, doc);
  let id = identityNow();
  // Settings and the record are read together: one storage round trip instead of two.
  let [stored, loaded] = await Promise.all([store.config(), store.load(id)]);
  const memoryOnly = !!opts.private && !{ ...stored, ...opts.config }.privateKeep;
  if (opts.private && !memoryOnly) {
    kv = opts.kv;
    store = storeOver(kv, { onBadRecord });
    [stored, loaded] = await Promise.all([store.config(), store.load(id)]);
  }
  // Host overrides apply in memory only. Nothing writes this object back.
  const config: InkConfig = { ...stored, ...opts.config };
  if (!opts.hideSiteOff && isOff(config, id)) return offViewer(store, id, opts);
  // A new device id is stored behind this load, and another tab may store its own first. The
  // stored one is kept, and this viewer writes with it from then on. Nothing waits for this.
  const adopt = (): void =>
    void store.config().then(
      (c) => {
        if (!opts.config?.device) config.device = c.device;
      },
      () => {},
    );
  adopt();
  const unCfg = kv.onChange?.((c) => {
    if (CFG_KEY in c) adopt();
  });

  let layer: Layer | null = null;
  let placer: Placer | null = null;
  const ctx: AnchorContext = {
    doc,
    isOurs: (el) => el === layer?.host || el.localName === LAYER_TAG,
  };
  if (opts.shadowRootOf) ctx.shadowRootOf = opts.shadowRootOf;
  if (opts.now) ctx.now = now;
  const resolver = createResolver(ctx);

  // A subframe shows only its own notes. The top document shows notes with no frame.
  // An ink note the merge left with no strokes shows nothing and is not counted.
  const visible = (n: Note): boolean =>
    showsInk(n) && (opts.frame ? n.anchor.frame?.url === opts.frame.url : !n.anchor.frame);

  let rec: PageRecord = loaded ?? emptyRecord(id, doc.title);
  let destroyed = false;

  // ---- state ---------------------------------------------------------------

  let st: InkState = { ...BASE_STATE, ...(memoryOnly ? { memoryOnly: true } : {}) };
  const subs = new Set<(s: InkState) => void>();
  const emit = (): void => {
    for (const cb of [...subs]) cb(st);
    hooks.onState?.(st);
  };
  const setState = (p: Partial<InkState>): void => {
    st = { ...st, ...p };
    emit();
  };
  const countNotes = (): number => rec.notes.reduce((k, n) => k + (visible(n) ? 1 : 0), 0);

  // ---- tray ------------------------------------------------------------------

  let settled = false;
  let settleMo: MutationObserver | null = null;
  let quietTimer = 0;
  let onLoadEv: (() => void) | null = null;
  let unplaced: Note[] = [];

  // ---- translated pages ------------------------------------------------------
  // While the browser shows a translation, notes whose words no longer match are held, not
  // missing: the tray lists them apart, and they return when the original is shown.
  const lang0 = doc.documentElement.getAttribute('lang') ?? '';
  let translated = isTranslated(doc, lang0);
  const langMo = new MutationObserver(() => {
    const t = isTranslated(doc, lang0);
    if (t === translated) return;
    translated = t;
    resolver.invalidate();
    placer?.refresh('translated');
    updateTray();
  });
  langMo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'lang'] });
  /** Notes out of place for good reason: none, unless the page is translated. */
  const held = (): Note[] => (translated ? unplaced : []);
  const missing = (): Note[] => (translated ? [] : unplaced);

  const trayItems = (): TrayItem[] =>
    unplaced
      .map((note): TrayItem => {
        const it: TrayItem = {
          note,
          state: translated ? 'translated' : settled ? 'missing' : 'waiting',
          quote: note.anchor.quote.exact,
          relY: Math.min(1, Math.max(0, note.anchor.frac?.y ?? 0)),
        };
        if (note.anchor.link) it.link = note.anchor.link;
        if (note.thumb) it.thumb = note.thumb;
        return it;
      })
      .sort((a, b) => a.relY - b.relY);

  const stopSettle = (): void => {
    settleMo?.disconnect();
    settleMo = null;
    if (quietTimer) win.clearTimeout(quietTimer);
    quietTimer = 0;
    if (onLoadEv) win.removeEventListener('load', onLoadEv);
    onLoadEv = null;
  };

  const quiet = (): void => {
    if (quietTimer) win.clearTimeout(quietTimer);
    quietTimer = win.setTimeout(() => {
      stopSettle();
      settled = true;
      updateTray();
    }, QUIET_MS);
  };

  /** Waits for the load event, then for a quiet spell. Runs only while notes are missing. */
  const watchSettle = (): void => {
    if (settled || settleMo || onLoadEv || destroyed) return;
    const begin = (): void => {
      onLoadEv = null;
      if (settled || destroyed) return;
      settleMo = new MutationObserver((list) => {
        for (const r of list) {
          if (layer && (r.target === layer.host || layer.host.contains(r.target))) continue;
          quiet();
          return;
        }
      });
      settleMo.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
      quiet();
    };
    if (doc.readyState === 'complete') begin();
    else {
      onLoadEv = begin;
      win.addEventListener('load', begin, { once: true });
    }
  };

  const openTray = (id?: string, byKey?: boolean): void => {
    void loadTools()
      .then((t) => t.openTray?.(id, byKey))
      .catch(() => {});
  };

  /** Page edge markers for moved notes (DESIGN 7.4 step 5). Shown once the page has settled. */
  const updateMarkers = (): void => {
    const l = layer as InkLayer | null;
    if (!l) return;
    const items = settled ? trayItems().filter((it) => it.state !== 'translated') : [];
    l.setMarkers(
      items.map((it) => ({
        id: it.note.id,
        relY: it.relY,
        label: it.quote ? `Moved note: “${it.quote}”` : 'Moved note',
      })),
      openTray,
    );
  };

  function updateTray(): void {
    if (unplaced.length && !settled) watchSettle();
    if (!unplaced.length) stopSettle();
    // Edge marks text, not <html>, so a page with notes out of place is checked again here.
    if (!translated && unplaced.length && isTranslated(doc, lang0)) translated = true;
    const n = missing().length;
    const h = held().length;
    const heldChanged = h !== (st.held ?? 0);
    if (heldChanged) st = { ...st, held: h };
    // The badge waits until the page has settled, so late content does not flash it.
    // Once the tools are in, the bar shows its own count and the badge steps aside.
    layer?.setBadge(settled && !toolsNow ? n : 0, () => openTray());
    updateMarkers();
    const theme = layer?.theme() ?? st.theme;
    if (n !== st.tray || theme !== st.theme || heldChanged) setState({ tray: n, theme });
    else if (settled) emit();
  }

  // ---- drawing ---------------------------------------------------------------

  let readyFn: () => void = () => {};
  const ready = new Promise<void>((r) => {
    readyFn = r;
  });
  let firstPass: (() => void) | null = readyFn;
  let passWaiters: (() => void)[] = [];
  let firstInk = false;

  const onChange = (_placed: unknown, un: Note[]): void => {
    const was = unplaced;
    unplaced = un;
    if (was.length !== un.length || was.some((n, i) => n !== un[i]) || layer?.theme() !== st.theme)
      updateTray();
    // The page may have grown or shrunk, so the markers follow its new height.
    else if (un.length && settled) updateMarkers();
    // A pass is complete for its waiters once every note is decided.
    if (placer?.waiting?.()) return;
    firstPass?.();
    firstPass = null;
    const w = passWaiters;
    passWaiters = [];
    for (const f of w) f();
  };

  const onTiming = (name: string, ms: number): void => {
    hooks.onTiming?.(name, ms);
    if (name === 'place.first' && !firstInk) {
      firstInk = true;
      hooks.onTiming?.('view.first-ink', now() - t0);
    } else if (name === 'place.all') {
      hooks.onTiming?.('view.placed', now() - t0);
    }
  };

  const ensure = (): { layer: Layer; placer: Placer } => {
    if (!layer || !placer) {
      layer = createLayer(doc, { theme: config.theme });
      placer = createPlacer({ doc, resolver, layer, onChange, onTiming, ...(opts.now ? { now } : {}) });
      st = { ...st, theme: layer.theme() };
    }
    return { layer, placer };
  };

  const nextPass = (): Promise<void> => new Promise((r) => passWaiters.push(r));

  /** Bring the placer in line with a new record. Only notes that changed are touched. */
  const sync = (
    prev: PageRecord,
    next: PageRecord,
    known?: Record<string, { origin: Point; scale: number }>,
  ) => {
    const old = new Map<string, Note>();
    for (const n of prev.notes) if (visible(n)) old.set(n.id, n);
    const keep = new Set<string>();
    for (const n of next.notes) {
      if (!visible(n)) continue;
      keep.add(n.id);
      const o = old.get(n.id);
      if (o === n || (o && sig(o) === sig(n) && !known?.[n.id])) continue;
      ensure().placer.upsert(n, known?.[n.id]);
    }
    for (const oid of old.keys()) if (!keep.has(oid)) placer?.remove(oid);
    const notes = countNotes();
    if (notes !== st.notes) setState({ notes });
  };

  // ---- saving ----------------------------------------------------------------

  // A save starts as soon as there is a change, so a tab closed right after a
  // stroke still keeps it. Changes made while a save runs go out in one write
  // when it ends. A failed save keeps the change in memory, shows a quiet
  // warning and is tried again on the next change or when the tab is hidden.
  let dirty = false;
  let busy = false;
  let saving: Promise<void> = Promise.resolve();

  const absorb = (incoming: PageRecord): void => {
    if (destroyed || incoming.key !== rec.key) return;
    const prev = rec;
    rec = merge(rec, incoming);
    sync(prev, rec);
  };

  const flush = (): Promise<void> => {
    if (busy || !dirty) return saving;
    dirty = false;
    busy = true;
    const snap = rec;
    const sid = id;
    saving = store
      .save(snap, sid)
      .then(absorb)
      .then(
        () => {
          busy = false;
          told.delete(`save|${pageKeyOf(snap.key)}`);
          if (st.warn && !destroyed) setState({ warn: undefined });
          if (dirty) void flush();
        },
        (err: unknown) => {
          busy = false;
          dirty = true;
          if (destroyed) return;
          const bad = err instanceof BadRecordError;
          const warn = bad ? RECORD_WARN : isQuotaError(err) ? FULL_WARN : SAVE_WARN;
          if (st.warn !== warn) setState({ warn });
          if (!bad)
            tell({ kind: 'save', key: pageKeyOf(snap.key), message: String((err as Error)?.message ?? err) });
        },
      );
    return saving;
  };

  const scheduleSave = (): void => {
    dirty = true;
    void flush();
  };

  // A page frozen in the back-forward cache or in a background tab misses storage events.
  // When it comes back, it reads its record again and places its notes afresh.
  const resync = (): void => {
    if (destroyed) return;
    const key = rec.key;
    void store
      .load(id)
      .then((r) => {
        if (r && r.key === key) absorb(r);
      })
      .catch(() => {});
    placer?.refresh('resume');
  };
  const onHide = (): void => void flush();
  const onShow = (e: PageTransitionEvent): void => {
    if (e.persisted) resync();
  };
  const onVis = (): void => {
    if (doc.visibilityState === 'hidden') void flush();
    else resync();
  };
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', onShow);
  doc.addEventListener('visibilitychange', onVis);
  doc.addEventListener('resume', resync);

  const commit: ViewerInternals['commit'] = (patch, known) => {
    if (destroyed) return;
    const prev = rec;
    rec = applyPatch(rec, patch);
    sync(prev, rec, known);
    scheduleSave();
  };

  // ---- other tabs, frames and folder sync -------------------------------------

  let unwatch = (): void => {};
  const watch = (): void => {
    unwatch();
    unwatch = store.watch(rec.key, (remote) => {
      if (remote) absorb(remote);
    });
  };
  watch();

  // ---- tools -------------------------------------------------------------------

  const swapSubs = new Set<() => void>();
  let tools: Promise<Tools> | null = null;
  let toolsNow: Tools | null = null;
  const viewer: InkViewer = {
    ready,
    state: () => st,
    record: () => (destroyed ? null : rec),
    tools: () => loadTools().then((t) => t.cmd),
    adopt(events) {
      void loadTools()
        .then((t) => t.adopt(events))
        .catch(() => {});
    },
    reload,
    destroy,
  };

  function internals(): ViewerInternals {
    const { layer: l, placer: p } = ensure();
    return {
      opts,
      doc,
      store,
      layer: l,
      placer: p,
      resolver,
      ctx,
      config,
      identity: () => id,
      record: () => rec,
      commit,
      setState,
      state: () => st,
      subscribe(cb) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      tray: trayItems,
      onSwap(cb) {
        swapSubs.add(cb);
        return () => swapSubs.delete(cb);
      },
      destroy,
    };
  }

  function loadTools(): Promise<Tools> {
    if (destroyed) return Promise.reject(new Error('ink: viewer is gone'));
    tools ??= (opts.loadTools ?? (() => import('./tools')))().then((m) => {
      if (destroyed) throw new Error('ink: viewer is gone');
      toolsNow = m.attachTools(internals());
      dropHandle();
      if (unplaced.length) updateTray();
      return toolsNow;
    });
    return tools;
  }

  // ---- quiet handle ------------------------------------------------------------------
  // Touch and mouse readers have no pen to wake the tools. Once the page is idle, a small
  // handle shows where the bar would be. The tools load only when it is used.

  let handleWait = null as HandleWait | null;
  const dropHandle = (): void => {
    const w = handleWait;
    handleWait = null;
    if (w?.load) win.removeEventListener('load', w.load);
    if (w?.idle) win.cancelIdleCallback?.(w.idle);
    if (w?.timer) win.clearTimeout(w.timer);
    (layer as Partial<InkLayer> | null)?.setHandle?.(null);
  };
  const showHandleSoon = (): void => {
    if (!opts.showHandle || tools || handleWait) return;
    const w: HandleWait = {};
    handleWait = w;
    const show = (): void => {
      if (handleWait !== w || destroyed || tools) return;
      (ensure().layer as Partial<InkLayer>).setHandle?.(() => void loadTools().catch(() => {}));
    };
    const idle = (): void => {
      w.load = undefined;
      if (win.requestIdleCallback) w.idle = win.requestIdleCallback(show, { timeout: 2000 });
      else w.timer = win.setTimeout(show, 200);
    };
    if (doc.readyState === 'complete') idle();
    else {
      w.load = idle;
      win.addEventListener('load', idle, { once: true });
    }
  };

  // ---- navigation and teardown ----------------------------------------------------

  async function reload(): Promise<void> {
    if (destroyed) return;
    await flush();
    // A change made during that save went out in a follow-up write. Wait for it too.
    await saving;
    const next = identityNow();
    const loaded = await store.load(next);
    if (destroyed) return;
    const prev = rec;
    id = next;
    if (loaded && loaded.key === rec.key) {
      absorb(loaded);
      return;
    }
    if (!loaded && next.key === rec.key) return;
    rec = loaded ?? emptyRecord(next, doc.title);
    watch();
    stopSettle();
    settled = false;
    resolver.invalidate();
    for (const cb of [...swapSubs]) cb();
    const notes = rec.notes.filter(visible);
    if (placer || notes.length) {
      const pass = nextPass();
      ensure().placer.setNotes(notes);
      setState({ notes: notes.length });
      await pass;
    } else if (prev.notes.length) setState({ notes: 0 });
  }

  function destroy(): void {
    if (destroyed) return;
    void flush();
    dropHandle();
    destroyed = true;
    unwatch();
    unCfg?.();
    langMo.disconnect();
    stopSettle();
    win.removeEventListener('pagehide', onHide);
    win.removeEventListener('pageshow', onShow);
    doc.removeEventListener('visibilitychange', onVis);
    doc.removeEventListener('resume', resync);
    toolsNow?.destroy();
    toolsNow = null;
    placer?.destroy();
    layer?.destroy();
    placer = null;
    layer = null;
    firstPass?.();
    for (const f of passWaiters) f();
    passWaiters = [];
    subs.clear();
    swapSubs.clear();
  }

  // ---- first paint -------------------------------------------------------------------

  const first = rec.notes.filter(visible);
  st = { ...st, notes: first.length };
  if (first.length) ensure().placer.setNotes(first);
  else {
    firstPass?.();
    firstPass = null;
  }
  showHandleSoon();
  // Draw mode left on at this site comes back on, with the bar up and saying so.
  if (config.rememberDraw !== false && config.drawOn?.includes(id.host)) {
    void loadTools()
      .then((t) => {
        if (destroyed || st.draw) return;
        t.cmd.setDraw(true);
        setState({ tip: DRAW_TIP });
      })
      .catch(() => {});
  }
  return viewer;
}

/**
 * A viewer for a site where ink is off. It touches nothing. Turning the site
 * back on is its one command: it saves the setting, then builds a full viewer
 * and hands every call to it, so the page works without a reload.
 */
function offViewer(store: Store, id: PageIdentity, opts: ViewerOptions): InkViewer {
  let st: InkState = { ...BASE_STATE, off: true };
  let live: InkViewer | null = null;
  let waking: Promise<InkViewer> | null = null;
  let gone = false;
  const noop = (): void => {};
  const none = async (): Promise<void> => {};
  const cmd: InkCommands = {
    setDraw: noop,
    setTool: noop,
    setColor: noop,
    undo: noop,
    redo: noop,
    place: noop,
    deleteNotes: noop,
    joinSelected: noop,
    splitSelected: noop,
    clearSelection: noop,
    clearPage: noop,
    exportImage: none,
    exportMarkdown: none,
    copyForChat: none,
    print: noop,
    setSiteOff(off) {
      if (off || waking) return;
      st = { ...st, off: false };
      opts.hooks?.onState?.(st);
      waking = store
        .config()
        .then((c) => store.setConfig({ off: c.off.filter((h) => h !== id.host) }))
        .then(() => createInkViewer(opts))
        .then((v) => {
          if (gone) v.destroy();
          else live = v;
          return v;
        });
      waking.catch(() => {
        waking = null;
      });
    },
  };
  return {
    ready: Promise.resolve(),
    state: () => live?.state() ?? st,
    record: () => live?.record() ?? null,
    tools: async () => (live ? live.tools() : cmd),
    adopt: (events) => live?.adopt(events),
    reload: () => live?.reload() ?? none(),
    destroy() {
      gone = true;
      live?.destroy();
      live = null;
    },
  };
}
