import type { InkLayer } from '../render/layer';
import type {
  ClipEdge,
  CreatePlacer,
  Note,
  NotePose,
  Placed,
  Placer,
  Point,
  Rect,
  Resolved,
  ResolveMethod,
} from '../types';
import {
  asWritten,
  type DockKind,
  dock,
  fits,
  inkBox,
  inkOn,
  lineAt,
  lineRects,
  needsDock,
  ON_CONTENT,
  offDoc,
  placeBox,
  union,
} from './geom';
import { shapeCut } from './shape';

/** Layout reads in one pass stop after this long; the rest go to idle time. */
const READ_BUDGET_MS = 6;
/** Anchors not in the page yet that one pass looks up while the page loads. */
const LOOKUPS_LOADING = 24;
/** Writes in one idle chunk stop after this long. */
const WRITE_BUDGET_MS = 8;
/** Docking in one frame pass stops after this long; the rest are docked in the next pass. */
const DOCK_BUDGET_MS = 4;
/** Mutations settle for this long before a pass, so a burst costs one pass. */
const MUTATION_DEBOUNCE_MS = 25;
const MUTATION_MAX_WAIT_MS = 100;
/** Screens above and below the viewport that count as near. */
const NEAR_SCREENS = 2;
/** One slice of building the document text. */
const MODEL_SLICE_MS = 6;
/** A note the path rung cannot place waits this long for the sliced text, then resolves in full. */
const MAX_WAIT_MS = 1000;
/** Attributes that open and close sections, menus and tabs. */
const TOGGLE_ATTRS = ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden'];
/** Events that end an opening or closing. Listened for in the capture phase. */
const TOGGLE_EVENTS = ['toggle', 'close', 'transitionend', 'animationend'];
/** Far enough to stand for "no edge" on an axis that does not clip. */
const FAR = 1e7;
const EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 };

type Visible = Element & {
  checkVisibility?(o?: {
    opacityProperty?: boolean;
    visibilityProperty?: boolean;
    contentVisibilityAuto?: boolean;
  }): boolean;
};
/** False when the element or an ancestor is transparent or not visible. */
const shown = (el: Element): boolean =>
  typeof (el as Visible).checkVisibility !== 'function' ||
  (el as Visible).checkVisibility!({ opacityProperty: true, visibilityProperty: true });

type Reason =
  | 'notes'
  | 'upsert'
  | 'refresh'
  | 'resize'
  | 'fonts'
  | 'load'
  | 'mutation'
  | 'viewport'
  | 'attr'
  | 'grow';

interface Write {
  mark: boolean;
  pose: NotePose;
  rects?: Rect[];
  key: string;
}

interface Entry {
  note: Note;
  /** Ink box in note-local units. Null for text marks and empty notes. */
  local: Rect | null;
  /** Pose given by the writer. Used until the page changes, so new ink does not jump. */
  /**
   * With an element that moves with the anchor, and its corner in document space when the pose
   * was given. A pass moves the pose by as much as that element moved since, so a pane or the
   * page scrolled before the pass does not leave the ink behind.
   */
  known?: { origin: Point; scale: number; el?: Element; at?: Point };
  needResolve: boolean;
  /** hidden: the anchor is there but not shown, so the note is hidden with it. */
  state: 'new' | 'placed' | 'unplaced' | 'hidden';
  placed?: Placed;
  el?: Element;
  scroller?: Element;
  pinned?: boolean;
  /** Inner scroll offset when placed, for scroller notes. */
  scroll0?: Point;
  /** Key of what is on screen now; equal keys skip the layer call. */
  drawnKey?: string;
  pending?: Write;
  /**
   * Placed by the quick path rung, before the document text was built. The full
   * ladder checks it once the text is ready, so the end result is the same.
   */
  trial?: boolean;
  /** The quick rung could not decide. Waits for the document text since this time. */
  waitSince?: number;
  /** Waits for the document text because its anchor is far from the screen. Growth of the page does not change that. */
  far?: boolean;
  /** While the page loads: the element the anchor's path points at, once it is there. */
  loc?: Element;
  /** Never drawn and off the screen in the last frame pass: left for idle time, so it held back no paint. */
  later?: boolean;
  /**
   * Where the anchor of a note not placed yet lies, top and bottom in document space, as read in
   * layout generation spotGen. Kept across passes, so a pass over a long backlog orders it
   * without reading every anchor's box again.
   */
  spot?: [number, number];
  spotGen?: number;
  /** Ancestors that clip the anchor, and the box they leave, in document space. */
  clips?: ClipEdge[];
  clip?: Rect;
  /** Ancestors with a clip-path, and their computed value. */
  shapes?: Shape[];
  /** The top layer element (modal dialog, open popover) the anchor is in. */
  top?: Element;
  /** Where a margin note sat after the last pass, when it did not fit beside its block. */
  dock?: DockKind;
}

interface Shape {
  el: Element;
  v: string;
}

interface ReadResult {
  e: Entry;
  r: Resolved | null;
  /** Box the anchor's clipping ancestors leave, and whether the anchor is visible at all. */
  clip?: Rect;
  visible?: boolean;
  /** For an anchor not found: its element, still there but not shown. */
  hiddenEl?: Element | null;
  shapes?: Shape[];
  top?: Element;
  rects?: Rect[];
  /** For a margin note that may not fit where it was written: what is around it. */
  room?: Room;
  /** Where the element of a known pose is now, null when it is gone. */
  at?: Rect | null;
}

interface Room {
  /** Boxes of the anchor block and its neighbours. Enough to tell that a note fits as written. */
  blocks: Rect[];
  /** Text lines, media and controls within about a screen. Read only when the boxes are not enough. */
  obstacles?: Rect[];
  /** Text lines of the anchor block. */
  own?: Rect[];
  rtl?: boolean;
}

/** Elements whose box is content as a whole. */
const SOLID = 'img,video,canvas,svg,iframe,input,button,select,textarea,object,embed,audio,meter,progress';
/** An element with more text pieces than this counts as one solid box. */
const MAX_PIECES = 400;

interface ScrollerInfo {
  box: Rect;
  scroll: Point;
  pinned: boolean;
  top: boolean;
}

/** Extra layer methods, present on layers made by render/. Fakes may lack them. */
type LayerExtras = Partial<
  Pick<
    InkLayer,
    'measure' | 'readTheme' | 'flush' | 'setScroller' | 'scrollScroller' | 'clipNote' | 'syncTop'
  >
>;

const rnd = (v: number): number => Math.round(v * 10) / 10;

/**
 * The box all clipping ancestors leave, in document space. Undefined when nothing clips.
 * An ancestor cuts only on an axis where it is cutting its own content right now: a wrapper
 * whose content fits (a float clearfix) clips nothing on the page, so a margin note beside it
 * stays whole. A section collapsing over its content cuts the ink where it cuts the text.
 */
