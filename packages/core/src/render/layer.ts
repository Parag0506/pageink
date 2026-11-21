import { LAYER_TAG } from '../brand';
import { addSheet, setDecls } from '../css';
import type { CreateLayer, InkColor, Layer, Note, NotePose, Point, Rect, StrokeTool, Theme } from '../types';
import { inkBox, intersects, n1, unionRects } from './geom';
import { markPath, seedOf } from './marks';
import { detectTheme, realColor, themeVars, varColor } from './theme';

const SVG_NS = 'http://www.w3.org/2000/svg';
const Z_MAX = 2147483647;

/**
 * Methods the placer uses beyond the Layer contract. They split layout reads
 * from writes so a placement pass can do all reads first. Callers that do not
 * use them still get correct output, because the layer then measures lazily.
 */
export interface InkLayer extends Layer {
  /** Read the host offset and window scroll. Read phase only. */
  measure(): void;
  /** Read the page theme when the theme is auto. Applied on the next write or flush. */
  readTheme(): void;
  /** Apply what measure() and readTheme() found. Write phase only. */
  flush(): void;
  /** Box (padding box, document space) and scroll offset of an inner scroller. */
  setScroller(el: Element, box: Rect, scroll: Point, pinned?: boolean, top?: boolean): void;
  /** New scroll offset for an inner scroller. Moves its notes by one transform. */
  scrollScroller(el: Element, scroll: Point): void;
  /** Ids of notes currently drawn. */
  drawn(): string[];
  /** Cut a drawn note to a document-space box, or stop cutting it. Writes only. */
  clipNote(id: string, clip: Rect | null): void;
  /** Small quiet handle that opens the tools. Null removes it. */
  setHandle(onOpen: (() => void) | null): void;
  /**
   * Notes drawn with `pose.top` sit in a second host shown in the browser's top layer, above
   * a modal dialog or an open popover. Call after a write phase: it shows that host while such
   * notes exist and removes it when none are left. `raise` shows it again, so it stays above
   * something the page opened after it. False when this browser has no top layer to use.
   */
  syncTop(raise?: boolean): boolean;
  /**
   * Quiet markers at the page edge, one per moved note, at the note's relative
   * height on the page. They scroll with the page like the ink. An empty list
   * removes them. Uses the page size from the last measure(), so it reads no layout and can
   * follow a write phase.
   */
  setMarkers(items: Marker[], onOpen?: (id: string, byKey: boolean) => void): void;
}

export interface Marker {
  id: string;
  /** Relative height on the page, 0 to 1. */
  relY: number;
  /** Tooltip and accessible name. */
  label: string;
}

/** Marker size in CSS px. The hit area is the whole button; the bar inside is what shows. */
const MARK_W = 12;
const MARK_H = 22;

// Inline !important beats any page rule, including `* { all: unset !important }`.
// Set through the CSSOM, which a strict style-src allows, never as an attribute.
const HOST_DECLS = [
  'all: initial',
  'display: block',
  'position: absolute',
  'left: 0',
  'top: 0',
  'width: 0',
  'height: 0',
  'min-width: 0',
  'min-height: 0',
  'max-width: none',
  'max-height: none',
  'margin: 0',
  'padding: 0',
  'border: 0 none',
  'overflow: visible',
  'pointer-events: none',
  // The host must not form a stacking context, or the highlighter could only
  // blend with the layer itself and never with the page under it. Every
  // surface inside carries the highest z-index instead.
  'z-index: auto',
  'transform: none',
  'filter: none',
  'opacity: 1',
  'visibility: visible',
  'contain: none',
  'isolation: auto',
  'mix-blend-mode: normal',
  'print-color-adjust: exact',
].map((d) => `${d} !important`);

const SHADOW_CSS = `
:host{all:initial !important;display:block !important;position:absolute !important;left:0 !important;top:0 !important;width:0 !important;height:0 !important;overflow:visible !important;pointer-events:none !important;z-index:auto !important;print-color-adjust:exact !important;-webkit-print-color-adjust:exact !important}
:host::before,:host::after{content:none !important;display:none !important}
.s{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;z-index:${Z_MAX};pointer-events:none;display:block;margin:0;padding:0;border:0}
.f{position:fixed}
.hi{mix-blend-mode:var(--hi-blend,multiply)}
.ui{position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:${Z_MAX};pointer-events:none;font:14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;direction:ltr;text-align:left}
.ui>*{pointer-events:auto}
.badge{position:fixed;right:16px;bottom:16px;min-width:32px;height:32px;padding:0 10px;border-radius:16px;border:0;box-sizing:border-box;cursor:pointer;background:var(--c-badge-bg);color:var(--c-badge-fg);font:600 13px/32px system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.badge[hidden]{display:none}
.hdl{position:fixed;display:flex;align-items:flex-end;justify-content:center;box-sizing:border-box;width:56px;height:44px;left:50%;margin:0 0 0 -28px;bottom:max(4px,env(safe-area-inset-bottom));padding:0 0 6px;border:0;background:none;cursor:pointer;color:var(--c-lead);opacity:.75;-webkit-tap-highlight-color:transparent}
.hdl i{display:block;width:30px;height:5px;border-radius:3px;background:currentColor;box-shadow:0 0 0 1px var(--c-badge-fg)}
.hdl.v{flex-direction:row;align-items:center;justify-content:flex-end;width:44px;height:56px;left:auto;right:max(4px,env(safe-area-inset-right));bottom:auto;top:50%;margin:-28px 0 0;padding:0 6px 0 0}
.hdl.v i{width:5px;height:30px}
.mks,.dks{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:${Z_MAX};pointer-events:none}
.mk,.dk{position:absolute;display:block;box-sizing:border-box;width:${MARK_W}px;height:${MARK_H}px;margin:0;padding:2px 3px;border:0;background:none;cursor:pointer;pointer-events:auto;opacity:.6;-webkit-tap-highlight-color:transparent}
.mk i,.dk i{display:block;width:100%;height:100%;border-radius:3px;background:var(--c-lead);box-shadow:0 0 0 1px var(--c-badge-fg)}
.mk:hover,.mk:focus-visible{opacity:1}
.mk:focus-visible,.dk:focus-visible{outline:2px solid var(--c-lead);outline-offset:1px;border-radius:4px}
.dk{display:flex;align-items:center;justify-content:center;padding:0;opacity:1}
.dk i{width:10px;height:10px;flex:none;border-radius:50%;background:var(--c-ink-1);box-shadow:0 0 0 2px var(--c-badge-fg),0 0 0 3px var(--c-lead)}
.dk:hover i,.dk[aria-expanded=true] i{background:var(--c-sel)}
.pop{position:absolute;padding:8px;border-radius:8px;background:var(--c-badge-fg);box-shadow:0 2px 12px rgba(0,0,0,.3);z-index:${Z_MAX};pointer-events:auto}
.pop svg{display:block}
.pop[hidden],.dk[hidden]{display:none}
.lead{fill:none;stroke:var(--c-lead);stroke-width:1;stroke-dasharray:3 3}
.dot{fill:var(--c-lead)}
.sel{fill:none;stroke:var(--c-sel);stroke-width:1.5;stroke-dasharray:4 3}
@media print{.s,.s *{print-color-adjust:exact !important;-webkit-print-color-adjust:exact !important}.ui,.sel,.mks,.dks,.pop{display:none !important}}
`;

