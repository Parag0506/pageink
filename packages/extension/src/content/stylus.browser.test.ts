/**
 * The Apple Pencil path through the real stub and the real capture, with synthetic events
 * built the way iPad Safari delivers them. It runs in WebKit as well as Chromium.
 *
 * What the events are based on:
 * - WebKit builds the pointer events of a touch from the same platform touch event, one per
 *   touch point: pointerType is "pen" when the touch type is stylus and "touch" otherwise, and
 *   pressure is the touch force (Source/WebCore/dom/ios/PointerEventIOS.cpp).
 * - On WebKit's open touch path, EventHandler::handleTouchEvent dispatches the pointer event
 *   of each changed touch first and the TouchEvent after it (Source/WebCore/page/EventHandler.cpp).
 *   The iOS dispatcher itself is not public, so this order is the one these tests use:
 *   pointerover, pointerdown, touchstart; then pointermove, touchmove; then pointerup, touchend.
 * - A tap sends pointerover, pointerenter, pointerdown, pointerup, pointerout, pointerleave,
 *   then click (LayoutTests/pointerevents/ios/pointer-event-order.html), and a Pencil reports
 *   pointerType "pen" with its pressure (LayoutTests/pointerevents/ios/pointer-events-dispatch-on-stylus.html).
 * - Touch.touchType is "stylus" for the Pencil and "direct" for a finger. Only Safari has it,
 *   and desktop engines cannot build Touch objects, so the touch events here are plain events
 *   with the touch lists set on them. The stub and capture read nothing else.
 */
import { memoryKV } from 'pageink-core/store';
import { attachTools, resetToolSession } from 'pageink-core/tools';
import type { Note, Viewer, ViewerInternals } from 'pageink-core/types';
import { createViewer } from 'pageink-core/view';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { quiet, until } from '../../../core/src/testkit';
import type { Api } from '../api';
import type { Load, LoaderModule } from './modules';
import { startStub } from './stub';

type TouchType = 'stylus' | 'direct';
interface Point {
  x: number;
  y: number;
}

/**
 * Only input the browser made counts in the stub and the viewer. These events stand in for an
 * iPad's own, so the test seam lets them through, and nothing else a script makes.
 */
const made = new WeakSet<Event>();
const real = (e: Event): boolean => e.isTrusted || made.has(e);

const IDS: Record<TouchType, number> = { stylus: 2, direct: 7 };
/** Touches on the screen now, by identifier. */
const down = new Map<number, { target: Element; touchType: TouchType; x: number; y: number }>();

function touchList(ids: number[]) {
  return ids.map((id) => {
    const t = down.get(id)!;
    return {
      identifier: id,
      target: t.target,
      clientX: t.x,
      clientY: t.y,
      touchType: t.touchType,
      force: 0.5,
    };
  });
}

