import type {
  Capture,
  CaptureHost,
  CreateCapture,
  FrontType,
  Gesture,
  PointerKind,
  Sample,
  Tool,
} from '../types';
import { LiveCanvas, type LiveStyle } from './live';

/** A pen or finger that moves less than this and lifts sooner than TAP_MS is a tap. */
export const TAP_PX = 4;
export const TAP_MS = 300;
/** A second finger this soon after the first means scroll or zoom, not ink. */
export const TWO_FINGER_MS = 300;
/** A swallowed click must come this soon after the stroke ends. */
const SWALLOW_MS = 600;
/** Do not tell the host about a hovering pen more often than this. */
const NEAR_MS = 500;

/** Targets where a tap must reach the page. A stroke that moves still becomes ink. */
const INTERACTIVE =
  'a[href],area[href],button,input,select,textarea,label,summary,details,video[controls],audio[controls],' +
  '[contenteditable]:not([contenteditable="false"]),[onclick],[tabindex]:not([tabindex="-1"]),' +
  '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],' +
  '[role="option"],[role="switch"],[role="slider"],[role="textbox"],[role="combobox"]';

/**
 * Things the page means to be dragged. A drag that starts on one goes to the page, never to ink,
 * whatever the pointer. `[data-ink-off]` lets a page keep any part of itself for its own input.
 */
const PAGE_DRAG =
  'input[type=range],[draggable=true],[role=slider],[role=scrollbar],[role=separator][aria-valuenow],' +
  'video[controls],audio[controls],[data-ink-off]';
/** A drag that starts this close to either end of a selection in editable text moves its handle. */
const HANDLE_PX = 20;

/** While a pen is in range, nothing may pan under it. touch-action is the only lever outside Safari. */
const GUARD_CSS = '*,*::before,*::after{touch-action:none!important}';

interface Live extends Sample {
  /** Client coordinates for the live canvas. */
  cx: number;
  cy: number;
}

interface G {
  id: number;
  kind: PointerKind;
  tool: Tool;
  /** pending: began on a link or control; it is left to the page until it moves. */
  mode: 'pending' | 'ink';
  style: LiveStyle;
  pts: Live[];
  /** The same samples in client coordinates, kept beside pts so a paint maps nothing. */
  cpts: Sample[];
  /** The live stroke has been painted once. */
  painted?: boolean;
  x0: number;
  y0: number;
  t0: number;
  moved: boolean;
  /** Replayed from a buffer: the page saw these events first. */
  replay: boolean;
}

interface Pan {
  id: number;
  x: number;
  y: number;
  el: Element | null;
}

const kindOf = (t: string): PointerKind | null => (t === 'pen' || t === 'touch' || t === 'mouse' ? t : null);

function elementOf(e: Event): Element | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const first = path[0] ?? e.target;
  const n = first as Node | null;
  if (!n || typeof n !== 'object' || !('nodeType' in n)) return null;
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

