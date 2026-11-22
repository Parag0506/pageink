// Test input that works in every engine the browser tests run in.
// In Chromium all input is real, through the Chrome DevTools Protocol, so the browser's own
// default actions (scrolling, text selection, coalescing) happen too. In WebKit and Firefox a
// mouse is real too, through Playwright (the realMouse command in vitest.commands.ts). Pen and
// touch have no such channel there, so their events are built and dispatched by hand at the
// element under the point, in the order Chromium sends them. Tests that need the browser's
// default actions for pen or touch run in Chromium only, with NEEDS_CDP as the reason.
import { cdp, commands, server } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    realMouse(type: MouseType, x: number, y: number, modifiers: number): Promise<void>;
    reducedMotion(on: boolean): Promise<void>;
    touches(steps: { type: TouchType; touchPoints: TouchPoint[]; timestamp: number }[]): Promise<void>;
  }
}

export type Engine = 'chromium' | 'webkit' | 'firefox';
export const engine = server.browser as Engine;
export const isChromium = engine === 'chromium';

/** Why a test runs in Chromium only. Synthetic events carry no default actions. */
export const NEEDS_CDP = 'needs trusted input through CDP: native scrolling, selection or coalescing';

type Session = { send(method: string, params?: Record<string, unknown>): Promise<unknown> };
export const session = (): Session => cdp() as unknown as Session;

export type Kind = 'pen' | 'mouse';
export type MouseType = 'mousePressed' | 'mouseMoved' | 'mouseReleased';
export const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

// ---- the input clock -------------------------------------------------------------
//
// Capture reads the timing of a gesture from the times of its events: a pen that lifts within
// TAP_MS without moving is a tap, a second finger within TWO_FINGER_MS makes two fingers, strokes
// within 1.5 s of each other are one note. Left alone, an event's time is the moment the browser
// got it, so on a busy machine the gaps between events grow and a test sees another gesture.
// So every event made here carries a time of its own:
// - with no `gap` it is the real time, as before;
// - with a `gap` it is that many ms after the last event made here, or the real time if that
//   is sooner. The helpers that make one gesture (a stroke, a tap) pass STEP_MS for every event
//   after the first;
// - no event is ever stamped ahead of the real clock, so real input that comes later (the
//   mouse through Playwright) still comes after it.
// A pause between gestures is a real wait: the real clock only makes it longer.

/** The gap between two events of one gesture on the input clock, in ms. */
export const STEP_MS = 4;
/** How long fingers rest before they lift. Chromium takes a finger still for 80 ms as stopped. */
export const REST_MS = 120;
let lastInput = 0;

/** The time of the next event, in ms since 1970: `gap` ms after the last one, or now if that is sooner. */
export function stamp(gap = Number.POSITIVE_INFINITY): number {
  const now = Date.now();
  lastInput = lastInput ? Math.min(now, lastInput + gap) : now;
  return lastInput;
}

/** The time synthetic events get while one input event is being dispatched. */
let eventTime: number | undefined;

/** Run a synthetic dispatch with its events stamped `at`, in ms since 1970. */
function stamped(at: number, dispatch: () => void): void {
  eventTime = at;
  try {
    dispatch();
  } finally {
    eventTime = undefined;
  }
}

/** Events this file built and dispatched. */
const made = new WeakSet<Event>();

/** Dispatch an event built here and remember it, so `fromTest` accepts it. */
function send<E extends Event>(el: EventTarget, e: E): E {
  made.add(e);
  // The same clock as trusted events: ms since the page's time origin.
  if (eventTime !== undefined)
    Object.defineProperty(e, 'timeStamp', { value: eventTime - performance.timeOrigin });
  el.dispatchEvent(e);
  return e;
}

/**
 * The `real` test seam for hosts: input the browser made, and input this file made in place
 * of a pen or touch the engine cannot drive. Events a test builds itself, the way a page
 * script would, still do not count.
 */
export const fromTest = (e: Event): boolean => e.isTrusted || made.has(e);

/** One macrotask, like the round trip of a CDP call, so frames and timers can run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The element a real pointer would hit, inside open shadow roots too, as the browser does. */
function targetAt(x: number, y: number): Element {
  let el = document.elementFromPoint(x, y) ?? document.documentElement;
  for (let inner = el.shadowRoot?.elementFromPoint(x, y); inner && inner !== el; ) {
    el = inner;
    inner = el.shadowRoot?.elementFromPoint(x, y);
  }
  return el;
}

