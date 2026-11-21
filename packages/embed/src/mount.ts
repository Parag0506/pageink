import { pageKeyOf } from 'pageink-core';
import { pageIdentity } from 'pageink-core/anchor';
import { NAME } from 'pageink-core/brand';
import { svgToPng } from 'pageink-core/render';
import type {
  FolderIO,
  InkConfig,
  InkState,
  KV,
  Note,
  PageIdentity,
  Rect,
  SyncReport,
  Theme,
  Tool,
  Viewer,
  ViewerInternals,
} from 'pageink-core/types';
import { createViewer } from 'pageink-core/view';
import { indexedDbKV } from './kv/idb';
import { localKV, type OwnedKV } from './kv/local';
import { legacySurface } from './legacy';

export interface MountOptions {
  /**
   * Where ink is kept. "indexeddb" (default), "local" for localStorage, or any object
   * that implements KV, for sites that keep reader data in their own database.
   */
  store?: 'indexeddb' | 'local' | KV;
  /**
   * Fixed identity for this page's ink. Use it when the page address is not stable.
   * Default: the page address, normalised the way the extension does it.
   */
  page?: string;
  /**
   * False (default): a pen writes with no toggle, and touch and mouse write only with the draw
   * toggle on. True: the pen needs the toggle too, like touch and mouse.
   */
  penNeedsToggle?: boolean;
  /** Older name. `penOnly: false` is the same as `penNeedsToggle: true`. */
  penOnly?: boolean;
  /** Ink colours for a light or dark page. Default "auto" reads the page background. */
  theme?: Theme | 'auto';
  /** Key that lets a mouse write while held, with the toggle off. Default "Alt". */
  modifier?: InkConfig['modifier'];
  /** The tool bar hides after this long without ink input. Default 4000. */
  barHideMs?: number;
  /**
   * "eager" (default) loads the tool bar at mount. "lazy" loads it on the first pen
   * contact or the first call that needs it, so pages that only show ink stay light.
   */
  tools?: 'lazy' | 'eager';
  /** Selector for sections that hold ink migrated from the earlier pencil layer. */
  legacy?: string;
  /**
   * True (default): with lazy tools, a small draw handle shows once the page is idle, so touch
   * and mouse readers can find drawing. The tools load only when it is used.
   */
  handle?: boolean;
}

export type InkEvent = 'state' | 'change';

export interface InkExports {
  /** This page's notes as Markdown. */
  markdown(): Promise<string>;
  /** The ink over a document rect as a PNG. Default: the part of the page in view. */
  png(area?: Rect): Promise<Blob>;
  /** Every page's ink in this store, as a zip in the backup folder layout. */
  archive(): Promise<Uint8Array>;
}

export interface InkHandle {
  /** Resolves when the ink is on screen, and the tool bar too when tools are eager. */
  ready: Promise<void>;
  /** Turn the draw toggle on or off. */
  draw(on?: boolean): Promise<void>;
  tool(name: Tool): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  state(): InkState;
  /** "state": the tool state changed. "change": this page's stored ink changed. Returns an unsubscribe. */
  on(event: 'state', cb: (s: InkState) => void): () => void;
  on(event: 'change', cb: () => void): () => void;
  export: InkExports;
  /** Merge an archive made by export.archive() or by the extension. */
  importArchive(bytes: Uint8Array | ArrayBuffer | Blob): Promise<SyncReport>;
  /** Two-way sync with a folder. Safe to run at any time. */
  sync(folder: FolderIO): Promise<SyncReport>;
  /** Add notes to this page, for example from migrateLegacy. Adding the same notes twice is harmless. */
  addNotes(notes: Note[]): Promise<void>;
  /** Save, then remove the ink and the tools from the page. */
  destroy(): Promise<void>;
}