function clipBox(clips: ClipEdge[] | undefined, sx: number, sy: number): Rect | undefined {
  if (!clips?.length) return undefined;
  let x0 = -FAR;
  let y0 = -FAR;
  let x1 = FAR;
  let y1 = FAR;
  let any = false;
  for (const c of clips) {
    const el = c.el;
    const cx = c.x && el.scrollWidth > el.clientWidth + 1;
    const cy = c.y && el.scrollHeight > el.clientHeight + 1;
    if (!cx && !cy) continue;
    any = true;
    const b = el.getBoundingClientRect();
    // The padding box: inside the borders, without scrollbars.
    const l = b.left + el.clientLeft + sx;
    const t = b.top + el.clientTop + sy;
    if (cx) {
      x0 = Math.max(x0, l);
      x1 = Math.min(x1, l + el.clientWidth);
    }
    if (cy) {
      y0 = Math.max(y0, t);
      y1 = Math.min(y1, t + el.clientHeight);
    }
  }
  if (!any) return undefined;
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

const isEmpty = (r: Rect | undefined): boolean => !!r && (r.w <= 0 || r.h <= 0);

function meet(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const edgesOf = (cs: CSSStyleDeclaration, pre: 'padding' | 'border') => {
  const f = (side: string) =>
    Number.parseFloat(cs.getPropertyValue(pre === 'border' ? `border-${side}-width` : `padding-${side}`)) ||
    0;
  return { t: f('top'), r: f('right'), b: f('bottom'), l: f('left') };
};

/**
 * The box clip-path ancestors leave, in document space. Undefined when none cuts. Simple shapes
 * cut to their box. Other shapes cut to the element's box. Content that lies outside what a
 * shape leaves is clipped away, and so is its note: the box is then empty.
 */
function shapeBox(shapes: Shape[] | undefined, anchor: Rect, sx: number, sy: number): Rect | undefined {
  if (!shapes?.length) return undefined;
  let out: Rect | undefined;
  for (const { el, v } of shapes) {
    const r = el.getBoundingClientRect();
    const box = { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
    const cs = /padding-box|content-box/.test(v) ? getComputedStyle(el) : null;
    const cut = shapeCut(
      v,
      box,
      cs ? edgesOf(cs, 'padding') : undefined,
      cs ? edgesOf(cs, 'border') : undefined,
    );
    if (!cut) continue;
    const rect = cut === 'other' ? box : cut;
    // A shape as large as the element cuts nothing, unless the element's content spills out of it.
    const whole =
      rect.x <= box.x + 0.5 &&
      rect.y <= box.y + 0.5 &&
      rect.x + rect.w >= box.x + box.w - 0.5 &&
      rect.y + rect.h >= box.y + box.h - 0.5;
    if (whole && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue;
    if (!overlaps(rect, anchor) && !(anchor.w === 0 && anchor.h === 0)) return EMPTY;
    out = meet(out, rect);
  }
  return out;
}
const clipKey = (r: Rect | undefined): string => (r ? `${rnd(r.x)},${rnd(r.y)},${rnd(r.w)},${rnd(r.h)}` : '');

// The scroller a note is drawn in is part of what is on screen. Without it, a note drawn
// in document space at the same numbers would never move into its scroller.
const scrollerIds = new WeakMap<Element, number>();
let nextScrollerId = 1;
const scrollerKey = (el: Element | undefined): string => {
  if (!el) return '';
  let id = scrollerIds.get(el);
  if (!id) {
    id = nextScrollerId++;
    scrollerIds.set(el, id);
  }
  return `s${id}`;
};

const poseKey = (p: NotePose, strokes: number): string =>
  [
    rnd(p.origin.x),
    rnd(p.origin.y),
    Math.round(p.scale * 1e4),
    p.leaderTo ? `${rnd(p.leaderTo.x)},${rnd(p.leaderTo.y)}` : '',
    p.leaderVia?.map((q) => `${rnd(q.x)},${rnd(q.y)}`).join(';') ?? '',
    p.marker ? clipKey(p.marker) : '',
    p.pinned ? 'p' : '',
    scrollerKey(p.scroller),
    clipKey(p.clip),
    p.top ? 't' : '',
    strokes,
  ].join('|');

export const createPlacer: CreatePlacer = (host) => {
  const { doc, resolver, layer } = host;
  const ext = layer as LayerExtras & typeof layer;
  const win = doc.defaultView ?? window;

  // ---- ancestors: clip-path and the top layer ----------------------------------
  /** The selector for elements in the top layer, as far as this browser knows them. */
  const TOP_SEL = ((): string => {
    for (const sel of [':modal,:popover-open,:fullscreen', ':modal,:popover-open', ':modal']) {
      try {
        doc.documentElement.matches(sel);
        return sel;
      } catch {
        // Not known here.
      }
    }
    return '';
  })();
  /** Notes in the top layer can be painted above it only with a popover of our own. */
  const canTop =
    typeof (win as Window & typeof globalThis).HTMLElement?.prototype?.showPopover === 'function';
  const parentOf = (el: Element): Element | null =>
    el.parentElement ?? ((el.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
  const within = (outer: Element, el: Element): boolean => {
    for (let a: Element | null = el; a; a = parentOf(a)) if (a === outer) return true;
    return false;
  };
  /** Computed clip-path and top layer state per element, for one pass. */
  let ancCache = new Map<Element, { v: string; top: boolean }>();
  const ancestry = (el: Element): { shapes?: Shape[]; top?: Element } => {
    const out: { shapes?: Shape[]; top?: Element } = {};
    for (let a: Element | null = el; a && a !== doc.documentElement; a = parentOf(a)) {
      let c = ancCache.get(a);
      if (!c) {
        c = { v: win.getComputedStyle(a).clipPath || 'none', top: !!TOP_SEL && a.matches(TOP_SEL) };
        ancCache.set(a, c);
      }
      if (c.v !== 'none') {
        out.shapes ??= [];
        out.shapes.push({ el: a, v: c.v });
      }
      // Nothing above a top layer element clips it.
      if (c.top) {
        out.top = a;
        break;
      }
    }
    return out;
  };
  /** The box a note is cut to: its clipping ancestors, then the shapes that cut it. */
  const cutOf = (
    clips: ClipEdge[] | undefined,
    shapes: Shape[] | undefined,
    anchor: Rect,
    sx: number,
    sy: number,
  ) => meet(clipBox(clips, sx, sy), shapeBox(shapes, anchor, sx, sy));
  const entries = new Map<string, Entry>();
  const now = host.now ? (): number => host.now!() : (): number => performance.now();

  let destroyed = false;
  /** Grows whenever the layout may have changed, so spots read before it are read again. */
  let layoutGen = 0;
  let raf = 0;
  let idle = 0;
  let idleIsTimeout = false;
  let fullPass = false;
  let clearKnown = false;
  let contentChanged = false;
  /** The parser added content since the last pass. Only notes not placed yet are tried again. */
  let grew = false;
  // The layer may defer reading the page theme until the first pass.
  let themeDirty = true;
  let firstAt: number | null = null;
  let allAt: number | null = null;
  /** Top layer elements that held drawn notes after the last pass, and a request to raise our host. */
  let topEls = new Set<Element>();
  let raiseTop = false;

  // Observed anchor elements and their last seen sizes, so the first report
  // of a new observation does not start a pass. A new anchor's size is also taken
  // when it is placed: a resize between that read and the first report still counts.
  const sizes = new WeakMap<Element, string>();
  const seeds = new WeakMap<Element, string>();
  const observed = new Map<Element, number>();
  const sizeKey = (w: number, h: number): string => `${Math.round(w)}x${Math.round(h)}`;
  const BOX: ResizeObserverOptions = { box: 'border-box' };

  const schedule = (reason: Reason): void => {
    if (destroyed) return;
    // Anything but a note's own change may have moved anchors.
    if (reason !== 'upsert') layoutGen++;
    if (reason !== 'upsert' && reason !== 'notes') {
      fullPass = true;
      clearKnown = true;
    }
    if (reason === 'notes' || reason === 'refresh') fullPass = true;
    if (reason === 'mutation') contentChanged = true;
    if (reason === 'grow') grew = true;
    if (reason === 'attr') themeDirty = true;
    if (raf) return;
    // The pass runs right after the browser's own layout, from a resize observation, so its
    // reads never force a layout and its ink is in the same frame. The observation is added in
    // the frame callback, before that frame's layout: added while resize observations are being
    // delivered, the browser would skip it and report a resize loop to the page. A second
    // frame callback is the fallback.
    raf = win.requestAnimationFrame(() => {
      raf = win.requestAnimationFrame(framePass);
      post.observe(doc.documentElement);
    });
  };

  // ---- observers -------------------------------------------------------

  // A new observation reports after the next layout: a callback with layout clean.
  const post = new ResizeObserver(() => {
    post.disconnect();
    if (!raf || destroyed) return;
    win.cancelAnimationFrame(raf);
    framePass();
  });

  // Clipping ancestors and the notes they cut. Their size is followed in the observer
  // callback itself, after layout, so ink is cut in the same frame as the content.
  const clipOwners = new Map<Element, Set<Entry>>();
  const reclip = (targets: Element[]): boolean => {
    const touched = new Set<Entry>();
    for (const t of targets) for (const e of clipOwners.get(t) ?? []) touched.add(e);
    if (!touched.size) return false;
    const sx = win.scrollX;
    const sy = win.scrollY;
    let flipped = false;
    for (const e of touched) {
      if ((!e.clips && !e.shapes) || e.drawnKey === undefined || e.state === 'unplaced') continue;
      const at = e.placed?.anchorBox ?? EMPTY;
      const next =
        shown(e.el ?? doc.documentElement) && !(e.top && !canTop)
          ? cutOf(e.clips, e.shapes, at, sx, sy)
          : EMPTY;
      if (clipKey(next) === clipKey(e.clip)) continue;
      if (isEmpty(next) !== isEmpty(e.clip)) {
        flipped = true;
        e.needResolve = true;
      }
      e.clip = next;
      ext.clipNote?.(e.note.id, next ?? null);
    }
    return flipped;
  };

  const ro = new ResizeObserver((list) => {
    let changed = false;
    if (clipOwners.size && reclip(list.map((en) => en.target))) schedule('upsert');
    for (const en of list) {
      // A clipping ancestor alone: its notes were cut above, nothing else moves.
      if (clipOwners.has(en.target) && !observed.has(en.target) && en.target !== attrBody) {
        const b = en.borderBoxSize?.[0];
        sizes.set(en.target, b ? sizeKey(b.inlineSize, b.blockSize) : '');
        continue;
      }
      const b = en.borderBoxSize?.[0];
      const s = b ? sizeKey(b.inlineSize, b.blockSize) : sizeKey(en.contentRect.width, en.contentRect.height);
      const prev = sizes.get(en.target);
      sizes.set(en.target, s);
      if (prev !== undefined) {
        if (prev !== s) changed = true;
        continue;
      }
      const seed = seeds.get(en.target);
      seeds.delete(en.target);
      // Inline elements always report 0x0, so that says nothing about a change.
      if (seed !== undefined && seed !== s && s !== '0x0') changed = true;
    }
    if (changed) schedule('resize');
  });
  // <html> is not observed here. Ink is written from the post-layout observation, and a
  // second observation of <html> that changed after that write (a scrollbar coming or going)
  // would be skipped and reported to the page as a resize loop error. The window's resize
  // event and the observed anchor elements cover what it told.

  let moTimer = 0;
  let moFirst = 0;
  /** Content changed, or something only opened or closed elsewhere and may have moved anchors. */
  let moContent = false;
  const flushMutations = (): void => {
    moTimer = 0;
    moFirst = 0;
    schedule(moContent ? 'mutation' : 'resize');
    moContent = false;
  };
  const isOurs = (n: Node): boolean =>
    n === layer.host || layer.host.contains(n) || n.nodeName === 'INK-LAYER';
  /** True when a node holds the anchor of a placed or hidden note: opening or closing it matters. */
  const holdsAnchor = (n: Node): boolean => {
    for (const e of entries.values()) if (e.el && (n === e.el || n.contains(e.el))) return true;
    return false;
  };
  const mo = new MutationObserver((records) => {
    let relevant = false;
    let moved = false;
    // While the page loads, the parser only adds content after what is there. Notes still
    // waiting for their anchors are tried in the next frame, right after its layout, so their
    // ink comes with the content's first paint. Nothing placed is touched.
    if (doc.readyState === 'loading' && !moTimer) {
      let grow = false;
      let other = false;
      for (const rec of records) {
        if (rec.type === 'childList' && !rec.removedNodes.length) grow = true;
        else if (!isOurs(rec.target)) {
          other = true;
          break;
        }
      }
      if (!other) {
        if (grow) schedule('grow');
        return;
      }
    }
    for (const rec of records) {
      if (isOurs(rec.target)) continue;
      if (rec.type === 'attributes') {
        // Our own hosts, in this or another layer on the page.
        if (rec.target.nodeName === 'INK-LAYER') continue;
        // Around an anchor: what shows may have changed. Elsewhere: anchors may have moved.
        if (!holdsAnchor(rec.target)) {
          moved = true;
          continue;
        }
        relevant = true;
        break;
      }
      if (rec.type === 'childList') {
        const nodes = [...rec.addedNodes, ...rec.removedNodes];
        // Our own hosts, in this or another layer on the page.
        if (nodes.length > 0 && nodes.every((n) => n.nodeName === 'INK-LAYER')) continue;
      }
      relevant = true;
      break;
    }
    if (!relevant && !moved) return;
    if (relevant) moContent = true;
    const t = now();
    if (!moFirst) moFirst = t;
    if (moTimer) win.clearTimeout(moTimer);
    if (t - moFirst >= MUTATION_MAX_WAIT_MS) flushMutations();
    else moTimer = win.setTimeout(flushMutations, MUTATION_DEBOUNCE_MS);
  });
  mo.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TOGGLE_ATTRS,
  });
  // A section, menu, popover or dialog that finished opening or closing. One pass per frame.
  const onToggle = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof win.Element) || isOurs(t)) return;
    // Around an anchor, what shows changed. Elsewhere, content below it may have moved.
    const holds = holdsAnchor(t);
    // Something with notes opened in the top layer: our own top host must come above it again.
    if (holds) raiseTop = true;
    schedule(holds ? 'mutation' : 'resize');
  };
  for (const type of TOGGLE_EVENTS) doc.addEventListener(type, onToggle, true);

  // Theme switches and root font size changes usually live on html or body attributes.
  const attrMo = new MutationObserver(() => schedule('attr'));
  attrMo.observe(doc.documentElement, { attributes: true });
  let attrBody: Element | null = null;
  const watchBody = (): void => {
    if (doc.body && attrBody !== doc.body) {
      if (attrBody) ro.unobserve(attrBody);
      attrBody = doc.body;
      attrMo.observe(doc.body, { attributes: true });
      // Content that moves when a section above it opens or closes changes the body's size.
      // The body sits below <html>, so a change after a write is still delivered, never skipped.
      ro.observe(doc.body, BOX);
    }
  };
  watchBody();

  const onFonts = (): void => schedule('fonts');
  const onLoad = (): void => schedule('load');
  const onViewport = (): void => schedule('viewport');
  doc.fonts?.addEventListener?.('loadingdone', onFonts);
  doc.addEventListener('load', onLoad, true);
  win.addEventListener('orientationchange', onViewport);
  win.addEventListener('resize', onViewport);
  win.visualViewport?.addEventListener('resize', onViewport);

  // ---- scrollers and pinned notes ----------------------------------------

  const scrollers = new Map<Element, { handler: () => void; raf: number }>();
  const followScroller = (el: Element): void => {
    const rec = scrollers.get(el);
    if (!rec || rec.raf) return;
    rec.raf = win.requestAnimationFrame(() => {
      rec.raf = 0;
      const sc = { x: el.scrollLeft, y: el.scrollTop };
      if (ext.scrollScroller) ext.scrollScroller(el, sc);
      else {
        for (const e of entries.values()) if (e.scroller === el) e.needResolve = true;
        schedule('upsert');
      }
      for (const e of entries.values()) {
        if (e.scroller !== el || !e.placed || !e.scroll0) continue;
        const dx = e.scroll0.x - sc.x;
        const dy = e.scroll0.y - sc.y;
        shift(e.placed, dx, dy);
        e.scroll0 = sc;
      }
    });
  };
  const shift = (p: Placed, dx: number, dy: number): void => {
    p.origin = { x: p.origin.x + dx, y: p.origin.y + dy };
    p.bbox = { ...p.bbox, x: p.bbox.x + dx, y: p.bbox.y + dy };
    p.anchorBox = { ...p.anchorBox, x: p.anchorBox.x + dx, y: p.anchorBox.y + dy };
  };

  let pinnedRaf = 0;
  let pinnedOn = false;
  const onWinScroll = (): void => {
    if (pinnedRaf) return;
    pinnedRaf = win.requestAnimationFrame(() => {
      pinnedRaf = 0;
      // Fixed notes keep their screen spot, but sticky ones move until they stick.
      const subset = [...entries.values()].filter((e) => e.pinned);
      for (const e of subset) e.needResolve = true;
      pass('frame', subset);
    });
  };

  const syncListeners = (): void => {
    const want = new Set<Element>();
    let anyPinned = false;
    for (const e of entries.values()) {
      if (e.state !== 'placed') continue;
      if (e.scroller) want.add(e.scroller);
      if (e.pinned) anyPinned = true;
    }
    for (const [el, rec] of scrollers) {
      if (want.has(el)) continue;
      el.removeEventListener('scroll', rec.handler);
      if (rec.raf) win.cancelAnimationFrame(rec.raf);
      scrollers.delete(el);
    }
    for (const el of want) {
      if (scrollers.has(el)) continue;
      const rec = { handler: () => followScroller(el), raf: 0 };
      scrollers.set(el, rec);
      el.addEventListener('scroll', rec.handler, { passive: true });
    }
    if (anyPinned !== pinnedOn) {
      pinnedOn = anyPinned;
      if (anyPinned) win.addEventListener('scroll', onWinScroll, { passive: true });
      else win.removeEventListener('scroll', onWinScroll);
    }
    // Clipping ancestors in use, and the notes each one cuts.
    const owners = new Map<Element, Set<Entry>>();
    for (const e of entries.values()) {
      if ((!e.clips && !e.shapes) || e.state === 'unplaced') continue;
      for (const el of [...(e.clips ?? []).map((c) => c.el), ...(e.shapes ?? []).map((c) => c.el)]) {
        let set = owners.get(el);
        if (!set) {
          set = new Set();
          owners.set(el, set);
        }
        set.add(e);
      }
    }
    // Anchor elements in use, for resize triggers.
    const els = new Map<Element, number>();
    for (const e of entries.values()) if (e.el) els.set(e.el, (els.get(e.el) ?? 0) + 1);
    for (const el of clipOwners.keys()) {
      if (!owners.has(el) && !els.has(el) && el !== attrBody) ro.unobserve(el);
    }
    for (const el of owners.keys()) {
      if (!clipOwners.has(el) && !observed.has(el) && el !== attrBody) ro.observe(el, BOX);
    }
    clipOwners.clear();
    for (const [k, v] of owners) clipOwners.set(k, v);
    for (const el of observed.keys()) {
      if (els.has(el)) continue;
      observed.delete(el);
      if (owners.has(el) || el === attrBody) continue;
      ro.unobserve(el);
    }
    for (const [el, n] of els) {
      if (!observed.has(el) && el !== doc.documentElement) ro.observe(el, BOX);
      observed.set(el, n);
    }
  };

  // ---- the pass ---------------------------------------------------------

  const framePass = (): void => {
    raf = 0;
    post.disconnect();
    pass('frame');
  };

  // ---- document text, built in slices -----------------------------------

  let modelJob = 0;
  let modelIsTimeout = false;
  /** A note near the screen waits for the text, so slices follow each other without idle waits. */
  let urgent = false;
  const sliceModel = (): void => {
    modelJob = 0;
    if (destroyed || !resolver.prepare) return;
    if (!resolver.prepare(MODEL_SLICE_MS)) {
      scheduleModel(urgent);
      return;
    }
    // The text is ready: notes that waited are resolved, and quick placements are checked.
    let any = false;
    for (const e of entries.values()) {
      if (e.trial || e.waitSince !== undefined) {
        e.needResolve = true;
        any = true;
      }
    }
    if (any && urgent) schedule('upsert');
    else if (any) scheduleIdle();
    urgent = false;
  };
  /** The document text is built once the parser is done: content it adds would make it stale. */
  let afterParse = false;
  const onParsed = (): void => {
    afterParse = false;
    scheduleModel(urgent);
  };
  const scheduleModel = (soon: boolean): void => {
    if (soon) urgent = true;
    if (destroyed) return;
    if (doc.readyState === 'loading') {
      if (!afterParse) doc.addEventListener('DOMContentLoaded', onParsed, { once: true });
      afterParse = true;
      return;
    }
    if (modelJob && urgent && !modelIsTimeout) {
      win.cancelIdleCallback?.(modelJob);
      modelJob = 0;
    }
    if (modelJob) return;
    if (urgent) {
      modelIsTimeout = true;
      modelJob = win.setTimeout(sliceModel, 0);
      return;
    }
    const ric = (win as Window & { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback;
    if (ric) {
      modelIsTimeout = false;
      modelJob = ric.call(win, sliceModel, { timeout: 100 });
    } else {
      modelIsTimeout = true;
      modelJob = win.setTimeout(sliceModel, 16);
    }
  };

  const scheduleIdle = (): void => {
    if (idle || destroyed) return;
    const ric = (win as Window & { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback;
    if (ric) {
      idleIsTimeout = false;
      idle = ric.call(
        win,
        () => {
          idle = 0;
          pass('idle');
        },
        { timeout: 200 },
      );
    } else {
      idleIsTimeout = true;
      idle = win.setTimeout(() => {
        idle = 0;
        pass('idle');
      }, 16);
    }
  };

  const toDoc = (r: DOMRect | Rect, sx: number, sy: number): Rect => {
    const d = r as DOMRect;
    if (d.left !== undefined) return { x: d.left + sx, y: d.top + sy, w: d.width, h: d.height };
    const q = r as Rect;
    return { x: q.x + sx, y: q.y + sy, w: q.w, h: q.h };
  };

  /** Text pieces, media and controls inside an element, and its box, document space. Kept for one pass. */
  let pieceCache = new Map<Element, Rect[]>();
  let boxCache = new Map<Element, Rect>();
  /** Elements whose content is laid out on screen, for one pass. */
  let litCache = new Map<Element, boolean>();
  /**
   * When the slice that reads ends. A docking read that runs past it stops, and its note is read
   * again in the next slice. Infinity for the first note of a slice, so every slice gets one done.
   */
  let readEnd = Number.POSITIVE_INFINITY;
  let late = false;
  const over = (): boolean => {
    if (!late && now() > readEnd) late = true;
    return late;
  };
  /**
   * True when the element's content is laid out on screen. Content a closed section skips
   * (content-visibility, hidden="until-found", a closed <details>) is not: reading a box in it makes
   * the browser lay that part out for the one read, every time, and the reader cannot see it anyway.
   * An element with no box of its own may still show its children (display: contents). Its style is
   * read only when its parent is shown and skips nothing, so no skipped content has its style forced.
   */
  const lit = (el: Element): boolean => {
    let v = litCache.get(el);
    if (v !== undefined) return v;
    const check = (el as Visible).checkVisibility;
    if (typeof check !== 'function' || check.call(el, { contentVisibilityAuto: true })) v = true;
    else {
      const p = el.parentElement;
      v =
        !!p &&
        lit(p) &&
        !(p.localName === 'details' && !(p as HTMLDetailsElement).open && el.localName !== 'summary') &&
        (win.getComputedStyle(p).contentVisibility || 'visible') === 'visible' &&
        win.getComputedStyle(el).display === 'contents';
    }
    litCache.set(el, v);
    return v;
  };
  /** An element's box, document space. Kept for one pass. */
  const boxOf = (el: Element, sx: number, sy: number): Rect => {
    let b = boxCache.get(el);
    if (!b) {
      b = toDoc(el.getBoundingClientRect(), sx, sy);
      boxCache.set(el, b);
    }
    return b;
  };
  /** Line boxes of a text node with something to show, document space. */
  const textRects = (t: Node, range: Range, sx: number, sy: number, out: Rect[]): boolean => {
    if (!/\S/.test(t.nodeValue ?? '') || !t.parentElement || !lit(t.parentElement)) return false;
    range.selectNodeContents(t);
    for (const c of range.getClientRects()) if (c.width > 0.5 && c.height > 0.5) out.push(toDoc(c, sx, sy));
    return true;
  };
  /**
   * An element with too much text to read piece by piece is split into its children, and only
   * those that reach the band from lo to hi are read. A long contents list beside the text is then
   * its lines near the note, not one box that spans the gap the note was written in.
   */
  const pieces = (el: Element, sx: number, sy: number, lo: number, hi: number): Rect[] => {
    let out = pieceCache.get(el);
    if (out) return out;
    const all: Rect[] = [];
    const box = (n: Element): void => {
      if (!lit(n)) return;
      const r = toDoc(n.getBoundingClientRect(), sx, sy);
      if (r.w > 0 && r.h > 0) all.push(r);
    };
    out = all;
    if (!lit(el)) return out;
    const range = doc.createRange();
    if (el.matches(SOLID)) box(el);
    else {
      const walk = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n = 0;
      for (let t = walk.nextNode(); t && !over(); t = walk.nextNode())
        if (textRects(t, range, sx, sy, all) && ++n > MAX_PIECES) {
          out = [];
          for (let c = el.firstChild; c && !over(); c = c.nextSibling) {
            if (c.nodeType === 3) textRects(c, range, sx, sy, out);
            else if (c.nodeType === 1 && lit(c as Element)) {
              const b = boxOf(c as Element, sx, sy);
              // A child with a box of its own that stays out of the band holds nothing near the
              // note. One with no box, such as display: contents, is read through.
              if (!b.h || (b.y + b.h > lo && b.y < hi)) out.push(...pieces(c as Element, sx, sy, lo, hi));
            }
          }
          // What is read for one band is not kept for another.
          return out;
        }
      for (const m of el.querySelectorAll(SOLID)) if (!over()) box(m);
    }
    // A read cut short by the end of its slice is not kept: the next slice reads it whole.
    if (!late) pieceCache.set(el, out);
    return out;
  };

  /**
   * What lies around a margin note's anchor, within a screen above and below: siblings of the
   * anchor and of its ancestors, walked outwards until they leave that band. Their boxes tell
   * whether the note fits where it was written. Only when they do not are their text pieces,
   * media and controls read, for the search for free space. Null when the slice ran out of time
   * during that read.
   */
  const roomOf = (e: Entry, r: Resolved, sx: number, sy: number, vh: number, docW: number): Room | null => {
    const own = r.box;
    const lo = own.y - vh;
    const hi = own.y + own.h + vh;
    const els: Element[] = [];
    const blocks: Rect[] = [own];
    for (let cur: Element | null = r.el, d = 0; cur && d < 8; cur = cur.parentElement, d++) {
      if (cur === doc.body || cur === doc.documentElement) break;
      for (const next of [true, false]) {
        for (
          let s = next ? cur.nextElementSibling : cur.previousElementSibling, i = 0;
          s && i < 24;
          s = next ? s.nextElementSibling : s.previousElementSibling, i++
        ) {
          if (s === layer.host || !lit(s)) continue;
          const b = boxOf(s, sx, sy);
          if (b.w < 1 || b.h < 1) continue;
          // Past the band: what follows in this direction is further still.
          if (next ? b.y > hi : b.y + b.h < lo) break;
          if (b.y > hi || b.y + b.h < lo) continue;
          // A box that holds the anchor is a container, not a neighbour.
          if (b.x <= own.x && b.y <= own.y && b.x + b.w >= own.x + own.w && b.y + b.h >= own.y + own.h)
            continue;
          els.push(s);
          blocks.push(b);
        }
      }
    }
    const out: Room = { blocks };
    if (needsDock(placeBox(e.local!, r.origin, r.scale), docW, blocks)) {
      const mine = pieces(r.el, sx, sy, lo, hi);
      const obstacles = [r.el, ...els]
        .flatMap((el) => pieces(el, sx, sy, lo, hi))
        .filter((p) => p.y + p.h > lo && p.y < hi);
      if (late) return null;
      out.own = mine;
      out.obstacles = obstacles;
      out.rtl = win.getComputedStyle(r.el).direction === 'rtl';
    }
    return out;
  };

  /**
   * True when a margin note may stay where its anchor puts it: inside the page, with its ink on
   * no content to speak of. The box only tells that the ink may be on content, so where the box
   * reaches content the ink itself is measured.
   */
  const stays = (
    note: Note,
    box: Rect,
    origin: Point,
    scale: number,
    docW: number,
    obstacles: Rect[],
  ): boolean =>
    fits(box, docW, obstacles) ||
    (!offDoc(box, docW) &&
      inkOn(
        note.strokes,
        origin,
        scale,
        obstacles.filter((o) => overlaps(box, o)),
      ) <= ON_CONTENT);

  const placedOf = (
    e: Entry,
    origin: Point,
    scale: number,
    anchorBox: Rect,
    method: ResolveMethod,
    docked: boolean,
    bbox?: Rect,
  ): Placed => ({
    id: e.note.id,
    origin,
    scale,
    bbox: bbox ?? (e.local ? placeBox(e.local, origin, scale) : { x: origin.x, y: origin.y, w: 0, h: 0 }),
    anchorBox,
    docked,
    method,
  });

  /**
   * One placement pass. Read phase: every resolve and rect read. Compute:
   * poses and docking, no DOM. Write phase: layer calls only.
   */
  const pass = (mode: 'frame' | 'idle', only?: Entry[]): void => {
    if (destroyed) return;
    const t0 = now();

    // ---- read ----
    watchBody();
    if (themeDirty) {
      ext.readTheme?.();
      themeDirty = false;
    }
    if (contentChanged) {
      resolver.invalidate();
      contentChanged = false;
      grew = false;
    }
    if (grew) {
      grew = false;
      resolver.invalidate();
      for (const e of entries.values()) {
        if ((e.state === 'new' || e.state === 'unplaced') && !e.far) e.needResolve = true;
      }
    }
    const full = fullPass && !only;
    if (full) {
      fullPass = false;
      for (const e of entries.values()) {
        e.needResolve = true;
        e.far = undefined;
        if (clearKnown) e.known = undefined;
      }
      clearKnown = false;
    }
    ext.measure?.();
    ancCache = new Map();
    pieceCache = new Map();
    boxCache = new Map();
    litCache = new Map();
    readEnd = Number.POSITIVE_INFINITY;
    late = false;
    const sx = win.scrollX;
    const sy = win.scrollY;
    const vh = win.innerHeight || 800;
    // While the parser runs, an anchor not in the page yet is further down, not near.
    const loading = doc.readyState === 'loading';
    const docW = doc.documentElement.clientWidth || win.innerWidth;
    const winW = win.innerWidth;
    const docH = doc.documentElement.scrollHeight || vh;
    const bandTop = sy - NEAR_SCREENS * vh;
    const bandBot = sy + vh + NEAR_SCREENS * vh;
    const dist = (y0: number, y1: number): number =>
      y1 < bandTop ? bandTop - y1 : y0 > bandBot ? y0 - bandBot : 0;
    // A note not placed yet is judged by the box of the element its path points at. Layout is
    // clean here, so that read is cheap. The stored page fraction is only a fallback: it goes
    // stale when the page grows or shrinks above the note.
    const guess = new Map<Entry, number>();
    // While the parser runs, anchors not found yet are looked up from the top of the page down,
    // a few per pass; the rest count as not there yet. An element once found stays: the parser
    // only adds. So a pass costs a few lookups however many notes the page has.
    let absent: Set<Entry> | null = null;
    if (loading) {
      absent = new Set();
      const order = [...entries.values()].filter((e) => !e.placed && e.needResolve && !e.loc?.isConnected);
      order.sort((a, b) => (a.note.anchor.frac?.y ?? 0) - (b.note.anchor.frac?.y ?? 0));
      let n = 0;
      for (const e of order) {
        e.loc = n++ < LOOKUPS_LOADING ? (resolver.locate?.(e.note.anchor) ?? undefined) : undefined;
        if (!e.loc) absent.add(e);
      }
    } else for (const e of entries.values()) e.loc = undefined;
    const locate = (e: Entry): Element | null | undefined =>
      absent
        ? absent.has(e)
          ? null
          : (e.loc ?? resolver.locate?.(e.note.anchor))
        : resolver.locate?.(e.note.anchor);
    /** Where the anchor of a note not placed yet lies, top and bottom in document space. Null: not in the page yet. */
    const spot = new Map<Entry, [number, number] | null>();
    const spotOf = (e: Entry): [number, number] | null => {
      let s = spot.get(e);
      if (s !== undefined) return s;
      if (e.spot && e.spotGen === layoutGen) s = e.spot;
      else {
        s = null;
        const el = locate(e);
        if (el) {
          const b = el.getBoundingClientRect();
          if (b.width || b.height) s = [b.top + sy, b.bottom + sy];
        }
        // While the parser runs, an anchor not in the page yet is further down, not near.
        if (loading && !el) {
          spot.set(e, null);
          return null;
        }
        const f = e.note.anchor.frac;
        if (!s && f) s = [f.y * docH, f.y * docH];
        // A spot in document space holds until the layout may have changed.
        e.spot = s ?? undefined;
        e.spotGen = layoutGen;
        // No box and no stored fraction: counted as near.
        s ??= [sy, sy];
      }
      spot.set(e, s);
      return s;
    };
    const estimate = (e: Entry): number => {
      if (e.placed) return dist(e.placed.bbox.y, e.placed.bbox.y + e.placed.bbox.h);
      const g = guess.get(e);
      if (g !== undefined) return g;
      const s = spotOf(e);
      const d = s ? dist(s[0], s[1]) : FAR;
      guess.set(e, d);
      return d;
    };
    /**
     * A note never drawn whose anchor is off the screen waits for idle time when this pass runs in
     * a frame: its ink would not show in that frame, and the time it took would hold back the
     * frame's paint. The margin covers ink that reaches out of its anchor's box: a note's ink lies
     * within its local box from the corner its anchor gives.
     */
    const offScreen = (e: Entry): boolean => {
      if (mode !== 'frame' || only || e.placed || e.drawnKey !== undefined || e.known) return false;
      const s = spotOf(e);
      if (!s) return true;
      const m = 32 + (e.local ? Math.abs(e.local.y) + e.local.h : 0);
      return s[1] < sy - m || s[0] > sy + vh + m;
    };

    const todo = (only ?? [...entries.values()]).filter((e) => e.needResolve);
    // A long backlog is ordered by what is known: placed boxes, spots kept from earlier passes,
    // else the stored page fraction. Then the anchors nearest by that order have their boxes read,
    // while half the pass's budget lasts, and the order is taken again. Reading every anchor's box
    // in one pass would cost a long task on a page with a thousand notes.
    // Within the near band, notes on the screen come first, so a frame pass reaches them first.
    const fromScreen = (y0: number, y1: number): number =>
      y1 < sy ? sy - y1 : y0 > sy + vh ? y0 - sy - vh : 0;
    const rank = (e: Entry): number => {
      let y: [number, number] | null;
      if (e.placed) y = [e.placed.bbox.y, e.placed.bbox.y + e.placed.bbox.h];
      else if (spot.has(e) || (e.spot && e.spotGen === layoutGen)) y = spotOf(e);
      else {
        const f = e.note.anchor.frac;
        y = f ? [f.y * docH, f.y * docH] : [sy, sy];
      }
      return y ? dist(y[0], y[1]) + fromScreen(y[0], y[1]) / FAR : FAR;
    };
    todo.sort((a, b) => rank(a) - rank(b));
    const spotsUntil = t0 + (mode === 'frame' ? READ_BUDGET_MS : WRITE_BUDGET_MS) / 2;
    for (const e of todo) {
      if (now() > spotsUntil) break;
      estimate(e);
    }
    todo.sort((a, b) => rank(a) - rank(b));
    const reads: ReadResult[] = [];
    const scrollerInfo = new Map<Element, ScrollerInfo>();
    const budget = mode === 'frame' ? READ_BUDGET_MS : WRITE_BUDGET_MS;
    // Until the document text is built, the path rung on each anchor's own block places what
    // it can. Building the text is left to idle slices, except below.
    let quick = resolver.quick && resolver.ready && !resolver.ready() ? resolver.quick : null;
    // Once the parser is done, a page whose whole text builds in a third of a frame pass's budget
    // is read whole before the notes on the screen are placed: one walk of the page costs less
    // than walking the blocks around each note. A longer page keeps what was built for its slices.
    if (
      quick &&
      mode === 'frame' &&
      !loading &&
      resolver.prepare &&
      todo.some((e) => !e.placed && !offScreen(e)) &&
      resolver.prepare(budget / 3)
    )
      quick = null;
    let waiting = false;
    let nearWait = false;
    let tried = 0;
    /** Notes near the screen the budget left for the next frame, which comes before any idle time. */
    let nearLeft = false;
    const readAll = (list: Entry[]): void => {
      for (const e of list) {
        // The budget covers telling which notes are off the screen too: past it, the rest wait.
        // The first note on the screen is tried whatever the clock says.
        if (now() - t0 > budget && (tried > 0 || offScreen(e))) {
          nearLeft = mode === 'frame' && estimate(e) === 0 && !offScreen(e);
          return;
        }
        if (offScreen(e)) {
          e.later = true;
          continue;
        }
        e.later = undefined;
        tried++;
        e.needResolve = false;
        let r: Resolved | null;
        if (quick && !(e.waitSince !== undefined && t0 - e.waitSince > MAX_WAIT_MS)) {
          // Notes away from the screen wait for the document text: one check instead of two.
          const far = estimate(e) > 0;
          const q = far ? undefined : quick.call(resolver, e.note.anchor, e.note.frame);
          if (q === undefined) {
            e.waitSince ??= t0;
            e.trial = false;
            // Far with its element in the page: more content cannot bring it nearer while the page loads.
            e.far = far && !!locate(e);
            waiting = true;
            if (!far) nearWait = true;
            continue;
          }
          r = q;
          e.trial = true;
          waiting = true;
        } else {
          r = resolver.resolve(e.note.anchor, e.note.frame);
          e.trial = false;
          e.waitSince = undefined;
          e.far = undefined;
        }
        const res: ReadResult = { e, r };
        if (r) {
          const anc = ancestry(r.el);
          if (anc.top) {
            // A top layer element is painted apart from its ancestors: nothing above it clips or
            // scrolls it. Without a top layer of our own the note would be painted under it, so
            // it is hidden while the element is open.
            const top = anc.top;
            r = { ...r, clips: r.clips?.filter((c) => within(top, c.el)) };
            if (r.scroller && !within(top, r.scroller)) r = { ...r, scroller: undefined };
            res.r = r;
            res.top = top;
          }
          res.shapes = anc.shapes;
          res.visible = shown(r.el) && !(anc.top && !canTop);
          res.clip = cutOf(r.clips, anc.shapes, r.box, sx, sy);
        } else if (resolver.hidden) res.hiddenEl = resolver.hidden(e.note.anchor);
        if (r && !observed.has(r.el) && !sizes.has(r.el) && !seeds.has(r.el)) {
          const b = r.el.getBoundingClientRect();
          seeds.set(r.el, sizeKey(b.width, b.height));
        }
        const kel = e.known?.el;
        if (r && kel) res.at = kel.isConnected ? boxOf(kel, sx, sy) : null;
        if (r) {
          if (e.note.kind === 'textmark' && r.range) {
            const raw = [...r.range.getClientRects()].map((c) => toDoc(c, sx, sy));
            res.rects = lineRects(raw);
          }
          if (r.scroller && !scrollerInfo.has(r.scroller)) {
            const el = r.scroller;
            const br = el.getBoundingClientRect();
            scrollerInfo.set(el, {
              box: {
                x: br.left + sx + el.clientLeft,
                y: br.top + sy + el.clientTop,
                w: el.clientWidth,
                h: el.clientHeight,
              },
              scroll: { x: el.scrollLeft, y: el.scrollTop },
              pinned: !!r.pinned,
              top: !!res.top,
            });
          }
          if (
            e.note.kind === 'ink' &&
            e.note.anchor.place !== 'on' &&
            e.local &&
            !e.known &&
            !r.scroller &&
            !r.pinned &&
            // In the layout it was written in, a note is where the reader put it: nothing to read.
            (!asWritten(e.note.frame, r.box, r.scale, winW) ||
              offDoc(placeBox(e.local, r.origin, r.scale), docW))
          ) {
            // The first note of a slice reads all it needs; later ones stop when the slice ends.
            readEnd = tried > 1 ? t0 + budget : Number.POSITIVE_INFINITY;
            const room = roomOf(e, r, sx, sy, vh, docW);
            if (!room) {
              e.needResolve = true;
              nearLeft = mode === 'frame' && estimate(e) === 0;
              return;
            }
            res.room = room;
          }
        }
        reads.push(res);
      }
    };
    readAll(todo);
    // An on-screen note the path rung could not decide waits for the document text. When the
    // parser is done and the rest of this pass's budget builds that text, the note is decided
    // now, so its ink comes with this frame. A long page gets the text in idle slices instead.
    if (nearWait && quick && mode === 'frame' && !loading && resolver.prepare) {
      const again = todo.filter(
        (e) => e.waitSince !== undefined && !e.needResolve && !e.later && estimate(e) === 0,
      );
      const left = budget - (now() - t0);
      if (again.length && left > 0 && resolver.prepare(left)) {
        quick = null;
        for (const e of again) e.needResolve = true;
        // The first of them is decided whatever the clock says, as the first note of a pass is.
        tried = 0;
        readAll(again);
      }
    }
    readEnd = Number.POSITIVE_INFINITY;
    const tRead = now();

    // ---- compute ----
    const writes: { e: Entry; w: Write; near: boolean }[] = [];
    /** Margin notes that do not fit where they were written. They dock once the rest is placed. */
    const later: { e: Entry; r: Resolved; room: Room; pose: NotePose }[] = [];
    for (const { e, r, rects, room, clip, visible, hiddenEl, shapes, top, at } of reads) {
      e.shapes = r ? shapes : undefined;
      e.top = r ? top : undefined;
      if (!r) {
        // Not found. When its element is still there but not shown, the note hides with it.
        e.state = hiddenEl ? 'hidden' : 'unplaced';
        e.placed = undefined;
        e.el = hiddenEl ?? undefined;
        e.clips = undefined;
        e.clip = undefined;
        e.scroller = undefined;
        e.pinned = undefined;
        e.pending = undefined;
        if (e.drawnKey !== undefined)
          writes.push({
            e,
            w: { mark: false, pose: { origin: { x: 0, y: 0 }, scale: 1 }, key: '' },
            near: true,
          });
        continue;
      }
      // Cut to what the clipping ancestors leave. Content that is not visible leaves nothing.
      const cut = visible === false ? EMPTY : clip;
      e.state = isEmpty(cut) ? 'hidden' : 'placed';
      e.clips = r.clips;
      e.clip = cut;
      e.el = r.el;
      e.scroller = r.scroller;
      e.pinned = r.pinned;
      e.scroll0 = r.scroller ? scrollerInfo.get(r.scroller)?.scroll : undefined;
      const base: Pick<NotePose, 'scroller' | 'pinned' | 'clip' | 'top'> = {};
      if (r.scroller) base.scroller = r.scroller;
      if (r.pinned) base.pinned = true;
      if (cut) base.clip = cut;
      if (top) base.top = true;
      if (e.note.kind === 'textmark') {
        const rs = rects ?? [];
        const bb = union(rs) ?? { x: r.origin.x, y: r.origin.y, w: 0, h: 0 };
        e.placed = placedOf(e, { x: bb.x, y: bb.y }, 1, r.box, r.method, false, bb);
        const key = `m|${rs.map((q) => `${rnd(q.x)},${rnd(q.y)},${rnd(q.w)},${rnd(q.h)}`).join(';')}|${base.pinned ? 'p' : ''}|${scrollerKey(base.scroller)}|${clipKey(base.clip)}|${base.top ? 't' : ''}`;
        writes.push({
          e,
          w: { mark: true, pose: { origin: e.placed.origin, scale: 1, ...base }, rects: rs, key },
          near: false,
        });
        continue;
      }
      // The element the known pose was taken against is gone: the anchor places it.
      let k = e.known;
      if (k?.el && !at) {
        e.known = undefined;
        k = undefined;
      }
      const origin = k
        ? k.at && at
          ? { x: k.origin.x + at.x - k.at.x, y: k.origin.y + at.y - k.at.y }
          : k.origin
        : r.origin;
      const scale = k?.scale ?? r.scale;
      const pose: NotePose = { origin, scale, ...base };
      if (room && e.local) {
        // Where it was written, as long as that is inside the page and its ink is on no content.
        const box = placeBox(e.local, origin, scale);
        if (
          needsDock(box, docW, room.blocks) &&
          !(room.obstacles && stays(e.note, box, origin, scale, docW, room.obstacles))
        ) {
          later.push({ e, r, room, pose });
          continue;
        }
      }
      e.dock = undefined;
      e.placed = placedOf(e, origin, scale, r.box, r.method, false);
      writes.push({ e, w: { mark: false, pose, key: poseKey(pose, e.note.strokes.length) }, near: false });
    }
    if (later.length) {
      // Docked notes keep clear of all other ink and of each other.
      const moving = new Set(later.map((x) => x.e));
      const taken: Rect[] = [];
      for (const x of entries.values())
        if (x.state === 'placed' && x.placed && x.note.kind === 'ink' && !moving.has(x))
          taken.push(x.placed.bbox);
      // Near the screen first, then down the page, so each pass docks the same way.
      later.sort(
        (a, b) => estimate(a.e) - estimate(b.e) || a.r.box.y - b.r.box.y || a.r.origin.y - b.r.origin.y,
      );
      // A frame pass gives docking its own few ms. An idle slice shares one budget over reading,
      // docking and writing, so the slice as a whole yields.
      const tDock = mode === 'frame' ? now() : t0;
      for (let i = 0; i < later.length; i++) {
        if (i > 0 && now() - tDock > (mode === 'frame' ? DOCK_BUDGET_MS : WRITE_BUDGET_MS)) {
          for (const x of later.slice(i)) {
            x.e.needResolve = true;
            if (mode === 'frame' && estimate(x.e) === 0) nearLeft = true;
          }
          break;
        }
        const { e, r, room, pose } = later[i]!;
        const own = room.own ?? [];
        const d = dock({
          local: e.local!,
          origin: pose.origin,
          scale: pose.scale,
          place: e.note.anchor.place,
          anchorBox: r.box,
          own,
          line: lineAt(own, r.origin.y, e.note.anchor.place),
          docW,
          obstacles: room.obstacles ?? room.blocks,
          taken,
          reach: vh,
          docH,
          rtl: room.rtl,
          prev: e.dock,
        });
        taken.push(d.box);
        e.dock = d.kind;
        if (d.kind === 'M') pose.marker = d.box;
        else {
          pose.origin = d.origin;
          pose.scale = d.scale;
          const lead = d.leader;
          if (lead?.length) {
            pose.leaderTo = lead[lead.length - 1];
            if (lead.length > 1) pose.leaderVia = lead.slice(0, -1);
          }
        }
        e.placed = placedOf(e, d.origin, d.scale, r.box, r.method, true, d.kind === 'M' ? d.box : undefined);
        if (d.kind === 'M') e.placed.collapsed = true;
        writes.push({ e, w: { mark: false, pose, key: poseKey(pose, e.note.strokes.length) }, near: false });
      }
    }
    for (const w of writes) {
      const p = w.e.placed;
      w.near = !p || !!w.e.pinned || dist(p.bbox.y, p.bbox.y + p.bbox.h) === 0;
    }

    // ---- write ----
    const tWrite = now();
    ext.flush?.();
    for (const [el, info] of scrollerInfo)
      ext.setScroller?.(el, info.box, info.scroll, info.pinned, info.top);
    let drewNear = false;
    const apply = (e: Entry, w: Write): void => {
      e.pending = undefined;
      if (w.key === '') {
        layer.removeNote(e.note.id);
        e.drawnKey = undefined;
        return;
      }
      if (w.key === e.drawnKey) return;
      if (w.mark) {
        const pose: Pick<NotePose, 'scroller' | 'pinned' | 'clip' | 'top'> = {};
        if (w.pose.scroller) pose.scroller = w.pose.scroller;
        if (w.pose.pinned) pose.pinned = true;
        if (w.pose.clip) pose.clip = w.pose.clip;
        if (w.pose.top) pose.top = true;
        layer.drawMark(e.note, w.rects ?? [], pose);
      } else layer.drawNote(e.note, w.pose);
      e.drawnKey = w.key;
    };
    for (const { e, w, near } of writes) {
      if (near || mode === 'idle') {
        if (mode === 'idle' && !near && now() - t0 > WRITE_BUDGET_MS) {
          e.pending = w;
          continue;
        }
        apply(e, w);
        if (near) drewNear = true;
      } else {
        e.pending = w;
      }
    }
    if (mode === 'idle') {
      // Far notes from earlier passes, a slice at a time.
      for (const e of entries.values()) {
        if (!e.pending) continue;
        if (now() - t0 > WRITE_BUDGET_MS) break;
        apply(e, e.pending);
      }
    }
    syncTopLayer();
    syncListeners();
    const tEnd = now();

    // ---- report ----
    let backlog = false;
    let held = false;
    for (const e of entries.values()) {
      if (e.needResolve || e.pending) backlog = true;
      if (e.waitSince !== undefined) held = true;
    }
    if (waiting || held) scheduleModel(nearWait);
    if (firstAt !== null && (drewNear || !backlog)) {
      host.onTiming?.('place.first', tEnd - firstAt);
      firstAt = null;
    }
    if (allAt !== null && !backlog && !held) {
      host.onTiming?.('place.all', tEnd - allAt);
      allAt = null;
    }
    host.onTiming?.('place.read', tRead - t0);
    host.onTiming?.('place.write', tEnd - tWrite);
    host.onTiming?.('place.pass', tEnd - t0);
    host.onChange?.(placer.all(), placer.unplaced());
    if (nearLeft) schedule('upsert');
    else if (backlog) scheduleIdle();
  };

  /** Show our top layer host while notes need it, above anything with notes opened since. */
  const syncTopLayer = (): void => {
    const next = new Set<Element>();
    for (const e of entries.values()) if (e.top && e.drawnKey !== undefined) next.add(e.top);
    if (!next.size && !topEls.size) return;
    let raise = raiseTop;
    for (const el of next) if (!topEls.has(el)) raise = true;
    raiseTop = false;
    topEls = next;
    ext.syncTop?.(raise);
  };

  // ---- api --------------------------------------------------------------

  const makeEntry = (note: Note): Entry => ({
    note,
    local: note.kind === 'ink' ? inkBox(note.strokes) : null,
    needResolve: true,
    state: 'new',
  });

  const placer: Placer = {
    setNotes(notes) {
      const ids = new Set(notes.map((n) => n.id));
      for (const [id, e] of entries) {
        if (ids.has(id)) continue;
        if (e.drawnKey !== undefined) layer.removeNote(id);
        entries.delete(id);
      }
      for (const n of notes) {
        const e = entries.get(n.id);
        if (!e) entries.set(n.id, makeEntry(n));
        else if (e.note !== n) {
          e.note = n;
          e.local = n.kind === 'ink' ? inkBox(n.strokes) : null;
          e.drawnKey = undefined;
        }
      }
      firstAt = now();
      allAt = firstAt;
      schedule('notes');
    },
    upsert(note, known) {
      let e = entries.get(note.id);
      if (!e) {
        e = makeEntry(note);
        entries.set(note.id, e);
      } else {
        e.note = note;
        e.local = note.kind === 'ink' ? inkBox(note.strokes) : null;
        e.drawnKey = undefined;
      }
      e.needResolve = true;
      if (known && note.kind === 'ink') {
        // The anchor's element and its corner, read before the drawing below, while layout is
        // still clean from the writer's own reads. Passes measure from here.
        const el = e.el ?? resolver.locate?.(note.anchor) ?? undefined;
        const b = el?.getBoundingClientRect();
        // Draw now, with no resolve, where the writer saw it.
        e.known = {
          origin: { ...known.origin },
          scale: known.scale,
          el,
          at: b && { x: b.left + win.scrollX, y: b.top + win.scrollY },
        };
        const pose: NotePose = { origin: e.known.origin, scale: known.scale };
        if (e.scroller) pose.scroller = e.scroller;
        if (e.pinned) pose.pinned = true;
        if (e.top) pose.top = true;
        layer.drawNote(note, pose);
        e.drawnKey = poseKey(pose, note.strokes.length);
        e.state = 'placed';
        const prev = e.placed;
        e.placed = placedOf(
          e,
          e.known.origin,
          known.scale,
          prev?.anchorBox ?? { x: 0, y: 0, w: 0, h: 0 },
          prev?.method ?? 'path',
          false,
        );
        if (!prev) e.placed.anchorBox = e.placed.bbox;
      }
      schedule('upsert');
    },
    remove(id) {
      const e = entries.get(id);
      if (!e) return;
      entries.delete(id);
      layer.removeNote(id);
      syncListeners();
    },
    get: (id) => entries.get(id)?.placed,
    all() {
      const out: Placed[] = [];
      for (const e of entries.values()) if (e.state === 'placed' && e.placed) out.push(e.placed);
      return out;
    },
    unplaced() {
      const out: Note[] = [];
      for (const e of entries.values()) if (e.state === 'unplaced') out.push(e.note);
      return out;
    },
    hidden() {
      const out: Note[] = [];
      for (const e of entries.values()) if (e.state === 'hidden') out.push(e.note);
      return out;
    },
    waiting() {
      let n = 0;
      for (const e of entries.values()) if (e.waitSince !== undefined || (e.later && e.needResolve)) n++;
      return n;
    },
    toLocal(id, p) {
      const pl = entries.get(id)?.placed;
      if (!pl?.scale) return undefined;
      return { x: (p.x - pl.origin.x) / pl.scale, y: (p.y - pl.origin.y) / pl.scale };
    },
    refresh() {
      schedule('refresh');
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) win.cancelAnimationFrame(raf);
      post.disconnect();
      if (modelJob) {
        if (modelIsTimeout) win.clearTimeout(modelJob);
        else win.cancelIdleCallback?.(modelJob);
      }
      if (pinnedRaf) win.cancelAnimationFrame(pinnedRaf);
      if (idle) {
        if (idleIsTimeout) win.clearTimeout(idle);
        else win.cancelIdleCallback?.(idle);
      }
      if (moTimer) win.clearTimeout(moTimer);
      if (afterParse) doc.removeEventListener('DOMContentLoaded', onParsed);
      ro.disconnect();
      mo.disconnect();
      attrMo.disconnect();
      doc.fonts?.removeEventListener?.('loadingdone', onFonts);
      doc.removeEventListener('load', onLoad, true);
      for (const type of TOGGLE_EVENTS) doc.removeEventListener(type, onToggle, true);
      win.removeEventListener('orientationchange', onViewport);
      win.removeEventListener('resize', onViewport);
      win.visualViewport?.removeEventListener('resize', onViewport);
      for (const [el, rec] of scrollers) {
        el.removeEventListener('scroll', rec.handler);
        if (rec.raf) win.cancelAnimationFrame(rec.raf);
      }
      scrollers.clear();
      if (pinnedOn) win.removeEventListener('scroll', onWinScroll);
      pinnedOn = false;
      for (const e of entries.values()) if (e.drawnKey !== undefined) layer.removeNote(e.note.id);
      entries.clear();
      observed.clear();
    },
  };
  return placer;
};