/** One touch event as iPad Safari sends it. Returns whether it was cancelled. */
function touchEvent(type: string, target: Element, changed: number[]): boolean {
  const e = new Event(type, { bubbles: true, cancelable: true, composed: true });
  const all = touchList([...down.keys()]);
  Object.defineProperty(e, 'changedTouches', { value: touchList(changed) });
  Object.defineProperty(e, 'touches', { value: all });
  Object.defineProperty(e, 'targetTouches', { value: all });
  made.add(e);
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

function pointerEvent(
  type: string,
  target: Element,
  kind: TouchType,
  p: Point,
  pressure: number,
): PointerEvent {
  const e = new PointerEvent(type, {
    pointerType: kind === 'stylus' ? 'pen' : 'touch',
    pointerId: IDS[kind],
    isPrimary: true,
    clientX: p.x,
    clientY: p.y,
    pressure,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  made.add(e);
  target.dispatchEvent(e);
  return e;
}

/** What the page saw cancelled for one contact: one entry per touch event. */
interface Contact {
  prevented: boolean[];
  start(): void;
  move(p: Point): void;
  end(): void;
}

/** A contact of the given kind, sent in the order described at the top of this file. */
function contact(kind: TouchType, at: Point): Contact {
  const target = document.elementFromPoint(at.x, at.y) ?? document.body;
  const id = IDS[kind];
  const force = kind === 'stylus' ? 0.6 : 0;
  const c: Contact = {
    prevented: [],
    start() {
      down.set(id, { target, touchType: kind, ...at });
      pointerEvent('pointerover', target, kind, at, 0);
      pointerEvent('pointerdown', target, kind, at, force);
      c.prevented.push(touchEvent('touchstart', target, [id]));
    },
    move(p) {
      Object.assign(down.get(id)!, p);
      pointerEvent('pointermove', target, kind, p, force);
      c.prevented.push(touchEvent('touchmove', target, [id]));
    },
    end() {
      const last = down.get(id)!;
      pointerEvent('pointerup', target, kind, last, 0);
      touchEvent('touchend', target, [id]);
      down.delete(id);
    },
  };
  return c;
}

function line(c: Contact, from: Point, to: Point, steps = 10): void {
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    c.move({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
  }
}

let viewer: Viewer | undefined;
let internals: ViewerInternals | undefined;
let toolsLoaded = 0;
let send: ((m: unknown) => void) | undefined;
/** True once the stub has handled its storage read, so its stylus listener is in. */
let stubReady = false;
/**
 * The y of a point given for a paragraph that ends at 166 px, as it does with Georgia, moved by
 * where the paragraph really ends with the fonts here. A pen line just under the words would be
 * read as an underline, so the strokes keep the same distance from the text with any font.
 */
const below = (y: number): number =>
  document.getElementById('text')!.getBoundingClientRect().bottom - 166 + y;
const strokes = (): number =>
  (internals?.record().notes ?? []).reduce((n: number, note: Note) => n + note.strokes.length, 0);

beforeAll(() => {
  document.body.style.margin = '0';
  document.body.innerHTML = `
    <p id="text" style="position:absolute;left:20px;top:80px;width:500px;font:18px/1.6 Georgia,serif">
      Rivers carry water from high ground to the sea, and they shape the land as they go.
      A meander forms where the outer bank wears away and the inner bank gathers sand.
    </p>
    <div style="height:2000px"></div>`;
  const kv = memoryKV();
  const loader: LoaderModule = {
    async start(ctx) {
      viewer = await createViewer({
        kv,
        real,
        front: ctx.front,
        loadTools: async () => ({
          attachTools: (v) => {
            internals = v;
            toolsLoaded++;
            return attachTools(v);
          },
        }),
      });
      return viewer;
    },
    pathOf: () => ({ css: '', xpath: '' }),
  };
  const load = (async () => loader) as unknown as Load;
  const api = {
    storage: {
      local: {
        get: () => {
          const read = Promise.resolve({});
          // The stub handles the read in the same microtask run; a task later it is done.
          void read.then(() => setTimeout(() => (stubReady = true)));
          return read;
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: (m: unknown, s: unknown, r: () => void) => void) => {
          send = (m) => fn(m, {}, () => {});
        },
      },
    },
  } as unknown as Api;
  // penReady: the stub holds Pencil touches back before the tools load, as on iPad.
  startStub({ win: window, api, load, penReady: true, real });
});

afterAll(() => {
  // Switch the stub off for this site, which removes its listeners and the viewer.
  send?.({ ink: 'site', on: false });
  resetToolSession();
  document.body.innerHTML = '';
});

test('the first Pencil stroke is held back by the stub, buffered and adopted as ink', async () => {
  // The stylus listener must be in. In a frame, as in the test runner, the stub reads no storage
  // and adds it at once. In a top frame it adds it once the storage read is handled.
  await until(() => stubReady || window !== window.top, 'the stub storage read');
  const finger = contact('direct', { x: 60, y: below(400) });
  finger.start();
  line(finger, { x: 60, y: below(400) }, { x: 60, y: below(300) });
  finger.end();
  // Before the tools load, a finger is the page's, and nothing loads.
  expect(finger.prevented.every((p) => !p)).toBe(true);
  expect(viewer).toBeUndefined();

  // The whole first stroke happens before the tools are in.
  const pen = contact('stylus', { x: 40, y: below(200) });
  pen.start();
  line(pen, { x: 40, y: below(200) }, { x: 300, y: below(230) });
  pen.end();
  expect(toolsLoaded).toBe(0);
  // Every stylus touch was held back, so Safari neither pans nor starts Scribble.
  expect(pen.prevented.length).toBe(11);
  expect(pen.prevented.every((p) => p)).toBe(true);

  await until(() => strokes() === 1, 'the buffered stroke adopted');
  expect(toolsLoaded).toBe(1);
  const s = internals!.record().notes[0]!.strokes[0]!;
  expect(s.tool).toBe('pen');
});

test('with the tools in, a Pencil stroke is ink, its touches are cancelled, and a finger is not', async () => {
  const before = strokes();
  const pen = contact('stylus', { x: 40, y: below(300) });
  pen.start();
  line(pen, { x: 40, y: below(300) }, { x: 160, y: below(330) }, 5);

  // A palm or finger while the Pencil is down: no ink of its own, no cancel of the stroke.
  const palm = contact('direct', { x: 400, y: below(500) });
  palm.start();
  line(palm, { x: 400, y: below(500) }, { x: 400, y: below(440) }, 3);
  palm.end();

  line(pen, { x: 160, y: below(330) }, { x: 300, y: below(340) }, 5);
  pen.end();
  expect(pen.prevented.length).toBe(11);
  expect(pen.prevented.every((p) => p)).toBe(true);
  // The palm is held still too, so it cannot pan the page under the pen.
  expect(palm.prevented.every((p) => p)).toBe(true);
  await until(() => strokes() === before + 1, 'the live stroke saved');
  await quiet();
  expect(strokes()).toBe(before + 1);

  // With the Pencil lifted and the draw toggle off, a finger is left to the page.
  const finger = contact('direct', { x: 60, y: below(500) });
  finger.start();
  line(finger, { x: 60, y: below(500) }, { x: 60, y: below(380) });
  finger.end();
  expect(finger.prevented.every((p) => !p)).toBe(true);
  await quiet();
  expect(strokes()).toBe(before + 1);
  expect(viewer!.state().draw).toBe(false);
});