function common(a: Element, b: Element): Element {
  for (let n: Element | null = a; n; n = n.parentElement) if (n.contains(b)) return n;
  return document.documentElement;
}

interface Press {
  target: Element;
  prevented: boolean;
}
const pressed = new Map<Kind, Press>();
const hovered = new Map<Kind | 'touch', Element>();
const POINTER_ID: Record<Kind, number> = { mouse: 1, pen: 2 };

function mods(m: number) {
  return { altKey: !!(m & ALT), ctrlKey: !!(m & CTRL), metaKey: !!(m & META), shiftKey: !!(m & SHIFT) };
}

function over(kind: Kind | 'touch', el: Element, init: PointerEventInit): void {
  if (hovered.get(kind) === el) return;
  hovered.set(kind, el);
  send(el, new PointerEvent('pointerover', { ...init, bubbles: true, cancelable: true, composed: true }));
}

function fire(el: Element, type: string, init: PointerEventInit): PointerEvent {
  return send(el, new PointerEvent(type, { ...init, bubbles: true, cancelable: true, composed: true }));
}

function fireMouse(el: Element, type: string, init: MouseEventInit): void {
  send(el, new MouseEvent(type, { ...init, bubbles: true, cancelable: true, composed: true }));
}

/** Synthetic pointer input in the order Chromium sends it for one CDP mouse event. */
export function synthMouse(
  type: MouseType,
  x: number,
  y: number,
  kind: Kind,
  o: { down?: boolean; force?: number; modifiers?: number; button?: number; buttons?: number },
): void {
  const el = targetAt(x, y);
  const held = type === 'mousePressed' || (type === 'mouseMoved' && !!o.down);
  const base: PointerEventInit = {
    pointerType: kind,
    pointerId: POINTER_ID[kind],
    isPrimary: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pressure: held ? (o.force ?? 0.5) : 0,
    button: type === 'mouseMoved' ? -1 : (o.button ?? 0),
    buttons: held ? (o.buttons ?? 1) : 0,
    detail: type === 'mouseMoved' ? 0 : 1,
    view: window,
    ...mods(o.modifiers ?? 0),
  };
  over(kind, el, base);
  const mouse: MouseEventInit = { ...base, button: base.button === -1 ? 0 : base.button };
  if (type === 'mousePressed') {
    const down = fire(el, 'pointerdown', base);
    pressed.set(kind, { target: el, prevented: down.defaultPrevented });
    if (!down.defaultPrevented) fireMouse(el, 'mousedown', mouse);
  } else if (type === 'mouseMoved') {
    fire(el, 'pointermove', base);
    if (!pressed.get(kind)?.prevented) fireMouse(el, 'mousemove', mouse);
  } else {
    const p = pressed.get(kind);
    pressed.delete(kind);
    fire(el, 'pointerup', base);
    if (!p?.prevented) fireMouse(el, 'mouseup', mouse);
    // The click goes to the nearest element that holds both the press and the release.
    fireMouse(p ? common(p.target, el) : el, 'click', mouse);
  }
}

/**
 * A whole pen stroke dispatched in one task, so every move and the lift land in the same
 * frame, as a fast flick can. Synthetic in every engine.
 */
export function penBurst(pts: [number, number][]): void {
  const [x0, y0] = pts[0]!;
  stamped(stamp(), () => synthMouse('mouseMoved', x0, y0, 'pen', {}));
  stamped(stamp(STEP_MS), () => synthMouse('mousePressed', x0, y0, 'pen', { force: 0.5 }));
  for (const [x, y] of pts.slice(1))
    stamped(stamp(STEP_MS), () => synthMouse('mouseMoved', x, y, 'pen', { down: true, force: 0.6 }));
  const [x1, y1] = pts[pts.length - 1]!;
  stamped(stamp(STEP_MS), () => synthMouse('mouseReleased', x1, y1, 'pen', {}));
}

/**
 * One mouse or pen event at a client point: real in Chromium, synthetic elsewhere. `gap` puts
 * it that many ms after the last event on the input clock (see above). Without it the event
 * has the real time. A mouse outside Chromium goes through Playwright and always has the real time.
 */
