// Test helpers shared by every browser test, here and in the embed package. Tests wait on
// what the page is doing, never on the wall clock: a busy machine makes them slower, not red.
//
// track() wraps the window's frame, idle and short timer calls, so quiet() can tell when the
// code under test has no work scheduled. The browser test setup calls it once per file.

import { beforeAll, expect } from 'vitest';
import { commands } from 'vitest/browser';

/** Timers up to this long count as pending work. Longer ones are timeouts a test waits on itself. */
export const SHORT_TIMER_MS = 300;
/** Upper bound for waits on a condition. Only a broken test ever reaches it. */
export const WAIT_MS = 15_000;

type Win = Window & typeof globalThis;
interface Pending {
  frames: Set<number>;
  idle: Set<number>;
  timers: Set<number>;
}

interface Tracker {
  pending: Pending;
  rawFrame: (cb: FrameRequestCallback) => number;
}
// The setup file and the tests may load this module as separate instances, so the state
// lives on the window.
const KEY = '__inkTracker';
const tracker = (): Tracker | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as Record<string, Tracker>)[KEY];

/** Wrap the scheduling calls of `win` so pending work can be counted. Safe to call twice. */
export function track(win: Win = window as Win): void {
  if ((win as unknown as Record<string, Tracker | undefined>)[KEY]) return;
  const raf = win.requestAnimationFrame.bind(win);
  const caf = win.cancelAnimationFrame.bind(win);
  const pending: Pending = { frames: new Set(), idle: new Set(), timers: new Set() };
  (win as unknown as Record<string, Tracker>)[KEY] = { pending, rawFrame: raf };
  win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = raf((t) => {
      pending.frames.delete(id);
      cb(t);
    });
    pending.frames.add(id);
    return id;
  };
  win.cancelAnimationFrame = (id: number): void => {
    pending.frames.delete(id);
    caf(id);
  };
  if (typeof win.requestIdleCallback === 'function') {
    const ric = win.requestIdleCallback.bind(win);
    const cic = win.cancelIdleCallback.bind(win);
    win.requestIdleCallback = (cb: IdleRequestCallback, o?: IdleRequestOptions): number => {
      const id = ric((d) => {
        pending.idle.delete(id);
        cb(d);
      }, o);
      pending.idle.add(id);
      return id;
    };
    win.cancelIdleCallback = (id: number): void => {
      pending.idle.delete(id);
      cic(id);
    };
  }
  const st = win.setTimeout.bind(win);
  const ct = win.clearTimeout.bind(win);
  win.setTimeout = ((cb: TimerHandler, ms?: number, ...args: unknown[]): number => {
    if (typeof cb !== 'function' || (ms ?? 0) > SHORT_TIMER_MS) return st(cb, ms, ...args);
    const id = st(() => {
      pending.timers.delete(id);
      (cb as (...a: unknown[]) => void)(...args);
    }, ms);
    pending.timers.add(id);
    return id;
  }) as Win['setTimeout'];
  win.clearTimeout = ((id?: number): void => {
    if (id !== undefined) pending.timers.delete(id);
    ct(id);
  }) as Win['clearTimeout'];
}

/** Frame callbacks, idle callbacks and short timers scheduled and not run yet. */
export function busy(): { frames: number; idle: number; timers: number } {
  const pending = tracker()?.pending ?? { frames: new Set(), idle: new Set(), timers: new Set() };
  return { frames: pending.frames.size, idle: pending.idle.size, timers: pending.timers.size };
}

/** The next animation frame. It is not counted as pending work. */
export const frame = (): Promise<void> =>
  new Promise((r) => (tracker()?.rawFrame ?? requestAnimationFrame)(() => r()));

/**
 * Wait until nothing is scheduled: no frame callback, no idle callback and no short timer,
 * for two frames in a row. Placement passes, idle slices and debounces have then all run.
 * Long timers (the bar's hide timer, the page settle timer) do not count.
 */