const IDLE: InkState = {
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

let active = false;

function fixedIdentity(page: string): PageIdentity {
  const host = location.hostname;
  return { key: page, aliases: [], host, hosts: host ? [host] : [], url: page };
}

/** True inside an element marked data-ink-off, across shadow roots. */
function offAt(el: Element | null): boolean {
  for (let n: Element | null = el; n; ) {
    const hit = n.closest('[data-ink-off]');
    if (hit) return true;
    const root = n.getRootNode();
    n = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function targetOf(e: Event): Element | null {
  const t = e.composedPath()[0] ?? e.target;
  if (t instanceof Element) return t;
  return t instanceof Node ? t.parentElement : null;
}

const domReady = (): Promise<void> =>
  document.readyState === 'loading'
    ? new Promise((r) => document.addEventListener('DOMContentLoaded', () => r(), { once: true }))
    : Promise.resolve();

/** Hooks for this package's own tests. Not part of the public API. */
export interface MountSpy {
  onInternals?(v: ViewerInternals): void;
  /** The viewer's `real` test seam. The built script has no way to set it. */
  real?(e: Event): boolean;
}

/** Start ink on this page. One mount at a time; destroy the handle before mounting again. */
export function mount(options: MountOptions = {}): InkHandle {
  return mountWith(options);
}

export function mountWith(o: MountOptions = {}, spy: MountSpy = {}): InkHandle {
  if (active)
    throw new Error(
      `${NAME} is already mounted on this page. Destroy the first handle before mounting again.`,
    );
  active = true;
  const win = window;
  const penNeedsToggle = o.penNeedsToggle ?? o.penOnly === false;
  const lazy = o.tools === 'lazy';

  let owned: OwnedKV | null = null;
  let kv: KV;
  if (o.store && typeof o.store === 'object') kv = o.store;
  else {
    owned = o.store === 'local' ? localKV() : indexedDbKV();
    kv = owned;
  }
  // Options become settings in memory only, so removing an option undoes it.
  const over: Partial<InkConfig> = {};
  if (o.theme) over.theme = o.theme;
  if (o.modifier) over.modifier = o.modifier;
  if (typeof o.barHideMs === 'number') over.barHideMs = o.barHideMs;

  const identity = (): PageIdentity =>
    o.page ? fixedIdentity(o.page) : pageIdentity(location.href, document);

  let dead = false;
  let viewer: Viewer | null = null;
  let internals: ViewerInternals | null = null;
  let toolsIn = false;

  // ---- events ----------------------------------------------------------------

  const subs = { state: new Set<(s: InkState) => void>(), change: new Set<() => void>() };
  const offChange =
    kv.onChange?.((changed) => {
      if (!subs.change.size) return;
      if (pageKeyOf(identity().key) in changed) for (const cb of [...subs.change]) cb();
    }) ?? (() => {});

  // ---- lazy tools ------------------------------------------------------------------
  // Before the tools are in, a pen that may write is buffered and handed over once they load.
  // The viewer's ignore and penNeedsToggle options keep the same rules after that.

  let buffer: PointerEvent[] | null = null;

  const loadSoon = (): void => {
    if (dead || toolsIn) return;
    void viewerP.then((v) => v.tools()).catch(() => {});
  };

  const penWrites = (): boolean => !penNeedsToggle || (viewer?.state().draw ?? false);
  const onDown = (e: PointerEvent): void => {
    if (toolsIn || e.pointerType !== 'pen' || !penWrites() || offAt(targetOf(e))) return;
    // Lazy tools: keep the pen's events and hand them over once the tools are in.
    buffer = [e];
    void viewerP
      .then((v) => v.tools().then(() => v))
      .then((v) => {
        const b = buffer;
        buffer = null;
        if (b && !dead) v.adopt(b);
      })
      .catch(() => {});
  };
  const onMove = (e: PointerEvent): void => {
    if (buffer && !toolsIn && e.pointerId === buffer[0]?.pointerId) buffer.push(e);
  };
  const onUp = onMove;
  const onOver = (e: PointerEvent): void => {
    // A hovering pen loads the tools before it touches down.
    if (e.pointerType === 'pen' && !toolsIn && penWrites() && !offAt(targetOf(e))) loadSoon();
  };
  const onNav = (): void => {
    void viewer?.reload().catch(() => {});
  };

  const cap = { capture: true, passive: true } as const;
  win.addEventListener('pointerdown', onDown, cap);
  win.addEventListener('pointermove', onMove, cap);
  win.addEventListener('pointerup', onUp, cap);
  win.addEventListener('pointercancel', onUp, cap);
  win.addEventListener('pointerover', onOver, cap);
  if (!o.page) {
    win.addEventListener('popstate', onNav);
    win.addEventListener('hashchange', onNav);
  }

  // ---- the viewer -----------------------------------------------------------------

  const viewerP: Promise<Viewer> = domReady().then(async () => {
    if (dead) throw new Error(`${NAME} was destroyed before it started.`);
    if (o.legacy) {
      for (const el of document.querySelectorAll<HTMLElement>(o.legacy)) {
        if (el.id || el.hasAttribute('data-ink-legacy-key')) legacySurface(el);
      }
    }
    const fixed = o.page ? fixedIdentity(o.page) : undefined;
    const v = await createViewer({
      kv,
      ...(fixed ? { identity: fixed } : {}),
      config: over,
      // The site owns ink on its own pages, so there is no per-site off switch.
      hideSiteOff: true,
      penNeedsToggle,
      ignore: offAt,
      showHandle: lazy && o.handle !== false,
      ...(spy.real ? { real: spy.real } : {}),
      hooks: {
        onState: (s) => {
          for (const cb of [...subs.state]) cb(s);
        },
      },
      loadTools: async () => {
        const m = await import('pageink-core/tools');
        return {
          attachTools: (vi: ViewerInternals) => {
            internals = vi;
            toolsIn = true;
            spy.onInternals?.(vi);
            return m.attachTools(vi);
          },
        };
      },
    });
    if (dead) {
      v.destroy();
      throw new Error(`${NAME} was destroyed before it started.`);
    }
    viewer = v;
    return v;
  });
  viewerP.catch(() => {});

  const ready = viewerP.then(async (v) => {
    await v.ready;
    if (!lazy && !dead && !v.state().off) await v.tools();
  });

  const cmd = () => viewerP.then((v) => v.tools());
  /** The viewer saves after a short pause. reload() writes what is pending first. */
  const flush = () => viewerP.then((v) => v.reload());
  const extras = () => import('./extras');

  let ended: Promise<void> | null = null;

  const handle: InkHandle = {
    ready,
    async draw(on = true) {
      (await cmd()).setDraw(on);
    },
    async tool(name) {
      (await cmd()).setTool(name);
    },
    async undo() {
      (await cmd()).undo();
    },
    async redo() {
      (await cmd()).redo();
    },
    state: () => viewer?.state() ?? IDLE,
    on(event: InkEvent, cb: ((s: InkState) => void) | (() => void)) {
      const set = (event === 'state' ? subs.state : subs.change) as Set<typeof cb>;
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    export: {
      async markdown() {
        await flush();
        return (await extras()).markdownOf(kv, identity());
      },
      async png(area) {
        await cmd();
        const layer = internals?.layer;
        if (!layer) throw new Error(`${NAME} is not on this page.`);
        const a = area ?? { x: win.scrollX, y: win.scrollY, w: win.innerWidth, h: win.innerHeight };
        return svgToPng(layer.toSVG(a), a.w, a.h, win.devicePixelRatio || 1);
      },
      async archive() {
        await flush();
        return (await extras()).archiveOf(kv);
      },
    },
    async importArchive(bytes) {
      const u8 =
        bytes instanceof Uint8Array
          ? bytes
          : bytes instanceof Blob
            ? new Uint8Array(await bytes.arrayBuffer())
            : new Uint8Array(bytes);
      await flush();
      const r = await (await extras()).importInto(kv, u8);
      await flush();
      return r;
    },
    async sync(folder) {
      await flush();
      const r = await (await extras()).syncWith(kv, folder);
      await flush();
      return r;
    },
    async addNotes(notes) {
      if (!notes.length) return;
      await flush();
      await (await extras()).addNotesTo(kv, identity(), document.title, notes);
      await flush();
    },
    destroy() {
      if (ended) return ended;
      dead = true;
      active = false;
      buffer = null;
      offChange();
      win.removeEventListener('pointerdown', onDown, cap);
      win.removeEventListener('pointermove', onMove, cap);
      win.removeEventListener('pointerup', onUp, cap);
      win.removeEventListener('pointercancel', onUp, cap);
      win.removeEventListener('pointerover', onOver, cap);
      win.removeEventListener('popstate', onNav);
      win.removeEventListener('hashchange', onNav);
      subs.state.clear();
      subs.change.clear();
      const v = viewer;
      viewer = null;
      internals = null;
      // reload() starts the pending save at once; destroy() then removes everything from the page.
      const saved = v ? v.reload().catch(() => {}) : Promise.resolve();
      v?.destroy();
      ended = saved.finally(() => owned?.close());
      return ended;
    },
  };
  return handle;
}