export async function mouseInput(
  type: MouseType,
  x: number,
  y: number,
  kind: Kind,
  o: { down?: boolean; force?: number; modifiers?: number; gap?: number } = {},
): Promise<void> {
  if (!isChromium && kind === 'mouse') {
    await commands.realMouse(type, x, y, o.modifiers ?? 0);
    stamp();
    return;
  }
  const at = stamp(o.gap);
  if (!isChromium) {
    stamped(at, () => synthMouse(type, x, y, kind, o));
    await tick();
    return;
  }
  const p: Record<string, unknown> = {
    type,
    x,
    y,
    pointerType: kind,
    modifiers: o.modifiers ?? 0,
    timestamp: at / 1000,
  };
  if (type !== 'mouseMoved') {
    p.button = 'left';
    p.clickCount = 1;
  } else if (o.down) {
    p.button = 'left';
    p.buttons = 1;
  }
  if (o.force !== undefined) p.force = o.force;
  await session().send('Input.dispatchMouseEvent', p);
}

export type TouchPoint = { x: number; y: number; id: number };
export type TouchType = 'touchStart' | 'touchMove' | 'touchEnd';
const fingers = new Map<number, { target: Element; x: number; y: number }>();

function touchEvent(type: string, el: Element, changed: TouchPoint[]): void {
  // WebKit on the Mac and Firefox without touch have no Touch constructor.
  if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return;
  try {
    const mk = (p: TouchPoint) =>
      new Touch({ identifier: p.id, target: fingers.get(p.id)?.target ?? el, clientX: p.x, clientY: p.y });
    const all = [...fingers.entries()].map(([id, f]) => mk({ id, x: f.x, y: f.y }));
    send(
      el,
      new TouchEvent(type, {
        touches: all,
        targetTouches: all,
        changedTouches: changed.map(mk),
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  } catch {
    // No touch events in this engine. Pointer events carry the gesture.
  }
}

function touchInit(p: TouchPoint, held: boolean): PointerEventInit {
  return {
    pointerType: 'touch',
    pointerId: 100 + p.id,
    isPrimary: p.id === [...fingers.keys()][0],
    clientX: p.x,
    clientY: p.y,
    pressure: held ? 0.5 : 0,
    button: 0,
    buttons: held ? 1 : 0,
    width: 10,
    height: 10,
    view: window,
  };
}

/** Synthetic touch input with CDP's meaning: the points listed are the fingers on the screen. */
function synthTouch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: TouchPoint[]): void {
  if (type === 'touchStart') {
    for (const p of points) {
      if (fingers.has(p.id)) continue;
      const el = targetAt(p.x, p.y);
      fingers.set(p.id, { target: el, x: p.x, y: p.y });
      const init = touchInit(p, true);
      over('touch', el, init);
      fire(el, 'pointerdown', init);
      touchEvent('touchstart', el, [p]);
    }
  } else if (type === 'touchMove') {
    const moved: TouchPoint[] = [];
    for (const p of points) {
      const f = fingers.get(p.id);
      if (!f || (f.x === p.x && f.y === p.y)) continue;
      f.x = p.x;
      f.y = p.y;
      moved.push(p);
      fire(f.target, 'pointermove', { ...touchInit(p, true), button: -1 });
    }
    const first = moved[0];
    if (first) touchEvent('touchmove', fingers.get(first.id)!.target, moved);
  } else {
    const keep = new Set(points.map((p) => p.id));
    for (const [id, f] of [...fingers]) {
      if (keep.has(id)) continue;
      const p = { id, x: f.x, y: f.y };
      fire(f.target, 'pointerup', touchInit(p, false));
      fingers.delete(id);
      touchEvent('touchend', f.target, [p]);
    }
    hovered.delete('touch');
  }
}

/**
 * One touch event, CDP style: real in Chromium, synthetic pointer and touch events elsewhere.
 * `gap` is as for mouseInput. A gesture the browser itself must read (a scroll, two fingers)
 * goes through touchGesture, which the load of the machine cannot stretch.
 */
export async function touchInput(type: TouchType, touchPoints: TouchPoint[], gap?: number): Promise<void> {
  const at = stamp(gap);
  if (!isChromium) {
    stamped(at, () => synthTouch(type, touchPoints));
    await tick();
    return;
  }
  await session().send('Input.dispatchTouchEvent', { type, touchPoints, timestamp: at / 1000 });
}

/** One step of a touch gesture: the fingers on the screen, `gap` ms after the step before (STEP_MS when left out). */
export interface TouchStep {
  type: TouchType;
  points: TouchPoint[];
  gap?: number;
}

/**
 * A whole touch gesture in one piece. The browser reads a gesture from real time too: a finger
 * that lands and waits is a long press, and the speed of the last moves decides how far the
 * page coasts. Sent event by event, each with a round trip, a busy machine turns a swipe into a
 * long press that scrolls nothing. Here Chromium gets every event at once, each with its time
 * on the input clock, the last one now. Other engines get the synthetic events touchInput
 * makes, with the same times.
 */
export async function touchGesture(steps: TouchStep[]): Promise<void> {
  const gaps = steps.map((s, i) => (i ? (s.gap ?? STEP_MS) : 0));
  const total = gaps.reduce((a, b) => a + b, 0);
  // The gesture ends now, so it starts in the past. It still starts after the last event made.
  const short = lastInput + 1 - (Date.now() - total);
  if (short > 0) await new Promise((r) => setTimeout(r, short));
  let at = Date.now() - total;
  const timed = steps.map((s, i) => {
    at += gaps[i]!;
    return { type: s.type, touchPoints: s.points, at };
  });
  lastInput = at;
  if (!isChromium) {
    for (const s of timed) {
      stamped(s.at, () => synthTouch(s.type, s.touchPoints));
      await tick();
    }
    return;
  }
  await commands.touches(
    timed.map((s) => ({ type: s.type, touchPoints: s.touchPoints, timestamp: s.at / 1000 })),
  );
}

/**
 * Fingers moving together along paths of the same length, as one gesture: moves 16 ms apart,
 * then a rest before the lift, so the page does not coast after it. Finger ids count from 1.
 */
export function swipeAlong(paths: [number, number][][]): Promise<void> {
  const at = (i: number): TouchPoint[] => paths.map((p, f) => ({ x: p[i]![0], y: p[i]![1], id: f + 1 }));
  const steps: TouchStep[] = [{ type: 'touchStart', points: at(0) }];
  for (let i = 1; i < paths[0]!.length; i++) steps.push({ type: 'touchMove', points: at(i), gap: 16 });
  steps.push({ type: 'touchEnd', points: [], gap: REST_MS });
  return touchGesture(steps);
}

export interface FakeTouch {
  identifier: number;
  target: EventTarget;
  clientX: number;
  clientY: number;
  /** iPad Safari: 'stylus' for the Pencil, 'direct' for a finger. */
  touchType: 'stylus' | 'direct';
  force?: number;
}

/**
 * A cancelable touch event carrying the given touches, as iPad Safari would deliver it.
 * Uses TouchEvent where the engine can build one. WebKit on the Mac and Firefox cannot,
 * so there it is a plain Event with the touch lists set on it, which is all capture reads.
 */
export function touchEventOf(type: string, changed: FakeTouch[], all: FakeTouch[] = changed): Event {
  const lists = { changedTouches: changed, touches: all, targetTouches: all };
  let e: Event | null = null;
  if (typeof Touch === 'function' && typeof TouchEvent === 'function') {
    try {
      const mk = (t: FakeTouch) => {
        const real = new Touch({
          identifier: t.identifier,
          target: t.target,
          clientX: t.clientX,
          clientY: t.clientY,
          force: t.force ?? 0,
        });
        // Only Safari has touchType, so it is added by hand.
        Object.defineProperty(real, 'touchType', { value: t.touchType });
        return real;
      };
      e = new TouchEvent(type, {
        changedTouches: changed.map(mk),
        touches: all.map(mk),
        targetTouches: all.map(mk),
        bubbles: true,
        cancelable: true,
        composed: true,
      });
    } catch {
      e = null;
    }
  }
  if (!e) {
    e = new Event(type, { bubbles: true, cancelable: true, composed: true });
    for (const [k, v] of Object.entries(lists)) Object.defineProperty(e, k, { value: v });
  }
  made.add(e);
  return e;
}

/** Touch emulation, so Chromium sends touch events. Other engines get synthetic ones anyway. */
export async function touchEmulation(on: boolean): Promise<void> {
  if (!isChromium) return;
  await session().send(
    'Emulation.setTouchEmulationEnabled',
    on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
  );
}