function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K): SVGElementTagNameMap[K] {
  return doc.createElementNS(SVG_NS, tag);
}

/** A host with its own shadow root and surfaces: the page layer, or the top layer one. */
interface Plane {
  host: HTMLElement;
  root: ShadowRoot;
  hiDoc: { svg: SVGSVGElement; g: SVGGElement };
  hiFix: { svg: SVGSVGElement; g: SVGGElement };
  penDoc: { svg: SVGSVGElement; g: SVGGElement };
  penFix: { svg: SVGSVGElement; g: SVGGElement };
  defs: SVGDefsElement;
  view: { set(css: string): void; remove(): void };
  /** Host offset in document space, from measure(). */
  off: Point;
  top: boolean;
}

/** Where a note's groups live. Coordinates differ per kind. */
interface Container {
  /** doc: document space. fix: viewport space. scr: scroller content space. */
  kind: 'doc' | 'fix' | 'scr';
  hi: SVGGElement;
  pen: SVGGElement;
  plane: Plane;
}

interface ScrollerView extends Container {
  kind: 'scr';
  hiSvg: SVGSVGElement;
  penSvg: SVGSVGElement;
  /** Padding box. Document space, or viewport space when pinned. */
  box: Rect;
  scroll: Point;
  pinned: boolean;
  top: boolean;
}

interface NoteView {
  kind: 'ink' | 'mark';
  note: Note;
  c: Container;
  hiG: SVGGElement;
  penG: SVGGElement;
  deco: SVGGElement;
  paths: Map<string, SVGPathElement>;
  /** Note origin in container coordinates and scale. */
  at: Point;
  scale: number;
  /** Mark rects in container coordinates. */
  rects?: Rect[];
  key: string;
  leaderTo?: Point;
  leaderVia?: Point[];
  /** Folded: the marker shown instead of the ink, and its box in document space. */
  dk?: HTMLButtonElement;
  marker?: Rect;
  /** Document-space box the note is cut to. */
  clip?: Rect;
  /** Clip paths: in note-local units for the transformed stroke groups, in container units for the rest. */
  clipL?: SVGRectElement;
  clipC?: SVGRectElement;
}

function transformOf(p: Point, s: number): string {
  return `translate(${n1(p.x)} ${n1(p.y)}) scale(${Math.round(s * 10000) / 10000})`;
}