export async function quiet(label = 'quiet', ms = WAIT_MS): Promise<void> {
  const end = performance.now() + ms;
  let calm = 0;
  while (calm < 2) {
    await frame();
    const b = busy();
    calm = b.frames + b.idle + b.timers === 0 ? calm + 1 : 0;
    if (calm < 2 && performance.now() > end) throw new Error(`${label}: still busy ${JSON.stringify(b)}`);
  }
}

/** Wait until cond() is true, checking once per frame. Throws with the label after the bound. */
export async function until(cond: () => boolean, label = 'condition', ms = WAIT_MS): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await frame();
  }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    shown(): Promise<{ jpeg: string; viewportWidth: number; x: number; y: number; width: number }>;
  }
}

/**
 * What the browser shows on screen right now, as a function from a client point of the test
 * frame to its colour. Read from a screencast frame (the shown command in vitest.commands.ts),
 * not from a screenshot: a screenshot paints the page again in one pass and so hides a fault
 * in how the browser puts its layers together. The frame is a JPEG, so colours are close, not
 * exact.
 */
export async function shown(): Promise<(x: number, y: number) => [number, number, number]> {
  const f = await commands.shown();
  const bin = atob(f.jpeg);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  // Picture pixels per CSS pixel of the page, and CSS pixels of the page per one of the frame.
  const k = bmp.width / f.viewportWidth;
  const s = f.width / window.innerWidth;
  return (x, y) => {
    const d = ctx.getImageData(Math.round((f.x + x * s) * k), Math.round((f.y + y * s) * k), 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  };
}

/** A clock the test moves by hand, for the `now` option of the placer, the viewer and the resolver. */
export function manualClock(start = 1000): { now: () => number; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

// ---- budgets ---------------------------------------------------------------------

/**
 * Median time of a fixed piece of script and layout work, in ms, measured now. Budget tests
 * compare against it, so a machine that is slow or busy for the whole run does not fail them,
 * while code that got slower still does.
 */
export function calibrate(runs = 7): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px';
    document.body.append(box);
    const t0 = performance.now();
    let h = 0;
    for (let j = 0; j < 600; j++) {
      const p = document.createElement('p');
      p.textContent = `Calibration line ${j} ${'word '.repeat(j % 17)}`;
      box.append(p);
      h += p.getBoundingClientRect().height;
    }
    box.style.width = '300px';
    for (const p of box.children) h += p.getBoundingClientRect().height;
    times.push(performance.now() - t0);
    box.remove();
    if (!h) throw new Error('calibration laid nothing out');
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/** calibrate() on a laptop, per engine, in ms. The engines lay this work out at different speeds. */
const CALIBRATE_REF_MS = { chromium: 30, webkit: 45, firefox: 20 };
const engine = (): keyof typeof CALIBRATE_REF_MS => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrom(e|ium)\//.test(ua)) return 'chromium';
  return 'webkit';
};

/** Budget tests have this in their name. The test script runs them alone, one file at a time. */
export const BUDGET_TEST = 'budget: ';

/**
 * A time limit for a budget test: `ms` on a quiet machine, scaled up by how much slower the
 * calibration work ran in this same run. Never below `ms`. Only a test named "budget: ..." may
 * call it, so it is never measured while other test files run beside it.
 */
export function budget(ms: number): number {
  const name = expect.getState().currentTestName ?? '';
  if (!name.includes(BUDGET_TEST)) {
    throw new Error(`budget() is for tests named "${BUDGET_TEST}...", which run alone: ${name}`);
  }
  const scale = Math.max(1, calibrate() / CALIBRATE_REF_MS[engine()]);
  return ms * scale;
}

if (typeof window !== 'undefined') {
  track();
  // VITE_INK_CPU_THROTTLE=4 runs the file with the CPU slowed four times, in Chromium.
  const rate = Number((import.meta as { env?: Record<string, string> }).env?.VITE_INK_CPU_THROTTLE ?? 0);
  if (rate > 1) {
    beforeAll(async () => {
      const go = (commands as unknown as { throttle?: (r: number) => Promise<boolean> }).throttle;
      await go?.(rate);
    });
  }
}
