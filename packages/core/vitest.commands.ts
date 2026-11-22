// Browser commands for the Vitest browser tests, shared with the embed package.
// They run on the test server and drive the page through Playwright, which works
// in every engine, unlike CDP.
import { availableParallelism, cpus } from 'node:os';
import type { BrowserCommand } from 'vitest/node';
import { freeCores } from './src/budget-rule';

/** prefers-reduced-motion, set for the whole page. */
const reducedMotion: BrowserCommand<[on: boolean]> = async (ctx, on) => {
  await ctx.page.emulateMedia({ reducedMotion: on ? 'reduce' : 'no-preference' });
};

type MouseStep = 'mousePressed' | 'mouseMoved' | 'mouseReleased';
const KEYS: [number, string][] = [
  [1, 'Alt'],
  [2, 'Control'],
  [4, 'Meta'],
  [8, 'Shift'],
];

/**
 * One trusted mouse event at a client point of the test frame. Playwright takes page
 * coordinates, so the frame's offset is added. Modifier bits are CDP's: 1 Alt, 2 Control,
 * 4 Meta, 8 Shift.
 */
const realMouse: BrowserCommand<[type: MouseStep, x: number, y: number, modifiers: number]> = async (
  ctx,
  type,
  x,
  y,
  modifiers,
) => {
  const frame = await ctx.frame();
  const box = await (await frame.frameElement()).boundingBox();
  const px = x + (box?.x ?? 0);
  const py = y + (box?.y ?? 0);
  const { mouse, keyboard } = ctx.page;
  const keys = KEYS.filter(([bit]) => modifiers & bit).map(([, k]) => k);
  for (const k of keys) await keyboard.down(k);
  try {
    if (type === 'mousePressed') {
      await mouse.move(px, py);
      await mouse.down();
    } else if (type === 'mouseMoved') await mouse.move(px, py);
    else {
      await mouse.move(px, py);
      await mouse.up();
    }
  } finally {
    for (const k of keys.reverse()) await keyboard.up(k);
  }
};

type PwPage = Parameters<BrowserCommand<[]>>[0]['page'];
type PwSession = Awaited<ReturnType<ReturnType<PwPage['context']>['newCDPSession']>>;
/**
 * One CDP session per page for touch input, kept for the life of the page. The browser keeps
 * the fingers that are down per session, so a gesture sent in several calls needs the same one.
 */
const touchSessions = new WeakMap<PwPage, Promise<PwSession>>();
function touchSession(page: PwPage): Promise<PwSession> {
  let s = touchSessions.get(page);
  if (!s) {
    s = page.context().newCDPSession(page);
    touchSessions.set(page, s);
  }
  return s;
}

type TouchStep = {
  type: 'touchStart' | 'touchMove' | 'touchEnd';
  touchPoints: { x: number; y: number; id: number }[];
  timestamp: number;
};

/**
 * Touch events at client points of the test frame, through CDP. Chromium only. All of them are
 * written to the browser in the same turn, each with its own time, so the browser reads them
 * as one piece of a gesture and no round trip falls between them (touchGesture in
 * src/capture/testkit.ts). It ends when the page has handled the last one.
 */
const touches: BrowserCommand<[steps: TouchStep[]]> = async (ctx, steps) => {
  const frame = await ctx.frame();
  const box = await (await frame.frameElement()).boundingBox();
  const dx = box?.x ?? 0;
  const dy = box?.y ?? 0;
  const cdp = await touchSession(ctx.page);
  await Promise.all(
    steps.map((s) =>
      cdp.send('Input.dispatchTouchEvent', {
        type: s.type,
        touchPoints: s.touchPoints.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
        timestamp: s.timestamp,
      }),
    ),
  );
};

/**
 * Slow the page's CPU by `rate` through CDP, as a slow machine would. Chromium only: elsewhere
 * it does nothing and returns false. Set VITE_INK_CPU_THROTTLE to run a suite this way.
 */
const throttle: BrowserCommand<[rate: number]> = async (ctx, rate) => {
  try {
    const cdp = await ctx.page.context().newCDPSession(ctx.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    return true;
  } catch {
    return false;
  }
};

/**
 * How many of the machine's cores sat idle over the next 300 ms, from the system's CPU
 * counters. A page cannot read them. Budget tests ask before and after a measure, to know
 * whether other work was running beside it (src/budget-rule.ts).
 */
const machine: BrowserCommand<[]> = async () => {
  const before = cpus();
  await new Promise((r) => setTimeout(r, 300));
  return { free: freeCores(before, cpus()), cores: availableParallelism() };
};

/** The side of the mark the shown command puts in the bottom right corner of the page, in px. */
const SHOWN_MARK_PX = 8;

/**
 * What the browser puts on the screen: one frame of the page's screencast as a JPEG, with the
 * place of the test frame in it. A screenshot paints the page again in one pass, so it cannot
 * show a fault in how the browser puts its layers together. A screencast frame can.
 *
 * While it runs, a small mark in the bottom right corner of the page changes between two
 * colours no page here uses (magenta and cyan). It keeps frames coming, and it dates them: a
 * frame that shows the mark was made after this command began, so it shows everything the
 * test drew before. A frame without it is older. The caller checks (shown in src/testkit.ts).
 */
const shown: BrowserCommand<[]> = async (ctx) => {
  const frame = await ctx.frame();
  const box = await (await frame.frameElement()).boundingBox();
  const size = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
  let last: { data: Buffer; viewportWidth: number } | undefined;
  let seen = 0;
  await ctx.page.screencast.start({
    size,
    quality: 100,
    onFrame: (f) => {
      last = f;
      seen++;
    },
  });
  try {
    // A browser sends a frame when the page changes. The mark changes until two frames have come.
    for (let i = 0; i < 100 && seen < 2; i++) {
      await ctx.page.evaluate(
        ([n, px]) => {
          const id = 'ink-shown-tick';
          let d = document.getElementById(id);
          if (!d) {
            d = document.createElement('div');
            d.id = id;
            d.style.cssText = `position:fixed;right:0;bottom:0;width:${px}px;height:${px}px;z-index:2147483647`;
            document.documentElement.append(d);
          }
          d.style.background = n % 2 ? '#ff00ff' : '#00ffff';
          return new Promise((r) => requestAnimationFrame(() => r(null)));
        },
        [i, SHOWN_MARK_PX] as const,
      );
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await ctx.page.screencast.stop();
    await ctx.page.evaluate(() => document.getElementById('ink-shown-tick')?.remove());
  }
  if (!last) throw new Error('The browser sent no screencast frame');
  return {
    jpeg: last.data.toString('base64'),
    viewportWidth: last.viewportWidth || size.width,
    mark: SHOWN_MARK_PX,
    x: box?.x ?? 0,
    y: box?.y ?? 0,
    width: box?.width ?? size.width,
  };
};

export const commands = { reducedMotion, realMouse, touches, throttle, shown, machine };