export const createCapture: CreateCapture = (host: CaptureHost): Capture => {
  const doc = host.doc;
  const win = doc.defaultView as Window & typeof globalThis;
  let live: LiveCanvas | null = null;
  let g: G | null = null;
  let raf = 0;
  /** Touch pointers that are down right now. */
  const fingers = new Set<number>();
  /** A second finger arrived: the fingers scroll and zoom until all lift. */
  let multi = false;
  let swallowUntil = 0;
  let lastNear = Number.NEGATIVE_INFINITY;
  /** Seen a stylus touch event: this is iPad Safari, the touch trick works. */
  let stylusTouch = false;
  let guard: { sheet?: CSSStyleSheet; style?: HTMLStyleElement } | null = null;
  /** The pan guard was up when this finger landed, so the browser will not pan it. */
  let pan: Pan | null = null;
  /** Counts what happens, for a host that asked (createProbe). */
  const pr = host.probe;

  const canvas = (): LiveCanvas => {
    if (!live) live = new LiveCanvas(win, host.mount);
    return live;
  };

  // ---- pan guard -------------------------------------------------------------

  /** Adopt the guard sheet. False when this world cannot: no support, a throw, or a silent no-op. */
  function adopt(): CSSStyleSheet | null {
    try {
      const list = doc.adoptedStyleSheets;
      if (!Array.isArray(list) || typeof win.CSSStyleSheet !== 'function') return null;
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(GUARD_CSS);
      doc.adoptedStyleSheets = [...list, sheet];
      // Some content script worlds accept the write and drop it. Read it back.
      if (!doc.adoptedStyleSheets.includes(sheet)) return null;
      return sheet;
    } catch {
      return null;
    }
  }

  function arm(): void {
    if (guard || stylusTouch) return;
    guard = {};
    const sheet = adopt();
    if (sheet) {
      guard.sheet = sheet;
      return;
    }
    // A style element does the same job where sheets cannot be adopted.
    try {
      const style = doc.createElement('style');
      style.textContent = GUARD_CSS;
      (doc.head ?? doc.documentElement).append(style);
      guard.style = style;
    } catch {
      // No guard at all: the pen still writes, the page may pan under it.
    }
  }

  function disarm(): void {
    if (!guard) return;
    const { sheet, style } = guard;
    guard = null;
    if (sheet) {
      try {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
      } catch {
        // Nothing to undo.
      }
    }
    style?.remove();
  }

  /**
   * The gesture starts on something the host or the page keeps for the page. A hovering pen
   * checks only the cheap part, with no style or layout read.
   */
  function ignored(e: Event, hover = false): boolean {
    const el = elementOf(e);
    if (!el) return false;
    if (host.ignore?.(el)) return true;
    if (hover) return !!el.closest(PAGE_DRAG);
    return pageDrag(el, e as PointerEvent);
  }

  /** The point is on a scrollbar of the element under it, or of the page. */
  function onScrollbar(el: Element, x: number, y: number): boolean {
    const html = doc.documentElement;
    // The page's own bars: the viewport less what its scrolling element shows. In quirks mode
    // that element is the body.
    const vp = doc.compatMode === 'BackCompat' && doc.body ? doc.body : html;
    if (
      (win.innerWidth > vp.clientWidth && x >= vp.clientWidth) ||
      (win.innerHeight > vp.clientHeight && y >= vp.clientHeight)
    )
      return true;
    if (el === html || el === doc.body || !(el instanceof win.HTMLElement)) return false;
    // Only a box that scrolls has bars. Inline boxes report no client size at all.
    const cs = win.getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) return false;
    const r = el.getBoundingClientRect();
    const lx = x - r.left - el.clientLeft;
    const ly = y - r.top - el.clientTop;
    // Bars take the room between the padding box and the borders.
    const barX = el.offsetWidth - el.clientWidth - 2 * el.clientLeft > 0;
    const barY = el.offsetHeight - el.clientHeight - 2 * el.clientTop > 0;
    return (barX && (lx < 0 || lx > el.clientWidth)) || (barY && (ly < 0 || ly > el.clientHeight));
  }

  /** The point is on a selection handle in editable text, or in a field with text selected. */
  function onHandle(el: Element, x: number, y: number): boolean {
    const field = el.closest('input,textarea') as HTMLInputElement | HTMLTextAreaElement | null;
    if (field) {
      try {
        return field.selectionStart !== null && field.selectionStart !== field.selectionEnd;
      } catch {
        return false;
      }
    }
    if (!(el instanceof win.HTMLElement) || !el.isContentEditable) return false;
    const sel = doc.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const rs = sel.getRangeAt(0).getClientRects();
    const a = rs[0];
    const b = rs[rs.length - 1];
    if (!a || !b) return false;
    const close = (px: number, py: number) => Math.hypot(x - px, y - py) <= HANDLE_PX;
    return (
      close(a.left, a.bottom) || close(a.left, a.top) || close(b.right, b.bottom) || close(b.right, b.top)
    );
  }

  function pageDrag(el: Element, e: PointerEvent): boolean {
    if (el.closest(PAGE_DRAG)) return true;
    if (typeof e.clientX !== 'number') return false;
    return onScrollbar(el, e.clientX, e.clientY) || onHandle(el, e.clientX, e.clientY);
  }

  /** A pen writes now: always, or with the toggle on when the host asks for it. */
  const penWrites = (): boolean => !host.penNeedsToggle || host.draw();

  function near(t: number, e: Event): void {
    // Where the pen cannot write, it acts like a finger, so the page may pan under it.
    if (!penWrites() || ignored(e, true)) disarm();
    else arm();
    if (t - lastNear < NEAR_MS) return;
    lastNear = t;
    host.onPenNear?.();
  }

  // ---- helpers ---------------------------------------------------------------

  function block(e: Event, replay: boolean): void {
    if (replay) return;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }

  function isInteractive(el: Element | null): boolean {
    if (!el) return false;
    if (el.closest(INTERACTIVE)) return true;
    // Clickable things often have no role, only a pointer cursor. One style read per pen-down.
    return win.getComputedStyle(el).cursor === 'pointer';
  }

  function modifierHeld(e: PointerEvent): boolean {
    switch (host.modifier) {
      case 'Alt':
        return e.altKey;
      case 'Control':
        return e.ctrlKey;
      case 'Meta':
        return e.metaKey;
      default:
        return false;
    }
  }

  function samplesOf(e: PointerEvent, kind: PointerKind, predicted: boolean, counted = false): Live[] {
    let list: PointerEvent[] = [];
    try {
      list = predicted
        ? typeof e.getPredictedEvents === 'function'
          ? e.getPredictedEvents()
          : []
        : typeof e.getCoalescedEvents === 'function'
          ? e.getCoalescedEvents()
          : [];
    } catch {
      list = [];
    }
    if (!predicted && !list.length) list = [e];
    if (counted) pr?.raw(list);
    const sx = win.scrollX;
    const sy = win.scrollY;
    return list.map((q) => ({
      x: q.clientX + sx,
      y: q.clientY + sy,
      cx: q.clientX,
      cy: q.clientY,
      p: kind === 'pen' && q.pressure > 0 ? q.pressure : 0.5,
      t: q.timeStamp,
    }));
  }

  function add(gs: G, list: Live[]): void {
    for (const s of list) {
      const last = gs.pts[gs.pts.length - 1];
      if (last && last.cx === s.cx && last.cy === s.cy && last.p === s.p) continue;
      gs.pts.push(s);
      gs.cpts.push({ x: s.cx, y: s.cy, p: s.p, t: s.t });
      if (!gs.moved && Math.hypot(s.cx - gs.x0, s.cy - gs.y0) >= TAP_PX) gs.moved = true;
    }
  }

  const NO_PTS: Sample[] = [];
  const clientPts = (pts: Live[]): Sample[] => pts.map((s) => ({ x: s.cx, y: s.cy, p: s.p, t: s.t }));

  function gesture(gs: G): Gesture {
    const samples = gs.pts.map((s) => ({ x: s.x, y: s.y, p: s.p, t: s.t }));
    return {
      tool: gs.tool,
      pointerType: gs.kind,
      samples,
      t0: samples[0]?.t ?? gs.t0,
      t1: samples[samples.length - 1]?.t ?? gs.t0,
    };
  }

  /** True while buffered events are replayed: the stroke is painted once, after them. */
  let replaying = false;

  function paint(gs: G, predicted: Live[]): void {
    if (replaying) return;
    canvas().draw(gs.tool, gs.style, gs.cpts, predicted.length ? clientPts(predicted) : NO_PTS);
    pr?.paint(predicted.length);
    if (gs.painted) return;
    gs.painted = true;
    host.onFirstPaint?.(gs.t0);
  }

  function scheduleMove(): void {
    if (raf || !host.onMove) return;
    raf = win.requestAnimationFrame(() => {
      raf = 0;
      if (g && g.mode === 'ink') host.onMove?.(gesture(g));
    });
  }

  /**
   * A replayed stroke reached the page first, which may have started a text selection at the
   * pen-down point. Clear only that one: a selection anchored anywhere else is the reader's.
   */
  function dropStrokeSelection(gs: G): void {
    const sel = doc.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return;
    const at = (
      doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
    ).caretRangeFromPoint?.(gs.x0, gs.y0);
    let here = false;
    if (at) here = at.startContainer === sel.anchorNode && Math.abs(at.startOffset - sel.anchorOffset) <= 1;
    else {
      const pos = (
        doc as Document & {
          caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
        }
      ).caretPositionFromPoint?.(gs.x0, gs.y0);
      here = !!pos && pos.offsetNode === sel.anchorNode && Math.abs(pos.offset - sel.anchorOffset) <= 1;
    }
    if (here) sel.removeAllRanges();
  }

  /** The gesture becomes ink: tell the host and start painting. */
  function begin(gs: G): void {
    gs.mode = 'ink';
    if (gs.replay) dropStrokeSelection(gs);
    const first = gs.pts[0];
    host.onStart?.({ tool: gs.tool, pointerType: gs.kind, at: { x: first?.x ?? 0, y: first?.y ?? 0 } });
    canvas().fit();
    paint(gs, []);
  }

  function cancel(): void {
    const gs = g;
    g = null;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    if (!gs) return;
    if (gs.mode === 'ink') {
      live?.clear();
      host.onCancel?.();
    }
    pr?.end('cancel', win.performance.now(), gs.pts);
  }

  // ---- pointer events ----------------------------------------------------------

  function down(e: PointerEvent, replay = false): void {
    const kind = kindOf(e.pointerType);
    if (!kind) return;
    if (kind === 'touch') fingers.add(e.pointerId);
    if (kind === 'pen') near(e.timeStamp, e);
    else if (g?.kind !== 'pen') {
      // A finger or a mouse means the pen is gone. A finger that lands while the
      // guard is up will not pan natively, so it is panned by script.
      if (guard && kind === 'touch' && !host.draw() && fingers.size === 1) {
        pan = { id: e.pointerId, x: e.clientX, y: e.clientY, el: elementOf(e) };
      }
      disarm();
    }

    if (g) {
      if (g.kind === 'pen' && kind === 'touch') {
        // Palm on the screen while writing.
        block(e, replay);
        pr?.palm(!replay);
        return;
      }
      if (g.kind === 'touch' && kind === 'touch' && e.pointerId !== g.id) {
        if (e.timeStamp - g.t0 < TWO_FINGER_MS) {
          multi = true;
          cancel();
        }
        return;
      }
      return;
    }
    if (kind === 'touch' && (multi || fingers.size > 1)) {
      if (fingers.size > 1) pan = null;
      return;
    }
    // A pen-down that starts nothing, for the probe.
    const skip = (why: 'off' | 'ui' | 'ignored' | 'needs-toggle' | 'button') => {
      if (kind === 'pen') pr?.skip(host.tool(), e.timeStamp, why, host.draw());
    };
    if (!host.enabled()) {
      skip('off');
      return;
    }
    if (host.isUi(e.target)) {
      skip('ui');
      return;
    }
    if (ignored(e)) {
      skip('ignored');
      return;
    }

    let tool = host.tool();
    if (kind === 'pen') {
      if (!penWrites()) {
        skip('needs-toggle');
        return;
      }
      // Button 5 is the eraser end of a pen.
      if (e.button === 5 || e.buttons & 32) tool = 'eraser';
      else if (e.button !== 0) {
        skip('button');
        return;
      }
    } else if (kind === 'touch') {
      if (!host.draw()) return;
    } else {
      if (e.button !== 0) return;
      if (!host.draw() && !modifierHeld(e)) return;
    }

    const el = elementOf(e);
    const gs: G = {
      id: e.pointerId,
      kind,
      tool,
      mode: 'pending',
      style: host.liveStyle(),
      pts: [],
      cpts: [],
      x0: e.clientX,
      y0: e.clientY,
      t0: e.timeStamp,
      moved: false,
      replay,
    };
    g = gs;
    swallowUntil = 0;
    pr?.start(kind, tool, e.timeStamp, replay, host.draw());
    add(gs, samplesOf(e, kind, false, true));
    if (isInteractive(el)) return;
    block(e, replay);
    begin(gs);
  }

  function move(e: PointerEvent, replay = false): void {
    const kind = kindOf(e.pointerType);
    if (kind === 'pen' && !g && e.buttons === 0) near(e.timeStamp, e);
    else if (kind === 'mouse' && guard && g?.kind !== 'pen') disarm();

    if (pan && e.pointerId === pan.id) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      pan.x = e.clientX;
      pan.y = e.clientY;
      scrollFrom(pan.el, -dx, -dy);
      return;
    }

    const gs = g;
    if (!gs || e.pointerId !== gs.id) {
      if (gs?.kind === 'pen' && kind === 'touch') block(e, replay);
      return;
    }
    const list = samplesOf(e, gs.kind, false, true);
    pr?.move(list.length);
    if (gs.mode === 'pending') {
      add(gs, list);
      if (!gs.moved) return;
      begin(gs);
      block(e, replay);
      return;
    }
    block(e, replay);
    add(gs, list);
    paint(gs, samplesOf(e, gs.kind, true));
    scheduleMove();
  }

  function up(e: PointerEvent, replay = false): void {
    const kind = kindOf(e.pointerType);
    if (kind === 'touch') {
      fingers.delete(e.pointerId);
      if (!fingers.size) multi = false;
    }
    if (pan && e.pointerId === pan.id) pan = null;
    const gs = g;
    if (!gs || e.pointerId !== gs.id) {
      if (gs?.kind === 'pen' && kind === 'touch') block(e, replay);
      return;
    }
    g = null;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    if (gs.mode === 'pending') {
      pr?.end('tap', e.timeStamp, gs.pts);
      return;
    }
    block(e, replay);
    // The page may have kept extending its selection until the replay ended.
    if (gs.replay) dropStrokeSelection(gs);
    // The lift point counts only if it moved. Its pressure is 0, so keep the last one.
    const lift = samplesOf(e, gs.kind, false).pop();
    const last = gs.pts[gs.pts.length - 1];
    if (lift && last && (lift.cx !== last.cx || lift.cy !== last.cy)) add(gs, [{ ...lift, p: last.p }]);
    const isTap = !gs.moved && e.timeStamp - gs.t0 < TAP_MS;
    // A stroke that moved must not click whatever it ended on. A tap still clicks.
    if (!isTap) swallowUntil = e.timeStamp + SWALLOW_MS;
    canvas().finish(gs.tool, gs.style, gs.cpts);
    if (gs.tool === 'eraser') live?.clear();
    host.onEnd(gesture(gs));
    pr?.end('ink', e.timeStamp, gs.pts);
  }

  function cancelled(e: PointerEvent): void {
    const kind = kindOf(e.pointerType);
    if (kind === 'touch') {
      fingers.delete(e.pointerId);
      if (!fingers.size) multi = false;
    }
    if (pan && e.pointerId === pan.id) pan = null;
    if (g && e.pointerId === g.id) cancel();
  }

  function over(e: PointerEvent): void {
    if (e.pointerType === 'pen' && e.buttons === 0) near(e.timeStamp, e);
  }

  // ---- touch events --------------------------------------------------------------

  function touchStart(e: TouchEvent): void {
    let stylus = false;
    for (const t of Array.from(e.changedTouches)) {
      if ((t as Touch & { touchType?: string }).touchType === 'stylus') stylus = true;
    }
    if (stylus) {
      stylusTouch = true;
      disarm();
      if (host.enabled() && !host.isUi(e.target) && penWrites() && !ignored(e)) {
        // Stops Safari panning and Scribble under the pen. Links and controls keep their tap.
        if ((g?.kind === 'pen' && g.mode === 'ink') || !isInteractive(elementOf(e))) {
          if (e.cancelable) e.preventDefault();
        }
      }
      pr?.touch(e.defaultPrevented);
      return;
    }
    // Palm while the pen is down.
    if (g?.kind === 'pen' && e.cancelable) e.preventDefault();
  }

  function touchMove(e: TouchEvent): void {
    // Pen down (pending or ink): no panning, by the pen or by a palm.
    // One finger drawing: no panning. Two fingers cancel the stroke and pan natively.
    if (g && e.cancelable && (g.kind === 'pen' || (g.kind === 'touch' && !multi))) e.preventDefault();
    if (
      pr &&
      Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus')
    )
      pr.touch(e.defaultPrevented);
  }

  // ---- guards against the page seeing the gesture -------------------------------

  function guardEvent(e: Event): void {
    if (!g) return;
    if (g.mode === 'ink' || e.type === 'selectstart' || e.type === 'dragstart') {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function mouseAfter(e: MouseEvent): void {
    if (g?.mode === 'ink') {
      guardEvent(e);
      return;
    }
    if (swallowUntil && e.timeStamp <= swallowUntil) {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') swallowUntil = 0;
    }
  }

  function scrollFrom(el: Element | null, dx: number, dy: number): void {
    let n: Element | null = el;
    while (n && n !== doc.documentElement && n !== doc.body) {
      const cs = win.getComputedStyle(n);
      const canY = /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight;
      const canX = /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth;
      if ((dy && canY) || (dx && canX)) {
        n.scrollBy(dx, dy);
        return;
      }
      n = n.parentElement;
    }
    win.scrollBy(dx, dy);
  }

  // ---- wiring ----------------------------------------------------------------------

  const cap = { capture: true } as const;
  const active = { capture: true, passive: false } as const;
  const onDown = (e: Event) => down(e as PointerEvent);
  const onMove = (e: Event) => move(e as PointerEvent);
  const onUp = (e: Event) => up(e as PointerEvent);
  const onCancel = (e: Event) => cancelled(e as PointerEvent);
  const onOver = (e: Event) => over(e as PointerEvent);
  const onTouchStart = (e: Event) => touchStart(e as TouchEvent);
  const onTouchMove = (e: Event) => touchMove(e as TouchEvent);
  const onMouse = (e: Event) => mouseAfter(e as MouseEvent);

  // Each event is handled once, whether the host's early listener or ours sees it first.
  // Only input the browser made counts: a page script can make events, never trusted ones.
  const real = host.real ?? ((e: Event) => e.isTrusted);
  const seen = new WeakSet<Event>();
  const once =
    (fn: (e: Event) => void) =>
    (e: Event): void => {
      if (seen.has(e) || !real(e)) return;
      seen.add(e);
      fn(e);
    };

  const listeners: [string, (e: Event) => void, AddEventListenerOptions][] = [
    ['pointerdown', onDown, cap],
    ['pointermove', onMove, cap],
    ['pointerup', onUp, cap],
    ['pointercancel', onCancel, cap],
    ['pointerover', onOver, cap],
    ['touchstart', onTouchStart, active],
    ['touchmove', onTouchMove, active],
    ['mousedown', onMouse, cap],
    ['mousemove', onMouse, cap],
    ['mouseup', onMouse, cap],
    ['click', onMouse, cap],
    ['auxclick', onMouse, cap],
    ['dblclick', onMouse, cap],
    ['contextmenu', guardEvent, cap],
    ['selectstart', guardEvent, cap],
    ['dragstart', guardEvent, cap],
  ];
  for (const l of listeners) l[1] = once(l[1]);
  for (const [type, fn, opts] of listeners) win.addEventListener(type, fn, opts);
  // Pages that stop events at the window block the listeners above. The front sees them first.
  const FRONT: FrontType[] = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'];
  const offFront = host.front
    ? FRONT.map((t) => host.front!.on(t, listeners.find((l) => l[0] === t)![1]))
    : [];

  /** Buffered events, seen before the tools were in, go through the same handlers. */
  function replay(events: Event[]): void {
    for (const e of events as PointerEvent[]) {
      if (!real(e)) continue;
      switch (e.type) {
        case 'pointerdown':
          down(e, true);
          break;
        // pointerrawupdate is skipped: in a same-process frame Chrome gives it the top
        // page's coordinates, and pointermove carries the same samples as coalesced events.
        case 'pointermove':
          move(e, true);
          break;
        case 'pointerup':
          up(e, true);
          break;
        case 'pointercancel':
          cancelled(e);
          break;
        case 'pointerover':
          over(e);
          break;
      }
    }
  }

  return {
    adopt(events) {
      // Each event would repaint the whole stroke so far. One paint after the replay shows the same.
      replaying = true;
      try {
        replay(events);
      } finally {
        replaying = false;
      }
      if (g && g.mode === 'ink') paint(g, []);
    },
    clearLive() {
      live?.clear();
      // A stroke in progress stays visible.
      if (g && g.mode === 'ink') paint(g, []);
    },
    destroy() {
      for (const [type, fn, opts] of listeners) win.removeEventListener(type, fn, opts);
      for (const f of offFront) f();
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      g = null;
      pan = null;
      fingers.clear();
      disarm();
      live?.remove();
      live = null;
    },
  };
};