export const createLayer: CreateLayer = (doc, opts) => {
  const win = doc.defaultView ?? window;
  const z = opts?.zIndex ?? Z_MAX;
  const css = z === Z_MAX ? SHADOW_CSS : SHADOW_CSS.replaceAll(String(Z_MAX), String(z));

  const makePlane = (top: boolean): Plane => {
    const h = doc.createElement(LAYER_TAG);
    setDecls(h, HOST_DECLS);
    const r = h.attachShadow({ mode: 'closed' });
    addSheet(r, css);
    // Rules that follow the page: zoom and transforms on <html>. Kept apart so the base sheet never changes.
    const view = addSheet(r, '');
    const surface = (cls: string): { svg: SVGSVGElement; g: SVGGElement } => {
      const svg = svgEl(doc, 'svg');
      svg.setAttribute('class', cls);
      svg.setAttribute('width', '1');
      svg.setAttribute('height', '1');
      svg.setAttribute('overflow', 'visible');
      svg.setAttribute('aria-hidden', 'true');
      const g = svgEl(doc, 'g');
      svg.append(g);
      r.append(svg);
      return { svg, g };
    };
    // Order sets stacking: highlighter under pen, document under pinned.
    const hiDoc = surface('s hi');
    const hiFix = surface('s f hi');
    const penDoc = surface('s');
    const penFix = surface('s f');
    // Clip paths for notes cut to the content they sit on. Ids are scoped to this shadow root.
    const defs = svgEl(doc, 'defs');
    penDoc.svg.prepend(defs);
    return { host: h, root: r, hiDoc, hiFix, penDoc, penFix, defs, view, off: { x: 0, y: 0 }, top };
  };
  const main = makePlane(false);
  const host = main.host;
  const root = main.root;
  let clipSeq = 0;

  const ui = doc.createElement('div');
  ui.className = 'ui';
  root.append(ui);
  const badge = doc.createElement('button');
  badge.className = 'badge';
  badge.type = 'button';
  badge.hidden = true;
  ui.append(badge);
  let badgeOpen: (() => void) | undefined;
  const onBadge = (): void => badgeOpen?.();
  badge.addEventListener('click', onBadge);
  let handle: HTMLButtonElement | null = null;
  // Markers sit in document space, so the browser scrolls them with the page.
  const marks = doc.createElement('div');
  marks.className = 'mks';
  marks.hidden = true;
  root.append(marks);
  let markOpen: ((id: string, byKey: boolean) => void) | undefined;
  const onMark = (e: MouseEvent): void => {
    const b = (e.target as Element | null)?.closest?.('button.mk') as HTMLButtonElement | null;
    if (b?.dataset.note) markOpen?.(b.dataset.note, e.detail === 0);
  };
  marks.addEventListener('click', onMark);
  // Markers of notes with no room beside their words, and the one popover that shows such a note.
  const docks = doc.createElement('div');
  docks.className = 'dks';
  root.append(docks);
  const pop = doc.createElement('div');
  pop.className = 'pop';
  pop.hidden = true;
  pop.id = 'ink-pop';
  pop.setAttribute('role', 'img');
  pop.setAttribute('aria-label', 'Handwritten note');
  root.append(pop);

  doc.documentElement.append(host);

  // View state, filled by measure(). Draw calls only use it.
  const hostOff: Point = main.off;
  const scroll: Point = { x: 0, y: 0 };
  let measured = false;
  /** Page height and width at the last measure(), for markers drawn after the writes that follow it. */
  const page = { h: 0, w: 0 };
  let viewDirty = true;
  /** Effective CSS zoom of <html>. Rects and pointer coordinates are already zoomed, so the host undoes it. */
  let zoom = 1;
  /** <html> is scaled, rotated or skewed. Ink would land in the wrong place, so it is not shown. */
  let warped = false;
  let viewCss = '';

  const docC: Container = { kind: 'doc', hi: main.hiDoc.g, pen: main.penDoc.g, plane: main };
  const fixC: Container = { kind: 'fix', hi: main.hiFix.g, pen: main.penFix.g, plane: main };

  // ---- the top layer ---------------------------------------------------------------
  // Notes on a modal dialog or an open popover sit in a second host, a manual popover shown
  // after the page's own, so the browser paints it above them. It takes no input, never
  // closes the page's popovers, and exists only while such notes do.
  const canTop =
    typeof (win as Window & typeof globalThis).HTMLElement?.prototype?.showPopover === 'function';
  let topPlane: Plane | null = null;
  let topDocC: Container | null = null;
  let topFixC: Container | null = null;
  let topShown = false;
  const topContainers = (): { doc: Container; fix: Container } => {
    if (!topPlane) {
      const t = makePlane(true);
      topPlane = t;
      t.host.setAttribute('popover', 'manual');
      t.host.dataset.theme = current;
      for (const [k, val] of Object.entries(themeVars(current))) t.host.style.setProperty(k, val);
      t.view.set(viewCss);
      topDocC = { kind: 'doc', hi: t.hiDoc.g, pen: t.penDoc.g, plane: t };
      topFixC = { kind: 'fix', hi: t.hiFix.g, pen: t.penFix.g, plane: t };
      viewDirty = true;
    }
    return { doc: topDocC as Container, fix: topFixC as Container };
  };
  const showTop = (): void => {
    const t = topPlane;
    if (!t) return;
    try {
      if (topShown) t.host.hidePopover();
    } catch {
      // Already closed by the browser.
    }
    if (!t.host.isConnected) doc.documentElement.append(t.host);
    try {
      t.host.showPopover();
      topShown = true;
    } catch {
      topShown = false;
    }
  };
  const dropTop = (): void => {
    const t = topPlane;
    if (!t) return;
    try {
      if (topShown) t.host.hidePopover();
    } catch {
      // Already closed.
    }
    topShown = false;
    t.host.remove();
  };
  const scrollers = new Map<Element, ScrollerView>();
  const views = new Map<string, NoteView>();
  const pathOf = new Map<string, SVGPathElement>();
  let hidden = new Set<string>();
  let selected = new Set<string>();

  let mode: Theme | 'auto' = opts?.theme ?? 'auto';
  let current: Theme = 'light';
  let pendingTheme: Theme | null = null;
  /** The page theme was not read at creation. The next readTheme() or flush() reads it. */
  let themeLate = false;

  const applyTheme = (t: Theme): void => {
    current = t;
    for (const h of topPlane ? [host, topPlane.host] : [host]) {
      h.dataset.theme = t;
      for (const [k, v] of Object.entries(themeVars(t))) h.style.setProperty(k, v);
    }
  };

  const readView = (): void => {
    const html = doc.documentElement;
    const cs = win.getComputedStyle(html);
    const z = Number.parseFloat(cs.getPropertyValue('zoom'));
    const zNext = Number.isFinite(z) && z > 0 ? z : 1;
    const tf = cs.transform;
    let warpNext = false;
    if (tf && tf !== 'none') {
      const m = /^matrix\(([^)]+)\)$/.exec(tf);
      const n = m ? (m[1] ?? '').split(',').map(Number) : [];
      // A pure translation is cancelled by the host offset. Anything else is not.
      warpNext = !(n.length === 6 && n[0] === 1 && n[1] === 0 && n[2] === 0 && n[3] === 1);
    }
    if (zNext !== zoom || warpNext !== warped) viewDirty = true;
    zoom = zNext;
    warped = warpNext;
  };

  const measure = (): void => {
    readView();
    const r = host.getBoundingClientRect();
    scroll.x = win.scrollX;
    scroll.y = win.scrollY;
    const html = doc.documentElement;
    page.h = Math.max(html.scrollHeight, doc.body?.scrollHeight ?? 0);
    page.w = html.clientWidth;
    const hx = r.left + scroll.x;
    const hy = r.top + scroll.y;
    if (hx !== hostOff.x || hy !== hostOff.y || !measured) viewDirty = true;
    hostOff.x = hx;
    hostOff.y = hy;
    const t = topPlane;
    if (t?.host.isConnected) {
      const tr = t.host.getBoundingClientRect();
      const tx = tr.left + scroll.x;
      const ty = tr.top + scroll.y;
      if (tx !== t.off.x || ty !== t.off.y) viewDirty = true;
      t.off.x = tx;
      t.off.y = ty;
    }
    measured = true;
  };

  const flush = (): void => {
    if (!measured) measure();
    if (themeLate) {
      themeLate = false;
      if (mode === 'auto') {
        const t = detectTheme(doc);
        if (t !== current) pendingTheme = t;
      }
    }
    if (pendingTheme) {
      applyTheme(pendingTheme);
      pendingTheme = null;
    }
    if (viewDirty) {
      const css =
        (zoom !== 1 ? `:host{zoom:${1 / zoom} !important}` : '') +
        (warped ? '.s{display:none !important}' : '');
      if (css !== viewCss) {
        viewCss = css;
        main.view.set(css);
        topPlane?.view.set(css);
      }
      // Document surfaces cancel any offset of the host, for pages that
      // position <html> or give it a margin.
      for (const pl of topPlane ? [main, topPlane] : [main]) {
        const t = `translate(${n1(-pl.off.x)} ${n1(-pl.off.y)})`;
        pl.hiDoc.g.setAttribute('transform', t);
        pl.penDoc.g.setAttribute('transform', t);
      }
      viewDirty = false;
    }
  };

  const onScheme = (): void => {
    if (mode === 'auto') applyTheme(detectTheme(doc));
  };
  const mq = win.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', onScheme);
  // While the page loads, or before its first paint, reading its colours would force a style pass
  // ahead of the page's own, and hold back that paint. The first placement reads them after
  // layout and applies them before any ink is drawn.
  // A browser that does not report paints counts as painted, so its colours are read at once.
  const painted = (): boolean => {
    try {
      const w = win as Window & typeof globalThis;
      if (!w.PerformanceObserver?.supportedEntryTypes?.includes('paint')) return true;
      return w.performance.getEntriesByType('paint').length > 0;
    } catch {
      return true;
    }
  };
  if (mode === 'auto' && (doc.readyState === 'loading' || !painted())) {
    applyTheme('light');
    pendingTheme = null;
    themeLate = true;
  } else applyTheme(mode === 'auto' ? detectTheme(doc) : mode);

  const placeScroller = (sv: ScrollerView, box: Rect, sc: Point): void => {
    sv.box = box;
    sv.scroll = { x: sc.x, y: sc.y };
    for (const svg of [sv.hiSvg, sv.penSvg]) {
      svg.setAttribute('x', n1(box.x));
      svg.setAttribute('y', n1(box.y));
      svg.setAttribute('width', n1(Math.max(0, box.w)));
      svg.setAttribute('height', n1(Math.max(0, box.h)));
    }
    const t = `translate(${n1(-sc.x)} ${n1(-sc.y)})`;
    sv.hi.setAttribute('transform', t);
    sv.pen.setAttribute('transform', t);
  };

  const buildScroller = (pinned: boolean, top: boolean): ScrollerView => {
    const mk = (parent: SVGGElement): { svg: SVGSVGElement; g: SVGGElement } => {
      // A nested svg viewport clips its content to the scroller's box.
      const svg = svgEl(doc, 'svg');
      svg.setAttribute('overflow', 'hidden');
      const g = svgEl(doc, 'g');
      svg.append(g);
      parent.append(svg);
      return { svg, g };
    };
    const tc = top ? topContainers() : null;
    const base = pinned ? (tc?.fix ?? fixC) : (tc?.doc ?? docC);
    const h = mk(base.hi);
    const p = mk(base.pen);
    return {
      kind: 'scr',
      hi: h.g,
      pen: p.g,
      plane: base.plane,
      hiSvg: h.svg,
      penSvg: p.svg,
      box: { x: 0, y: 0, w: 0, h: 0 },
      scroll: { x: 0, y: 0 },
      pinned,
      top,
    };
  };

  /** Set a scroller's box from document space. Pinned scrollers store viewport space. */
  const setScroller = (el: Element, box: Rect, sc: Point, pinned: boolean, top = false): ScrollerView => {
    let sv = scrollers.get(el);
    if (sv && (sv.pinned !== pinned || sv.top !== top)) {
      const old = sv;
      sv = buildScroller(pinned, top);
      for (const v of views.values()) if (v.c === old) move(v, sv);
      old.hiSvg.remove();
      old.penSvg.remove();
      scrollers.set(el, sv);
    }
    if (!sv) {
      sv = buildScroller(pinned, top);
      scrollers.set(el, sv);
    }
    const b = pinned ? { x: box.x - scroll.x, y: box.y - scroll.y, w: box.w, h: box.h } : box;
    placeScroller(sv, b, sc);
    return sv;
  };

  const containerFor = (pose?: Pick<NotePose, 'scroller' | 'pinned' | 'top'>): Container => {
    const el = pose?.scroller;
    const top = !!pose?.top && canTop;
    if (el) {
      const sv = scrollers.get(el);
      if (sv && sv.pinned === !!pose.pinned && sv.top === top) return sv;
      // Not told by a placer: read the scroller once so the drawing is still right.
      const r = el.getBoundingClientRect();
      const box = {
        x: r.left + scroll.x + el.clientLeft,
        y: r.top + scroll.y + el.clientTop,
        w: el.clientWidth,
        h: el.clientHeight,
      };
      return setScroller(el, box, { x: el.scrollLeft, y: el.scrollTop }, !!pose.pinned, top);
    }
    if (top) {
      const tc = topContainers();
      return pose?.pinned ? tc.fix : tc.doc;
    }
    return pose?.pinned ? fixC : docC;
  };

  /** Document point to container coordinates, using the measured scroll. */
  const toC = (c: Container, p: Point): Point => {
    if (c.kind === 'doc') return p;
    const vp = { x: p.x - scroll.x, y: p.y - scroll.y };
    if (c.kind === 'fix') return vp;
    const sv = c as ScrollerView;
    const base = sv.pinned ? vp : p;
    return { x: base.x - sv.box.x + sv.scroll.x, y: base.y - sv.box.y + sv.scroll.y };
  };

  /** Shift from container coordinates to document space, at the given window scroll. */
  const shiftOf = (c: Container, now: Point): Point => {
    if (c.kind === 'doc') return { x: 0, y: 0 };
    if (c.kind === 'fix') return { x: now.x, y: now.y };
    const sv = c as ScrollerView;
    const x = sv.box.x - sv.scroll.x + (sv.pinned ? now.x : 0);
    const y = sv.box.y - sv.scroll.y + (sv.pinned ? now.y : 0);
    return { x, y };
  };

  const move = (v: NoteView, c: Container): void => {
    if (v.c === c) return;
    // Clip paths are found by id inside one shadow root, so a note that changes host gets new ones.
    if (v.c.plane !== c.plane && v.clipC) {
      for (const g of [v.hiG, v.penG, v.deco]) g.removeAttribute('clip-path');
      v.clipC.parentElement?.remove();
      v.clipL?.parentElement?.remove();
      v.clipC = v.clipL = undefined;
    }
    c.hi.append(v.hiG);
    c.pen.append(v.penG, v.deco);
    v.c = c;
  };

  const newView = (note: Note, kind: 'ink' | 'mark', c: Container): NoteView => {
    const hiG = svgEl(doc, 'g');
    const penG = svgEl(doc, 'g');
    const deco = svgEl(doc, 'g');
    hiG.dataset.note = note.id;
    penG.dataset.note = note.id;
    c.hi.append(hiG);
    c.pen.append(penG, deco);
    return { kind, note, c, hiG, penG, deco, paths: new Map(), at: { x: 0, y: 0 }, scale: 1, key: '' };
  };

  const clipRect = (pl: Plane): SVGRectElement => {
    const cp = svgEl(doc, 'clipPath');
    const id = `ink-clip-${++clipSeq}`;
    cp.id = id;
    cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const r = svgEl(doc, 'rect');
    cp.append(r);
    pl.defs.append(cp);
    return r;
  };
  const setRect = (r: SVGRectElement, x: number, y: number, w: number, h: number): void => {
    r.setAttribute('x', n1(x));
    r.setAttribute('y', n1(y));
    r.setAttribute('width', n1(Math.max(0, w)));
    r.setAttribute('height', n1(Math.max(0, h)));
  };
  /** Cut the view to its clip box, which follows the anchor's clipping ancestors. */
  const applyClip = (v: NoteView): void => {
    // A marker shows only where its note's content is shown.
    if (v.dk && v.marker) v.dk.hidden = !!v.clip && !intersects(v.clip, v.marker);
    const groups = [v.hiG, v.penG, v.deco];
    if (!v.clip) {
      if (!v.clipC) return;
      for (const g of groups) g.removeAttribute('clip-path');
      v.clipC.parentElement?.remove();
      v.clipL?.parentElement?.remove();
      v.clipC = v.clipL = undefined;
      return;
    }
    if (!v.clipC) {
      v.clipC = clipRect(v.c.plane);
      v.clipL = clipRect(v.c.plane);
    }
    const urlC = `url(#${v.clipC.parentElement!.id})`;
    const urlL = `url(#${v.clipL!.parentElement!.id})`;
    const p = toC(v.c, v.clip);
    setRect(v.clipC, p.x, p.y, v.clip.w, v.clip.h);
    const s = v.scale || 1;
    setRect(v.clipL!, (p.x - v.at.x) / s, (p.y - v.at.y) / s, v.clip.w / s, v.clip.h / s);
    // Ink groups carry the note transform, so their clip is in note-local units.
    const local = v.kind === 'ink' ? urlL : urlC;
    if (v.hiG.getAttribute('clip-path') !== local) {
      v.hiG.setAttribute('clip-path', local);
      v.penG.setAttribute('clip-path', local);
    }
    if (v.deco.getAttribute('clip-path') !== urlC) v.deco.setAttribute('clip-path', urlC);
  };

  const dropView = (v: NoteView): void => {
    if (popId === v.note.id) closePop();
    v.dk?.remove();
    v.clipC?.parentElement?.remove();
    v.clipL?.parentElement?.remove();
    v.hiG.remove();
    v.penG.remove();
    v.deco.remove();
    for (const id of v.paths.keys()) pathOf.delete(id);
  };

  /** Ink box of a view in container coordinates. */
  const viewBox = (v: NoteView): Rect | null => {
    if (v.kind === 'mark') return unionRects(v.rects ?? []);
    const b = inkBox(v.note.strokes);
    if (!b) return null;
    return { x: v.at.x + b.x * v.scale, y: v.at.y + b.y * v.scale, w: b.w * v.scale, h: b.h * v.scale };
  };

  const drawDeco = (v: NoteView): void => {
    v.deco.replaceChildren();
    const box = viewBox(v);
    if (v.leaderTo && box && !v.marker) {
      const t = toC(v.c, v.leaderTo);
      const pts = [...(v.leaderVia ?? []).map((p) => toC(v.c, p)), t];
      // Start on the edge of the ink box nearest the first point.
      const f = pts[0]!;
      const sx = Math.max(box.x, Math.min(f.x, box.x + box.w));
      const sy = Math.max(box.y, Math.min(f.y, box.y + box.h));
      const line = svgEl(doc, 'path');
      line.setAttribute('class', 'lead');
      line.setAttribute('d', `M${n1(sx)} ${n1(sy)}${pts.map((p) => `L${n1(p.x)} ${n1(p.y)}`).join('')}`);
      const dot = svgEl(doc, 'circle');
      dot.setAttribute('class', 'dot');
      dot.setAttribute('cx', n1(t.x));
      dot.setAttribute('cy', n1(t.y));
      dot.setAttribute('r', '2');
      v.deco.append(line, dot);
    }
    if (selected.has(v.note.id) && box) {
      const r = svgEl(doc, 'rect');
      r.setAttribute('class', 'sel');
      r.setAttribute('x', n1(box.x - 4));
      r.setAttribute('y', n1(box.y - 4));
      r.setAttribute('width', n1(box.w + 8));
      r.setAttribute('height', n1(box.h + 8));
      r.setAttribute('rx', '4');
      v.deco.append(r);
    }
  };

  // ---- folded notes ---------------------------------------------------------------
  // A note with no free space beside its words is drawn as a small marker. Hover with a pen or
  // a mouse, a tap or a key shows the ink at reading size in a popover; a press elsewhere, leaving
  // a hover, or Escape hides it.
  let popId = '';
  let popPinned = false;
  let popByKey = false;
  let popTimer = 0;
  const holdPop = (): void => {
    win.clearTimeout(popTimer);
    popTimer = 0;
  };
  const closePop = (): void => {
    holdPop();
    if (!popId) return;
    views.get(popId)?.dk?.setAttribute('aria-expanded', 'false');
    popId = '';
    pop.hidden = true;
    pop.replaceChildren();
    win.removeEventListener('pointerdown', onAway, true);
  };
  const hideSoon = (): void => {
    holdPop();
    if (!popPinned) popTimer = win.setTimeout(closePop, 250);
  };
  /** A press outside the layer closes the popover. Listened for only while it is open. */
  const onAway = (e: Event): void => {
    if (!e.composedPath().includes(host)) closePop();
  };
  const openPop = (v: NoteView, pin: boolean): void => {
    holdPop();
    popPinned = pin;
    const b = inkBox(v.note.strokes);
    const m = v.marker;
    if (!b || !m || popId === v.note.id) return;
    closePop();
    popPinned = pin;
    // Read at the time of the event, not in a placement pass.
    const vw = doc.documentElement.clientWidth || win.innerWidth;
    const s = Math.min(v.scale || 1, (vw - 40) / (b.w || 1));
    const svg = svgEl(doc, 'svg');
    svg.setAttribute('width', n1(b.w * s));
    svg.setAttribute('height', n1(b.h * s));
    svg.setAttribute('viewBox', `${n1(b.x)} ${n1(b.y)} ${n1(b.w)} ${n1(b.h)}`);
    for (const g of [v.hiG, v.penG]) {
      const c = svgEl(doc, 'g');
      for (const p of g.children) {
        const q = p.cloneNode() as SVGPathElement;
        q.removeAttribute('data-stroke');
        c.append(q);
      }
      svg.append(c);
    }
    pop.replaceChildren(svg);
    const pw = b.w * s + 16;
    const ph = b.h * s + 16;
    const x = Math.min(Math.max(m.x + m.w / 2 - pw / 2, win.scrollX + 8), win.scrollX + vw - pw - 8);
    // Below the marker, or above it when only that fits on the screen.
    const y =
      m.y + m.h + ph + 6 > win.scrollY + win.innerHeight && m.y - ph - 6 >= win.scrollY
        ? m.y - ph - 6
        : m.y + m.h + 6;
    pop.style.setProperty('left', `${n1(x - main.off.x)}px`);
    pop.style.setProperty('top', `${n1(y - main.off.y)}px`);
    pop.hidden = false;
    popId = v.note.id;
    v.dk?.setAttribute('aria-expanded', 'true');
    win.addEventListener('pointerdown', onAway, true);
  };
  // One set of listeners for all markers, on their container.
  const dkOf = (t: EventTarget | null): NoteView | undefined => {
    const b = (t as Element | null)?.closest?.('.dk') as HTMLElement | null;
    return b ? views.get(b.dataset.note ?? '') : undefined;
  };
  const onDk = (e: Event): void => {
    const v = dkOf(e.target);
    const t = e.type;
    if (t === 'keydown') {
      if ((e as KeyboardEvent).key === 'Escape' && popId) closePop();
    } else if (t === 'focusout') {
      if (popByKey && v && popId === v.note.id) closePop();
    } else if (t === 'click') {
      if (!v) return;
      popByKey = (e as MouseEvent).detail === 0;
      // A hover opened it: the press keeps it open. Kept open: the press closes it.
      if (popId === v.note.id && popPinned) closePop();
      else openPop(v, true);
    } else {
      const k = (e as PointerEvent).pointerType;
      if (!v || (k !== 'mouse' && k !== 'pen') || dkOf((e as PointerEvent).relatedTarget) === v) return;
      if (t === 'pointerover') openPop(v, popId === v.note.id && popPinned);
      else hideSoon();
    }
  };
  const DK_EVENTS = ['pointerover', 'pointerout', 'click', 'keydown', 'focusout'];
  for (const t of DK_EVENTS) docks.addEventListener(t, onDk);
  pop.addEventListener('pointerenter', holdPop);
  pop.addEventListener('pointerleave', hideSoon);

  /** Show the note as ink, or folded into its marker. */
  const fold = (v: NoteView, m: Rect | undefined): void => {
    v.marker = m;
    const shown = m ? 'none' : '';
    v.hiG.style.display = shown;
    v.penG.style.display = shown;
    if (!m) {
      if (popId === v.note.id) closePop();
      v.dk?.remove();
      v.dk = undefined;
      return;
    }
    let b = v.dk;
    if (!b) {
      b = v.dk = doc.createElement('button');
      b.type = 'button';
      b.className = 'dk';
      b.dataset.note = v.note.id;
      b.title = 'Show the note written here';
      b.setAttribute('aria-label', b.title);
      b.setAttribute('aria-expanded', 'false');
      b.setAttribute('aria-controls', pop.id);
      b.append(doc.createElement('i'));
      docks.append(b);
    }
    for (const [k, val] of [
      ['left', m.x - main.off.x],
      ['top', m.y - main.off.y],
      ['width', m.w],
      ['height', m.h],
    ] as const)
      b.style.setProperty(k, `${n1(val)}px`);
    if (popId === v.note.id) {
      popId = '';
      openPop(v, popPinned);
    }
  };

  const drawNote = (note: Note, pose: NotePose): void => {
    flush();
    let v = views.get(note.id);
    const c = containerFor(pose);
    if (v && v.kind !== 'ink') {
      dropView(v);
      views.delete(note.id);
      v = undefined;
    }
    if (!v) {
      v = newView(note, 'ink', c);
      views.set(note.id, v);
    }
    move(v, c);
    v.note = note;
    v.at = toC(c, pose.origin);
    v.scale = pose.scale;
    const tf = transformOf(v.at, v.scale);
    v.hiG.setAttribute('transform', tf);
    v.penG.setAttribute('transform', tf);

    // Strokes never change once written, so only adds and removes matter.
    const keep = new Set<string>();
    for (const s of note.strokes) {
      keep.add(s.id);
      if (v.paths.has(s.id)) continue;
      const p = svgEl(doc, 'path');
      p.setAttribute('d', s.d);
      p.style.fill = varColor(s.color, s.tool);
      p.dataset.stroke = s.id;
      if (hidden.has(s.id)) p.style.display = 'none';
      (s.tool === 'hi' ? v.hiG : v.penG).append(p);
      v.paths.set(s.id, p);
      pathOf.set(s.id, p);
    }
    for (const [id, p] of v.paths) {
      if (keep.has(id)) continue;
      p.remove();
      v.paths.delete(id);
      pathOf.delete(id);
    }
    v.leaderTo = pose.leaderTo;
    v.leaderVia = pose.leaderVia;
    fold(v, pose.marker);
    drawDeco(v);
    v.clip = pose.clip;
    applyClip(v);
  };

  const drawMark = (
    note: Note,
    rects: Rect[],
    pose?: Pick<NotePose, 'scroller' | 'pinned' | 'clip' | 'top'>,
  ): void => {
    flush();
    let v = views.get(note.id);
    const c = containerFor(pose);
    if (v && v.kind !== 'mark') {
      dropView(v);
      views.delete(note.id);
      v = undefined;
    }
    if (!v) {
      v = newView(note, 'mark', c);
      views.set(note.id, v);
    }
    move(v, c);
    v.note = note;
    const local = rects.map((r) => {
      const p = toC(c, r);
      return { x: p.x, y: p.y, w: r.w, h: r.h };
    });
    const style = note.mark?.style ?? 'highlight';
    const color = note.mark?.color ?? (style === 'highlight' ? 'hi-1' : 'ink-1');
    const key = `${style}|${color}|${local.map((r) => `${n1(r.x)},${n1(r.y)},${n1(r.w)},${n1(r.h)}`).join(';')}`;
    v.rects = local;
    v.at = local[0] ? { x: local[0].x, y: local[0].y } : { x: 0, y: 0 };
    v.scale = 1;
    if (key !== v.key) {
      v.key = key;
      const tool: StrokeTool = style === 'highlight' ? 'hi' : 'pen';
      let p = v.paths.get(note.id);
      if (!p) {
        p = svgEl(doc, 'path');
        p.dataset.mark = style;
        v.paths.set(note.id, p);
        // The eraser preview hides a text mark by its note id.
        pathOf.set(note.id, p);
        if (hidden.has(note.id)) p.style.display = 'none';
      }
      p.setAttribute('d', markPath(style, local, seedOf(note.id)));
      p.style.fill = varColor(color, tool);
      (tool === 'hi' ? v.hiG : v.penG).append(p);
    }
    v.leaderTo = undefined;
    fold(v, undefined);
    drawDeco(v);
    v.clip = pose?.clip;
    applyClip(v);
  };

  const removeNote = (id: string): void => {
    const v = views.get(id);
    if (!v) return;
    dropView(v);
    views.delete(id);
  };

  const syncTop = (raise = false): boolean => {
    if (!canTop) return false;
    let need = false;
    for (const v of views.values()) {
      if (v.c.plane.top) {
        need = true;
        break;
      }
    }
    if (!need) {
      if (topPlane?.host.isConnected) dropTop();
      return true;
    }
    if (raise || !topShown || !topPlane?.host.isConnected) showTop();
    return true;
  };

  const clear = (): void => {
    for (const v of views.values()) dropView(v);
    views.clear();
  };

  const setSelected = (ids: string[]): void => {
    const next = new Set(ids);
    const touched = new Set([...selected, ...next]);
    selected = next;
    for (const id of touched) {
      const v = views.get(id);
      if (v) drawDeco(v);
    }
  };

  const setHidden = (ids: string[]): void => {
    const next = new Set(ids);
    for (const id of hidden) if (!next.has(id)) pathOf.get(id)?.style.removeProperty('display');
    for (const id of next) if (!hidden.has(id)) pathOf.get(id)?.style.setProperty('display', 'none');
    hidden = next;
  };

  const setBadge = (count: number, onOpen?: () => void): void => {
    badgeOpen = onOpen;
    badge.hidden = count <= 0;
    badge.textContent = String(count);
    const label = count === 1 ? '1 note is not on the page' : `${count} notes are not on the page`;
    badge.setAttribute('aria-label', label);
    badge.title = label;
  };

  const setHandle = (onOpen: (() => void) | null): void => {
    handle?.remove();
    handle = null;
    if (!onOpen) return;
    const b = doc.createElement('button');
    b.type = 'button';
    // The same spot as the bar's own handle: bottom centre for touch, right edge for a mouse.
    b.className = win.matchMedia?.('(pointer: coarse)').matches ? 'hdl' : 'hdl v';
    b.setAttribute('aria-label', 'Draw on this page');
    b.title = 'Draw on this page';
    b.append(doc.createElement('i'));
    b.addEventListener('click', () => onOpen());
    ui.append(b);
    handle = b;
  };

  const setMarkers = (items: Marker[], onOpen?: (id: string, byKey: boolean) => void): void => {
    markOpen = onOpen;
    if (!items.length) {
      marks.replaceChildren();
      marks.hidden = true;
      return;
    }
    // Markers follow a placement pass, after its writes. The page size and scroll come from the
    // pass's own measure, so drawing them reads no layout.
    if (!measured) measure();
    const { h, w } = page;
    const x = Math.max(0, w - MARK_W - 2) - hostOff.x + scroll.x;
    const old = new Map<string, HTMLButtonElement>();
    for (const b of marks.querySelectorAll<HTMLButtonElement>('button.mk')) old.set(b.dataset.note ?? '', b);
    const next: HTMLButtonElement[] = [];
    for (const it of items) {
      let b = old.get(it.id);
      if (!b) {
        b = doc.createElement('button');
        b.type = 'button';
        b.className = 'mk';
        b.dataset.note = it.id;
        b.append(doc.createElement('i'));
      }
      if (b.title !== it.label) {
        b.title = it.label;
        b.setAttribute('aria-label', it.label);
      }
      // Kept inside the page, so a marker never makes the page taller.
      const y = Math.min(Math.max(0, it.relY * h - MARK_H / 2), Math.max(0, h - MARK_H));
      b.style.setProperty('left', `${n1(x)}px`);
      b.style.setProperty('top', `${n1(y - hostOff.y)}px`);
      next.push(b);
    }
    marks.replaceChildren(...next);
    marks.hidden = false;
  };

  const toSVG = (area: Rect): string => {
    const hi: string[] = [];
    const pen: string[] = [];
    const esc = (s: string): string => s.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const now = { x: win.scrollX, y: win.scrollY };
    for (const v of views.values()) {
      const box = viewBox(v);
      if (!box || v.marker) continue;
      const off = shiftOf(v.c, now);
      const doc0 = { x: box.x + off.x, y: box.y + off.y, w: box.w, h: box.h };
      if (!intersects(doc0, area)) continue;
      if (v.kind === 'mark') {
        const style = v.note.mark?.style ?? 'highlight';
        const tool: StrokeTool = style === 'highlight' ? 'hi' : 'pen';
        const color = realColor(current, v.note.mark?.color ?? (tool === 'hi' ? 'hi-1' : 'ink-1'), tool);
        const rects = (v.rects ?? []).map((r) => ({ x: r.x + off.x, y: r.y + off.y, w: r.w, h: r.h }));
        const out = `<path fill="${esc(color)}" d="${markPath(style, rects, seedOf(v.note.id))}"/>`;
        (tool === 'hi' ? hi : pen).push(out);
        continue;
      }
      const tf = transformOf({ x: v.at.x + off.x, y: v.at.y + off.y }, v.scale);
      const h: string[] = [];
      const p: string[] = [];
      for (const s of v.note.strokes) {
        if (hidden.has(s.id)) continue;
        const path = `<path fill="${esc(realColor(current, s.color, s.tool))}" d="${esc(s.d)}"/>`;
        (s.tool === 'hi' ? h : p).push(path);
      }
      if (h.length) hi.push(`<g transform="${tf}">${h.join('')}</g>`);
      if (p.length) pen.push(`<g transform="${tf}">${p.join('')}</g>`);
    }
    const blend = current === 'dark' ? 'screen' : 'multiply';
    return (
      `<svg xmlns="${SVG_NS}" width="${n1(area.w)}" height="${n1(area.h)}" ` +
      `viewBox="${n1(area.x)} ${n1(area.y)} ${n1(area.w)} ${n1(area.h)}">` +
      `<g style="mix-blend-mode:${blend}">${hi.join('')}</g><g>${pen.join('')}</g></svg>`
    );
  };

  const layer: InkLayer = {
    host,
    root,
    ui,
    theme: () => current,
    setTheme(t) {
      mode = t;
      themeLate = false;
      applyTheme(t === 'auto' ? detectTheme(doc) : t);
    },
    cssColor: (c: InkColor, tool: StrokeTool) => realColor(current, c, tool),
    drawNote,
    drawMark,
    removeNote,
    clear,
    setSelected,
    setHidden,
    setBadge,
    setHandle,
    setMarkers,
    toSVG,
    syncTop,
    destroy() {
      dropTop();
      handle?.remove();
      marks.removeEventListener('click', onMark);
      closePop();
      for (const t of DK_EVENTS) docks.removeEventListener(t, onDk);
      pop.removeEventListener('pointerenter', holdPop);
      pop.removeEventListener('pointerleave', hideSoon);
      mq?.removeEventListener?.('change', onScheme);
      badge.removeEventListener('click', onBadge);
      clear();
      for (const sv of scrollers.values()) {
        sv.hiSvg.remove();
        sv.penSvg.remove();
      }
      scrollers.clear();
      host.remove();
    },
    measure,
    flush,
    clipNote(id, clip) {
      const v = views.get(id);
      if (!v) return;
      v.clip = clip ?? undefined;
      applyClip(v);
    },
    readTheme() {
      themeLate = false;
      if (mode !== 'auto') return;
      const t = detectTheme(doc);
      if (t !== current) pendingTheme = t;
    },
    setScroller(el, box, sc, pinned = false, top = false) {
      flush();
      setScroller(el, box, sc, pinned, top && canTop);
    },
    scrollScroller(el, sc) {
      const sv = scrollers.get(el);
      if (!sv) return;
      sv.scroll = { x: sc.x, y: sc.y };
      const t = `translate(${n1(-sc.x)} ${n1(-sc.y)})`;
      sv.hi.setAttribute('transform', t);
      sv.pen.setAttribute('transform', t);
    },
    drawn: () => [...views.keys()],
  };
  return layer;
};

/** Kept apart, so only the code that exports pictures carries it. */
export { svgToPng } from './png';
